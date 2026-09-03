// --- File operations orchestration: every destructive-but-reversible op
// (copy/move/paste/rename) funnels through runTransfer/performRename here so
// overrides are asked once (conflict policy) and undo covers the whole batch.
// The copy engine lives in ./transfer (pure, sink-injected) and the progress
// toast in ./ui-progress — this factory owns the wiring between them plus the
// internal clipboard. Same seam as grid-input.ts: no renderer imports. ---

import path from "node:path";
import { existsSync } from "node:fs";
import { rm, rename as fsRename } from "node:fs/promises";
import {
  fsErrText,
  fsMove,
  safeRestoreMove,
  trashDir,
  uniqueTarget,
  xdgTrashMove,
  crossDevice as fsCrossDevice,
} from "./fsutil";
import { copyTreeProgress, scanTree, type TransferSink } from "./transfer";
import { publishPathsToSystemClipboard, readCopiedFilesFromSystemClipboard } from "./clipboard";
import type { ConflictChoice } from "../ui/ui-dialogs";
import type { ProgressState } from "../ui/ui-progress";
import type { UndoUnit } from "../app/undo";
import type { ClipItem } from "../input/grid-input";

export type FileOpsCtx = {
  conflict: {
    resetPolicy(): void;
    policy(): ConflictChoice | null;
    promptConflict(destPath: string, remaining: number): Promise<ConflictChoice>;
  };
  // live progress state — the transfer sink reports into it (stable object ref)
  prog: ProgressState;
  paintProgress(full?: boolean): void;
  showProgressToast(): void;
  finishProgressToast(msg: string): void;
  pauseGate(): Promise<void>;
  pushUndoBatch(label: string, units: UndoUnit[], redos: UndoUnit[]): void;
  renderAll(): void;
  setStatusMsg(msg: string): void;
  notify(msg: string, title?: string): void;
  home: string;
  // cut-tile dimming repaint (tile visuals live in ./selection)
  // cut-tile dimming repaint (tile visuals live in ./selection)
  refreshCutVisuals(): void;
  // injectable for tests — real impl lstats st.dev (fsutil)
  crossDevice?(a: string, b: string): boolean;
  // /tmp/tfm-dnd.log debug sink
  log(msg: string): void;
};

