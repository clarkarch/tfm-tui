import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  WriteStream,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { copyFileProgress, copyTreeProgress, rmTreeProgress, scanTree, type TransferSink } from "./transfer";

// mkdtemp only creates the last segment — the parent must be a dir that
// exists everywhere (CI runners choke on a hardcoded /tmp/opencode)
const mktmp = (prefix: string): string => mkdtempSync(path.join(os.tmpdir(), prefix));

const mkSink = (opts: { pauseAfterBytes?: number; cancelAfterFiles?: number } = {}) => {
  const log: string[] = [];
  let bytes = 0;
  let files = 0;
  let paused = false;
  let cancelled = false;
  const sink: TransferSink = {
    checkpoint: async () => {
      while (paused) await new Promise((r) => setTimeout(r, 5));
      if (cancelled) throw new Error("cancelled");
    },
    paused: () => paused,
    cancelled: () => cancelled,
    addBytes: (n) => {
      bytes += n;
    },
    fileDone: () => {
      files++;
      log.push(`file#${files}`);
      if (opts.cancelAfterFiles !== undefined && files >= opts.cancelAfterFiles) cancelled = true;
    },
    setStream: (_rs) => log.push(`open`),
    clearStream: (_rs) => log.push(`close`),
    repaint: () => {},
  };
  return {
    sink,
    log,
    get bytes() {
      return bytes;
    },
    get files() {
      return files;
    },
    setPaused: (v: boolean) => {
      paused = v;
    },
  };
};

