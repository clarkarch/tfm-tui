import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
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
    remoteTimeoutMs: () => 2000,
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

  test("bare E ack (empty payload) is not a drag error", () => {
    const { ctx, feed, notes } = baseCtx();
    makeDnd72(ctx);
    gridDrag.ctrl = false;
    gridDrag.keys = [{ path: "/d/a", isDir: false }];
    feed("t=o:x=64:y=10");
    feed("t=E"); // kitty's StartDrag ack with an EMPTY payload
    feed("t=E", "OK"); // and the OK payload form
    expect(notes).toEqual([]);
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

  test("keyless continuation chunks complete the drop (kitty omits keys)", async () => {
    // kitty sends continuations as bare `m=1;<chunk>` (spec: chunks after the
    // first may omit all metadata but m) — a >3KB uri-list must still land,
    // and the NEXT drop must not wedge on a stuck dropIdx
    const { ctx, feed } = baseCtx();
    makeDnd72(ctx);
    feed("t=m", "text/uri-list");
    feed("t=M:x=1", "text/uri-list");
    const full = b64(`file:///home/u/${"a".repeat(4000)}.txt`);
    feed("t=r:x=1:m=1", full.slice(0, 100));
    feed("m=1", full.slice(100)); // no keys at all
    feed("t=r:x=1"); // EOF
    await settleUntil(() => ctx.runTransfers.length > 0);
    // the FULL path landed, not the first chunk's truncation
    expect(ctx.runTransfers[0]).toEqual(["copy", "/home/u", [`/home/u/${"a".repeat(4000)}.txt`], "drop 1 item"]);
    // the session freed: a second drop transfers too
    feed("t=M:x=1", "text/uri-list");
    feed("t=r:x=1", b64("file:///home/u/b.txt"));
    feed("t=r:x=1");
    await settleUntil(() => ctx.runTransfers.length > 1);
    expect(ctx.runTransfers.length).toBe(2);
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
  test("hover over a folder tile agrees the drop (else kitty cancels it)", () => {
    const { ctx, feed, tx } = baseCtx();
    makeDnd72(ctx);
    gridDrag.keys = [{ path: "/d/a", isDir: false }];
    feed("t=o:x=1:y=1"); // begin session
    feed("t=m:x=5:y=5"); // self hover onto /d/dest
    expect(tx.some((s) => s === "\x1b]72;t=m:o=2;text/uri-list\x1b\\")).toBe(true);
    gridDrag.keys = null;
  });

  test("hover over no target rejects the hover (no late session cancel)", () => {
    const { ctx, feed, tx } = baseCtx();
    makeDnd72(ctx);
    gridDrag.keys = [{ path: "/d/a", isDir: false }];
    feed("t=o:x=1:y=1");
    feed("t=m:x=99:y=99"); // miss — hitTargetAt returns null
    expect(tx.some((s) => s === "\x1b]72;t=m:o=0\x1b\\")).toBe(true);
    gridDrag.keys = null;
  });
  test("hover highlights the folder tile, drop moves into it", async () => {
    const { ctx, feed, logs, tx } = baseCtx();
    makeDnd72(ctx);
    gridDrag.ctrl = false;
    gridDrag.keys = [{ path: "/d/a", isDir: false }];
    feed("t=o:x=1:y=1"); // begin session
    feed("t=m:x=5:y=5"); // self hover onto /d/dest
    expect(logs).toContain("visual:/d/dest:2");
    feed("t=M:x=5:y=5"); // self drop
    await settleUntil(() => ctx.moveIns.length > 0);
    expect(tx.some((s) => s === "\x1b]72;t=r:o=2\x1b\\")).toBe(true); // completion handshake
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

  test("a completed self-drop does not paint 'drag cancelled' after the end event", async () => {
    const { ctx, feed, status } = baseCtx();
    makeDnd72(ctx);
    gridDrag.ctrl = false;
    gridDrag.keys = [{ path: "/d/a", isDir: false }];
    feed("t=o:x=1:y=1");
    feed("t=M:x=5:y=5"); // self drop — moves /d/a into /d/dest
    await settleUntil(() => ctx.moveIns.length > 0);
    feed("t=e:x=4:y=1"); // kitty's canceled=true end event after every drop
    await settleUntil(() => status.length > 0);
    expect(status).not.toContain("drag cancelled");
    gridDrag.keys = null;
  });

  test("hovering a folder clears a previous place hover (no lingering highlight)", () => {
    const { ctx, feed, logs } = baseCtx();
    makeDnd72(ctx);
    gridDrag.keys = [{ path: "/d/a", isDir: false }];
    feed("t=o:x=1:y=1");
    feed("t=m:x=5:y=5"); // folder target
    expect(logs).toContain("clearHoverPlace");
    gridDrag.keys = null;
  });

  test("self-drop clears the place hover highlight", async () => {
    const { ctx, feed, logs } = baseCtx();
    ctx.hitTargetAt = () => ({ kind: "place", path: "/places/Downloads" });
    makeDnd72(ctx);
    gridDrag.keys = [{ path: "/d/a", isDir: false }];
    feed("t=o:x=1:y=1");
    feed("t=M:x=5:y=5");
    await settleUntil(() => logs.includes("clearHoverPlace"));
    gridDrag.keys = null;
  });
});

describe("remote drops", () => {
  test("enableDrops declares the drop-side machine id when known", () => {
    const { ctx, tx } = baseCtx();
    ctx.machineId = () => "1:abcd";
    const { enableDrops } = makeDnd72(ctx);
    enableDrops();
    expect(tx).toContain("\x1b]72;t=a:x=1;1:abcd\x1b\\");
    // the drag side declares it too (invites t=k serve requests we answer)
    expect(tx).toContain("\x1b]72;t=o:x=1;1:abcd\x1b\\");
  });

  test("enableDrops skips the id frame when unknown (today's behavior)", () => {
    const { ctx, tx } = baseCtx();
    const { enableDrops } = makeDnd72(ctx);
    enableDrops();
    expect(tx.some((s) => s.includes("t=a:x=1"))).toBe(false);
  });

  test("X=1 uri-list requests each entry by subidx", async () => {
    const { ctx, feed, tx } = baseCtx();
    makeDnd72(ctx);
    feed("t=m", "text/uri-list");
    feed("t=M:x=1", "text/uri-list");
    feed("t=r:x=1:X=1", b64("file:///remote/a.txt\r\nfile:///remote/b.txt"));
    feed("t=r:x=1"); // empty frame + m=0 → uri-list complete
    await settleUntil(() => tx.some((s) => s === "\x1b]72;t=r:x=1:y=1\x1b\\"));
    // answer the first entry so the fetch proceeds to the second
    feed("t=r:x=1:y=1", b64("AAA"));
    feed("t=r:x=1:y=1");
    await settleUntil(() => tx.some((s) => s === "\x1b]72;t=r:x=1:y=2\x1b\\"));
    gridDrag.keys = null;
  });

  test("fetched file bytes land via runTransfer, finish handshake, staging cleaned", async () => {
    const { ctx, feed, tx } = baseCtx();
    let stagedContent = "";
    ctx.runTransfer = async (_op, _dest, srcs) => {
      ctx.runTransfers.push([_op, _dest, srcs]);
      stagedContent = readFileSync(srcs[0]!, "utf8");
    };
    makeDnd72(ctx);
    feed("t=m", "text/uri-list");
    feed("t=M:x=1", "text/uri-list");
    feed("t=r:x=1:X=1", b64("file:///remote/a.txt"));
    feed("t=r:x=1");
    await settleUntil(() => tx.some((s) => s === "\x1b]72;t=r:x=1:y=1\x1b\\"));
    feed("t=r:x=1:y=1", b64("hello remote"));
    feed("t=r:x=1:y=1");
    await settleUntil(() => tx.some((s) => s === "\x1b]72;t=r:o=1\x1b\\"));
    expect(stagedContent).toBe("hello remote");
    expect(ctx.runTransfers.length).toBe(1);
    const stagedDir = path.dirname(ctx.runTransfers[0]![2][0]);
    expect(existsSync(stagedDir)).toBe(false); // staging cleaned
    expect(ctx.runTransfers[0]![2][0].endsWith("a.txt")).toBe(true);
  });

  test("chunked entry (m=1 + metadata-less continuation) reassembles", async () => {
    const { ctx, feed, tx } = baseCtx();
    let stagedContent = "";
    ctx.runTransfer = async (_op, _dest, srcs) => {
      ctx.runTransfers.push([_op, _dest, srcs]);
      stagedContent = readFileSync(srcs[0]!, "utf8");
    };
    makeDnd72(ctx);
    feed("t=m", "text/uri-list");
    feed("t=M:x=1", "text/uri-list");
    feed("t=r:x=1:X=1", b64("file:///remote/a.txt"));
    feed("t=r:x=1");
    await settleUntil(() => tx.some((s) => s === "\x1b]72;t=r:x=1:y=1\x1b\\"));
    const full = b64("hello chunked world");
    feed("t=r:x=1:y=1:m=1", full.slice(0, 8));
    feed("m=1", full.slice(8)); // continuation may omit all metadata but m
    feed("t=r:x=1:y=1");
    await settleUntil(() => tx.some((s) => s === "\x1b]72;t=r:o=1\x1b\\"));
    expect(stagedContent).toBe("hello chunked world");
  });

  test("same-basename remote entries stage without overwriting each other", async () => {
    const { ctx, feed, tx } = baseCtx();
    let staged: string[] = [];
    let bytes: string[] = [];
    ctx.runTransfer = async (_op, _dest, srcs) => {
      ctx.runTransfers.push([_op, _dest, srcs]);
      // capture inside the transfer — staging is cleaned right after it resolves
      staged = [...srcs];
      bytes = srcs.map((s: string) => readFileSync(s, "utf8")).sort();
    };
    makeDnd72(ctx);
    feed("t=m", "text/uri-list");
    feed("t=M:x=1", "text/uri-list");
    feed("t=r:x=1:X=1", b64("file:///remote/one/same.txt\r\nfile:///remote/two/same.txt"));
    feed("t=r:x=1");
    await settleUntil(() => tx.some((s) => s === "\x1b]72;t=r:x=1:y=1\x1b\\"));
    feed("t=r:x=1:y=1", b64("first-bytes"));
    feed("t=r:x=1:y=1");
    await settleUntil(() => tx.some((s) => s === "\x1b]72;t=r:x=1:y=2\x1b\\"));
    feed("t=r:x=1:y=2", b64("second-bytes"));
    feed("t=r:x=1:y=2");
    await settleUntil(() => ctx.runTransfers.length > 0);
    expect(staged.length).toBe(2);
    expect(new Set(staged).size).toBe(2); // distinct staged paths
    expect(bytes).toEqual(["first-bytes", "second-bytes"]);
  });

  test("duplicate child names inside one dir listing stage distinctly", async () => {
    const { ctx, feed, tx } = baseCtx();
    let kids: string[] = [];
    ctx.runTransfer = async (_op, _dest, srcs) => {
      ctx.runTransfers.push([_op, _dest, srcs]);
      kids = readdirSync(srcs[0]!);
    };
    makeDnd72(ctx);
    feed("t=m", "text/uri-list");
    feed("t=M:x=1", "text/uri-list");
    feed("t=r:x=1:X=1", b64("file:///remote/docs"));
    feed("t=r:x=1");
    await settleUntil(() => tx.some((s) => s === "\x1b]72;t=r:x=1:y=1\x1b\\"));
    const listing = Buffer.from("dup.txt\0dup.txt", "utf8").toString("base64").replace(/=+$/, "");
    feed("t=r:x=1:y=1:X=7", listing);
    feed("t=r:x=1:y=1");
    await settleUntil(() => tx.some((s) => s === "\x1b]72;t=r:Y=7:x=1\x1b\\"));
    feed("t=r:Y=7:x=1", b64("aaa"));
    feed("t=r:Y=7:x=1");
    await settleUntil(() => tx.some((s) => s === "\x1b]72;t=r:Y=7:x=2\x1b\\"));
    feed("t=r:Y=7:x=2", b64("bbb"));
    feed("t=r:Y=7:x=2");
    await settleUntil(() => ctx.runTransfers.length > 0);
    expect(kids.length).toBe(2);
    expect(new Set(kids).size).toBe(2);
  });

  test("symlink entry (X=1) stages a symlink with the remote target", async () => {
    const { ctx, feed, tx } = baseCtx();
    let wasLink = false;
    let target = "";
    ctx.runTransfer = async (_op, _dest, srcs) => {
      ctx.runTransfers.push([_op, _dest, srcs]);
      // capture inside the transfer — staging is cleaned right after it resolves
      wasLink = lstatSync(srcs[0]!).isSymbolicLink();
      target = readlinkSync(srcs[0]!);
    };
    makeDnd72(ctx);
    feed("t=m", "text/uri-list");
    feed("t=M:x=1", "text/uri-list");
    feed("t=r:x=1:X=1", b64("file:///remote/link"));
    feed("t=r:x=1");
    await settleUntil(() => tx.some((s) => s === "\x1b]72;t=r:x=1:y=1\x1b\\"));
    feed("t=r:x=1:y=1:X=1", b64("/remote/real-target"));
    feed("t=r:x=1:y=1");
    await settleUntil(() => ctx.runTransfers.length > 0);
    expect(wasLink).toBe(true);
    expect(target).toBe("/remote/real-target");
  });

  test("dir entry recurses children then releases the handle", async () => {
    const { ctx, feed, tx } = baseCtx();
    let first = "";
    let second = "";
    ctx.runTransfer = async (_op, _dest, srcs) => {
      ctx.runTransfers.push([_op, _dest, srcs]);
      // capture inside the transfer — staging is cleaned right after it resolves
      first = readFileSync(path.join(srcs[0]!, "a.txt"), "utf8");
      second = readFileSync(path.join(srcs[0]!, "b.txt"), "utf8");
    };
    makeDnd72(ctx);
    feed("t=m", "text/uri-list");
    feed("t=M:x=1", "text/uri-list");
    feed("t=r:x=1:X=1", b64("file:///remote/docs"));
    feed("t=r:x=1");
    await settleUntil(() => tx.some((s) => s === "\x1b]72;t=r:x=1:y=1\x1b\\"));
    const listing = Buffer.from("a.txt\0b.txt", "utf8").toString("base64").replace(/=+$/, "");
    feed("t=r:x=1:y=1:X=7", listing);
    feed("t=r:x=1:y=1");
    await settleUntil(() => tx.some((s) => s === "\x1b]72;t=r:Y=7:x=1\x1b\\"));
    feed("t=r:Y=7:x=1", b64("first"));
    feed("t=r:Y=7:x=1");
    await settleUntil(() => tx.some((s) => s === "\x1b]72;t=r:Y=7:x=2\x1b\\"));
    feed("t=r:Y=7:x=2", b64("second"));
    feed("t=r:Y=7:x=2");
    await settleUntil(() => ctx.runTransfers.length > 0);
    expect(first).toBe("first");
    expect(second).toBe("second");
    expect(tx.some((s) => s === "\x1b]72;t=r:Y=7\x1b\\")).toBe(true); // handle released
    expect(tx.some((s) => s === "\x1b]72;t=r:o=1\x1b\\")).toBe(true);
  });

  test("t=R aborts with an error toast, cancel frame, no transfer", async () => {
    const { ctx, feed, notes, tx } = baseCtx();
    makeDnd72(ctx);
    feed("t=m", "text/uri-list");
    feed("t=M:x=1", "text/uri-list");
    feed("t=r:x=1:X=1", b64("file:///remote/a.txt"));
    feed("t=r:x=1");
    await settleUntil(() => tx.some((s) => s === "\x1b]72;t=r:x=1:y=1\x1b\\"));
    feed("t=R:x=1:y=1", "ENOENT:gone");
    await settleUntil(() => notes.some((n) => n.includes("ENOENT")));
    expect(ctx.runTransfers).toEqual([]);
    expect(tx.some((s) => s === "\x1b]72;t=r:o=0\x1b\\")).toBe(true);
  });

  test("request timeout aborts and cleans staging", async () => {
    const { ctx, feed, notes, tx } = baseCtx();
    ctx.remoteTimeoutMs = () => 50;
    // only this module stages tfm-remote-* dirs — snapshot before/after
    const stagedBefore = new Set(readdirSync(os.tmpdir()).filter((n) => n.startsWith("tfm-remote-")));
    makeDnd72(ctx);
    feed("t=m", "text/uri-list");
    feed("t=M:x=1", "text/uri-list");
    feed("t=r:x=1:X=1", b64("file:///remote/a.txt"));
    feed("t=r:x=1");
    await settleUntil(() => tx.some((s) => s === "\x1b]72;t=r:x=1:y=1\x1b\\"));
    // never answer — the 50ms timer fires
    await settleUntil(() => notes.length > 0, 3000);
    expect(ctx.runTransfers).toEqual([]);
    expect(tx.some((s) => s === "\x1b]72;t=r:o=0\x1b\\")).toBe(true);
    const leaked = readdirSync(os.tmpdir()).filter((n) => n.startsWith("tfm-remote-") && !stagedBefore.has(n));
    expect(leaked).toEqual([]);
  });

  test("keyless first chunk defaults to file (spec-violating peer)", async () => {
    const { ctx, feed, tx } = baseCtx();
    let stagedContent = "";
    ctx.runTransfer = async (_op, _dest, srcs) => {
      ctx.runTransfers.push([_op, _dest, srcs]);
      stagedContent = readFileSync(srcs[0]!, "utf8");
    };
    makeDnd72(ctx);
    feed("t=m", "text/uri-list");
    feed("t=M:x=1", "text/uri-list");
    feed("t=r:x=1:X=1", b64("file:///remote/a.txt"));
    feed("t=r:x=1");
    await settleUntil(() => tx.some((s) => s === "\x1b]72;t=r:x=1:y=1\x1b\\"));
    feed("m=1", b64("peer skips keys")); // first chunk carries no X at all
    feed("t=r:x=1:y=1"); // EOF
    await settleUntil(() => tx.some((s) => s === "\x1b]72;t=r:o=1\x1b\\"));
    expect(stagedContent).toBe("peer skips keys");
  });

  test("byte cap counts decoded bytes, not b64 chars", async () => {
    const { ctx, feed, tx } = baseCtx();
    // 25 decoded bytes = 34 b64 chars: trips a 30-char count, fits a 30-byte cap
    ctx.remoteMaxBytes = () => 30;
    makeDnd72(ctx);
    feed("t=m", "text/uri-list");
    feed("t=M:x=1", "text/uri-list");
    feed("t=r:x=1:X=1", b64("file:///remote/a.txt"));
    feed("t=r:x=1");
    await settleUntil(() => tx.some((s) => s === "\x1b]72;t=r:x=1:y=1\x1b\\"));
    feed("t=r:x=1:y=1", b64("1234567890123456789012345"));
    feed("t=r:x=1:y=1");
    await settleUntil(() => tx.some((s) => s === "\x1b]72;t=r:o=1\x1b\\"));
    expect(ctx.runTransfers.length).toBe(1);
  });

  test("staging creation failure cancels loudly, not silently", async () => {
    const { ctx, feed, notes, tx } = baseCtx();
    const oldTmp = process.env.TMPDIR;
    process.env.TMPDIR = "/nonexistent-tfm-tmpdir-xyz";
    try {
      makeDnd72(ctx);
      feed("t=m", "text/uri-list");
      feed("t=M:x=1", "text/uri-list");
      feed("t=r:x=1:X=1", b64("file:///remote/a.txt"));
      feed("t=r:x=1");
      await settleUntil(() => notes.length > 0);
      expect(ctx.runTransfers).toEqual([]);
      expect(tx.some((s) => s === "\x1b]72;t=r:o=0\x1b\\")).toBe(true); // cancel, not silence
    } finally {
      if (oldTmp === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = oldTmp;
    }
  });

  test("DropLeave mid-fetch aborts silently (no toast)", async () => {
    const { ctx, feed, notes, tx } = baseCtx();
    makeDnd72(ctx);
    feed("t=m", "text/uri-list");
    feed("t=M:x=1", "text/uri-list");
    feed("t=r:x=1:X=1", b64("file:///remote/a.txt"));
    feed("t=r:x=1");
    await settleUntil(() => tx.some((s) => s === "\x1b]72;t=r:x=1:y=1\x1b\\"));
    feed("t=m:x=-1:y=-1");
    await Bun.sleep(100);
    expect(ctx.runTransfers).toEqual([]);
    expect(notes).toEqual([]);
    expect(tx.some((s) => s === "\x1b]72;t=r:o=0\x1b\\")).toBe(true);
  });

  test("second t=M while a remote fetch runs is refused (no agree)", async () => {
    const { ctx, feed, tx } = baseCtx();
    makeDnd72(ctx);
    feed("t=m", "text/uri-list");
    feed("t=M:x=1", "text/uri-list");
    feed("t=r:x=1:X=1", b64("file:///remote/a.txt"));
    feed("t=r:x=1");
    await settleUntil(() => tx.some((s) => s === "\x1b]72;t=r:x=1:y=1\x1b\\"));
    const agrees = tx.filter((s) => s.startsWith("\x1b]72;t=m:o=1")).length;
    feed("t=M:x=1", "text/uri-list"); // second drop while fetching
    await Bun.sleep(100);
    expect(tx.filter((s) => s.startsWith("\x1b]72;t=m:o=1")).length).toBe(agrees);
    gridDrag.keys = null;
  });

  test("dotdot top-level entry aborts before any subidx request", async () => {
    const { ctx, feed, notes, tx } = baseCtx();
    makeDnd72(ctx);
    feed("t=m", "text/uri-list");
    feed("t=M:x=1", "text/uri-list");
    feed("t=r:x=1:X=1", b64("file:///.."));
    feed("t=r:x=1");
    await settleUntil(() => notes.length > 0);
    expect(tx.some((s) => s.includes(":y="))).toBe(false); // never fetched
    expect(ctx.runTransfers).toEqual([]);
    expect(tx.some((s) => s === "\x1b]72;t=r:o=0\x1b\\")).toBe(true);
  });

  test("slashed dir-child name aborts before any child fetch", async () => {
    const { ctx, feed, notes, tx } = baseCtx();
    makeDnd72(ctx);
    feed("t=m", "text/uri-list");
    feed("t=M:x=1", "text/uri-list");
    feed("t=r:x=1:X=1", b64("file:///remote/docs"));
    feed("t=r:x=1");
    await settleUntil(() => tx.some((s) => s === "\x1b]72;t=r:x=1:y=1\x1b\\"));
    const listing = Buffer.from("sub/evil", "utf8").toString("base64").replace(/=+$/, "");
    feed("t=r:x=1:y=1:X=7", listing);
    feed("t=r:x=1:y=1");
    await settleUntil(() => notes.length > 0);
    expect(tx.some((s) => s.includes(":Y=7"))).toBe(false); // no child fetched
    expect(ctx.runTransfers).toEqual([]);
    expect(tx.some((s) => s === "\x1b]72;t=r:o=0\x1b\\")).toBe(true);
  });

  test("virtual cwd refuses a remote drop before any subidx request", async () => {
    const { ctx, feed, notes, tx } = baseCtx();
    ctx.virtualCwd = () => true;
    makeDnd72(ctx);
    feed("t=m", "text/uri-list");
    feed("t=M:x=1", "text/uri-list");
    feed("t=r:x=1:X=1", b64("file:///remote/a.txt"));
    feed("t=r:x=1");
    await settleUntil(() => notes.length > 0);
    expect(tx.some((s) => s.includes(":y="))).toBe(false);
    expect(ctx.runTransfers).toEqual([]);
  });

  test("oversize staged bytes abort the drop (remoteMaxBytes seam)", async () => {
    const { ctx, feed, notes, tx } = baseCtx();
    ctx.remoteMaxBytes = () => 10;
    makeDnd72(ctx);
    feed("t=m", "text/uri-list");
    feed("t=M:x=1", "text/uri-list");
    feed("t=r:x=1:X=1", b64("file:///remote/a.txt"));
    feed("t=r:x=1");
    await settleUntil(() => tx.some((s) => s === "\x1b]72;t=r:x=1:y=1\x1b\\"));
    feed("t=r:x=1:y=1", b64("way more than ten bytes of content"));
    feed("t=r:x=1:y=1");
    await settleUntil(() => notes.length > 0);
    expect(ctx.runTransfers).toEqual([]);
    expect(tx.some((s) => s === "\x1b]72;t=r:o=0\x1b\\")).toBe(true);
  });

  test("local uri-list completion (X absent) still transfers", async () => {
    const { ctx, feed } = baseCtx();
    makeDnd72(ctx);
    feed("t=m", "text/uri-list");
    feed("t=M:x=1", "text/uri-list");
    feed("t=r:x=1", b64("file:///home/u/a.txt"));
    feed("t=r:x=1");
    await settleUntil(() => ctx.runTransfers.length > 0);
    expect(ctx.runTransfers.length).toBe(1);
  });
});

describe("external drag end", () => {
  test("released over another app (copy) notifies Sent", async () => {
    const { ctx, feed, notes } = baseCtx();
    makeDnd72(ctx);
    gridDrag.keys = [{ path: "/d/a", isDir: false }];
    feed("t=o:x=1:y=1");
    feed("t=e:x=4:y=0"); // end, not canceled, no self drop handled
    await settleUntil(() => notes.some((n) => n.includes("Sent 1 item")), 3000); // 700ms-deferred epilogue
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

describe("remote serve (t=k)", () => {
  const serveDir = (): string => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "tfm-serve-"));
    writeFileSync(path.join(dir, "a.txt"), "serve-bytes");
    writeFileSync(path.join(dir, "big.bin"), Buffer.alloc(4000, 7));
    mkdirSync(path.join(dir, "sub"));
    writeFileSync(path.join(dir, "sub", "inner.txt"), "inner");
    symlinkSync(path.join(dir, "a.txt"), path.join(dir, "link"));
    return dir;
  };

  // payload of a serve frame (text after the second ";", minus ST; "" when the
  // frame carries no payload, e.g. the trailing m=0 EOF marker)
  const payloadOf = (f: string): string => {
    const first = f.indexOf(";");
    const second = f.indexOf(";", first + 1);
    return second < 0 ? "" : f.slice(second + 1, -2);
  };

  test("t=k:x=1 serves file bytes + EOF", () => {
    const dir = serveDir();
    try {
      const { ctx, feed, tx } = baseCtx();
      makeDnd72(ctx);
      gridDrag.ctrl = false;
      gridDrag.keys = [{ path: path.join(dir, "a.txt"), isDir: false }];
      feed("t=o:x=64:y=10");
      tx.length = 0;
      feed("t=k:x=1");
      const frames = tx.filter((s) => s.includes("t=k:x=1"));
      expect(frames.length).toBe(2); // data + empty EOF
      expect(Buffer.from(payloadOf(frames[0]!), "base64").toString("utf8")).toBe("serve-bytes");
      expect(payloadOf(frames[1]!)).toBe("");
      gridDrag.keys = null;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("out-of-range idx answers t=E", () => {
    const dir = serveDir();
    try {
      const { ctx, feed, tx } = baseCtx();
      makeDnd72(ctx);
      gridDrag.keys = [{ path: path.join(dir, "a.txt"), isDir: false }];
      feed("t=o:x=64:y=10");
      tx.length = 0;
      feed("t=k:x=5");
      expect(tx.some((s) => s.startsWith("\x1b]72;t=E;"))).toBe(true);
      gridDrag.keys = null;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("symlink serves X=1 + target, dir serves handle + children with Y", () => {
    const dir = serveDir();
    try {
      const { ctx, feed, tx } = baseCtx();
      makeDnd72(ctx);
      gridDrag.keys = [
        { path: path.join(dir, "link"), isDir: false },
        { path: path.join(dir, "sub"), isDir: true },
      ];
      feed("t=o:x=64:y=10");
      tx.length = 0;
      feed("t=k:x=1");
      const linkFrames = tx.filter((s) => s.includes("t=k:x=1"));
      expect(linkFrames[0]).toContain(":X=1:");
      expect(Buffer.from(payloadOf(linkFrames[0]!), "base64").toString("utf8")).toBe(path.join(dir, "a.txt"));
      tx.length = 0;
      feed("t=k:x=2");
      const dirFrames = tx.filter((s) => s.includes("t=k:x=2"));
      const handle = Number(/:X=(\d+)/.exec(dirFrames[0]!)![1]);
      expect(handle).toBeGreaterThan(1);
      expect(Buffer.from(payloadOf(dirFrames[0]!), "base64").toString("utf8")).toBe("inner.txt");
      // the child is pushed with Y=handle:y=num and its own bytes + EOF
      const childData = tx.find((s) => s.includes(`Y=${handle}:y=1`) && payloadOf(s) !== "");
      expect(Buffer.from(payloadOf(childData!), "base64").toString("utf8")).toBe("inner");
      gridDrag.keys = null;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("big file chunks at 4096 b64 chars and reassembles", () => {
    const dir = serveDir();
    try {
      const { ctx, feed, tx } = baseCtx();
      makeDnd72(ctx);
      gridDrag.keys = [{ path: path.join(dir, "big.bin"), isDir: false }];
      feed("t=o:x=64:y=10");
      tx.length = 0;
      feed("t=k:x=1");
      const frames = tx.filter((s) => s.includes("t=k:x=1"));
      expect(frames.length).toBeGreaterThan(2);
      expect(payloadOf(frames[0]!).length).toBe(4096);
      expect(frames[0]).toContain(":m=1;");
      const bytes = Buffer.concat(frames.slice(0, -1).map((f) => Buffer.from(payloadOf(f), "base64")));
      expect(bytes.equals(Buffer.alloc(4000, 7))).toBe(true);
      expect(payloadOf(frames[frames.length - 1]!)).toBe(""); // EOF
      gridDrag.keys = null;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("vanished file answers t=E;ENOENT", () => {
    const { ctx, feed, tx } = baseCtx();
    makeDnd72(ctx);
    gridDrag.keys = [{ path: "/nonexistent-tfm-serve-target", isDir: false }];
    feed("t=o:x=64:y=10");
    tx.length = 0;
    feed("t=k:x=1");
    expect(tx.some((s) => s.startsWith("\x1b]72;t=E;ENOENT"))).toBe(true);
    gridDrag.keys = null;
  });

  test("t=k with no session is ignored", () => {
    const { ctx, feed, tx, notes } = baseCtx();
    makeDnd72(ctx);
    feed("t=k:x=1");
    expect(tx).toEqual([]);
    expect(notes).toEqual([]);
  });

  test("dragged dir uri-list ends the dir URL with /", () => {
    const dir = serveDir();
    try {
      const { ctx, feed, tx } = baseCtx();
      makeDnd72(ctx);
      gridDrag.keys = [{ path: path.join(dir, "sub"), isDir: true }];
      feed("t=o:x=64:y=10");
      const present = tx.find((s) => s.includes("t=p:x=0:m=0;"))!;
      const uriList = Buffer.from(payloadOf(present), "base64").toString("utf8");
      expect(uriList.endsWith("/")).toBe(true);
      gridDrag.keys = null;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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

  test("E with an OK payload is the start-drag ack, not an error", () => {
    // kitty answers our StartDrag with `E:OK` ~5ms after every ACCEPTED drag
    // and the session continues normally — it must stay silent
    const { ctx, feed, notes, status } = baseCtx();
    makeDnd72(ctx);
    gridDrag.ctrl = false;
    gridDrag.keys = [{ path: "/d/a", isDir: false }];
    feed("t=o:x=64:y=10");
    feed("t=E", "OK");
    expect(notes).toEqual([]);
    expect(status).toEqual(["Dragging 1 item — drop into another app or a folder"]);
    gridDrag.keys = null;
  });
});

describe("payload length", () => {
  test("present frame carries the unpadded b64 uri-list", () => {
    const paths = ["/a b.txt"];
    expect(uriListPayload(paths)).not.toContain("=");
  });
});
