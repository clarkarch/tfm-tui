import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { trashDir } from "./fsutil";
import { makeTrashConfirms, makeTrashOps, trashOrigPath, type TrashOpsSink } from "./trashops";

const oldDataHome = process.env.XDG_DATA_HOME;
const oldHome = process.env.HOME;
afterEach(() => {
  if (oldDataHome === undefined) delete process.env.XDG_DATA_HOME;
  else process.env.XDG_DATA_HOME = oldDataHome;
  if (oldHome === undefined) delete process.env.HOME;
  else process.env.HOME = oldHome;
});

const sandbox = (): string => {
  const root = mkdtempSync(path.join(os.tmpdir(), "tfm-trash-"));
  process.env.XDG_DATA_HOME = path.join(root, "data");
  process.env.HOME = root; // restoreFromTrash may mkdir under orig path
  return root;
};

// the ops run fire-and-forget async — a fixed sleep races real fs work under
// suite load, so poll for a condition (or just settle when no fs change is
// expected) with a generous deadline
const settleUntil = async (cond: () => boolean): Promise<void> => {
  const deadline = Date.now() + 2000;
  while (!cond() && Date.now() < deadline) await Bun.sleep(10);
  await Bun.sleep(10);
};

const recordingSink = (): TrashOpsSink & {
  notes: string[];
  batches: { label: string; units: number; redos: number }[];
} => {
  const notes: string[] = [];
  const batches: { label: string; units: number; redos: number }[] = [];
  return {
    notes,
    batches,
    pushUndoBatch: (label, units, redos) => batches.push({ label, units: units.length, redos: redos.length }),
    setStatusMsg: (msg) => notes.push(`setStatusMsg:${msg}`),
    notify: (msg, title) => notes.push(`notify:${title ?? ""}:${msg}`),
    renderAll: () => notes.push("renderAll"),
  };
};

