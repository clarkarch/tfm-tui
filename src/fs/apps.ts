import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSafe } from "./spawn-safe";
import { runSudo, sudoLaunchArgv, sudoOpenArgv } from "./elevate";
import { extOf, mimeForExt } from "./filetype";
import type { NotifyLevel } from "../lib/notify-level";
import { xdgDataHome } from "./uri";

// --- Resolving what xdg-open would launch, so the "open" toast can say what
// launched, plus the "Open With…" chooser (enumerate `gio mime` handlers).
// Process/FS probing only — no renderer/state imports. ---

// run a command with a short timeout; returns trimmed stdout, "" on failure
export const runOutShort = async (cmd: string[], timeoutMs = 1500): Promise<string> => {
  try {
    const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "ignore", stdin: "ignore", timeout: timeoutMs });
    return (await new Response(proc.stdout).text()).trim();
  } catch {
    return "";
  }
};

const applicationDirs = (): string[] => [
  path.join(xdgDataHome(), "applications"),
  "/usr/local/share/applications",
  "/usr/share/applications",
  "/var/lib/flatpak/exports/share/applications",
  path.join(os.homedir(), ".local/share/flatpak/exports/share/applications"),
];

// human name for a desktop id: first non-localized Name= inside [Desktop Entry]
export const desktopAppName = async (desktopId: string): Promise<string> => {
  if (!desktopId) return "";
  for (const d of applicationDirs()) {
    try {
      // first non-localized Name= inside [Desktop Entry]
      const m = readFileSync(path.join(d, desktopId), "utf8").match(/^\[Desktop Entry\][\s\S]*?^Name=(.+)$/m);
      if (m?.[1]) return m[1].trim();
    } catch {}
  }
  return desktopId.replace(/\.desktop$/, "");
};

// absolute path of a desktop id (needed by `gio launch`), or null when unknown
export const desktopFilePath = (desktopId: string): string | null => {
  if (!desktopId) return null;
  for (const d of applicationDirs()) {
    const p = path.join(d, desktopId);
    if (existsSync(p)) return p;
  }
  return null;
};

// what xdg-open would launch for p: mime probe → default handler → app name
export const appForFile = async (p: string): Promise<string> => {
  try {
    const mime = await runOutShort(["xdg-mime", "query", "filetype", p]);
    if (mime) return await desktopAppName(await runOutShort(["xdg-mime", "query", "default", mime]));
  } catch {}
  return "";
};

// `gio mime <type>` output → desktop ids, in order (default first, deduped)
export const parseGioMime = (out: string): string[] => {
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const m of out.matchAll(/([A-Za-z0-9_.+-]+\.desktop)/g)) {
    const id = m[1];
    if (id === undefined) continue;
    if (!seen.has(id)) {
      seen.add(id);
      ids.push(id);
    }
  }
  return ids;
};

export type AppChoice = { id: string; name: string; file: string };

// launchable handlers for a file: default + registered apps that resolve to a
// real .desktop file. `run` is injectable so tests never shell out. Content
// probe first (accurate for shebangs/odd bytes); when it fails (EACCES on a
// root-owned file) OR yields zero handlers (empty files sniff as
// inode/x-empty, which nothing registers), fall back to ext→mime — `gio mime`
// needs no file access. `mimeByExt` is injectable so tests don't depend on
// the boot-loaded globs2 cache.
export const appsForFile = async (
  p: string,
  run: (cmd: string[]) => Promise<string> = runOutShort,
  mimeByExt: (ext: string) => string | undefined = mimeForExt,
): Promise<AppChoice[]> => {
  const collect = async (mime: string): Promise<AppChoice[]> => {
    const ids = parseGioMime(await run(["gio", "mime", mime]));
    const out: AppChoice[] = [];
    for (const id of ids) {
      const file = desktopFilePath(id);
      if (!file) continue;
      out.push({ id, name: await desktopAppName(id), file });
    }
    return out;
  };
  // one mime's probe failure must not skip the other mime's chance (custom
  // runners can throw; the default never does)
  const tryCollect = async (mime: string): Promise<AppChoice[]> => {
    try {
      return await collect(mime);
    } catch {
      return [];
    }
  };
  try {
    const probed = await run(["xdg-mime", "query", "filetype", p]);
    if (probed) {
      const apps = await tryCollect(probed);
      if (apps.length) return apps;
    }
    const extMime = mimeByExt(extOf(p));
    if (extMime && extMime !== probed) return tryCollect(extMime);
    return [];
  } catch {
    return [];
  }
};

