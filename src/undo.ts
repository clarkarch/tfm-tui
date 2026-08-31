import { fsErrText } from "./fsutil";

// --- Undo/redo stack. Pure state machine — no renderer/state imports; the
// app surfaces results through an injected UndoSink (same seam as
// trashops/transfer). Every batch carries paired inverses: `units` reverse
// the op, `redos` re-apply it; a batch without `redos` breaks the redo chain
// (replace-stash can't re-apply). A fresh push clears stale redos. ---

export type UndoUnit = () => Promise<void> | void;
export type OpBatch = { label: string; units: UndoUnit[]; redos: UndoUnit[] };

export type UndoSink = {
  status: (msg: string) => void;
  notify: (message: string, title?: string) => void;
  refresh: () => void;
};

export const MAX_UNDO_BATCHES = 30;

export const makeUndo = (sink: UndoSink) => {
  const undoStack: OpBatch[] = [];
  const redoStack: OpBatch[] = [];

  const pushUndoBatch = (label: string, units: UndoUnit[], redos: UndoUnit[] = []): void => {
    if (!units.length) return;
    undoStack.push({ label, units, redos });
    if (undoStack.length > MAX_UNDO_BATCHES) undoStack.shift();
    redoStack.length = 0; // a fresh action forks history — stale redos are gone
  };

  const undoLast = (): void => {
    const entry = undoStack.pop();
    if (!entry) {
      sink.status("Nothing to undo");
      return;
    }
    void (async () => {
      let failed = 0;
      const failWhy = new Set<string>();
      for (let i = entry.units.length - 1; i >= 0; i--) {
        const u = entry.units[i];
        try {
          await u?.();
        } catch (err) {
          failed++;
          failWhy.add(fsErrText(err));
        }
      }
      // only batches that know how to re-apply themselves stay redoable
      if (entry.redos.length) redoStack.push(entry);
      sink.refresh();
      const why = [...failWhy][0];
      const summary = failed
        ? `Undo ${entry.label} · ${failed} FAILED${why ? ` (${why})` : ""}`
        : `Undid: ${entry.label}`;
      sink.status(failed || !entry.redos.length ? summary : `${summary} · ctrl+y to redo`);
      sink.notify(summary, failed ? "undo failed" : "undo");
    })();
  };

  const redoLast = (): void => {
    const entry = redoStack.pop();
    if (!entry) {
      sink.status("Nothing to redo");
      return;
    }
    void (async () => {
      let failed = 0;
      const failWhy = new Set<string>();
      for (const r of entry.redos) {
        try {
          await r?.();
        } catch (err) {
          failed++;
          failWhy.add(fsErrText(err));
        }
      }
      undoStack.push(entry);
      sink.refresh();
      const why = [...failWhy][0];
      const summary = failed
        ? `Redo ${entry.label} · ${failed} FAILED${why ? ` (${why})` : ""}`
        : `Redid: ${entry.label}`;
      sink.status(summary);
      sink.notify(summary, failed ? "redo failed" : "redo");
    })();
  };

  return { pushUndoBatch, undoLast, redoLast, undoDepth: () => undoStack.length, redoDepth: () => redoStack.length };
};
