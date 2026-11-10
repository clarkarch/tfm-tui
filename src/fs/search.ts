// --- Recursive type-to-search backend ([ui] recursive-search). fd is the
// fast path (fixed-string, absolute, capped, hidden opt-in); when fd/fdfind
// is missing or fails, a built-in readdir walk with the same match rule and
// cap takes over. Pure fs + process — the UI (ui-grid) owns rendering and
// gen-counter staleness. ---

import { lstat, readdir, stat } from "node:fs/promises";
import type { Dirent } from "node:fs";
import path from "node:path";
import type { Entry } from "./listing";
import { whichLive } from "./which";

export const DEFAULT_SEARCH_LIMIT = 200;

// The fd lane has THREE outcomes, and the old seam carried them in a
// two-valued `string | null`:
//   - ok      — fd answered (its paths; an EMPTY list is a legitimate "no
//               matches" answer — fd exits 1 for that).
//   - failed  — fd could not answer (exit 2+, a bad dir, a spawn throw) →
//               the built-in walk takes over.
//   - aborted — the caller abandoned the search → NO results, and NO walk
//               fallback (walking a tree for a superseded search burns CPU).
// The old shape spelled "aborted" as the EMPTY STRING, which is exactly what
// "no matches" looks like: a caller that forgot the case reported a silently
// EMPTY result set. The outcome is now TAGGED, so the three cannot be
// confused, and the consumer never has to re-read the signal to tell them
// apart.
export type FdOutcome = { ok: true; paths: string[] } | { ok: false; reason: "aborted" | "failed" };

export type SearchOpts = {
  hidden?: boolean;
  limit?: number;
  // cancels an in-flight search: kills the fd child (no walk fallback) and
  // bails the walk — stale keystroke searches must not keep burning disk
  signal?: AbortSignal;
  // injectable for tests: null = no fd available (forces the walk)
  fdBin?: string | null;
  // injectable fd runner; the outcome is TAGGED (an empty path list is "no
  // matches", never "aborted")
  runFd?: (bin: string, args: string[], cwd: string, signal?: AbortSignal) => Promise<FdOutcome>;
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

// The lane's decision table, PURE (so it is testable without spawning fd):
// the exit code + the abort state decide the outcome.
//   - fd exits 1 on "no matches" — that is still a valid answer (NO fallback);
//     2+ means a real error (bad dir, permission) and the walk should try.
//   - an abort wins over the exit code: the caller abandoned the search, so
//     its answer is void — reading it as "no matches" would be a silently
//     empty result set.
export const fdOutcomeFor = (code: number, stdout: string, aborted: boolean): FdOutcome => {
  if (aborted) return { ok: false, reason: "aborted" };
  if (code >= 2) return { ok: false, reason: "failed" };
  return { ok: true, paths: parseSearchPaths(stdout) };
};

const defaultRunFd = async (bin: string, args: string[], cwd: string, signal?: AbortSignal): Promise<FdOutcome> => {
  try {
    const proc = Bun.spawn([bin, ...args], { cwd, stdout: "pipe", stderr: "ignore", stdin: "ignore" });
    let escalateTimer: ReturnType<typeof setTimeout> | null = null;
    const onAbort = (): void => {
      try {
        proc.kill("SIGTERM");
      } catch {}
      // a SIGTERM-immune child (wedged FUSE) would hold proc.exited past every
      // timer: escalate once, cleared on exit below
      if (escalateTimer === null) {
        escalateTimer = setTimeout(() => {
          try {
            proc.kill("SIGKILL");
          } catch {}
        }, 2000);
      }
    };
    void proc.exited.then(() => {
      if (escalateTimer !== null) clearTimeout(escalateTimer);
    });
    // a wedged fd (stale NFS/FUSE cwd) must not burn until the next keystroke:
    // time out like every other helper read (10s) and let the walk take over
    const timer = setTimeout(onAbort, 10_000);
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const out = new Response(proc.stdout).text();
      const code = await proc.exited;
      const text = await out;
      // the 10s timeout kills the child WITHOUT aborting the signal → the
      // killed exit code (>= 2) lands as "failed" and the walk takes over
      return fdOutcomeFor(code, text, signal?.aborted === true);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
  } catch {
    return { ok: false, reason: "failed" };
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
  const bin = opts.fdBin !== undefined ? opts.fdBin : (whichLive("fd") ?? whichLive("fdfind"));
  let paths: string[] | null = null;
  if (bin) {
    const out = await (opts.runFd ?? defaultRunFd)(bin, fdArgs(query, hidden, limit), root, opts.signal);
    if (out.ok) {
      // an empty list here is "no matches" — a valid answer, no fallback
      paths = out.paths;
    } else if (out.reason === "aborted") {
      // an ABORTED search is not "no matches": it yields no results and does
      // NOT fall back to the walk (the caller abandoned it — walking the tree
      // would burn CPU on a superseded search)
      return [];
    }
    // "failed" → paths stays null → the walk takes over
    // the caller's own cancellation wins over ANY answer — the fd run may
    // have completed just before the abort landed
    if (opts.signal?.aborted) return [];
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
        // size/mtime are the link's own (on-disk cost, like the list view);
        // routing still follows it
        let size = st.size;
        let mtimeMs = st.mtimeMs ?? 0;
        let isLink = false;
        try {
          const lst = await lstat(p);
          isLink = lst.isSymbolicLink();
          if (isLink) {
            size = lst.size;
            mtimeMs = lst.mtimeMs ?? mtimeMs;
          }
        } catch {}
        return {
          name: path.relative(root, p) || path.basename(p),
          isDir: st.isDirectory(),
          size,
          mtimeMs,
          abs: p,
          isLink,
          // probed just now → the stats are fresh by construction
          statsState: "fresh",
        };
      } catch {
        return null;
      }
    }),
  );
  if (opts.signal?.aborted) return [];
  return entries.filter((e): e is Entry => e !== null);
};
