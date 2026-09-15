// --- I/O wiring, in the original wiring order: cwd watcher, the boot
// sequence, OSC 72 drag-and-drop (+ the XTSHIFTESCAPE request), and the
// resize repave. Everything renderer-coupled arrives as an injected step. ---

import { CliRenderEvents, Renderable } from "@opentui/core";
import { runBoot } from "../app/boot";
import { consumeRestartFlag } from "../app/restart";
import { buildBootLayout } from "../ui/ui-boot-layout";
import { hookScrollerScroll } from "../ui/ui-grid";
import { makeCwdWatcher } from "../fs/watcher";
import { isVirtualUri } from "../fs/uri";
import { isNetworkPath } from "../fs/network";
import { makeDnd72 } from "../dnd/dnd72";
import { makeHitTargetAt } from "../dnd/hit-target";
import { debounced } from "../lib/uiutil";
import { makeHoverDrawer } from "../ui/ui-hover-drawer";
import { gridDrag } from "../input/grid-input";
import { mergedMapFacade } from "../app/panes";
import { waitForResolution } from "../ui/ui-lookup";
import { loadGlobs2 } from "../fs/filetype";
import { loadSystemPlaces } from "../fs/places";
import { startMemHygiene, type AllocatorStats } from "../app/mem-hygiene";
import { xtShiftEscapeFrame, kittyDeleteAllImages } from "../ui/ui-term";
import { configPath } from "../config/config";
import { debugLog, dlog, isDebug, DEBUG_LOG, DND_LOG } from "../app/log";
import type { CoreWiring } from "./core";
import type { ChromeWiring, FileopsWiring, GridFoundationWiring, GridWiring, NavWiring } from "./types";

// narrowed shape of CliRenderer's private native binding — diagnostics only
type NativeStatsReach = { lib?: { getAllocatorStats?: () => AllocatorStats | null } };

// --- Live directory watching: external changes refresh the grid.
// Watch lifecycle lives in ./watcher (tested); the wiring supplies the live
// cwd/renaming/renderGrid getters (TDZ seam rule). ---
export const wireWatcher = (deps: {
  core: CoreWiring;
  getGridFoundation: () => GridFoundationWiring;
  getGrid: () => GridWiring;
}) => {
  const { core, getGridFoundation, getGrid } = deps;
  // one watcher per pane so external changes refresh BOTH sides of a dual
  // workspace. Pane 1's watcher stands down (isVirtualCwd true) while dual
  // pane is off, so a hidden pane never holds an inotify watch.
  const makeFor = (pane: 0 | 1) =>
    makeCwdWatcher({
      cwd: () => core.panes.states[pane].cwd,
      // network (gvfs FUSE) mounts get no watcher: inotify over FUSE is
      // unreliable and can storm; the grid refreshes on navigation instead
      isVirtualCwd: () => {
        if (pane === 1 && !core.config.ui.dualPane) return true;
        const cwd = core.panes.states[pane].cwd;
        return isVirtualUri(cwd) || isNetworkPath(cwd);
      },
      isRenaming: () => getGridFoundation().rename.isRenaming(),
      renderGrid: () => getGrid().renderPane(pane),
      // our own diagnostic sinks: dlog appends on every mouse event and defaults
      // to /tmp/tfm-dnd.log — when that IS the cwd, each click would otherwise
      // full-rebuild the grid 200ms later (visible flash after every select)
      ignorePaths: () => [DND_LOG, DEBUG_LOG],
    });
  const watchers = [makeFor(0), makeFor(1)];
  const syncCwdWatcher = (): void => {
    watchers[0]!.syncCwdWatcher();
    watchers[1]!.syncCwdWatcher();
  };
  return { syncCwdWatcher };
};

