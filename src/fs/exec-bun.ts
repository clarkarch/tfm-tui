// --- Awaited exec over Bun.spawn (replaces promisified node execFile).
// Measured ~2.7x faster than execFile on small outputs (lsblk/clipboard/gio
// reads). Same never-throws contract as runArchiveTool: a missing binary or
// any spawn failure resolves { code: -1 } with the message in stderr, and a
// timeoutMs expiry SIGKILLs (SIGCONT first — a paused child ignores SIGKILL
// until resumed) and resolves code -1 like any spawn failure. ---

export type ExecBunResult = { code: number; stdout: string; stderr: string };

// "pipe" was requested, but the type is a union (fd passthrough): anything
// non-streaming resolves empty rather than throwing into the caller.
const streamText = (s: unknown): Promise<string> =>
  s instanceof ReadableStream ? new Response(s as ReadableStream<Uint8Array>).text() : Promise.resolve("");

export const execBun = async (
  cmd: string,
  args: string[],
  opts: { cwd?: string; timeoutMs?: number } = {},
): Promise<ExecBunResult> => {
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn([cmd, ...args], {
      cwd: opts.cwd,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      // explicit env copy: Bun.spawn resolves the binary against a STALE
      // PATH without it (probed 1.4.0 — a runtime-prepended stub dir is
      // ignored, the real binary runs), while node re-reads PATH per call.
      // The places lsblk-stub test pins the fresh-PATH behavior.
      env: { ...process.env },
    });
  } catch (err) {
    return { code: -1, stdout: "", stderr: err instanceof Error ? err.message : String(err) };
  }
  let timer: ReturnType<typeof setTimeout> | null = null;
  if (opts.timeoutMs && opts.timeoutMs > 0) {
    timer = setTimeout(() => {
      try {
        proc.kill("SIGCONT");
      } catch {}
      try {
        proc.kill("SIGKILL");
      } catch {}
    }, opts.timeoutMs);
  }
  try {
    const [stdout, stderr, code] = await Promise.all([streamText(proc.stdout), streamText(proc.stderr), proc.exited]);
    if (timer !== null) clearTimeout(timer);
    // a timeout kill lands here as a non-zero/signal exit: report it as the
    // timeout failure, not as the tool's own code
    if (timer !== null && code !== 0 && (proc.signalCode === "SIGKILL" || proc.signalCode === "SIGTERM")) {
      return {
        code: -1,
        stdout,
        stderr: `${stderr}${stderr.endsWith("\n") || stderr === "" ? "" : "\n"}timed out after ${opts.timeoutMs}ms`,
      };
    }
    return { code: code ?? -1, stdout, stderr };
  } catch (err) {
    if (timer !== null) clearTimeout(timer);
    return { code: -1, stdout: "", stderr: err instanceof Error ? err.message : String(err) };
  }
};
