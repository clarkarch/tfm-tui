// Resolver contract: $TFM_FFMPEG override first, else `ffmpeg` on PATH. tfm
// never bundles an ffmpeg — the system package is an optional dependency and
// a missing one just leaves plain video icons.
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "bun:test";
import { resetVideoBin, resolveVideoBin, videoBin } from "./videobin";

const mkBin = (dir: string, name: string): string => {
  const p = path.join(dir, name);
  writeFileSync(p, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  chmodSync(p, 0o755);
  return p;
};

describe("resolveVideoBin lookup order", () => {
  test("explicit override wins over the PATH binary", () => {
    const tmp = mkdtempSync(path.join(tmpdir(), "tfm-videobin-"));
    try {
      const override = mkBin(tmp, "custom-ffmpeg");
      const onPath = mkBin(tmp, "ffmpeg");
      expect(resolveVideoBin({ override, which: () => onPath })).toEqual({ bin: override, source: "override" });
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("system ffmpeg on PATH is used when no override exists", () => {
    const tmp = mkdtempSync(path.join(tmpdir(), "tfm-videobin-"));
    try {
      const onPath = mkBin(tmp, "ffmpeg");
      expect(resolveVideoBin({ override: "", which: () => onPath })).toEqual({ bin: onPath, source: "path" });
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("non-runnable override falls through to the PATH binary", () => {
    const tmp = mkdtempSync(path.join(tmpdir(), "tfm-videobin-"));
    try {
      const dead = path.join(tmp, "not-executable");
      writeFileSync(dead, "nope");
      const onPath = mkBin(tmp, "ffmpeg");
      expect(resolveVideoBin({ override: dead, which: () => onPath })).toEqual({ bin: onPath, source: "path" });
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("missing override path falls through to the PATH binary", () => {
    const tmp = mkdtempSync(path.join(tmpdir(), "tfm-videobin-"));
    try {
      const onPath = mkBin(tmp, "ffmpeg");
      expect(resolveVideoBin({ override: path.join(tmp, "ghost"), which: () => onPath })).toEqual({
        bin: onPath,
        source: "path",
      });
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("null when there is no override and no ffmpeg on PATH", () => {
    expect(resolveVideoBin({ override: "", which: () => null })).toBeNull();
  });

  // The default probe must pass the LIVE PATH to Bun.which: its cached default
  // resolves against the PATH at first use, so a runtime-prepended dir is
  // ignored (the same staleness class as Bun.spawn — see AGENTS "Bun-only
  // migration"). Probed 1.4.0: cached default returns null here, explicit
  // PATH returns the stub.
  test("the default probe honors a freshly prepended PATH dir", () => {
    const tmp = mkdtempSync(path.join(tmpdir(), "tfm-videobin-path-"));
    const prevPath = process.env.PATH;
    const prevOverride = process.env.TFM_FFMPEG;
    try {
      const stub = mkBin(tmp, "ffmpeg");
      delete process.env.TFM_FFMPEG;
      process.env.PATH = `${tmp}:${prevPath ?? ""}`;
      expect(resolveVideoBin()).toEqual({ bin: stub, source: "path" });
    } finally {
      if (prevPath === undefined) delete process.env.PATH;
      else process.env.PATH = prevPath;
      if (prevOverride === undefined) delete process.env.TFM_FFMPEG;
      else process.env.TFM_FFMPEG = prevOverride;
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
