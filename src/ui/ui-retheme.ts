// --- Config application & persistence: rethemeChrome + applyConfig +
// scheduleSaveConfig + live config reload. The single path for every config
// change (file watcher, settings UI, reset): mutate -> applyConfig ->
// scheduleSaveConfig. Geometry values that used to be baked into consts are
// rewritten through ctx setters, and raster caches are invalidated only when
// colors actually changed. No module-level renderer imports — the widget
// repaint fns arrive via ctx (same seam as ui-dialogs). ---
import { watch } from "node:fs";
import path from "node:path";
import { bumpHex } from "../config/color";
import { applySurface, chromeSurface, floatSurface } from "./style";
import { BAND_ID, DRAG_GHOST_ID } from "../input/grid-input";
import { loadConfig, saveConfig, configPath, type Config, type Theme } from "../config/config";
import { debounced } from "../lib/uiutil";
import type { NotifyLevel } from "../lib/notify-level";

type RethemeCtx = {
  // live object refs — applyConfig mutates them in place
  config: Config;
  colors: Theme;
  setOnId(id: string, fn: (n: any) => void): void;
  byId(id: string): any;
  renderer(): any;
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
  notify(msg: string, title?: string, level?: NotifyLevel): void;
  // side-effect hook for non-visual config consumers (undo journal sync).
  // Runs at the end of every applyConfig — optional so tests stay light.
  onConfigApplied?(): void;
  // dual pane: re-clamp the active pane when dual is disabled (a hidden pane
  // must never own input/status) and repaint the focus cue.
  normalizePanes?(): void;
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
      n.borderColor = colors.accent;
    });
    setOnId(DRAG_GHOST_ID, (n) => {
      n.backgroundColor = colors.accent;
    });
    setOnId(`${DRAG_GHOST_ID}-label`, (n) => {
      n.fg = colors.bg;
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
  };

  // theme-relevant signature of a config snapshot. Diffing against the LAST
  // APPLIED state (not the caller's pre-call `config`) means a settings row
  // can mutate config first and call applyConfig(config) and the flip is
  // still seen — the old self-compare skipped raster invalidation silently.
  const themeSig = (c: Config): string => JSON.stringify([c.theme, c.ui.transparentBg, c.ui.uiStyle, c.ui.icons]);
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
    "fileAnimationContainerFade",
    "fileAnimationVisibleOnly",
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
  ]);

  // rebuild-relevant signature: all UI keys except the exempt ones, plus theme
  const renderSig = (c: Config): string => {
    const ui: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(c.ui)) {
      if (!RENDER_EXEMPT.has(k)) ui[k] = v;
    }
    return JSON.stringify([ui, c.theme]);
  };
  let lastRenderSig = renderSig(ctx.config);

  const applyConfig = (fresh: Config): void => {
    const themeChanged = lastThemeSig !== themeSig(fresh);
    Object.assign(ctx.config.ui, fresh.ui);
    Object.assign(ctx.config.theme, fresh.theme);
    Object.assign(ctx.config.keys, fresh.keys);
    Object.assign(ctx.colors, fresh.theme);
    if (!ctx.config.ui.transparentBg) ctx.colors.bg = bumpHex(ctx.colors.bg);
    lastThemeSig = themeSig(ctx.config);
    const renderChanged = lastRenderSig !== renderSig(ctx.config);
    lastRenderSig = renderSig(ctx.config);

    ctx.setSw(ctx.config.ui.sidebarWidth);
    ctx.setTileW(ctx.config.ui.tileWidth);
    ctx.setTileH(ctx.config.ui.tileHeight);
    ctx.setIconCells(ctx.config.ui.iconCells);
    for (const id of ["tfm-sidebar-root", "tfm-title-box", "tfm-places"]) {
      setOnId(id, (n) => {
        n.width = id === "tfm-sidebar-root" ? ctx.getSw() : ctx.sideInnerW();
      });
    }
    const pane: any = ctx.byId("tfm-preview");
    if (pane) {
      try {
        pane.visible = ctx.config.ui.previewEnabled;
        pane.width = ctx.config.ui.previewWidth;
      } catch {}
    }
    // dual-pane visibility: pane 1 + divider show only while enabled. renderAll
    // (below, via renderSig) rebuilds both grids through the new pane width.
    for (const id of ["tfm-pane-col-1", "tfm-pane-divider"]) {
      const node: any = ctx.byId(id);
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
        ctx.renderer().setBackgroundColor(ctx.config.ui.transparentBg ? "transparent" : ctx.colors.bg);
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
