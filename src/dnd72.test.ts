import { describe, expect, test } from "bun:test";
import { makeDnd72, splitOsc72Seq, type Dnd72Ctx } from "./dnd72";
import { gridDrag } from "./grid-input";
import { startDropFrame, uriListPayload } from "./osc72";

const baseCtx = () => {
  const tx: string[] = [];
  const logs: string[] = [];
  const status: string[] = [];
  const notes: string[] = [];
  let oscCb: ((seq: string) => void) | null = null;
  const ctx: Dnd72Ctx & { tx: string[]; logs: string[]; status: string[]; notes: string[]; runTransfers: any[]; moveIns: any[]; trashed: string[][] } = {
    tx,
    logs,
    status,
    notes,
    runTransfers: [],
    moveIns: [],
    trashed: [],
    log: (m) => logs.push(m),
    writeFrame: (s) => tx.push(s),
    hitTargetAt: (x, y, dragPaths) => {
      if (x === 5 && y === 5) {
        if (dragPaths?.includes("/d/dest")) return null; // dropping onto itself
        return { kind: "folder", path: "/d/dest" };
      }
      return null;
    },
    tileRefs: new Map([["/d/dest", { selected: false, isDir: true }]]),
    setTileVisual: (key, mode) => logs.push(`visual:${key}:${mode}`),
    hoverPlace: (p) => logs.push(`hoverPlace:${p}`),
    clearHoverPlace: () => logs.push("clearHoverPlace"),
    finishDrag: () => logs.push("finishDrag"),
    escMenuOpen: () => false,
    fileMenuOpen: () => false,
    trashPaths: (ps) => ctx.trashed.push(ps),
    moveInto: async (destDir, items) => { ctx.moveIns.push([destDir, items]); },
    runTransfer: async (op, destDir, srcs, label) => { ctx.runTransfers.push([op, destDir, srcs, label]); },
    cwd: () => "/home/u",
    virtualCwd: () => false,
    home: "/home/u",
    setStatusMsg: (m) => status.push(m),
    notify: (m, t) => notes.push(`${t}: ${m}`),
    subscribeOsc: (cb) => { oscCb = cb; },
  };
  const feed = (meta: string, payload = ""): void => {
    oscCb!(`\x1b]72;${meta};${payload}\x1b\\`);
  };
  return { ctx, feed, tx, logs, status, notes };
};

const b64 = (s: string): string =>
  Buffer.from(s, "utf8").toString("base64").replace(/=+$/, "");

describe("splitOsc72Seq", () => {
  test("splits meta/payload and strips terminators", () => {
    expect(splitOsc72Seq("\x1b]72;t=m:o=1;text/uri-list\x1b\\")).toEqual({ meta: "t=m:o=1", payload: "text/uri-list" });
    expect(splitOsc72Seq("\x1b]72;t=r:x=1;QUJD\x07")).toEqual({ meta: "t=r:x=1", payload: "QUJD" });
    expect(splitOsc72Seq("\x1b]72;t=M:x=1")).toEqual({ meta: "t=M:x=1", payload: "" });
    expect(splitOsc72Seq("\x1b]10;rgb:0000\x1b\\")).toBeNull();
  });
});

describe("outgoing drag", () => {
  test("plain drag offer starts an OS drag session", () => {
    const { ctx, feed, tx, status, logs } = baseCtx();
    makeDnd72(ctx);
    gridDrag.ctrl = false;
    gridDrag.keys = [{ path: "/d/a", isDir: false }];
    feed("t=o:x=64:y=10");
    expect(tx.some((s) => s.startsWith("\x1b]72;t=o:o=3"))).toBe(true); // agree
    expect(tx.some((s) => s.includes("t=p:x=0:m=0;"))).toBe(true); // present payload
    expect(tx.some((s) => s.startsWith("\x1b]72;t=P:x=-1"))).toBe(true); // start
    expect(status[0]).toContain("Dragging 1 item");
    expect(logs).toContain("finishDrag");
    gridDrag.keys = null;
  });

  test("ctrl+drag (internal move) declines the offer", () => {
    const { ctx, feed, tx } = baseCtx();
    makeDnd72(ctx);
    gridDrag.ctrl = true;
    gridDrag.keys = [{ path: "/d/a", isDir: false }];
    feed("t=o:x=64:y=10");
    expect(tx).toEqual([]);
    gridDrag.ctrl = false;
    gridDrag.keys = null;
  });

  test("menu open declines the offer", () => {
    const { ctx, feed, tx } = baseCtx();
    ctx.escMenuOpen = () => true;
    makeDnd72(ctx);
    gridDrag.ctrl = false;
    gridDrag.keys = [{ path: "/d/a", isDir: false }];
    feed("t=o:x=64:y=10");
    expect(tx).toEqual([]);
    gridDrag.keys = null;
  });
});