// --- Boot sequence (order + toast gating live in ./boot, tested): resolution
// wait, fixed nodes, globs2, session restore, places, first render, hygiene,
// search wiring. Fire-and-forget, exactly like the old flat wiring. ---
export const wireBoot = (deps: {
  core: CoreWiring;
  nav: NavWiring;
  chrome: ChromeWiring;
  gridFoundation: GridFoundationWiring;
  grid: GridWiring;
  fileops: FileopsWiring;
  bootStart: number;
  // an explicit CLI path suppresses session restore: the user asked for a
  // location, the saved session must not silently win
  skipSessionRestore?: boolean;
  // plugin UI slots mount into the boot layout (see app/boot.ts)
  mountSlots?: () => void;
  // cold-boot-only sidebar intro, played after the first renderAll (built in
  // wireChrome; a no-op unless [ui] sidebar-animation is on)
  playSidebarIntro?: () => void;
  // cold-boot-only top bar intro, played right after the sidebar intro (built
  // in wireChrome; a no-op unless [ui] topbar-animation is on)
  playTopbarIntro?: () => void;
  // re-apply the hover drawer's panel states AFTER the boot layout mounts
  // (constructed pre-boot, its collapse writes hit no nodes yet — without
  // this, auto-hidden panels paint expanded while the grid is laid out
  // collapsed)
  afterLayout?: () => void;
}) => {
  const { core, nav, chrome, gridFoundation, grid, fileops, bootStart } = deps;
  runBoot({
    waitForResolution: () => waitForResolution(chrome.renderer),
    // restart child only: the waiting parent never destroyed, so its kitty
    // placements are still on screen under ours — delete-all once, first.
    // Fresh boots skip this so other programs' images are never nuked. The
    // flag is consumed (read+deleted) unconditionally, so a stale export can
    // neither misfire here nor leak into shells/children.
    isRestartChild: consumeRestartFlag(process.env),
    clearStaleImages: () => {
      try {
        process.stdout.write(kittyDeleteAllImages());
      } catch {}
    },
    mountSlots: deps.mountSlots,
    buildLayout: () => {
      // scrollers x2 (one per pane)/band rect/drag ghost — module:
      // ./ui-boot-layout (ids stay byte-identical; band gesture fns wired
      // there straight from grid-input)
      const scrollers = buildBootLayout({
        renderer: chrome.renderer,
        byId: core.lookup.byId,
        colors: core.colors,
        bandCtx: grid.bandCtx,
        focusPane: (i) => grid.focusPane(i as 0 | 1),
        dropIntoPane: (i) => grid.dropIntoPane(i as 0 | 1),
        closeFileMenu: chrome.menu.closeFileMenu,
        clearSearch: nav.clearSearch,
        blurTerminal: fileops.terminal.blurTerminal,
        pathEditMode: () => chrome.activeToolbar().pathEditMode(),
        exitPathEdit: () => chrome.activeToolbar().exitPathEdit(),
        isRenaming: gridFoundation.rename.isRenaming,
        finishInlineRename: gridFoundation.rename.finishInlineRename,
        clearTileSelection: gridFoundation.selection.clearTileSelection,
        openContextMenu: (x: number, y: number, t: string, e: any[]) => chrome.menu.openContextMenu(x, y, t, e),
        emptyAreaEntries: grid.menuEntries.emptyAreaEntries,
      });
      core.scrollerRefs[0]!.current = scrollers[0];
      core.scrollerRefs[1]!.current = scrollers[1];
      // [ui] windowed-grid: the hook wraps the scrollTop setter (wheel, drag
      // auto-scroll, programmatic scrollTo) AND chains the scrollbar's
      // _onChange — a thumb drag writes the position field raw, never the
      // setter (ScrollBox exposes no scroll event)
      hookScrollerScroll(scrollers[0], () => grid.syncWindowPane(0));
      hookScrollerScroll(scrollers[1], () => grid.syncWindowPane(1));
      // the hover drawer's construction-time collapse wrote to no nodes (they
      // only mount here) — re-apply its panel states now that they exist
      try {
        deps.afterLayout?.();
      } catch {}
    },
    loadGlobs2: () => loadGlobs2(),
    restoreSession: () => {
      if (!deps.skipSessionRestore) nav.restoreSession();
    },
    loadSystemPlaces: () => loadSystemPlaces(),
    renderAll: nav.renderAll,
    playSidebarIntro: () => deps.playSidebarIntro?.(),
    playTopbarIntro: () => deps.playTopbarIntro?.(),
    debugTrace: () => {
      debugLog(
        `terminal ${chrome.renderer.terminalWidth}x${chrome.renderer.terminalHeight} cwd=${process.cwd()} config=${configPath()}`,
      );
      nav.setStatusMsg(`debug: ${DEBUG_LOG}`);
    },
    launchToast: () => chrome.notify(`launched in ${Math.round(performance.now() - bootStart)} ms`),
    startHygiene: () =>
      startMemHygiene({
        // CliRenderer.lib is private with no public stats accessor — this
        // diagnostics-only reach stays narrowed to the one method we call
        // (see the seam note in ./mem-hygiene) instead of `any`
        allocatorStats: () => {
          try {
            return (chrome.renderer as unknown as NativeStatsReach).lib?.getAllocatorStats?.() ?? null;
          } catch {
            return null;
          }
        },
        debugLog: isDebug ? (msg) => debugLog(msg) : undefined,
      }),
    wireSearchInput: () => nav.wireSearchInput(),
    reportBootError: (name, err) => {
      // a throw here (native OOM during buildLayout, globs2 io, …) must not
      // leave a blank-but-alive TUI — report it and keep whatever rendered
      try {
        dlog(`boot ${name} failed: ${err instanceof Error ? (err.stack ?? err.message) : err}`);
        chrome.notify(`Startup step "${name}" failed`, "boot error", "error");
      } catch {}
    },
    isDebug,
    showLaunchTime: () => core.config.ui.showLaunchTime,
  }).catch(() => {}); // every step is guarded in ./boot; this catches the tail
};

