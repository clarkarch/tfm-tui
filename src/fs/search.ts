// --- Recursive type-to-search backend ([ui] recursive-search). fd is the
// fast path (fixed-string, absolute, capped, hidden opt-in); when fd/fdfind
// is missing or fails, a built-in readdir walk with the same match rule and
// cap takes over. Pure fs + process — the UI (ui-grid) owns rendering and
// gen-counter staleness. ---

import { readdir, stat } from "node:fs/promises";
import type { Dirent } from "node:fs";
import path from "node:path";
import type { Entry } from "./listing";

export const DEFAULT_SEARCH_LIMIT = 200;

export type SearchOpts = {
  hidden?: boolean;
  limit?: number;
  // cancels an in-flight search: kills the fd child (no walk fallback) and
  // bails the walk — stale keystroke searches must not keep burning disk
  signal?: AbortSignal;
  // injectable for tests: null = no fd available (forces the walk)
  fdBin?: string | null;
  // injectable fd runner; null return = fd failed (fall back to the walk)
  runFd?: (bin: string, args: string[], cwd: string, signal?: AbortSignal) => Promise<string | null>;
};

export const fdArgs = (query: string, hidden: boolean, limit: number): string[] => [
  "--color",
  "never",
  "--fixed-strings",
  // match the built-in walk's always-case-insensitive rule (fd's default is
  // smart-case: a single uppercase would silently flip the result set)
  "--ignore-case",
  "--absolute-path",
  "--max-results",
  String(limit),
  ...(hidden ? ["--hidden"] : []),
  // a query starting with "-" must not be parsed as an option
  "--",
  query,
];

export const parseSearchPaths = (stdout: string): string[] =>
  stdout
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

const defaultRunFd = async (bin: string, args: string[], cwd: string, signal?: AbortSignal): Promise<string | null> => {
  try {
    const proc = Bun.spawn([bin, ...args], { cwd, stdout: "pipe", stderr: "ignore", stdin: "ignore" });
    const onAbort = (): void => {
      try {
        proc.kill();
      } catch {}
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const out = new Response(proc.stdout).text();
      const code = await proc.exited;
      const text = await out;
      // aborted = empty result, NOT a failure — null would trigger the walk
      if (signal?.aborted) return "";
      // fd exits 1 on "no matches" — that's still a valid answer (no fallback);
      // 2+ means a real error (bad dir, permission) and the walk should try
      if (code >= 2) return null;
      return text;
    } finally {
      signal?.removeEventListener("abort", onAbort);
    }
  } catch {
    return null;
  }
};

// depth-first readdir walk; symlinked dirs are never descended (listing
// semantics), hidden entries filtered unless requested, capped
const walkTree = async (
  root: string,
  q: string,
  hidden: boolean,
  limit: number,
  signal?: AbortSignal,
): Promise<string[]> => {
  const out: string[] = [];
  const stack = [root];
  while (stack.length && out.length < limit) {
    if (signal?.aborted) return out;
    const dir = stack.pop() as string;
    let dirents: Dirent[];
    try {
      dirents = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const d of dirents) {
      if (out.length >= limit) break;
      if (!hidden && d.name.startsWith(".")) continue;
      const abs = path.join(dir, d.name);
      if (d.name.toLowerCase().includes(q)) out.push(abs);
      if (d.isDirectory()) stack.push(abs);
    }
  }
  return out;
};

export const searchTree = async (root: string, query: string, opts: SearchOpts = {}): Promise<Entry[]> => {
  const q = query.trim().toLowerCase();
  if (!q || opts.signal?.aborted) return [];
  const limit = opts.limit ?? DEFAULT_SEARCH_LIMIT;
  const hidden = opts.hidden ?? false;
  const bin = opts.fdBin !== undefined ? opts.fdBin : (Bun.which("fd") ?? Bun.which("fdfind"));
  let paths: string[] | null = null;
  if (bin) {
    const out = await (opts.runFd ?? defaultRunFd)(bin, fdArgs(query, hidden, limit), root, opts.signal);
    if (opts.signal?.aborted) return [];
    if (out !== null) paths = parseSearchPaths(out);
  }
  if (paths === null) {
    paths = await walkTree(root, q, hidden, limit, opts.signal);
    if (opts.signal?.aborted) return [];
  }
  // stats in parallel (serial awaits added ~a round-trip per result); size and
  // mtime ride along so list view / thumbnails don't stat the same paths again
  const entries = await Promise.all(
    paths.slice(0, limit).map(async (p): Promise<Entry | null> => {
      try {
        const st = await stat(p);
        return {
          name: path.relative(root, p) || path.basename(p),
          isDir: st.isDirectory(),
          size: st.size,
          mtimeMs: st.mtimeMs ?? 0,
          abs: p,
        };
      } catch {
        return null;
      }
    }),
  );
  if (opts.signal?.aborted) return [];
  return entries.filter((e): e is Entry => e !== null);
};
