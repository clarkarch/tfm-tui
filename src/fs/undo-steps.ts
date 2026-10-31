// --- The undo step vocabulary: the DATA shapes of a journalable undo/redo
// batch plus the interpreter that turns one step back into a live closure.
//
// This is a LEAF (fs/undo-steps.ts) because the shapes are pure data that
// fs/ and ui/ both need, while the undo STATE MACHINE lives in app/undo.ts.
// They used to live together, which forced fs/fileops.ts, fs/trashops.ts,
// fs/undo-journal.ts and ui/ui-rename.ts to import UP into app/ for a type —
// and app/undo.ts imports fs/transfer.ts, so every one of those paid for the
// whole transfer engine to get `UndoStep`. Worse, it was a latent cycle:
// app/undo.ts reaching fs/undo-journal.ts (or vice versa) would have closed
// a loop the import-graph test rejects.
//
// The interpreter (stepToUnit) moved here too: ui/ui-rename.ts needs it, and
// ui/ may depend on fs/ but never on app/.

import { existsSync } from "node:fs";
import { mkdir, rename as fsRename, rm, writeFile } from "node:fs/promises";
import { fsErrText, rmTrashInfo, rmTrashInfoForPath, safeRestoreMove, trashIfSameFile, xdgTrashMove } from "./fsutil";
import { copyTreeProgress } from "./transfer";
import type { TransferSink } from "../lib/file-op-protocol";

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

export type UndoUnit = () => Promise<void> | void;

// --- Serializable undo steps: every undo/redo closure in the app is one of
// these fs operations (moves, trashes, renames, creates). Conditional (-if-)
// steps never throw — they encode redo guards (`if (!existsSync(t)) …`).
// Unconditional steps throw so the outer handler reports them like today. ---
export type UndoStep =
  | { op: "trash"; path: string; dev?: number; ino?: number; born?: number }
  | { op: "trash-if-exists"; path: string }
  | { op: "restore-move"; from: string; to: string }
  | { op: "rename"; from: string; to: string }
  | { op: "rename-if"; from: string; to: string }
  | { op: "copy-tree-if-missing"; src: string; dest: string }
  | { op: "rm"; path: string }
  | { op: "mkdir-if-missing"; path: string }
  | { op: "write-empty-if-missing"; path: string }
  | { op: "rm-trashinfo"; name: string; path?: string };

export type UndoBatchData = {
  label: string;
  /** epoch ms — the journal drops entries older than the max age */
  at: number;
  units: UndoStep[];
  redos: UndoStep[];
};

// journal payload carried alongside a push (the data mirror of units/redos)
export type UndoJournalData = { units: UndoStep[]; redos: UndoStep[] };

// how many batches the in-memory stack keeps
export const MAX_UNDO_BATCHES = 30;

// interpret one journal step back into a live closure. `log` mirrors the
// catch-and-log the original inline closures carry (redos especially).
export const stepToUnit = (step: UndoStep, log: (msg: string) => void = () => {}): UndoUnit => {
  switch (step.op) {
    case "trash":
      // idempotent: undoing a copy whose target the user already deleted is
      // already at the desired end-state (path absent) — report success, not
      // FAILED. A path reoccupied since the op (dev+ino mismatch) is skipped,
      // never trashed: the stranger isn't ours. Present paths still trash
      // loudly on real errors.
      return () =>
        trashIfSameFile(
          step.path,
          step.dev !== undefined && step.ino !== undefined
            ? { dev: step.dev, ino: step.ino, ...(step.born !== undefined ? { born: step.born } : {}) }
            : null,
          log,
        );
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
      // bump to "name (copy)" instead of clobbering whatever now occupies the
      // original name (same guard every other undo inverse uses)
      return () => safeRestoreMove(step.from, step.to).then(() => undefined);
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
          // O_EXCL create, not check-then-write: a raced occupant between
          // existsSync and writeFile would be silently truncated otherwise
          if (!existsSync(step.path)) await writeFile(step.path, "", { flag: "wx" });
        } catch {}
      };
    case "rm-trashinfo":
      return () => (step.path ? rmTrashInfoForPath(step.path, log) : rmTrashInfo(step.name, log));
  }
};
