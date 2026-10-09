// --- Smoke test for the composition root itself: every other test covers a
// module in isolation, this one proves the WIRING boots — the instantiation
// order, the TDZ seam arrows and the renderer teardown. Spawn the real entry
// in a tmp cwd with an isolated config and assert the alternate-screen
// teardown frame (`?1049l`) lands in the output. Boot is polled, not slept:
// cold/loaded boots (transpile + the 2s pixel probe + first render ≈ 4s warm,
// more under parallel-suite load) outlast any fixed `timeout 8` budget, and
// bun ignores SIGTERM so a plain `timeout N` always pays its full window
// anyway — `timeout -k 2` stays the recipe for manual smoke runs (see
// AGENTS.md), but here the test bounds the wait itself. ---

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const TMP = mkdtempSync(path.join(os.tmpdir(), "tfm-smoke-"));
afterAll(() => {
  rmSync(TMP, { recursive: true, force: true });
});

// skip when coreutils' timeout is missing — the --help/--version/bad-flag
// probes below bound their boots with it (a hung boot would hang the suite);
// the wiring boot itself is bounded internally (poll deadlines), no binary
// needed
const bootTest = Bun.which("timeout") ? test : test.skip;

// cold boots under parallel-suite load outlast the 5s default (same load
// story as the fileops 20s pins) — the wiring boot owns its budget
const BOOT_BUDGET_MS = 45000;

describe("index.ts smoke boot", () => {
  test(
    "boots the real wiring and tears down the alternate screen",
    async () => {
      const configPath = path.join(TMP, "config.toml");
      writeFileSync(configPath, "# smoke: defaults\n");

      const proc = Bun.spawn(["bun", "src/index.ts", TMP], {
        // TMP is the launch dir: index.ts chdirs there, so tabs/history/session start inside the sandbox
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

      let out = "";
      let err = "";
      const decoder = new TextDecoder();
      const drain = async (stream: ReadableStream<Uint8Array> | null, append: (s: string) => void): Promise<void> => {
        if (!stream) return;
        const reader = stream.getReader();
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            append(decoder.decode(value, { stream: true }));
          }
        } catch {
          // teardown races the kill below; a read throw just ends the drain
        } finally {
          reader.releaseLock();
        }
      };
      const outDone = drain(proc.stdout as ReadableStream<Uint8Array> | null, (s) => {
        out += s;
      });
      const errDone = drain(proc.stderr as ReadableStream<Uint8Array> | null, (s) => {
        err += s;
      });

      const ENTER = "\x1b[?1049h";
      const LEAVE = "\x1b[?1049l";
      const poll = async (ready: () => boolean, budgetMs: number): Promise<void> => {
        const start = Date.now();
        // proc.exitCode !== null ends the wait early: a fast-path exit (bad
        // path, crash) leaves stdout empty by design, no point burning the cap
        while (!ready() && proc.exitCode === null && Date.now() - start < budgetMs) {
          await new Promise((r) => setTimeout(r, 50));
        }
      };
      // wait for the alternate-screen enter frame: the observable "booted"
      await poll(() => out.includes(ENTER), 30000);
      // TERM asks OpenTUI to run destroy() (which writes `?1049l`) — bun
      // itself ignores it, so escalate to KILL like `timeout -k` does
      try {
        proc.kill("SIGTERM");
      } catch {}
      await poll(() => out.includes(LEAVE), 5000);
      try {
        proc.kill("SIGKILL");
      } catch {}
      await proc.exited;
      await Promise.all([outDone, errDone]);

      // stderr rides along in the message: an early exit leaves stdout empty
      // by design, so a bare "" failure would hide where the boot went
      expect(`${out}\n<stderr>${err}`).toContain(LEAVE);
      // teardown alone is not health: a boot that crashes yet still tears
      // down must fail here, not ride green into a release (the crash
      // handler announces `[tfm] crash` on stderr; native OOM surfaces as
      // `Failed to create …` from the renderer)
      expect(err).not.toContain("[tfm] crash");
      expect(err).not.toContain("[tfm] unhandled rejection");
      expect(err).not.toContain("Failed to create");
    },
    BOOT_BUDGET_MS,
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
