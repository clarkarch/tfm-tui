import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { xdgDataHome } from "./uri";

// --- Resolving what xdg-open would launch, so the "open" toast can say what
// launched. Process/FS probing only — no renderer/state imports. ---

// run a command with a short timeout; returns trimmed stdout, "" on failure
export const runOutShort = async (cmd: string[], timeoutMs = 1500): Promise<string> => {
  try {
    const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "ignore", stdin: "ignore" });
    const timer = setTimeout(() => { try { proc.kill(); } catch {} }, timeoutMs);
    const out = (await new Response(proc.stdout).text()).trim();
    clearTimeout(timer);
    return out;
  } catch { return ""; }
};

// human name for a desktop id: first non-localized Name= inside [Desktop Entry]
export const desktopAppName = async (desktopId: string): Promise<string> => {
  if (!desktopId) return "";
  const dirs = [
    path.join(xdgDataHome(), "applications"),
    "/usr/local/share/applications",
    "/usr/share/applications",
    "/var/lib/flatpak/exports/share/applications",
    path.join(os.homedir(), ".local/share/flatpak/exports/share/applications"),
  ];
  for (const d of dirs) {
    try {
      // first non-localized Name= inside [Desktop Entry]
      const m = readFileSync(path.join(d, desktopId), "utf8").match(/^\[Desktop Entry\][\s\S]*?^Name=(.+)$/m);
      if (m?.[1]) return m[1].trim();
    } catch {}
  }
  return desktopId.replace(/\.desktop$/, "");
};

// what xdg-open would launch for p: mime probe → default handler → app name
export const appForFile = async (p: string): Promise<string> => {
  try {
    const mime = await runOutShort(["xdg-mime", "query", "filetype", p]);
    if (mime) return await desktopAppName(await runOutShort(["xdg-mime", "query", "default", mime]));
  } catch {}
  return "";
};
