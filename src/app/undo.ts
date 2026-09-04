import { existsSync } from "node:fs";
import { mkdir, rename as fsRename, rm, writeFile } from "node:fs/promises";
import { failSuffix, fsErrText, rmTrashInfo, safeRestoreMove, xdgTrashMove } from "../fs/fsutil";
import { copyTreeProgress, type TransferSink } from "../fs/transfer";

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

export type UndoUnit = () => Promise<void> | void;
export type OpBatch = { label: string; units: UndoUnit[]; redos: UndoUnit[] };

// --- Serializable undo steps: every undo/redo closure in the app is one of
// these fs operations (moves, trashes, renames, creates). Conditional (-if-)
// steps never throw — they encode redo guards (`if (!existsSync(t)) …`).
// Unconditional steps throw so the outer handler reports them like today. ---
export type UndoStep =
  | { op: "trash"; path: string }
  | { op: "trash-if-exists"; path: string }
  | { op: "restore-move"; from: string; to: string }
  | { op: "rename"; from: string; to: string }
  | { op: "rename-if"; from: string; to: string }
  | { op: "copy-tree-if-missing"; src: string; dest: string }
  | { op: "rm"; path: string }
  | { op: "mkdir-if-missing"; path: string }
  | { op: "write-empty-if-missing"; path: string }
  | { op: "rm-trashinfo"; name: string };

export type UndoBatchData = {
  label: string;
  /** epoch ms — the journal drops entries older than the max age */
  at: number;
  units: UndoStep[];
  redos: UndoStep[];
};

// journal payload carried alongside a push (the data mirror of units/redos)
export type UndoJournalData = { units: UndoStep[]; redos: UndoStep[] };

export type UndoSink = {
  setStatusMsg: (msg: string) => void;
  notify: (message: string, title?: string) => void;
  renderAll: () => void;
};

export const MAX_UNDO_BATCHES = 30;

// progress-less sink for journal redo copies (no toast to report into)
const nullSink: TransferSink = {
  checkpoint: async () => {},
  paused: () => false,
  cancelled: () => false,
  addBytes: () => {},
  fileDone: () => {},
  setStream: () => {},
  clearStream: () => {},
  repaint: () => {},
};

// interpret one journal step back into a live closure. `log` mirrors the
// catch-and-log the original inline closures carry (redos especially).
export const stepToUnit = (step: UndoStep, log: (msg: string) => void = () => {}): UndoUnit => {
  switch (step.op) {
    case "trash":
      return () => xdgTrashMove(step.path).then(() => undefined);
    case "trash-if-exists":
      return async () => {
        try {
          if (existsSync(step.path)) await xdgTrashMove(step.path);
        } catch (err) {
          log(`redo trash ${step.path}: ${fsErrText(err)}`);
        }
      };
    case "restore-move":
      return () => safeRestoreMove(step.from, step.to).then(() => undefined);
    case "rename":
      return () => fsRename(step.from, step.to);
    case "rename-if":
      return async () => {
        try {
          if (existsSync(step.from) && !existsSync(step.to)) await fsRename(step.from, step.to);
        } catch (err) {
          log(`redo rename ${step.to}: ${fsErrText(err)}`);
        }
      };
    case "copy-tree-if-missing":
      return async () => {
        try {
          if (!existsSync(step.dest)) await copyTreeProgress(step.src, step.dest, nullSink);
        } catch (err) {
          log(`redo copy ${step.dest}: ${fsErrText(err)}`);
        }
      };
    case "rm":
      return () => rm(step.path, { recursive: true });
    case "mkdir-if-missing":
      return async () => {
        try {
          if (!existsSync(step.path)) await mkdir(step.path, { recursive: true });
        } catch {}
      };
    case "write-empty-if-missing":
      return async () => {
        try {
          if (!existsSync(step.path)) await writeFile(step.path, "");
        } catch {}
      };
    case "rm-trashinfo":
      return () => rmTrashInfo(step.name, log);
  }
};

export const dataToBatch = (data: UndoBatchData, log: (msg: string) => void = () => {}): OpBatch => ({
  label: data.label,
  units: data.units.map((s) => stepToUnit(s, log)),
  redos: data.redos.map((s) => stepToUnit(s, log)),
});

export type UndoOpts = {
  /** debug sink for rehydrated-step logs (defaults to silent) */
  log?: (msg: string) => void;
  /** fired on push/undo/redo so the wiring can persist the journal */
  onChange?: () => void;
};

export const makeUndo = (sink: UndoSink, opts: UndoOpts = {}) => {
  const log = opts.log ?? (() => {});
  const onChange = opts.onChange ?? (() => {});
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

  const undoLast = (): void => {
    const entry = undoStack.pop();
    if (!entry) {
      sink.setStatusMsg("Nothing to undo");
      return;
    }
    void (async () => {
      let failed = 0;
      const failWhy = new Set<string>();
      for (let i = entry.batch.units.length - 1; i >= 0; i--) {
        const u = entry.batch.units[i];
        try {
          await u?.();
        } catch (err) {
          failed++;
          failWhy.add(fsErrText(err));
        }
      }
      // only batches that know how to re-apply themselves stay redoable
      if (entry.batch.redos.length) redoStack.push(entry);
      sink.renderAll();
      const summary = failed
        ? `Undo ${entry.batch.label} · ${failSuffix(failed, failWhy)}`
        : `Undid: ${entry.batch.label}`;
      sink.setStatusMsg(failed || !entry.batch.redos.length ? summary : `${summary} · ctrl+y to redo`);
      sink.notify(summary, failed ? "undo failed" : "undo");
      onChange();
    })();
  };

  const redoLast = (): void => {
    const entry = redoStack.pop();
    if (!entry) {
      sink.setStatusMsg("Nothing to redo");
      return;
    }
    void (async () => {
      let failed = 0;
      const failWhy = new Set<string>();
      for (const r of entry.batch.redos) {
        try {
          await r?.();
        } catch (err) {
          failed++;
          failWhy.add(fsErrText(err));
        }
      }
      undoStack.push(entry);
      sink.renderAll();
      const summary = failed
        ? `Redo ${entry.batch.label} · ${failSuffix(failed, failWhy)}`
        : `Redid: ${entry.batch.label} · ctrl+z to undo`;
      sink.setStatusMsg(summary);
      sink.notify(summary, failed ? "redo failed" : "redo");
      onChange();
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
