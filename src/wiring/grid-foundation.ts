// --- Grid wiring, phase 1: selection + focus state (single source of truth
// shared by the grid build, mouse pipeline, OSC 72 and the keyboard router)
// and inline rename/create. Runs BEFORE the fileops wiring (makeFileOps takes
// refreshCutVisuals directly) while rename's performRename/pushUndoBatch stay
// deferred arrows into it (TDZ seam rule). ---

import { makeSelection, type SelTileRef, type Selection } from "../input/selection";
import { makeRename } from "../ui/ui-rename";
import { makeBulkRename } from "../ui/ui-bulk-rename";
import { clearChildren } from "../lib/uiutil";
import { sharedPluginEvents } from "../lib/plugin-events";
import { activeFacade, activeMapFacade } from "../app/panes";
import type { CoreWiring } from "./core";
import type { ChromeWiring, FileopsWiring, GridWiring, NavWiring } from "./types";

export const wireGridFoundation = (deps: {
  core: CoreWiring;
  nav: NavWiring;
  chrome: ChromeWiring;
  getGrid: () => GridWiring;
  getFileops: () => FileopsWiring;
}) => {
  const { core, nav, chrome, getGrid, getFileops } = deps;

  const selectionFor = (pane: 0 | 1): Selection =>
    makeSelection({
      colors: core.themeGet,
      uiStyle: () => core.config.ui.uiStyle,
      byId: core.lookup.byId,
      setText: core.lookup.setTextOnId,
      setIconState: core.slots.setIconState,
      isCutKey: core.isCutKey,
      scroller: () => core.scrollerRefs[pane].current,
      viewH: () => chrome.renderer.terminalHeight - 3,
      rowHInit: () => core.geometry.tileH,
      renderPreview: () => getGrid().renderPreview(),
      onSelection: (paths) => sharedPluginEvents().emit("selection", { paths }),
      isActive: () => core.panes.active === pane,
    });

  // two independent selections; `selection` is a stable facade over the active
  // pane so every existing consumer reads the active pane without changes.
  // tileRefs is overridden with a live map facade because ui-rename/preview and
  // the menu capture it ONCE at construction.
  const selections: [Selection, Selection] = [selectionFor(0), selectionFor(1)];
  const activeTileRefs = activeMapFacade(() => selections[core.panes.active].tileRefs as Map<string, SelTileRef>);
  const selection = activeFacade(() => selections[core.panes.active], {
    tileRefs: activeTileRefs as unknown,
  });

  // cut/copy/paste dimming must repaint in BOTH panes (a path can be visible on
  // either side); the facade method only reaches the active one.
  const refreshCutVisuals = (): void => {
    selections[0].refreshCutVisuals();
    selections[1].refreshCutVisuals();
  };

  // --- inline rename/create: widget + state live in ./ui-rename ---
  const rename = makeRename({
    renderer: () => chrome.renderer,
    byId: core.lookup.byId,
    colors: core.themeGet,
    tileW: () => core.geometry.tileW,
    tileRefs: selection.tileRefs,
    stripSelectable: core.lookup.stripSelectable,
    renderAll: nav.renderAll,
    renderGrid: () => getGrid().renderGrid(),
    // arrow wrappers: performRename/pushUndoBatch belong to the fileops wiring (TDZ)
    performRename: (p, name) => getFileops().fileops.performRename(p, name),
    pushUndoBatch: (label, undos, redos, data) => getFileops().undo.pushUndoBatch(label, undos, redos, data),
    notify: chrome.notify,
    isVirtualCwd: core.isVirtualCwd,
    inTrashView: core.inTrashView,
    cwd: () => core.state.cwd,
    focusKeys: () => selection.focusKeys(),
    selectTileAt: selection.selectTileAt,
  });

  // --- bulk rename: F2 on a multi-selection edits names one-per-line in a
  // modal (widget + planner); apply is ONE undo batch via fileops ---
  const bulkRename = makeBulkRename({
    renderer: () => chrome.renderer,
    byId: core.lookup.byId,
    rootAdd: (node) => chrome.renderer.root.add(node),
    clearChildren,
    stripSelectable: core.lookup.stripSelectable,
    escHintBtn: core.slots.escHintBtn,
    drainIconQueue: () => core.slots.drainIconQueue(),
    colors: core.themeGet,
    uiStyle: () => core.config.ui.uiStyle,
    floats: core.floats,
    // arrow wrapper: performBulkRename belongs to the fileops wiring (TDZ)
    performBulkRename: (pairs) => getFileops().fileops.performBulkRename(pairs),
  });
  // rename guard here (both callers — keymap F2 and the context menu — route
  // through it): virtual views span directories, so one-name-per-line is
  // ambiguous; trash uses restore, not rename
  const startBulkRename = (paths: string[]): void => {
    if (core.isVirtualCwd() || core.inTrashView()) {
      chrome.notify("Can't rename here", "rename", "error");
      return;
    }
    bulkRename.open(paths);
  };

  return { selection, selections, refreshCutVisuals, rename, bulkRename, startBulkRename };
};
