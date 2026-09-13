// --- Fileops wiring: undo stack, transfer conflict prompt, copy progress,
// the file-operations engine itself (copy/move/paste/clipboard), the embedded
// terminal pane, trash operations and their confirm dialogs. Runs AFTER the
// grid foundation (takes refreshCutVisuals directly) and BEFORE the grid
// wiring (gridCtx takes moveInto directly). ---

import { makeUndo } from "../app/undo";
import { clearUndoJournal, readUndoJournal, saveUndoJournal } from "../fs/undo-journal";
import { makeConflict, makeYesNo } from "../ui/ui-dialogs";
import { makeProgress } from "../ui/ui-progress";
import { makeFileOps } from "../fs/fileops";
import { makeTerminal } from "../ui/ui-term";
import { makeTrashOps, makeTrashConfirms } from "../fs/trashops";
import { shouldToast } from "../fs/fsutil";
import { appendLog, dlog } from "../app/log";
import { sharedPluginEvents } from "../lib/plugin-events";
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
  // Persistent undo ([ui] persist-undo, off by default): the journalable tail
  // is saved synchronously on every stack change and re-adopted at boot.
  // Function declaration (hoisted) so the onChange closure below is TDZ-safe.
  function syncUndoJournal(): void {
    if (core.config.ui.persistUndo) {
      try {
        saveUndoJournal(undo.snapshotData());
      } catch (err) {
        dlog(`undo journal save failed: ${err}`);
      }
    } else {
      clearUndoJournal();
    }
  }
  const undo = makeUndo(
    {
      notify: chrome.notify,
      renderAll: nav.renderAll,
      onEvent: (op, label) => {
        try {
          sharedPluginEvents().emit("undo", { op, label });
        } catch {}
      },
    },
    { log: (msg) => dlog(msg), onChange: syncUndoJournal },
  );
  if (core.config.ui.persistUndo) {
    const restored = readUndoJournal();
    if (restored.length) {
      const n = undo.adoptBatches(restored);
      dlog(`undo journal: adopted ${n} batches from previous session`);
    }
  } else {
    // don't let a stale journal linger from when the option was last on
    clearUndoJournal();
  }

  const conflict = makeConflict(chrome.dialogs, {
    colors: themeGet,
    drainIconQueue: () => drainIconQueue(),
    floats: core.floats,
  });

  // --- live copy progress: floating toast (top-right) with pause/cancel.
  // The shell lives in ./notify (single stack via notifySticky) — this only
  // passes the icon-slot machinery the buttons need. ---
  const progress = makeProgress({
    byId,
    stripSelectable,
    colors: () => core.colors,
    makeIconSlot,
    setIconState,
    drainIconQueue,
    notifySticky: chrome.notifySticky,
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
    notify: chrome.notify,
    home,
    refreshCutVisuals: gridFoundation.refreshCutVisuals,
    log: (msg) => dlog(msg),
    onFileOp: (op, paths, dest, outcome) =>
      sharedPluginEvents().emit("file-op", { op, paths, ...(dest ? { dest } : {}), ...(outcome ? { outcome } : {}) }),
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
    notify: chrome.notify,
    renderAll: nav.renderAll,
    // delete progress: the driver maps trashops' calls onto the SAME prog
    // state + toast transfers use (pause/cancel included). Flags reset at
    // start so a stale cancel from an earlier op can't abort the delete.
    deleteProgress: {
      sink: fileops.progressSink,
      start: (totalFiles, totalBytes) => {
        const p = progress.prog;
        p.paused = false;
        p.cancelled = false;
        p.doneFiles = 0;
        p.bytes = 0;
        p.totalFiles = totalFiles;
        p.totalBytes = totalBytes;
        p.verb = "deleting";
        if (shouldToast(totalBytes, totalFiles)) {
          p.active = true;
          progress.showProgressToast();
          progress.paintProgress(true);
        }
      },
      cancelled: () => progress.prog.cancelled,
      finish: (msg) => progress.finishProgressToast(msg),
      stop: () => {
        progress.prog.active = false;
      },
    },
    log: (msg) => appendLog(`trashops: ${msg}`),
    // plugin event fan-out through the sink seam (no method wrapping — the
    // op names are the stable vocabulary, never the method names).
    onEvent: (op, paths) => {
      try {
        sharedPluginEvents().emit("trash", { op, paths });
      } catch {}
    },
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
    syncUndoJournal,
    conflict,
    fileops,
    terminal,
    trash,
    yesNo,
    confirmEmptyTrash,
    confirmDeleteForever,
  };
};
