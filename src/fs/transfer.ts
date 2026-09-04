import { createReadStream, createWriteStream, type ReadStream, type Stats } from "node:fs";
import { lstat, mkdir, readlink, readdir, rename, rm, symlink, open, chmod, utimes } from "node:fs/promises";
import path from "node:path";

// --- Copy engine: tree walking, pre-scan and streamed file copy with
// pause/cancel/progress. UI-agnostic: callers inject a TransferSink wired to
// their own progress state, so this module imports neither state nor renderer.
// Symlinks are recreated as links (never streamed through), lstat everywhere
// so cycles can't loop.
//
// Durability: every file streams to a sibling tmp file (`<dest>.tfm-part-*`)
// in the SAME directory (same filesystem, so the final rename is atomic),
// then fsync + chmod/utimes (preserve mode/mtime) + atomic rename + parent
// dir fsync. A crash can leave a `.tfm-part-*` orphan but never a half-visible
// dest. Dir modes/mtimes are restored after children land. ---

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

export const scanTree = async (root: string): Promise<{ files: number; bytes: number }> => {
  let files = 0,
    bytes = 0;
  const stack = [root];
  while (stack.length) {
    const d = stack.pop() as string;
    // lstat: a symlink counts once by its own size and is never followed
    // (following it would loop forever on cycles and duplicate target trees)
    let st: Stats;
    try {
      st = await lstat(d);
    } catch {
      continue;
    }
    if (!st.isDirectory()) {
      files++;
      bytes += st.size ?? 0;
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

const tmpSibling = (dest: string): string =>
  `${dest}.tfm-part-${process.pid}-${Math.random().toString(36).slice(2, 10)}`;

const fsyncParentDir = async (p: string): Promise<void> => {
  try {
    const h = await open(path.dirname(p), "r");
    try {
      await h.sync();
    } finally {
      await h.close().catch(() => {});
    }
  } catch {
    // best-effort: tmpfs / permissions may not allow dir fsync — the file
    // fsync + atomic rename already closed the half-copy window
  }
};

export const copyFileProgress = (src: string, dest: string, sink: TransferSink): Promise<void> =>
  new Promise((resolve, reject) => {
    // stat first for mode/mtime preservation (lstat: copy the link target's
    // meta only when src is a regular file — symlinks never reach here)
    lstat(src).then(
      (srcStat) => {
        const tmp = tmpSibling(dest);
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
              if (sink.repaint) sink.repaint();
            });
            const done = () => sink.clearStream(rs);
            let settled = false;
            const cleanupTmp = async (): Promise<void> => {
              try {
                await rm(tmp, { force: true });
              } catch {}
            };
            ws.on("finish", () => {
              if (settled) return;
              settled = true;
              done();
              // durability + fidelity: fsync content, restore mode/mtime,
              // then atomic rename into place
              (async () => {
                try {
                  const h = await open(tmp, "r+");
                  try {
                    await h.sync();
                  } finally {
                    await h.close().catch(() => {});
                  }
                  try {
                    await chmod(tmp, srcStat.mode & 0o7777);
                  } catch {}
                  try {
                    await utimes(tmp, srcStat.atime, srcStat.mtime);
                  } catch {}
                  await rename(tmp, dest);
                  await fsyncParentDir(dest);
                  resolve();
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
      (e) => reject(e),
    );
  });

export const copyTreeProgress = async (src: string, dest: string, sink: TransferSink): Promise<void> => {
  const st = await lstat(src);
  if (st.isSymbolicLink()) {
    // recreate the link itself — never stream through to the target's contents
    await sink.checkpoint();
    await mkdir(path.dirname(dest), { recursive: true });
    const target = await readlink(src);
    try {
      await symlink(target, dest);
    } catch (err: unknown) {
      const code = typeof err === "object" && err !== null && "code" in err ? err.code : undefined;
      if (code !== "EEXIST") throw err;
    }
    sink.fileDone();
    sink.repaint(true);
    return;
  }
  if (st.isDirectory()) {
    await mkdir(dest, { recursive: true });
    // best-effort dir mode now; mtime restored after children (mtime would
    // otherwise reflect the last child creation, not the source)
    try {
      await chmod(dest, st.mode & 0o7777);
    } catch {}
    for (const k of await readdir(src)) {
      await sink.checkpoint();
      await copyTreeProgress(path.join(src, k), path.join(dest, k), sink);
    }
    try {
      await utimes(dest, st.atime, st.mtime);
    } catch {}
  } else {
    await sink.checkpoint();
    await mkdir(path.dirname(dest), { recursive: true });
    await copyFileProgress(src, dest, sink);
    sink.fileDone();
    sink.repaint(true);
  }
};
