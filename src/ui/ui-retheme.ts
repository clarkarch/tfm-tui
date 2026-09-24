// --- Config application & persistence: rethemeChrome + applyConfig +
// scheduleSaveConfig + live config reload. The single path for every config
// change (file watcher, settings UI, reset): mutate -> applyConfig ->
// scheduleSaveConfig. Geometry values that used to be baked into consts are
// rewritten through ctx setters, and raster caches are invalidated only when
// colors actually changed. No module-level renderer imports — the widget
// repaint fns arrive via ctx (same seam as ui-dialogs). ---
import type { CliRenderer } from "@opentui/core";
import { mkdirSync, watch } from "node:fs";
import path from "node:path";
import { bumpHex } from "../config/color";
import { compatStaticTheme, isDark, resolveCompat } from "./compat";
import { applySurface, chromeSurface, floatSurface } from "./style";
import { BAND_ID, DRAG_GHOST_ID } from "../input/grid-input";
import { loadConfig, saveConfig, configPath, type Config, type Theme } from "../config/config";
import { debounced } from "../lib/uiutil";
import type { NotifyLevel } from "../lib/notify-level";
import type { MaybeNode, NodeLike } from "../lib/node-like";

type RethemeCtx = {
  // live object refs — applyConfig mutates them in place
  config: Config;
  colors: Theme;
  setOnId(id: string, fn: (n: NodeLike) => void): void;
  byId(id: string): MaybeNode;
  renderer(): CliRenderer;
  // geometry lets — rewritten on every applyConfig, never captured
  getSw(): number;
  setSw(v: number): void;
  setTileW(v: number): void;
  setTileH(v: number): void;
  setIconCells(v: number): void;
  sideInnerW(): number;
  renderAll(): void;
  clearIconCaches(): void;
  resetIconQueue(): void;
  syncTerminalTheme(): void;
  // live-resize for the RENDER_EXEMPT terminal-height knob (no renderAll):
  // the open pane resizes its VT node itself. Optional so tests stay light.
  syncTerminalHeight?(): void;
  repaintButtons(): void;
  renderCrumbs(): void;
  refreshNav(): void;
  escMenu: { isOpen(): boolean; renderMenuContent(): void };
  fileMenuIsOpen(): boolean;
  renderFileMenu(): void;
  // open floats that persist across a theme switch (pick, conflict/yes-no
  // confirms, bulk-rename, props, progress toast): each repaints itself by
  // id — no rebuild, focus-safe. Optional so tests stay light.
  floatRepaints?: Array<{ isOpen(): boolean; repaint(): void }>;
  notify(msg: string, title?: string, level?: NotifyLevel): void;
  // side-effect hook for non-visual config consumers (undo journal sync).
  // Runs at the end of every applyConfig — optional so tests stay light.
  onConfigApplied?(): void;
  // dual pane: re-clamp the active pane when dual is disabled (a hidden pane
  // must never own input/status) and repaint the focus cue.
  normalizePanes?(): void;
  // compat mode (linux console): forces opaque bg + list view. Optional so
  // tests stay light; absent = modern terminal.
  compatActive?(): boolean;
};

