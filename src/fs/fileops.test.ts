import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, existsSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { makeFileOps, type FileOpsCtx } from "./fileops";

// runTransfer is the only path copies/moves take — these tests pin the wiring:
// same-fs move = plain rename (no toast), cross-device move = copy engine +
// toast + source removal, and cancel mid-copy never leaves partials behind.
// crossDevice is injectable precisely so tests can fake the device split.

// mkdtemp only creates the last segment — the parent must be a dir that
// exists everywhere (CI runners choke on a hardcoded /tmp/opencode)
const mktmp = (prefix: string): string => mkdtempSync(path.join(os.tmpdir(), prefix));
const ROOT = mktmp("tfm-fileops-");
const HOME = ROOT;

afterAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

const W = (p: string, s = "x") => {
  mkdirSync(path.dirname(p), { recursive: true });
  writeFileSync(p, s);
};

const makeHarness = (over: Partial<FileOpsCtx> = {}) => {
  const calls: string[] = [];
  const prog = {
    active: false,
    verb: "copying",
    doneFiles: 0,
    totalFiles: 1,
    bytes: 0,
    totalBytes: 0,
    paused: false,
    cancelled: false,
    currentRs: null,
    toastUp: false,
  };
  const ctx: FileOpsCtx = {
    conflict: {
      resetPolicy: () => calls.push("policy:reset"),
      policy: () => null,
      promptConflict: async () => {
        calls.push("conflict:prompt");
        return "skip" as const;
      },
    },
    prog,
    paintProgress: () => calls.push("paint"),
    showProgressToast: () => {
      prog.toastUp = true;
      calls.push("toast:show");
    },
    finishProgressToast: (msg) => {
      prog.toastUp = false;
      calls.push(`toast:finish:${msg}`);
    },
    pauseGate: async () => {},
    pushUndoBatch: (label, units, redos) => calls.push(`undo:${label}:${units.length}:${redos.length}`),
    renderAll: () => calls.push("renderAll"),
    setStatusMsg: (msg) => calls.push(`status:${msg}`),
    notify: (_msg, title) => calls.push(`notify:${title ?? ""}`),
    home: HOME,
    refreshCutVisuals: () => calls.push("cut"),
    log: () => {},
    ...over,
  };
  const ops = makeFileOps(ctx);
  return { ops, ctx, calls, prog };
};

// 6 files keeps the transfer past the shouldToast threshold (totalFiles > 4)
const seedTree = (dir: string): void => {
  for (let i = 1; i <= 6; i++) W(path.join(dir, `f${i}.txt`), `content-${i}`);
};

describe("runTransfer: same-fs move", () => {
  test("plain rename — no progress toast, undo batch covers the move", async () => {
    const h = makeHarness();
    const src = path.join(ROOT, "samefs-a");
    const destDir = path.join(ROOT, "samefs-b");
    seedTree(src);
    mkdirSync(destDir, { recursive: true });

    await h.ops.runTransfer("move", destDir, [src], "move to samefs-b");

    expect(existsSync(src)).toBe(false);
    expect(readFileSync(path.join(destDir, "samefs-a", "f1.txt"), "utf8")).toBe("content-1");
    // instant renames don't need a toast
    expect(h.calls).not.toContain("toast:show");
    expect(h.calls.some((c) => c.startsWith("undo:move to samefs-b:1:"))).toBe(true);
  });
});

describe("runTransfer: cross-device move", () => {
  const fakeSplit = (a: string, b: string): boolean => a.includes("dev-a") !== b.includes("dev-a");

  test("goes through the copy engine with a toast, then removes the source", async () => {
    const h = makeHarness({ crossDevice: fakeSplit });
    const src = path.join(ROOT, "dev-a", "tree");
    const destDir = path.join(ROOT, "dev-b");
    seedTree(src);
    mkdirSync(destDir, { recursive: true });

    await h.ops.runTransfer("move", destDir, [src], "move to dev-b");

    // copy+delete semantics: content arrived, source tree is gone
    expect(readFileSync(path.join(destDir, "tree", "f1.txt"), "utf8")).toBe("content-1");
    expect(existsSync(src)).toBe(false);
    expect(h.calls).toContain("toast:show");
    expect(h.calls.some((c) => c.startsWith("undo:move to dev-b:1:"))).toBe(true);
    expect(h.prog.verb).toBe("moving");
  });

  test("cancel mid-copy: partial target cleaned, source intact, reported as cancelled", async () => {
    const h = makeHarness({
      crossDevice: fakeSplit,
      // first progress repaint (during file 1's copy) flips the cancel flag —
      // the next checkpoint/epilogue sees it, no timing games needed
      paintProgress: () => {
        h.prog.cancelled = true;
      },
    });
    const src = path.join(ROOT, "dev-a", "cancel-tree");
    const destDir = path.join(ROOT, "dev-b-cancel");
    seedTree(src);
    mkdirSync(destDir, { recursive: true });

    await h.ops.runTransfer("move", destDir, [src], "move to dev-b-cancel");

    // cancelled move = nothing moved: source untouched, copy dropped
    expect(existsSync(path.join(src, "f1.txt"))).toBe(true);
    expect(existsSync(src)).toBe(true);
    expect(existsSync(path.join(destDir, "cancel-tree"))).toBe(false);
    expect(h.calls).toContain("toast:finish:✗ Moved cancelled");
    expect(h.calls).toContain("notify:move cancelled");
  });

  test("copy op unaffected: still streams with the toast (control)", async () => {
    const h = makeHarness();
    const src = path.join(ROOT, "copy-src");
    const destDir = path.join(ROOT, "copy-dest");
    seedTree(src);
    mkdirSync(destDir, { recursive: true });

    await h.ops.runTransfer("copy", destDir, [src], "paste");

    expect(readFileSync(path.join(destDir, "copy-src", "f1.txt"), "utf8")).toBe("content-1");
    expect(existsSync(path.join(src, "f1.txt"))).toBe(true);
    expect(h.calls).toContain("toast:show");
  });
});
