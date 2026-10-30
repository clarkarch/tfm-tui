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
  let running = false; // in-flight undo/redo guard: no interleaved batches
  // undo/redo entries with their journal data alongside (null = session-only,
  // pushed without data — fully undoable in memory, skipped by snapshotData)
  const undoStack: { batch: OpBatch; data: UndoBatchData | null }[] = [];
  const redoStack: { batch: OpBatch; data: UndoBatchData | null }[] = [];

  const pushUndoBatch = (label: string, units: UndoUnit[], redos: UndoUnit[] = [], data?: UndoJournalData): void => {
    if (!units.length) return;
    undoStack.push({
      batch: { label, units, redos },
      data: data ? { label, at: Date.now(), units: data.units, redos: data.redos } : null,
    });
    if (undoStack.length > MAX_UNDO_BATCHES) undoStack.shift();
    redoStack.length = 0; // a fresh action forks history — stale redos are gone
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

  const undoLast = (): void => {
    if (running) return; // in-flight fs closures must not interleave
    const entry = undoStack.pop();
    if (!entry) {
      noteEmpty("undo");
      return;
    }
    emit("undo", entry.batch.label);
    running = true;
    void (async () => {
      try {
        const { failed, failWhy } = await runBatch([...entry.batch.units].reverse());
        // only batches that know how to re-apply themselves stay redoable
        if (entry.batch.redos.length) redoStack.push(entry);
        sink.renderAll();
        const summary = failed
          ? `Undo ${entry.batch.label} · ${failSuffix(failed, failWhy)}`
          : `Undid ${entry.batch.label}`;
        sink.notify(summary, failed ? "undo failed" : "undo", failed ? "error" : "success");
        onChange();
      } finally {
        running = false;
      }
    })();
  };

  const redoLast = (): void => {
    if (running) return;
    const entry = redoStack.pop();
    if (!entry) {
      noteEmpty("redo");
      return;
    }
    emit("redo", entry.batch.label);
    running = true;
    void (async () => {
      try {
        const { failed, failWhy } = await runBatch(entry.batch.redos);
        undoStack.push(entry);
        sink.renderAll();
        const summary = failed
          ? `Redo ${entry.batch.label} · ${failSuffix(failed, failWhy)}`
          : `Redid ${entry.batch.label}`;
        sink.notify(summary, failed ? "redo failed" : "redo", failed ? "error" : "success");
        onChange();
      } finally {
        running = false;
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