describe("trashPaths", () => {
  test("moves into XDG trash, writes trashinfo, pushes paired undo batch", async () => {
    const root = sandbox();
    try {
      const file = path.join(root, "doomed.txt");
      writeFileSync(file, "bye");
      const sink = recordingSink();
      const ops = makeTrashOps(sink);
      ops.trashPaths([file]);

      const hit = path.join(trashDir(), "files", "doomed.txt");
      await settleUntil(() => existsSync(hit));
      expect(existsSync(hit)).toBe(true);
      expect(existsSync(file)).toBe(false);
      expect(existsSync(path.join(trashDir(), "info", "doomed.txt.trashinfo"))).toBe(true);
      expect(sink.batches.length).toBe(1);
      expect(sink.batches[0]!.label).toBe("trash 1 item");
      expect(sink.batches[0]!.units).toBe(1);
      expect(sink.batches[0]!.redos).toBe(1);
      expect(sink.notes.some((n) => n === "setStatusMsg:Trashed 1 item · ctrl+z to undo")).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("failure is counted with reason, not thrown", async () => {
    const root = sandbox();
    try {
      const sink = recordingSink();
      const ops = makeTrashOps(sink);
      ops.trashPaths([path.join(root, "missing.bin")]);
      await settleUntil(() => sink.notes.some((n) => n.startsWith("notify:trash failed")));
      expect(sink.notes.some((n) => n.includes("Trashed 0 of 1") && n.includes("FAILED"))).toBe(true);
      expect(sink.notes.some((n) => n.startsWith("notify:trash failed"))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("onEvent fires with the stable op name (trash, not trashPaths)", async () => {
    const root = sandbox();
    try {
      const events: Array<{ op: string; paths: string[] }> = [];
      const file = path.join(root, "doomed.txt");
      writeFileSync(file, "bye");
      const sink = recordingSink();
      const ops = makeTrashOps({ ...sink, onEvent: (op, paths) => events.push({ op, paths }) });
      await ops.trashPaths([file]);
      expect(events).toEqual([{ op: "trash", paths: [file] }]);
      // a throwing listener never breaks the op
      const ops2 = makeTrashOps({
        ...sink,
        onEvent: () => {
          throw new Error("listener-boom");
        },
      });
      const file2 = path.join(root, "doomed2.txt");
      writeFileSync(file2, "bye");
      await expect(ops2.trashPaths([file2])).resolves.toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("trashOrigPath", () => {
  test("parses Path= with url-decoding, file:// prefix tolerated", async () => {
    const root = sandbox();
    try {
      mkdirSync(path.join(trashDir(), "info"), { recursive: true });
      writeFileSync(path.join(trashDir(), "info", "a.txt.trashinfo"), "[Trash Info]\nPath=/tmp/a%20b.txt\n");
      writeFileSync(path.join(trashDir(), "info", "b.txt.trashinfo"), "[Trash Info]\nPath=file:///tmp/b.txt\n");
      expect(await trashOrigPath("a.txt")).toBe("/tmp/a b.txt");
      expect(await trashOrigPath("b.txt")).toBe("/tmp/b.txt");
      expect(await trashOrigPath("nope.txt")).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("restoreFromTrash", () => {
  test("moves back to original location and removes trashinfo", async () => {
    const root = sandbox();
    try {
      const origDir = path.join(root, "orig");
      mkdirSync(origDir, { recursive: true });
      mkdirSync(path.join(trashDir(), "files"), { recursive: true });
      mkdirSync(path.join(trashDir(), "info"), { recursive: true });
      writeFileSync(path.join(trashDir(), "files", "gone.txt"), "data");
      writeFileSync(path.join(trashDir(), "info", "gone.txt.trashinfo"), `[Trash Info]\nPath=${origDir}/gone.txt\n`);
      const sink = recordingSink();
      makeTrashOps(sink).restoreFromTrash([path.join(trashDir(), "files", "gone.txt")]);
      await settleUntil(() => existsSync(path.join(origDir, "gone.txt")));
      expect(existsSync(path.join(origDir, "gone.txt"))).toBe(true);
      expect(existsSync(path.join(trashDir(), "info", "gone.txt.trashinfo"))).toBe(false);
      expect(sink.notes.some((n) => n === "setStatusMsg:Restored 1 item · ctrl+z to undo")).toBe(true);
      // restore is reversible: undo batch re-trashes the restored item
      expect(sink.batches.length).toBe(1);
      expect(sink.batches[0]!.label).toBe("restore 1 item");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("recreated original is never clobbered: restore bumps to (copy)", async () => {
    const root = sandbox();
    try {
      const origDir = path.join(root, "orig");
      mkdirSync(origDir, { recursive: true });
      mkdirSync(path.join(trashDir(), "files"), { recursive: true });
      mkdirSync(path.join(trashDir(), "info"), { recursive: true });
      writeFileSync(path.join(trashDir(), "files", "gone.txt"), "restored-data");
      writeFileSync(path.join(trashDir(), "info", "gone.txt.trashinfo"), `[Trash Info]\nPath=${origDir}/gone.txt\n`);
      writeFileSync(path.join(origDir, "gone.txt"), "current-data");
      const sink = recordingSink();
      makeTrashOps(sink).restoreFromTrash([path.join(trashDir(), "files", "gone.txt")]);
      await settleUntil(() => existsSync(path.join(origDir, "gone (copy).txt")));
      expect(readFileSync(path.join(origDir, "gone.txt"), "utf8")).toBe("current-data");
      expect(readFileSync(path.join(origDir, "gone (copy).txt"), "utf8")).toBe("restored-data");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("deleteForever / emptyTrash", () => {
  test("delete removes files+info without undo batch", async () => {
    const root = sandbox();
    try {
      mkdirSync(path.join(trashDir(), "files"), { recursive: true });
      mkdirSync(path.join(trashDir(), "info"), { recursive: true });
      writeFileSync(path.join(trashDir(), "files", "x.txt"), "1");
      writeFileSync(path.join(trashDir(), "info", "x.txt.trashinfo"), "[Trash Info]\nPath=/tmp/x\n");
      const sink = recordingSink();
      makeTrashOps(sink).deleteForever([path.join(trashDir(), "files", "x.txt")]);
      await settleUntil(() => !existsSync(path.join(trashDir(), "info", "x.txt.trashinfo")));
      expect(existsSync(path.join(trashDir(), "files", "x.txt"))).toBe(false);
      expect(existsSync(path.join(trashDir(), "info", "x.txt.trashinfo"))).toBe(false);
      expect(sink.batches.length).toBe(0);
      expect(sink.notes.some((n) => n === "setStatusMsg:Deleted 1 item · cannot be undone")).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("emptyTrash wipes everything and reports count", async () => {
    const root = sandbox();
    try {
      mkdirSync(path.join(trashDir(), "files"), { recursive: true });
      mkdirSync(path.join(trashDir(), "info"), { recursive: true });
      writeFileSync(path.join(trashDir(), "files", "a"), "1");
      writeFileSync(path.join(trashDir(), "files", "b"), "2");
      const sink = recordingSink();
      makeTrashOps(sink).emptyTrash();
      await settleUntil(() => !existsSync(path.join(trashDir(), "files", "a")));
      expect(existsSync(path.join(trashDir(), "files", "a"))).toBe(false);
      expect(sink.notes.some((n) => n === "notify:empty:Emptied 2 items · cannot be undone")).toBe(true);
      expect(sink.notes.some((n) => n === "setStatusMsg:Emptied 2 items · cannot be undone")).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("emptyTrash with unreadable dir notifies failure", async () => {
    const root = sandbox();
    try {
      const sink = recordingSink();
      makeTrashOps(sink).emptyTrash();
      await Bun.sleep(30);
      expect(sink.notes.some((n) => n.startsWith("notify:empty failed:Could not read trash"))).toBe(true);
      expect(sink.notes.some((n) => n === "setStatusMsg:Trash unreadable (source gone)")).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("makeTrashConfirms", () => {
  type Confirmed = { message: string; yesLabel: string; danger?: boolean };
  const mkEnv = () => {
    const asked: Confirmed[] = [];
    const fired: string[] = [];
    let onYes: (() => void) | null = null;
    const confirms = makeTrashConfirms({
      confirm: (message, yesLabel, cb, danger) => {
        asked.push({ message, yesLabel, danger });
        onYes = cb;
      },
      emptyTrash: () => {
        fired.push("empty");
      },
      deleteForever: (paths) => {
        fired.push(`delete:${paths.join(",")}`);
      },
    });
    return { asked, fired, confirms, runYes: () => onYes?.() };
  };

  test("empty-trash prompt names the count, exact verb and danger flag", () => {
    const root = sandbox();
    try {
      mkdirSync(path.join(trashDir(), "files"), { recursive: true });
      writeFileSync(path.join(trashDir(), "files", "a"), "1");
      writeFileSync(path.join(trashDir(), "files", "b"), "2");
      const { asked, confirms, runYes, fired } = mkEnv();
      confirms.confirmEmptyTrash();
      expect(asked[0]).toEqual({
        message: "Empty Trash (2 items)? This cannot be undone.",
        yesLabel: "Empty Trash",
        danger: true,
      });
      runYes();
      expect(fired).toEqual(["empty"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("empty-trash prompt omits the count when the trash is unreadable", () => {
    const root = sandbox();
    try {
      const { asked, confirms } = mkEnv();
      confirms.confirmEmptyTrash();
      expect(asked[0]!.message).toBe("Empty Trash? This cannot be undone.");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("delete-forever prompt pluralizes and carries the paths into the action", () => {
    const { asked, confirms, runYes, fired } = mkEnv();
    confirms.confirmDeleteForever(["/t/a"]);
    expect(asked[0]!.message).toBe("Permanently delete 1 item? This cannot be undone.");
    expect(asked[0]!.yesLabel).toBe("Delete permanently");
    expect(asked[0]!.danger).toBe(true);
    runYes();
    expect(fired).toEqual(["delete:/t/a"]);

    confirms.confirmDeleteForever(["/t/a", "/t/b"]);
    expect(asked[1]!.message).toBe("Permanently delete 2 items? This cannot be undone.");
    runYes();
    expect(fired).toEqual(["delete:/t/a", "delete:/t/a,/t/b"]);
  });

  test("nothing happens until the user confirms (onYes not auto-invoked)", () => {
    const { confirms, fired } = mkEnv();
    confirms.confirmEmptyTrash();
    confirms.confirmDeleteForever(["/x"]);
    expect(fired).toEqual([]);
  });
});

describe("delete progress driver", () => {
  const W = (p: string, s = "x") => {
    mkdirSync(path.dirname(p), { recursive: true });
    writeFileSync(p, s);
  };

  // the real wiring maps the driver onto prog+toast; here it records the
  // driver contract and its sink drives the real rmTreeProgress engine
  const fakeDriver = (opts: { cancelAfterFiles?: number } = {}) => {
    const calls: string[] = [];
    let cancelled = false;
    let done = 0;
    const driver: NonNullable<TrashOpsSink["deleteProgress"]> = {
      sink: {
        checkpoint: async () => {
          if (cancelled) throw new Error("cancelled");
        },
        paused: () => false,
        cancelled: () => cancelled,
        addBytes: () => {},
        fileDone: () => {
          done++;
          if (opts.cancelAfterFiles !== undefined && done >= opts.cancelAfterFiles) cancelled = true;
        },
        setStream: () => {},
        clearStream: () => {},
        repaint: () => {},
      },
      start: (files, bytes) => calls.push(`start:${files}:${bytes}`),
      cancelled: () => cancelled,
      finish: (msg) => calls.push(`finish:${msg}`),
      stop: () => calls.push("stop"),
    };
    return { driver, calls, files: () => done };
  };

  test("deleteForever pre-scans totals, streams the engine, finishes the toast", async () => {
    const root = sandbox();
    try {
      const tree = path.join(root, "tree");
      W(path.join(tree, "a.txt"), "AAA");
      W(path.join(tree, "sub", "b.txt"), "BB");
      const sink = recordingSink();
      const p = fakeDriver();
      sink.deleteProgress = p.driver;
      makeTrashOps(sink).deleteForever([tree]);
      await settleUntil(() => p.calls.includes("stop"));
      expect(existsSync(tree)).toBe(false);
      expect(p.calls).toContain("start:2:5");
      expect(p.calls).toContain("finish:✓ Deleted 1");
      expect(sink.notes.some((n) => n === "setStatusMsg:Deleted 1 item · cannot be undone")).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("cancel stops mid-tree, reports the partial removal, keeps what's left", async () => {
    const root = sandbox();
    try {
      const tree = path.join(root, "tree");
      W(path.join(tree, "a.txt"), "A");
      W(path.join(tree, "b.txt"), "B");
      W(path.join(tree, "c.txt"), "C");
      const sink = recordingSink();
      const p = fakeDriver({ cancelAfterFiles: 1 });
      sink.deleteProgress = p.driver;
      makeTrashOps(sink).deleteForever([tree]);
      await settleUntil(() => p.calls.includes("stop"));
      expect(existsSync(tree)).toBe(true);
      expect(p.files()).toBe(1);
      expect(p.calls).toContain("finish:✗ Delete cancelled");
      expect(sink.notes.some((n) => n === "setStatusMsg:Delete cancelled · 0 of 1 removed")).toBe(true);
      expect(sink.notes.some((n) => n.startsWith("notify:delete cancelled"))).toBe(true);
      expect(sink.batches.length).toBe(0); // irreversible by design
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("emptyTrash streams through the same driver", async () => {
    const root = sandbox();
    try {
      mkdirSync(path.join(trashDir(), "files"), { recursive: true });
      mkdirSync(path.join(trashDir(), "info"), { recursive: true });
      writeFileSync(path.join(trashDir(), "files", "a"), "1");
      writeFileSync(path.join(trashDir(), "files", "b"), "2");
      const sink = recordingSink();
      const p = fakeDriver();
      sink.deleteProgress = p.driver;
      makeTrashOps(sink).emptyTrash();
      await settleUntil(() => p.calls.includes("stop"));
      expect(p.calls).toContain("start:2:2");
      expect(p.calls).toContain("finish:✓ Emptied 2");
      expect(sink.notes.some((n) => n === "notify:empty:Emptied 2 items · cannot be undone")).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