export const makeFileOps = (ctx: FileOpsCtx) => {
  const { prog, conflict } = ctx;

  // Trash/files (or anything under it) is not a paste/move target: files
  // landing there without .trashinfo are unrestorable. Trashing goes through
  // trashPaths; drag-restore onto real places stays allowed (dest-based, not
  // view-based, so it never blocks legitimate outs).
  const trashFilesRoot = (): string => path.join(trashDir(), "files");
  const isInTrashFiles = (p: string): boolean => {
    const root = path.resolve(trashFilesRoot());
    const target = path.resolve(p);
    return target === root || target.startsWith(root + path.sep);
  };

  const scanTreeWired = (root: string): Promise<{ files: number; bytes: number }> => scanTree(root);

  // wire the copy engine (./transfer) to the live progress state
  const transferSink: TransferSink = {
    checkpoint: async () => {
      await ctx.pauseGate();
      if (prog.cancelled) throw new Error("cancelled");
    },
    paused: () => prog.paused,
    cancelled: () => prog.cancelled,
    addBytes: (n) => {
      prog.bytes += n;
    },
    fileDone: () => {
      prog.doneFiles++;
    },
    setStream: (rs) => {
      prog.currentRs = rs;
    },
    clearStream: (rs) => {
      if (prog.currentRs === rs) prog.currentRs = null;
    },
    repaint: (full) => ctx.paintProgress(full),
  };
  const copyTreeProgressWired = (src: string, dest: string): Promise<void> => copyTreeProgress(src, dest, transferSink);
  const isCrossDevice = (a: string, b: string): boolean => (ctx.crossDevice ?? fsCrossDevice)(a, b);

  // every destructive-but-reversible file op funnels through here so overrides
  // are asked once and undo covers the whole batch
  const runTransfer = async (op: "copy" | "move", destDir: string, srcs: string[], label: string): Promise<void> => {
    conflict.resetPolicy();
    const units: UndoUnit[] = [];
    const redos: UndoUnit[] = [];
    let ok = 0,
      skipped = 0,
      replaced = 0,
      failed = 0,
      gone = 0;
    const failWhy = new Set<string>();
    const total = srcs.length;
    // moves across a filesystem boundary go through the copy engine too
    // (rename can't cross devices) — those need the same pre-scan + toast
    // copies get, or a big cross-device move sits there silently for minutes
    const withProgress = op === "copy" || srcs.some((s) => isCrossDevice(s, destDir));
    if (withProgress) {
      // pre-scan so the progress toast has real totals from byte one
      prog.paused = false;
      prog.cancelled = false;
      prog.doneFiles = 0;
      prog.bytes = 0;
      prog.verb = op === "copy" ? "copying" : "moving";
      let files = 0,
        bytes = 0;
      for (const s of srcs) {
        try {
          const r = await scanTreeWired(s);
          files += r.files;
          bytes += r.bytes;
        } catch {}
      }
      prog.totalFiles = files || Math.max(1, total);
      prog.totalBytes = bytes;
      // tiny transfers don't need a toast
      if (prog.totalBytes > 4 * 1024 * 1024 || prog.totalFiles > 4) {
        prog.active = true;
        ctx.showProgressToast();
        ctx.paintProgress(true);
      }
    }
    let cancelled = false;
    try {
      for (const src of srcs) {
        if (cancelled || prog.cancelled) {
          cancelled = true;
          break;
        }
        await ctx.pauseGate();
        // source vanished since it was copied/cut — report clearly instead of a
        // cryptic mid-transfer ENOENT
        if (!existsSync(src)) {
          gone++;
          skipped++;
          continue;
        }
        const base = path.basename(src);
        let target = path.join(destDir, base);
        // nautilus semantics: paste-in-place never asks, it just makes "name (copy)"
        if (target === src && op === "copy") {
          target = uniqueTarget(destDir, base);
        } else if (target === src) {
          skipped++;
          continue;
        } else if (existsSync(target)) {
          const done = ok + skipped;
          const choice = conflict.policy() ?? (await conflict.promptConflict(target, Math.max(0, total - done - 1)));
          if (choice === "skip") {
            skipped++;
            continue;
          }
          if (choice === "keepBoth") target = uniqueTarget(destDir, base);
          else {
            // stash the victim in the trash so ctrl+z can bring it back;
            // re-check first — the target may have vanished while the prompt was up
            try {
              if (existsSync(target)) {
                const victimDest = target;
                const trashLoc = await xdgTrashMove(victimDest);
                units.push(async () => {
                  await safeRestoreMove(trashLoc, victimDest);
                  try {
                    await rm(path.join(trashDir(), "info", `${path.basename(trashLoc)}.trashinfo`));
                  } catch (err) {
                    ctx.log(`undo replace ${victimDest}: ${fsErrText(err)}`);
                  }
                });
                replaced++;
              }
            } catch (err) {
              failWhy.add(fsErrText(err));
              ctx.log(`replace stash failed ${target}: ${fsErrText(err)} — proceeding without undo`);
            }
          }
        }
        // per-iteration: did THIS src go through the streaming copy engine?
        // (cross-device moves need the same half-copy cleanup real copies get)
        let copiedHere = false;
        try {
          if (op === "copy") {
            copiedHere = true;
            await copyTreeProgressWired(src, target);
          } else if (isCrossDevice(src, destDir)) {
            copiedHere = true;
            await copyTreeProgressWired(src, target);
            // cancel raced the final byte: copy completed but the source must
            // survive a cancelled move — surface as cancelled, drop the copy
            if (prog.cancelled) throw new Error("cancelled");
            await rm(src, { recursive: true });
          } else await fsMove(src, target);
          const t = target,
            s = src;
          if (op === "copy") {
            units.push(() => xdgTrashMove(t).then(() => undefined));
            redos.push(async () => {
              try {
                if (!existsSync(t)) await copyTreeProgressWired(src, t);
              } catch (err) {
                ctx.log(`redo copy ${t}: ${fsErrText(err)}`);
              }
            });
          } else {
            units.push(() => safeRestoreMove(t, s));
            redos.push(async () => {
              try {
                if (existsSync(s) && !existsSync(t)) await fsMove(s, t);
              } catch (err) {
                ctx.log(`redo move ${t}: ${fsErrText(err)}`);
              }
            });
          }
          ok++;
        } catch (err) {
          // don't leave half-copied files behind (copies AND cross-device moves)
          if (op === "copy" || copiedHere) {
            try {
              await rm(target, { recursive: true });
            } catch (cleanup) {
              ctx.log(`half-copy cleanup failed ${target}: ${fsErrText(cleanup)}`);
            }
          }
          if (prog.cancelled) {
            cancelled = true;
            break;
          }
          failed++;
          failWhy.add(fsErrText(err));
        }
      }
    } finally {
      prog.active = false;
    }
    ctx.pushUndoBatch(label, units, redos);
    ctx.renderAll();
    const verb = op === "copy" ? "Copied" : "Moved";
    const bits = [`${verb} ${ok} item${ok === 1 ? "" : "s"}`];
    if (replaced) bits.push(`${replaced} replaced`);
    if (skipped) bits.push(`${skipped} skipped`);
    if (gone) bits.push(`${gone} source gone`);
    const why = [...failWhy][0];
    if (failed) bits.push(`${failed} FAILED${why ? ` (${why})` : ""}`);
    if (ok || replaced) bits.push("ctrl+z to undo");
    const summary = bits.join(" · ");
    ctx.setStatusMsg(summary);
    // always surface the outcome — success, failure, or cancel
    if (prog.toastUp) {
      ctx.finishProgressToast(cancelled ? `✗ ${verb} cancelled` : failed ? `✗ ${op} failed` : `✓ ${verb} ${ok}`);
    }
    const destLabel = `to ~/${path.relative(ctx.home, destDir) || "/"}`;
    const msg = `${summary}${!cancelled && !failed && ok + replaced > 0 ? ` ${destLabel}` : ""}`;
    if (cancelled) ctx.notify(msg, `${op} cancelled`);
    else if (failed > 0 && ok === 0) ctx.notify(msg, `${op} failed`);
    else ctx.notify(msg, op);
  };

  // rename with nautilus-style collision handling: rename() would otherwise
  // silently overwrite the existing file
  const performRename = async (p: string, v: string): Promise<void> => {
    const dest = path.join(path.dirname(p), v);
    if (path.resolve(dest) === path.resolve(p)) {
      ctx.renderAll();
      return;
    }
    let finalDest = dest;
    const units: UndoUnit[] = [];
    const redos: UndoUnit[] = [];
    if (existsSync(finalDest)) {
      conflict.resetPolicy();
      const choice = await conflict.promptConflict(finalDest, 0);
      if (choice === "skip") return;
      if (choice === "keepBoth") {
        finalDest = uniqueTarget(path.dirname(finalDest), path.basename(finalDest));
      } else {
        try {
          const victim = finalDest;
          const trashLoc = await xdgTrashMove(victim);
          units.push(async () => {
            await safeRestoreMove(trashLoc, victim);
            try {
              await rm(path.join(trashDir(), "info", `${path.basename(trashLoc)}.trashinfo`));
            } catch (err) {
              ctx.log(`undo replace ${victim}: ${fsErrText(err)}`);
            }
          });
        } catch (err) {
          ctx.log(`replace stash failed ${finalDest}: ${fsErrText(err)} — proceeding without undo`);
        }
      }
    }
    try {
      await fsRename(p, finalDest);
      units.push(() => fsRename(finalDest, p));
      redos.push(async () => {
        try {
          if (existsSync(p) && !existsSync(finalDest)) await fsRename(p, finalDest);
        } catch (err) {
          ctx.log(`redo rename ${finalDest}: ${fsErrText(err)}`);
        }
      });
      ctx.pushUndoBatch("rename", units, redos);
      ctx.renderAll();
      ctx.setStatusMsg(`Renamed to ${path.basename(finalDest)} · ctrl+z to undo`);
      ctx.notify(`Renamed to ${path.basename(finalDest)}`, "rename");
    } catch (err) {
      const summary = `Rename failed (${fsErrText(err)})`;
      ctx.setStatusMsg(summary);
      ctx.notify(`${path.basename(p)}: ${summary}`, "rename failed");
    }
  };

  // --- internal clipboard (cut/copy pending items) ---
  let clipboard: { mode: "copy" | "cut"; items: ClipItem[] } | null = null;

  // tfm publishes plain-text paths so paste-anywhere works; reading accepts
  // gnome-copied-files from other apps (bridge lives in ./clipboard, tested)
  const toSystemClipboard = (mode: "copy" | "cut", items: ClipItem[]): void => {
    publishPathsToSystemClipboard(mode, items, ctx.log);
  };

  const setClipboard = (mode: "copy" | "cut", items: ClipItem[]): void => {
    clipboard = items.length ? { mode, items } : null;
    if (clipboard) toSystemClipboard(mode, items);
    ctx.setStatusMsg(
      clipboard ? `${mode === "cut" ? "Cut" : "Copied"} ${items.length} item${items.length === 1 ? "" : "s"}` : "",
    );
    ctx.refreshCutVisuals();
  };

  const doPaste = async (dest: string): Promise<void> => {
    if (!clipboard || clipboard.items.length === 0) return;
    const mode = clipboard.mode === "copy" ? "copy" : "move";
    const srcs = clipboard.items.map((i) => i.path);
    clipboard = null;
    ctx.refreshCutVisuals();
    await runTransfer(mode, dest, srcs, mode === "copy" ? "paste" : "paste (move)");
  };

  const pasteSmart = (dest: string): void => {
    if (isInTrashFiles(dest)) {
      ctx.setStatusMsg("Can't paste into Trash");
      return;
    }
    if (clipboard?.items.length) {
      ctx.log(`paste: internal clipboard (${clipboard.items.length} items)`);
      void doPaste(dest);
      return;
    }
    void readCopiedFilesFromSystemClipboard(ctx.log).then((res) => {
      if (res) void runTransfer(res.op === "move" ? "move" : "copy", dest, res.paths, "system-clipboard paste");
    });
  };

  const moveInto = async (destDir: string, items: ClipItem[]): Promise<void> => {
    // trashing goes through trashPaths (trashinfo metadata) — a raw move
    // into Trash/files orphans the .trashinfo OriginalPath chain
    if (isInTrashFiles(destDir)) {
      ctx.setStatusMsg("Can't move items into Trash");
      return;
    }
    const srcs = items
      .filter((it) => !(it.isDir && (destDir === it.path || destDir.startsWith(it.path + path.sep))))
      .map((it) => it.path);
    ctx.log(
      `moveInto dest=${destDir} in=${items.length} out=${srcs.length} dropped=[${items
        .filter((it) => it.isDir && (destDir === it.path || destDir.startsWith(it.path + path.sep)))
        .map((it) => it.path.split("/").pop())
        .join(",")}]`,
    );
    await runTransfer("move", destDir, srcs, `move to ${path.basename(destDir) || "/"}`);
  };

  return {
    runTransfer,
    performRename,
    setClipboard,
    pasteSmart,
    moveInto,
    // live read — index/menus need the current clipboard without owning it
    clipboard: (): { mode: "copy" | "cut"; items: ClipItem[] } | null => clipboard,
  };
};
