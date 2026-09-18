import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { MAX_UNDO_BATCHES, type UndoBatchData, type UndoStep } from "../app/undo";
import { swallow } from "../app/log";

// --- Undo journal persistence: the journalable tail of the undo stack as
// JSON, next to session.json. Writes are synchronous + atomic (tmp+rename)
// so quitting mid-op can't lose the journal; the file is tiny (≤30 batches
// of path data) and writes happen once per file op. Reads validate every
// step against an allowlist and drop expired batches — a hand-edited or
// ancient journal must never trash the wrong file. ---

export const UNDO_JOURNAL_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export const undoJournalFile = (): string =>
  path.join(process.env.XDG_STATE_HOME ?? path.join(os.homedir(), ".local/state"), "tfm", "undo-journal.json");

const isStep = (v: unknown): v is UndoStep => {
  if (typeof v !== "object" || v === null) return false;
  const s = v as Record<string, unknown>;
  switch (s.op) {
    case "trash":
    case "trash-if-exists":
      return typeof s.path === "string";
    case "restore-move":
    case "rename":
    case "rename-if":
      return typeof s.from === "string" && typeof s.to === "string";
    case "copy-tree-if-missing":
      return typeof s.src === "string" && typeof s.dest === "string";
    case "rm":
    case "mkdir-if-missing":
    case "write-empty-if-missing":
      return typeof s.path === "string";
    case "rm-trashinfo":
      return typeof s.name === "string";
    default:
      return false;
  }
};

const isBatch = (v: unknown): v is UndoBatchData => {
  if (typeof v !== "object" || v === null) return false;
  const b = v as Record<string, unknown>;
  return (
    typeof b.label === "string" &&
    typeof b.at === "number" &&
    Number.isFinite(b.at) &&
    Array.isArray(b.units) &&
    b.units.length > 0 &&
    (b.units as unknown[]).every(isStep) &&
    Array.isArray(b.redos) &&
    (b.redos as unknown[]).every(isStep)
  );
};

// newest-first expiry: batches older than the max age are dropped (stale
// undos across weeks would surprise — the trashed file may be long gone or
// the path reused). Keeps the newest MAX_UNDO_BATCHES valid batches.
export const readUndoJournal = (now: number = Date.now()): UndoBatchData[] => {
  let doc: unknown;
  try {
    doc = JSON.parse(readFileSync(undoJournalFile(), "utf8"));
  } catch {
    return [];
  }
  const list = Array.isArray(doc) ? doc : (doc as { batches?: unknown })?.batches;
  if (!Array.isArray(list)) return [];
  const out: UndoBatchData[] = [];
  for (const b of list) {
    if (!isBatch(b)) continue;
    if (now - b.at > UNDO_JOURNAL_MAX_AGE_MS) continue;
    out.push({ label: b.label, at: b.at, units: b.units, redos: b.redos });
  }
  return out.slice(-MAX_UNDO_BATCHES);
};

export const saveUndoJournal = (batches: UndoBatchData[]): void => {
  const file = undoJournalFile();
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(batches.slice(-MAX_UNDO_BATCHES)));
  renameSync(tmp, file);
};

export const clearUndoJournal = (): void => {
  try {
    rmSync(undoJournalFile(), { force: true });
  } catch (err) {
    // force:true means ENOENT never throws here, so any failure is real —
    // a journal that can't be cleared replays stale undo batches next launch
    swallow("undo journal clear", err);
  }
};
