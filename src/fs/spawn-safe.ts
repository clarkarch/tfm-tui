// --- Best-effort child-process spawn over Bun.spawn (measured ~2x faster
// than node spawn on awaited exits; fire-and-forget paths are unchanged).
// The audit invariant stands: a missing binary must NEVER throw and NEVER
// fire an async uncaughtException (that path kills the whole TUI via the
// crash handler) — it reports through onFail and returns null. Difference
// from the node version: onFail fires SYNCHRONOUSLY (Bun.spawn throws sync,
// there is no async error event), so callers null-guard the return.
// `detached` is accepted and ignored (Bun children are independent;
// unref() detaches); `stdio` keeps the node tuple shape so call sites are
// untouched. env defaults to a FRESH copy of process.env: Bun.spawn resolves
// the binary against a stale PATH otherwise (probed 1.4.0 — the places
// lsblk-stub test pins the fresh behavior). ---

import type { Subprocess } from "bun";

export type SpawnSafeStdio = "pipe" | "ignore" | "inherit";

export type SpawnSafeOpts = {
  cwd?: string;
  env?: Record<string, string | undefined>;
  // tuple (per-fd) or one value for all three, like node SpawnOptions
  stdio?:
    | SpawnSafeStdio
    | readonly [
        (SpawnSafeStdio | null | undefined)?,
        (SpawnSafeStdio | null | undefined)?,
        (SpawnSafeStdio | null | undefined)?,
      ];
  detached?: boolean;
  timeoutMs?: number;
  // unref the child so it does not pin the event loop (fire-and-forget
  // helpers like xdg-open)
  unref?: boolean;
};

type SpawnFail = (err: Error) => void;

const stdioOr = (v: SpawnSafeStdio | null | undefined, fallback: SpawnSafeStdio): SpawnSafeStdio => v ?? fallback;

export const spawnSafe = (
  cmd: string,
  args: string[],
  opts: SpawnSafeOpts = {},
  onFail: SpawnFail = () => {},
): Subprocess | null => {
  const { timeoutMs, detached: _detached, unref: doUnref, ...rest } = opts;
  void _detached;
  // string form ("ignore") applies to all three fds, like node SpawnOptions
  const stdio: readonly [
    (SpawnSafeStdio | null | undefined)?,
    (SpawnSafeStdio | null | undefined)?,
    (SpawnSafeStdio | null | undefined)?,
  ] = typeof rest.stdio === "string" ? [rest.stdio, rest.stdio, rest.stdio] : (rest.stdio ?? []);
  let proc: Subprocess;
  try {
    proc = Bun.spawn([cmd, ...args], {
      cwd: rest.cwd,
      env: rest.env ?? { ...process.env },
      stdin: stdioOr(stdio[0], "ignore"),
      stdout: stdioOr(stdio[1], "ignore"),
      stderr: stdioOr(stdio[2], "inherit"),
    });
  } catch (err) {
    onFail(err instanceof Error ? err : new Error(String(err)));
    return null;
  }
  // the child must not pin the event loop (fire-and-forget helpers)
  if (doUnref) proc.unref();
  // awaited flows (mount/unmount) need a backstop: a wedged helper otherwise
  // never resolves, never toasts, never dies
  if (timeoutMs && timeoutMs > 0) {
    const timer = setTimeout(() => {
      try {
        proc.kill("SIGCONT");
      } catch {}
      try {
        proc.kill("SIGKILL");
      } catch {}
    }, timeoutMs);
    void proc.exited.then(
      () => clearTimeout(timer),
      () => clearTimeout(timer),
    );
  }
  return proc;
};

// The spawn's FATE, settled ONCE: the spawn either started (ok) or failed
// with the error's message. Bun.spawn throws SYNCHRONOUSLY on a missing
// binary, so the promise settles in the same tick — and a promise settles
// once, so a caller can never receive two answers (the old callback shape
// could: a "failed" callback arriving after the caller had already moved on
// was a second, contradictory answer).
export type SpawnOutcome = { ok: true } | { ok: false; reason: string };

export const spawnOutcome = (
  cmd: string,
  args: string[],
  opts: SpawnSafeOpts = {},
  onFail?: (err: Error) => void,
): Promise<SpawnOutcome> =>
  new Promise((resolve) => {
    const proc = spawnSafe(cmd, args, opts, (err) => {
      onFail?.(err);
      resolve({ ok: false, reason: err.message });
    });
    if (proc) resolve({ ok: true });
  });
