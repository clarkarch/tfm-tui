// --- Fileops wiring: undo stack, transfer conflict prompt, copy progress,
// the file-operations engine itself (copy/move/paste/clipboard), the embedded
// terminal pane, trash operations and their confirm dialogs. Runs AFTER the
// grid foundation (takes refreshCutVisuals directly) and BEFORE the grid
// wiring (gridCtx takes moveInto directly). ---

import { makeUndo } from "../app/undo";
import { makeConflict, makeYesNo } from "../ui/ui-dialogs";
import { makeProgress } from "../ui/ui-progress";
import { makeFileOps } from "../fs/fileops";
import { makeTerminal } from "../ui/ui-term";
import { makeTrashOps, makeTrashConfirms } from "../fs/trashops";
import { appendLog, dlog } from "../app/log";
import type { CoreWiring } from "./core";
import type { ChromeWiring, GridFoundationWiring, NavWiring } from "./types";

export const wireFileops = (deps: {
  core: CoreWiring;
  nav: NavWiring;
  chrome: ChromeWiring;
  gridFoundation: GridFoundationWiring;
  // grid's finishDragCtx (internal drag commit) — grid wiring builds it later
  finishDrag(): void;
}) => {
  const { core, nav, chrome, gridFoundation } = deps;
  const { byId, stripSelectable } = core.lookup;
  const { makeIconSlot, setIconState, drainIconQueue } = core.slots;
  const { themeGet, home } = core;
  const uiStyle = () => core.config.ui.uiStyle;

  // --- Undo stack — state machine lives in ./undo (pure, tested) — results
  // surface via sink; the override (conflict) prompt dialog lives in ./ui-dialogs ---
  const undo = makeUndo({
    status: nav.setStatusMsg,
    notify: chrome.notify,
    refresh: nav.renderAll,
  });

  const conflict = makeConflict(chrome.dialogs, {
    colors: themeGet,
    drainIconQueue: () => drainIconQueue(),
    floats: core.floats,
  });

  // --- live copy progress: floating toast (top-right) with pause/cancel ---
  const progress = makeProgress({
    byId,
    rootAdd: (node) => chrome.renderer.root.add(node),
    remove: (node) => {
      try {
        (node.parent ?? chrome.renderer.root).remove(node);
      } catch {}
    },
    stripSelectable,
    termW: () => chrome.renderer.terminalWidth,
    toastCount: chrome.toastCount,
    colors: () => core.colors,
    makeIconSlot,
    setIconState,
    drainIconQueue,
  });

  // --- File operations: runTransfer/performRename/paste/clipboard
  // orchestration lives in ./fileops; the copy engine is ./transfer (pure,
  // sink-injected), the progress toast is ./ui-progress. ---
  const fileops = makeFileOps({
    conflict,
    prog: progress.prog,
    paintProgress: progress.paintProgress,
    showProgressToast: progress.showProgressToast,
    finishProgressToast: progress.finishProgressToast,
    pauseGate: progress.pauseGate,
    pushUndoBatch: undo.pushUndoBatch,
    renderAll: nav.renderAll,
    setStatusMsg: nav.setStatusMsg,
    notify: chrome.notify,
    home,
    refreshCutVisuals: gridFoundation.selection.refreshCutVisuals,
    log: (msg) => dlog(msg),
  });

  // --- Embedded terminal pane — widget lives in ./ui-term ---
  const terminal = makeTerminal({
    renderer: chrome.renderer,
    byId,
    uiStyle,
    colors: themeGet,
    sw: () => core.geometry.sw,
    escHintBtn: (id, onClose) => core.slots.escHintBtn(id, onClose),
    stripSelectable,
    drainIconQueue: () => drainIconQueue(),
    notify: chrome.notify,
    renderAll: nav.renderAll,
    cwd: () => core.state.cwd,
    virtualCwd: core.isVirtualCwd,
    home,
    finishDrag: deps.finishDrag,
    dlog: (msg) => dlog(msg),
  });

  const trash = makeTrashOps({
    pushUndoBatch: undo.pushUndoBatch,
    status: nav.setStatusMsg,
    notify: chrome.notify,
    refresh: nav.renderAll,
    log: (msg) => appendLog(`trashops: ${msg}`),
  });

  // floating Yes/No confirmation — widget lives in ./ui-dialogs
  const yesNo = makeYesNo(chrome.dialogs, {
    colors: themeGet,
    canOpen: () => !!chrome.renderer.resolution,
    floats: core.floats,
  });

  // --- Trash-bound confirm dialogs: label+verb bindings live in ./trashops ---
  const { confirmEmptyTrash, confirmDeleteForever } = makeTrashConfirms({
    confirm: yesNo.confirm,
    emptyTrash: trash.emptyTrash,
    deleteForever: trash.deleteForever,
  });

  return {
    undo,
    conflict,
    progress,
    fileops,
    terminal,
    trash,
    yesNo,
    confirmYesNo: yesNo.confirm,
    confirmEmptyTrash,
    confirmDeleteForever,
  };
};
