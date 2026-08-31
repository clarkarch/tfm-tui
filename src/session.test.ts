import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { readRestoredSession, saveSession, sessionFile } from "./session";

const oldStateHome = process.env.XDG_STATE_HOME;
afterEach(() => {
  if (oldStateHome === undefined) delete process.env.XDG_STATE_HOME;
  else process.env.XDG_STATE_HOME = oldStateHome;
});

const sandbox = (): string => {
  const root = path.join(os.tmpdir(), `tfm-session-${process.pid}-${Math.random().toString(36).slice(2)}`);
  process.env.XDG_STATE_HOME = root;
  return root;
};

describe("sessionFile", () => {
  test("honors XDG_STATE_HOME, defaults to ~/.local/state/tfm", () => {
    const root = sandbox();
    expect(sessionFile()).toBe(path.join(root, "tfm", "session.json"));
    delete process.env.XDG_STATE_HOME;
    expect(sessionFile()).toBe(path.join(os.homedir(), ".local/state/tfm", "session.json"));
  });
});

describe("readRestoredSession", () => {
  test("round-trips tabs through saveSession", async () => {
    const root = sandbox();
    try {
      await saveSession(
        root,
        [
          { history: [root, os.homedir()], histIdx: 1 },
          { history: ["/tmp"], histIdx: 0 },
        ],
        1,
      );
      const doc = readRestoredSession();
      expect(doc).not.toBeNull();
      expect(doc!.tabs.length).toBe(2);
      expect(doc!.tabs[0]!.histIdx).toBe(1);
      expect(doc!.activeTab).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("filters dead dirs and clamps histIdx, drops empty tabs", () => {
    const root = sandbox();
    try {
      mkdirSync(path.dirname(sessionFile()), { recursive: true });
      writeFileSync(
        sessionFile(),
        JSON.stringify({
          tabs: [
            { history: ["/nonexistent-dir-xyz", os.tmpdir()], histIdx: 99 },
            { history: ["/nonexistent-dir-xyz"], histIdx: 0 },
          ],
          activeTab: 7,
        }),
      );
      const doc = readRestoredSession();
      expect(doc).not.toBeNull();
      expect(doc!.tabs.length).toBe(1);
      expect(doc!.tabs[0]!.history).toEqual([os.tmpdir()]);
      expect(doc!.tabs[0]!.histIdx).toBe(0);
      expect(doc!.activeTab).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("legacy single-cwd doc restores one tab", () => {
    const root = sandbox();
    try {
      mkdirSync(path.dirname(sessionFile()), { recursive: true });
      writeFileSync(sessionFile(), JSON.stringify({ cwd: os.tmpdir() }));
      const doc = readRestoredSession();
      expect(doc).toEqual({ tabs: [{ history: [os.tmpdir()], histIdx: 0 }], activeTab: 0 });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("garbage json, missing file, and unusable-only histories -> null", () => {
    const root = sandbox();
    mkdirSync(path.dirname(sessionFile()), { recursive: true });
    expect(readRestoredSession()).toBeNull();
    writeFileSync(sessionFile(), "{not json");
    expect(readRestoredSession()).toBeNull();
    writeFileSync(sessionFile(), JSON.stringify({ tabs: [{ history: ["other://"], histIdx: 0 }] }));
    expect(readRestoredSession()).toBeNull();
    rmSync(root, { recursive: true, force: true });
  });

  test("recent/starred virtual uris are usable in histories", () => {
    const root = sandbox();
    try {
      mkdirSync(path.dirname(sessionFile()), { recursive: true });
      writeFileSync(
        sessionFile(),
        JSON.stringify({ tabs: [{ history: ["recent://", "starred://"], histIdx: 1 }], activeTab: 0 }),
      );
      const doc = readRestoredSession();
      expect(doc!.tabs[0]!.history).toEqual(["recent://", "starred://"]);
      expect(doc!.tabs[0]!.histIdx).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
