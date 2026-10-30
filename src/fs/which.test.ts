// The PATH probe is the ONE place that resolves a binary by name. Bun.which
// caches PATH per process, so the bare call resolves against the PATH at
// FIRST use — a dir added later (or a runtime-prepended stub dir) is
// invisible. That silently hid `fd`, `tar`, `7z`, `gio` and `git` from tfm
// depending on what had been probed first.
//
// Two contracts:
//   1. whichLive honors a freshly prepended PATH dir (the behavior).
//   2. No source file calls the bare `Bun.which(` again (the no-drift rule).
import { chmodSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "bun:test";
import { whichLive } from "./which";

const collectTsFiles = (dir: string): string[] => {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) out.push(...collectTsFiles(p));
    else if (name.endsWith(".ts")) out.push(p);
  }
  return out;
};

const mkBin = (dir: string, name: string): string => {
  const p = path.join(dir, name);
  writeFileSync(p, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  chmodSync(p, 0o755);
  return p;
};

describe("whichLive", () => {
  test("finds a binary on the current PATH", () => {
    expect(whichLive("sh")).not.toBeNull();
  });

  test("returns null for a binary that does not exist", () => {
    expect(whichLive("tfm-no-such-binary-xyz")).toBeNull();
  });

  // The whole point of the leaf: a dir prepended to PATH AFTER the process
  // started must still be visible. Probed 1.4.0 — the cached bare
  // `Bun.which` returns null here, the explicit-PATH probe finds the stub.
  test("honors a freshly prepended PATH dir", () => {
    const tmp = mkdtempSync(path.join(tmpdir(), "tfm-which-"));
    const prevPath = process.env.PATH;
    try {
      const stub = mkBin(tmp, "tfm-which-stub");
      process.env.PATH = `${tmp}:${prevPath ?? ""}`;
      expect(whichLive("tfm-which-stub")).toBe(stub);
    } finally {
      if (prevPath === undefined) delete process.env.PATH;
      else process.env.PATH = prevPath;
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("no-drift rule", () => {
  // The bug this leaf exists to prevent was ALREADY fixed once (in
  // videobin.ts) and never propagated — 13 other call sites kept the stale
  // bare form. A behavioral test cannot catch that class, so the rule is
  // enforced structurally: the bare call may not come back.
  test("no source file calls the bare Bun.which(", async () => {
    const root = path.resolve(import.meta.dir, "..");
    const offenders: string[] = [];
    for (const file of collectTsFiles(root)) {
      if (file.endsWith(".test.ts")) continue;
      // the leaf itself owns the one legal call
      if (file === path.join(root, "fs", "which.ts")) continue;
      // comments are stripped first: the prose that explains this rule must
      // not trip it. Both the CALL form and the bare-reference form (a
      // `which: WhichFn = Bun.which` default parameter) count.
      const src = (await Bun.file(file).text()).replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
      if (/\bBun\.which\b/.test(src)) offenders.push(path.relative(root, file));
    }
    expect(offenders).toEqual([]);
  });
});
