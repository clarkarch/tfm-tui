// --- I/O wiring, in the original wiring order: cwd watcher, the boot
// sequence, OSC 72 drag-and-drop (+ the XTSHIFTESCAPE request), and the
// resize repave. Everything renderer-coupled arrives as an injected step. ---

import { CliRenderEvents, Renderable } from "@opentui/core";
import { runBoot } from "../boot";
import { buildBootLayout } from "../ui-boot-layout";
import { makeCwdWatcher } from "../watcher";
import { makeDnd72 } from "../dnd72";
import { makeHitTargetAt } from "../hit-target";
import { makeResizeWatcher } from "../resize";
import { waitForResolution } from "../ui-lookup";
import { loadGlobs2 } from "../filetype";
import { loadSystemPlaces } from "../places";
import { startMemHygiene } from "../mem-hygiene";
import { xtShiftEscapeFrame } from "../ui-term";
import { configPath } from "../config";
import { debugLog, dlog, isDebug, DEBUG_LOG } from "../log";
import type { CoreWiring } from "./core";
import type { ChromeWiring, FileopsWiring, GridFoundationWiring, GridWiring, NavWiring } from "./types";
export type WatcherWiring = ReturnType<typeof makeCwdWatcher>;
export type DndWiring = ReturnType<typeof makeDnd72>;

// --- Live directory watching: external changes refresh the grid.
// Watch lifecycle lives in ./watcher (tested); the wiring supplies the live
// cwd/renaming/renderGrid getters (TDZ seam rule). ---
export const wireWatcher = (deps: {
  core: CoreWiring;
  getGridFoundation: () => GridFoundationWiring;
  getGrid: () => GridWiring;
}) => {
  const { core, getGridFoundation, getGrid } = deps;
  const { syncCwdWatcher } = makeCwdWatcher({
    cwd: () => core.state.cwd,
    isVirtualCwd: core.isVirtualCwd,
    isRenaming: () => getGridFoundation().rename.isRenaming(),
    renderGrid: () => getGrid().renderGrid(),
  });
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
}) => {
  const { core, nav, chrome, gridFoundation, grid, fileops, bootStart } = deps;
  void runBoot({
    waitForResolution: () => waitForResolution(chrome.renderer),
    buildLayout: () => {
      // scroller/band rect/drag ghost — module: ./ui-boot-layout (ids stay
      // byte-identical; band gesture fns wired there straight from grid-input)
      core.scrollerRef.current = buildBootLayout({
        renderer: chrome.renderer,
        byId: core.lookup.byId,
        colors: core.colors,
        bandCtx: grid.bandCtx,
        closeFileMenu: chrome.menu.closeFileMenu,
        clearSearch: nav.clearSearch,
        blurTerminal: fileops.terminal.blurTerminal,
        pathEditMode: chrome.toolbar.pathEditMode,
        exitPathEdit: chrome.toolbar.exitPathEdit,
        isRenaming: gridFoundation.rename.isRenaming,
        finishInlineRename: gridFoundation.rename.finishInlineRename,
        clearTileSelection: gridFoundation.selection.clearTileSelection,
        openContextMenu: (x: number, y: number, t: string, e: any[]) => chrome.menu.openContextMenu(x, y, t, e),
        emptyAreaEntries: grid.menuEntries.emptyAreaEntries,
      });
    },
    loadGlobs2: () => loadGlobs2(),
    restoreSession: () => nav.restoreSession(),
    loadSystemPlaces: () => loadSystemPlaces(),
    renderAll: nav.renderAll,
    debugTrace: () => {
      debugLog(
        `terminal ${chrome.renderer.terminalWidth}x${chrome.renderer.terminalHeight} cwd=${process.cwd()} config=${configPath()}`,
      );
      nav.setStatusMsg(`debug: ${DEBUG_LOG}`);
    },
    launchToast: () => chrome.notify(`launched in ${Math.round(performance.now() - bootStart)} ms`),
    startHygiene: () =>
      startMemHygiene({
        // the private allocator stats reach is the only renderer-coupled part,
        // so it's injected here (module: ./mem-hygiene)
        allocatorStats: () => {
          try {
            return (chrome.renderer as any).lib?.getAllocatorStats?.() ?? null;
          } catch {
            return null;
          }
        },
        debugLog: isDebug ? (msg) => debugLog(msg) : undefined,
      }),
    wireSearchInput: () => nav.wireSearchInput(),
    isDebug,
    showLaunchTime: () => core.config.ui.showLaunchTime,
  });
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
      byNumber: (num) => (Renderable as any).renderablesByNumber?.get(num),
      placesHost: () => chrome.chrome.placesHost,
      tileRefs: gridFoundation.selection.tileRefs,
    }),
    tileRefs: gridFoundation.selection.tileRefs,
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
    home: core.home,
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

// --- resize: repave rasters and rebuild layout (debounce lives in ./resize) ---
export const wireResize = (deps: { core: CoreWiring; nav: NavWiring; chrome: ChromeWiring }) => {
  const { core, nav, chrome } = deps;
  const { onResize } = makeResizeWatcher({
    resetIconQueue: () => core.slots.resetIconQueue(),
    renderAll: nav.renderAll,
  });
  chrome.renderer.on(CliRenderEvents.RESIZE, onResize);
};
