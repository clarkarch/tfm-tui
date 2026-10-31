import { chmod, cp, mkdir, rename as fsRename, rm, writeFile, open } from "node:fs/promises";
import { accessSync, constants, existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToUri } from "./uri";
import { swallow } from "../lib/log";

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
export const countTrashItems = (mountsText?: string): number => {
  let home: string[];
  try {
    home = readdirSync(path.join(trashDir(), "files"));
  } catch {
    return -1;
  }
  let n = home.length;
  // per-mount trashes ($topdir/.Trash-$uid) hold real entries too — the
  // confirm count must not under-report them
  for (const dir of allTrashFilesDirs(mountsText)) {
    try {
      if (path.resolve(dir) === path.resolve(path.join(trashDir(), "files"))) continue;
    } catch {
      continue;
    }
    try {
      n += readdirSync(dir).length;
    } catch {
      // yanked device mid-count — home count still stands
    }
  }
  return n;
};

// every trash FILES dir currently mounted: home first, then one
// `<mountpoint>/.Trash-<uid>/files` per /proc/mounts entry. Unreadable or
// missing dirs are still listed (callers readdir best-effort) — only the
// parse itself must never throw. mountsText is an injectable seam (tests pass
// a fake table; production reads /proc/mounts).
export const allTrashFilesDirs = (mountsText?: string): string[] => {
  const home = path.join(trashDir(), "files");
  const out = [home];
  const seen = new Set<string>();
  try {
    seen.add(path.resolve(home));
  } catch {}
  const uid = typeof process.getuid === "function" ? process.getuid() : 0;
  let text: string;
  if (mountsText !== undefined) {
    text = mountsText;
  } else {
    try {
      text = readFileSync("/proc/mounts", "utf8");
    } catch {
      return out;
    }
  }
  for (const line of text.split("\n")) {
    const mp = parseProcMountpoint(line);
    if (!mp) continue;
    try {
      const r = path.resolve(path.join(mp, `.Trash-${uid}`, "files"));
      if (!seen.has(r)) {
        seen.add(r);
        out.push(path.join(mp, `.Trash-${uid}`, "files"));
      }
    } catch {}
  }
  return out;
};

// network and automount filesystems never hold tfm trash (trashPaths refuses
// network paths outright) — probing them here would hang on a dead server or
// trigger an autofs mount for nothing. Deny by fstype, not by path.
const PROC_MOUNT_SKIP_FSTYPES = new Set([
  "nfs",
  "nfs4",
  "cifs",
  "smbfs",
  "smb3",
  "sshfs",
  "fuse.sshfs",
  "fuse.gvfsd-fuse",
  "autofs",
]);

