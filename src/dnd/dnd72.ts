// --- OSC 72 (kitty drag-and-drop) state machine: outgoing drag sessions,
// incoming drop payloads and the self-drop hover/highlight routing, as a
// factory with injected UI callbacks (same seam as grid-input.ts). The wire
// frames and payload decoding live in ./osc72 (pure, byte-exact with yazi);
// everything renderer-coupled (hit-testing, tile visuals, place hover)
// arrives via ctx. ---

import path from "node:path";
import { statSync } from "node:fs";
import {
  agreeDragFrame,
  agreeDropFrame,
  dragIconFrame,
  dragOutEnableFrame,
  dropDisableFrame,
  dropInEnableFrame,
  dropPayloadToPaths,
  finishDropFrame,
  parseOsc72Meta,
  presentDragFrames,
  selfDropRejectFrame,
  startDragFrame,
  startDropFrame,
  uriListPayload,
} from "./osc72";
import { gridDrag, TileVisual, type ClipItem, type GridTileRef, type TileVisualMode } from "../input/grid-input";
import { trashDir } from "../fs/fsutil";
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
    write(dragOutEnableFrame(), "enable drag-out");
    write(dropInEnableFrame(), "enable drop-in");
  };
  const disableDrops = (): void => write(dropDisableFrame(), "disable drop");

  // --- session state ---
  let dropIdx = -1;
  const arrive: Record<number, string> = {};
  let dragPaths: string[] | null = null;
  let dragOp = 1; // 1 copy / 2 move
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

  const presentDragUriList = (paths: string[]): void => {
    const [dataFrame, endFrame] = presentDragFrames(paths);
    write(dataFrame, `present drag ${dropPayloadLength(paths)} b64 chars`);
    write(endFrame, "present drag end");
  };

  const beginDrag = (paths: string[]): void => {
    // a drag starting inside a previous session's 700ms end window must not
    // inherit the stale epilogue: it would wipe THIS payload and read THIS
    // session's op against the OLD session's paths
    dragSession++;
    dragPaths = paths;
    dragOp = 1;
    selfDropDoneSession = -1;
    ctx.finishDrag(); // pointer is about to be grabbed by the terminal
    write(agreeDragFrame(), "agree drag either");
    presentDragUriList(paths);
    sendDragIcon(paths.length);
    write(startDragFrame(), "start drag");
    ctx.setStatusMsg(
      `Dragging ${paths.length} item${paths.length === 1 ? "" : "s"} — drop into another app or a folder`,
    );
  };

  // self-dropped back onto tfm: route to the folder/place under the cursor,
  // otherwise cancel — this is what makes one plain drag serve both worlds
  const handleSelfDropHover = (x: number, y: number): void => {
    clearSelfDropHighlight();
    const target = x >= 0 ? ctx.hitTargetAt(x, y, dragPaths) : null;
    ctx.log(`self hover ${x},${y} -> ${target ? `${target.kind}:${target.path}` : "none"}`);
    if (!target) {
      ctx.clearHoverPlace();
      return;
    }
    if (target.kind === "folder") {
      selfTargetKey = target.path;
      // a folder tile wins over any previous place hover highlight
      ctx.clearHoverPlace();
      ctx.setTileVisual(target.path, TileVisual.Selected);
    } else {
      ctx.hoverPlace(target.path);
    }
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
    if (!paths?.length || !target) {
      write(selfDropRejectFrame(), "self drop rejected");
      ctx.setStatusMsg("drag cancelled");
      return;
    }
    const destDir = target.path;
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

  const finishDrop = async (idx: number): Promise<void> => {
    const b64 = arrive[idx];
    delete arrive[idx];
    dropIdx = -1;
    write(finishDropFrame(), `finish drop idx=${idx}`);
    ctx.log(`drop complete, uri-list bytes=${b64 ? Buffer.from(b64, "base64").length : 0}`);
    if (!b64) return;
    if (ctx.virtualCwd()) {
      ctx.notify("Drops land in a real folder", "drop", "info");
      return;
    }
    const text = Buffer.from(b64, "base64").toString("utf8");
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
    const { t, x, y, m } = parseOsc72Meta(meta);

    // --- outgoing drag session ---
    // middle-button drags go external (OS session + icon badge); left drags are
    // declined so the internal move flow keeps the pointer and its UI feedback
    if (t === "o" && x >= 0) {
      const want = !gridDrag.ctrl && !!gridDrag.keys?.length && !ctx.escMenuOpen() && !ctx.fileMenuOpen();
      ctx.log(
        `drag offer x=${x} y=${y} ctrl=${gridDrag.ctrl} accept=${want} keys=${gridDrag.keys?.length ?? -1} menu=${ctx.escMenuOpen()} fmenu=${ctx.fileMenuOpen()}`,
      );
      if (!want || !gridDrag.keys) return; // left-drag: kitty falls back to normal mouse events
      beginDrag(gridDrag.keys.map((k) => k.path));
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
      } else if (x === 5 && dragPaths) {
        ctx.log("drag send request");
        presentDragUriList(dragPaths);
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
        handleSelfDropHover(x, y);
        return;
      }
      void finishSelfDrop(x, y); // M — dropped on ourselves
      return;
    }

    // DropLeave
    if (t === "m" && x === -1 && y === -1) {
      ctx.log("leave");
      dropIdx = -1;
      for (const k of Object.keys(arrive)) delete arrive[Number(k)];
      return;
    }

    if (t === "m" || t === "M") {
      const mimes = payload.split(/\s+/).filter(Boolean);
      const idx = mimes.indexOf("text/uri-list");
      ctx.log(`${t === "M" ? "ready" : "enter"} mimes=[${mimes}] uriIdx=${idx} busy=${dropIdx >= 0}`);
      if (idx < 0 || dropIdx >= 0) return;
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
      arrive[x] += payload;
      // presence of payload or m=1 means more chunks are coming
      if (!payload && !m) void finishDrop(x);
      return;
    }
    if (t === "R") {
      ctx.log(`drop error: ${payload}`);
      const summary = `Drop failed (${shortReason(payload)})`;
      ctx.notify(summary, "drop failed", "error");
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
