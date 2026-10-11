// --- OSC 72 (kitty drag-and-drop) state machine: outgoing drag sessions,
// incoming drop payloads and the self-drop hover/highlight routing, as a
// factory with injected UI callbacks (same seam as grid-input.ts). The wire
// frames and payload decoding live in ./osc72 (pure, byte-exact with yazi);
// everything renderer-coupled (hit-testing, tile visuals, place hover)
// arrives via ctx. ---

import path from "node:path";
import os from "node:os";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import {
  agreeDragFrame,
  agreeDropFrame,
  agreeSelfDropFrame,
  cancelDropFrame,
  dragIconFrame,
  dragOutEnableFrame,
  dropDisableFrame,
  dropInEnableFrame,
  dropMachineIdFrame,
  dropPayloadToPaths,
  finishDropFrame,
  finishSelfDropFrame,
  parseOsc72Meta,
  presentDragFrames,
  rejectHoverFrame,
  releaseRemoteDirFrame,
  requestRemoteChildFrame,
  requestRemoteFileFrame,
  serveDataFrames,
  serveErrorFrame,
  startDragFrame,
  startDropFrame,
  uriListPayload,
} from "./osc72";
import { fileUriToPath } from "../fs/uri";
import { gridDrag, TileVisual, type ClipItem, type GridTileRef, type TileVisualMode } from "../input/grid-input";
import { splitStemExt, trashDir } from "../fs/fsutil";
import type { NotifyLevel } from "../lib/notify-level";

// terminal-provided error text can be long or binary — keep one short line
// for the status bar; the full payload stays in the debug log
const shortReason = (s: string): string => (s.length > 80 ? `${s.slice(0, 77)}…` : s) || "unknown error";

// "]72;<meta>;<payload>" → { meta, payload } — ST/BEL/8-bit terminators are
// stripped; null when the sequence isn't OSC 72
export const splitOsc72Seq = (seq: string): { meta: string; payload: string } | null => {
  const start = seq.indexOf("]72;");
  if (start < 0) return null;
  // biome-ignore lint/suspicious/noControlCharactersInRegex: OSC terminators (ST/BEL) are control bytes
  const body = seq.slice(start + 4).replace(/(\x1b\\|\x07|\x9c)$/, "");
  const sep = body.indexOf(";");
  return { meta: sep < 0 ? body : body.slice(0, sep), payload: sep < 0 ? "" : body.slice(sep + 1) };
};

export type DropTarget = { kind: "folder" | "place"; path: string };

export type Dnd72Ctx = {
  log(msg: string): void;
  // emit a wire frame (stdout in the app; captured in tests)
  writeFrame(s: string): void;
  // resolve a terminal cell to an internal drop target (folder tile or place);
  // dragPaths lets the hit filter exclude the tiles being dragged
  hitTargetAt(x: number, y: number, dragPaths: string[] | null): DropTarget | null;
  tileRefs: Map<string, GridTileRef>;
  setTileVisual(key: string, mode: TileVisualMode): void;
  // sidebar place highlight while a self-drop hovers it
  hoverPlace(path: string): void;
  clearHoverPlace(): void;
  // pointer is about to be grabbed by the terminal — end the internal drag
  finishDrag(): void;
  escMenuOpen(): boolean;
  fileMenuOpen(): boolean;
  trashPaths(paths: string[]): Promise<void>;
  moveInto(destDir: string, items: ClipItem[]): Promise<void>;
  runTransfer(op: "copy" | "move", destDir: string, srcs: string[], label: string): Promise<void>;
  cwd(): string;
  virtualCwd(): boolean;
  // trash view — external drops land in Trash: route them through trashPaths
  // (trashinfo metadata), never a raw copy into Trash/files
  inTrashView(): boolean;
  // live drag state stays on the status bar (transient, reclaimed after);
  // outcomes (sent/failed) surface as leveled toasts
  setStatusMsg(msg: string): void;
  notify(msg: string, title?: string, level?: NotifyLevel): void;
  // hashed local machine id for the drop-side declaration (lets kitty flag
  // cross-machine payloads with X=1). Absent = unknown, id frame is skipped.
  machineId?(): string;
  // per-request timeout for remote file fetches (ms) + total staged-bytes cap;
  // injectable so tests don't wait out / fill up the production values
  remoteTimeoutMs?(): number;
  remoteMaxBytes?(): number;
  // sanctioned OSC receiver — never a second process.stdin listener
  subscribeOsc(cb: (seq: string) => void): void;
};

