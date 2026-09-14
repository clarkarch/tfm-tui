// --- Directory listing + sort: pure fs/dir-entry logic. No renderer, no UI
// state — sort mode arrives as params so callers (grid, tests) own state.
// Virtual places (Recent/Starred) resolve through the registries in ./recent. ---
import { readdir, stat } from "node:fs/promises";
import { statSync } from "node:fs";
import path from "node:path";
import { RECENT_URI, STARRED_URI } from "./uri";
import { readRecentXbel, readStarredList } from "./recent";
import type { SortMode } from "../lib/sort";
import { extOf } from "./filetype";

export type Entry = { name: string; isDir: boolean; size?: number; mtimeMs?: number; abs?: string };

// One collator for the whole process (JSC/Bun rebuilds collation data on every
// String#localeCompare call, turning an n log n sort into a slow-mode flood —
// Nautilus caches collation keys per file for the same reason). Default
// options == localeCompare(undefined) semantics: pure speed, same order.
const NAME_COLLATOR = new Intl.Collator();
const cmpName = (a: string, b: string): number => NAME_COLLATOR.compare(a, b);

export const compareEntries = (sortBy: SortMode, sortAsc: boolean) => {
  // memoized so a "type" sort pays one extOf per NAME, not one per comparison
  const exts = new Map<string, string>();
  const extCached = (n: string): string => {
    let e = exts.get(n);
    if (e === undefined) {
      e = extOf(n);
      exts.set(n, e);
    }
    return e;
  };
  const cmp = (x: Entry, y: Entry): number => {
    switch (sortBy) {
      case "size":
        return (x.size ?? 0) - (y.size ?? 0);
      case "mtime":
        return (x.mtimeMs ?? 0) - (y.mtimeMs ?? 0);
      case "type":
        return cmpName(extCached(x.name), extCached(y.name)) || cmpName(x.name, y.name);
      default:
        return cmpName(x.name, y.name);
    }
  };
  return (a: Entry, b: Entry): number =>
    // dirs sort first, always — like nautilus
    Number(b.isDir) - Number(a.isDir) || (sortAsc ? cmp(a, b) : -cmp(a, b));
};

const statEntry = (abs: string): { size?: number; mtimeMs?: number } => {
  try {
    const st = statSync(abs);
    return { size: st.size, mtimeMs: st.mtimeMs ?? 0 };
  } catch {
    return {};
  }
};

// shared stat-and-build for the virtual places: vanished files are dropped,
// an explicit mtime (XBEL Modified) wins over the fs mtime
const statEntries = (items: Array<{ path: string; mtimeMs?: number }>): Entry[] => {
  const out: Entry[] = [];
  for (const it of items) {
    let st: ReturnType<typeof statSync>;
    try {
      st = statSync(it.path);
    } catch {
      continue;
    }
    out.push({
      name: path.basename(it.path),
      isDir: st.isDirectory(),
      abs: it.path,
      size: st.size,
      mtimeMs: it.mtimeMs ?? st.mtimeMs ?? 0,
    });
  }
  return out;
};

const recentEntries = async (): Promise<Entry[]> =>
  statEntries(readRecentXbel().map((it) => ({ path: it.path, mtimeMs: it.modified })));

const starredEntries = async (): Promise<Entry[]> => statEntries(readStarredList().map((p) => ({ path: p })));

export const listDir = async (
  dir: string,
  showHidden: boolean,
  sortBy: SortMode,
  sortAsc: boolean,
): Promise<Entry[]> => {
  let out: Entry[];
  if (dir === RECENT_URI) {
    out = await recentEntries();
    // recency order wins over the global sort mode, like nautilus
    return out.sort((a, b) => (b.mtimeMs ?? 0) - (a.mtimeMs ?? 0));
  }
  if (dir === STARRED_URI) out = await starredEntries();
  else {
    const dirents = await readdir(dir, { withFileTypes: true });
    out = [];
    for (const d of dirents) {
      if (!showHidden && d.name.startsWith(".")) continue;
      let isDir = d.isDirectory();
      // a symlink is a folder only if its target is one — never follow it further
      if (d.isSymbolicLink()) {
        try {
          isDir = (await stat(path.join(dir, d.name))).isDirectory();
        } catch {
          isDir = false;
        }
      }
      out.push({ name: d.name, isDir });
    }
  }
  if (sortBy === "size" || sortBy === "mtime") {
    for (const e of out) {
      const got = statEntry(e.abs ?? path.join(dir, e.name));
      e.size = got.size;
      e.mtimeMs = got.mtimeMs;
    }
  }
  return out.sort(compareEntries(sortBy, sortAsc));
};
