import { describe, expect, test } from "bun:test";
import { makeUndo, MAX_UNDO_BATCHES, type UndoSink } from "./undo";

const recordingSink = (): UndoSink & { notes: string[] } => {
  const notes: string[] = [];
  return {
    notes,
    status: (msg) => notes.push(`status:${msg}`),
    notify: (msg, title) => notes.push(`notify:${title ?? ""}:${msg}`),
    refresh: () => notes.push("refresh"),
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
    expect(sink.notes).toContain("status:Undid: op 34");
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
    await settleUntil(() => sink.notes.some((n) => n.startsWith("status:Undid")));
    expect(undo.redoDepth()).toBe(0);
    expect(sink.notes).toContain("status:Undid: one-way");
    expect(sink.notes.some((n) => n.includes("ctrl+y"))).toBe(false);
  });

  test("undo on empty stack only sets status", async () => {
    const sink = recordingSink();
    const undo = makeUndo(sink);
    undo.undoLast();
    await settleUntil(() => sink.notes.length === 1);
    expect(sink.notes).toEqual(["status:Nothing to undo"]);
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
    expect(sink.notes).toContain("status:Undo messy · 1 FAILED (permission denied)");
    expect(sink.notes).toContain("notify:undo failed:Undo messy · 1 FAILED (permission denied)");
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
    expect(sink.notes).toContain("status:Redid: op");
    expect(sink.notes).toContain("notify:redo:Redid: op");
  });

  test("redo on empty stack only sets status", async () => {
    const sink = recordingSink();
    const undo = makeUndo(sink);
    undo.redoLast();
    await settleUntil(() => sink.notes.length === 1);
    expect(sink.notes).toEqual(["status:Nothing to redo"]);
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
    await settleUntil(() => sink.notes.some((n) => n.startsWith("status:Undid")));
    undo.redoLast();
    await settleUntil(() => sink.notes.some((n) => n.includes("1 FAILED")));
    expect(sink.notes).toContain("status:Redo op · 1 FAILED (source gone)");
    expect(sink.notes).toContain("notify:redo failed:Redo op · 1 FAILED (source gone)");
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
    await settleUntil(() => sink.notes.some((n) => n.startsWith("status:Undid")));
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
    await settleUntil(() => sink.notes.some((n) => n.startsWith("status:Undid")));
    undo.redoLast();
    undo.redoLast(); // in-flight → no-op
    release();
    await settleUntil(() => sink.notes.some((n) => n.startsWith("status:Redid")));
    expect(ran).toBe(1);
    expect(undo.redoDepth()).toBe(0);
  });
});
