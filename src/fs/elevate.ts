// --- sudo escalation leaf: privilege-error classification, exact sudo argv,
// and the cached-timestamp-first auth flow. No ui/renderer/state imports —
// callers inject prompt/notify/exec seams so tests never touch real sudo. ---
import { errCode } from "./fsutil";

export const isPrivilegeError = (err: unknown): boolean => {
  const code = errCode(err);
  if (code === "EACCES" || code === "EPERM") return true;
  // fsMove wraps cross-device rm failures as "source partially removed: <text>"
  // where the inner text already went through fsErrText ("permission denied");
  // tool stderr uses capital "Permission denied" — match case-insensitively
  if (err instanceof Error && /permission denied/i.test(err.message)) return true;
  return false;
};

export const sudoAvailable = (which: (bin: string) => string | null = Bun.which): boolean => which("sudo") !== null;

export const sudoCpArgv = (src: string, dest: string): string[] => ["sudo", "-n", "cp", "-a", "--", src, dest];
export const sudoMvArgv = (src: string, dest: string): string[] => ["sudo", "-n", "mv", "--", src, dest];
export const sudoRmArgv = (target: string): string[] => ["sudo", "-n", "rm", "-rf", "--", target];
export const sudoCatArgv = (file: string): string[] => ["sudo", "-n", "cat", "--", file];
export const sudoValidateArgv = (): string[] => ["sudo", "-S", "-v"];
export const sudoCachedArgv = (): string[] => ["sudo", "-n", "true"];
// Elevated default-open. Deliberately NO `--`: tfm only passes absolute
// paths (leading `/`, never parsed as options), and `--` is only legal when
// XDG_UTILS_ENABLE_DOUBLE_HYPEN=1 is visible — which sudo's env_reset strips,
// so with `--` the open always died as `unexpected option '--'`.
export const sudoOpenArgv = (file: string): string[] => ["sudo", "-n", "-E", "xdg-open", file];
// elevated chosen-app launch (Open With… on an unreadable file). Same no-`--`
// rule as the open above: both operands are absolute paths.
export const sudoLaunchArgv = (desktopFile: string, file: string): string[] => [
  "sudo",
  "-n",
  "-E",
  "gio",
  "launch",
  desktopFile,
  file,
];

export type SudoAuthDeps = {
  cached: () => Promise<boolean>;
  validate: (pw: string) => Promise<boolean>;
  prompt: (title: string, opLabel: string) => Promise<string | null>;
  notify: (msg: string, title?: string, level?: "info" | "success" | "error") => void;
  // injectable sudo probe (tests force "no sudo")
  available?: () => boolean;
};

// Cached timestamp first (no prompt), else up to 3 password attempts via the
// caller's prompt overlay. Password travels via stdin only — never argv.
export const ensureSudoAuth = async (deps: SudoAuthDeps, opLabel = "file operation"): Promise<boolean> => {
  if (await deps.cached()) return true;
  if (!(deps.available?.() ?? sudoAvailable())) {
    deps.notify("Permission denied (no sudo found)", "sudo", "error");
    return false;
  }
  for (let attempt = 0; attempt < 3; attempt++) {
    const pw = await deps.prompt(`Root required: ${opLabel}`, opLabel);
    if (pw === null) return false;
    if (await deps.validate(pw)) return true;
    deps.notify("Authentication failed", "sudo", "error");
  }
  return false;
};

// sudo child failed: keep the tool's first stderr line as the message, but
// carry EACCES when it says permission denied — otherwise fsErrText reduces
// "cp: …: Permission denied" to "cp" (message.split(":")[0]).
export const sudoExecError = (stderr: string): Error => {
  const line =
    stderr
      .split("\n")
      .map((l) => l.trim())
      .find(Boolean) ?? "permission denied";
  const err = new Error(line) as Error & { code?: string };
  if (/permission denied/i.test(stderr)) err.code = "EACCES";
  return err;
};
export type PromptOpen = (opts: {
  title: string;
  okLabel?: string;
  password?: boolean;
  placeholder?: string;
  initial?: string;
}) => Promise<string | null>;

// Shared password gate for wirings: cached timestamp first, else the prompt
// overlay (password mode) piped to `sudo -S -v` via stdin — never argv.
export const makeEnsureSudo = (deps: {
  getPrompt: () => { open: PromptOpen };
  notify: SudoAuthDeps["notify"];
  // injectable child runner (tests fake it; default = runSudo)
  exec?: (argv: string[], stdin?: string) => Promise<{ status: number | null }>;
}): ((opLabel: string) => Promise<boolean>) => {
  const exec =
    deps.exec ??
    ((argv: string[], stdin?: string): Promise<{ status: number | null }> =>
      runSudo(argv, stdin !== undefined ? { stdin } : undefined).then(
        (r) => ({ status: r.status }),
        () => ({ status: null }),
      ));
  return (opLabel: string): Promise<boolean> =>
    ensureSudoAuth(
      {
        cached: async () => (await exec(sudoCachedArgv())).status === 0,
        validate: async (pw) => (await exec(sudoValidateArgv(), pw)).status === 0,
        prompt: (title) => deps.getPrompt().open({ title, okLabel: "Authenticate", password: true }),
        notify: deps.notify,
      },
      opLabel,
    );
};
export const runSudo = async (
  argv: string[],
  opts?: { stdin?: string; timeoutMs?: number },
): Promise<{ status: number | null; stdout: string; stderr: string }> => {
  const proc = Bun.spawn(argv, {
    stdin: opts?.stdin !== undefined ? "pipe" : "ignore",
    stdout: "pipe",
    stderr: "pipe",
    timeout: opts?.timeoutMs ?? 120_000,
  });
  if (opts?.stdin !== undefined && proc.stdin && typeof proc.stdin !== "number") {
    const w = proc.stdin as unknown as { write(s: string): void; end(): void };
    w.write(opts.stdin.endsWith("\n") ? opts.stdin : `${opts.stdin}\n`);
    w.end();
  }
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  await proc.exited;
  return { status: proc.exitCode, stdout: out, stderr: err };
};
