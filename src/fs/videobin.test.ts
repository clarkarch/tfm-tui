// Resolver contract: bundled sidecar first, never the system PATH.
import { mkdtempSync, rmSync } from "node:fs";
import { chmodSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "bun:test";
import { resetVideoBin, resolveVideoBin, SIDECAR_NAME, videoBin } from "./videobin";

const mkBin = (dir: string, name: string): string => {
  const p = path.join(dir, name);
  writeFileSync(p, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  chmodSync(p, 0o755);
  return p;
};

describe("resolveVideoBin lookup order", () => {
  test("explicit override wins over sidecar and dev binary", () => {
    const tmp = mkdtempSync(path.join(tmpdir(), "tfm-videobin-"));
    try {
      const override = mkBin(tmp, "custom-ffmpeg");
      const execDir = mkdtempSync(path.join(tmpdir(), "tfm-videobin-exec-"));
      try {
        mkBin(execDir, SIDECAR_NAME);
        const dev = mkBin(tmp, "dev-ffmpeg");
        expect(resolveVideoBin({ override, execDir, devBin: dev })).toEqual({ bin: override, source: "override" });
      } finally {
        rmSync(execDir, { recursive: true, force: true });
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("sidecar next to the executable beats the dev binary", () => {
    const execDir = mkdtempSync(path.join(tmpdir(), "tfm-videobin-exec-"));
    const tmp = mkdtempSync(path.join(tmpdir(), "tfm-videobin-"));
    try {
      const sidecar = mkBin(execDir, SIDECAR_NAME);
      const dev = mkBin(tmp, "dev-ffmpeg");
      expect(resolveVideoBin({ execDir, devBin: dev })).toEqual({ bin: sidecar, source: "sidecar" });
    } finally {
      rmSync(execDir, { recursive: true, force: true });
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("dev binary used when no override or sidecar exists", () => {
    const execDir = mkdtempSync(path.join(tmpdir(), "tfm-videobin-exec-"));
    const tmp = mkdtempSync(path.join(tmpdir(), "tfm-videobin-"));
    try {
      const dev = mkBin(tmp, "dev-ffmpeg");
      expect(resolveVideoBin({ execDir, devBin: dev })).toEqual({ bin: dev, source: "dev" });
    } finally {
      rmSync(execDir, { recursive: true, force: true });
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("null when nothing is runnable", () => {
    const execDir = mkdtempSync(path.join(tmpdir(), "tfm-videobin-exec-"));
    try {
      expect(resolveVideoBin({ execDir, devBin: null })).toBeNull();
    } finally {
      rmSync(execDir, { recursive: true, force: true });
    }
  });

  test("non-runnable override falls through to the sidecar", () => {
    const tmp = mkdtempSync(path.join(tmpdir(), "tfm-videobin-"));
    const execDir = mkdtempSync(path.join(tmpdir(), "tfm-videobin-exec-"));
    try {
      const dead = path.join(tmp, "not-executable");
      writeFileSync(dead, "nope");
      const sidecar = mkBin(execDir, SIDECAR_NAME);
      expect(resolveVideoBin({ override: dead, execDir, devBin: null })).toEqual({
        bin: sidecar,
        source: "sidecar",
      });
    } finally {
      rmSync(tmp, { recursive: true, force: true });
      rmSync(execDir, { recursive: true, force: true });
    }
  });

  test("missing override path falls through instead of failing", () => {
    const execDir = mkdtempSync(path.join(tmpdir(), "tfm-videobin-exec-"));
    const tmp = mkdtempSync(path.join(tmpdir(), "tfm-videobin-"));
    try {
      const dev = mkBin(tmp, "dev-ffmpeg");
      expect(resolveVideoBin({ override: path.join(tmp, "ghost"), execDir, devBin: dev })).toEqual({
        bin: dev,
        source: "dev",
      });
    } finally {
      rmSync(execDir, { recursive: true, force: true });
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("videoBin memoization", () => {
  test("caches the first resolution until reset", () => {
    resetVideoBin();
    try {
      const first = videoBin();
      expect(videoBin()).toBe(first);
    } finally {
      resetVideoBin();
    }
  });
});
