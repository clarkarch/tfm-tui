import { CliRenderEvents } from "@opentui/core";
import { bumpHex } from "../config/color";
import { deriveSystemTheme, type TerminalPaletteInput, type TerminalThemeMode } from "../config/system-theme";
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
  renderer(): any;
  // live refs — boot assigns them in place, runtime merges via applyConfig
  config: Config;
  colors: Theme;
  applyConfig(fresh: Config): void;
  log?(msg: string): void;
  // debounced TOML write after a successful runtime resolve — without it the
  // derived hexes never persist and a fast quit can lose even the flag commit
  scheduleSaveConfig?(): void;
  // boot-path hook so the plugin `theme` event still fires on a System boot
  // (the runtime path emits through applyConfig's onConfigApplied instead)
  onBootDerived?(theme: Theme): void;
  // virtual-clock seam for the follow debounce (timing units take one and
  // test on it — bun has no fake timers); query bounds stay wall-clock
  sched?: Scheduler;
};

type TerminalQuery = { input: TerminalPaletteInput; mode: TerminalThemeMode | null };

export const makeSystemTheme = (ctx: SystemThemeCtx) => {
  // generation token: a slow query landing after the user moved on
  // (System→preset, toggle-off, newer resolve) must not clobber live state
  let gen = 0;

  // settle one leg against its own bound — a slow theme-mode must never
  // discard a fast palette (mode falls back to bg-brightness inference)
  const settle = <T>(p: Promise<T>, ms: number): Promise<T | null> =>
    withTimeout(p, ms).then(
      (v) => v,
      () => null,
    );

  // bounded query: silent terminals (dumb term, some tmux/ssh) must fall back
  // fast instead of stalling boot behind two detector timeouts
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

  // runtime path (settings toggle, live follow): full retheme via applyConfig
  const resolveSystemTheme = async (timeoutMs = 800): Promise<boolean> => {
    if (!ctx.config.ui.followTerminal) return false;
    const g = ++gen;
    const theme = await queryAndDerive(timeoutMs);
    // a newer resolve (or toggle-off) won while the query was in flight —
    // the landing is stale, drop it instead of clobbering live state
    if (g !== gen || !ctx.config.ui.followTerminal) return false;
    if (!theme) return false;
    ctx.applyConfig({ ui: { ...ctx.config.ui }, theme, keys: { ...ctx.config.keys } });
    try {
      ctx.scheduleSaveConfig?.();
    } catch {}
    return true;
  };

  // boot path (pre-first-render): direct assign, mirroring applyConfig's
  // merge + transparent-bg nudge but without caches/repaint/renderAll.
  // The renderer bg is set too — chrome read the preset bg at construction.
  const applyBootSystemTheme = async (timeoutMs = 250): Promise<boolean> => {
    if (!ctx.config.ui.followTerminal) return false;
    const g = ++gen;
    const theme = await queryAndDerive(timeoutMs);
    if (g !== gen || !ctx.config.ui.followTerminal) return false;
    if (!theme) return false;
    Object.assign(ctx.config.theme, theme);
    Object.assign(ctx.colors, theme);
    if (!ctx.config.ui.transparentBg) ctx.colors.bg = bumpHex(ctx.colors.bg);
    try {
      ctx.renderer()?.setBackgroundColor?.(ctx.config.ui.transparentBg ? "transparent" : ctx.colors.bg);
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
