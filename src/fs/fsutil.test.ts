import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  existsSync,
  rmSync,
  writeFileSync,
  chmodSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  trashDir,
  fsErrText,
  failSuffix,
  fsMove,
  canReadSync,
  isTrashFilesDir,
  safeRestoreMove,
  uniqueTarget,
  xdgTrashMove,
  deviceOf,
  crossDevice,
  atomicWriteFile,
  claimTmp,
  encodeTrashPath,
  rmTrashInfoForPath,
  allTrashFilesDirs,
  countTrashItems,
  fileIdMatches,
  fileIdOf,
  trashIfSameFile,
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

describe("canReadSync", () => {
  test("true for a readable file, false for a missing path", () => {
    const f = path.join(SANDBOX, "readable.txt");
    writeFileSync(f, "x");
    expect(canReadSync(f)).toBe(true);
    expect(canReadSync(path.join(SANDBOX, "no-such-file.txt"))).toBe(false);
  });

  // root bypasses file modes, so a chmod-000 probe is meaningless as uid 0
  test.skipIf(process.getuid?.() === 0)("chmod-000 is unreadable", () => {
    const f = path.join(SANDBOX, "locked.txt");
    writeFileSync(f, "x");
    chmodSync(f, 0o000);
    try {
      expect(canReadSync(f)).toBe(false);
    } finally {
      chmodSync(f, 0o644);
    }
  });
});

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

  test("claimTmp hands out distinct exclusive names (no shared part-files)", async () => {
    const dir = mktmp("tfm-claim-");
    try {
      const dest = path.join(dir, "out.bin");
      const a = await claimTmp(dest);
      const b = await claimTmp(dest);
      expect(a).not.toBe(b);
      // both claims exist and are empty: the second claim did not reuse the first
      expect(existsSync(a)).toBe(true);
      expect(existsSync(b)).toBe(true);
      expect(readFileSync(a, "utf8")).toBe("");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("claimTmp dir mode claims an exclusive directory", async () => {
    const dir = mktmp("tfm-claimdir-");
    try {
      const a = await claimTmp(path.join(dir, "out"), true);
      const b = await claimTmp(path.join(dir, "out"), true);
      expect(a).not.toBe(b);
      expect(readdirSync(a)).toEqual([]);
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

describe("rmTrashInfoForPath per-mount isolation", () => {
  test("a missing per-mount sidecar never touches the home entry of the same name", async () => {
    // home holds an entry "same.txt" (with its sidecar); a per-mount file of
    // the same basename has NO sibling sidecar — cleanup must leave home alone
    const homeFile = path.join(SANDBOX, "home-orig-same.txt");
    writeFileSync(homeFile, "home-data");
    await xdgTrashMove(homeFile);
    expect(existsSync(path.join(trashDir(), "info", "home-orig-same.txt.trashinfo"))).toBe(true);
    const mnt = path.join(SANDBOX, "mnt");
    mkdirSync(path.join(mnt, "files"), { recursive: true });
    writeFileSync(path.join(mnt, "files", "home-orig-same.txt"), "other-disk-data");
    await rmTrashInfoForPath(path.join(mnt, "files", "home-orig-same.txt"));
    expect(existsSync(path.join(trashDir(), "info", "home-orig-same.txt.trashinfo"))).toBe(true);
  });

  test("a present per-mount sidecar is removed without touching home", async () => {
    const mnt = path.join(SANDBOX, "mnt2");
    mkdirSync(path.join(mnt, "info"), { recursive: true });
    mkdirSync(path.join(mnt, "files"), { recursive: true });
    writeFileSync(path.join(mnt, "files", "u.txt"), "d");
    writeFileSync(path.join(mnt, "info", "u.txt.trashinfo"), "[Trash Info]\nPath=/x/u.txt\n");
    await rmTrashInfoForPath(path.join(mnt, "files", "u.txt"));
    expect(existsSync(path.join(mnt, "info", "u.txt.trashinfo"))).toBe(false);
  });
});

describe("allTrashFilesDirs", () => {
  const uid = typeof process.getuid === "function" ? process.getuid() : 0;
  test("home first, one entry per mount, deduped", () => {
    const mounts = [
      "dev2 /mnt/usb ext4 rw 0 0",
      "dev3 /mnt/usb ext4 rw 0 0",
      "dev4 /mnt/odd\\040name ext4 rw 0 0",
    ].join("\n");
    expect(allTrashFilesDirs(mounts)).toEqual([
      path.join(trashDir(), "files"),
      path.join("/mnt/usb", `.Trash-${uid}`, "files"),
      path.join("/mnt/odd name", `.Trash-${uid}`, "files"),
    ]);
  });

  test("network and automount filesystems are never probed", () => {
    const mounts = [
      "srv:/share /mnt/nfs nfs rw 0 0",
      "//srv/share /mnt/cifs cifs rw 0 0",
      "sshfs#x /mnt/ssh fuse.sshfs rw 0 0",
      "auto /mnt/auto autofs rw 0 0",
      "gvfs /run/user/1000/gvfs fuse.gvfsd-fuse rw 0 0",
      "dev5 /mnt/disk ext4 rw 0 0",
    ].join("\n");
    expect(allTrashFilesDirs(mounts)).toEqual([
      path.join(trashDir(), "files"),
      path.join("/mnt/disk", `.Trash-${uid}`, "files"),
    ]);
  });

  test("malformed lines are skipped, never throw", () => {
    // "garbage" (one field) and blank lines skip; "dev /x ext4" is a
    // well-formed (if odd) entry and is honored
    expect(allTrashFilesDirs("garbage\n\n  \ndev /x ext4")).toEqual([
      path.join(trashDir(), "files"),
      path.join("/x", `.Trash-${uid}`, "files"),
    ]);
    expect(allTrashFilesDirs("")).toEqual([path.join(trashDir(), "files")]);
  });
});

describe("countTrashItems", () => {
  const uid = typeof process.getuid === "function" ? process.getuid() : 0;
  test("sums home plus mounted per-mount trashes", () => {
    const mnt = path.join(SANDBOX, "usb");
    const files = path.join(mnt, `.Trash-${uid}`, "files");
    mkdirSync(files, { recursive: true });
    writeFileSync(path.join(files, "u1"), "x");
    writeFileSync(path.join(files, "u2"), "x");
    const before = (() => {
      try {
        return readdirSync(path.join(trashDir(), "files")).length;
      } catch {
        return -1;
      }
    })();
    if (before < 0) return; // home unreadable — covered by the -1 test below
    expect(countTrashItems(`dev ${mnt} ext4 rw 0 0`)).toBe(before + 2);
  });
});

describe("fileIdOf / fileIdMatches / trashIfSameFile", () => {
  test("same file matches, replaced file does not", () => {
    const p = path.join(SANDBOX, "id-target.txt");
    writeFileSync(p, "v1");
    const id = fileIdOf(p);
    expect(id).not.toBeNull();
    expect(fileIdMatches(id, p)).toBe(true);
    expect(fileIdMatches(null, p)).toBe(true);
    expect(fileIdMatches({ dev: -1, ino: -1 }, p)).toBe(false);
    expect(fileIdMatches(id, path.join(SANDBOX, "id-missing.txt"))).toBe(false);
    expect(fileIdOf(path.join(SANDBOX, "id-missing.txt"))).toBeNull();
  });

  test("trashes the recorded file, skips a stranger, no-ops when gone", async () => {
    const logs: string[] = [];
    const log = (m: string) => logs.push(m);
    const p = path.join(SANDBOX, "same-trashed.txt");
    writeFileSync(p, "v1");
    const id = fileIdOf(p);
    await trashIfSameFile(p, id, log);
    expect(existsSync(p)).toBe(false);
    expect(logs).toEqual([]);

    // reoccupied path: the stranger survives, skip is logged
    writeFileSync(p, "stranger");
    await trashIfSameFile(p, id, log);
    expect(readFileSync(p, "utf8")).toBe("stranger");
    expect(logs.some((m) => m.includes("replaced since op"))).toBe(true);

    // gone path: silent success
    rmSync(p);
    await trashIfSameFile(p, id, log);
  });

  test("null id falls back to path semantics", async () => {
    const p = path.join(SANDBOX, "null-id.txt");
    writeFileSync(p, "x");
    await trashIfSameFile(p, null);
    expect(existsSync(p)).toBe(false);
  });
});
