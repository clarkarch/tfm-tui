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
          TMP, // run INSIDE the sandbox dir so a stray write lands there
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