// fire-and-forget launch through gio (detached so the app outlives the spawn)
export const launchApp = (desktopFile: string, file: string, onFail?: (e: Error) => void): void => {
  spawnSafe("gio", ["launch", desktopFile, file], { stdio: "ignore", detached: true }, onFail);
};

// Shared gate+exec core behind both escalation primitives below: one password
// gate, then the awaited elevated child with honest toasts (never a lying
// "Opening …"). Never rejects (gate-cancel stays silent), so callers can
// fire-and-forget it.
type ElevatedDeps = {
  ensureSudo: (opLabel: string) => Promise<boolean>;
  exec?: (argv: string[]) => Promise<{ status: number | null; stderr: string }>;
  notify: (msg: string, title?: string, level?: NotifyLevel) => void;
  log: (msg: string) => void;
};

const runElevated = async (
  deps: ElevatedDeps,
  tag: "open-as-root" | "launch-as-root",
  opLabel: string,
  file: string,
  argv: string[],
  openedMsg: string,
  failedPrefix: string,
): Promise<void> => {
  const exec =
    deps.exec ??
    ((a: string[]): Promise<{ status: number | null; stderr: string }> => runSudo(a, { timeoutMs: 30_000 }));
  let ok = false;
  try {
    ok = await deps.ensureSudo(opLabel);
  } catch (err) {
    deps.log(`${tag} gate failed: ${err}`);
  }
  if (!ok) return;
  let r: { status: number | null; stderr: string };
  try {
    r = await exec(argv);
  } catch (err) {
    deps.log(`${tag} exec failed: ${err}`);
    deps.notify(`${failedPrefix} · ${err instanceof Error ? err.message : err}`, "open", "error");
    return;
  }
  if (r.status === 0) {
    deps.notify(openedMsg, "open", "info");
    return;
  }
  const why =
    r.stderr
      .split("\n")
      .map((l) => l.trim())
      .find(Boolean) ?? `exit ${r.status}`;
  deps.log(`${tag} failed for ${file}: ${why}`);
  deps.notify(
    `${failedPrefix} · ${why}${tag === "open-as-root" ? " (try sudoedit in a terminal)" : ""}`,
    "open",
    "error",
  );
};

// Escalation primitive behind the adaptive open: password gate first, then
// the default app as root. `exec` is injectable so tests capture argv without
// spawning.
export const makeOpenAsRoot = (deps: ElevatedDeps): ((p: string) => Promise<void>) => {
  return (p: string): Promise<void> =>
    runElevated(
      deps,
      "open-as-root",
      `open ${path.basename(p)} as root`,
      p,
      sudoOpenArgv(p),
      `Opening ${path.basename(p)} as root`,
      `Can't open ${path.basename(p)} as root`,
    );
};

// Escalation primitive behind Open With… on unreadable files: password gate
// first, then the CHOSEN app as root. Same honest-toast contract as above
// (GUI apps as root may still fail on Wayland — the toast will say why).
export const makeLaunchAppAsRoot = (
  deps: ElevatedDeps,
): ((desktopFile: string, appName: string, p: string) => Promise<void>) => {
  return (desktopFile: string, appName: string, p: string): Promise<void> =>
    runElevated(
      deps,
      "launch-as-root",
      `open ${path.basename(p)} with ${appName} as root`,
      p,
      sudoLaunchArgv(desktopFile, p),
      `Opening ${path.basename(p)} · ${appName} as root`,
      `Can't open ${path.basename(p)} with ${appName} as root`,
    );
};
