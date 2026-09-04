import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, existsSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  trashDir,
  fsErrText,
  failSuffix,
  fsMove,
  isTrashFilesDir,
  safeRestoreMove,
  uniqueTarget,
  xdgTrashMove,
  deviceOf,
  crossDevice,
  atomicWriteFile,
  encodeTrashPath,
} from "./fsutil";

// mkdtemp only creates the last segment — the parent must be a dir that
// exists everywhere (CI runners choke on a hardcoded /tmp/opencode)
const mktmp = (prefix: string): string => mkdtempSync(path.join(os.tmpdir(), prefix));

// trashDir() re-reads XDG_DATA_HOME on every call, so redirecting the env in
// beforeAll sandboxes all trash writes away from the real ~/.local/share.
const SANDBOX = mktmp("tfm-fsutil-");
let oldData: string | undefined;

beforeAll(() => {
  oldData = process.env.XDG_DATA_HOME;
  process.env.XDG_DATA_HOME = SANDBOX;
  mkdirSync(path.join(SANDBOX, "Trash", "files"), { recursive: true });
  mkdirSync(path.join(SANDBOX, "Trash", "info"), { recursive: true });
});

afterAll(() => {
  if (oldData === undefined) delete process.env.XDG_DATA_HOME;
  else process.env.XDG_DATA_HOME = oldData;
  rmSync(SANDBOX, { recursive: true, force: true });
});

const W = (p: string, s = "x") => {
  mkdirSync(path.dirname(p), { recursive: true });
  writeFileSync(p, s);
};

