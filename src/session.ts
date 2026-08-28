import { readFileSync, statSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { RECENT_URI, STARRED_URI, isVirtualUri } from "./uri";
import type { Tab } from "./tabs";

// --- Session persistence: tabs (each with its own history) survive restarts.
// Pure read/write of the session document; the caller owns when to save and
// how to adopt the restored slots. ---

export type SessionTab = Tab;

export const sessionFile = (): string =>
  path.join(process.env.XDG_STATE_HOME ?? path.join(os.homedir(), ".local/state"), "tfm", "session.json");

export const saveSession = async (cwd: string, tabs: SessionTab[], activeTab: number): Promise<void> => {
  await mkdir(path.dirname(sessionFile()), { recursive: true });
  await writeFile(sessionFile(), JSON.stringify({ cwd, tabs, activeTab }));
};

// directory check shared with virtual places: recent/starred URIs are always
// "usable", other virtual URIs are not, real paths must be existing dirs
const usable = (p: string): boolean => {
  if (isVirtualUri(p)) return p === RECENT_URI || p === STARRED_URI;
  try { return statSync(p).isDirectory(); } catch { return false; }
};

// Parse + sanitize the session file. Returns null when there is nothing to
// restore (missing file, garbage JSON, or no tab with a usable history) —
// callers then keep their default tab.
export const readRestoredSession = (): { tabs: SessionTab[]; activeTab: number } | null => {
  try {
    const doc = JSON.parse(readFileSync(sessionFile(), "utf8"));
    if (Array.isArray(doc?.tabs)) {
      const restored: SessionTab[] = [];
      for (const t of doc.tabs) {
        const hist: string[] = Array.isArray(t?.history)
          ? t.history.filter((p: unknown) => typeof p === "string" && usable(p as string))
          : [];
        if (!hist.length) continue;
        restored.push({ history: hist, histIdx: Math.min(Math.max(0, t.histIdx | 0), hist.length - 1) });
      }
      if (restored.length) {
        return {
          tabs: restored,
          activeTab: Math.min(Math.max(0, doc.activeTab | 0), restored.length - 1),
        };
      }
      return null;
    }
    // legacy single-cwd session file
    const cwd = typeof doc?.cwd === "string" ? doc.cwd : "";
    if (cwd && cwd !== RECENT_URI && cwd !== STARRED_URI) {
      try {
        if (statSync(cwd).isDirectory()) return { tabs: [{ history: [cwd], histIdx: 0 }], activeTab: 0 };
      } catch {}
    }
  } catch {}
  return null;
};
