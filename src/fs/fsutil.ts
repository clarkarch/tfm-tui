import { cp, mkdir, rename as fsRename, rm, writeFile, open } from "node:fs/promises";
import { existsSync, lstatSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToUri } from "./uri";

// --- Deterministic fs+path operations: the primitives runTransfer, trash and
// undo sit on. No prompts, no UI, no state — callers own decisions; these own
// correctness (never overwrite silently, EXDEV fallback, XDG trash spec). ---

// XDG trash root (spec: $XDG_DATA_HOME/Trash, default ~/.local/share/Trash —
// which is where the monolith hardcoded it). Resolved per call, not at import,
// so env redirection works.
export const trashDir = (): string =>
  path.join(process.env.XDG_DATA_HOME ?? path.join(os.homedir(), ".local/share"), "Trash");

// is a cwd the trash FILES dir? (virtual URIs like recent:// resolve to junk
// paths, never the trash root, so no guard needed at the call site)
export const isTrashFilesDir = (p: string): boolean => {
  const homeFiles = path.join(trashDir(), "files");
  try {
    if (path.resolve(p) === homeFiles) return true;
  } catch {}
  // topdir trashes (removable media) also count — check the target's own root
  try {
    const roots = trashRootsFor(p);
    return roots.some((r) => path.resolve(p) === path.join(r, "files"));
  } catch {
    return false;
  }
};

// is a path the trash FILES dir or anything under it? Files landing there
// without .trashinfo are unrestorable, so paste/move targets must check the
// SUBTREE (unlike isTrashFilesDir, which matches the dir itself exactly).
export const isInTrashFiles = (p: string): boolean => {
  try {
    const target = path.resolve(p);
    const roots = [path.join(trashDir(), "files"), ...trashRootsFor(p).map((r) => path.join(r, "files"))];
    return roots.some((root) => target === path.resolve(root) || target.startsWith(path.resolve(root) + path.sep));
  } catch {
    return false;
  }
};

// is `inner` the same path as `outer` or anywhere inside it? Ancestor
// relationship for self-drop guards (copying a folder into itself/its own
// subtree recurses unboundedly) — shared by runTransfer and moveInto.
export const isWithinOrEqual = (inner: string, outer: string): boolean => {
  try {
    const i = path.resolve(inner);
    const o = path.resolve(outer);
    return i === o || i.startsWith(o + path.sep);
  } catch {
    return false;
  }
};

// best-effort count of home-trash entries for the empty-trash confirm
// prompt. -1 when the trash is unreadable (prompt omits the count then).
export const countTrashItems = (): number => {
  try {
    return readdirSync(path.join(trashDir(), "files")).length;
  } catch {
    return -1;
  }
};

// progress-toast threshold shared by the transfer pre-scan (./fileops) and
// the toast widget (./ui-progress re-exports it): tiny transfers don't need
// a toast. One predicate so the two can't drift apart again.
export const shouldToast = (totalBytes: number, totalFiles: number): boolean =>
  totalBytes > 4 * 1024 * 1024 || totalFiles > 4;

// terse human text for the fs error codes users actually hit — "FAILED" alone
// gives them nothing to act on (retry vs chmod vs free disk space)
const FS_ERR_TEXT: Record<string, string> = {
  ENOENT: "source gone",
  EACCES: "permission denied",
  EPERM: "permission denied",
  ENOSPC: "disk full",
  EBUSY: "file busy",
  ETXTBSY: "file busy",
  EISDIR: "is a directory",
  ENOTDIR: "not a directory",
  ENAMETOOLONG: "name too long",
  EROFS: "read-only fs",
  EMFILE: "too many open files",
};

export const fsErrText = (err: unknown): string => {
  const code = errCode(err);
  if (typeof code === "string") return FS_ERR_TEXT[code] ?? code.toLowerCase();
  return err instanceof Error ? (err.message.split(":")[0]?.toLowerCase() ?? "unknown error") : "unknown error";
};

// shared FAILED clause for op summaries: "N FAILED (reason)" with the first
// collected reason. The seven trash/transfer/undo summaries compose it into
// their own sentences (separators stay per-site), so the FAILED phrasing
// can't drift apart again. Callers gate on failed > 0.
export const failSuffix = (failed: number, failWhy: Set<string>): string => {
  const why = [...failWhy][0];
  return `${failed} FAILED${why ? ` (${why})` : ""}`;
};

// errno-style .code off an unknown caught value (fs renames, child-proc
// failures) — structural narrowing instead of `any`
export const errCode = (err: unknown): unknown => {
  if (typeof err === "object" && err !== null && "code" in err) return err.code;
  return undefined;
};