let dir: string;
beforeEach(() => {
  dir = mktmp("tfm-transfer-");
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const W = (p: string, s: string) => {
  mkdirSync(path.dirname(p), { recursive: true });
  writeFileSync(p, s);
};

describe("scanTree", () => {
  test("counts files and bytes recursively", async () => {
    W(path.join(dir, "a.txt"), "12345");
    W(path.join(dir, "sub", "b.txt"), "123456");
    const r = await scanTree(dir);
    expect(r.files).toBe(2);
    expect(r.bytes).toBe(11);
  });

  test("lstat semantics: symlinks count once by their own footprint, never followed", async () => {
    W(path.join(dir, "real.txt"), "hello");
    symlinkSync(path.join(dir, "real.txt"), path.join(dir, "link.txt"));
    symlinkSync("/definitely/nowhere", path.join(dir, "dangling"));
    const r = await scanTree(dir);
    expect(r.files).toBe(3); // real + 2 links; target counted once, no cycle
  });

  test("unreadable entries are skipped, not fatal", async () => {
    W(path.join(dir, "ok.txt"), "x");
    const r = await scanTree(path.join(dir, "does-not-exist"));
    expect(r).toEqual({ files: 0, bytes: 0 });
  });

  test("onTick reports every 100th file (Preparing counter)", async () => {
    for (let i = 0; i < 105; i++) W(path.join(dir, `f${i}`), "x");
    const ticks: number[] = [];
    const r = await scanTree(dir, (n) => ticks.push(n));
    expect(r.files).toBe(105);
    expect(ticks).toEqual([100]);
  });
});

describe("copyFileProgress", () => {
  test("streams content and reports bytes through the sink", async () => {
    const src = path.join(dir, "in.bin");
    const dest = path.join(dir, "out.bin");
    writeFileSync(src, "0123456789");
    const h = mkSink();
    await copyFileProgress(src, dest, h.sink);
    expect(readFileSync(dest, "utf8")).toBe("0123456789");
    expect(h.bytes).toBe(10);
    expect(h.log[0]).toBe("open");
    expect(h.log.at(-1)).toBe("close");
  });

  test("mid-stream cancel destroys the write stream (no leaked fd / disk blocks)", async () => {
    // the cancel path used to destroy only the read stream: the write stream
    // stayed open while the tmp/dest cleanup unlinked the partial file —
    // allocated blocks lingered until a GC finalizer bun may never run
    const src = path.join(dir, "in.bin");
    const dest = path.join(dir, "out.bin");
    writeFileSync(src, "0123456789".repeat(64));
    const h = mkSink();
    h.sink.cancelled = () => true; // cancel on the very first data chunk
    const spy = spyOn(WriteStream.prototype, "destroy");
    let caught: unknown = null;
    try {
      await copyFileProgress(src, dest, h.sink);
    } catch (err) {
      caught = err;
    }
    expect((caught as Error)?.message).toBe("cancelled");
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  test("lands atomically: no half-visible dest, no tmp orphans left behind", async () => {
    const src = path.join(dir, "atomic.bin");
    const dest = path.join(dir, "atomic-out.bin");
    writeFileSync(src, "0123456789");
    const h = mkSink();
    await copyFileProgress(src, dest, h.sink);
    const leftovers = readdirSync(dir).filter((f) => f.includes(".tfm-part-"));
    expect(leftovers).toEqual([]);
    expect(readFileSync(dest, "utf8")).toBe("0123456789");
  });

  test("preserves mode and mtime from the source", async () => {
    const src = path.join(dir, "meta.txt");
    const dest = path.join(dir, "meta-out.txt");
    writeFileSync(src, "meta");
    const { chmodSync, utimesSync } = await import("node:fs");
    chmodSync(src, 0o640);
    const atime = new Date("2020-01-02T03:04:05Z");
    const mtime = new Date("2021-06-07T08:09:10Z");
    utimesSync(src, atime, mtime);
    const h = mkSink();
    await copyFileProgress(src, dest, h.sink);
    const st = lstatSync(dest);
    expect(st.mode & 0o777).toBe(0o640);
    expect(Math.floor(st.mtimeMs / 1000)).toBe(Math.floor(mtime.getTime() / 1000));
  });

  test("failed copy leaves neither dest nor tmp orphan", async () => {
    const h = mkSink();
    await expect(copyFileProgress(path.join(dir, "missing-src"), path.join(dir, "nope.bin"), h.sink)).rejects.toThrow();
    expect(readdirSync(dir).filter((f) => f.includes(".tfm-part-") || f === "nope.bin")).toEqual([]);
  });
});

describe("copyTreeProgress", () => {
  test("copies nested trees with contents intact", async () => {
    W(path.join(dir, "src", "a.txt"), "A");
    W(path.join(dir, "src", "deep", "b.txt"), "B");
    symlinkSync(path.join(dir, "src", "a.txt"), path.join(dir, "src", "lnk"));
    const h = mkSink();
    await copyTreeProgress(path.join(dir, "src"), path.join(dir, "dst"), h.sink);
    expect(readFileSync(path.join(dir, "dst", "a.txt"), "utf8")).toBe("A");
    expect(readFileSync(path.join(dir, "dst", "deep", "b.txt"), "utf8")).toBe("B");
    // symlink recreated as a link, not materialized into target content
    expect(lstatSync(path.join(dir, "dst", "lnk")).isSymbolicLink()).toBe(true);
    expect(h.files).toBe(3); // a.txt + b.txt + link all count as done entries
  });

  test("checkpoint throw (cancel) aborts the walk with a rejected promise", async () => {
    W(path.join(dir, "src", "a.txt"), "A");
    W(path.join(dir, "src", "b.txt"), "B");
    const h = mkSink({ cancelAfterFiles: 1 });
    let caught: unknown = null;
    try {
      await copyTreeProgress(path.join(dir, "src"), path.join(dir, "dst"), h.sink);
    } catch (err) {
      caught = err;
    }
    expect((caught as Error)?.message).toBe("cancelled"); // same contract runTransfer catches per-source
    expect(h.files).toBe(1);
    // readdir order is fs-dependent, so exactly one file landed — never both
    expect(readdirSync(path.join(dir, "dst")).filter((f) => f.endsWith(".txt")).length).toBe(1);
  });

  test("pause gate holds mid-walk and resumes", async () => {
    W(path.join(dir, "src", "a.txt"), "A");
    const h = mkSink();
    h.setPaused(true);
    const p = copyTreeProgress(path.join(dir, "src"), path.join(dir, "dst"), h.sink);
    let done = false;
    void p.then(() => {
      done = true;
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(done).toBe(false); // still gated
    h.setPaused(false);
    await p;
    expect(readFileSync(path.join(dir, "dst", "a.txt"), "utf8")).toBe("A");
  });
});

describe("rmTreeProgress", () => {
  test("removes nested trees, counting files/bytes like scanTree", async () => {
    W(path.join(dir, "t", "a.txt"), "AAA");
    W(path.join(dir, "t", "deep", "b.txt"), "BB");
    const h = mkSink();
    await rmTreeProgress(path.join(dir, "t"), h.sink);
    expect(existsSync(path.join(dir, "t"))).toBe(false);
    expect(h.files).toBe(2);
    expect(h.bytes).toBe(5);
  });

  test("a symlink is unlinked, never followed into its target", async () => {
    W(path.join(dir, "real", "keep.txt"), "keep");
    symlinkSync(path.join(dir, "real"), path.join(dir, "link"));
    const h = mkSink();
    await rmTreeProgress(path.join(dir, "link"), h.sink);
    expect(existsSync(path.join(dir, "link"))).toBe(false);
    expect(readFileSync(path.join(dir, "real", "keep.txt"), "utf8")).toBe("keep");
    expect(h.files).toBe(1); // the link itself counts once, target untouched
  });

  test("cancel after the first file throws cancelled and leaves the rest", async () => {
    W(path.join(dir, "t", "a.txt"), "A");
    W(path.join(dir, "t", "b.txt"), "B");
    const h = mkSink({ cancelAfterFiles: 1 });
    let caught: unknown = null;
    try {
      await rmTreeProgress(path.join(dir, "t"), h.sink);
    } catch (err) {
      caught = err;
    }
    expect((caught as Error)?.message).toBe("cancelled");
    expect(h.files).toBe(1);
    expect(existsSync(path.join(dir, "t"))).toBe(true);
    // readdir order is fs-dependent: exactly one of the two files survives
    expect(readdirSync(path.join(dir, "t")).length).toBe(1);
  });

  test("directory-only trees remove without counting files", async () => {
    mkdirSync(path.join(dir, "empty", "nested", "deep"), { recursive: true });
    const h = mkSink();
    await rmTreeProgress(path.join(dir, "empty"), h.sink);
    expect(existsSync(path.join(dir, "empty"))).toBe(false);
    expect(h.files).toBe(0);
    expect(h.bytes).toBe(0);
  });
});
