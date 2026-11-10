import { failSuffix, fsErrText } from "../fs/fsutil";
import { sharedOpQueue } from "../lib/op-queue";
import type { NotifyLevel } from "../lib/notify-level";
import {
  MAX_UNDO_BATCHES,
  stepToUnit,
  type UndoBatchData,
  type UndoJournalData,
  type UndoUnit,
} from "../fs/undo-steps";

// --- Undo/redo stack. Pure state machine — no renderer/state imports; the
// app surfaces results through an injected UndoSink (same seam as
// trashops/transfer). Every batch carries paired inverses: `units` reverse
// the op, `redos` re-apply it; a batch without `redos` breaks the redo chain
// (replace-stash can't re-apply). A fresh push clears stale redos. ---
//
// Persistence: closures can't cross a restart, so journalable batches also
// carry `UndoBatchData` — the same inverses as plain fs-step data (below).
// `snapshotData()` exports the journalable tail for the journal file and
// `adoptBatches()` rehydrates it at boot by interpreting each step back into
// a closure. Batches pushed without data are session-only (still fully
// undoable in memory, just not restorable after a restart). ---

type OpBatch = { label: string; units: UndoUnit[]; redos: UndoUnit[] };

// an undo/redo stack entry: the batch plus its journal data alongside
// (null = session-only, pushed without data — fully undoable in memory,
// skipped by snapshotData)
type UndoEntry = { batch: OpBatch; data: UndoBatchData | null };

// The in-flight op: ONE object with an explicit phase. The old shape was
// THREE facts about one op — a bare `running` boolean, the popped entry
// (held in a closure) and the re-push that landed at the end of the async
// body — and the re-push could land AFTER a fresh op had forked the
// history, resurrecting a stale entry on the redo stack.
//
//   "popped"  — the entry is off the stack; the batch has not started
//   "running" — the batch is on the shared op queue
//   "settled" — the outcome is known; the op may (re-)enter a stack
type UndoOp = {
  phase: "popped" | "running" | "settled";
  entry: UndoEntry;
  // the history's version when the op popped its entry: a fresh op pushed
  // while this one was in flight forks the history, and a forked history
  // must not take the op's entry back
  version: number;
};

export type UndoSink = {
  notify: (message: string, title?: string, level?: NotifyLevel) => void;
  renderAll: () => void;
  // plugin event fan-out: fires ONLY on an actual pop (empty stacks and the
  // in-flight guard are silent no-ops, never events). Never throws into undo.
  onEvent?: (op: "undo" | "redo", label: string) => void;
};

const dataToBatch = (data: UndoBatchData, log: (msg: string) => void = () => {}): OpBatch => ({
  label: data.label,
  units: data.units.map((s) => stepToUnit(s, log)),
  redos: data.redos.map((s) => stepToUnit(s, log)),
});

type UndoOpts = {
  /** debug sink for rehydrated-step logs (defaults to silent) */
  log?: (msg: string) => void;
  /** fired on push/undo/redo so the wiring can persist the journal */
  onChange?: () => void;
};

