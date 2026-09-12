import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { makeDnd72, splitOsc72Seq, type Dnd72Ctx } from "./dnd72";
import { gridDrag } from "../input/grid-input";
import { startDropFrame, uriListPayload } from "./osc72";
import { trashDir } from "../fs/fsutil";

// trash-place routing compares against trashDir() (XDG-aware), so sandbox
// XDG_DATA_HOME like the trashops tests do — a hardcoded ~/.local/share
// path diverges under relocation, which is exactly the bug being pinned
const oldDataHome = process.env.XDG_DATA_HOME;
const XDG_ROOT = mkdtempSync(path.join(os.tmpdir(), "tfm-dnd-xdg-"));
beforeAll(() => {
  process.env.XDG_DATA_HOME = path.join(XDG_ROOT, "data");
});
afterAll(() => {
  if (oldDataHome === undefined) delete process.env.XDG_DATA_HOME;
  else process.env.XDG_DATA_HOME = oldDataHome;
  rmSync(XDG_ROOT, { recursive: true, force: true });
});

const baseCtx = () => {
  const tx: string[] = [];
  const logs: string[] = [];
  const status: string[] = [];
  const notes: string[] = [];
  let oscCb: ((seq: string) => void) | null = null;
  const ctx: Dnd72Ctx & {
    tx: string[];
    logs: string[];
    status: string[];
    notes: string[];
    runTransfers: any[];
    moveIns: any[];
    trashed: string[][];
  } = {
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
    trashPaths: (ps) => {
      ctx.trashed.push(ps);
      return Promise.resolve();
    },
    moveInto: async (destDir, items) => {
      ctx.moveIns.push([destDir, items]);
    },
    runTransfer: async (op, destDir, srcs, label) => {
      ctx.runTransfers.push([op, destDir, srcs, label]);
    },
    cwd: () => "/home/u",
    virtualCwd: () => false,
    inTrashView: () => false,
    setStatusMsg: (m) => status.push(m),
    notify: (m, t, l) => notes.push(`${t}:${l}: ${m}`),
    subscribeOsc: (cb) => {
      oscCb = cb;
    },
  };
  const feed = (meta: string, payload = ""): void => {
    oscCb!(`\x1b]72;${meta};${payload}\x1b\\`);
  };
  return { ctx, feed, tx, logs, status, notes };
};

const b64 = (s: string): string => Buffer.from(s, "utf8").toString("base64").replace(/=+$/, "");

