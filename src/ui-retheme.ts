// --- Config application & persistence: rethemeChrome + applyConfig +
// scheduleSaveConfig + live config reload. The single path for every config
// change (file watcher, settings UI, reset): mutate -> applyConfig ->
// scheduleSaveConfig. Geometry values that used to be baked into consts are
// rewritten through ctx setters, and raster caches are invalidated only when
// colors actually changed. No module-level renderer imports — the widget
// repaint fns arrive via ctx (same seam as ui-dialogs). ---
import { watch } from "node:fs";
import path from "node:path";
import { bumpHex } from "./color";
import { applySurface, chromeSurface } from "./style";
import { BAND_ID, DRAG_GHOST_ID } from "./grid-input";
import { loadConfig, saveConfig, configPath, type Config, type Theme } from "./config";
import { debounced } from "./uiutil";

export type RethemeCtx = {
  // live object refs — applyConfig mutates them in place
  config: Config;
  colors: Theme & Record<string, any>;
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
  repaintButtons(): void;
  renderCrumbs(): void;
  refreshNav(): void;
  escMenu: { isOpen(): boolean; renderMenuContent(): void };
  fileMenuIsOpen(): boolean;
  renderFileMenu(): void;
  setStatusMsg(msg: string): void;
};

export const makeRetheme = (ctx: RethemeCtx) => {
  const { setOnId } = ctx;

  // Repaints widgets whose colors were baked at boot and which renderAll's
  // rebuilds never touch. Without this a runtime theme swap leaves the
  // sidebar, title, inputs, band, ghost and status bar in the old palette.
  const rethemeChrome = (): void => {
    const st = ctx.config.ui.uiStyle;
    const colors = ctx.colors;
    setOnId("tfm-sidebar-root", (n) => { n.width = ctx.getSw(); applySurface(n, chromeSurface(st, colors, colors.sidebarBg)); });
    setOnId("tfm-main", (n) => applySurface(n, chromeSurface(st, colors, colors.bg)));
    setOnId("tfm-title-box", (n) => { n.width = ctx.sideInnerW(); });
    setOnId("tfm-places", (n) => { n.width = ctx.sideInnerW(); });
    setOnId("tfm-title-font", (n) => { n.color = colors.accent; });
    setOnId("tfm-title-sub", (n) => { n.fg = colors.sidebarFgMuted; });
    setOnId("tfm-preview", (n) => applySurface(n, chromeSurface(st, colors, colors.sidebarBg)));
    setOnId(BAND_ID, (n) => { n.borderColor = colors.accent; });
    setOnId(DRAG_GHOST_ID, (n) => { n.backgroundColor = colors.accent; });
    setOnId(`${DRAG_GHOST_ID}-label`, (n) => { n.fg = colors.bg; });
    setOnId("tfm-status-label", (n) => { n.fg = colors.sidebarFgMuted; });
    setOnId("tfm-prompt-panel", (n) => applySurface(n, chromeSurface(st, colors, colors.sidebarBg)));
    // 1-row header can't carry a border ring — just drop the fill in outline
    setOnId("tfm-term-header", (n) => applySurface(n, st === "outline" ? {} : { backgroundColor: colors.sidebarBg }));

    // toolbar hover buttons: box bg must track the new palette between raster swaps
    ctx.repaintButtons();
    ctx.renderCrumbs();
    ctx.refreshNav();
    for (const id of ["tfm-search", "tfm-path-input", "tfm-prompt-input"]) {
      setOnId(id, (n) => {
        n.backgroundColor = colors.accentBg;
        n.focusedBackgroundColor = colors.accentBg;
        n.textColor = colors.white;
      });
    }
    if (ctx.escMenu.isOpen()) {
      setOnId("tfm-menu-panel", (n) => applySurface(n, chromeSurface(st, colors, colors.sidebarBg)));
      ctx.escMenu.renderMenuContent();
    }
    if (ctx.fileMenuIsOpen()) {
      setOnId("tfm-filemenu", (n) => applySurface(n, chromeSurface(st, colors, colors.sidebarBg)));
      ctx.renderFileMenu();
    }
  };

  // theme-relevant signature of a config snapshot. Diffing against the LAST
  // APPLIED state (not the caller's pre-call `config`) means a settings row
  // can mutate config first and call applyConfig(config) and the flip is
  // still seen — the old self-compare skipped raster invalidation silently.
  const themeSig = (c: Config): string =>
    JSON.stringify([c.theme, c.ui.transparentBg, c.ui.uiStyle]);
  let lastThemeSig = themeSig(ctx.config);

  const applyConfig = (fresh: Config): void => {
    const themeChanged = lastThemeSig !== themeSig(fresh);
    Object.assign(ctx.config.ui, fresh.ui);
    Object.assign(ctx.config.theme, fresh.theme);
    Object.assign(ctx.colors, fresh.theme);
    if (!ctx.config.ui.transparentBg) ctx.colors.bg = bumpHex(ctx.colors.bg);
    lastThemeSig = themeSig(ctx.config);

    ctx.setSw(ctx.config.ui.sidebarWidth);
    ctx.setTileW(ctx.config.ui.tileWidth);
    ctx.setTileH(ctx.config.ui.tileHeight);
    ctx.setIconCells(ctx.config.ui.iconCells);
    for (const id of ["tfm-sidebar-root", "tfm-title-box", "tfm-places"]) {
      setOnId(id, (n) => { n.width = id === "tfm-sidebar-root" ? ctx.getSw() : ctx.sideInnerW(); });
    }
    const pane: any = ctx.byId("tfm-preview");
    if (pane) {
      try {
        pane.visible = ctx.config.ui.previewEnabled;
        pane.width = ctx.config.ui.previewWidth;
      } catch {}
    }

    if (themeChanged) {
      ctx.clearIconCaches();
      ctx.resetIconQueue();
      try { ctx.renderer().setBackgroundColor(ctx.config.ui.transparentBg ? "transparent" : ctx.colors.bg); } catch {}
      // grid/sidebar rebuild picks up the new palette; everything else needs this
      rethemeChrome();
      ctx.syncTerminalTheme();
    }
    ctx.renderAll();
  };

  // signature of the last file WE wrote; the watcher skips it so saving
  // doesn't re-enter applyConfig and churn the rasters
  let lastSavedSig = "";
  let saveWarned = false;

  const scheduleSaveConfig = debounced(500, () => {
    saveConfig(ctx.config)
      .then(async () => { try { lastSavedSig = JSON.stringify(loadConfig()); } catch {} })
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
        ctx.setStatusMsg("config reloaded");
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
