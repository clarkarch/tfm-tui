import { createReadStream, createWriteStream, type ReadStream, type Stats } from "node:fs";
import {
  chmod,
  link,
  lstat,
  mkdir,
  open,
  readlink,
  readdir,
  rename,
  rm,
  rmdir,
  symlink,
  utimes,
} from "node:fs/promises";
import path from "node:path";
import { errCode, claimTmp, fileIdMatches, fileIdOf, fsyncPath, type FileId } from "./fsutil";
import { swallow } from "../app/log";

// --- Copy engine: tree walking, pre-scan and streamed file copy with
// pause/cancel/progress. UI-agnostic: callers inject a TransferSink wired to
// their own progress state, so this module imports neither state nor renderer.
// Symlinks are recreated as links (never streamed through), lstat everywhere
// so cycles can't loop.
//
// Durability: every file streams to a sibling tmp file (`<dest>.tfm-part-*`)
// in the SAME directory, then fsync + chmod/utimes (preserve mode/mtime) +
// exclusive hardlink landing + parent dir fsync. A crash can leave a
// `.tfm-part-*` orphan but never a half-visible dest. Directories stage the
// whole tree and claim the destination before renaming it into place. ---

export type TransferSink = {
  // gate between files AND before each entry: waits while paused, throws
  // Error("cancelled") when the transfer was cancelled
  checkpoint: () => Promise<void>;
  // mid-stream queries: the data handler pauses/destroys the live stream
  paused: () => boolean;
  cancelled: () => boolean;
  addBytes: (n: number) => void;
  fileDone: () => void;
  // mid-stream cancel path: the toast's cancel button destroys the current
  // stream, so the sink owns the "which stream is live" bookkeeping
  setStream: (rs: ReadStream) => void;
  clearStream: (rs: ReadStream) => void;
  repaint: (full?: boolean) => void;
};

// onTick (optional) fires every SCAN_TICK_FILES found files — nautilus updates
// its "Preparing…" counter at the same rate so a huge-source scan never looks
// dead. Callback is sync-only; callers must not await inside it.
const SCAN_TICK_FILES = 100;
export const scanTree = async (
  root: string,
  onTick?: (files: number) => void,
): Promise<{ files: number; bytes: number }> => {
  let files = 0,
    bytes = 0;
  const stack = [root];
  while (stack.length) {
    const d = stack.pop() as string;
    // lstat: a symlink counts once by its own size and is never followed
    // (following it would loop forever on cycles and duplicate target trees).
    // NOTE: no inode dedupe here on purpose — a copy writes each hardlinked
    // name out separately (2x bytes land), unlike the status/props on-disk
    // totals which count the shared body once. Unify them and progress lies.
    let st: Stats;
    try {
      st = await lstat(d);
    } catch {
      continue;
    }
    if (!st.isDirectory()) {
      files++;
      bytes += st.size ?? 0;
      if (onTick && files % SCAN_TICK_FILES === 0) onTick(files);
      continue;
    }
    let kids: string[];
    try {
      kids = await readdir(d);
    } catch {
      continue;
    }
    for (const k of kids) stack.push(path.join(d, k));
  }
  return { files, bytes };
};

const fsyncParentDir = (p: string): Promise<void> =>
  // best-effort: tmpfs / permissions may not allow dir fsync — the file
  // fsync + exclusive landing already closed the half-copy window
  fsyncPath(path.dirname(p)).catch(() => {});

