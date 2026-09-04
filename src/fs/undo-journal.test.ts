import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseConfigDoc, defaultConfig } from "../config/config-schema";
import {
  UNDO_JOURNAL_MAX_AGE_MS,
  clearUndoJournal,
  readUndoJournal,
  saveUndoJournal,
  undoJournalFile,
} from "./undo-journal";
import type { UndoBatchData } from "../app/undo";

const oldStateHome = process.env.XDG_STATE_HOME;
const sandbox = (): string => {
  const root = mkdtempSync(path.join(os.tmpdir(), "tfm-journal-"));
  process.env.XDG_STATE_HOME = path.join(root, "state");
  return root;
};
afterEach(() => {
  if (oldStateHome === undefined) delete process.env.XDG_STATE_HOME;
  else process.env.XDG_STATE_HOME = oldStateHome;
});

const batch = (over: Partial<UndoBatchData> = {}): UndoBatchData => ({
  label: "test",
  at: Date.now(),
  units: [{ op: "rename", from: "/a", to: "/b" }],
  redos: [],
  ...over,
});

describe("undo journal file", () => {
  test("round-trips batches through XDG_STATE_HOME", async () => {
    const root = sandbox();
    try {
      saveUndoJournal([batch({ label: "move x" })]);
      expect(undoJournalFile()).toBe(path.join(process.env.XDG_STATE_HOME as string, "tfm", "undo-journal.json"));
      expect(existsSync(undoJournalFile())).toBe(true);
      const loaded = readUndoJournal();
      expect(loaded.length).toBe(1);
      expect(loaded[0]!.label).toBe("move x");
      expect(loaded[0]!.units).toEqual([{ op: "rename", from: "/a", to: "/b" }]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("missing or corrupt file reads as empty, never throws", async () => {
    const root = sandbox();
    try {
      expect(readUndoJournal()).toEqual([]);
      mkdirSync(path.dirname(undoJournalFile()), { recursive: true });
      writeFileSync(undoJournalFile(), "{not json");
      expect(readUndoJournal()).toEqual([]);
      writeFileSync(undoJournalFile(), JSON.stringify({ batches: "nope" }));
      expect(readUndoJournal()).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("drops unknown ops, non-string paths and unit-less batches", async () => {
    const root = sandbox();
    try {
      saveUndoJournal([
        batch({ label: "good" }),
        // @ts-expect-error hostile shape: unknown op
        { label: "evil", at: Date.now(), units: [{ op: "exec", cmd: "rm -rf /" }], redos: [] },
        // @ts-expect-error hostile shape: non-string path
        { label: "evil2", at: Date.now(), units: [{ op: "rm", path: 42 }], redos: [] },
        { label: "empty", at: Date.now(), units: [], redos: [] },
      ]);
      const loaded = readUndoJournal();
      expect(loaded.map((b) => b.label)).toEqual(["good"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("expires batches older than 7 days, keeps fresh ones", async () => {
    const root = sandbox();
    try {
      const now = Date.now();
      saveUndoJournal([
        batch({ label: "old", at: now - UNDO_JOURNAL_MAX_AGE_MS - 1000 }),
        batch({ label: "fresh", at: now - UNDO_JOURNAL_MAX_AGE_MS + 60_000 }),
      ]);
      expect(readUndoJournal(now).map((b) => b.label)).toEqual(["fresh"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("clearUndoJournal removes the file and never throws when absent", async () => {
    const root = sandbox();
    try {
      saveUndoJournal([batch()]);
      expect(existsSync(undoJournalFile())).toBe(true);
      clearUndoJournal();
      expect(existsSync(undoJournalFile())).toBe(false);
      expect(() => clearUndoJournal()).not.toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("persist-undo option", () => {
  test("off by default, parsed per-key like every ui bool", () => {
    expect(defaultConfig.ui.persistUndo).toBe(false);
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { parse } = require("smol-toml") as typeof import("smol-toml");
    expect(parseConfigDoc(parse("[ui]\npersist-undo = true")).ui.persistUndo).toBe(true);
    expect(parseConfigDoc(parse('[ui]\npersist-undo = "yes"')).ui.persistUndo).toBe(false);
  });

  test("journal file round-trips through readFileSync (atomic write leaves valid JSON)", async () => {
    const root = sandbox();
    try {
      saveUndoJournal([batch({ label: "atomic" })]);
      const raw = readFileSync(undoJournalFile(), "utf8");
      expect(() => JSON.parse(raw)).not.toThrow();
      expect(JSON.parse(raw)[0].label).toBe("atomic");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
