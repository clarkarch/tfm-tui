import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { readRestoredSession, saveSession, sessionFile, type PaneTabs } from "./session";

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

const writeDoc = (doc: unknown): void => {
  mkdirSync(path.dirname(sessionFile()), { recursive: true });
  writeFileSync(sessionFile(), JSON.stringify(doc));
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
  test("round-trips both pane tab lists and the active pane", async () => {
    const root = sandbox();
    try {
      const panes: [PaneTabs, PaneTabs] = [
        { tabs: [{ history: [root, os.homedir()], histIdx: 1 }], activeTab: 0 },
        {
          tabs: [
            { history: [root], histIdx: 0 },
            { history: [os.tmpdir()], histIdx: 0 },
          ],
          activeTab: 1,
        },
      ];
      await saveSession(panes, 1);
      const doc = readRestoredSession();
      expect(doc).not.toBeNull();
      expect(doc!.panes[0].tabs[0]!.histIdx).toBe(1);
      expect(doc!.panes[1].tabs.length).toBe(2);
      expect(doc!.panes[1].activeTab).toBe(1);
      expect(doc!.activePane).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("filters dead dirs, clamps activeTab, and mirrors a surviving pane", () => {
    const root = sandbox();
    try {
      writeDoc({
        panes: [
          { tabs: [{ history: ["/nonexistent-dir-xyz", os.tmpdir()], histIdx: 99 }], activeTab: 5 },
          { tabs: [{ history: ["/nonexistent-dir-xyz"], histIdx: 0 }], activeTab: 0 },
        ],
        activePane: 0,
      });
      const doc = readRestoredSession();
      expect(doc).not.toBeNull();
      expect(doc!.panes[0].tabs[0]!.history).toEqual([os.tmpdir()]);
      expect(doc!.panes[0].tabs[0]!.histIdx).toBe(0);
      expect(doc!.panes[0].activeTab).toBe(0);
      // pane 1 had nothing usable; it falls back to pane 0's survivor
      expect(doc!.panes[1].tabs[0]!.history).toEqual([os.tmpdir()]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("migrates the shared-tabs dual format ({tabs:[{panes:[l,r]}]})", () => {
    const root = sandbox();
    try {
      const left = path.join(root, "left");
      const right = path.join(root, "right");
      mkdirSync(left, { recursive: true });
      mkdirSync(right, { recursive: true });
      writeDoc({
        tabs: [
          {
            panes: [
              { history: [left], histIdx: 0 },
              { history: [right], histIdx: 0 },
            ],
          },
          {
            panes: [
              { history: [os.tmpdir()], histIdx: 0 },
              { history: [os.homedir()], histIdx: 0 },
            ],
          },
        ],
        activeTab: 1,
        activePane: 1,
      });
      const doc = readRestoredSession();
      expect(doc!.panes[0].tabs.length).toBe(2);
      expect(doc!.panes[0].tabs[1]!.history).toEqual([os.tmpdir()]);
      expect(doc!.panes[1].tabs[0]!.history).toEqual([right]);
      expect(doc!.panes[0].activeTab).toBe(1);
      expect(doc!.activePane).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("migrates the pre-dual-pane per-tab format (one history, both panes)", () => {
    const root = sandbox();
    try {
      writeDoc({ tabs: [{ history: [os.tmpdir()], histIdx: 0 }], activeTab: 0 });
      const doc = readRestoredSession();
      expect(doc!.panes[0].tabs[0]!.history).toEqual([os.tmpdir()]);
      expect(doc!.panes[1].tabs[0]!.history).toEqual([os.tmpdir()]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("legacy single-cwd doc restores one tab in each pane", () => {
    const root = sandbox();
    try {
      writeDoc({ cwd: os.tmpdir() });
      const doc = readRestoredSession();
      expect(doc).toEqual({
        panes: [
          { tabs: [{ history: [os.tmpdir()], histIdx: 0 }], activeTab: 0 },
          { tabs: [{ history: [os.tmpdir()], histIdx: 0 }], activeTab: 0 },
        ],
        activePane: 0,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("garbage json, missing file, and unusable-only histories -> null", () => {
    const root = sandbox();
    expect(readRestoredSession()).toBeNull();
    writeDoc("{not json");
    expect(readRestoredSession()).toBeNull();
    writeDoc({ panes: [{ tabs: [{ history: ["other://"], histIdx: 0 }] }, { tabs: [] }] });
    expect(readRestoredSession()).toBeNull();
    rmSync(root, { recursive: true, force: true });
  });

  test("a pane with only a usable recent:// history restores", () => {
    const root = sandbox();
    try {
      writeDoc({ panes: [{ tabs: [{ history: ["recent://"], histIdx: 0 }] }, { tabs: [] }] });
      const doc = readRestoredSession();
      expect(doc!.panes[0].tabs[0]!.history).toEqual(["recent://"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
