import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSafe } from "./spawn-safe";
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
    const id = m[1]!;
    if (!seen.has(id)) {
      seen.add(id);
      ids.push(id);
    }
  }
  return ids;
};

export type AppChoice = { id: string; name: string; file: string };

// launchable handlers for a file: default + registered apps that resolve to a
// real .desktop file. `run` is injectable so tests never shell out.
export const appsForFile = async (
  p: string,
  run: (cmd: string[]) => Promise<string> = runOutShort,
): Promise<AppChoice[]> => {
  try {
    const mime = await run(["xdg-mime", "query", "filetype", p]);
    if (!mime) return [];
    const ids = parseGioMime(await run(["gio", "mime", mime]));
    const out: AppChoice[] = [];
    for (const id of ids) {
      const file = desktopFilePath(id);
      if (!file) continue;
      out.push({ id, name: await desktopAppName(id), file });
    }
    return out;
  } catch {
    return [];
  }
};

// fire-and-forget launch through gio (detached so the app outlives the spawn)
export const launchApp = (desktopFile: string, file: string, onFail?: (e: Error) => void): void => {
  spawnSafe("gio", ["launch", desktopFile, file], { stdio: "ignore", detached: true }, onFail);
};
