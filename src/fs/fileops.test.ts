import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, existsSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { makeFileOps, type FileOpsCtx } from "./fileops";
import { trashDir } from "./fsutil";
import type { ArchiveRun, ToolSpec } from "./archive";
import type { ProgressState } from "../ui/ui-progress";
import { sharedPluginHooks } from "../lib/plugin-hooks";

// runTransfer is the only path copies/moves take — these tests pin the wiring:
// same-fs move = plain rename (no toast), cross-device move = copy engine +
// toast + source removal, and cancel mid-copy never leaves partials behind.
// crossDevice is injectable precisely so tests can fake the device split.

// mkdtemp only creates the last segment — the parent must be a dir that
// exists everywhere (CI runners choke on a hardcoded /tmp/opencode)
const mktmp = (prefix: string): string => mkdtempSync(path.join(os.tmpdir(), prefix));
const ROOT = mktmp("tfm-fileops-");
const HOME = ROOT;

// trash-path assertions sandbox $XDG_DATA_HOME (same pattern as
// trashops.test.ts) so no real Trash dir is ever touched
const oldDataHome = process.env.XDG_DATA_HOME;
const XDG_ROOT = mktmp("tfm-fileops-xdg-");
beforeAll(() => {
  process.env.XDG_DATA_HOME = path.join(XDG_ROOT, "data");
});
afterAll(() => {
  if (oldDataHome === undefined) delete process.env.XDG_DATA_HOME;
  else process.env.XDG_DATA_HOME = oldDataHome;
});

afterAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

const W = (p: string, s = "x") => {
  mkdirSync(path.dirname(p), { recursive: true });
  writeFileSync(p, s);
};

