// --- Fileops wiring: undo stack, transfer conflict prompt, copy progress,
// the file-operations engine itself (copy/move/paste/clipboard), the embedded
// terminal pane, trash operations and their confirm dialogs. Runs AFTER the
// grid foundation (takes refreshCutVisuals directly) and BEFORE the grid
// wiring (gridCtx takes moveInto directly). ---

import { makeUndo } from "../app/undo";
import { clearUndoJournal, readUndoJournal, saveUndoJournal } from "../fs/undo-journal";
import { makeConflict, makeYesNo } from "../ui/ui-dialogs";
import { makeOpProgress, makeProgress } from "../ui/ui-progress";
import { makeFileOps } from "../fs/fileops";
import { makeTerminal } from "../ui/ui-term";
import { makeTrashOps, makeTrashConfirms } from "../fs/trashops";
import { appendLog, dlog } from "../lib/log";
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
  // password-prompt overlay — keymap wires LAST (TDZ seam, same pattern as
  // wireChrome's getPrompt above)
  getPrompt: () => { open(o: { title: string; okLabel?: string; password?: boolean }): Promise<string | null> };
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
    { log: dlog, onChange: syncUndoJournal },
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

  // Mouse pointer shapes (OSC 22): the single shared tty-guarded sink from
  // wireCore (see there for why per-cluster instances diverged).
  const setPointer = core.setPointer;

  const conflict = makeConflict(chrome.dialogs, {
    colors: themeGet,
    uiStyle,
    byId,
    drainIconQueue,
    floats: core.floats,
    setPointer,
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
    setPointer,
    // the spinner rides the renderer's shared animation clock (OpenTUI 0.8.0)
    // instead of owning a private interval
    onTick: (fps, cb) => chrome.renderer.onAnimationTick(fps, () => cb()),
  });

  // --- progress driver for the ops that MOVE bytes but do NOT run through
  // the fileops transfer engine (the deletes, and the cross-device
  // trash/restore copy). The driver lives in ./ui-progress (it owns the prog
  // state + the toast): every byte-moving op has ONE bar with ONE
  // pause/cancel pair — and an op that moves bytes can never run without a
  // status. ---

  // --- File operations: runTransfer/performRename/paste/clipboard
  // orchestration lives in ./fileops; the copy engine is ./transfer (pure,
  // sink-injected), the progress toast is ./ui-progress. ---
  // sudo gate: chrome wires it first (same getPrompt dep + notify) — one
  // shared gate, the factory is stateless.
  const ensureSudo = chrome.ensureSudo;
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
    ensureSudo,
    log: dlog,
    onFileOp: (op, paths, dest, outcome) =>
      sharedPluginEvents().emit("file-op", { op, paths, ...(dest ? { dest } : {}), ...(outcome ? { outcome } : {}) }),
    // a finished long op raises a TERMINAL notification (OSC 99 / OSC 777 /
    // OSC 9 — the renderer negotiates the protocol with the terminal and
    // silently does nothing on a terminal that has none)
    notifyTerminal: (message, title) => {
      try {
        chrome.renderer.triggerNotification(message, title);
      } catch {}
    },
  });

  // --- Embedded terminal pane — widget lives in ./ui-term ---
  const terminal = makeTerminal({
    renderer: chrome.renderer,
    byId,
    uiStyle,
    colors: themeGet,
    sw: () => core.geometry.sw,
    termH: () => core.config.ui.terminalHeight,
    // force only (not `on`: panels still paint there): same TTY guard as the
    // renderer boot in wiring/chrome — no alpha on the Linux console
    transparentForce: () => core.config.ui.transparentBg === "force" && !core.isTtyMode(),
    escHintBtn: core.slots.escHintBtn,
    stripSelectable,
    drainIconQueue,
    notify: chrome.notify,
    renderAll: nav.renderAll,
    cwd: () => core.state.cwd,
    virtualCwd: core.isVirtualCwd,
    home,
    finishDrag: deps.finishDrag,
    dlog,
    setPointer,
  });

  const trash = makeTrashOps({
    pushUndoBatch: undo.pushUndoBatch,
    notify: chrome.notify,
    renderAll: nav.renderAll,
    ensureSudo,
    // progress driver factory: every op that MOVES bytes reports into the
    // SAME prog state + toast transfers use (pause/cancel included). The
    // verb is the default; the cross-device trash/restore copy passes its
    // own at start() time ("trashing" / "restoring").
    // Flags reset at start so a stale cancel from an earlier op can't abort
    // the next one.
    deleteProgress: makeOpProgress(progress, "deleting"),
    trashProgress: makeOpProgress(progress, "trashing"),
    log: (msg) => appendLog(`trashops: ${msg}`),
    // a finished long op raises a TERMINAL notification (OSC 99 / OSC 777 /
    // OSC 9 — the renderer negotiates the protocol with the terminal and
    // silently does nothing on a terminal that has none)
    notifyTerminal: (message, title) => {
      try {
        chrome.renderer.triggerNotification(message, title);
      } catch {}
    },
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
    uiStyle: () => core.config.ui.uiStyle,
    byId: core.lookup.byId,
    // NO readiness gate: the old `!!renderer.resolution` predicate only became
    // true when the terminal answered OpenTUI's pixel-size query, so on the
    // Linux console / tmux Empty Trash and Delete Forever silently no-op'd.
    // makeConflict opens ungated for the same reason — dialogs mount on the
    // always-present renderer root.
    floats: core.floats,
    setPointer,
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
    progress,
    confirmEmptyTrash,
    confirmDeleteForever,
  };
};
