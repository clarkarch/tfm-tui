// --- Grid wiring, phase 1: selection + focus state (single source of truth
// shared by the grid build, mouse pipeline, OSC 72 and the keyboard router)
// and inline rename/create. Runs BEFORE the fileops wiring (makeFileOps takes
// refreshCutVisuals directly) while rename's performRename/pushUndoBatch stay
// deferred arrows into it (TDZ seam rule). ---

import { makeSelection } from "../selection";
import { makeRename } from "../ui-rename";
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

  const selection = makeSelection({
    colors: core.themeGet,
    uiStyle: () => core.config.ui.uiStyle,
    byId: core.lookup.byId,
    setIconState: core.slots.setIconState,
    isCutKey: core.isCutKey,
    scroller: () => core.scrollerRef.current,
    viewH: () => chrome.renderer.terminalHeight - 3,
    rowHInit: () => core.geometry.tileH,
    renderPreview: () => getGrid().renderPreview(),
  });

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
    pushUndoBatch: (label, undos, redos) => getFileops().undo.pushUndoBatch(label, undos, redos),
    setStatusMsg: nav.setStatusMsg,
    isVirtualCwd: core.isVirtualCwd,
    inTrashView: core.inTrashView,
    cwd: () => core.state.cwd,
    focusKeys: () => selection.focusKeys(),
    selectTileAt: selection.selectTileAt,
  });

  return { selection, rename };
};