// poll on observable state (fake ctx arrays) instead of fixed sleeps — the
// drop finishing is fire-and-forget inside dnd72
const settleUntil = async (cond: () => boolean, ms = 2000): Promise<void> => {
  const deadline = Date.now() + ms;
  while (!cond() && Date.now() < deadline) await Bun.sleep(10);
  if (!cond()) throw new Error("settleUntil timeout");
};

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
    await settleUntil(() => ctx.runTransfers.length > 0);
    expect(ctx.runTransfers).toEqual([["copy", "/home/u", ["/home/u/a.txt", "/home/u"], "drop 2 items"]]);
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
    const { ctx, feed, notes } = baseCtx();
    ctx.virtualCwd = () => true;
    makeDnd72(ctx);
    feed("t=M:x=1", "text/uri-list");
    feed("t=r:x=1", b64("file:///x"));
    feed("t=r:x=1");
    await settleUntil(() => notes.length > 0);
    expect(ctx.runTransfers).toEqual([]);
    expect(notes).toContain("drop:info: Drops land in a real folder");
  });

  test("trash view trashes external drops (no raw copy without trashinfo)", async () => {
    const { ctx, feed } = baseCtx();
    ctx.inTrashView = () => true;
    makeDnd72(ctx);
    feed("t=M:x=1", "text/uri-list");
    feed("t=r:x=1", b64("file:///home/u/a.txt"));
    feed("t=r:x=1");
    await settleUntil(() => ctx.trashed.length > 0);
    expect(ctx.runTransfers).toEqual([]);
    expect(ctx.trashed).toEqual([[`/home/u/a.txt`]]);
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
    await settleUntil(() => ctx.moveIns.length > 0);
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
    await settleUntil(() => status.includes("drag cancelled"));
    expect(tx.some((s) => s.includes("t=r:o=0"))).toBe(true); // self drop reject
    expect(status).toContain("drag cancelled");
    gridDrag.keys = null;
  });

  test("drop onto the trash place trashes instead of moving", async () => {
    const { ctx, feed } = baseCtx();
    ctx.hitTargetAt = () => ({ kind: "place", path: path.join(trashDir(), "files") });
    makeDnd72(ctx);
    gridDrag.keys = [{ path: "/d/a", isDir: false }];
    feed("t=o:x=1:y=1");
    feed("t=M:x=5:y=5");
    await settleUntil(() => ctx.trashed.length > 0);
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
    await Bun.sleep(750); // deferred end is a fixed 700ms timer with no observable pre-signal
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
    await settleUntil(() => ctx.trashed.length > 0, 3000); // 700ms-deferred epilogue
    gridDrag.keys = null;
  });

  test("a new drag starting inside the end window completes its own epilogue", async () => {
    const { ctx, feed, notes } = baseCtx();
    makeDnd72(ctx);
    // session A ends over another app (copy) — its epilogue is deferred 700ms
    gridDrag.keys = [{ path: "/d/a", isDir: false }];
    feed("t=o:x=1:y=1");
    feed("t=e:x=4:y=0");
    // session B starts inside that window and ends over another app too
    gridDrag.keys = [{ path: "/d/b", isDir: false }];
    feed("t=o:x=1:y=1");
    feed("t=e:x=4:y=0");
    // both sessions must report "Sent" — the stale fire resetting the shared
    // state (dragPaths=null) used to swallow session B's epilogue entirely
    const deadline = Date.now() + 3000;
    while (notes.filter((n) => n.includes("Sent 1 item")).length < 2 && Date.now() < deadline) await Bun.sleep(10);
    expect(notes.filter((n) => n.includes("Sent 1 item")).length).toBe(2);
    gridDrag.keys = null;
  });

  test("stale copy-session epilogue never trashes sources because a new drag was a move", async () => {
    const { ctx, feed, notes } = baseCtx();
    makeDnd72(ctx);
    // A: copy drag, end over another app → deferred epilogue
    gridDrag.keys = [{ path: "/d/a", isDir: false }];
    feed("t=o:x=1:y=1");
    feed("t=e:x=4:y=0");
    // B: move drag begins inside A's window and announces op=move
    gridDrag.keys = [{ path: "/d/b", isDir: false }];
    feed("t=o:x=1:y=1");
    feed("t=e:x=2:y=2");
    // the stale timer reads the snapshot (A was a copy), not the live op
    await settleUntil(() => notes.some((n) => n.includes("Sent 1 item")), 3000); // A's epilogue ran as a copy
    expect(ctx.trashed).toEqual([]); // A's sources survive
    expect(notes).toContain("drag & drop:success: Sent 1 item"); // A's copy epilogue ran as a copy
    // B still completes with move semantics
    feed("t=e:x=4:y=0");
    const deadline = Date.now() + 3000;
    while (ctx.trashed.length === 0 && Date.now() < deadline) await Bun.sleep(10);
    expect(ctx.trashed).toEqual([["/d/b"]]);
    gridDrag.keys = null;
  });
});

describe("wire errors", () => {
  test("drop error names the reason in the toast", () => {
    const { ctx, feed, notes } = baseCtx();
    makeDnd72(ctx);
    feed("t=R", "denied by target");
    expect(notes).toContain("drop failed:error: Drop failed (denied by target)");
  });

  test("drag offer error names the reason in the toast", () => {
    const { ctx, feed, notes } = baseCtx();
    makeDnd72(ctx);
    feed("t=E", "offer timeout");
    expect(notes).toContain("drag failed:error: Drag failed (offer timeout)");
  });
});

describe("payload length", () => {
  test("present frame carries the unpadded b64 uri-list", () => {
    const paths = ["/a b.txt"];
    expect(uriListPayload(paths)).not.toContain("=");
  });
});