const makeHarness = (over: Partial<FileOpsCtx> = {}) => {
  const calls: string[] = [];
  const prog: ProgressState = {
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
    processCancel: null,
    processPause: null,
  };
  // mirror production: an empty batch is dropped, and the real closures are
  // captured so tests can EXECUTE undo (not just assert a recorded label)
  let lastUnits: Array<() => void | Promise<void>> = [];
  let lastRedos: Array<() => void | Promise<void>> = [];
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
    pushUndoBatch: (label, units, redos) => {
      if (!units.length) return;
      lastUnits = units;
      lastRedos = redos;
      calls.push(`undo:${label}:${units.length}:${redos.length}`);
    },
    renderAll: () => calls.push("renderAll"),
    notify: (msg, title, level) => calls.push(`notify:${title ?? ""}:${level ?? ""}:${msg}`),
    home: HOME,
    refreshCutVisuals: () => calls.push("cut"),
    log: () => {},
    ...over,
  };
  const ops = makeFileOps(ctx);
  return { ops, ctx, calls, prog, undoUnits: () => lastUnits, redoUnits: () => lastRedos };
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

  test("stale cancelled flag from a past toast never blocks the next plain move", async () => {
    // the toast's ✕ sets prog.cancelled=true; only toast-bearing transfers
    // reset it — so a later plain (non-progress) move broke on iteration 1
    // with "Moved 0 items" until some progress transfer happened to run
    const h = makeHarness();
    h.prog.cancelled = true;
    h.prog.paused = true;
    const src = path.join(ROOT, "stale-flag-src");
    const destDir = path.join(ROOT, "stale-flag-dest");
    W(src, "content");
    mkdirSync(destDir, { recursive: true });

    await h.ops.runTransfer("move", destDir, [src], "move after cancel");

    expect(existsSync(path.join(destDir, "stale-flag-src"))).toBe(true);
    expect(existsSync(src)).toBe(false);
    expect(h.calls.some((c) => c.startsWith("undo:move after cancel:"))).toBe(true);
  });

  test("sweeps crashed .tfm-extract-* staging before a transfer", async () => {
    const h = makeHarness();
    const destDir = path.join(ROOT, "sweep-dest");
    mkdirSync(destDir, { recursive: true });
    mkdirSync(path.join(destDir, ".tfm-extract-1234-ab12cd34"));
    const src = path.join(ROOT, "sweep-src.txt");
    W(src, "x");

    await h.ops.runTransfer("copy", destDir, [src], "paste");

    expect(existsSync(path.join(destDir, ".tfm-extract-1234-ab12cd34"))).toBe(false);
    expect(existsSync(path.join(destDir, "sweep-src.txt"))).toBe(true);
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
    expect(h.calls).toContain("toast:finish:✗ Move cancelled");
    expect(h.calls.some((c) => c.startsWith("notify:move cancelled:info:"))).toBe(true);
  });

  test("source-removal failure keeps the complete copy (no total loss)", async () => {
    const h = makeHarness({
      crossDevice: fakeSplit,
      removeTree: async () => {
        throw new Error("simulated partial rm failure");
      },
    });
    const src = path.join(ROOT, "dev-a", "rmfail-tree");
    const destDir = path.join(ROOT, "dev-b-rmfail");
    seedTree(src);
    mkdirSync(destDir, { recursive: true });

    await h.ops.runTransfer("move", destDir, [src], "move to dev-b-rmfail");

    // the ONE complete copy must survive the source-removal failure (the old
    // half-copy cleanup deleted it — total data loss on a partial rm(src))
    expect(readFileSync(path.join(destDir, "rmfail-tree", "f1.txt"), "utf8")).toBe("content-1");
    expect(existsSync(src)).toBe(true);
    expect(h.calls.some((c) => c.startsWith("notify:move failed:error:"))).toBe(true);
    expect(h.calls.some((c) => c.includes("source partially removed"))).toBe(true);
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

describe("runTransfer: self-drop and orphan-sweep guards", () => {
  test("copying a folder into itself is refused (no self-copy recursion)", async () => {
    const h = makeHarness();
    const src = path.join(ROOT, "self-src");
    seedTree(src);
    await h.ops.runTransfer("copy", src, [src], "paste into itself");
    // recursion would mkdir src/src and descend forever — completing with the
    // destination absent proves the guard fired
    expect(existsSync(path.join(src, "self-src"))).toBe(false);
    expect(readdirSync(src).sort()).toEqual(["f1.txt", "f2.txt", "f3.txt", "f4.txt", "f5.txt", "f6.txt"]);
    expect(h.calls.some((c) => c.includes("into itself"))).toBe(true);
  });

  test("copying a folder into its own subtree is refused too", async () => {
    const h = makeHarness();
    const src = path.join(ROOT, "self-sub-src");
    const sub = path.join(src, "sub");
    seedTree(src);
    mkdirSync(sub, { recursive: true });
    await h.ops.runTransfer("copy", sub, [src], "paste into subtree");
    expect(existsSync(path.join(sub, "self-sub-src"))).toBe(false);
    expect(h.calls.some((c) => c.includes("into itself"))).toBe(true);
  });

  test("moving a folder into itself is refused too", async () => {
    const h = makeHarness();
    const src = path.join(ROOT, "self-move");
    seedTree(src);
    await h.ops.runTransfer("move", src, [src], "move into itself");
    expect(existsSync(path.join(src, "self-move"))).toBe(false);
    expect(existsSync(src)).toBe(true);
  });

  test("orphan sweep removes only temp-shaped names, not user files", async () => {
    const h = makeHarness();
    const destDir = path.join(ROOT, "sweep-anchored");
    mkdirSync(destDir, { recursive: true });
    // real orphaned temps (pid + 8-char rand) get swept
    writeFileSync(path.join(destDir, "f.txt.tfm-part-1234-ab12cd34"), "x");
    mkdirSync(path.join(destDir, ".tfm-extract-5678-ef56gh78"));
    // user files that merely LOOK related must survive
    writeFileSync(path.join(destDir, "notes.tfm-part-2.md"), "keep me");
    mkdirSync(path.join(destDir, ".tfm-extract-backup"));
    const src = path.join(ROOT, "sweep-anchored-src.txt");
    W(src, "x");

    await h.ops.runTransfer("copy", destDir, [src], "paste");

    expect(existsSync(path.join(destDir, "f.txt.tfm-part-1234-ab12cd34"))).toBe(false);
    expect(existsSync(path.join(destDir, ".tfm-extract-5678-ef56gh78"))).toBe(false);
    expect(existsSync(path.join(destDir, "notes.tfm-part-2.md"))).toBe(true);
    expect(existsSync(path.join(destDir, ".tfm-extract-backup"))).toBe(true);
  });
});

describe("performBulkRename", () => {
  test("renames all pairs in ONE undo batch (undone as one step)", async () => {
    const h = makeHarness();
    const a = path.join(ROOT, "bulk-a.txt");
    const b = path.join(ROOT, "bulk-b.txt");
    W(a, "A");
    W(b, "B");
    await h.ops.performBulkRename([
      { from: a, to: path.join(ROOT, "bulk-A.txt") },
      { from: b, to: path.join(ROOT, "bulk-B.txt") },
    ]);
    expect(existsSync(path.join(ROOT, "bulk-A.txt"))).toBe(true);
    expect(existsSync(path.join(ROOT, "bulk-B.txt"))).toBe(true);
    expect(existsSync(a)).toBe(false);
    expect(h.calls).toContain("undo:rename 2 items:2:2");
    expect(h.calls).toContain("notify:rename:success:Renamed 2 items · ctrl+z to undo");
  });

  test("a vanished source is reported FAILED; the rest still land", async () => {
    const h = makeHarness();
    const good = path.join(ROOT, "bulk-good.txt");
    W(good, "x");
    await h.ops.performBulkRename([
      { from: good, to: path.join(ROOT, "bulk-good2.txt") },
      { from: path.join(ROOT, "bulk-gone.txt"), to: path.join(ROOT, "bulk-gone2.txt") },
    ]);
    expect(existsSync(path.join(ROOT, "bulk-good2.txt"))).toBe(true);
    expect(h.calls.some((c) => c.includes("1 FAILED (source gone)"))).toBe(true);
    expect(h.calls).toContain("undo:rename 1 item:1:1");
    expect(h.calls.some((c) => c.startsWith("notify:rename failed:error:"))).toBe(true);
  });

  test("no pairs reports Nothing to rename", async () => {
    const h = makeHarness();
    await h.ops.performBulkRename([]);
    expect(h.calls).toContain("notify:rename:info:Nothing to rename");
    expect(h.calls.some((c) => c.startsWith("undo:"))).toBe(false);
  });
});

describe("duplicate", () => {
  test("copies in place with (copy) naming, one undo batch", async () => {
    const h = makeHarness();
    const a = path.join(ROOT, "dup-a.txt");
    W(a, "A");
    await h.ops.duplicate([a]);
    const copy = path.join(ROOT, "dup-a (copy).txt");
    expect(readFileSync(copy, "utf8")).toBe("A");
    expect(existsSync(a)).toBe(true);
    expect(h.calls.some((c) => c.startsWith("undo:duplicate 1 item:1:"))).toBe(true);
    expect(h.calls.some((c) => c.startsWith("notify:copy:success:Copied 1 item"))).toBe(true);
  });

  test("overlapping calls collapse into one batch (ctrl+d spam guard)", async () => {
    const h = makeHarness();
    const a = path.join(ROOT, "dup-spam.txt");
    W(a, "x");
    await Promise.all([h.ops.duplicate([a]), h.ops.duplicate([a])]);
    expect(existsSync(path.join(ROOT, "dup-spam (copy).txt"))).toBe(true);
    expect(existsSync(path.join(ROOT, "dup-spam (copy 2).txt"))).toBe(false);
    expect(h.calls.filter((c) => c.startsWith("undo:duplicate 1 item:1:")).length).toBe(1);
  });

  test("selection spanning directories duplicates next to each source", async () => {
    const h = makeHarness();
    const one = path.join(ROOT, "dup-d1", "one.txt");
    const two = path.join(ROOT, "dup-d2", "two.txt");
    W(one, "1");
    W(two, "2");
    await h.ops.duplicate([one, two]);
    expect(existsSync(path.join(ROOT, "dup-d1", "one (copy).txt"))).toBe(true);
    expect(existsSync(path.join(ROOT, "dup-d2", "two (copy).txt"))).toBe(true);
    // one batch per directory — never a cross-dir flatten
    expect(h.calls.some((c) => c.startsWith("undo:duplicate 1 item:1:"))).toBe(true);
    expect(existsSync(path.join(ROOT, "dup-d1", "two (copy).txt"))).toBe(false);
  });
});

describe("onFileOp fan-out", () => {
  test("successful transfer reports a clean outcome (not a phantom success)", async () => {
    const seen: Array<{
      op: string;
      paths: string[];
      dest?: string;
      outcome?: { cancelled: boolean; failed: number };
    }> = [];
    const h = makeHarness({ onFileOp: (op, paths, dest, outcome) => seen.push({ op, paths, dest, outcome }) });
    const src = path.join(ROOT, "fanout-src");
    const destDir = path.join(ROOT, "fanout-dest");
    W(src, "content");
    mkdirSync(destDir, { recursive: true });

    await h.ops.runTransfer("copy", destDir, [src], "paste");

    expect(seen.length).toBe(1);
    expect(seen[0]!.op).toBe("copy");
    expect(seen[0]!.paths).toEqual([src]);
    expect(seen[0]!.dest).toBe(destDir);
    expect(seen[0]!.outcome).toEqual({ cancelled: false, failed: 0 });
  });

  test("cancelled transfer reports cancelled:true (never a fake success)", async () => {
    const seen: Array<{ outcome?: { cancelled: boolean; failed: number } }> = [];
    const h = makeHarness({
      crossDevice: (a, b) => a.includes("dev-a") !== b.includes("dev-a"),
      paintProgress: () => {
        h.prog.cancelled = true;
      },
      onFileOp: (_op, _paths, _dest, outcome) => seen.push({ outcome }),
    });
    const src = path.join(ROOT, "dev-a", "fanout-cancel-tree");
    const destDir = path.join(ROOT, "dev-b-fanout-cancel");
    seedTree(src);
    mkdirSync(destDir, { recursive: true });

    await h.ops.runTransfer("move", destDir, [src], "move cancelled");

    expect(seen.length).toBe(1);
    expect(seen[0]!.outcome?.cancelled).toBe(true);
  });

  test("failed rename reports failed:1", async () => {
    const seen: Array<{ op: string; outcome?: { cancelled: boolean; failed: number } }> = [];
    const h = makeHarness({ onFileOp: (op, _paths, _dest, outcome) => seen.push({ op, outcome }) });
    await h.ops.performRename(path.join(ROOT, "no-such-file.txt"), "renamed.txt");
    expect(seen.length).toBe(1);
    expect(seen[0]!.op).toBe("rename");
    expect(seen[0]!.outcome).toEqual({ cancelled: false, failed: 1 });
  });
});

describe("trash guards", () => {
  test("pasteSmart into Trash/files refuses with a status, moves nothing", () => {
    // dest-based (not view-based): pasting onto a real place while viewing
    // trash stays allowed — only the trash dir itself is refused, since
    // files landing there get no .trashinfo and become unrestorable
    const h = makeHarness();
    const src = path.join(ROOT, "paste-guard-src.txt");
    W(src, "keep me");
    h.ops.setClipboard("copy", [{ path: src, isDir: false }]);
    h.ops.pasteSmart(path.join(trashDir(), "files"));
    expect(h.calls).toContain("notify:paste:error:Can't paste into Trash");
    expect(h.calls.some((c) => c.startsWith("undo:"))).toBe(false);
    expect(existsSync(src)).toBe(true);
  });

  test("moveInto a trash dir refuses with a status, moves nothing", async () => {
    const h = makeHarness();
    const src = path.join(ROOT, "move-guard-src.txt");
    W(src, "keep me");
    const trashFiles = path.join(trashDir(), "files");
    await h.ops.moveInto(trashFiles, [{ path: src, isDir: false }]);
    expect(h.calls).toContain("notify:move:error:Can't move into Trash");
    expect(h.calls.some((c) => c.startsWith("undo:"))).toBe(false);
    expect(existsSync(src)).toBe(true);
    expect(existsSync(path.join(trashFiles, "move-guard-src.txt"))).toBe(false);
  });
});

describe("human-friendly statuses and labels", () => {
  test("performRename to the same name reports Name unchanged, no undo", async () => {
    const h = makeHarness();
    const src = path.join(ROOT, "same-name.txt");
    W(src, "keep me");
    await h.ops.performRename(src, "same-name.txt");
    expect(h.calls).toContain("notify:rename:info:Name unchanged");
    expect(h.calls.some((c) => c.startsWith("undo:"))).toBe(false);
    expect(existsSync(src)).toBe(true);
  });

  test("performRename success names both ends in status and notify", async () => {
    const h = makeHarness();
    const src = path.join(ROOT, "old-name.txt");
    W(src, "data");
    await h.ops.performRename(src, "new-name.txt");
    expect(h.calls).toContain("notify:rename:success:Renamed old-name.txt → new-name.txt · ctrl+z to undo");
    expect(h.calls.some((c) => c.startsWith("undo:rename old-name.txt → new-name.txt:1:"))).toBe(true);
  });

  test("moveInto a dir into itself reports Already here, no transfer", async () => {
    const h = makeHarness();
    const dir = path.join(ROOT, "self-drop");
    mkdirSync(dir, { recursive: true });
    await h.ops.moveInto(dir, [{ path: dir, isDir: true }]);
    expect(h.calls).toContain("notify:move:info:Already here");
    expect(h.calls.some((c) => c.startsWith("undo:"))).toBe(false);
  });

  test("runTransfer with nothing to do reports it instead of Moved 0 items", async () => {
    const h = makeHarness();
    await h.ops.runTransfer("move", ROOT, [], "move 0 items");
    await h.ops.runTransfer("copy", ROOT, [], "paste 0 items");
    expect(h.calls).toContain("notify:move:info:Nothing to move");
    expect(h.calls).toContain("notify:copy:info:Nothing to copy");
    expect(h.calls.some((c) => c.startsWith("undo:"))).toBe(false);
  });

  test("setClipboard stages (not done): Copy/Cut … · paste to complete", () => {
    const h = makeHarness();
    h.ops.setClipboard("copy", [
      { path: "/a", isDir: false },
      { path: "/b", isDir: false },
    ]);
    expect(h.calls).toContain("notify:copy:info:Copy 2 items · paste to complete");
    h.ops.setClipboard("cut", [{ path: "/a", isDir: false }]);
    expect(h.calls).toContain("notify:cut:info:Cut 1 item · paste to complete");
  });

  test("re-staging the identical clipboard stays silent (autorepeat coalesces)", () => {
    const h = makeHarness();
    const items = [
      { path: "/a", isDir: false },
      { path: "/b", isDir: false },
    ];
    h.ops.setClipboard("copy", items);
    h.ops.setClipboard("copy", items);
    expect(h.calls.filter((c) => c.startsWith("notify:copy:info:Copy"))).toHaveLength(1);
    // a genuine change (mode flip) still reports
    h.ops.setClipboard("cut", items);
    expect(h.calls).toContain("notify:cut:info:Cut 2 items · paste to complete");
  });

  test("paste labels carry counts and destination", async () => {
    const h = makeHarness();
    const src = path.join(ROOT, "label-src.txt");
    const destDir = path.join(ROOT, "label-dest");
    W(src, "data");
    mkdirSync(destDir, { recursive: true });
    h.ops.setClipboard("copy", [{ path: src, isDir: false }]);
    h.ops.pasteSmart(destDir);
    const deadline = Date.now() + 2000;
    while (!h.calls.some((c) => c.startsWith("undo:")) && Date.now() < deadline) await Bun.sleep(10);
    expect(h.calls.some((c) => c.startsWith("undo:paste 1 item:1:"))).toBe(true);
    expect(h.calls).toContain("notify:copy:success:Copied 1 item to ~/label-dest · ctrl+z to undo");
  });

  test("moveInto labels carry counts and destination", async () => {
    const h = makeHarness();
    const src = path.join(ROOT, "label-mv.txt");
    const destDir = path.join(ROOT, "label-mv-dest");
    W(src, "data");
    mkdirSync(destDir, { recursive: true });
    await h.ops.moveInto(destDir, [{ path: src, isDir: false }]);
    expect(h.calls.some((c) => c.startsWith(`undo:move 1 item to ${path.basename(destDir)}:1:`))).toBe(true);
  });
});

// --- archive ops: the engine is injected (never shell out) -----------------
// The fake mirrors what tar/unzip do to the filesystem: extraction writes
// entries into the staging dir passed via -C, compression writes the temp
// archive the caller then renames into place.
const fakeArchive = (opts: { entries?: Record<string, string>; stdout?: string } = {}) => {
  const runs: ToolSpec[] = [];
  const runArchive: ArchiveRun = async (spec) => {
    runs.push(spec);
    const entries = opts.entries ?? { foo: "extracted" };
    const argAfter = (flag: string): string => spec.args[spec.args.indexOf(flag) + 1]!;
    if (spec.tool === "tar" && spec.args.includes("-x")) {
      const stage = argAfter("-C");
      for (const [name, body] of Object.entries(entries)) {
        const p = path.join(stage, name);
        mkdirSync(path.dirname(p), { recursive: true });
        writeFileSync(p, body);
      }
    } else if (spec.tool === "tar" && spec.args.includes("-c")) {
      writeFileSync(argAfter("-f"), "archive-bytes");
    } else if (spec.tool === "zip") {
      writeFileSync(spec.args[1]!, "archive-bytes");
    } else if (spec.tool === "7z") {
      writeFileSync(argAfter("-y"), "archive-bytes");
    }
    return { code: 0, stdout: opts.stdout ?? "", stderr: "" };
  };
  return { runArchive, runs };
};

describe("rename undo / replace-stash guards", () => {
  test("undo of a rename bumps to (copy) instead of clobbering a recreated file", async () => {
    const h = makeHarness();
    const a = path.join(ROOT, "ren-undo-a.txt");
    W(a, "A");
    await h.ops.performRename(a, "ren-undo-b.txt");
    // the original name is reoccupied BEFORE ctrl+z
    W(a, "NEW");
    await h.undoUnits()[0]!();
    // the recreated file survives; the renamed one lands next to it as a copy
    expect(readFileSync(a, "utf8")).toBe("NEW");
    expect(existsSync(path.join(ROOT, "ren-undo-b.txt"))).toBe(false);
    expect(readFileSync(path.join(ROOT, "ren-undo-a (copy).txt"), "utf8")).toBe("A");
  });

  test("a failed rename AFTER a successful stash still records the undo batch", async () => {
    // stash succeeds (unit recorded) but the rename itself fails — the stash's
    // restore unit must not be stranded with no undo entry
    const h = makeHarness({
      conflict: { resetPolicy: () => {}, policy: () => null, promptConflict: async () => "replace" as const },
      stashVictim: async (_victim, units) => {
        units.push(async () => {});
        return true;
      },
    });
    const src = path.join(ROOT, "ren-m2-src.txt");
    W(src, "A");
    const dest = path.join(ROOT, "ren-m2-dest");
    mkdirSync(dest, { recursive: true });
    W(path.join(dest, "child.txt"), "x"); // non-empty dir => rename fails ENOTEMPTY
    await h.ops.performRename(src, "ren-m2-dest");
    expect(existsSync(src)).toBe(true);
    expect(h.calls.some((c) => c.startsWith("notify:rename failed:error:"))).toBe(true);
    expect(h.undoUnits().length).toBe(1);
  });

  test("a failed replace-stash aborts the copy (victim preserved)", async () => {
    const h = makeHarness({
      conflict: { resetPolicy: () => {}, policy: () => null, promptConflict: async () => "replace" as const },
      stashVictim: async (_victim, _units, _d, onFail) => {
        onFail(new Error("disk full"));
        return false;
      },
    });
    const src = path.join(ROOT, "m1-copy-src.txt");
    W(src, "NEW");
    const destDir = path.join(ROOT, "m1-copy-dest");
    mkdirSync(destDir, { recursive: true });
    const victim = path.join(destDir, "m1-copy-src.txt");
    W(victim, "OLD");
    await h.ops.runTransfer("copy", destDir, [src], "paste");
    expect(readFileSync(victim, "utf8")).toBe("OLD");
    expect(h.calls.some((c) => c.startsWith("notify:copy failed:error:"))).toBe(true);
  });

  test("a failed replace-stash aborts the rename (existing file preserved)", async () => {
    const h = makeHarness({
      conflict: { resetPolicy: () => {}, policy: () => null, promptConflict: async () => "replace" as const },
      stashVictim: async (_victim, _units, _d, onFail) => {
        onFail(new Error("disk full"));
        return false;
      },
    });
    const a = path.join(ROOT, "m1-ren-a.txt");
    W(a, "A");
    const b = path.join(ROOT, "m1-ren-b.txt");
    W(b, "OLD");
    await h.ops.performRename(a, "m1-ren-b.txt");
    expect(readFileSync(b, "utf8")).toBe("OLD");
    expect(readFileSync(a, "utf8")).toBe("A");
    expect(h.calls).toContain("notify:rename failed:error:Replace failed — existing file kept");
  });
});

describe("extractArchive", () => {
  test("stages, moves entries in, cleans staging, one undo batch", async () => {
    const { runArchive, runs } = fakeArchive();
    const h = makeHarness({ runArchive, listArchive: async () => 1 });
    const destDir = path.join(ROOT, "x-dest");
    mkdirSync(destDir, { recursive: true });
    const archive = path.join(ROOT, "x.tar.gz");
    W(archive, "not-really");

    await h.ops.extractArchive([archive], destDir);

    expect(readFileSync(path.join(destDir, "foo"), "utf8")).toBe("extracted");
    // staging is gone, only the extracted entry remains
    expect(readdirSync(destDir)).toEqual(["foo"]);
    expect(runs[0]!.args).toContain("-x");
    expect(h.calls.some((c) => c.startsWith("undo:extract 1 archive:1:0"))).toBe(true);
    expect(h.calls).toContain("notify:extract:success:Extracted 1 archive · ctrl+z to undo");
  });

  test("collision defaults to skip, leaving the existing entry untouched", async () => {
    const { runArchive } = fakeArchive({ entries: { foo: "new" } });
    const h = makeHarness({ runArchive, listArchive: async () => 1 });
    const destDir = path.join(ROOT, "x-skip");
    mkdirSync(destDir, { recursive: true });
    W(path.join(destDir, "foo"), "old");
    const archive = path.join(ROOT, "x-skip.tar.gz");
    W(archive, "x");

    await h.ops.extractArchive([archive], destDir);

    expect(readFileSync(path.join(destDir, "foo"), "utf8")).toBe("old");
    expect(h.calls).toContain("conflict:prompt");
    expect(h.calls.some((c) => c.includes("1 skipped"))).toBe(true);
  });

  test("keep both creates a (copy) sibling", async () => {
    const { runArchive } = fakeArchive({ entries: { foo: "new" } });
    const h = makeHarness({
      runArchive,
      listArchive: async () => 1,
      conflict: { resetPolicy: () => {}, policy: () => null, promptConflict: async () => "keepBoth" },
    });
    const destDir = path.join(ROOT, "x-keepboth");
    mkdirSync(destDir, { recursive: true });
    W(path.join(destDir, "foo"), "old");
    const archive = path.join(ROOT, "x-keepboth.tar.gz");
    W(archive, "x");

    await h.ops.extractArchive([archive], destDir);

    expect(readFileSync(path.join(destDir, "foo"), "utf8")).toBe("old");
    expect(readFileSync(path.join(destDir, "foo (copy)"), "utf8")).toBe("new");
  });

  test("cancel kills the run and discards the staging dir", async () => {
    const { runArchive, runs } = fakeArchive();
    const h = makeHarness({
      listArchive: async () => 1,
      runArchive: (spec, opts) => {
        opts?.onLine?.("foo");
        return runArchive(spec, opts);
      },
      paintProgress: () => {
        h.prog.cancelled = true;
      },
    });
    const destDir = path.join(ROOT, "x-cancel");
    mkdirSync(destDir, { recursive: true });
    const archive = path.join(ROOT, "x-cancel.tar.gz");
    W(archive, "x");

    await h.ops.extractArchive([archive], destDir);

    expect(readdirSync(destDir)).toEqual([]);
    expect(runs.length).toBe(1);
    // nothing landed, so no undo batch (production drops empty batches)
    expect(h.calls.some((c) => c.startsWith("undo:"))).toBe(false);
    expect(h.calls).toContain("notify:extract cancelled:info:Extract cancelled (0 done)");
  });

  test("cancel wakes a paused child (SIGCONT) before hard-killing it", async () => {
    const killed: string[] = [];
    const child = { kill: (sig: string) => killed.push(sig), pid: 0 } as unknown as ChildProcess;
    const h = makeHarness({
      listArchive: async () => 1,
      runArchive: async (_spec, opts) => {
        opts?.onChild?.(child);
        h.prog.cancelled = true;
        h.prog.processCancel?.();
        return { code: -1, stdout: "", stderr: "" };
      },
    });
    const destDir = path.join(ROOT, "x-pause-cancel");
    mkdirSync(destDir, { recursive: true });
    const archive = path.join(ROOT, "x-pause-cancel.tar.gz");
    W(archive, "x");

    await h.ops.extractArchive([archive], destDir);

    // SIGCONT first: a SIGSTOPped process ignores SIGKILL until resumed
    expect(killed).toEqual(["SIGCONT", "SIGKILL"]);
    expect(h.calls).toContain("notify:extract cancelled:info:Extract cancelled (0 done)");
  });

  test("undo units trash the entries that landed (executed, not just recorded)", async () => {
    const { runArchive } = fakeArchive();
    const h = makeHarness({ runArchive, listArchive: async () => 1 });
    const destDir = path.join(ROOT, "x-undo");
    mkdirSync(destDir, { recursive: true });
    const archive = path.join(ROOT, "x-undo.tar.gz");
    W(archive, "x");

    await h.ops.extractArchive([archive], destDir);
    expect(existsSync(path.join(destDir, "foo"))).toBe(true);

    const units = h.undoUnits();
    expect(units.length).toBe(1);
    for (const u of [...units].reverse()) await u();
    expect(existsSync(path.join(destDir, "foo"))).toBe(false);
  });

  test("fatal tool exit cleans staging, reports failure, records no undo", async () => {
    const h = makeHarness({
      listArchive: async () => 1,
      runArchive: async () => ({ code: 2, stdout: "", stderr: "boom happened\nmore\n" }),
    });
    const destDir = path.join(ROOT, "x-fatal");
    mkdirSync(destDir, { recursive: true });
    const archive = path.join(ROOT, "x-fatal.tar.gz");
    W(archive, "x");

    await h.ops.extractArchive([archive], destDir);

    expect(readdirSync(destDir)).toEqual([]);
    expect(h.calls.some((c) => c.includes("1 FAILED (boom happened)"))).toBe(true);
    expect(h.calls.some((c) => c.startsWith("notify:extract failed:error:"))).toBe(true);
    expect(h.calls.some((c) => c.startsWith("undo:"))).toBe(false);
  });

  test("warning exit (1) still lands the extracted entries", async () => {
    const h = makeHarness({
      listArchive: async () => 1,
      runArchive: async (spec) => {
        const stage = spec.args[spec.args.indexOf("-C") + 1]!;
        writeFileSync(path.join(stage, "foo"), "extracted");
        return { code: 1, stdout: "", stderr: "warning: skipped one member" };
      },
    });
    const destDir = path.join(ROOT, "x-warn");
    mkdirSync(destDir, { recursive: true });
    const archive = path.join(ROOT, "x-warn.tar.gz");
    W(archive, "x");

    await h.ops.extractArchive([archive], destDir);

    expect(readFileSync(path.join(destDir, "foo"), "utf8")).toBe("extracted");
    expect(h.calls).toContain("notify:extract:success:Extracted 1 archive · ctrl+z to undo");
  });

  test("an archive whose entries all collide-and-skip advertises no undo", async () => {
    const { runArchive } = fakeArchive({ entries: { foo: "new" } });
    const h = makeHarness({ runArchive, listArchive: async () => 1 });
    const destDir = path.join(ROOT, "x-allskip");
    mkdirSync(destDir, { recursive: true });
    W(path.join(destDir, "foo"), "old");
    const archive = path.join(ROOT, "x-allskip.tar.gz");
    W(archive, "x");

    await h.ops.extractArchive([archive], destDir);

    expect(h.calls.some((c) => c.includes("ctrl+z to undo"))).toBe(false);
    expect(h.calls.some((c) => c.startsWith("undo:"))).toBe(false);
  });

  test("virtual destinations are refused", async () => {
    const h = makeHarness();
    await h.ops.extractArchive([path.join(ROOT, "x.tar.gz")], "recent://");
    expect(h.calls).toContain("notify:extract:error:Can't extract here");
  });

  test("reports onFileOp with the archive paths", async () => {
    const seen: Array<{ op: string; dest?: string; outcome?: { cancelled: boolean; failed: number } }> = [];
    const { runArchive } = fakeArchive();
    const h = makeHarness({
      runArchive,
      listArchive: async () => 1,
      onFileOp: (op, _p, dest, outcome) => seen.push({ op, dest, outcome }),
    });
    const destDir = path.join(ROOT, "x-fanout");
    mkdirSync(destDir, { recursive: true });
    const archive = path.join(ROOT, "x-fanout.tar.gz");
    W(archive, "x");
    await h.ops.extractArchive([archive], destDir);
    expect(seen).toEqual([{ op: "extract", dest: destDir, outcome: { cancelled: false, failed: 0 } }]);
  });
});

describe("compressPaths", () => {
  test("writes a temp then renames it into place, one undo batch", async () => {
    const { runArchive, runs } = fakeArchive();
    const h = makeHarness({ runArchive });
    const destDir = path.join(ROOT, "c-dest");
    mkdirSync(destDir, { recursive: true });
    const a = path.join(ROOT, "c-src", "a.txt");
    const b = path.join(ROOT, "c-src", "b.txt");
    W(a, "a");
    W(b, "b");

    await h.ops.compressPaths([a, b], "tar.gz", destDir);

    const out = path.join(destDir, "archive.tar.gz");
    expect(readFileSync(out, "utf8")).toBe("archive-bytes");
    // no .tfm-part leftovers
    expect(readdirSync(destDir)).toEqual(["archive.tar.gz"]);
    const spec = runs.find((r) => r.args.includes("-c"))!;
    expect(spec.args).toEqual([
      "-c",
      "-z",
      "-v",
      "-f",
      expect.stringContaining(".tfm-part-"),
      "-C",
      path.join(ROOT, "c-src"),
      "--",
      "a.txt",
      "b.txt",
    ]);
    expect(h.calls.some((c) => c.startsWith("undo:compress archive.tar.gz:1:0"))).toBe(true);
    expect(h.calls).toContain("notify:compress:success:Compressed archive.tar.gz · ctrl+z to undo");
  });

  test("existing archive: skip leaves it alone, keep both gets a (copy) name", async () => {
    const { runArchive, runs } = fakeArchive();
    const h = makeHarness({ runArchive });
    const destDir = path.join(ROOT, "c-collide");
    mkdirSync(destDir, { recursive: true });
    const a = path.join(ROOT, "c-collide-src", "only.txt");
    W(a, "x");
    W(path.join(destDir, "only.txt.tar.gz"), "old");

    await h.ops.compressPaths([a], "tar.gz", destDir);
    expect(readFileSync(path.join(destDir, "only.txt.tar.gz"), "utf8")).toBe("old");
    expect(runs.some((r) => r.args.includes("-c"))).toBe(false);

    const h2 = makeHarness({
      runArchive,
      conflict: { resetPolicy: () => {}, policy: () => null, promptConflict: async () => "keepBoth" },
    });
    await h2.ops.compressPaths([a], "tar.gz", destDir);
    expect(readFileSync(path.join(destDir, "only.txt (copy).tar.gz"), "utf8")).toBe("archive-bytes");
  });

  test("cancel removes the half-written temp and reports cancelled", async () => {
    const { runArchive } = fakeArchive();
    const h = makeHarness({
      runArchive: (spec, opts) => {
        opts?.onLine?.("x");
        return runArchive(spec, opts);
      },
      paintProgress: () => {
        h.prog.cancelled = true;
      },
    });
    const destDir = path.join(ROOT, "c-cancel");
    mkdirSync(destDir, { recursive: true });
    const a = path.join(ROOT, "c-cancel-src", "x.txt");
    W(a, "x");

    await h.ops.compressPaths([a], "tar.gz", destDir);

    expect(readdirSync(destDir)).toEqual([]);
    expect(h.calls).toContain("notify:compress cancelled:info:Compress cancelled");
    expect(h.calls.some((c) => c.startsWith("undo:"))).toBe(false);
  });

  test("cross-directory selection stores relative paths, not collapsed basenames", async () => {
    const { runArchive, runs } = fakeArchive();
    const h = makeHarness({ runArchive });
    const destDir = path.join(ROOT, "c-cross-dest");
    mkdirSync(destDir, { recursive: true });
    const a = path.join(ROOT, "c-cross", "a", "foo.txt");
    const b = path.join(ROOT, "c-cross", "b", "foo.txt");
    W(a, "a");
    W(b, "b");

    await h.ops.compressPaths([a, b], "tar.gz", destDir);

    const spec = runs.find((r) => r.args.includes("-c"))!;
    // both `foo.txt` entries survive under distinct relative paths (a basename
    // list would store foo.txt twice and drop the second file)
    expect(spec.args.slice(spec.args.indexOf("--") + 1)).toEqual(["a/foo.txt", "b/foo.txt"]);
    expect(spec.args).toContain(path.join(ROOT, "c-cross"));
  });

  test("virtual destination is refused", async () => {
    const h = makeHarness();
    await h.ops.compressPaths([path.join(ROOT, "noop.txt")], "tar.gz", "recent://");
    expect(h.calls).toContain("notify:compress:error:Can't compress here");
  });
});

describe("plugin pre-op veto", () => {
  test("a beforeFileOp hook blocks the transfer with a status and no undo", async () => {
    const h = makeHarness();
    const off = sharedPluginHooks().onBeforeFileOp((p) =>
      p.op === "move" ? { skip: true, reason: "nope" } : undefined,
    );
    try {
      const src = path.join(ROOT, "veto-src.txt");
      const destDir = path.join(ROOT, "veto-dest");
      W(src, "keep");
      mkdirSync(destDir, { recursive: true });
      await h.ops.runTransfer("move", destDir, [src], "move");
      expect(existsSync(src)).toBe(true);
      expect(existsSync(path.join(destDir, "veto-src.txt"))).toBe(false);
      expect(h.calls).toContain("notify:blocked:info:Blocked by plugin: nope");
      expect(h.calls.some((c) => c.startsWith("undo:"))).toBe(false);
    } finally {
      off();
    }
  });

  test("a rename hook blocks performRename", async () => {
    const h = makeHarness();
    const off = sharedPluginHooks().onBeforeFileOp((p) => (p.op === "rename" ? { skip: true } : undefined));
    try {
      const src = path.join(ROOT, "veto-rename.txt");
      W(src, "x");
      await h.ops.performRename(src, "veto-renamed.txt");
      expect(existsSync(src)).toBe(true);
      expect(h.calls.some((c) => c.startsWith("notify:blocked:info:Blocked by plugin"))).toBe(true);
      expect(h.calls.some((c) => c.startsWith("undo:"))).toBe(false);
    } finally {
      off();
    }
  });
});

describe("plugin veto keeps caller state intact", () => {
  test("a vetoed paste does not consume the internal clipboard", async () => {
    const h = makeHarness();
    const off = sharedPluginHooks().onBeforeFileOp((p) => (p.op === "copy" ? { skip: true } : undefined));
    try {
      const src = path.join(ROOT, "veto-paste-src.txt");
      const destDir = path.join(ROOT, "veto-paste-dest");
      W(src, "x");
      mkdirSync(destDir, { recursive: true });
      h.ops.setClipboard("copy", [{ path: src, isDir: false }]);
      h.ops.pasteSmart(destDir);
      await Bun.sleep(30);
      expect(h.ops.clipboard()?.items.length).toBe(1); // NOT consumed
      expect(existsSync(path.join(destDir, "veto-paste-src.txt"))).toBe(false);
      expect(h.calls.some((c) => c.startsWith("undo:"))).toBe(false);
      expect(h.calls.some((c) => c.startsWith("notify:blocked:info:Blocked by plugin"))).toBe(true);
    } finally {
      off();
    }
  });
});

// scanTree over a big source tree used to be silent: seconds of nothing before
// the first honest total existed, so the toast could only be armed afterwards.
// preScan arms it mid-scan in counting mode, and a small tree must still never
// flicker a toast at all.
describe("preScan counting", () => {
  test("big tree raises the toast while totals are still unknown", async () => {
    const h = makeHarness();
    const src = path.join(ROOT, "prescan-big");
    const destDir = path.join(ROOT, "prescan-dest");
    mkdirSync(src, { recursive: true });
    mkdirSync(destDir, { recursive: true });
    for (let i = 0; i < 1100; i++) W(path.join(src, `f${i}`), "x");
    const shown: Array<{ counting?: boolean; totalFiles: number }> = [];
    // mirror the real showProgressToast: a second call while the toast is up
    // no-ops, so `shown` records genuine armings only
    h.ctx.showProgressToast = () => {
      if (h.prog.toastUp) return;
      h.prog.toastUp = true;
      shown.push({ counting: !!h.prog.counting, totalFiles: h.prog.totalFiles });
    };
    await h.ops.runTransfer("copy", destDir, [src], "paste");
    // the very first (and only) show happened mid-scan, while still counting —
    // the post-scan arm no-ops because the toast is up
    expect(shown.length).toBe(1);
    expect(shown[0]!.counting).toBe(true);
    // the counting flag is gone by the time the transfer runs
    expect(h.prog.counting).toBeFalsy();
    expect(h.prog.totalFiles).toBe(1100);
  });

  test("small tree never touches counting paint and never arms mid-scan", async () => {
    const h = makeHarness();
    const src = path.join(ROOT, "prescan-small");
    const destDir = path.join(ROOT, "prescan-small-dest");
    seedTree(src);
    mkdirSync(destDir, { recursive: true });
    let shows = 0;
    h.ctx.showProgressToast = () => {
      h.prog.toastUp = true;
      shows++;
    };
    await h.ops.runTransfer("copy", destDir, [path.join(src, "f1.txt")], "paste");
    // one file = under the toast threshold: exactly one show (the real one)
    expect(shows).toBe(0);
    expect(h.prog.counting).toBeFalsy();
  });

  // ✕ during a long pre-scan must abort the SCAN (tick throw + loop break),
  // not just the later copy loop — otherwise the counting toast visibly
  // refuses to stop while the tree is walked to the end. totalFiles staying
  // on the no-totals fallback proves the walk never finished (without the
  // guards the scan completes and total becomes 5000).
  test("cancel during the pre-scan aborts scan and copy phase", async () => {
    const h = makeHarness();
    const src = path.join(ROOT, "prescan-cancel");
    const destDir = path.join(ROOT, "prescan-cancel-dest");
    mkdirSync(src, { recursive: true });
    mkdirSync(destDir, { recursive: true });
    for (let i = 0; i < 5000; i++) W(path.join(src, `f${i}`), "x");
    h.ctx.paintProgress = () => {
      h.prog.cancelled = true; // the toast ✕ lands on the first counting paint
    };
    await h.ops.runTransfer("copy", destDir, [src], "paste");
    expect(h.prog.counting).toBeFalsy();
    expect(h.prog.totalFiles).toBe(1);
    expect(readdirSync(destDir).length).toBe(0);
    expect(h.calls.some((c) => c.startsWith("notify:copy cancelled"))).toBe(true);
  });
});
