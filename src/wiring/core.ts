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
import { applySurface, sideInnerWidth } from "../ui/style";
import { ensureGlyphFallbacks, glyphFor } from "../ui/glyphs";
import { asciiGlyphFor, compatTheme, resolveCompat } from "../ui/compat";
import { FILE_ICON_BY_EXT } from "../fs/filetype";
import { isVirtualUri } from "../fs/uri";
import { isNetworkPath } from "../fs/network";
import { isTrashFilesDir } from "../fs/fsutil";
import { isCutKeyFor } from "../fs/clipboard";
import { makeLookup } from "../ui/ui-lookup";
import { makeSlots } from "../ui/ui-slots";
import { makeFloats } from "../ui/floats";
import { clearChildren } from "../lib/uiutil";
import { initialAppState } from "../app/nav";
import { activeFacade, activeState, makePanePair, otherState, setActivePane, togglePane } from "../app/panes";

export type CoreWiring = ReturnType<typeof wireCore>;

export const wireCore = (deps: {
  // () => renderer — TDZ: the chrome wiring creates it later
  renderer(): any;
  // live fileops clipboard read (isCutKey tile dimming)
  clipboard(): { mode: "copy" | "cut"; items: { path: string }[] } | null;
  // a launch FILE path (`tfm some/file.txt`) to highlight after the first build
  pendingSelect?: string | null;
}) => {
  // --- Config (TOML at ~/.config/tfm/config.toml, TFM_CONFIG overrides path) ---
  const config = loadConfig();

  // --- Color palette (theme from config; transparent-bg nudge lives in ./color).
  // Compat forces opaque: a transparent console bg + explicit SGR cells is
  // how the whole TUI went see-through (see color.ts). Compat ALSO snaps the
  // palette to ANSI16: the VT ignores 48;2 truecolor, so unquantized theme
  // hexes collapse into one cell and bg/hover read dead (see compatTheme).
  const compat = resolveCompat(config.ui.compatMode, process.env.TERM);
  const colors = compat
    ? compatTheme(deriveColors(config.theme, false))
    : deriveColors(config.theme, config.ui.transparentBg && !compat);
  const themeGet = (): Theme => colors;

  // --- Geometry applyConfig() rewrites through this cell — never bake into consts ---
  const geometry = {
    sw: config.ui.sidebarWidth,
    tileW: config.ui.tileWidth,
    tileH: config.ui.tileHeight,
    iconCells: config.ui.iconCells,
    // effective pane widths the grid reads for column math. The hover drawer
    // rewrites these as panes collapse/expand; `sw` above stays the config
    // width for sidebar CONTENT (baked at full size and clipped, not rebuilt).
    sidebarEff: config.ui.sidebarWidth,
    previewEff: config.ui.previewEnabled ? config.ui.previewWidth : 0,
  };

  // inner width available to children of the sidebar panel (outline border
  // math lives in ./style)
  const sideInnerW = (): number => sideInnerWidth(config.ui.uiStyle, geometry.sw);

  // --- Compat mode (Linux console / dumb terms): single effective switch.
  // `auto` follows the TERM prefix; `on`/`off` override. Live-read so a
  // settings flip or live-reload applies without restart.
  const compatActive = (): boolean => resolveCompat(config.ui.compatMode, process.env.TERM);
  // ASCII glyphs on the console (no Nerd PUA there), Nerd glyphs elsewhere
  const compatGlyphFor = (name: string): string => (compatActive() ? asciiGlyphFor(name) : glyphFor(name));
  // force-glyph: same raster skip as compat, but WITHOUT the console extras
  // (list view, ASCII glyphs, anim/transparent forcing), live-read like compat
  const forceGlyph = (): boolean => config.ui.forceGlyph;

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
  // any widget (makeSlots reads its escmenu state through a getter). Modal
  // open/close dims the background rasters via slots.setScrim (the scrim used
  // to be esc-menu-only, so props/conflict/pick rasters floated over modals).
  // `slots` is TDZ here — the callback fires post-construction only.
  const floats = makeFloats({
    onModalChange: (open) => {
      try {
        slots.setScrim(open);
      } catch {}
    },
  });

  // --- Icon slots / thumbs / modal scrim — widget lives in ./ui-slots.
  // Called before the renderer boots: every ctx field the drain path needs is
  // an arrow wrapper (post-boot evaluation), per the widget-seam rules. ---
  const slots = makeSlots({
    renderer: () => deps.renderer(),
    byId: lookup.byId,
    clearChildren,
    colors: themeGet,
    uiStyle: () => config.ui.uiStyle,
    iconsMode: () => config.ui.icons,
    iconCells: () => geometry.iconCells,
    modalOpen: () => floats.hasModal(),
    glyphFor: compatGlyphFor,
    compatActive,
    forceGlyph,
  });

  // --- App state & history (type + boot-state factory live in ./nav with the
  // navigation logic). Two panes, each an independent AppState; `state` is a
  // stable facade over the ACTIVE pane so every existing `core.state` consumer
  // keeps reading/writing the active view. Dual pane off = pane 1 lies dormant.
  const home = os.homedir();
  const panes = makePanePair(
    initialAppState(config, process.cwd(), deps.pendingSelect ?? null),
    initialAppState(config, process.cwd()),
  );
  const state = activeFacade(() => activeState(panes));

  // --- Grid scroll containers — assigned during boot (buildLayout step), one
  // per pane. `scrollerRef` stays the active pane's live ref for the same
  // facade reason as `state`. ---
  const scrollerRefs: Array<{ current: ScrollBoxRenderable | null }> = [{ current: null }, { current: null }];
  const scrollerRef = {
    get current(): ScrollBoxRenderable | null {
      return scrollerRefs[panes.active]!.current;
    },
    set current(v: ScrollBoxRenderable | null) {
      scrollerRefs[panes.active]!.current = v;
    },
  };

  // --- Virtual places: Recent (freedesktop recently-used.xbel) & Starred.
  // URI/XDG primitives live in ./uri.
  function isVirtualCwd(): boolean {
    return isVirtualUri(state.cwd);
  }

  // --- Network cwd (gvfs FUSE path): live directory watching is skipped and
  // the trash refuses — the share is a real dir but not a local one. ---
  function isNetworkCwd(): boolean {
    return isNetworkPath(state.cwd);
  }

  // --- Trash view detection: the path comparison is pure (./fsutil, honors
  // $XDG_DATA_HOME); this wrapper reads the live cwd. ---
  function inTrashView(): boolean {
    return isTrashFilesDir(state.cwd);
  }

  // --- The cut check itself is pure (./clipboard); this wrapper reads the
  // live internal clipboard, created later by the fileops wiring. ---
  const isCutKey = (key: string): boolean => isCutKeyFor(deps.clipboard(), key);

  // --- Dual-pane focus cue: no per-pane background. Tinting the inactive pane
  // (sidebarBg) fought the tiles/empty states, which paint the main bg, giving
  // a patchwork in solid mode. Clear any stale fill instead; focus reads from
  // the selection, preview and divider. No-op before the boot layout exists. ---
  const refreshPaneFocus = (): void => {
    for (const i of [0, 1] as const) {
      const node = lookup.byId(`tfm-pane-col-${i}`);
      if (!node) continue;
      try {
        applySurface(node, {});
      } catch {}
    }
  };

  return {
    config,
    colors,
    themeGet,
    compatActive,
    forceGlyph,
    geometry,
    sideInnerW,
    lookup,
    floats,
    slots,
    home,
    state,
    panes,
    activeState: () => activeState(panes),
    otherState: () => otherState(panes),
    setActivePane: (i: 0 | 1) => setActivePane(panes, i),
    togglePane: () => togglePane(panes),
    refreshPaneFocus,
    scrollerRef,
    scrollerRefs,
    isVirtualCwd,
    inTrashView,
    isNetworkCwd,
    isCutKey,
  };
};
