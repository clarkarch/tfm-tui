import { type CliRenderer, CliRenderEvents } from "@opentui/core";
import { bumpHex } from "../config/color";
import { deriveSystemTheme, type TerminalPaletteInput, type TerminalThemeMode } from "../config/system-theme";
import { backgroundClearColor } from "./scrim";
import type { Config, Theme } from "../config/config-schema";
import { debounced, withTimeout, type Scheduler } from "../lib/uiutil";

// --- System (terminal-adaptive) theme orchestration: query the terminal's
// own colors through the renderer (OSC 10/11 fg/bg + OSC 4 palette, already
// probed by OpenTUI's theme-mode/palette detectors), derive a tfm Theme from
// them, and apply it. Renderer-coupled seams arrive via ctx (same pattern as
// ui-dialogs); the mapping itself stays pure in config/system-theme. ---
// Boot uses applyBootSystemTheme (direct assign — nothing is mounted yet, so
// no caches/repaint/renderAll exist to invalidate); runtime toggles and the
// THEME_MODE live-follow go through applyConfig (full retheme path).

export type SystemThemeCtx = {
  renderer(): CliRenderer;
  // live refs — boot assigns them in place, runtime merges via applyConfig
  config: Config;
  colors: Theme;
  applyConfig(fresh: Config): void;
  log?(msg: string): void;
  // debounced TOML write after a successful runtime resolve — without it the
  // derived hexes never persist and a fast quit can lose even the flag commit
  scheduleSaveConfig?(): void;
  // console/tty mode: the static console palette paints, so the boot derive
  // must not clobber it (applyConfig already honors tty mode; boot bypasses it)
  isTtyMode?(): boolean;
  // boot-path hook so the plugin `theme` event still fires on a System boot
  // (the runtime path emits through applyConfig's onConfigApplied instead)
  onBootDerived?(theme: Theme): void;
  // virtual-clock seam for the follow debounce (timing units take one and
  // test on it — bun has no fake timers); query bounds stay wall-clock
  sched?: Scheduler;
};

type TerminalQuery = { input: TerminalPaletteInput; mode: TerminalThemeMode | null };

// ONE resolve state per PATH. The boot derive and the runtime resolve are
// INDEPENDENT machines: the boot paints the FIRST frame, so a runtime
// resolve (a THEME_MODE event landing inside the boot window) must NOT drop
// it — the app would start on the preset and flip to the terminal theme a
// beat later (the reported "boot kept the preset, then flipped" symptom).
type Resolve = { kind: "idle" } | { kind: "querying"; token: number };