export const makeUndo = (sink: UndoSink, opts: UndoOpts = {}) => {
  const log = opts.log ?? (() => {});
  const onChange = opts.onChange ?? (() => {});
  // the in-flight op (null = idle). ONE record: the old `running` boolean
  // could not say WHICH op was in flight, and the popped entry lived in a
  // closure — the re-push that came with it could land after a fresh op
  // had already forked the history.
  let inflight: UndoOp | null = null;
  // the history's version: every fresh action forks the history (it clears
  // the redo stack) and bumps this, so an op that settles late can tell
  // that the chain it was holding is gone
  let historyVersion = 0;
  // undo/redo entries with their journal data alongside (null = session-only,
  // pushed without data — fully undoable in memory, skipped by snapshotData)
  const undoStack: UndoEntry[] = [];
  const redoStack: UndoEntry[] = [];
  const pushUndoBatch = (label: string, units: UndoUnit[], redos: UndoUnit[] = [], data?: UndoJournalData): void => {
    if (!units.length) return;
    undoStack.push({
      batch: { label, units, redos },
      data: data ? { label, at: Date.now(), units: data.units, redos: data.redos } : null,
    });
    if (undoStack.length > MAX_UNDO_BATCHES) undoStack.shift();
    redoStack.length = 0; // a fresh action forks history — stale redos are gone
    historyVersion++; // the fork: an op in flight can no longer re-enter a stack
    onChange();
  };

  const emit = (op: "undo" | "redo", label: string): void => {
    try {
      sink.onEvent?.(op, label);
    } catch {}
  };

  // empty-stack notices report a no-op: throttle them (autorepeat held on
  // ctrl+z/ctrl+y would otherwise stack a toast per press — same flood class
  // the clipboard staging coalesces above)
  let lastEmptyAt = 0;
  const noteEmpty = (op: "undo" | "redo"): void => {
    const now = Date.now();
    if (now - lastEmptyAt < 1500) return;
    lastEmptyAt = now;
    sink.notify(op === "undo" ? "Nothing to undo" : "Nothing to redo", op, "info");
  };

  // shared batch envelope: serialize with transfers/trash/extract (an undo
  // running concurrently with a queued op can interleave on the same paths,
  // and a redo copy writes `.tfm-part-*` temps the concurrent transfer's
  // orphan sweep deletes mid-copy — data loss), tally per-step failures.
  const runBatch = async (steps: Iterable<UndoUnit>): Promise<{ failed: number; failWhy: Set<string> }> => {
    let failed = 0;
    const failWhy = new Set<string>();
    await sharedOpQueue().enqueue(async () => {
      for (const u of steps) {
        try {
          await u?.();
        } catch (err) {
          failed++;
          failWhy.add(fsErrText(err));
        }
      }
    });
    return { failed, failWhy };
  };

  // An op may start only while no op is in flight. The slot keeps the LAST
  // op (the guard reads its phase), so a settled op never blocks the next
  // one — the old `running` boolean did the same, but it could not say which
  // op it was guarding.
  const busy = (): boolean => inflight !== null && inflight.phase !== "settled";

  // The op SETTLES: the outcome is known, so it may re-enter a stack.
  //
  // It may re-enter ONLY while the history was not forked meanwhile: a
  // fresh op pushed during the op's window already invalidated the chain
  // (it cleared the redo stack), so the stale entry must NOT come back — a
  // resurrected redo would re-apply an op that a newer op had already
  // invalidated, and a resurrected undo entry would invert the undo order
  // (the older entry would be popped before the newer one).
  const settle = (op: UndoOp, kind: "undo" | "redo", failed: number, failWhy: Set<string>): void => {
    op.phase = "settled";
    const entry = op.entry;
    if (op.version === historyVersion) {
      if (kind === "undo") {
        // only batches that know how to re-apply themselves stay redoable
        if (entry.batch.redos.length) redoStack.push(entry);
      } else {
        undoStack.push(entry);
      }
    }
    // the plugin event fires when the op has SETTLED: a plugin that reads
    // the fs in its handler must see the POST-op state, not the pre-op one
    emit(kind, entry.batch.label);
    sink.renderAll();
    const verb = kind === "undo" ? "Undo" : "Redo";
    const done = kind === "undo" ? "Undid" : "Redid";
    const summary = failed
      ? `${verb} ${entry.batch.label} · ${failSuffix(failed, failWhy)}`
      : `${done} ${entry.batch.label}`;
    sink.notify(summary, failed ? `${kind} failed` : kind, failed ? "error" : "success");
    onChange();
  };

  const undoLast = (): void => {
    if (busy()) return; // in-flight fs closures must not interleave
    const entry = undoStack.pop();
    if (!entry) {
      noteEmpty("undo");
      return;
    }
    // ONE op object owns the popped entry from here on
    const op: UndoOp = { phase: "popped", entry, version: historyVersion };
    inflight = op;
    void (async () => {
      op.phase = "running";
      try {
        const { failed, failWhy } = await runBatch([...entry.batch.units].reverse());
        settle(op, "undo", failed, failWhy);
      } finally {
        // the op always settles (even if the batch runner itself threw): a
        // stuck "running" phase would block every later undo
        op.phase = "settled";
      }
    })();
  };

  const redoLast = (): void => {
    if (busy()) return;
    const entry = redoStack.pop();
    if (!entry) {
      noteEmpty("redo");
      return;
    }
    const op: UndoOp = { phase: "popped", entry, version: historyVersion };
    inflight = op;
    void (async () => {
      op.phase = "running";
      try {
        const { failed, failWhy } = await runBatch(entry.batch.redos);
        settle(op, "redo", failed, failWhy);
      } finally {
        op.phase = "settled";
      }
    })();
  };

  // rehydrate journal data into live batches (boot path). Invalid entries are
  // the journal reader's job to filter — here every entry is trusted data.
  // Oldest-first input; the cap keeps the newest.
  const adoptBatches = (datas: UndoBatchData[]): number => {
    const fresh = datas.slice(-MAX_UNDO_BATCHES);
    for (const d of fresh) {
      undoStack.push({ batch: dataToBatch(d, log), data: d });
    }
    if (undoStack.length > MAX_UNDO_BATCHES) undoStack.splice(0, undoStack.length - MAX_UNDO_BATCHES);
    redoStack.length = 0;
    historyVersion++; // adopting a journal is a history fork too
    if (fresh.length) onChange();
    return fresh.length;
  };

  // journalable tail for the journal file (newest cap entries with data).
  // Entries whose data carries no units can't rehydrate to anything — the
  // journal reader drops those too, so skip them here as well.
  const snapshotData = (): UndoBatchData[] =>
    undoStack
      .filter((e) => e.data !== null && e.data.units.length > 0)
      .map((e) => e.data as UndoBatchData)
      .slice(-MAX_UNDO_BATCHES);

  return {
    pushUndoBatch,
    undoLast,
    redoLast,
    adoptBatches,
    snapshotData,
    undoDepth: () => undoStack.length,
    redoDepth: () => redoStack.length,
  };
};
