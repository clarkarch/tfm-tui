// --- Core wiring: config, theme, glyph fallbacks, post-mount lookup, icon
// slots, floats, app state — everything created before the renderer boots,
// plus the mutable geometry cell that applyConfig() rewrites (never baked
// into consts) and the scroller ref the boot layout assigns. Renderer- and
// fileops-coupled deps arrive as getters (TDZ seam rule — the renderer is
// created later by the chrome wiring, the clipboard by the fileops wiring;
// both are only read at runtime, post-boot). ---

import os from "node:os";
import type { CliRenderer, ScrollBoxRenderable } from "@opentui/core";
import { loadConfig, type Theme } from "../config/config";
import { deriveColors } from "../config/color";
import { applySurface, sideInnerWidth } from "../ui/style";
import { ensureGlyphFallbacks, glyphFor } from "../ui/glyphs";
import { asciiGlyphFor, resolveTtyMode, ttyStaticTheme } from "../ui/tty";
import { FILE_ICON_BY_EXT } from "../fs/filetype";
import { isVirtualUri } from "../fs/uri";
import { isTrashFilesDir } from "../fs/fsutil";
import { isCutKeyFor } from "../fs/clipboard";
import { makeLookup, makeResolutionGate } from "../ui/ui-lookup";
import { makePointerSetter, makeSlots } from "../ui/ui-slots";
import {
  SCRIM_FILL_ID,
  contentPresentation,
  modalVisibility,
  revealVisibility,
  type ContentPresentation,
  type ContentVisibility,
} from "../ui/scrim";
import { makeFloats } from "../ui/floats";
import { initialAppState } from "../app/nav";
import { appendLog } from "../lib/log";
import { bootModeFor, isLazyBoot } from "../lib/boot-mode";
import { activeFacade, activeState, makePanePair, otherState, setActivePane, togglePane } from "../app/panes";

export type CoreWiring = ReturnType<typeof wireCore>;