// one /proc/mounts line → mountpoint, or null. Fields are
// `device mountpoint fstype opts …` with octal escapes in the first two
// (\040 space, \011 tab, \012 newline, \134 backslash).
const parseProcMountpoint = (line: string): string | null => {
  const parts = line.split(" ");
  if (parts.length < 3) return null;
  const mp = parts[1];
  const fstype = parts[2];
  if (!mp || !fstype || PROC_MOUNT_SKIP_FSTYPES.has(fstype)) return null;
  try {
    return mp.replace(/\\040/g, " ").replace(/\\011/g, "\t").replace(/\\012/g, "\n").replace(/\\134/g, "\\");
  } catch {
    return null;
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

// sync readability probe behind the adaptive opens (default open + Open
// With… route unreadable files through the sudo gate instead of spawning a
// doomed unprivileged child). One syscall; callers, not this, decide.
export const canReadSync = (p: string): boolean => {
  try {
    accessSync(p, constants.R_OK);
    return true;
  } catch {
    return false;
  }
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

// A filesystem NAME (one path segment), not a path. The rename + create
// inputs take free text, and `path.join(dir, value)` silently turns "sub/x"
// into a move INTO sub/ and "../x" into a move OUT of the folder — the file
// changes directory while the toast reports the old basename, so the user is
// told it was renamed and it wasn't.
//
// Validate at the BOUNDARY (the fs-facing API), not at each call site: the
// inline rename, the inline create and the bulk-rename planner all go
// through it, and a per-site check is exactly what let the two rename entry
// points disagree about what a legal name is (the bulk-rename planner
// already had its own copy of this rule).
export const invalidFileName = (name: string): string | null => {
  // whitespace-only is as empty as empty (the rename input trims, but this
  // is the fs-facing boundary and must not depend on the caller trimming)
  if (!name.trim()) return "Name can't be empty";
  if (name === "." || name === "..") return `Invalid name: ${name}`;
  if (name.includes("/") || name.includes("\0")) return `Invalid name: ${name}`;
  return null;
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

// A copy implementation for the EXDEV fallback (see fsMove below). The seam
// exists so a caller that owns a progress sink can route the cross-device
// copy through it — the default `cp` reports neither progress nor cancel, so
// a big cross-device move (a USB stick into the home trash) ran in silence.
// The seam copies the CONTENT only: fsMove removes the source afterwards.
export type CrossDeviceCopy = (src: string, dest: string) => Promise<void>;

export const fsMove = async (src: string, dest: string, copy?: CrossDeviceCopy): Promise<void> => {
  try {
    await fsRename(src, dest);
  } catch (err: unknown) {
    if (errCode(err) !== "EXDEV") throw err;
    // cross-device: copy+delete (no atomic rename across filesystems).
    // Via an EXCLUSIVELY-claimed sibling tmp (same .tfm-part-* shape the
    // transfer engine sweeps) so a crash can't leave a half-written dest and
    // a concurrent op can't share our tmp: only a complete tmp is renamed
    // into place. The caller (runTransfer) routes big moves through the
    // durable tmp+rename engine with progress + half-copy cleanup — this
    // fallback is for single renames that unexpectedly hit EXDEV (bind
    // mounts). Remove source only after the copy succeeded.
    if (copy) {
      // the caller's engine owns the staging + the bar (it lands dest
      // atomically on its own), so the tmp dance below is not needed
      await copy(src, dest);
    } else {
      const srcStat = lstatSync(src);
      const tmp = await claimTmp(dest, srcStat.isDirectory());
      try {
        await cp(src, tmp, { recursive: true, preserveTimestamps: true });
        // cp merges into the claimed dir instead of creating it, so the root
        // keeps mkdir-default mode — restore the source's explicitly
        if (srcStat.isDirectory()) {
          try {
            // eslint-disable-next-line no-bitwise
            await chmod(tmp, srcStat.mode & 0o7777);
          } catch {}
        }
        await fsRename(tmp, dest);
      } catch (copyErr) {
        await rm(tmp, { recursive: true, force: true }).catch(() => {});
        throw copyErr;
      }
    }
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
//
// `opts.copy` is the cross-device seam (see fsMove): it copies the content
// through the caller's engine (progress bar + cancel) and the source is
// dropped afterwards — a plain `cp` fallback showed the user NOTHING while a
// multi-GB file crossed the boundary.
//
// `opts.crossDevice` says the caller KNOWS the move crosses a filesystem
// boundary (it probed the devices itself). Without it the seam only runs if
// the rename actually fails with EXDEV — the probe is what makes the
// progress-aware path reachable (and testable) BEFORE the slow copy starts.
export const safeRestoreMove = async (
  src: string,
  dest: string,
  opts?: { copy?: CrossDeviceCopy; crossDevice?: boolean },
): Promise<string> => {
  let d = dest;
  if (existsSync(d)) d = uniqueTarget(path.dirname(d), path.basename(d));
  await mkdir(path.dirname(d), { recursive: true });
  if (opts?.copy && opts.crossDevice) {
    // copy first, drop the source after: a failed copy leaves the source
    // intact (the move's mirror), never a half-restored file
    await opts.copy(src, d);
    await rm(src, { recursive: true });
    return d;
  }
  await fsMove(src, d, opts?.copy);
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

// sibling info path for per-mount trashes ($topdir/.Trash-$uid): a trash
// location already encodes its root (<root>/files/<name>), so its sidecar is
// <root>/info/<name>.trashinfo. Null unless the path is absolute and inside a
// files dir (relative paths fall back to home lookup).
export const trashInfoPathForTrashFile = (trashFilePath: string): string | null => {
  try {
    if (!path.isAbsolute(trashFilePath)) return null;
    const abs = path.resolve(trashFilePath);
    if (path.basename(path.dirname(abs)) !== "files") return null;
    return path.join(path.dirname(path.dirname(abs)), "info", `${path.basename(abs)}.trashinfo`);
  } catch {
    return null;
  }
};

// sibling-aware cleanup for per-mount trashes ($topdir/.Trash-$uid): the
// trash location already encodes its root (<root>/files/<name>), so delete
// <root>/info/<name>.trashinfo instead of assuming home trash. Falls back to
// home lookup ONLY when the path isn't inside a files dir (relative callers).
// A missing sibling sidecar is NOT a home lookup: a home entry with the same
// basename belongs to a different file, and deleting its .trashinfo would
// orphan it (restore reads Path= from that sidecar).
export const rmTrashInfoForPath = async (trashFilePath: string, log?: (msg: string) => void): Promise<void> => {
  const sibling = trashInfoPathForTrashFile(trashFilePath);
  if (sibling) {
    try {
      await rm(sibling);
    } catch (err) {
      if (errCode(err) !== "ENOENT") log?.(`trashinfo cleanup ${path.basename(trashFilePath)}: ${fsErrText(err)}`);
    }
    return;
  }
  await rmTrashInfo(path.basename(trashFilePath), log);
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
  // unreadable home-parent (the XDG data dir may not exist yet) = home trash
  // only — the old homedir fallback was unreachable (inside one try, the
  // first lstat's throw jumped straight to catch), so deviceOf must not make
  // it live: that walks /tmp targets to /tmp/.Trash-$uid and lands the file
  // OUTSIDE trashDir() (the trashops test pins the old behavior).
  const targetDev = deviceOf(target) ?? deviceOf(path.dirname(path.resolve(target)));
  const homeDev = deviceOf(path.dirname(home));
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
    const curDev = deviceOf(cur);
    if (curDev === null) {
      cur = parent;
      continue;
    }
    const parentDev = deviceOf(parent);
    if (parentDev === null) {
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
// A full move (the source is GONE afterwards) — the seam the trash op uses
// so a cross-device trash can go through the progress-aware copy engine.
export type MoveFn = (src: string, dest: string) => Promise<void>;

export const xdgTrashMove = async (
  p: string,
  opts?: { move?: MoveFn; isCancelled?: () => boolean },
): Promise<string> => {
  const absSrc = path.resolve(p);
  const roots = trashRootsFor(absSrc);
  let lastErr: unknown = null;
  for (const root of roots) {
    try {
      return await xdgTrashMoveToRoot(absSrc, root, opts?.move);
    } catch (err) {
      lastErr = err;
      // a cancelled op must NOT fall through to the next trash root: the
      // fallback would start the whole copy again against the user's ✕
      if (opts?.isCancelled?.()) break;
      // topdir may be read-only/unwritable — fall through to home trash
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
};

export const xdgTrashMoveToRoot = async (
  absSrc: string,
  root: string,
  // injectable move (default fsMove): the sudo replace-stash runs the SAME
  // claim/rename/finalize loop with sudo-mv — one loop, not a near-clone.
  move: (src: string, dest: string) => Promise<void> = fsMove,
): Promise<string> => {
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
    const finalPath = path.join(filesDir, name);
    // An ORPHANED trash entry — the file is in Trash/files but its
    // .trashinfo is not — must never be overwritten: rename(2) REPLACES the
    // target, so the old trashed file's bytes would be destroyed (and the
    // repo can produce that state itself: the info-write rollback removes the
    // .trashinfo while leaving the file behind). The check sits BEFORE the
    // claim on purpose — inside the claim's catch it only ran when the info
    // claim failed, so a file without an info was silently clobbered.
    if (existsSync(finalPath)) {
      name = `${base}.${i}`;
      continue;
    }
    // atomic claim: fails with EEXIST when another trasher owns this name
    try {
      await writeFile(infoPath, `[Trash Info]\nPath=${encoded}\nDeletionDate=${stamp}\n`, { flag: "wx" });
    } catch (err) {
      if (errCode(err) === "EEXIST") {
        name = `${base}.${i}`;
        continue;
      }
      throw err;
    }
    // claimed — now move, then finalize the info (overwrite placeholder)
    try {
      await move(absSrc, finalPath);
    } catch (moveErr) {
      try {
        await rm(infoPath, { force: true });
      } catch (cleanupErr) {
        // a leftover .trashinfo for a file that never moved is an orphan entry
        swallow("trash info cleanup after failed move", cleanupErr);
      }
      throw moveErr;
    }
    try {
      await writeFile(infoPath, `[Trash Info]\nPath=${encoded}\nDeletionDate=${stamp}\n`);
      // best-effort durability: info + dir fsync so a crash doesn't lose the
      // restore mapping for a file that already moved
      try {
        await fsyncPath(infoPath);
      } catch (syncErr) {
        swallow("trash info fsync", syncErr);
      }
    } catch (err) {
      // put the file back — a source-less trash entry is worse than no entry
      try {
        await move(finalPath, absSrc);
      } catch (undoErr) {
        if (err instanceof Error) {
          const e: Error & { rollbackFailed?: unknown } = err;
          e.rollbackFailed = undoErr;
        }
      }
      try {
        await rm(infoPath, { force: true });
      } catch (cleanupErr) {
        // failed rollback of the .trashinfo: the file is back but the entry
        // would linger without this line in the log
        swallow("trash info cleanup after failed write", cleanupErr);
      }
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

// st_dev of the nearest EXISTING ancestor of a path. The path itself often
// does not exist yet — a trash destination is CREATED by the move, and the
// original path of a restore was freed by the trash — so a plain lstat on it
// says "unknown" and a device probe built on it would answer "same device"
// for exactly the cross-device case that needs the slow, progress-aware copy.
export const deviceOfAncestor = (p: string): number | null => {
  let cur = path.resolve(p);
  for (;;) {
    const d = deviceOf(cur);
    if (d !== null) return d;
    const parent = path.dirname(cur);
    if (parent === cur) return null;
    cur = parent;
  }
};

// cross-device probe for a destination that may not exist yet: compare the
// source's device with the nearest existing ancestor of the destination.
export const crossDeviceTo = (a: string, b: string): boolean => {
  const da = deviceOf(a);
  if (da === null) return false;
  const db = deviceOfAncestor(b);
  return db !== null && da !== db;
};

// identity of a live file for undo guards: undo closures trash/restore by
// path, but the path may have been reoccupied since the op (user deleted the
// copy, then made a new file at the same name). dev+ino alone is NOT enough:
// ext4 hands a freed inode straight to the next create, so a stranger made
// right after the delete carries the SAME dev+ino. `born` (birth time, absent
// on filesystems that don't report one) breaks that tie — null when the path
// is gone/unstatable (callers treat null as "unknown, fall back to path
// semantics", never as a match).
export type FileId = { dev: number; ino: number; born?: number };

export const fileIdOf = (p: string): FileId | null => {
  try {
    const s = lstatSync(p);
    return s.birthtimeMs > 0 ? { dev: s.dev, ino: s.ino, born: s.birthtimeMs } : { dev: s.dev, ino: s.ino };
  } catch {
    return null;
  }
};

export const fileIdMatches = (id: FileId | null, p: string): boolean => {
  if (id === null) return true;
  const cur = fileIdOf(p);
  return cur !== null && cur.dev === id.dev && cur.ino === id.ino && (id.born === undefined || cur.born === id.born);
};

// trash `p` only if it is still the recorded file: a missing path is already
// at the desired end-state (success, nothing to do); a reoccupied path is
// skipped with a log (trashing the stranger would be wrong) — neither throws.
// A null id falls back to plain path semantics. Real trash errors propagate.
export const trashIfSameFile = async (p: string, id: FileId | null, log?: (msg: string) => void): Promise<void> => {
  if (!existsSync(p)) return;
  if (id && !fileIdMatches(id, p)) {
    log?.(`undo trash ${p}: file replaced since op, skipped`);
    return;
  }
  await xdgTrashMove(p);
};

// Crash-orphan temp name — the orphan sweep regex in fileops anchors to this
// exact shape (`<base>.tfm-part-<pid>-<rand8>` sibling tmp); a substring
// match there silently deleted real user files (notes.tfm-part-2.md), so the
// shape contract lives in ONE place. (The `.tfm-extract-<pid>-<rand8>` staging
// DIR is a separate dot-prefixed shape, anchored by its own regex.)
export const tmpName = (base: string): string =>
  `${base}.tfm-part-${process.pid}-${Math.random().toString(36).slice(2, 10)}`;

// Exclusive claim of a sibling tmp: the rand name is 64-bit, but two live ops
// on the same dest (or a planted name) would otherwise share one tmp and
// clobber each other mid-copy. mkdir/open-wx fail EEXIST atomically, so a won
// claim is proof of exclusivity; callers retry with a fresh name.
export const claimTmp = async (dest: string, dir = false): Promise<string> => {
  for (let i = 0; i < 10; i++) {
    const cand = tmpName(dest);
    try {
      if (dir) await mkdir(cand);
      else await (await open(cand, "wx")).close();
      return cand;
    } catch (err) {
      if (errCode(err) !== "EEXIST") throw err;
    }
  }
  throw new Error(`cannot claim temp for ${path.basename(dest)}`);
};

// fsync a single path (best-effort close; callers own error policy — the
// trash info fsync logs, the copy finish treats failure as fatal upstream).
export const fsyncPath = async (p: string, mode: string = "r"): Promise<void> => {
  const h = await open(p, mode);
  try {
    await h.sync();
  } finally {
    await h.close().catch(() => {});
  }
};
