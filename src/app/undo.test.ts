import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { makeUndo, MAX_UNDO_BATCHES, stepToUnit, type UndoBatchData, type UndoSink } from "./undo";
import { sharedOpQueue } from "../lib/op-queue";
import { fileIdOf } from "../fs/fsutil";

const recordingSink = (): UndoSink & { notes: string[] } => {
  const notes: string[] = [];
  return {
    notes,
    notify: (msg, title, level) => notes.push(`notify:${title ?? ""}:${level ?? ""}:${msg}`),
    renderAll: () => notes.push("renderAll"),
  };
};

// poll on observable state (sink notes / stack depths / ran[]) — never a
// fixed sleep, which races fire-and-forget ops under parallel-suite load
const settleUntil = async (cond: () => boolean): Promise<void> => {
  const deadline = Date.now() + 2000;
  while (!cond() && Date.now() < deadline) await Bun.sleep(10);
  if (!cond()) throw new Error("settleUntil timeout");
};

describe("makeUndo", () => {
  test("pushUndoBatch ignores empty unit lists", () => {
    const sink = recordingSink();
    const undo = makeUndo(sink);
    undo.pushUndoBatch("nothing", []);
    expect(undo.undoDepth()).toBe(0);
  });

  test("undo/redo units run behind the shared serial queue (no interleave with a live op)", async () => {
    const sink = recordingSink();
    const undo = makeUndo(sink);
    const ran: string[] = [];
    undo.pushUndoBatch(
      "op",
      [
        () => {
          ran.push("undo-unit");
        },
      ],
      [
        () => {
          ran.push("redo-unit");
        },
      ],
    );
    // hold the queue: the undo must not run until the live op releases
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const held = sharedOpQueue().enqueue(() => gate);
    undo.undoLast();
    // microtasks drain but the unit stays parked on the queue's tail. Release
    // in a finally: the queue is a process-global singleton, so a failing
    // assertion here must not leave it blocked and hang every later test.
    try {
      await Promise.resolve();
      await Promise.resolve();
      expect(ran).toEqual([]);
    } finally {
      release();
    }
    await held;
    await settleUntil(() => ran.includes("undo-unit"));
    undo.redoLast();
    await settleUntil(() => ran.includes("redo-unit"));
  });

  test("onEvent fires with the batch label on pop, silent on empty stacks", async () => {
    const events: Array<{ op: string; label: string }> = [];
    const sink = recordingSink();
    const undo = makeUndo({ ...sink, onEvent: (op, label) => events.push({ op, label }) });
    // empty stacks: status notes, no events (a no-op is not an undo)
    undo.undoLast();
    undo.redoLast();
    expect(events).toEqual([]);
    undo.pushUndoBatch("op", [() => {}], [() => {}]);
    undo.undoLast();
    expect(events).toEqual([{ op: "undo", label: "op" }]);
    await settleUntil(() => undo.redoDepth() === 1);
    undo.redoLast();
    expect(events).toEqual([
      { op: "undo", label: "op" },
      { op: "redo", label: "op" },
    ]);
  });

  test("a fresh push clears stale redos (history fork)", async () => {
    const sink = recordingSink();
    const undo = makeUndo(sink);
    const ran: string[] = [];
    undo.pushUndoBatch(
      "op",
      [
        () => {
          ran.push("u1");
        },
      ],
      [
        () => {
          ran.push("r1");
        },
      ],
    );
    undo.undoLast();
    await settleUntil(() => undo.redoDepth() === 1);
    undo.pushUndoBatch("fresh op", [() => {}]);
    expect(undo.redoDepth()).toBe(0);
  });

  test("stack is capped at MAX_UNDO_BATCHES, oldest dropped", async () => {
    const sink = recordingSink();
    const undo = makeUndo(sink);
    const ran: string[] = [];
    for (let i = 0; i < MAX_UNDO_BATCHES + 5; i++) {
      undo.pushUndoBatch(`op ${i}`, [
        () => {
          ran.push(String(i));
        },
      ]);
    }
    expect(undo.undoDepth()).toBe(MAX_UNDO_BATCHES);
    // oldest five (op 0..4) were shifted — next undo reverses the newest
    undo.undoLast();
    await settleUntil(() => ran.length === 1);
    expect(ran).toEqual([String(MAX_UNDO_BATCHES + 4)]);
    // batch was pushed without redos → not redoable, no hint
    expect(sink.notes).toContain("notify:undo:success:Undid: op 34");
  });

  test("undo runs units in reverse order", async () => {
    const sink = recordingSink();
    const undo = makeUndo(sink);
    const ran: string[] = [];
    undo.pushUndoBatch("batch", [
      () => {
        ran.push("a");
      },
      () => {
        ran.push("b");
      },
      () => {
        ran.push("c");
      },
    ]);
    undo.undoLast();
    await settleUntil(() => ran.length === 3);
    expect(ran).toEqual(["c", "b", "a"]);
  });

  test("batch without redos is not redoable — no ctrl+y hint", async () => {
    const sink = recordingSink();
    const undo = makeUndo(sink);
    undo.pushUndoBatch("one-way", [() => {}]);
    undo.undoLast();
    await settleUntil(() => sink.notes.some((n) => n.startsWith("notify:undo:")));
    expect(undo.redoDepth()).toBe(0);
    expect(sink.notes).toContain("notify:undo:success:Undid: one-way");
    expect(sink.notes.some((n) => n.includes("ctrl+y"))).toBe(false);
  });

  test("undo on empty stack toasts once", async () => {
    const sink = recordingSink();
    const undo = makeUndo(sink);
    undo.undoLast();
    await settleUntil(() => sink.notes.length === 1);
    expect(sink.notes).toEqual(["notify:undo:info:Nothing to undo"]);
  });

  test("rapid empty-stack notices coalesce (autorepeat doesn't stack toasts)", () => {
    const sink = recordingSink();
    const undo = makeUndo(sink);
    undo.undoLast();
    undo.undoLast();
    undo.redoLast();
    expect(sink.notes.filter((n) => n.startsWith("notify:"))).toHaveLength(1);
  });

  test("undo failure keeps going, reports count + first reason, stays redoable", async () => {
    const sink = recordingSink();
    const undo = makeUndo(sink);
    const boom = Object.assign(new Error("nope"), { code: "EACCES" });
    undo.pushUndoBatch(
      "messy",
      [
        () => {
          throw boom;
        },
        () => {},
      ],
      [() => {}],
    );
    undo.undoLast();
    await settleUntil(() => sink.notes.some((n) => n.includes("1 FAILED")));
    // failed runs get no ctrl+y hint (original behavior) but stay redoable
    expect(sink.notes).toContain("notify:undo failed:error:Undo messy · 1 FAILED (permission denied)");
    expect(sink.notes.filter((n) => n.startsWith("notify:"))).toHaveLength(1);
    expect(undo.redoDepth()).toBe(1);
  });

  test("redo re-applies redos forward and returns the batch to the undo stack", async () => {
    const sink = recordingSink();
    const undo = makeUndo(sink);
    const ran: string[] = [];
    undo.pushUndoBatch(
      "op",
      [
        () => {
          ran.push("u");
        },
      ],
      [
        () => {
          ran.push("r");
        },
      ],
    );
    undo.undoLast();
    await settleUntil(() => ran.length === 1);
    undo.redoLast();
    await settleUntil(() => ran.length === 2);
    expect(ran).toEqual(["u", "r"]);
    expect(undo.undoDepth()).toBe(1);
    expect(undo.redoDepth()).toBe(0);
    expect(sink.notes).toContain("notify:redo:success:Redid: op · ctrl+z to undo");
    expect(sink.notes).toContain("notify:redo:success:Redid: op · ctrl+z to undo");
  });

  test("redo on empty stack toasts once", async () => {
    const sink = recordingSink();
    const undo = makeUndo(sink);
    undo.redoLast();
    await settleUntil(() => sink.notes.length === 1);
    expect(sink.notes).toEqual(["notify:redo:info:Nothing to redo"]);
  });

  test("redo failure reports count + reason", async () => {
    const sink = recordingSink();
    const undo = makeUndo(sink);
    const boom = Object.assign(new Error("gone"), { code: "ENOENT" });
    undo.pushUndoBatch(
      "op",
      [() => {}],
      [
        () => {
          throw boom;
        },
      ],
    );
    undo.undoLast();
    await settleUntil(() => sink.notes.some((n) => n.startsWith("notify:undo:")));
    undo.redoLast();
    await settleUntil(() => sink.notes.some((n) => n.includes("1 FAILED")));
    expect(sink.notes).toContain("notify:redo failed:error:Redo op · 1 FAILED (source gone)");
    expect(sink.notes.filter((n) => n.startsWith("notify:"))).toHaveLength(2); // undo ok + redo failed
    // the batch returns to the undo stack even on failed redo (matches old behavior)
    expect(undo.undoDepth()).toBe(1);
  });

  test("a second undo while one is in flight is ignored (no interleaved batches)", async () => {
    // rapid ctrl+z used to pop TWO batches and run their fs closures
    // concurrently against overlapping paths
    const sink = recordingSink();
    const undo = makeUndo(sink);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let ran = 0;
    undo.pushUndoBatch("slow", [
      async () => {
        ran++;
        await gate;
      },
    ]);
    undo.pushUndoBatch("next", [
      async () => {
        ran++;
      },
    ]);
    undo.undoLast(); // starts the slow batch, pops "slow"
    undo.undoLast(); // in-flight → must be a no-op, NOT pop "next"
    release();
    await settleUntil(() => sink.notes.some((n) => n.startsWith("notify:undo:")));
    expect(ran).toBe(1);
    expect(undo.undoDepth()).toBe(1); // "next" still queued for a real second press
  });

  test("a second redo while one is in flight is ignored", async () => {
    const sink = recordingSink();
    const undo = makeUndo(sink);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let ran = 0;
    undo.pushUndoBatch(
      "slow",
      [() => {}],
      [
        async () => {
          ran++;
          await gate;
        },
      ],
    );
    undo.undoLast();
    await settleUntil(() => sink.notes.some((n) => n.startsWith("notify:undo:")));
    undo.redoLast();
    undo.redoLast(); // in-flight → no-op
    release();
    await settleUntil(() => sink.notes.some((n) => n.startsWith("notify:redo:")));
    expect(ran).toBe(1);
    expect(undo.redoDepth()).toBe(0);
  });
});

