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

// --- [ui] listings-cache: reuse a folder's raw entry list across repaints
// (yazi's folder cache + dir-signature revalidate). Every renderAll used to
// pay a full readdir (+ a stat per row under size/mtime sorts); back/forward,
// tab switches and selection changes re-asked the disk for identical data.
// The dir's own stat is the validity key: create/delete/rename ALWAYS bump
// its mtime, so the set of names can't go stale. Content edits don't touch
// it, and with [ui] listings-cache-stats (default on) the size/mtime fill
// rides along IN the cached entries — sorts stop re-statting every file on
// every repaint, so displayed stats (and everything keyed off them, e.g.
// thumbnail cache keys) can lag a live edit by up to the TTL window. With stats caching off the fill re-stats per call instead, and
// nothing ever goes stale — so no watcher per-file patching is ever needed
// (unlike yazi). The TTL ([ui] listings-cache-ttl) caps the worst case for
// stale stats AND for exotic filesystems whose dir mtimes freeze (some
// fuse/exFAT mounts, yazi's "soundless" partitions) — it is the only thing
// that must re-validate on a slow clock. One known hole: a symlink's isDir
// FOLLOWS ITS TARGET, and retargeting a link (dir↔file) bumps no directory
// mtime, so routing can lie until the TTL.
type CachedDir = { sig: string; entries: Entry[]; t: number };
const LISTINGS_CAP = 64;
const LISTINGS_TTL_MS = 2000;
const listings = new Map<string, CachedDir>();

const scanDir = async (dir: string): Promise<Entry[]> => {
  const dirents = await readdir(dir, { withFileTypes: true });
  const out: Entry[] = [];
  for (const d of dirents) {
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
  return out;
};

// stats written INTO the cached entries ([ui] listings-cache-stats): ONE
// stat fills size AND mtimeMs, so switching sorts later finds them present.
// Failed stats stay missing and are retried next call — never fake a zero.
const fillInto = (entries: Entry[], dir: string): void => {
  for (const e of entries) {
    if (e.size !== undefined && e.mtimeMs !== undefined) continue;
    const got = statEntry(e.abs ?? path.join(dir, e.name));
    if (got.size === undefined) continue;
    e.size = got.size;
    e.mtimeMs = got.mtimeMs;
  }
};

// raw scan (hidden INCLUDED — listDir filters per call so the showHidden
// toggle never re-reads the disk). Entries are returned as a fresh array of
// copies: the caller's sort must never mutate the cache.
const loadEntries = async (
  dir: string,
  o: { cache: boolean; now: () => number; ttlMs: number; fillStats: boolean },
): Promise<Entry[]> => {
  if (!o.cache) return (await scanDir(dir)).map((e) => ({ ...e }));
  const key = path.resolve(dir);
  // mtime ONLY: a dir's st_size is block-granular and lies on most filesystems
  const sig = String(statSync(dir).mtimeMs);
  const hit = listings.get(key);
  if (hit && hit.sig === sig && o.now() - hit.t < o.ttlMs) {
    // re-insert so the LRU evicts the least-recently-USED dir; `t` is
    // deliberately NOT refreshed (absolute staleness cap, not idle expiry)
    listings.delete(key);
    listings.set(key, hit);
    if (o.fillStats) fillInto(hit.entries, dir);
    return hit.entries.map((e) => ({ ...e }));
  }
  const entries = await scanDir(dir);
  if (o.fillStats) fillInto(entries, dir);
  listings.delete(key);
  listings.set(key, { sig, entries, t: o.now() });
  while (listings.size > LISTINGS_CAP) {
    // Map iteration survives deletes; the first key is the least-recently-used
    for (const k of listings.keys()) {
      listings.delete(k);
      break;
    }
  }
  return entries.map((e) => ({ ...e }));
};

export const listDir = async (
  dir: string,
  showHidden: boolean,
  sortBy: SortMode,
  sortAsc: boolean,
  opts?: { cache?: boolean; cacheStats?: boolean; ttlMs?: number; now?: () => number },
): Promise<Entry[]> => {
  let out: Entry[];
  if (dir === RECENT_URI) {
    out = await recentEntries();
    // recency order wins over the global sort mode, like nautilus
    return out.sort((a, b) => (b.mtimeMs ?? 0) - (a.mtimeMs ?? 0));
  }
  // stats-cached reads only apply to real dirs (virtual places are rebuilt
  // per call anyway) and need the listing cache itself on
  const fillAtLoad = dir !== STARRED_URI && (opts?.cache ?? true) && (opts?.cacheStats ?? true);
  if (dir === STARRED_URI) out = await starredEntries();
  else {
    const all = await loadEntries(dir, {
      cache: opts?.cache ?? true,
      now: opts?.now ?? Date.now,
      ttlMs: opts?.ttlMs ?? LISTINGS_TTL_MS,
      fillStats: fillAtLoad && (sortBy === "size" || sortBy === "mtime"),
    });
    out = showHidden ? all : all.filter((e) => !e.name.startsWith("."));
  }
  if ((sortBy === "size" || sortBy === "mtime") && !fillAtLoad) {
    for (const e of out) {
      const got = statEntry(e.abs ?? path.join(dir, e.name));
      e.size = got.size;
      e.mtimeMs = got.mtimeMs;
    }
  }
  return out.sort(compareEntries(sortBy, sortAsc));
};
