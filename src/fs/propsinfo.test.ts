import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadGlobs2 } from "./filetype";
import { dirWalkStats, fmtBytes, fmtDate, idName, mimeLabelFor, permWords } from "./propsinfo";

describe("fmtBytes", () => {
  test("stays in B under 1024, formats one decimal above", () => {
    expect(fmtBytes(0)).toBe("0 B");
    expect(fmtBytes(1023)).toBe("1023 B");
    expect(fmtBytes(1024)).toBe("1.0 KB");
    expect(fmtBytes(1536)).toBe("1.5 KB");
    expect(fmtBytes(1024 ** 3)).toBe("1.0 GB");
  });
});

describe("permWords", () => {
  test("maps rwx triads to words per kind", () => {
    // 0o755 dir: owner rwx, group/others r-x
    expect(permWords(0o755, 6, true)).toBe("read, write, enter");
    expect(permWords(0o755, 3, true)).toBe("read, enter");
    expect(permWords(0o755, 0, false)).toBe("read, run");
    expect(permWords(0o000, 6, true)).toBe("no access");
    expect(permWords(0o400, 6, false)).toBe("read");
  });
});

describe("fmtDate", () => {
  test("pads fields, dashes for falsy", () => {
    expect(fmtDate(undefined)).toBe("-");
    expect(fmtDate(0)).toBe("-");
    const d = new Date(2026, 0, 5, 7, 8);
    expect(fmtDate(d.getTime())).toBe("2026-01-05 07:08");
  });
});

describe("mimeLabelFor", () => {
  test("globs2 mime wins when loaded, else category fallback, else data", async () => {
    // pre-globs2: extension classifier falls back to category labels
    expect(mimeLabelFor("noext")).toBe("data");
    expect(mimeLabelFor("photo.png")).toBe("image/*");
    await loadGlobs2();
    expect(mimeLabelFor("photo.png")).toBe("image/png");
    expect(mimeLabelFor("song.mp3")).toBe("audio/mpeg");
    expect(mimeLabelFor("noext")).toBe("data");
  });
});

describe("idName", () => {
  test("resolves from /etc/passwd or falls back to numeric uid", () => {
    const name = idName(0);
    expect(name === "root" || name === "0").toBe(true);
  });
});

describe("dirWalkStats", () => {
  test("sums files bytes + folder count, symlinks not followed", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "tfm-props-"));
    try {
      const sub = path.join(root, "sub");
      mkdirSync(sub, { recursive: true });
      writeFileSync(path.join(root, "a.txt"), "x".repeat(10));
      writeFileSync(path.join(sub, "b.bin"), "y".repeat(5));
      symlinkSync("/etc/hostname", path.join(root, "lnk"));
      const s = await dirWalkStats(root);
      expect(s).not.toBeNull();
      expect(s!.files).toBe(3);
      expect(s!.folders).toBe(1);
      expect(s!.bytes).toBe(15 + (await (await import("node:fs/promises")).lstat(path.join(root, "lnk"))).size);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("missing root yields zeros, not a throw", async () => {
    const s = await dirWalkStats(path.join(os.tmpdir(), `tfm-props-nonexistent-${process.pid}`));
    expect(s).toEqual({ bytes: 0, files: 0, folders: 0 });
  });
});