export const makeRetheme = (ctx: RethemeCtx) => {
  const { setOnId } = ctx;

  // Repaints widgets whose colors were baked at boot and which renderAll's
  // rebuilds never touch. Without this a runtime theme swap leaves the
  // sidebar, title, inputs, band, ghost and status bar in the old palette.
  const rethemeChrome = (): void => {
    const st = ctx.config.ui.uiStyle;
    const colors = ctx.colors;
    setOnId("tfm-sidebar-root", (n) => {
      n.width = ctx.getSw();
      applySurface(n, chromeSurface(st, colors, colors.sidebarBg));
    });
    setOnId("tfm-main", (n) => applySurface(n, chromeSurface(st, colors, colors.bg)));
    setOnId("tfm-title-box", (n) => {
      n.width = ctx.sideInnerW();
    });
    setOnId("tfm-places", (n) => {
      n.width = ctx.sideInnerW();
    });
    setOnId("tfm-title-font", (n) => {
      n.color = colors.accent;
    });
    setOnId("tfm-title-sub", (n) => {
      n.fg = colors.sidebarFgMuted;
    });
    setOnId("tfm-preview", (n) => applySurface(n, chromeSurface(st, colors, colors.sidebarBg)));
    setOnId("tfm-pane-divider", (n) => {
      n.backgroundColor = colors.divider;
    });
    setOnId(BAND_ID, (n) => {
      n.borderColor = ctx.compatActive?.() ? colors.hoverBg : colors.accent;
    });
    setOnId(DRAG_GHOST_ID, (n) => {
      n.backgroundColor = ctx.compatActive?.() ? colors.accentBg : colors.accent;
    });
    setOnId(`${DRAG_GHOST_ID}-label`, (n) => {
      n.fg = ctx.compatActive?.() ? colors.white : colors.bg;
    });
    setOnId("tfm-status-label", (n) => {
      n.fg = colors.sidebarFgMuted;
    });
    setOnId("tfm-prompt-panel", (n) => applySurface(n, chromeSurface(st, colors, colors.sidebarBg)));
    // 1-row header can't carry a border ring — just drop the fill in outline variants
    setOnId("tfm-term-header", (n) => applySurface(n, st === "solid" ? { backgroundColor: colors.sidebarBg } : {}));

    // toolbar hover buttons: box bg must track the new palette between raster swaps
    ctx.repaintButtons();
    ctx.renderCrumbs();
    ctx.refreshNav();
    for (const p of ["tfm-p0-", "tfm-p1-"]) {
      for (const name of ["search", "path-input"]) {
        setOnId(`${p}${name}`, (n) => {
          n.backgroundColor = colors.accentBg;
          n.focusedBackgroundColor = colors.accentBg;
          n.textColor = colors.white;
        });
      }
    }
    setOnId("tfm-prompt-input", (n) => {
      n.backgroundColor = colors.accentBg;
      n.focusedBackgroundColor = colors.accentBg;
      n.textColor = colors.white;
    });
    if (ctx.escMenu.isOpen()) {
      setOnId("tfm-menu-panel", (n) => applySurface(n, floatSurface(st, colors, colors.sidebarBg)));
      ctx.escMenu.renderMenuContent();
    }
    if (ctx.fileMenuIsOpen()) {
      setOnId("tfm-filemenu", (n) => applySurface(n, floatSurface(st, colors, colors.sidebarBg)));
      setOnId("tfm-filemenu-sub", (n) => applySurface(n, floatSurface(st, colors, colors.sidebarBg)));
      ctx.renderFileMenu();
    }
    // floats that outlive the switch repaint themselves — one throwing must
    // not skip the rest (same isolation as render steps)
    for (const f of ctx.floatRepaints ?? []) {
      try {
        if (f.isOpen()) f.repaint();
      } catch {}
    }
  };

  // theme-relevant signature of a config snapshot. Diffing against the LAST
  // APPLIED state (not the caller's pre-call `config`) means a settings row
  // can mutate config first and call applyConfig(config) and the flip is
  // still seen — the old self-compare skipped raster invalidation silently.
  // followTerminal is deliberately NOT here: the flag-only commit rebuilds
  // through renderSig below, and the resolve lands the derived theme (with
  // its own invalidation) right after — caching the flag flip would clear
  // icon rasters twice for one user action
  // compatMode rides along: flipping it changes the effective transparentBg
  // (opaque on the console), so rasters must invalidate like a theme change.
  // forceGlyph too: drains stopped while on must resume on the way back, or
  // tiles keep glyphs forever.
  // While compat is active the user [theme] is IGNORED (one static console
  // palette paints instead), so the sig keys off the static dark/light choice
  // — a [theme] TOML edit on a TTY must not churn rasters or rebuild the grid.
  const themeSig = (c: Config): string => {
    if (resolveCompat(c.ui.compatMode, process.env.TERM))
      return JSON.stringify([
        "console",
        isDark(c.theme.bg) ? "dark" : "light",
        c.ui.uiStyle,
        c.ui.icons,
        c.ui.compatMode,
        c.ui.forceGlyph,
      ]);
    return JSON.stringify([c.theme, c.ui.transparentBg, c.ui.uiStyle, c.ui.icons, c.ui.compatMode, c.ui.forceGlyph]);
  };
  let lastThemeSig = themeSig(ctx.config);

  // UI keys that a settings adjust can change WITHOUT the heavy renderAll steps
  // (sidebar/grid/preview rebuilds). Their consumers read config live on the
  // next use, and the settings panel repaints the row's value text by id — so a
  // full clear-and-rebuild is pure native-alloc churn (the esc-menu settings
  // session was a documented OOM contributor). Everything else defaults to
  // rebuild, so a newly added visual key is safe unless explicitly listed.
  const RENDER_EXEMPT = new Set<string>([
    "toastDurationMs",
    "doubleClickMs",
    "dragThresholdCells",
    "hoverZoneCells",
    "hoverOpenDelayMs",
    "hoverCloseDelayMs",
    "hoverAnimMs",
    "terminalHeight",
    "fileAnimation",
    "fileAnimationSlide",
    "fileAnimationStagger",
    "fileAnimationMs",
    "fileAnimationStaggerPct",
    "fileAnimationSlidePct",
    "fileAnimationSlideDir",
    "fileAnimationEase",
    "fileAnimationScrollRevealDelayMs",
    "fileAnimationContainerFade",
    "fileAnimationVisibleOnly",
    "fileAnimationRowGranularity",
    "fileAnimationMaxFiles",
    "listingsCache",
    "listingsCacheStats",
    "listingsCacheTtl",
    "fileHoverIncludeLabel",
    "sidebarAnimation",
    "sidebarAnimationStyle",
    "sidebarAnimationMs",
    "sidebarAnimationSlideCells",
    "sidebarAnimationSlideDir",
    "sidebarAnimationStaggerPct",
    "sidebarAnimationEase",
    "sidebarAnimationIncludeTitle",
    "sidebarHoverAnimation",
    "sidebarHoverIncludeLabel",
    "sidebarHoverDirection",
    "topbarAnimation",
    "topbarAnimationStyle",
    "topbarAnimationMs",
    "topbarAnimationSlideCells",
    "topbarAnimationSlideDir",
    "topbarAnimationStaggerPct",
    "topbarAnimationEase",
    "directoryBarAnimation",
    "directoryBarStyle",
    "directoryBarMs",
    "directoryBarSlideCells",
    "directoryBarDir",
    "directoryBarStaggerPct",
    "directoryBarEase",
    "persistUndo",
    "restoreSession",
    "showLaunchTime",
    "typeToSearch",
    "gpmMouse",
  ]);

  // rebuild-relevant signature: all UI keys except the exempt ones, plus theme.
  // Compat ignores [theme] (static console palette), so it is excluded there
  // too — a theme-only edit on a TTY is a no-op, not a full repaint.
  const renderSig = (c: Config): string => {
    const ui: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(c.ui)) {
      if (!RENDER_EXEMPT.has(k)) ui[k] = v;
    }
    if (resolveCompat(c.ui.compatMode, process.env.TERM)) return JSON.stringify([ui, "console"]);
    return JSON.stringify([ui, c.theme]);
  };
  let lastRenderSig = renderSig(ctx.config);
  // force-glyph pairing nudge: fire once on the off->on edge (held-on applies
  // stay silent; off->on reminds again). Boot never passes through here, so
  // a config file with it already on doesn't spam.
  let lastForceGlyph = ctx.config.ui.forceGlyph;

  const applyConfig = (fresh: Config): void => {
    const themeChanged = lastThemeSig !== themeSig(fresh);
    Object.assign(ctx.config.ui, fresh.ui);
    Object.assign(ctx.config.theme, fresh.theme);
    Object.assign(ctx.config.keys, fresh.keys);
    Object.assign(ctx.colors, fresh.theme);
    // compat ignores the user hues: one static console palette paints instead
    // (dark/light by the configured bg's brightness) and the kitty-compositing
    // bumpHex nudge is skipped — meaningless on the console. config.theme is
    // still STORED above, so leaving the console restores the user theme.
    if (ctx.compatActive?.()) Object.assign(ctx.colors, compatStaticTheme(ctx.config.theme));
    else {
      const effTransparent = ctx.config.ui.transparentBg;
      if (!effTransparent) ctx.colors.bg = bumpHex(ctx.colors.bg);
    }
    lastThemeSig = themeSig(ctx.config);
    const renderChanged = lastRenderSig !== renderSig(ctx.config);
    lastRenderSig = renderSig(ctx.config);
    if (ctx.config.ui.forceGlyph && !lastForceGlyph) {
      try {
        ctx.notify("force glyph is on, list view pairs best with it", "compat", "info");
      } catch {}
    }
    lastForceGlyph = ctx.config.ui.forceGlyph;

    ctx.setSw(ctx.config.ui.sidebarWidth);
    ctx.setTileW(ctx.config.ui.tileWidth);
    ctx.setTileH(ctx.config.ui.tileHeight);
    ctx.setIconCells(ctx.config.ui.iconCells);
    for (const id of ["tfm-sidebar-root", "tfm-title-box", "tfm-places"]) {
      setOnId(id, (n) => {
        n.width = id === "tfm-sidebar-root" ? ctx.getSw() : ctx.sideInnerW();
      });
    }
    const pane = ctx.byId("tfm-preview");
    if (pane) {
      try {
        pane.visible = ctx.config.ui.previewEnabled;
        pane.width = ctx.config.ui.previewWidth;
      } catch {}
    }
    // dual-pane visibility: pane 1 + divider show only while enabled. renderAll
    // (below, via renderSig) rebuilds both grids through the new pane width.
    for (const id of ["tfm-pane-col-1", "tfm-pane-divider"]) {
      const node = ctx.byId(id);
      if (node) {
        try {
          node.visible = ctx.config.ui.dualPane;
        } catch {}
      }
    }
    try {
      ctx.normalizePanes?.();
    } catch {}

    if (themeChanged) {
      ctx.clearIconCaches();
      ctx.resetIconQueue();
      try {
        ctx
          .renderer()
          .setBackgroundColor(ctx.config.ui.transparentBg && !ctx.compatActive?.() ? "transparent" : ctx.colors.bg);
      } catch {}
      // grid/sidebar rebuild picks up the new palette; everything else needs this
      rethemeChrome();
      ctx.syncTerminalTheme();
      // a theme flip churns the whole icon raster set + every chrome surface;
      // without a GC poke the destroyed renderables' native buffers sit in
      // finalizer limbo until the next heap-driven GC (see the native-OOM
      // note in AGENTS.md / ./mem-hygiene)
      try {
        Bun.gc(false);
      } catch {}
    }
    try {
      ctx.onConfigApplied?.();
    } catch {}
    // terminal-height is RENDER_EXEMPT (no renderAll above) — the open pane
    // resizes its VT node itself, after the hover drawer settled the host.
    try {
      ctx.syncTerminalHeight?.();
    } catch {}
    // skip the full repaint for value-only knobs (no layout/theme change):
    // the settings row already repainted its own value text
    if (renderChanged) ctx.renderAll();
  };

  // signature of the last file WE wrote; the watcher skips it so saving
  // doesn't re-enter applyConfig and churn the rasters
  let lastSavedSig = "";
  let saveWarned = false;

  const scheduleSaveConfig = debounced(500, () => {
    saveConfig(ctx.config)
      .then(async () => {
        try {
          lastSavedSig = JSON.stringify(loadConfig());
        } catch {}
      })
      .catch(() => {
        if (!saveWarned) {
          saveWarned = true;
          console.error(`[tfm] could not write config to ${configPath()}`);
        }
      });
  });

  // --- live config reload ---
  try {
    const cfgPath = configPath();
    // fs.watch throws ENOENT SYNCHRONOUSLY when the dir is missing, and nothing
    // creates ~/.config/tfm at boot (session/undo live under $XDG_STATE_HOME,
    // saveConfig only mkdirs on first save) — on a fresh profile the watcher
    // silently never installed, so external config edits never live-reloaded.
    mkdirSync(path.dirname(cfgPath), { recursive: true });
    const applyFreshConfig = debounced(250, () => {
      try {
        const fresh = loadConfig();
        if (JSON.stringify(fresh) === lastSavedSig) return;
        applyConfig(fresh);
        ctx.notify("config reloaded", "config", "success");
      } catch {}
    });
    const watcher = watch(path.dirname(cfgPath), (_event, filename) => {
      if (!filename || filename !== path.basename(cfgPath)) return;
      applyFreshConfig();
    });
    watcher.on("error", () => {});
  } catch {}

  return { rethemeChrome, applyConfig, scheduleSaveConfig };
};
