import { accessSync, constants } from "node:fs";
import { spawnSync, type SpawnSyncOptions } from "node:child_process";
import type { NotifyLevel } from "../lib/notify-level";
import { runTeardownSteps, type QuitCtx } from "./quit";

// --- Restart: relaunch the same binary with the same args, then WAIT for the
// child (spawnSync, same process group, inherited stdio) before tearing down.
// Why the parent must outlive the child: the shell wakes the moment its
// foreground job exits and steals both the foreground and the input — a
// fire-and-forget detached child ends up competing with the shell for every
// key/mouse byte (the bytes echo as garbage, input dies, stray digits become
// phantom search queries). Staying the shell's foreground job the whole time
// makes the handoff byte-clean (probed: shell prints no prompt mid-handoff,
// the child receives every byte, the exit code propagates).
// Display teardown is SKIPPED before spawn: the renderer stays alive (alt
// screen + raw mode carry over; the child re-inits idempotently and pairs its
// own teardown LIFO), so a failed spawn recovers with a plain re-render.
// The session IS flushed first so a restore-session child picks up live tabs.
// Leaf: process identity + spawn arrive via params so tests inject fakes; the
// only I/O defaults are node:child_process / node:fs. ---

export type RestartSpawn = (
  cmd: string,
  args: string[],
  opts: SpawnSyncOptions,
) => { status: number | null; error?: unknown };

export type RestartCheck = (path: string) => void;

// set in the child's env at spawn; the child's boot clears the previous
// generation's kitty placements when (and only when) it sees this (restart
// re-sets it explicitly, so nested restarts keep working)
export const RESTART_ENV = "TFM_RESTART";

// Spawn args for the restart child, for a spawn of `execPath`.
// The compiled binary's runtime injects argv=["bun", "/$bunfs/root/tfm",
// ...userArgs] (probed 2026-09): the virtual entry must be stripped or the
// child treats it as a PATH (exit 1). The dev runner (`bun src/index.ts …`)
// is the SAME process as execPath but DOES need its script re-passed — strip
// it and the child runs `bun <first-user-arg>` (Module not found). So strip
// the script token ONLY when the entry differs from the executable we spawn.
export const restartArgs = (argv: string[], execPath = ""): string[] => {
  const rest = argv.slice(1);
  const script = rest[0] ?? "";
  const isScriptToken = /index\.[tj]s$/.test(script) || script.startsWith("/$bunfs/");
  if (!isScriptToken || !rest.length) return rest;
  // argv[0] === execPath means we re-spawn the interpreter (dev): keep the script
  return argv[0] === execPath ? rest : rest.slice(1);
};

// read-and-clear the restart-generation marker. UNCONDITIONAL by design: a
// stale "1" (user-exported, or inherited from a shell spawned before the
// cleanup existed) must never misdetect a fresh boot as a restart child and
// nuke other programs' images.
export const consumeRestartFlag = (env: Record<string, string | undefined>): boolean => {
  const marked = env[RESTART_ENV] === "1";
  delete env[RESTART_ENV];
  return marked;
};

export type RestartCtx = QuitCtx & {
  execPath: string;
  argv: string[];
  spawn?: RestartSpawn;
  preflight?: RestartCheck;
  // file-op activity probe (wiring: shared queue depth) — refusing while
  // busy beats killing a live transfer (see below)
  isBusy?: () => boolean;
  // re-arm after a failed spawn (renderer is still alive). Restores what has
  // a clean seam (wiring re-enables drops + shift-capture, then re-renders);
  // one-way steps stay lost: the PTY pane is closed (reopen with F4) and
  // plugin instances stay deactivated until the next boot.
  recover?(): void;
  notify?(msg: string, title?: string, level?: NotifyLevel): void;
};

const defaultSpawn: RestartSpawn = (cmd, args, opts) => spawnSync(cmd, args, opts);

const defaultPreflight: RestartCheck = (p) => accessSync(p, constants.X_OK);

export const makeRestart =
  (ctx: RestartCtx): (() => void) =>
  () => {
    const fail = (msg: string): void => {
      ctx.notify?.(msg, "restart", "error");
    };
    // executable check BEFORE touching live state: teardown has one-way steps
    // (PTY kill, drops off), so a missing binary must never reach it
    try {
      (ctx.preflight ?? defaultPreflight)(ctx.execPath);
    } catch (err) {
      fail(`restart failed: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    // refuse while file ops are in flight: the parent loop freezes inside
    // spawnSync, and the child's orphan sweep could delete the paused op's
    // staging temp mid-copy (the op would die silently once resumed)
    if ((ctx.isBusy ?? (() => false))()) {
      ctx.notify?.("Can't restart during file operations", "restart", "error");
      return;
    }
    const preFailed = runTeardownSteps(ctx);
    let status: number | null;
    try {
      // same group (NOT detached) + inherited stdio: the child shares the
      // foreground with the waiting parent, so the shell never wakes mid-run.
      // spawnSync ENOENT does NOT throw — it returns { status: null, error },
      // so a binary vanishing between preflight and spawn must reuse the
      // failure path explicitly or the session vanishes with no toast.
      const res = (ctx.spawn ?? defaultSpawn)(ctx.execPath, [...ctx.argv], {
        stdio: "inherit",
        env: { ...process.env, [RESTART_ENV]: "1" },
      });
      if (res.error) throw res.error;
      status = res.status;
    } catch (err) {
      try {
        ctx.recover?.();
      } catch {}
      fail(`restart failed: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    let failed = preFailed;
    try {
      ctx.destroy();
    } catch {
      failed = true;
    }
    // teardown failure wins over the child status (deliberate, matches quit's
    // honest-code rule: a broken shutdown must never exit 0)
    ctx.exit(failed ? 1 : (status ?? 1));
  };
