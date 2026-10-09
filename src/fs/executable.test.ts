import { describe, expect, test } from "bun:test";
import {
  addExecBits,
  classifyExecutable,
  classifyPath,
  executableChoiceLabels,
  isElfHead,
  isShebangHead,
} from "./executable";
import { mkdtempSync, writeFileSync, chmodSync } from "node:fs";
import os from "node:os";
import path from "node:path";

describe("executable heads", () => {
  test("+x mode is executable without sniffing", () => {
    expect(classifyExecutable(0o755, false)).toEqual({ executable: true, needsChmod: false });
    expect(classifyExecutable(0o100, false)).toEqual({ executable: true, needsChmod: false });
  });
  test("dirs never count, even with +x", () => {
    expect(classifyExecutable(0o755, true).executable).toBe(false);
  });
  test("ELF without bit needs chmod", () => {
    const elf = Buffer.from([0x7f, 0x45, 0x4c, 0x46]);
    expect(isElfHead(elf)).toBe(true);
    expect(classifyExecutable(0o644, false, elf)).toEqual({ executable: true, needsChmod: true });
  });
  test("shebang without bit needs chmod", () => {
    const sh = Buffer.from([0x23, 0x21, 0x2f, 0x62]);
    expect(isShebangHead(sh)).toBe(true);
    expect(classifyExecutable(0o644, false, sh)).toEqual({ executable: true, needsChmod: true });
  });
  test("plain text without bit is not executable", () => {
    expect(classifyExecutable(0o644, false, Buffer.from("hell")).executable).toBe(false);
    expect(classifyExecutable(0o644, false).executable).toBe(false);
  });
});

describe("classifyPath", () => {
  test("real files: +x runs, shebang-without-bit needs chmod, text opens", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "tfm-exec-"));
    const bin = path.join(dir, "run.sh");
    writeFileSync(bin, "#!/bin/sh\necho hi\n");
    expect(classifyPath(bin)).toEqual({ executable: true, needsChmod: true });
    chmodSync(bin, 0o755);
    expect(classifyPath(bin)).toEqual({ executable: true, needsChmod: false });
    const txt = path.join(dir, "note.txt");
    writeFileSync(txt, "hello");
    expect(classifyPath(txt).executable).toBe(false);
  });
  test("missing path falls through to not-executable", () => {
    expect(classifyPath("/definitely/not/here-tfm-xyz").executable).toBe(false);
  });
});

describe("run helpers", () => {
  test("addExecBits mirrors read bits, never clobbers", () => {
    expect(addExecBits(0o644)).toBe(0o755);
    expect(addExecBits(0o600)).toBe(0o700);
    expect(addExecBits(0o444)).toBe(0o555);
    expect(addExecBits(0o755)).toBe(0o755);
  });
  test("prompt labels name the chmod when the bit is missing", () => {
    expect(executableChoiceLabels({ executable: true, needsChmod: false })[0]).toBe("Run");
    expect(executableChoiceLabels({ executable: true, needsChmod: true })[0]).toBe("Make executable and run");
    expect(executableChoiceLabels({ executable: true, needsChmod: true })[2]).toBe("Open anyway");
  });
});