// --- OSC 72 (kitty drag-and-drop): wire format per yazi's reference impl;
// the state machine (outgoing drags, incoming drops, self-drop routing) lives
// in ./dnd72, the byte-exact frames in ./osc72. Only the renderer-coupled
// hooks stay here: cell hit-testing, tile highlight and place hover. ---
export const wireDnd = (deps: {
  core: CoreWiring;
  nav: NavWiring;
  chrome: ChromeWiring;
  gridFoundation: GridFoundationWiring;
  grid: GridWiring;
  fileops: FileopsWiring;
}) => {
  const { core, nav, chrome, gridFoundation, grid, fileops } = deps;
  // drop-target tile resolution must find a tile in EITHER pane; the merged
  // live map unions both panes' tileRefs (pane-prefixed ids make them unique).
  const allTileRefs = mergedMapFacade(() => [
    gridFoundation.selections[0].tileRefs,
    gridFoundation.selections[1].tileRefs,
  ]);
  const { enableDrops, disableDrops } = makeDnd72({
    log: (msg) => dlog(msg),
    writeFrame: (s) => {
      try {
        process.stdout.write(s);
      } catch {}
    },
    // cell -> drop target walk lives in ./hit-target (tested); the wiring
    // supplies the renderer-coupled hitTest + registry and the live place refs
    hitTargetAt: makeHitTargetAt({
      hitTest: (x, y) => chrome.renderer.hitTest(x, y),
      byNumber: (num) => Renderable.renderablesByNumber.get(num),
      placesHost: () => chrome.chrome.placesHost,
      tileRefs: allTileRefs,
      panesCwd: () => [core.panes.states[0]!.cwd, core.panes.states[1]!.cwd],
    }),
    tileRefs: allTileRefs,
    setTileVisual: gridFoundation.selection.setTileVisual,
    hoverPlace: (p) => {
      const idx = chrome.chrome.placesHost.findIndex((pl: { place: { path?: string | null } }) => pl.place.path === p);
      if (idx >= 0) chrome.chrome.setMousePlace(idx);
    },
    clearHoverPlace: () => chrome.chrome.clearMousePlace(),
    finishDrag: grid.finishDrag,
    escMenuOpen: () => core.floats.isOpen("escmenu"),
    fileMenuOpen: () => core.floats.isOpen("filemenu"),
    trashPaths: fileops.trash.trashPaths,
    moveInto: fileops.fileops.moveInto,
    runTransfer: fileops.fileops.runTransfer,
    cwd: () => core.state.cwd,
    virtualCwd: core.isVirtualCwd,
    inTrashView: core.inTrashView,
    setStatusMsg: nav.setStatusMsg,
    notify: chrome.notify,
    subscribeOsc: (cb) => chrome.renderer.subscribeOsc(cb),
  });
  enableDrops();
  // XTSHIFTESCAPE=1 (CSI > Ps s): ask the terminal (kitty, ghostty, xterm) to
  // forward shift+click instead of using it for native text selection.
  // Terminals that don't know the sequence ignore it; alt+click is the fallback.
  // (frame builder in ./ui-term; released on quit via the quit wiring)
  try {
    dlog("tx xtshiftescape on");
    process.stdout.write(xtShiftEscapeFrame(true));
  } catch {}
  return { enableDrops, disableDrops };
};

