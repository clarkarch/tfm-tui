// --- Directory listing + sort: pure fs/dir-entry logic. No renderer, no UI
// state — sort mode arrives as params so callers (grid, tests) own state.
// Virtual places (Recent/Starred) resolve through the registries in ./recent. ---
import { readdir, stat } from "node:fs/promises";
import { statSync } from "node:fs";
import path from "node:path";
import { RECENT_URI, STARRED_URI } from "./uri";
import { readRecentXbel, readStarredList } from "./recent";
import type { SortMode } from "../ui/menu-entries";

export type Entry = { name: string; isDir: boolean; size?: number; mtimeMs?: number; abs?: string };

export const extOf = (n: string): string => {
  const b = n.startsWith(".") ? n.slice(1) : n;
  const i = b.lastIndexOf(".");
  return i > 0 ? b.slice(i + 1).toLowerCase() : "";
};

export const compareEntries =
  (sortBy: SortMode, sortAsc: boolean) =>
  (a: Entry, b: Entry): number => {
    const cmp = (x: Entry, y: Entry): number => {
      switch (sortBy) {
        case "size":
          return (x.size ?? 0) - (y.size ?? 0);
        case "mtime":
          return (x.mtimeMs ?? 0) - (y.mtimeMs ?? 0);
        case "type":
          return extOf(x.name).localeCompare(extOf(y.name)) || x.name.localeCompare(y.name);
        default:
          return x.name.localeCompare(y.name);
      }
    };
    // dirs sort first, always — like nautilus
    return Number(b.isDir) - Number(a.isDir) || (sortAsc ? cmp(a, b) : -cmp(a, b));
  };

const statEntry = (abs: string): { size?: number; mtimeMs?: number } => {
  try {
    const st = statSync(abs);
    return { size: st.size, mtimeMs: st.mtimeMs ?? 0 };
  } catch {
    return {};
  }
};

export const recentEntries = async (): Promise<Entry[]> => {
  const out: Entry[] = [];
  for (const it of readRecentXbel()) {
    let st: any = null;
    try {
      st = statSync(it.path);
    } catch {
      continue;
    } // drop vanished files
    out.push({
      name: path.basename(it.path),
      isDir: st.isDirectory(),
      abs: it.path,
      size: st.size,
      mtimeMs: it.modified,
    });
  }
  return out;
};

export const starredEntries = async (): Promise<Entry[]> => {
  const out: Entry[] = [];
  for (const p of readStarredList()) {
    let st: any = null;
    try {
      st = statSync(p);
    } catch {
      continue;
    }
    out.push({ name: path.basename(p), isDir: st.isDirectory(), abs: p, size: st.size, mtimeMs: st.mtimeMs ?? 0 });
  }
  return out;
};

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