// split "report.pdf" -> {stem "report", ext ".pdf"}; extensionless names and
// dotfiles ("Makefile", ".x") keep the whole name as stem. Shared by
// uniqueTarget (" (copy)" dialect) and inline-create (" 2" dialect).
export const splitStemExt = (base: string): { stem: string; ext: string } => {
  const dot = base.lastIndexOf(".");
  return dot > 0 ? { stem: base.slice(0, dot), ext: base.slice(dot) } : { stem: base, ext: "" };
};

// nautilus naming for an OCCUPIED name: first suggestion is " (copy)", then
// " (copy 2)", … Callers must only invoke this when `dir/base` already exists
// (runTransfer collisions, replace-stash) — the base name itself is never
// checked, and that's load-bearing for the replace flow's expectations.
export const uniqueTarget = (dir: string, base: string): string => {
  const { stem, ext } = splitStemExt(base);
  for (let i = 2; ; i++) {
    const cand = i === 2 ? path.join(dir, `${stem} (copy)${ext}`) : path.join(dir, `${stem} (copy ${i - 1})${ext}`);
    if (!existsSync(cand)) return cand;
  }
};

export const fsMove = async (src: string, dest: string): Promise<void> => {
  try {
    await fsRename(src, dest);
  } catch (err: unknown) {
    if (errCode(err) !== "EXDEV") throw err;
    // cross-device: copy+delete (no atomic rename across filesystems).
    // cp preserves mode/mtime; the caller (runTransfer) routes big moves
    // through the durable tmp+rename engine with progress + half-copy
    // cleanup — this fallback is for single renames that unexpectedly hit
    // EXDEV (bind mounts). Remove source only after the copy succeeded.
    await cp(src, dest, { recursive: true, preserveTimestamps: true });
    try {
      await rm(src, { recursive: true });
    } catch (err) {
      // partial source deletion; the complete copy in dest is the only intact
      // data now — keep it and say what actually happened instead of a bare errno
      throw new Error(`source partially removed: ${fsErrText(err)}`);
    }
  }
};

// undo/restore moves must never clobber whatever now occupies the target —
// rename() silently overwrites on Linux, so a file created between the original
// op and ctrl+z would be destroyed. Bump to "name (copy)" instead. Returns
// the final destination (== dest unless it was occupied).
export const safeRestoreMove = async (src: string, dest: string): Promise<string> => {
  let d = dest;
  if (existsSync(d)) d = uniqueTarget(path.dirname(d), path.basename(d));
  await mkdir(path.dirname(d), { recursive: true });
  await fsMove(src, d);
  return d;
};

// best-effort removal of one trashinfo sidecar (undo/restore cleanup). Never
// throws — a stale .trashinfo is cosmetic, failing the whole undo over it is not.
export const rmTrashInfo = async (name: string, log?: (msg: string) => void): Promise<void> => {
  try {
    await rm(path.join(trashDir(), "info", `${name}.trashinfo`));
  } catch (err) {
    log?.(`trashinfo cleanup ${name}: ${fsErrText(err)}`);
  }
};

// --- XDG trash spec helpers ---

// Percent-encode an absolute path per the trash spec (Path= must be
// URL-encoded). Uses the shared path->URI encoder minus the scheme, so `/`
// separators survive and spaces, `%`, `#`, non-ASCII round-trip through
// decodeURIComponent on read.
export const encodeTrashPath = (p: string): string => pathToUri(path.resolve(p)).slice(7);

// Candidate trash roots for a target: home trash always, plus the topdir
// trash ($topdir/.Trash-$uid) when the target lives on another filesystem
// (removable media — spec §2). Resolved per call for env-redirection tests.
const trashRootsFor = (target: string): string[] => {
  const home = trashDir();
  let targetDev: number | null = null;
  let homeDev: number | null = null;
  try {
    targetDev = lstatSync(target).dev;
  } catch {
    try {
      targetDev = lstatSync(path.dirname(path.resolve(target))).dev;
    } catch {
      targetDev = null;
    }
  }
  try {
    homeDev = lstatSync(path.dirname(home)).dev ?? lstatSync(os.homedir()).dev;
  } catch {
    homeDev = null;
  }
  if (targetDev === null || homeDev === null || targetDev === homeDev) return [home];
  // different filesystem — walk up to the mount point (dev changes there)
  let cur = path.resolve(target);
  let top = cur;
  while (true) {
    const parent = path.dirname(cur);
    if (parent === cur) {
      top = cur;
      break;
    }
    let curDev: number | null = null;
    let parentDev: number | null = null;
    try {
      curDev = lstatSync(cur).dev;
    } catch {
      cur = parent;
      continue;
    }
    try {
      parentDev = lstatSync(parent).dev;
    } catch {
      top = cur;
      break;
    }
    if (curDev !== parentDev) {
      top = cur;
      break;
    }
    cur = parent;
    top = cur;
  }
  const uid = typeof process.getuid === "function" ? process.getuid() : 0;
  return [path.join(top, `.Trash-${uid}`), home];
};