export const landCopiedFile = async (
  tmp: string,
  dest: string,
  doLink: (src: string, target: string) => Promise<void> = link,
  afterClaim?: () => void,
): Promise<FileId | null> => {
  try {
    await doLink(tmp, dest);
    return fileIdOf(tmp);
  } catch (err) {
    if (errCode(err) === "EEXIST") throw new Error(`already exists: ${path.basename(dest)}`);
    if (!["EPERM", "ENOTSUP", "EOPNOTSUPP", "ENOSYS", "EMLINK"].includes(String(errCode(err)))) throw err;
    const meta = await lstat(tmp);
    const out = await open(dest, "wx", meta.mode & 0o7777).catch((openErr: unknown) => {
      if (errCode(openErr) === "EEXIST") throw new Error(`already exists: ${path.basename(dest)}`);
      throw openErr;
    });
    const st = await out.stat().catch(async (statErr: unknown) => {
      await out.close().catch(() => {});
      throw statErr;
    });
    const id: FileId =
      st.birthtimeMs > 0 ? { dev: st.dev, ino: st.ino, born: st.birthtimeMs } : { dev: st.dev, ino: st.ino };
    try {
      afterClaim?.();
      for await (const chunk of createReadStream(tmp)) {
        let offset = 0;
        while (offset < chunk.length) {
          const { bytesWritten } = await out.write(chunk, offset, chunk.length - offset);
          if (bytesWritten === 0) throw new Error("copy made no progress");
          offset += bytesWritten;
        }
      }
      await out.chmod(meta.mode & 0o7777).catch(() => {});
      await out.utimes(meta.atime, meta.mtime).catch(() => {});
      await out.sync();
      return id;
    } catch (copyErr) {
      await out.close().catch(() => {});
      if (fileIdMatches(id, dest))
        await rm(dest, { force: true }).catch((cleanup) => swallow("transfer fallback cleanup", cleanup));
      throw copyErr;
    } finally {
      await out.close().catch(() => {});
    }
  }
};

export const copyFileProgress = (src: string, dest: string, sink: TransferSink): Promise<FileId | null> =>
  new Promise((resolve, reject) => {
    // claim the tmp BEFORE stat/stream setup: a shared .tfm-part-* name would
    // interleave two copies' bytes (EEXIST retry inside claimTmp)
    claimTmp(dest).then(
      (tmp) =>
        // stat first for mode/mtime preservation (lstat: copy the link target's
        // meta only when src is a regular file — symlinks never reach here)
        lstat(src).then(
          (srcStat) => {
            mkdir(path.dirname(dest), { recursive: true }).then(
              () => {
                const rs = createReadStream(src);
                const ws = createWriteStream(tmp, { mode: 0o600 });
                sink.setStream(rs);
                rs.on("data", (c: unknown) => {
                  const n =
                    typeof c === "string"
                      ? Buffer.byteLength(c)
                      : c instanceof Uint8Array
                        ? c.length
                        : typeof (c as { length?: unknown })?.length === "number"
                          ? (c as unknown as { length: number }).length
                          : 0;
                  sink.addBytes(n);
                  if (sink.paused()) {
                    try {
                      rs.pause();
                    } catch {}
                  }
                  if (sink.cancelled()) {
                    try {
                      rs.destroy(new Error("cancelled"));
                    } catch {}
                  }
                  sink.repaint();
                });
                let cleared = false;
                const done = () => {
                  // exactly-once: finish/fail AND stream close all call this, and
                  // the TransferSink contract doesn't require idempotent
                  // clearStream (fakes log a double close)
                  if (cleared) return;
                  cleared = true;
                  sink.clearStream(rs);
                };
                let settled = false;
                const cleanupTmp = async (): Promise<void> => {
                  try {
                    await rm(tmp, { force: true });
                  } catch (err) {
                    // a part file that survives cleanup is real disk garbage (the
                    // .tfm-part sweep only catches it on the next transfer)
                    swallow("transfer part-file cleanup", err);
                  }
                };
                ws.on("finish", () => {
                  if (settled) return;
                  settled = true;
                  done();
                  // durability + fidelity: fsync content, restore mode/mtime,
                  // then claim the destination without replacing an occupant
                  (async () => {
                    try {
                      await fsyncPath(tmp, "r+");
                      try {
                        await chmod(tmp, srcStat.mode & 0o7777);
                      } catch {}
                      try {
                        await utimes(tmp, srcStat.atime, srcStat.mtime);
                      } catch {}
                      const id = await landCopiedFile(tmp, dest);
                      await cleanupTmp();
                      await fsyncParentDir(dest);
                      resolve(id);
                    } catch (e) {
                      await cleanupTmp();
                      reject(e);
                    }
                  })();
                });
                const fail = (e: unknown) => {
                  // destroy the write stream too: it was left open while the
                  // tmp/dest cleanup unlinked the partial file — the fd and its
                  // allocated blocks lingered until a GC finalizer bun may never run
                  try {
                    ws.destroy();
                  } catch {}
                  if (!settled) {
                    settled = true;
                    done();
                    void cleanupTmp().then(() => reject(e));
                  } else {
                    void cleanupTmp();
                  }
                };
                ws.on("error", fail);
                rs.on("error", fail);
                rs.on("close", done);
                rs.pipe(ws);
              },
              (e) => reject(e),
            );
          },
          (e) => {
            // stat failed (missing source): the just-claimed tmp is ours and
            // empty — remove it before rejecting or it orphans (nothing streams)
            void rm(tmp, { force: true })
              .catch(() => {})
              .then(() => reject(e));
          },
        ),
      (e) => reject(e),
    );
  });

