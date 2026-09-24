import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { RECENT_URI, STARRED_URI, isVirtualUri } from "./uri";
import type { Tab } from "../app/tabs";

// --- Session persistence: each pane's tab list survives restarts, plus which
// pane was focused. Pure read/write of the session document; the caller owns
// when to save and how to adopt the restored slots. Legacy docs — the
// shared-tabs dual format ({tabs:[{panes:[left,right]}]}), the pre-dual-pane
// per-tab {history,histIdx}, and the old single {cwd} — all still read. ---

export const sessionFile = (): string =>
  path.join(process.env.XDG_STATE_HOME ?? path.join(os.homedir(), ".local/state"), "tfm", "session.json");

export type PaneTabs = { tabs: Tab[]; activeTab: number };
export type RestoredSession = { panes: [PaneTabs, PaneTabs]; activePane: 0 | 1 };

export const saveSession = async (panes: [PaneTabs, PaneTabs], activePane: 0 | 1): Promise<void> => {
  await mkdir(path.dirname(sessionFile()), { recursive: true });
  await writeFile(sessionFile(), JSON.stringify({ panes, activePane }));
};

// synchronous final write for quit: process.exit() kills pending async IO,
// so the debounced save would lose the last navigation
export const saveSessionSync = (panes: [PaneTabs, PaneTabs], activePane: 0 | 1): void => {
  mkdirSync(path.dirname(sessionFile()), { recursive: true });
  writeFileSync(sessionFile(), JSON.stringify({ panes, activePane }));
};

// directory check shared with virtual places: recent/starred URIs are always
// "usable", other virtual URIs are not, real paths must be existing dirs
const usable = (p: string): boolean => {
  if (isVirtualUri(p)) return p === RECENT_URI || p === STARRED_URI;
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};

const paneAt = (cwd: string): Tab => ({ history: [cwd], histIdx: 0 });

// filter a raw tab's history to usable dirs; null when nothing survives
const sanitizeTab = (raw: unknown): Tab | null => {
  const t = raw as { history?: unknown; histIdx?: unknown };
  const hist: string[] = Array.isArray(t?.history)
    ? t.history.filter((x: unknown) => typeof x === "string" && usable(x as string))
    : [];
  if (!hist.length) return null;
  return { history: hist, histIdx: Math.min(Math.max(0, (t.histIdx as number) | 0), hist.length - 1) };
};

const sanitizePaneTabs = (raw: unknown): PaneTabs | null => {
  const p = raw as { tabs?: unknown; activeTab?: unknown };
  if (!Array.isArray(p?.tabs)) return null;
  const tabs: Tab[] = [];
  for (const t of p.tabs) {
    const s = sanitizeTab(t);
    if (s) tabs.push(s);
  }
  if (!tabs.length) return null;
  return { tabs, activeTab: Math.min(Math.max(0, (p.activeTab as number) | 0), tabs.length - 1) };
};

// Parse + sanitize the session file. Returns null when there is nothing usable
// to restore — callers then keep their default tabs.
export const readRestoredSession = (): RestoredSession | null => {
  try {
    const doc = JSON.parse(readFileSync(sessionFile(), "utf8"));
    const activePane: 0 | 1 = doc?.activePane === 1 ? 1 : 0;

    // current format: two independent pane tab lists
    if (Array.isArray(doc?.panes)) {
      const a = sanitizePaneTabs(doc.panes[0]);
      const b = sanitizePaneTabs(doc.panes[1]);
      const base = a ?? b;
      if (!base) return null;
      return {
        panes: [
          a ?? { tabs: base.tabs.map((t) => ({ history: [...t.history], histIdx: t.histIdx })), activeTab: 0 },
          b ?? { tabs: base.tabs.map((t) => ({ history: [...t.history], histIdx: t.histIdx })), activeTab: 0 },
        ],
        activePane,
      };
    }

    if (Array.isArray(doc?.tabs)) {
      const rawTabs = doc.tabs as Array<Record<string, unknown>>;
      const activeTab = Math.min(Math.max(0, doc.activeTab | 0), Math.max(0, rawTabs.length - 1));
      // shared-tabs dual format: each tab carried panes:[left,right] — split it
      const shared = rawTabs.some((t) => Array.isArray(t?.panes));
      if (shared) {
        const left: Tab[] = [];
        const right: Tab[] = [];
        for (const t of rawTabs) {
          const p = t.panes as unknown[];
          const a = sanitizeTab(p?.[0]);
          const b = sanitizeTab(p?.[1]);
          if (a) left.push(a);
          if (b) right.push(b);
        }
        return finishPanes(left, right, activeTab, activePane);
      }
      // pre-dual-pane format: one history per tab, both panes get a copy
      const only: Tab[] = [];
      for (const t of rawTabs) {
        const s = sanitizeTab(t);
        if (s) only.push(s);
      }
      return finishPanes(
        only,
        only.map((t) => ({ history: [...t.history], histIdx: t.histIdx })),
        activeTab,
        activePane,
      );
    }

    // legacy single-cwd session file
    const cwd = typeof doc?.cwd === "string" ? doc.cwd : "";
    if (cwd && cwd !== RECENT_URI && cwd !== STARRED_URI) {
      try {
        if (statSync(cwd).isDirectory()) {
          return {
            panes: [
              { tabs: [paneAt(cwd)], activeTab: 0 },
              { tabs: [paneAt(cwd)], activeTab: 0 },
            ],
            activePane: 0,
          };
        }
      } catch {}
    }
  } catch {}
  return null;
};

// clamp + null out a pair of pane tab lists (both empty = nothing to restore)
const finishPanes = (left: Tab[], right: Tab[], activeTab: number, activePane: 0 | 1): RestoredSession | null => {
  if (!left.length && !right.length) return null;
  const base = left.length ? left : right;
  const mk = (tabs: Tab[]): PaneTabs => ({
    tabs: tabs.length ? tabs : base.map((t) => ({ history: [...t.history], histIdx: t.histIdx })),
    activeTab: Math.min(activeTab, (tabs.length ? tabs : base).length - 1),
  });
  return { panes: [mk(left), mk(right)], activePane };
};