export const makeSystemTheme = (ctx: SystemThemeCtx) => {
  // ONE token issuer, so the tokens are COMPARABLE across the paths: a
  // landing OLDER than what already applied is stale (the boot query starts
  // first but can land last) and must not clobber the newer result.
  let tokenSeq = 0;
  // the token of the last result that was APPLIED (0 = none yet)
  let appliedToken = 0;
  let bootResolve: Resolve = { kind: "idle" };
  let runtimeResolve: Resolve = { kind: "idle" };

  // start a query: the new token supersedes the previous query on the SAME
  // path only — the other path's query is independent
  const startQuery = (): Resolve & { kind: "querying" } => ({ kind: "querying", token: ++tokenSeq });
  // is this landing still the current query on its path?
  const isCurrent = (state: Resolve, token: number): boolean => state.kind === "querying" && state.token === token;

  // settle one leg against its own bound — a slow theme-mode must never
  // discard a fast palette (mode falls back to bg-brightness inference)
  const settle = <T>(p: Promise<T>, ms: number): Promise<T | null> =>
    withTimeout(p, ms).then(
      (v) => v,
      () => null,
    );

  // bounded query: the budget must cover OpenTUI's own FIXED 300ms OSC-support
  // probe (not scaled by our timeout), the tmux XTVERSION wait, and 16 OSC 4
  // relay round-trips — short budgets (250/800) lost that race 100% of the
  // time: every boot kept the preset (then flipped ~0.7s later via PALETTE)
  // and truncated answers landed as partial palettes (grey/white/navy
  // hallucinations in the fallback ladder). withTimeout resolves the moment
  // the terminal answers, so success adds no latency; silent terminals still
  // fall back fast — the detector's own 300ms idle window fires when nothing
  // answers, so the bound here only caps slow trickle replies.
  const queryTerminal = async (timeoutMs: number): Promise<TerminalQuery | null> => {
    const r = ctx.renderer();
    if (!r || typeof r.getPalette !== "function") return null;
    const modeP = settle(
      (async (): Promise<TerminalThemeMode | null> => {
        try {
          if (r.themeMode === "dark" || r.themeMode === "light") return r.themeMode;
          if (typeof r.waitForThemeMode === "function") return await r.waitForThemeMode(timeoutMs);
        } catch {}
        return null;
      })(),
      timeoutMs,
    );
    const palP = settle(
      (async (): Promise<TerminalPaletteInput | null> => {
        try {
          const pal = await r.getPalette({ timeout: timeoutMs });
          if (!pal || !Array.isArray(pal.palette)) return null;
          return {
            palette: pal.palette,
            defaultForeground: pal.defaultForeground ?? null,
            defaultBackground: pal.defaultBackground ?? null,
            cursorColor: pal.cursorColor ?? null,
            highlightBackground: pal.highlightBackground ?? null,
            highlightForeground: pal.highlightForeground ?? null,
          };
        } catch {
          return null;
        }
      })(),
      timeoutMs,
    );
    const [mode, input] = await Promise.all([modeP, palP]);
    if (!input) return null;
    return { input, mode };
  };

  const queryAndDerive = async (timeoutMs: number): Promise<Theme | null> => {
    const q = await queryTerminal(timeoutMs);
    if (!q) {
      try {
        ctx.log?.("system theme: terminal did not answer color query, keeping preset");
      } catch {}
      return null;
    }
    const theme = deriveSystemTheme(q.input, q.mode);
    // always-on trace (DND_LOG): what the terminal answered and what we
    // painted from it — no --debug needed, no manual checking
    try {
      ctx.log?.(
        `system theme derived mode=${q.mode ?? "inferred"} bg=${theme.bg} accent=${theme.accent} accentBg=${theme.accentBg} border=${theme.border} sidebarBg=${theme.sidebarBg}`,
      );
    } catch {}
    return theme;
  };

  // runtime path (settings toggle, live follow): full retheme via applyConfig.
  // 2000: same race as the boot budget (see queryTerminal).
  const resolveSystemTheme = async (timeoutMs = 2000): Promise<boolean> => {
    if (!ctx.config.ui.followTerminal) {
      // follow-terminal is OFF: the query in flight on this path is STALE
      // (the user picked a preset). Drop it HERE, not at the landing — the
      // flag can come back on before the query lands, and the flag check
      // alone would let that stale landing through.
      runtimeResolve = { kind: "idle" };
      return false;
    }
    const query = startQuery();
    runtimeResolve = query;
    const theme = await queryAndDerive(timeoutMs);
    // a newer resolve on this path won while the query was in flight —
    // the landing is stale, drop it instead of clobbering live state
    if (!isCurrent(runtimeResolve, query.token)) return false;
    runtimeResolve = { kind: "idle" };
    // a NEWER query already applied (the boot derive can land after a
    // runtime resolve) — this result is the older one, drop it
    if (appliedToken > query.token) return false;
    if (!ctx.config.ui.followTerminal) return false;
    if (!theme) return false;
    appliedToken = query.token;
    ctx.applyConfig({ ui: { ...ctx.config.ui }, theme, keys: { ...ctx.config.keys } });
    try {
      ctx.scheduleSaveConfig?.();
    } catch {}
    return true;
  };

  // boot path (pre-first-render): direct assign, mirroring applyConfig's
  // merge + transparent-bg nudge but without caches/repaint/renderAll.
  // The renderer bg is set too — chrome read the preset bg at construction.
  // 2000: the OSC-support probe + tmux XTVERSION + OSC 4 relay all run inside
  // this window (see queryTerminal) — 250 lost it every single boot, so the
  // first frame painted the preset and the theme flipped after the intros.
  const applyBootSystemTheme = async (timeoutMs = 2000): Promise<boolean> => {
    if (!ctx.config.ui.followTerminal) {
      bootResolve = { kind: "idle" };
      return false;
    }
    // tty/console mode paints the static console palette and applyConfig
    // skips the truecolor bg; boot must match or the first frame is derived
    // while themeSig believes the console theme is active
    if (ctx.isTtyMode?.()) {
      bootResolve = { kind: "idle" };
      return false;
    }
    const query = startQuery();
    bootResolve = query;
    const theme = await queryAndDerive(timeoutMs);
    if (!isCurrent(bootResolve, query.token)) return false;
    bootResolve = { kind: "idle" };
    // a NEWER query already applied (a runtime resolve landed first) — this
    // boot answer is the older one, drop it
    if (appliedToken > query.token) return false;
    if (!ctx.config.ui.followTerminal) return false;
    if (!theme) return false;
    appliedToken = query.token;
    Object.assign(ctx.config.theme, theme);
    Object.assign(ctx.colors, theme);
    if (ctx.config.ui.transparentBg === "off") ctx.colors.bg = bumpHex(ctx.colors.bg);
    try {
      // tty mode returned early above, so isTty is false here
      ctx.renderer()?.setBackgroundColor?.(backgroundClearColor(ctx.config.ui.transparentBg, ctx.colors.bg, false));
    } catch {}
    try {
      ctx.onBootDerived?.(theme);
    } catch {}
    return true;
  };

  // live follow: the terminal re-emits THEME_MODE on dark<->light flips and
  // PALETTE on same-mode palette switches (kitty theme change, tmux attach
  // elsewhere) — re-derive debounced
  const followSystemTheme = (): (() => void) | undefined => {
    const r = ctx.renderer();
    if (!r || typeof r.on !== "function") return;
    const re = debounced(
      400,
      () => {
        if (!ctx.config.ui.followTerminal) return;
        void resolveSystemTheme().catch(() => {});
      },
      ctx.sched ?? globalThis,
    );
    const handler = (): void => re();
    const kinds = [CliRenderEvents.THEME_MODE, CliRenderEvents.PALETTE];
    try {
      for (const k of kinds) r.on(k, handler);
    } catch {
      return;
    }
    return () => {
      try {
        for (const k of kinds) r.off(k, handler);
      } catch {}
    };
  };

  return { resolveSystemTheme, applyBootSystemTheme, followSystemTheme };
};
