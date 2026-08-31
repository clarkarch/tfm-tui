import { createReadStream, createWriteStream, type ReadStream, type Stats } from "node:fs";
import { lstat, mkdir, readdir, readlink, symlink } from "node:fs/promises";
import path from "node:path";

// --- Copy engine: tree walking, pre-scan and streamed file copy with
// pause/cancel/progress. UI-agnostic: callers inject a TransferSink wired to
// their own progress state, so this module imports neither state nor renderer.
// Symlinks are recreated as links (never streamed through), lstat everywhere
// so cycles can't loop. ---

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
  let files = 0, bytes = 0;
  const stack = [root];
  while (stack.length) {
    const d = stack.pop()!;
    // lstat: a symlink counts once by its own size and is never followed
    // (following it would loop forever on cycles and duplicate target trees)
    let st: Stats;
    try { st = await lstat(d); } catch { continue; }
    if (!st.isDirectory()) { files++; bytes += st.size ?? 0; continue; }
    let kids: string[];
    try { kids = await readdir(d); } catch { continue; }
    for (const k of kids) stack.push(path.join(d, k));
  }
  return { files, bytes };
};

export const copyFileProgress = (src: string, dest: string, sink: TransferSink): Promise<void> =>
  new Promise((resolve, reject) => {
    const rs = createReadStream(src);
    const ws = createWriteStream(dest);
    sink.setStream(rs);
    rs.on("data", (c: any) => {
      sink.addBytes(c?.length ?? 0);
      if (sink.paused()) { try { rs.pause(); } catch {} }
      if (sink.cancelled()) { try { rs.destroy(new Error("cancelled")); } catch {} }
      if (sink.repaint) sink.repaint();
    });
    const done = () => sink.clearStream(rs);
    let settled = false;
    ws.on("finish", () => { if (!settled) { settled = true; done(); resolve(); } });
    const fail = (e: any) => { if (!settled) { settled = true; done(); reject(e); } };
    ws.on("error", fail);
    rs.on("error", fail);
    rs.on("close", done);
    rs.pipe(ws);
  });

export const copyTreeProgress = async (src: string, dest: string, sink: TransferSink): Promise<void> => {
  const st = await lstat(src);
  if (st.isSymbolicLink()) {
    // recreate the link itself — never stream through to the target's contents
    await sink.checkpoint();
    await mkdir(path.dirname(dest), { recursive: true });
    const target = await readlink(src);
    try { await symlink(target, dest); } catch (err: any) { if (err?.code !== "EEXIST") throw err; }
    sink.fileDone();
    sink.repaint(true);
    return;
  }
  if (st.isDirectory()) {
    await mkdir(dest, { recursive: true });
    for (const k of await readdir(src)) {
      await sink.checkpoint();
      await copyTreeProgress(path.join(src, k), path.join(dest, k), sink);
    }
  } else {
    await sink.checkpoint();
    await mkdir(path.dirname(dest), { recursive: true });
    await copyFileProgress(src, dest, sink);
    sink.fileDone();
    sink.repaint(true);
  }
};