// --- resize: repave rasters and rebuild layout. The trailing debounce lives
// in ./lib/uiutil (debounced) — the same timing tenant ui-status uses; only
// the body differs (icon-queue reset first so every raster re-renders at the
// new cell pixels). ---
export const wireResize = (deps: { core: CoreWiring; nav: NavWiring; chrome: ChromeWiring }) => {
  const { core, nav, chrome } = deps;
  const onResize = debounced(150, () => {
    core.slots.resetIconQueue();
    nav.renderAll();
  });
  chrome.renderer.on(CliRenderEvents.RESIZE, onResize);
};

// --- Hover drawer: auto-hide/collapse panels until the mouse nears an edge.
// The panel policy + timelines live in ./ui-hover-drawer (pure decision fns
// are tested); the wiring supplies the live config/state getters and the
// suppression predicate (a drag to the edge must not pop the drawer). ---
export const wireHoverDrawer = (deps: {
  core: CoreWiring;
  chrome: ChromeWiring;
  fileops: FileopsWiring;
  gridFoundation: GridFoundationWiring;
  grid: GridWiring;
}) => {
  const { core, chrome, fileops, gridFoundation, grid } = deps;
  return makeHoverDrawer({
    renderer: chrome.renderer,
    byId: core.lookup.byId,
    ui: () => core.config.ui,
    terminalOpen: () => fileops.terminal.isOpen(),
    terminalFocused: () => fileops.terminal.ownsKeyboard(),
    blocked: () =>
      core.floats.depth() > 0 ||
      chrome.activeToolbar().pathEditMode() ||
      gridFoundation.rename.isRenaming() ||
      gridDrag.active,
    setEffectiveSidebar: (n) => {
      core.geometry.sidebarEff = n;
    },
    setEffectivePreview: (n) => {
      core.geometry.previewEff = n;
    },
    // a pane slide changes the columns the grid can fit; rebuild once on settle
    // (the drawer coalesces bursts) and keep the scroll offset so the view
    // doesn't jump to top
    onSettle: () => {
      const scroller = core.scrollerRef.current;
      const y = scroller?.scrollTop ?? 0;
      void grid.renderGrid().then(() => {
        try {
          if (scroller) scroller.scrollTop = y;
        } catch {}
        // reclaim the old tiles' native buffers now instead of waiting for the
        // 10s mem-hygiene poke (same mitigation as a theme flip)
        try {
          Bun.gc(false);
        } catch {}
      });
      // a preview that just EXPANDED was skipped while collapsed (visible()
      // gate) — render it now so it shows the focused file instead of blank
      void grid.renderPreview();
    },
    log: (msg) => dlog(msg),
  });
};
