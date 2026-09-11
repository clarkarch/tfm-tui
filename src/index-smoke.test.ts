// --- Smoke test for the composition root itself: every other test covers a
// module in isolation, this one proves the WIRING boots — the instantiation
// order, the TDZ seam arrows and the renderer teardown. Spawn the real entry
// in a tmp cwd with an isolated config and assert the alternate-screen
// teardown frame (`?1049l`) lands in the output — a clean boot shows it even
// under SIGKILL (see AGENTS.md: bun ignores SIGTERM, so `timeout -k 2` is the
// only way a plain `timeout N` ever exits). ---

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const TMP = mkdtempSync(path.join(os.tmpdir(), "tfm-smoke-"));
afterAll(() => {
  rmSync(TMP, { recursive: true, force: true });
});

// skip when coreutils' timeout is missing — without it the boot cannot be
// bounded (bun ignores SIGTERM), so a hung boot would hang the whole suite
const bootTest = Bun.which("timeout") ? test : test.skip;

describe("index.ts smoke boot", () => {
  bootTest(
    "boots the real wiring and tears down the alternate screen",
    async () => {
      const configPath = path.join(TMP, "config.toml");
      writeFileSync(configPath, "# smoke: defaults\n");

      const proc = Bun.spawnSync({
        cmd: [
          "timeout",
          "-k",
          "2",
          "8",
          "bun",
          "src/index.ts",
          TMP, // launch dir: index.ts chdirs here, so tabs/history/session start inside the sandbox
        ],
        cwd: path.resolve(import.meta.dir, ".."),
        env: {
          ...process.env,
          TFM_CONFIG: configPath,
          XDG_DATA_HOME: path.join(TMP, "data"),
          XDG_CACHE_HOME: path.join(TMP, "cache"),
          TFM_DEBUG_LOG: path.join(TMP, "debug.log"),
        },
        stdout: "pipe",
        stderr: "pipe",
      });

      const out = new TextDecoder().decode(proc.stdout);
      // a clean boot leaves the alternate screen, even when timeout kills it
      expect(out).toContain("\x1b[?1049l");
    },
    15000,
  );
});

describe("index.ts --version", () => {
  test("--version prints the package version without booting the TUI", () => {
    const pkg = JSON.parse(readFileSync(path.resolve(import.meta.dir, "..", "package.json"), "utf8"));
    for (const flag of ["--version", "-v"]) {
      const proc = Bun.spawnSync({
        cmd: ["bun", "src/index.ts", flag],
        cwd: path.resolve(import.meta.dir, ".."),
        env: { ...process.env, TFM_CONFIG: path.join(TMP, "config.toml") },
        stdout: "pipe",
        stderr: "pipe",
      });
      const out = new TextDecoder().decode(proc.stdout);
      expect(out).toBe(`tfm ${pkg.version}\n`);
      // exits cleanly on its own — no timeout kill, no alternate screen
      expect(proc.exitCode).toBe(0);
      expect(out).not.toContain("\x1b[?1049");
    }
  });
});

describe("index.ts --help / bad flags", () => {
  // timeout-gated: if the fast path ever regresses these would boot the TUI and
  // a bare spawnSync would hang the suite (bun ignores SIGTERM)
  bootTest(
    "--help prints usage and exits 0 without booting",
    () => {
      const proc = Bun.spawnSync({
        cmd: ["timeout", "-k", "2", "8", "bun", "src/index.ts", "--help"],
        cwd: path.resolve(import.meta.dir, ".."),
        env: { ...process.env, TFM_CONFIG: path.join(TMP, "config.toml") },
        stdout: "pipe",
        stderr: "pipe",
      });
      const out = new TextDecoder().decode(proc.stdout);
      expect(out).toContain("Usage: tfm [OPTIONS] [PATH]");
      expect(out).toContain("--config");
      expect(proc.exitCode).toBe(0);
      expect(out).not.toContain("\x1b[?1049");
    },
    15000,
  );

  bootTest(
    "an unknown option exits 2 with a hint",
    () => {
      const proc = Bun.spawnSync({
        cmd: ["timeout", "-k", "2", "8", "bun", "src/index.ts", "--nope"],
        cwd: path.resolve(import.meta.dir, ".."),
        env: { ...process.env, TFM_CONFIG: path.join(TMP, "config.toml") },
        stdout: "pipe",
        stderr: "pipe",
      });
      const err = new TextDecoder().decode(proc.stderr);
      expect(err).toContain("unknown option '--nope'");
      expect(err).toContain("tfm --help");
      expect(proc.exitCode).toBe(2);
    },
    15000,
  );
});

describe("index.ts bad PATH", () => {
  // timeout-gated like the boot test: an unpatched build would boot the TUI
  // here instead of exiting, and a bare spawn would hang the suite
  bootTest(
    "a nonexistent PATH exits 1 without booting",
    () => {
      const proc = Bun.spawnSync({
        cmd: ["timeout", "-k", "2", "8", "bun", "src/index.ts", "/definitely/not/here"],
        cwd: path.resolve(import.meta.dir, ".."),
        env: { ...process.env, TFM_CONFIG: path.join(TMP, "config.toml") },
        stdout: "pipe",
        stderr: "pipe",
      });
      const err = new TextDecoder().decode(proc.stderr);
      const out = new TextDecoder().decode(proc.stdout);
      expect(err).toContain("no such file or directory");
      expect(proc.exitCode).toBe(1);
      // hard-fail BEFORE the renderer: no alternate-screen frame was emitted
      expect(out).not.toContain("\x1b[?1049");
    },
    15000,
  );
});