describe("journal data (persistent undo)", () => {
  test("snapshotData exports only batches pushed with data", () => {
    const undo = makeUndo(recordingSink());
    undo.pushUndoBatch("session-only", [() => {}]);
    undo.pushUndoBatch("journalable", [() => {}], [], {
      units: [{ op: "rename", from: "/a", to: "/b" }],
      redos: [],
    });
    const snap = undo.snapshotData();
    expect(snap.length).toBe(1);
    expect(snap[0]!.label).toBe("journalable");
    expect(snap[0]!.units).toEqual([{ op: "rename", from: "/a", to: "/b" }]);
    expect(typeof snap[0]!.at).toBe("number");
  });

  test("adopted batches undo for real (rehydrated rename moves the file back)", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "tfm-undo-adopt-"));
    try {
      const moved = path.join(dir, "moved.txt");
      const orig = path.join(dir, "orig.txt");
      writeFileSync(moved, "data");
      const sink = recordingSink();
      const undo = makeUndo(sink);
      const data: UndoBatchData = {
        label: "rename",
        at: Date.now(),
        units: [{ op: "rename", from: moved, to: orig }],
        redos: [{ op: "rename-if", from: orig, to: moved }],
      };
      expect(undo.adoptBatches([data])).toBe(1);
      expect(undo.undoDepth()).toBe(1);
      expect(undo.redoDepth()).toBe(0);
      undo.undoLast();
      // poll on the batch having FINISHED (undo = move back + redoable), not
      // on the file's location — the rename can land mid-batch under load
      await settleUntil(() => sink.notes.some((n) => n.startsWith("notify:undo:")));
      expect(existsSync(moved)).toBe(false);
      expect(existsSync(orig)).toBe(true);
      expect(sink.notes).toContain("notify:undo:success:Undid: rename · ctrl+y to redo");
      // and redo re-applies
      undo.redoLast();
      await settleUntil(() => sink.notes.some((n) => n.startsWith("notify:redo:")));
      expect(existsSync(moved)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("adoptBatches caps at MAX_UNDO_BATCHES, newest win", () => {
    const undo = makeUndo(recordingSink());
    const datas: UndoBatchData[] = Array.from({ length: MAX_UNDO_BATCHES + 5 }, (_, i) => ({
      label: `op ${i}`,
      at: Date.now(),
      units: [{ op: "rename", from: `/a${i}`, to: `/b${i}` }],
      redos: [],
    }));
    expect(undo.adoptBatches(datas)).toBe(MAX_UNDO_BATCHES);
    expect(undo.undoDepth()).toBe(MAX_UNDO_BATCHES);
    expect(undo.snapshotData()[0]!.label).toBe("op 5");
  });

  test("write-empty-if-missing redo never truncates a raced occupant", async () => {
    // a file arriving between undo and redo used to be silently truncated to
    // ""; the O_EXCL create fails instead and the occupant survives intact
    const dir = mkdtempSync(path.join(os.tmpdir(), "tfm-undo-wx-"));
    try {
      const p = path.join(dir, "n.txt");
      const redo = stepToUnit({ op: "write-empty-if-missing", path: p });
      await redo();
      expect(readFileSync(p, "utf8")).toBe("");
      writeFileSync(p, "precious");
      await redo();
      expect(readFileSync(p, "utf8")).toBe("precious");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("onChange fires on push, undo and redo (wiring persists the journal)", async () => {
    const sink = recordingSink();
    let changes = 0;
    const undo = makeUndo(sink, { onChange: () => changes++ });
    undo.pushUndoBatch("op", [() => {}], [() => {}], { units: [{ op: "rm", path: "/x" }], redos: [] });
    expect(changes).toBe(1);
    undo.undoLast();
    await settleUntil(() => changes === 2);
    undo.redoLast();
    await settleUntil(() => changes === 3);
  });
});

describe("journal trash idempotency", () => {
  test("undoing a trash step for an already-absent path succeeds (already at end-state)", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "tfm-undo-trash-"));
    try {
      const gone = path.join(dir, "already-gone.txt");
      const sink = recordingSink();
      const undo = makeUndo(sink);
      const data: UndoBatchData = {
        label: "copy",
        at: Date.now(),
        units: [{ op: "trash", path: gone }],
        redos: [],
      };
      expect(undo.adoptBatches([data])).toBe(1);
      undo.undoLast();
      await settleUntil(() => sink.notes.some((n) => n.startsWith("notify:undo:")));
      expect(sink.notes).toContain("notify:undo:success:Undid: copy");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("journal trash identity", () => {
  test("a rehydrated trash step skips a reoccupied path (dev+ino mismatch)", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "tfm-undo-ident-"));
    try {
      const p = path.join(dir, "f.txt");
      writeFileSync(p, "orig");
      // the id exactly as production records it (fileIdOf: dev+ino+birth) —
      // on ext4 the stranger below reuses the freed inode, so dev+ino alone
      // would match it and trash the wrong file
      const id = fileIdOf(p)!;
      // the recorded file is gone; a stranger took its name
      rmSync(p);
      writeFileSync(p, "stranger");
      const sink = recordingSink();
      const undo = makeUndo(sink);
      const data: UndoBatchData = {
        label: "copy",
        at: Date.now(),
        units: [{ op: "trash", path: p, ...id }],
        redos: [],
      };
      expect(undo.adoptBatches([data])).toBe(1);
      undo.undoLast();
      await settleUntil(() => sink.notes.some((n) => n.startsWith("notify:undo:")));
      // the stranger survives and the batch reports success, not FAILED
      expect(readFileSync(p, "utf8")).toBe("stranger");
      expect(sink.notes).toContain("notify:undo:success:Undid: copy");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a rehydrated trash step without identity falls back to path semantics", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "tfm-undo-noid-"));
    // sandbox the trash target: the fallback really trashes, and that must
    // never touch the real ~/.local/share
    const oldDataHome = process.env.XDG_DATA_HOME;
    const xdg = mkdtempSync(path.join(os.tmpdir(), "tfm-undo-noid-xdg-"));
    process.env.XDG_DATA_HOME = xdg;
    try {
      const p = path.join(dir, "g.txt");
      writeFileSync(p, "orig");
      rmSync(p);
      writeFileSync(p, "stranger");
      const sink = recordingSink();
      const undo = makeUndo(sink);
      // old journals carry no dev/ino — path semantics trash the occupant
      // (restorable from the sandboxed trash, not deleted)
      const data: UndoBatchData = {
        label: "copy",
        at: Date.now(),
        units: [{ op: "trash", path: p }],
        redos: [],
      };
      expect(undo.adoptBatches([data])).toBe(1);
      undo.undoLast();
      await settleUntil(() => sink.notes.some((n) => n.startsWith("notify:undo:")));
      expect(sink.notes).toContain("notify:undo:success:Undid: copy");
      expect(existsSync(p)).toBe(false);
    } finally {
      if (oldDataHome === undefined) delete process.env.XDG_DATA_HOME;
      else process.env.XDG_DATA_HOME = oldDataHome;
      rmSync(dir, { recursive: true, force: true });
      rmSync(xdg, { recursive: true, force: true });
    }
  });
});
