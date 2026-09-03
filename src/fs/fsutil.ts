import { cp, mkdir, rename as fsRename, rm, writeFile } from "node:fs/promises";
import { existsSync, lstatSync } from "node:fs";
import os from "node:os";
import path from "node:path";

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
export const isTrashFilesDir = (p: string): boolean => path.resolve(p) === path.join(trashDir(), "files");

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

// errno-style .code off an unknown caught value (fs renames, child-proc
// failures) — structural narrowing instead of `any`
const errCode = (err: unknown): unknown => {
  if (typeof err === "object" && err !== null && "code" in err) return err.code;
  return undefined;
};

// nautilus naming for an OCCUPIED name: first suggestion is " (copy)", then
// " (copy 2)", … Callers must only invoke this when `dir/base` already exists
// (runTransfer collisions, replace-stash) — the base name itself is never
// checked, and that's load-bearing for the replace flow's expectations.
export const uniqueTarget = (dir: string, base: string): string => {
  const dot = base.lastIndexOf(".");
  const stem = dot > 0 ? base.slice(0, dot) : base;
  const ext = dot > 0 ? base.slice(dot) : "";
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
    await cp(src, dest, { recursive: true });
    await rm(src, { recursive: true });
  }
};

// undo/restore moves must never clobber whatever now occupies the target —
// rename() silently overwrites on Linux, so a file created between the original
// op and ctrl+z would be destroyed. Bump to "name (copy)" instead.
export const safeRestoreMove = async (src: string, dest: string): Promise<void> => {
  let d = dest;
  if (existsSync(d)) d = uniqueTarget(path.dirname(d), path.basename(d));
  await mkdir(path.dirname(d), { recursive: true });
  await fsMove(src, d);
};

// XDG trash fallback: `gio trash` fails on tmpfs ("system internal mounts"),
// so we write the .trashinfo ourselves and move into Trash/files. Returns the
// final path (name may be suffixed .2, .3 … on collisions).
//
// Ordering matters: the move happens FIRST, the .trashinfo only after it —
// writing the info first left an orphan entry pointing at a file that never
// arrived whenever the move failed (dead row in every trash browser). If the
// info write fails after a successful move, roll the move back so trash state
// stays consistent (either fully trashed or untouched). Residual race: the
// collision-name check is existsSync-then-rename, so a concurrent trasher
// could still claim the name between check and move (portable APIs expose no
// atomic no-clobber rename for dirs).
export const xdgTrashMove = async (p: string): Promise<string> => {
  const filesDir = path.join(trashDir(), "files");
  const infoDir = path.join(trashDir(), "info");
  await mkdir(filesDir, { recursive: true });
  await mkdir(infoDir, { recursive: true });
  const base = path.basename(p);
  let name = base;
  for (let i = 2; existsSync(path.join(filesDir, name)); i++) name = `${base}.${i}`;
  const finalPath = path.join(filesDir, name);
  await fsMove(p, finalPath);
  const stamp = new Date().toISOString().replace(/\.\d+Z$/, "Z");
  try {
    await writeFile(path.join(infoDir, `${name}.trashinfo`), `[Trash Info]\nPath=${p}\nDeletionDate=${stamp}\n`);
  } catch (err) {
    // put the file back — a source-less trash entry is worse than no entry
    try {
      await fsMove(finalPath, p);
    } catch (undoErr) {
      if (err instanceof Error) {
        const e: Error & { rollbackFailed?: unknown } = err;
        e.rollbackFailed = undoErr;
      }
    }
    throw err;
  }
  return finalPath;
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
