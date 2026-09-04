import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { makeUndo, MAX_UNDO_BATCHES, type UndoBatchData, type UndoSink } from "./undo";

const recordingSink = (): UndoSink & { notes: string[] } => {
  const notes: string[] = [];
  return {
    notes,
    setStatusMsg: (msg) => notes.push(`setStatusMsg:${msg}`),
    notify: (msg, title) => notes.push(`notify:${title ?? ""}:${msg}`),
    renderAll: () => notes.push("renderAll"),
  };
};

const settle = () => Bun.sleep(20);

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
    await settle();
    expect(undo.redoDepth()).toBe(1);
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
    await settle();
    expect(ran).toEqual([String(MAX_UNDO_BATCHES + 4)]);
    // batch was pushed without redos → not redoable, no hint
    expect(sink.notes).toContain("setStatusMsg:Undid: op 34");
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
    await settle();
    expect(ran).toEqual(["c", "b", "a"]);
  });

  test("batch without redos is not redoable — no ctrl+y hint", async () => {
    const sink = recordingSink();
    const undo = makeUndo(sink);
    undo.pushUndoBatch("one-way", [() => {}]);
    undo.undoLast();
    await settle();
    expect(undo.redoDepth()).toBe(0);
    expect(sink.notes).toContain("setStatusMsg:Undid: one-way");
    expect(sink.notes.some((n) => n.includes("ctrl+y"))).toBe(false);
  });

  test("undo on empty stack only sets status", async () => {
    const sink = recordingSink();
    const undo = makeUndo(sink);
    undo.undoLast();
    await settle();
    expect(sink.notes).toEqual(["setStatusMsg:Nothing to undo"]);
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
    await settle();
    // failed runs get no ctrl+y hint (original behavior) but stay redoable
    expect(sink.notes).toContain("setStatusMsg:Undo messy · 1 FAILED (permission denied)");
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
    await settle();
    undo.redoLast();
    await settle();
    expect(ran).toEqual(["u", "r"]);
    expect(undo.undoDepth()).toBe(1);
    expect(undo.redoDepth()).toBe(0);
    expect(sink.notes).toContain("setStatusMsg:Redid: op · ctrl+z to undo");
    expect(sink.notes).toContain("notify:redo:Redid: op · ctrl+z to undo");
  });

  test("redo on empty stack only sets status", async () => {
    const sink = recordingSink();
    const undo = makeUndo(sink);
    undo.redoLast();
    await settle();
    expect(sink.notes).toEqual(["setStatusMsg:Nothing to redo"]);
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
    await settle();
    undo.redoLast();
    await settle();
    expect(sink.notes).toContain("setStatusMsg:Redo op · 1 FAILED (source gone)");
    expect(sink.notes).toContain("notify:redo failed:Redo op · 1 FAILED (source gone)");
    // the batch returns to the undo stack even on failed redo (matches old behavior)
    expect(undo.undoDepth()).toBe(1);
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
      await settle();
      expect(existsSync(moved)).toBe(false);
      expect(existsSync(orig)).toBe(true);
      expect(sink.notes).toContain("setStatusMsg:Undid: rename · ctrl+y to redo");
      // and redo re-applies
      undo.redoLast();
      await settle();
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

  test("onChange fires on push, undo and redo (wiring persists the journal)", async () => {
    const sink = recordingSink();
    let changes = 0;
    const undo = makeUndo(sink, { onChange: () => changes++ });
    undo.pushUndoBatch("op", [() => {}], [() => {}], { units: [{ op: "rm", path: "/x" }], redos: [] });
    expect(changes).toBe(1);
    undo.undoLast();
    await settle();
    expect(changes).toBe(2);
    undo.redoLast();
    await settle();
    expect(changes).toBe(3);
  });
});