export const wireCore = (deps: {
  // () => renderer — TDZ: the chrome wiring creates it later
  renderer(): CliRenderer;
  // live fileops clipboard read (isCutKey tile dimming)
  clipboard(): { mode: "copy" | "cut"; items: { path: string }[] } | null;
  // a launch FILE path (`tfm some/file.txt`) to highlight after the first build
  pendingSelect?: string | null;
}) => {
  // --- Config (TOML at ~/.config/tfm/config.toml, TFM_CONFIG overrides path) ---
  const config = loadConfig();

  // --- Color palette (theme from config; transparent-bg nudge lives in ./color).
  // Tty mode forces opaque AND ignores the user's [theme] hues: the VT ignores
  // 48;2 truecolor, so a snapped custom theme always went muddy — one static
  // console palette (dark/light by configured-bg brightness) paints instead.
  // config.theme is still STORED untouched, so leaving the console restores it.
  const ttyMode = resolveTtyMode(config.ui.ttyMode, process.env.TERM);
  const colors = ttyMode ? ttyStaticTheme<Theme>(config.theme) : deriveColors(config.theme, config.ui.transparentBg);
  const themeGet = (): Theme => colors;

  // --- [ui] lazy-startup: the ONE switch between the two startup shapes.
  // OFF (classic, the default): the app paints in ONE burst — the content
  // starts transparent and the boot reveals it once the first frame is
  // COMPLETE (the grid built, the icons rastered). The user never watches
  // tfm assemble itself (title + background first, then the sidebar, then
  // the grid, then the icons).
  // ON: the app paints IMMEDIATELY and the rest lands in the background —
  // the progressive arrival IS the feature (a fast first paint).
  // Read ONCE, here: lazy-startup is restart-required (a live flip would
  // change the boot's shape mid-session), so the mode is CAPTURED and every
  // consumer reads THIS value — the old shape held an inverted capture here
  // and a second, opposite-polarity capture in wireBoot, plus live config
  // re-reads in the chrome and the plugins wirings.
  const bootMode = bootModeFor(config.ui.lazyStartup);

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

  // --- Tty mode (Linux console / dumb terms): single effective switch.
  // `auto` follows the TERM prefix; `on`/`off` override. Live-read so a
  // settings flip or live-reload applies without restart.
  const isTtyMode = (): boolean => resolveTtyMode(config.ui.ttyMode, process.env.TERM);
  // ASCII glyphs on the console (no Nerd PUA there), Nerd glyphs elsewhere
  // (style-aware: an icon-style toggle re-resolves via resetIconQueue)
  const ttyGlyphFor = (name: string): string =>
    isTtyMode() ? asciiGlyphFor(name) : glyphFor(name, config.ui.iconStyle);
  // force-glyph: same raster skip as tty mode, but WITHOUT the console extras
  // (list view, ASCII glyphs, anim/transparent forcing), live-read like tty mode
  const forceGlyph = (): boolean => config.ui.forceGlyph;

  // --- Nerd Font glyphs live in ./glyphs (FALLBACK ONLY); every category the
  // ./filetype classifier can emit gets a file-glyph fallback ---
  ensureGlyphFallbacks(new Set(Object.values(FILE_ICON_BY_EXT)));

  // --- Pixel-resolution gate (./ui-lookup, tested): ONE per process, shared by
  // the boot wait (settle: full budget, then latch "this terminal never
  // reports pixels") and the grid's render path (wait: instant on the console
  // and tmux, short-bounded parking only after a resize requery). Owning it
  // here is what keeps the two from disagreeing — a per-call-site gate could
  // never latch across the whole app. Lazy renderer getter (TDZ seam rule).
  const resolutionGate = makeResolutionGate(() => deps.renderer(), {
    log: appendLog,
    // no rasters here (the console, or a terminal with broken kitty graphics) —
    // cell pixels would never be read, so the boot wait is skipped entirely
    rasterless: () => isTtyMode() || config.ui.forceGlyph,
  });

  // --- Post-mount node lookup seam — lives in ./ui-lookup (tested). Created
  // before the widget factories that capture byId/stripSelectable in ctx; the
  // renderer boots further down, so root arrives as an arrow (TDZ seam rule).
  // Every lookup must tolerate a miss (nodes die on every rebuild). ---
  const lookup = makeLookup({ root: () => deps.renderer().root });

  // Fired whenever a modal takes the screen (floats 0->1) AND when it closes.
  // Lets widgets drop state that a modal overlay would strand — e.g. a hovered
  // tile/row or the kb-focused sidebar row that stays highlighted behind the
  // dim (wiring/grid + wiring/chrome register).
  const modalOpenHooks: Array<() => void> = [];
  const registerModalOpen = (fn: () => void): void => {
    modalOpenHooks.push(fn);
  };

  const runModalHooks = (): void => {
    for (const h of modalOpenHooks) {
      try {
        h();
      } catch {}
    }
  };

  // --- Mouse pointer shapes (OSC 22): ONE tty-guarded, deduping sink for
  // the whole app, shared by every widget ctx. Per-cluster instances were
  // tried first and diverged: each kept its own `last`, so cluster A
  // emitting `default` left cluster B believing `pointer` and skipping the
  // re-set — the shape stuck wrong across widget boundaries depending on
  // the approach path. Arrows defer renderer access (pre-boot safe).
  const setPointer = makePointerSetter({
    setMousePointer: (s) => deps.renderer().setMousePointer(s),
    isTtyMode,
  });

  // --- Icon slots / thumbs — widget lives in ./ui-slots.
  // Called before the renderer boots: every ctx field the drain path needs is
  // an arrow wrapper (post-boot evaluation), per the widget-seam rules.
  // Created BEFORE the floats layer on purpose: the modal dim (applyModalDim)
  // shades the icon rasters through `slots.setRasterDim`, so the slot factory
  // must already exist when the dim is wired — a slot factory built later
  // would leave that call reading a not-yet-initialized binding (the dim's
  // try/catch would swallow the ReferenceError as a SILENT no-op). ---
  const slots = makeSlots({
    renderer: () => deps.renderer(),
    byId: lookup.byId,
    colors: themeGet,
    uiStyle: () => config.ui.uiStyle,
    iconsMode: () => config.ui.icons,
    // global policy for every image/video thumbnail surface (grid, list,
    // preview, and properties) — read live so a config change updates the
    // mounted images without re-rastering their source pixels.
    thumbnailFit: () => config.ui.thumbnailFit,
    // TTY-guarded like the terminal pane's own seam (no alpha on the Linux
    // console — without this a TTY+force run clears the X while its header
    // keeps its fill). The icon drain early-returns under TTY before ever
    // reading this, so the guard only affects the new button path.
    transparentForce: () => config.ui.transparentBg === "force" && !isTtyMode(),
    iconStyle: () => config.ui.iconStyle,
    iconCells: () => geometry.iconCells,
    glyphFor: ttyGlyphFor,
    isTtyMode,
    forceGlyph,
    setPointer,
  });

  // The app content's presentation: ONE phase, ONE applier. The boot's hide
  // and the modal's dim used to be TWO owners with TWO writers (the boot
  // wrote the content's opacity; the modal wrote the opacity AND the scrim
  // fill AND the rasters' shade), so they disagreed in the overlap — a modal
  // opened while the boot still hid the app left the scrim FILL painting
  // over an invisible app, and the boot's intermediate frame showed a
  // tfm-colored screen instead of the terminal's background.
  //
  // The phase is the whole truth: "hidden-for-boot" (the app is not on
  // screen yet), "dimmed" (a modal is open) or "visible". ONE function
  // applies the WHOLE presentation it implies.
  let contentVisibility: ContentVisibility = isLazyBoot(bootMode) ? "visible" : "hidden-for-boot";
  const presentation = (): ContentPresentation =>
    contentPresentation(contentVisibility, config.ui.scrimMode, config.ui.scrimDim);
  const applyContentVisibility = (): void => {
    try {
      const p = presentation();
      const content = lookup.byId("tfm-content");
      if (content) content.opacity = p.opacity;
      const fill = lookup.byId(SCRIM_FILL_ID);
      if (fill) fill.visible = p.fill;
      slots.setRasterDim(p.raster.opacity, p.raster.shade, p.raster.bgShade);
    } catch {}
  };

  // Dim the whole app behind a modal. `dim` fades the app-content node's
  // opacity; `fill` toggles the classic full-screen overlay node
  // (SCRIM_FILL_ID), whose box opts into the fork's fillDimsImages so the
  // rasters it covers are dimmed in place instead of deleted. In both modes
  // the icon rasters keep their placement opaque and instead have their baked
  // pixels shaded (rasterDimPlan), so they darken along with the text without
  // the translucent `icons = transparent` look.
  //
  // The boot's hide (the "burst" startup: the app is transparent until the
  // first frame is complete) wins as a WHOLE — while it is on, the modal's
  // dim has nothing to dim.
  const applyModalDim = (open: boolean): void => {
    contentVisibility = modalVisibility(contentVisibility, open);
    applyContentVisibility();
    // run on BOTH open and close: the widgets' reset also REPAINTS the
    // sidebar (normalizePlaces), which is gated on the live modal state — so
    // closing must repaint it back to the hover/kb highlight, and opening
    // must drop it (the kb-focused row otherwise stayed highlighted).
    runModalHooks();
  };

  // The boot's reveal: the app content goes from transparent to visible once
  // the first frame is COMPLETE (see wiring/io.ts runBootRender). A modal
  // open at that moment still dims it — the phase is ONE value and the
  // reveal asks the floats layer whether a modal is up.
  const setBootHidden = (hidden: boolean): void => {
    contentVisibility = hidden ? "hidden-for-boot" : revealVisibility(floats.hasModal());
    applyContentVisibility();
  };

  // --- Floating layers: THE single source of truth for which modal/cursor
  // layer is open + the dismiss-others policy. Pure module, created before any
  // widget. Modal open/close dims the app content via `applyModalDim`.
  const floats = makeFloats({
    onModalChange: applyModalDim,
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

  // --- Grid scroll containers — ONE owner, ONE write path.
  //
  // The boot layout builds BOTH panes' scrollers in one step (buildBootLayout
  // returns the pair), so the mount has exactly TWO phases: "unmounted" (the
  // boot layout has not run yet — the grid's render is a no-op, it has nothing
  // to draw into) and "mounted" (both panes' scrollers exist). The old shape
  // was two mutable `{current}` boxes: a PARTIAL mount (pane 0 set, pane 1
  // not) was representable, and `null` meant "not built yet" / "this pane is
  // not mounted" / "torn down", depending on the reader. ---
  type ScrollerMount =
    | { kind: "unmounted" }
    | { kind: "mounted"; scrollers: [ScrollBoxRenderable, ScrollBoxRenderable] };
  let mount: ScrollerMount = { kind: "unmounted" };
  // the ONE write path: the boot layout mounts both panes' scrollers
  const mountScrollers = (scrollers: [ScrollBoxRenderable, ScrollBoxRenderable]): void => {
    mount = { kind: "mounted", scrollers };
  };
  const scrollerFor = (pane: 0 | 1): ScrollBoxRenderable | null =>
    mount.kind === "mounted" ? mount.scrollers[pane] : null;
  // the ACTIVE pane's scroller — the grid renders into it
  const activeScroller = (): ScrollBoxRenderable | null => scrollerFor(panes.active);

  // --- Virtual places: Recent (freedesktop recently-used.xbel) & Starred.
  // URI/XDG primitives live in ./uri.
  function isVirtualCwd(): boolean {
    return isVirtualUri(state.cwd);
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
    isTtyMode,
    forceGlyph,
    setPointer,
    geometry,
    sideInnerW,
    lookup,
    resolutionGate,
    floats,
    // re-apply the modal dim after a config change (scrim mode flip / theme
    // change while a modal is open) — no-op when no modal is up
    reapplyModalDim: () => applyModalDim(floats.hasModal()),
    // the boot's MODE — captured once from [ui] lazy-startup. Every boot
    // consumer (the mounts branch, the resolution budget, the prompt's
    // position, the icon warms, the plugin scan) reads THIS value.
    bootMode,
    setBootHidden,
    // the content's opacity for the BUILD (the phase owns it — the boot
    // hides the app by building the content transparent)
    contentOpacity: () => presentation().opacity,
    // widgets that own transient hover state register a dropper here
    registerModalOpen,
    slots,
    home,
    state,
    panes,
    activeState: () => activeState(panes),
    otherState: () => otherState(panes),
    setActivePane: (i: 0 | 1) => setActivePane(panes, i),
    togglePane: () => togglePane(panes),
    refreshPaneFocus,
    // the grid scrollers' mount: ONE write path (the boot layout), one phase
    // predicate, and the per-pane / active-pane readers
    mountScrollers,
    scrollersMounted: () => mount.kind === "mounted",
    scrollerFor,
    activeScroller,
    isVirtualCwd,
    inTrashView,
    isCutKey,
  };
};