export const makeDnd72 = (ctx: Dnd72Ctx) => {
  const write = (s: string, label: string): void => {
    ctx.log(`tx ${label}`);
    try {
      ctx.writeFrame(s);
    } catch {}
  };

  const enableDrops = (): void => {
    // id omitted when unknown — without it kitty treats every drop as local
    // (today's behavior); declared, kitty flags cross-machine payloads (X=1)
    const id = ctx.machineId?.() ?? "";
    write(dragOutEnableFrame(id), "enable drag-out");
    write(dropInEnableFrame(), "enable drop-in");
    // drop-side declaration rides a second frame (kitty Go StartAcceptingDrops order)
    if (id) write(dropMachineIdFrame(id), "enable drop machine-id");
  };
  const disableDrops = (): void => write(dropDisableFrame(), "disable drop");

  // --- session state ---
  let dropIdx = -1;
  const arrive: Record<number, string> = {};
  // X=1 on the uri-list response flags a cross-machine payload (only sent
  // because enableDrops declared our id). Tracked per in-flight drop.
  let dropRemote = false;
  let dragPaths: string[] | null = null;
  // entries behind the outgoing drag, in presented order — t=k serve requests
  // resolve their 1-based idx against this (cleared with dragPaths)
  let dragEntries: ClipItem[] | null = null;
  let dragOp = 1; // 1 copy / 2 move
  // dir-handle counter for served subtrees (0/1 are file/symlink, never handles)
  let serveHandle = 1;
  let selfTargetKey: string | null = null; // folder tile currently highlighted
  // session whose self-drop already finished — the end event (t=e:x=4:y=1,
  // canceled=true) that follows every accepted drop must not overwrite the
  // status with "drag cancelled" after a successful internal move
  let selfDropDoneSession = -1;
  let endTimer: ReturnType<typeof setTimeout> | null = null;
  let endTimerSession = 0; // which drag session the pending epilogue belongs to
  // monotonically rising session token: the deferred end epilogue closes over
  // the token it belongs to, so a stale timer firing inside a NEWER session
  // can neither read the new session's live op (a copy drag's sources were
  // trashed when the new drag was a move) nor clear the new session's state
  let dragSession = 0;

  const clearSelfDropHighlight = (): void => {
    if (selfTargetKey) {
      const r = ctx.tileRefs.get(selfTargetKey);
      if (r && !r.selected) ctx.setTileVisual(selfTargetKey, TileVisual.Rest);
      selfTargetKey = null;
    }
  };

  // kitty renders this text badge next to the cursor for the whole drag session —
  // the visual feedback we lose by handing the pointer to the OS
  const sendDragIcon = (n: number): void => {
    write(dragIconFrame(n), "drag icon");
  };

  // length of the unpadded base64 payload, for the debug label only
  const dropPayloadLength = (paths: string[]): number => uriListPayload(paths).length;

  const presentDragUriList = (entries: ClipItem[]): void => {
    // directory URLs MUST end with / or the far side reads them as files;
    // the slash survives percentEncodePath (empty trailing segment)
    const paths = entries.map((e) => (e.isDir && !e.path.endsWith("/") ? `${e.path}/` : e.path));
    const [dataFrame, endFrame] = presentDragFrames(paths);
    write(dataFrame, `present drag ${dropPayloadLength(paths)} b64 chars`);
    write(endFrame, "present drag end");
  };

  const beginDrag = (entries: ClipItem[]): void => {
    // a drag starting inside a previous session's 700ms end window must not
    // inherit the stale epilogue: it would wipe THIS payload and read THIS
    // session's op against the OLD session's paths
    dragSession++;
    dragPaths = entries.map((e) => e.path);
    dragEntries = entries;
    serveHandle = 1;
    dragOp = 1;
    selfDropDoneSession = -1;
    ctx.finishDrag(); // pointer is about to be grabbed by the terminal
    write(agreeDragFrame(), "agree drag either");
    presentDragUriList(entries);
    sendDragIcon(entries.length);
    write(startDragFrame(), "start drag");
    ctx.setStatusMsg(
      `Dragging ${entries.length} item${entries.length === 1 ? "" : "s"} — drop into another app or a folder`,
    );
  };

  // self-dropped back onto tfm: route to the folder/place under the cursor,
  // otherwise cancel — this is what makes one plain drag serve both worlds.
  // Returns the resolved target so the caller answers kitty's hover offer
  // (agree/reject per hover — without an answer kitty marks the drop as not
  // accepted and cancels it on release, so the t=M below never arrives).
  const handleSelfDropHover = (x: number, y: number): DropTarget | null => {
    clearSelfDropHighlight();
    const target = x >= 0 ? ctx.hitTargetAt(x, y, dragPaths) : null;
    ctx.log(`self hover ${x},${y} -> ${target ? `${target.kind}:${target.path}` : "none"}`);
    if (!target) {
      ctx.clearHoverPlace();
      return null;
    }
    if (target.kind === "folder") {
      selfTargetKey = target.path;
      // a folder tile wins over any previous place hover highlight
      ctx.clearHoverPlace();
      ctx.setTileVisual(target.path, TileVisual.Selected);
    } else {
      ctx.hoverPlace(target.path);
    }
    return target;
  };

  const finishSelfDrop = async (x: number, y: number): Promise<void> => {
    ctx.log(`self drop at ${x},${y}`);
    if (endTimer && endTimerSession === dragSession) {
      // this session's own pending epilogue is superseded by a self drop;
      // an OLDER session's deferred epilogue still runs — cancelling it here
      // would skip its move-semantics source cleanup (the trash)
      clearTimeout(endTimer);
      endTimer = null;
    }
    const paths = dragPaths;
    selfDropDoneSession = dragSession;
    const target = ctx.hitTargetAt(x, y, dragPaths);
    clearSelfDropHighlight();
    ctx.clearHoverPlace();
    dragPaths = null;
    dragEntries = null;
    if (!paths?.length || !target) {
      write(cancelDropFrame(), "self drop rejected");
      ctx.setStatusMsg("drag cancelled");
      return;
    }
    const destDir = target.path;
    write(finishSelfDropFrame(), "self drop accepted");
    // same routing as tile/place drops: conflict prompt, undo units, honest counts —
    // never silently skip collisions; the trash place must go through
    // trashPaths (own .trashinfo writer), not raw-move
    if (destDir === path.join(trashDir(), "files")) {
      void ctx.trashPaths(paths);
      return;
    }
    const items: ClipItem[] = paths.map((p) => ({
      path: p,
      isDir:
        ctx.tileRefs.get(p)?.isDir ??
        (() => {
          try {
            return statSync(p).isDirectory();
          } catch {
            return false;
          }
        })(),
    }));
    await ctx.moveInto(destDir, items);
  };

  // --- remote drops (cross-machine, X=1): per-entry bytes are fetched with
  // t=r:x=idx:y=subidx (both 1-based) into a staging dir, then land through
  // the normal runTransfer path. Requests run strictly sequentially, so at
  // most one fetch is outstanding — responses are matched by key, and a
  // metadata-less chunk (continuations may omit all keys but m) continues it.
  type RemotePending = {
    key: string;
    chunks: string[];
    pendingBytes: number;
    X: number; // entry kind from the first chunk (NaN->0 file, 1 symlink, else dir handle)
    resolve: (data: Buffer, X: number) => void;
    reject: (err: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  };
  type RemoteFetchState = { stagingDir: string; stagedBytes: number; pending: RemotePending | null };
  let remoteFetch: RemoteFetchState | null = null;
  // disk-staging cap (the /tmp tmpfs is small — a runaway terminal must not
  // fill it); the timeout bounds wall-clock, this bounds bytes
  const REMOTE_DROP_MAX_BYTES = 512 * 1024 * 1024;

  const remoteKey = (x: number, y: number, Y: number, t: string): string | null => {
    if (!Number.isNaN(y) && !Number.isNaN(x)) return `${x}:${y}`;
    if (!Number.isNaN(Y) && !Number.isNaN(x)) return `Y${Y}:${x}`;
    // continuation chunks may carry no keys at all — they extend the pending fetch
    if (t === "" && remoteFetch?.pending) return remoteFetch.pending.key;
    return null;
  };

  const abortRemoteFetch = (reason: string | null): void => {
    const st = remoteFetch;
    remoteFetch = null;
    if (!st) return;
    if (st.pending) {
      clearTimeout(st.pending.timer);
      st.pending = null;
    }
    try {
      rmSync(st.stagingDir, { recursive: true, force: true });
    } catch {}
    write(cancelDropFrame(), "remote drop aborted");
    if (reason) ctx.notify(`Remote drop failed (${reason})`, "drop failed", "error");
  };

  // send one fetch request and resolve with the reassembled bytes + kind when
  // its EOF (empty payload, m=0) arrives; terminal errors and the timeout
  // reject instead. Timer spans the whole request (all its chunks).
  const awaitRemoteResponse = (frame: string, label: string, key: string): Promise<{ data: Buffer; X: number }> =>
    new Promise((resolve, reject) => {
      const st = remoteFetch;
      if (!st) {
        reject(new Error("drop ended"));
        return;
      }
      const timer = setTimeout(() => {
        if (remoteFetch?.pending?.key === key) remoteFetch.pending = null;
        reject(new Error("timed out waiting for the terminal"));
      }, ctx.remoteTimeoutMs?.() ?? 30000);
      st.pending = {
        key,
        chunks: [],
        pendingBytes: 0,
        X: NaN,
        resolve: (data, X) => {
          clearTimeout(timer);
          if (remoteFetch?.pending?.key === key) remoteFetch.pending = null;
          resolve({ data, X });
        },
        reject: (err) => {
          clearTimeout(timer);
          if (remoteFetch?.pending?.key === key) remoteFetch.pending = null;
          reject(err);
        },
        timer,
      };
      write(frame, label);
    });

  // entry names come from a remote machine — never let them escape staging
  const safeEntryName = (raw: string): string | null => {
    const name = path.basename(raw);
    if (!name || name === "." || name === ".." || name.includes("\0")) return null;
    return name;
  };

  // same-named entries from different remote dirs (or dup names in one
  // listing) must not share a staged path — the second fetch would overwrite
  // the first's bytes. Nautilus dialect via splitStemExt (base free → base,
  // else " (copy)"), but lstat-based: a staged DANGLING symlink (the common
  // case — remote targets) still occupies its name, and existsSync/statSync
  // follow links and would report it free.
  const dedupeStagedName = (dir: string, base: string): string => {
    const occupied = (p: string): boolean => {
      try {
        lstatSync(p);
        return true;
      } catch {
        return false;
      }
    };
    if (!occupied(path.join(dir, base))) return path.join(dir, base);
    const { stem, ext } = splitStemExt(base);
    for (let i = 2; ; i++) {
      const next = path.join(dir, i === 2 ? `${stem} (copy)${ext}` : `${stem} (copy ${i - 1})${ext}`);
      if (!occupied(next)) return next;
    }
  };

  const fetchRemoteEntry = async (uriIdx: number, subIdx: number, dest: string): Promise<void> => {
    const { data, X } = await awaitRemoteResponse(
      requestRemoteFileFrame(uriIdx, subIdx),
      `remote fetch entry ${subIdx}`,
      `${uriIdx}:${subIdx}`,
    );
    await stageRemoteData(data, X, dest, null);
  };

  const fetchRemoteChild = async (handle: number, num: number, dest: string): Promise<void> => {
    const { data, X } = await awaitRemoteResponse(
      requestRemoteChildFrame(handle, num),
      `remote fetch child ${num} of ${handle}`,
      `Y${handle}:${num}`,
    );
    await stageRemoteData(data, X, dest, handle);
  };

  const stageRemoteData = async (data: Buffer, X: number, dest: string, _handle: number | null): Promise<void> => {
    const st = remoteFetch;
    if (!st) throw new Error("drop ended");
    st.stagedBytes += data.length;
    if (st.stagedBytes > (ctx.remoteMaxBytes?.() ?? REMOTE_DROP_MAX_BYTES)) throw new Error("drop too large");
    if (X === 1) {
      symlinkSync(data.toString("utf8"), dest);
      return;
    }
    if (X !== 0) {
      // directory: NUL-separated child names, fetched sequentially and
      // released once the whole subtree is staged (breadth-first per spec
      // costs concurrent handles; sequential holds one chain at a time)
      const names = data.toString("utf8").split("\0").filter(Boolean);
      mkdirSync(dest, { recursive: true });
      const clean: string[] = [];
      for (const raw of names) {
        const name = safeEntryName(raw);
        if (!name || raw.includes("/")) throw new Error(`bad entry name ${JSON.stringify(raw)}`);
        clean.push(name);
      }
      for (let n = 0; n < clean.length; n++) {
        const name = clean[n] ?? "";
        await fetchRemoteChild(X, n + 1, dedupeStagedName(dest, name));
      }
      write(releaseRemoteDirFrame(X), `remote release dir ${X}`);
      return;
    }
    writeFileSync(dest, data);
  };

  const receiveRemoteDrop = async (uriIdx: number, listText: string): Promise<void> => {
    const lines = listText.split(/\r?\n/).filter(Boolean);
    if (!lines.length || lines.some((l) => !l.startsWith("file://"))) {
      write(cancelDropFrame(), "remote drop rejected");
      if (lines.length) ctx.notify("Remote drop has unsupported entries (only file://)", "drop failed", "error");
      return;
    }
    if (remoteFetch) {
      // busy-guarded at t=M time; defensive — never interleave two fetches
      write(cancelDropFrame(), "remote drop busy");
      return;
    }
    // stagingDir starts empty so a mkdtemp throw still routes through the
    // abort below (cancel frame + toast) instead of escaping as an unhandled
    // rejection out of the fire-and-forget finishDrop
    remoteFetch = { stagingDir: "", stagedBytes: 0, pending: null };
    let stagingDir = "";
    try {
      stagingDir = mkdtempSync(path.join(os.tmpdir(), "tfm-remote-"));
      const st = remoteFetch;
      if (st) st.stagingDir = stagingDir;
      const staged: string[] = [];
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i] ?? "";
        const name = safeEntryName(fileUriToPath(line));
        if (!name) throw new Error(`bad entry name ${JSON.stringify(line)}`);
        const dest = dedupeStagedName(stagingDir, name);
        await fetchRemoteEntry(uriIdx, i + 1, dest);
        staged.push(dest);
      }
      // same landing as local drops: real folders copy (conflict/undo free),
      // the trash view trashes the staged files (trashinfo metadata)
      if (ctx.inTrashView()) await ctx.trashPaths(staged);
      else
        await ctx.runTransfer("copy", ctx.cwd(), staged, `drop ${staged.length} item${staged.length === 1 ? "" : "s"}`);
      write(finishDropFrame(), "remote drop finished");
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      abortRemoteFetch(shortReason(reason));
    } finally {
      remoteFetch = null;
      try {
        rmSync(stagingDir, { recursive: true, force: true });
      } catch {}
    }
  };

  // route one t=r/t=R/t="" frame into the pending fetch; anything unmatched is
  // logged and ignored (a stray chunk must not kill the drop)
  const handleRemoteChunk = (
    t: string,
    x: number,
    y: number,
    X: number,
    Y: number,
    m: boolean,
    payload: string,
  ): void => {
    const st = remoteFetch;
    if (!st) return;
    if (t === "R") {
      const reason = shortReason(payload.split(":")[0] || "terminal error");
      st.pending?.reject(new Error(reason));
      return;
    }
    const key = remoteKey(x, y, Y, t);
    if (!key || !st.pending || st.pending.key !== key) {
      ctx.log(`remote stray chunk t=${JSON.stringify(t)} key=${key ?? "none"}`);
      return;
    }
    const pending = st.pending;
    // first chunk carries the full meta (continuations may omit keys) — its X
    // decides file (0/absent) vs symlink (1) vs dir (handle)
    if (pending.chunks.length === 0 && t !== "") pending.X = Number.isNaN(X) ? 0 : X;
    pending.pendingBytes += Math.ceil((payload.length * 3) / 4); // b64 chars -> decoded bytes
    if (st.stagedBytes + pending.pendingBytes > (ctx.remoteMaxBytes?.() ?? REMOTE_DROP_MAX_BYTES)) {
      pending.reject(new Error("drop too large"));
      return;
    }
    pending.chunks.push(payload);
    // end of data is an empty payload with m=0 (same rule as the local path)
    if (!payload && !m) {
      const data = Buffer.concat(pending.chunks.map((c) => Buffer.from(c, "base64")));
      // a metadata-less first chunk leaves X unknown (spec-violating peer —
      // the first chunk must carry meta) — default to file, never dir
      pending.resolve(data, Number.isNaN(pending.X) ? 0 : pending.X);
    }
  };

  // --- remote serve (dragging TO a remote machine): the terminal requests our
  // entries with t=k:x=idx (1-based into the presented uri-list). Files serve
  // bytes, symlinks serve X=1 + target, dirs serve X=handle + NUL names and
  // then push EVERY child recursively (breadth-first — the terminal never
  // requests children itself). Read failures answer t=E so the terminal
  // aborts the drag instead of hanging on a missing EOF.
  const posixName = (err: unknown): string => {
    const code =
      err instanceof Error && typeof (err as NodeJS.ErrnoException).code === "string"
        ? ((err as NodeJS.ErrnoException).code ?? "")
        : "";
    return /^[A-Z]+$/.test(code) ? code : "EIO";
  };

  // readlink first so links classify as links even when dangling (statSync
  // follows them); anything else yields null (missing, fifo, socket, …)
  const kindOf = (p: string): "link" | "dir" | "file" | null => {
    try {
      readlinkSync(p);
      return "link";
    } catch {}
    try {
      const st = statSync(p);
      if (st.isDirectory()) return "dir";
      if (st.isFile()) return "file";
      return null;
    } catch {
      return null;
    }
  };

  const serveDragPath = (fsPath: string, meta: string, label: string): void => {
    const kind = kindOf(fsPath);
    try {
      if (kind === "link") {
        const target = readlinkSync(fsPath);
        const b64 = Buffer.from(target, "utf8").toString("base64").replace(/=+$/, "");
        for (const f of serveDataFrames(`${meta}:X=1`, b64)) write(f, `${label} symlink`);
        return;
      }
      if (kind === "dir") {
        serveDragDir(fsPath, meta, label);
        return;
      }
      if (kind === "file") {
        const b64 = readFileSync(fsPath).toString("base64").replace(/=+$/, "");
        for (const f of serveDataFrames(meta, b64)) write(f, `${label} file`);
        return;
      }
    } catch (err) {
      write(serveErrorFrame(posixName(err)), `${label} read failed`);
      return;
    }
    // classified as nothing (vanished between kindOf and the read, or a
    // fifo/socket) — report the stat errno so the terminal aborts the drag
    let code = "EIO";
    try {
      statSync(fsPath);
    } catch (err) {
      code = posixName(err);
    }
    write(serveErrorFrame(code), `${label} unreadable`);
  };

  const serveDragDir = (fsPath: string, meta: string, label: string): void => {
    // BFS: the terminal never requests children itself — every level's names
    // go out with a fresh handle and the whole next level is enqueued
    const queue: Array<{ dir: string; meta: string; handle: number }> = [
      { dir: fsPath, meta, handle: ++serveHandle + 1 },
    ];
    try {
      while (queue.length) {
        const item = queue.shift();
        if (!item) break;
        const names: string[] = [];
        for (const name of readdirSync(item.dir)) {
          if (kindOf(path.join(item.dir, name))) names.push(name);
        }
        const b64 = Buffer.from(names.join("\0"), "utf8").toString("base64").replace(/=+$/, "");
        for (const f of serveDataFrames(`${item.meta}:X=${item.handle}`, b64)) write(f, `${label} dir`);
        names.forEach((name, n) => {
          const childMeta = `${item.meta}:Y=${item.handle}:y=${n + 1}`;
          const child = path.join(item.dir, name);
          if (kindOf(child) === "dir") queue.push({ dir: child, meta: childMeta, handle: ++serveHandle + 1 });
          else serveDragPath(child, childMeta, `${label} child`);
        });
      }
    } catch (err) {
      write(serveErrorFrame(posixName(err)), `${label} dir failed`);
    }
  };

  const handleServeRequest = (idx: number): void => {
    const entries = dragEntries;
    if (!entries) {
      ctx.log(`serve request x=${idx} with no session — ignored`);
      return;
    }
    const entry = entries[idx - 1];
    if (!entry) {
      write(serveErrorFrame("EINVAL", `entry ${idx} out of range`), "serve out of range");
      return;
    }
    serveDragPath(entry.path, `t=k:x=${idx}`, `serve entry ${idx}`);
  };

  const finishDrop = async (idx: number): Promise<void> => {
    const b64 = arrive[idx];
    delete arrive[idx];
    dropIdx = -1;
    const remote = dropRemote;
    dropRemote = false;
    if (!b64) {
      write(finishDropFrame(), `finish drop idx=${idx}`);
      return;
    }
    const text = Buffer.from(b64, "base64").toString("utf8");
    if (ctx.virtualCwd()) {
      // virtual places have no folder to land in — refuse before any fetching
      write(remote ? cancelDropFrame() : finishDropFrame(), `finish drop idx=${idx} refused`);
      ctx.notify("Drops land in a real folder", "drop", "info");
      return;
    }
    if (remote) {
      // cross-machine payload: fetch each entry's bytes (t=r y=subidx) into
      // staging, then land through the normal copy path. The finish handshake
      // goes out only after the transfer — it means "drop completed".
      await receiveRemoteDrop(idx, text);
      return;
    }
    write(finishDropFrame(), `finish drop idx=${idx}`);
    ctx.log(`drop complete, uri-list bytes=${Buffer.from(b64, "base64").length}`);
    const paths = dropPayloadToPaths(text);
    ctx.log(`paths: ${paths.join(" | ") || "(none)"}`);
    if (!paths.length) return;
    // dropping onto Trash trashes (same as the trash-place self-drop route)
    if (ctx.inTrashView()) {
      void ctx.trashPaths(paths);
      return;
    }
    await ctx.runTransfer("copy", ctx.cwd(), paths, `drop ${paths.length} item${paths.length === 1 ? "" : "s"}`);
  };

  const handleOsc72 = (meta: string, payload: string): void => {
    const { t, x, y, m, X, Y } = parseOsc72Meta(meta);

    // --- outgoing drag session ---
    // middle-button drags go external (OS session + icon badge); left drags are
    // declined so the internal move flow keeps the pointer and its UI feedback
    if (t === "o" && x >= 0) {
      const want = !gridDrag.ctrl && !!gridDrag.keys?.length && !ctx.escMenuOpen() && !ctx.fileMenuOpen();
      ctx.log(
        `drag offer x=${x} y=${y} ctrl=${gridDrag.ctrl} accept=${want} keys=${gridDrag.keys?.length ?? -1} menu=${ctx.escMenuOpen()} fmenu=${ctx.fileMenuOpen()}`,
      );
      if (!want || !gridDrag.keys) return; // left-drag: kitty falls back to normal mouse events
      beginDrag(gridDrag.keys);
      return;
    }
    if (t === "e") {
      if (x === 2) {
        dragOp = y === 2 ? 2 : 1;
        ctx.log(`drag op=${dragOp === 2 ? "move" : "copy"}`);
      } else if (x === 3) {
        ctx.log(`drag landed op=${dragOp}`);
      } else if (x === 4) {
        const canceled = y !== 0;
        ctx.log(`drag end canceled=${canceled} op=${dragOp}`);
        // snapshot EVERYTHING the epilogue needs at end time — the timer may
        // fire after a newer session began, and the live values then belong
        // to that newer session
        const seqAtEnd = dragSession;
        const pathsAtEnd = dragPaths;
        const opAtEnd = dragOp;
        const selfDoneAtEnd = selfDropDoneSession === seqAtEnd;
        const finishExternal = (): void => {
          if (!canceled && pathsAtEnd) {
            // released over another app: honor move semantics by trashing our copies
            if (opAtEnd === 2) void ctx.trashPaths(pathsAtEnd);
            else
              ctx.notify(
                `Sent ${pathsAtEnd.length} item${pathsAtEnd.length === 1 ? "" : "s"}`,
                "drag & drop",
                "success",
              );
          } else if (canceled && !selfDoneAtEnd) ctx.setStatusMsg("drag cancelled");
          if (dragSession === seqAtEnd) {
            dragPaths = null;
            dragEntries = null;
            clearSelfDropHighlight();
          }
        };
        if (endTimer && endTimerSession === dragSession) {
          // duplicate end events for the same session — reschedule, don't stack
          clearTimeout(endTimer);
          endTimer = null;
        }
        // a self-drop M may still be in flight behind the end event — defer
        if (!canceled && pathsAtEnd) {
          endTimerSession = seqAtEnd;
          endTimer = setTimeout(finishExternal, 700);
        } else finishExternal();
      } else if (x === 5 && dragEntries) {
        ctx.log("drag send request");
        presentDragUriList(dragEntries);
      }
      return;
    }

    // --- self-drop: hover/drop events landing back on tfm during OUR session ---
    if ((t === "m" || t === "M") && dragPaths) {
      if (x === -1 && y === -1) {
        clearSelfDropHighlight();
        ctx.clearHoverPlace();
        return;
      }
      if (t === "m") {
        const target = handleSelfDropHover(x, y);
        write(target ? agreeSelfDropFrame() : rejectHoverFrame(), target ? "self drop agree" : "self drop reject");
        return;
      }
      void finishSelfDrop(x, y); // M — dropped on ourselves
      return;
    }

    // DropLeave
    if (t === "m" && x === -1 && y === -1) {
      ctx.log("leave");
      dropIdx = -1;
      dropRemote = false;
      // a drag leaving mid-fetch aborts it silently — the user dragged away,
      // there is nothing to report
      if (remoteFetch) abortRemoteFetch(null);
      for (const k of Object.keys(arrive)) delete arrive[Number(k)];
      return;
    }

    // a remote fetch owns every t=r/t=R frame until it settles (a second drop
    // is refused at t=M time, so nothing else can be in flight); metadata-less
    // continuation chunks (t="") belong to it too
    if (remoteFetch && (t === "r" || t === "R" || t === "")) {
      handleRemoteChunk(t, x, y, X, Y, m, payload);
      return;
    }

    if (t === "m" || t === "M") {
      const mimes = payload.split(/\s+/).filter(Boolean);
      const idx = mimes.indexOf("text/uri-list");
      ctx.log(`${t === "M" ? "ready" : "enter"} mimes=[${mimes}] uriIdx=${idx} busy=${dropIdx >= 0}`);
      // one in-flight drop AND one in-flight remote fetch at most — a second
      // t=M while fetching would interleave indistinguishable responses
      if (idx < 0 || dropIdx >= 0 || remoteFetch) return;
      write(agreeDropFrame(), "agree copy");
      if (t === "M") {
        // kitty's mime indices are 1-based (yazi requests ipairs index)
        dropIdx = idx + 1;
        arrive[dropIdx] = "";
        write(startDropFrame(dropIdx), `start drop uriIdx=${idx} wire=${dropIdx}`);
      }
      return;
    }
    if (t === "r" && x === dropIdx) {
      // first chunk of a response carries the full meta (continuation chunks
      // may omit keys — those land in the branch below) — capture X=1 here.
      // The slot is pre-initialized to "" at t=M time, so empty means no
      // chunk has landed yet.
      if (arrive[x] === "" && X === 1) dropRemote = true;
      arrive[x] += payload;
      // presence of payload or m=1 means more chunks are coming
      if (!payload && !m) void finishDrop(x);
      return;
    }
    // keyless continuation chunk (kitty sends `m=1;<data>` after the first
    // chunk): it extends the in-flight drop's reassembly. Without this a
    // >3KB uri-list never completes and dropIdx wedges every later drop.
    if (t === "" && dropIdx >= 0 && arrive[dropIdx] !== undefined) {
      arrive[dropIdx] += payload;
      if (!payload && !m) void finishDrop(dropIdx);
      return;
    }
    if (t === "R") {
      ctx.log(`drop error: ${payload}`);
      const summary = `Drop failed (${shortReason(payload)})`;
      ctx.notify(summary, "drop failed", "error");
      return;
    }
    if (t === "k") {
      // terminal requests our entry bytes (dragging to a remote machine) —
      // idx is 1-based into the presented uri-list
      handleServeRequest(x);
      return;
    }
    if (t === "E") {
      // kitty ACKs our StartDrag with `E:OK` ~5ms after every ACCEPTED drag
      // and the session continues normally — only a non-OK payload is a real
      // failure (every E in the wild has been exactly "OK"; a genuine reason
      // names itself, so the match stays tight). A bare `E` (empty payload)
      // is the same ack, not an error.
      if (!payload.trim() || payload.trim().toLowerCase() === "ok") {
        ctx.log("drag acknowledged");
        return;
      }
      ctx.log(`drag offer error: ${payload}`);
      const summary = `Drag failed (${shortReason(payload)})`;
      ctx.notify(summary, "drag failed", "error");
      return;
    }
    ctx.log(`unhandled osc72 type t=${JSON.stringify(t)} x=${x} y=${y} payloadLen=${payload.length}`);
  };

  ctx.subscribeOsc((seq: string) => {
    const parts = splitOsc72Seq(seq);
    if (parts) handleOsc72(parts.meta, parts.payload);
  });

  return { handleOsc72, enableDrops, disableDrops };
};
