import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";

// --- Best-effort child-process spawn. spawn() does NOT throw synchronously
// when the binary is missing — the try/catch at a call site does not help.
// It emits an ASYNC uncaughtException ("Executable not found in $PATH") which
// the crash handler (app/log.ts) turns into exit(1). Every fire-and-forget
// spawn must therefore attach an "error" listener immediately or opening a
// file on a system without xdg-open (headless, containers, minimal distros)
// kills the whole TUI. Returns the child (null never — spawn always returns
// on POSIX) with the listener armed; onFail receives the failure. ---

type SpawnFail = (err: Error) => void;

export const spawnSafe = (
  cmd: string,
  args: string[],
  opts: SpawnOptions & { timeoutMs?: number } = {},
  onFail: SpawnFail = () => {},
): ChildProcess => {
  const { timeoutMs, ...spawnOpts } = opts;
  const child = spawn(cmd, args, spawnOpts);
  child.on("error", (err) => onFail(err));
  // awaited flows (mount/unmount) need a backstop: a wedged helper otherwise
  // never resolves, never toasts, never dies
  if (timeoutMs && timeoutMs > 0) {
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {}
    }, timeoutMs);
    child.on("close", () => clearTimeout(timer));
    child.on("error", () => clearTimeout(timer));
  }
  return child;
};