export const copyTreeProgress = async (src: string, dest: string, sink: TransferSink): Promise<FileId | null> => {
  const st = await lstat(src);
  if (st.isSymbolicLink()) {
    // recreate the link itself — never stream through to the target's contents
    await sink.checkpoint();
    await mkdir(path.dirname(dest), { recursive: true });
    const target = await readlink(src);
    try {
      await symlink(target, dest);
    } catch (err: unknown) {
      // a raced occupant (conflict resolved, then a concurrent create landed)
      // must fail loudly like the file branches — swallowing EEXIST keeps the
      // old link and reports a copy that never happened
      if (errCode(err) === "EEXIST") throw new Error(`already exists: ${path.basename(dest)}`);
      throw err;
    }
    sink.fileDone();
    sink.repaint(true);
    return fileIdOf(dest);
  }
  if (st.isDirectory()) {
    await mkdir(path.dirname(dest), { recursive: true });
    const tmp = await claimTmp(dest, true);
    try {
      for (const k of await readdir(src)) {
        await sink.checkpoint();
        await copyTreeProgress(path.join(src, k), path.join(tmp, k), sink);
      }
      try {
        await chmod(tmp, st.mode & 0o7777);
        await utimes(tmp, st.atime, st.mtime);
      } catch {}
      const tmpId = fileIdOf(tmp);
      await mkdir(dest);
      const claimId = fileIdOf(dest);
      try {
        await rename(tmp, dest);
      } catch (err) {
        if (claimId && fileIdMatches(claimId, dest)) await rmdir(dest).catch(() => {});
        throw err;
      }
      await fsyncParentDir(dest);
      return tmpId;
    } catch (err) {
      await rm(tmp, { recursive: true, force: true }).catch((cleanup) => swallow("transfer stage cleanup", cleanup));
      if (errCode(err) === "EEXIST") throw new Error(`already exists: ${path.basename(dest)}`);
      throw err;
    }
  } else {
    await sink.checkpoint();
    await mkdir(path.dirname(dest), { recursive: true });
    const id = await copyFileProgress(src, dest, sink);
    sink.fileDone();
    sink.repaint(true);
    return id;
  }
};

// Recursive delete with per-entry checkpoints (pause/cancel) and progress
// accounting. Same lstat semantics as scanTree: symlinks are unlinked, never
// followed into their target; only files/links count toward files/bytes,
// directories are checkpointed but not counted. Throws Error("cancelled")
// from the sink's checkpoint (or the real rm error) — the caller decides
// whether that ends a batch, exactly like copyTreeProgress. ---
export const rmTreeProgress = async (root: string, sink: TransferSink): Promise<void> => {
  const st = await lstat(root);
  if (st.isDirectory()) {
    for (const k of await readdir(root)) {
      await sink.checkpoint();
      await rmTreeProgress(path.join(root, k), sink);
    }
    await sink.checkpoint();
    await rmdir(root);
    return;
  }
  await sink.checkpoint();
  await rm(root, { force: true });
  sink.addBytes(st.size ?? 0);
  sink.fileDone();
  sink.repaint(true);
};