// XDG trash: `gio trash` fails on tmpfs ("system internal mounts"), so we
// write the .trashinfo ourselves and move into Trash/files. Returns the final
// path (name may be suffixed .2, .3 … on collisions).
//
// Ordering + atomicity: the destination NAME is claimed first with an
// O_EXCL (`wx`) .trashinfo placeholder — portable APIs expose no atomic
// no-clobber rename for dirs, but the `wx` create is atomic, so two
// concurrent trashers can never claim the same name (loser bumps to .2).
// Then the file moves, then the placeholder is overwritten with the real
// Path=/DeletionDate=. If the move fails the placeholder is removed (no
// orphan entry); if the final info write fails the move rolls back.
export const xdgTrashMove = async (p: string): Promise<string> => {
  const absSrc = path.resolve(p);
  const roots = trashRootsFor(absSrc);
  let lastErr: unknown = null;
  for (const root of roots) {
    try {
      return await xdgTrashMoveToRoot(absSrc, root);
    } catch (err) {
      lastErr = err;
      // topdir may be read-only/unwritable — fall through to home trash
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
};

const xdgTrashMoveToRoot = async (absSrc: string, root: string): Promise<string> => {
  const filesDir = path.join(root, "files");
  const infoDir = path.join(root, "info");
  await mkdir(filesDir, { recursive: true });
  await mkdir(infoDir, { recursive: true });
  const base = path.basename(absSrc);
  const stamp = new Date().toISOString().replace(/\.\d+Z$/, "Z");
  const encoded = encodeTrashPath(absSrc);
  let name = base;
  for (let i = 2; ; i++) {
    const infoPath = path.join(infoDir, `${name}.trashinfo`);
    // atomic claim: fails with EEXIST when another trasher owns this name
    try {
      await writeFile(infoPath, `[Trash Info]\nPath=${encoded}\nDeletionDate=${stamp}\n`, { flag: "wx" });
    } catch (err) {
      if (errCode(err) === "EEXIST" || existsSync(path.join(filesDir, name))) {
        name = `${base}.${i}`;
        continue;
      }
      throw err;
    }
    // claimed — now move, then finalize the info (overwrite placeholder)
    const finalPath = path.join(filesDir, name);
    try {
      await fsMove(absSrc, finalPath);
    } catch (moveErr) {
      try {
        await rm(infoPath, { force: true });
      } catch {}
      throw moveErr;
    }
    try {
      await writeFile(infoPath, `[Trash Info]\nPath=${encoded}\nDeletionDate=${stamp}\n`);
      // best-effort durability: info + dir fsync so a crash doesn't lose the
      // restore mapping for a file that already moved
      try {
        const h = await open(infoPath, "r");
        try {
          await h.sync();
        } finally {
          await h.close().catch(() => {});
        }
      } catch {}
    } catch (err) {
      // put the file back — a source-less trash entry is worse than no entry
      try {
        await fsMove(finalPath, absSrc);
      } catch (undoErr) {
        if (err instanceof Error) {
          const e: Error & { rollbackFailed?: unknown } = err;
          e.rollbackFailed = undoErr;
        }
      }
      try {
        await rm(infoPath, { force: true });
      } catch {}
      throw err;
    }
    return finalPath;
  }
};

// st.dev of a path (lstat: moving a symlink moves the link, not its target).
// null when the path is gone/unstatable — callers must treat null as
// "unknown, use the safe fallback" (fsMove's EXDEV path), never as equal.
export const deviceOf = (p: string): number | null => {
  try {
    return lstatSync(p).dev;
  } catch {
    return null;
  }
};

export const crossDevice = (a: string, b: string): boolean => {
  const da = deviceOf(a),
    db = deviceOf(b);
  return da !== null && db !== null && da !== db;
};

// tmp+rename write: a crash or EDQUOT mid-write never leaves a truncated
// file at the target path. Used for caches keyed by content version — a
// partial write there would be served as a valid hit forever.
export const atomicWriteFile = async (p: string, data: Uint8Array | string): Promise<void> => {
  const tmp = `${p}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmp, data);
  try {
    await fsRename(tmp, p);
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
};
