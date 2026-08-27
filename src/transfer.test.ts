import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { copyFileProgress, copyTreeProgress, scanTree, type TransferSink } from "./transfer";

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
    addBytes: (n) => { bytes += n; },
    fileDone: () => {
      files++;
      log.push(`file#${files}`);
      if (opts.cancelAfterFiles !== undefined && files >= opts.cancelAfterFiles) cancelled = true;
    },
    setStream: (rs) => log.push(`open`),
    clearStream: (rs) => log.push(`close`),
    repaint: () => {},
  };
  return {
    sink,
    log,
    get bytes() { return bytes; },
    get files() { return files; },
    setPaused: (v: boolean) => { paused = v; },
  };
};

let dir: string;
beforeEach(() => { dir = mkdtempSync("/tmp/opencode/tfm-transfer-"); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

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
    } catch (err) { caught = err; }
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
    void p.then(() => { done = true; });
    await new Promise((r) => setTimeout(r, 50));
    expect(done).toBe(false); // still gated
    h.setPaused(false);
    await p;
    expect(readFileSync(path.join(dir, "dst", "a.txt"), "utf8")).toBe("A");
  });
});