describe("incoming drop", () => {
  test("ready → request chunks → finish routes payload to runTransfer", async () => {
    const { ctx, feed } = baseCtx();
    makeDnd72(ctx);
    feed("t=m", "text/uri-list x-special/gnome-copied-files");
    feed("t=M:x=1", "text/uri-list");
    // mime index 1 is 1-based → wire idx 2
    feed("t=r:x=1", b64("file:///home/u/a.txt\r\nfile:///home/u"));
    feed("t=r:x=1"); // empty frame + m=0 → finish
    await Bun.sleep(10);
    expect(ctx.runTransfers).toEqual([["copy", "/home/u", ["/home/u/a.txt", "/home/u"], "drop"]]);
  });

  test("startDropFrame requests the 1-based wire index", () => {
    const { ctx, feed, tx } = baseCtx();
    makeDnd72(ctx);
    feed("t=m", "text/uri-list");
    feed("t=M:x=1", "text/uri-list");
    expect(tx.some((s) => s === startDropFrame(1))).toBe(true);
  });

  test("rejects drops while one is already in flight", () => {
    const { ctx, feed, tx } = baseCtx();
    makeDnd72(ctx);
    feed("t=M:x=1", "text/uri-list");
    feed("t=M:x=1", "text/uri-list"); // second ready while busy
    expect(tx.filter((s) => s === startDropFrame(1)).length).toBe(1);
  });

  test("virtual cwd refuses drops", async () => {
    const { ctx, feed, status } = baseCtx();
    ctx.virtualCwd = () => true;
    makeDnd72(ctx);
    feed("t=M:x=1", "text/uri-list");
    feed("t=r:x=1", b64("file:///x"));
    feed("t=r:x=1");
    await Bun.sleep(10);
    expect(ctx.runTransfers).toEqual([]);
    expect(status).toContain("Drops land in a real folder");
  });
});

describe("self drop", () => {
  test("hover highlights the folder tile, drop moves into it", async () => {
    const { ctx, feed, logs } = baseCtx();
    makeDnd72(ctx);
    gridDrag.ctrl = false;
    gridDrag.keys = [{ path: "/d/a", isDir: false }];
    feed("t=o:x=1:y=1"); // begin session
    feed("t=m:x=5:y=5"); // self hover onto /d/dest
    expect(logs).toContain("visual:/d/dest:2");
    feed("t=M:x=5:y=5"); // self drop
    await Bun.sleep(10);
    expect(ctx.moveIns.length).toBe(1);
    const [dest, items] = ctx.moveIns[0]!;
    expect(dest).toBe("/d/dest");
    expect(items).toEqual([{ path: "/d/a", isDir: false }]);
    gridDrag.keys = null;
  });

  test("drop onto a non-target rejects and reports cancel", async () => {
    const { ctx, feed, tx, status } = baseCtx();
    makeDnd72(ctx);
    gridDrag.keys = [{ path: "/d/a", isDir: false }];
    feed("t=o:x=1:y=1");
    feed("t=M:x=99:y=99"); // miss
    await Bun.sleep(10);
    expect(tx.some((s) => s.includes("t=r:o=0"))).toBe(true); // self drop reject
    expect(status).toContain("drag cancelled");
    gridDrag.keys = null;
  });

  test("drop onto the trash place trashes instead of moving", async () => {
    const { ctx, feed } = baseCtx();
    ctx.hitTargetAt = () => ({ kind: "place", path: "/home/u/.local/share/Trash/files" });
    makeDnd72(ctx);
    gridDrag.keys = [{ path: "/d/a", isDir: false }];
    feed("t=o:x=1:y=1");
    feed("t=M:x=5:y=5");
    await Bun.sleep(10);
    expect(ctx.trashed).toEqual([["/d/a"]]);
    expect(ctx.moveIns).toEqual([]);
    gridDrag.keys = null;
  });
});

describe("external drag end", () => {
  test("released over another app (copy) notifies Sent", async () => {
    const { ctx, feed, notes } = baseCtx();
    makeDnd72(ctx);
    gridDrag.keys = [{ path: "/d/a", isDir: false }];
    feed("t=o:x=1:y=1");
    feed("t=e:x=4:y=0"); // end, not canceled, no self drop handled
    await Bun.sleep(750); // end is deferred 700ms for in-flight self drops
    expect(notes.some((n) => n.includes("Sent 1 item"))).toBe(true);
    gridDrag.keys = null;
  });

  test("external move semantics trash our copies", async () => {
    const { ctx, feed } = baseCtx();
    makeDnd72(ctx);
    gridDrag.keys = [{ path: "/d/a", isDir: false }];
    feed("t=o:x=1:y=1");
    feed("t=e:x=2:y=2"); // op=move
    feed("t=e:x=4:y=0");
    await Bun.sleep(750);
    expect(ctx.trashed).toEqual([["/d/a"]]);
    gridDrag.keys = null;
  });
});

describe("payload length", () => {
  test("present frame carries the unpadded b64 uri-list", () => {
    const paths = ["/a b.txt"];
    expect(uriListPayload(paths)).not.toContain("=");
  });
});
