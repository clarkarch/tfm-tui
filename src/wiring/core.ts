// --- Core wiring: config, theme, glyph fallbacks, post-mount lookup, icon
// slots, floats, app state — everything created before the renderer boots,
// plus the mutable geometry cell that applyConfig() rewrites (never baked
// into consts) and the scroller ref the boot layout assigns. Renderer- and
// fileops-coupled deps arrive as getters (TDZ seam rule — the renderer is
// created later by the chrome wiring, the clipboard by the fileops wiring;
// both are only read at runtime, post-boot). ---

import os from "node:os";
import type { ScrollBoxRenderable } from "@opentui/core";
import { loadConfig, type Theme } from "../config/config";
import { deriveColors } from "../config/color";
import { sideInnerWidth } from "../ui/style";
import { ensureGlyphFallbacks, glyphFor } from "../ui/glyphs";
import { FILE_ICON_BY_EXT } from "../fs/filetype";
import { isVirtualUri } from "../fs/uri";
import { isTrashFilesDir } from "../fs/fsutil";
import { isCutKeyFor } from "../fs/clipboard";
import { makeLookup } from "../ui/ui-lookup";
import { makeSlots } from "../ui/ui-slots";
import { makeFloats } from "../ui/floats";
import { clearChildren } from "../ui/uiutil";
import { initialAppState } from "../app/nav";

export type CoreWiring = ReturnType<typeof wireCore>;

export const wireCore = (deps: {
  // () => renderer — TDZ: the chrome wiring creates it later
  renderer(): any;
  // live fileops clipboard read (isCutKey tile dimming)
  clipboard(): { mode: "copy" | "cut"; items: { path: string }[] } | null;
}) => {
  // --- Config (TOML at ~/.config/tfm/config.toml, TFM_CONFIG overrides path) ---
  const config = loadConfig();

  // --- Color palette (theme from config; transparent-bg nudge lives in ./color) ---
  const colors = deriveColors(config.theme, config.ui.transparentBg);
  const themeGet = (): Theme => colors;

  // --- Geometry applyConfig() rewrites through this cell — never bake into consts ---
  const geometry = {
    sw: config.ui.sidebarWidth,
    tileW: config.ui.tileWidth,
    tileH: config.ui.tileHeight,
    iconCells: config.ui.iconCells,
  };

  // inner width available to children of the sidebar panel (outline border
  // math lives in ./style)
  const sideInnerW = (): number => sideInnerWidth(config.ui.uiStyle, geometry.sw);

  // --- Nerd Font glyphs live in ./glyphs (FALLBACK ONLY); every category the
  // ./filetype classifier can emit gets a file-glyph fallback ---
  ensureGlyphFallbacks(new Set(Object.values(FILE_ICON_BY_EXT)));

  // --- Post-mount node lookup seam — lives in ./ui-lookup (tested). Created
  // before the widget factories that capture byId/stripSelectable in ctx; the
  // renderer boots further down, so root arrives as an arrow (TDZ seam rule).
  // Every lookup must tolerate a miss (nodes die on every rebuild). ---
  const lookup = makeLookup({ root: () => deps.renderer().root });

  // --- Floating layers: THE single source of truth for which modal/cursor
  // layer is open + the dismiss-others policy. Pure module, created before
  // any widget (makeSlots reads its escmenu state through a getter). ---
  const floats = makeFloats();

  // --- Icon slots / thumbs / modal scrim — widget lives in ./ui-slots.
  // Called before the renderer boots: every ctx field the drain path needs is
  // an arrow wrapper (post-boot evaluation), per the widget-seam rules. ---
  const slots = makeSlots({
    renderer: () => deps.renderer(),
    byId: lookup.byId,
    clearChildren,
    colors: themeGet,
    uiStyle: () => config.ui.uiStyle,
    iconCells: () => geometry.iconCells,
    modalOpen: () => floats.isOpen("escmenu"),
    glyphFor,
  });

  // --- App state & history (type + boot-state factory live in ./nav with the
  // navigation logic) ---
  const home = os.homedir();
  const state = initialAppState(config);

  // --- Grid scroll container — assigned during boot (buildLayout step) ---
  const scrollerRef: { current: ScrollBoxRenderable | null } = { current: null };

  // --- Virtual places: Recent (freedesktop recently-used.xbel) & Starred.
  // URI/XDG primitives live in ./uri; this wrapper keeps the historic
  // call-signature (defaults to the current cwd). ---
  function isVirtualCwd(p: string = state.cwd): boolean {
    return isVirtualUri(p);
  }

  // --- Trash view detection: the path comparison is pure (./fsutil, honors
  // $XDG_DATA_HOME); this wrapper reads the live cwd. ---
  function inTrashView(): boolean {
    return isTrashFilesDir(state.cwd);
  }

  // --- The cut check itself is pure (./clipboard); this wrapper reads the
  // live internal clipboard, created later by the fileops wiring. ---
  const isCutKey = (key: string): boolean => isCutKeyFor(deps.clipboard(), key);

  return {
    config,
    colors,
    themeGet,
    geometry,
    sideInnerW,
    lookup,
    floats,
    slots,
    home,
    state,
    scrollerRef,
    isVirtualCwd,
    inTrashView,
    isCutKey,
  };
};
