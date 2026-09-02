import { describe, expect, test, afterAll } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { tileLabelFor, uniqueUntitledName } from "./ui-rename";

// mkdtemp only creates the last segment — the parent must be a dir that
// exists everywhere (CI runners choke on a hardcoded /tmp/opencode)
const mktmp = (prefix: string): string => mkdtempSync(path.join(os.tmpdir(), prefix));
const dir = mktmp("tfm-rename-");
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("uniqueUntitledName", () => {
  test("base name is free -> returned as-is", () => {
    expect(uniqueUntitledName(dir, "Untitled folder")).toBe("Untitled folder");
  });

  test("collision bumps to 'Untitled folder 2', ' 3'… keeping the space in the stem", () => {
    mkdirSync(path.join(dir, "Untitled folder"));
    expect(uniqueUntitledName(dir, "Untitled folder")).toBe("Untitled folder 2");
    mkdirSync(path.join(dir, "Untitled folder 2"));
    expect(uniqueUntitledName(dir, "Untitled folder")).toBe("Untitled folder 3");
  });

  test("extension split: 'Untitled 2.txt', not 'Untitled.txt 2'", () => {
    writeFileSync(path.join(dir, "Untitled.txt"), "");
    expect(uniqueUntitledName(dir, "Untitled.txt")).toBe("Untitled 2.txt");
    writeFileSync(path.join(dir, "Untitled 2.txt"), "");
    expect(uniqueUntitledName(dir, "Untitled.txt")).toBe("Untitled 3.txt");
  });

  test("dotfile names never split the leading dot", () => {
    writeFileSync(path.join(dir, ".tmp"), "");
    expect(uniqueUntitledName(dir, ".tmp")).toBe(".tmp 2");
  });
});

describe("tileLabelFor", () => {
  test("fits inside maxW-2 untouched", () => {
    expect(tileLabelFor("notes.txt", 20)).toBe("notes.txt");
  });

  test("long names truncate to maxW-5 chars + ellipsis", () => {
    const out = tileLabelFor("a-very-long-filename-indeed.txt", 20);
    expect(out.length).toBe(16); // 15 chars + "…"
    expect(out.endsWith("…")).toBe(true);
  });

  test("boundary: exactly maxW-2 fits, maxW-1 truncates", () => {
    expect(tileLabelFor("x".repeat(18), 20)).toBe("x".repeat(18));
    expect(tileLabelFor("x".repeat(19), 20).length).toBe(16);
  });
});