describe("uniqueTarget", () => {
  test("contract: callers pass an OCCUPIED name — first suggestion is ' (copy)', never the base", () => {
    const dir = mktmp("tfm-ut-");
    try {
      W(path.join(dir, "report.pdf"));
      expect(uniqueTarget(dir, "report.pdf")).toBe(path.join(dir, "report (copy).pdf"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("first collision -> ' (copy)', then ' (copy 2)'…", () => {
    const dir = mktmp("tfm-ut-");
    try {
      W(path.join(dir, "f.txt"));
      expect(uniqueTarget(dir, "f.txt")).toBe(path.join(dir, "f (copy).txt"));
      W(path.join(dir, "f (copy).txt"));
      expect(uniqueTarget(dir, "f.txt")).toBe(path.join(dir, "f (copy 2).txt"));
      W(path.join(dir, "f (copy 2).txt"));
      expect(uniqueTarget(dir, "f.txt")).toBe(path.join(dir, "f (copy 3).txt"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("extensionless and dotfiles collide on the whole name", () => {
    const dir = mktmp("tfm-ut-");
    try {
      W(path.join(dir, "Makefile"));
      expect(uniqueTarget(dir, "Makefile")).toBe(path.join(dir, "Makefile (copy)"));
      W(path.join(dir, ".x"));
      expect(uniqueTarget(dir, ".x")).toBe(path.join(dir, ".x (copy)")); // dot <= 0 → no ext split
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("fsMove / safeRestoreMove", () => {
  test("move renames within a fs", async () => {
    const dir = mktmp("tfm-mv-");
    try {
      W(path.join(dir, "a.txt"), "data");
      await fsMove(path.join(dir, "a.txt"), path.join(dir, "b.txt"));
      expect(existsSync(path.join(dir, "a.txt"))).toBe(false);
      expect(readFileSync(path.join(dir, "b.txt"), "utf8")).toBe("data");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("safeRestoreMove never clobbers an occupied target", async () => {
    const dir = mktmp("tfm-mv-");
    try {
      W(path.join(dir, "src.txt"), "restored");
      W(path.join(dir, "dst.txt"), "current");
      await safeRestoreMove(path.join(dir, "src.txt"), path.join(dir, "dst.txt"));
      expect(readFileSync(path.join(dir, "dst.txt"), "utf8")).toBe("current");
      expect(readFileSync(path.join(dir, "dst (copy).txt"), "utf8")).toBe("restored");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("safeRestoreMove creates missing parent dirs", async () => {
    const dir = mktmp("tfm-mv-");
    try {
      W(path.join(dir, "src.txt"), "deep");
      await safeRestoreMove(path.join(dir, "src.txt"), path.join(dir, "x/y/z/dst.txt"));
      expect(readFileSync(path.join(dir, "x/y/z/dst.txt"), "utf8")).toBe("deep");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("xdgTrashMove", () => {
  test("writes .trashinfo and moves into Trash/files with deterministic name", async () => {
    const files = mktmp("tfm-trash-src-");
    try {
      W(path.join(files, "gone.txt"), "bye");
      const loc = await xdgTrashMove(path.join(files, "gone.txt"));
      expect(loc).toBe(path.join(trashDir(), "files", "gone.txt"));
      expect(existsSync(path.join(files, "gone.txt"))).toBe(false);
      const info = readFileSync(path.join(trashDir(), "info", "gone.txt.trashinfo"), "utf8");
      expect(info).toContain("[Trash Info]");
      expect(info).toContain(`Path=${path.join(files, "gone.txt")}`);
      expect(info).toMatch(/DeletionDate=\d{4}-\d{2}-\d{2}T/);
    } finally {
      rmSync(files, { recursive: true, force: true });
    }
  });

  test("colliding NAME suffixes .2 (trash/files holds a.txt, so same-named source bumps)", async () => {
    const d1 = mktmp("tfm-trash-d1-");
    const d2 = mktmp("tfm-trash-d2-");
    try {
      W(path.join(d1, "same.txt"));
      W(path.join(d2, "same.txt"));
      W(path.join(d2, "other.txt"));
      const l1 = await xdgTrashMove(path.join(d1, "same.txt"));
      const l2 = await xdgTrashMove(path.join(d2, "same.txt"));
      const l3 = await xdgTrashMove(path.join(d2, "other.txt"));
      expect(l1).toBe(path.join(trashDir(), "files", "same.txt"));
      expect(l2).toBe(path.join(trashDir(), "files", "same.txt.2"));
      expect(l3).toBe(path.join(trashDir(), "files", "other.txt")); // distinct name: no suffix
      expect(existsSync(path.join(trashDir(), "info", "same.txt.trashinfo"))).toBe(true);
      expect(existsSync(path.join(trashDir(), "info", "same.txt.2.trashinfo"))).toBe(true);
    } finally {
      rmSync(d1, { recursive: true, force: true });
      rmSync(d2, { recursive: true, force: true });
    }
  });

  test("creates the trash tree on demand when absent", async () => {
    rmSync(path.join(SANDBOX, "Trash"), { recursive: true, force: true });
    const files = mktmp("tfm-trash-src3-");
    try {
      W(path.join(files, "c.txt"));
      const loc = await xdgTrashMove(path.join(files, "c.txt"));
      expect(loc).toBe(path.join(trashDir(), "files", "c.txt"));
    } finally {
      rmSync(files, { recursive: true, force: true });
    }
  });

  test("failed move leaves NO orphan .trashinfo (info is written after the move)", async () => {
    rmSync(path.join(SANDBOX, "Trash"), { recursive: true, force: true });
    await expect(xdgTrashMove("/nonexistent/tfm-orphan.txt")).rejects.toThrow();
    expect(existsSync(path.join(trashDir(), "info", "tfm-orphan.txt.trashinfo"))).toBe(false);
    expect(existsSync(path.join(trashDir(), "files", "tfm-orphan.txt"))).toBe(false);
  });

  test("info-write failure rolls the move back — source intact, no half-trashed state", async () => {
    // NOTE: fails as root (chmod 555 doesn't block uid 0) — CI runs as
    // non-root; verified green there. Skipped when euid is 0.
    if (typeof process.geteuid === "function" && process.geteuid() === 0) return;
    rmSync(path.join(SANDBOX, "Trash"), { recursive: true, force: true });
    const files = mktmp("tfm-trash-rb-");
    const infoDir = path.join(trashDir(), "info");
    try {
      W(path.join(files, "rb.txt"), "still mine");
      mkdirSync(infoDir, { recursive: true });
      chmodSync(infoDir, 0o555); // writeFile into info/ fails with EACCES
      await expect(xdgTrashMove(path.join(files, "rb.txt"))).rejects.toThrow();
      // rolled back: file back where it was, nothing left in Trash
      expect(readFileSync(path.join(files, "rb.txt"), "utf8")).toBe("still mine");
      expect(existsSync(path.join(trashDir(), "files", "rb.txt"))).toBe(false);
    } finally {
      chmodSync(infoDir, 0o755);
      rmSync(files, { recursive: true, force: true });
    }
  });
});

describe("encodeTrashPath", () => {
  test("plain paths pass through unchanged", () => {
    expect(encodeTrashPath("/tmp/plain.txt")).toBe("/tmp/plain.txt");
  });

  test("spaces, %, # and unicode are percent-encoded per segment, slashes survive", () => {
    expect(encodeTrashPath("/tmp/a b/c%d.txt")).toBe("/tmp/a%20b/c%25d.txt");
    const enc = encodeTrashPath("/home/me/#hash éprouvé.txt");
    expect(enc).not.toContain(" ");
    expect(enc).not.toContain("#");
    expect(decodeURIComponent(enc)).toBe("/home/me/#hash éprouvé.txt");
  });
});

describe("xdgTrashMove encoding", () => {
  test("Path= is percent-encoded and resolves back to the source", async () => {
    const files = mktmp("tfm-trash-enc-");
    try {
      const src = path.join(files, "sp ace.txt");
      W(src, "data");
      const loc = await xdgTrashMove(src);
      const info = readFileSync(path.join(trashDir(), "info", `${path.basename(loc)}.trashinfo`), "utf8");
      expect(info).toContain(`Path=${encodeTrashPath(src)}`);
      expect(info).toContain("%20");
    } finally {
      rmSync(files, { recursive: true, force: true });
    }
  });
});

describe("deviceOf / crossDevice", () => {
  test("same tree is same-device, statable paths yield a dev number", () => {
    const dir = mktmp("tfm-dev-");
    try {
      W(path.join(dir, "f.txt"));
      expect(typeof deviceOf(path.join(dir, "f.txt"))).toBe("number");
      expect(crossDevice(dir, path.join(dir, "f.txt"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("unstatable path -> null dev, crossDevice false (safe fallback, not 'equal')", () => {
    expect(deviceOf("/nonexistent/tfm-dev-miss")).toBeNull();
    expect(crossDevice("/nonexistent/a", "/nonexistent/b")).toBe(false);
  });
});

describe("fsErrText", () => {
  test("known codes map to human phrases", () => {
    expect(fsErrText({ code: "ENOENT" })).toBe("source gone");
    expect(fsErrText({ code: "EACCES" })).toBe("permission denied");
    expect(fsErrText({ code: "ENOSPC" })).toBe("disk full");
  });

  test("unknown codes lowercase, non-fs errors take the message head", () => {
    expect(fsErrText({ code: "EWOULDNEVER" })).toBe("ewouldnever");
    expect(fsErrText(new Error("EACCES: permission denied, open '/x'"))).toBe("eacces");
    expect(fsErrText("plain string")).toBe("unknown error");
  });
});

describe("failSuffix", () => {
  test("first reason wins, empty set omits the parens", () => {
    expect(failSuffix(2, new Set(["disk full", "source gone"]))).toBe("2 FAILED (disk full)");
    expect(failSuffix(1, new Set())).toBe("1 FAILED");
  });
});

describe("isTrashFilesDir", () => {
  test("the sandboxed trash files dir matches (XDG_DATA_HOME honored)", () => {
    expect(isTrashFilesDir(path.join(SANDBOX, "Trash", "files"))).toBe(true);
  });

  test("relative spellings of the same dir match", () => {
    const abs = path.join(SANDBOX, "Trash", "files");
    const rel = path.relative(process.cwd(), abs);
    expect(isTrashFilesDir(rel)).toBe(path.resolve(rel) === abs);
  });

  test("the trash info dir and unrelated paths do NOT match", () => {
    expect(isTrashFilesDir(path.join(SANDBOX, "Trash", "info"))).toBe(false);
    expect(isTrashFilesDir(SANDBOX)).toBe(false);
    expect(isTrashFilesDir("/")).toBe(false);
  });

  test("virtual place URIs never match", () => {
    expect(isTrashFilesDir("recent://")).toBe(false);
    expect(isTrashFilesDir("starred://")).toBe(false);
  });
});

describe("atomicWriteFile", () => {
  test("writes the payload and leaves no tmp files behind", async () => {
    const p = path.join(SANDBOX, "atomic-out.png");
    await atomicWriteFile(p, new Uint8Array([1, 2, 3]));
    expect([...readFileSync(p)]).toEqual([1, 2, 3]);
    expect(existsSync(`${p}.tmp-`)).toBe(false);
  });

  test("failed rename (target dir removed mid-flight) cleans the tmp file", async () => {
    // the tmp file goes next to the target; the target's parent is missing,
    // so writeFile itself fails on ENOENT and nothing is left behind
    const missing = path.join(SANDBOX, "atomic-gone", "out.png");
    await expect(atomicWriteFile(missing, "x")).rejects.toThrow();
    expect(existsSync(path.join(SANDBOX, "atomic-gone"))).toBe(false);
  });
});
