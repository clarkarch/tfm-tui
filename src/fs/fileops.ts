// --- File operations orchestration: every destructive-but-reversible op
// (copy/move/paste/rename) funnels through runTransfer/performRename here so
// overrides are asked once (conflict policy) and undo covers the whole batch.
// The copy engine lives in ./transfer (pure, sink-injected) and the progress
// toast in ./ui-progress — this factory owns the wiring between them plus the
// internal clipboard. Same seam as grid-input.ts: no renderer imports. ---

import path from "node:path";
import { existsSync } from "node:fs";
import { readdir, rm, rename as fsRename } from "node:fs/promises";
import {
  failSuffix,
  fsErrText,
  fsMove,
  isInTrashFiles,
  rmTrashInfo,
  safeRestoreMove,
  shouldToast,
  uniqueTarget,
  xdgTrashMove,
  crossDevice as fsCrossDevice,
} from "./fsutil";
import { copyTreeProgress, scanTree, type TransferSink } from "./transfer";
import { publishPathsToSystemClipboard, readCopiedFilesFromSystemClipboard } from "./clipboard";
import { sharedOpQueue } from "../lib/op-queue";
import type { ConflictChoice } from "../ui/ui-dialogs";
import type { ProgressState } from "../ui/ui-progress";
import type { UndoJournalData, UndoStep, UndoUnit } from "../app/undo";
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
  pushUndoBatch(label: string, units: UndoUnit[], redos: UndoUnit[], data?: UndoJournalData): void;
  renderAll(): void;
  setStatusMsg(msg: string): void;
  notify(msg: string, title?: string): void;
  home: string;
  // cut-tile dimming repaint (tile visuals live in ./selection)
  refreshCutVisuals(): void;
  // injectable for tests — real impl lstats st.dev (fsutil)
  crossDevice?(a: string, b: string): boolean;
  // /tmp/tfm-dnd.log debug sink
  log(msg: string): void;
  // plugin event fan-out (optional; never throws into the transfer).
  // Always fires on completion — including cancel/failure, with the outcome
  // attached — so plugins can't mistake a cancelled op for a success.
  onFileOp?: (op: string, paths: string[], dest?: string, outcome?: { cancelled: boolean; failed: number }) => void;
};

export const makeFileOps = (ctx: FileOpsCtx) => {
  const { prog, conflict } = ctx;
  const queue = sharedOpQueue();

  // Trash/files (or anything under it) is not a paste/move target: files
  // landing there without .trashinfo are unrestorable. Trashing goes through
  // trashPaths; drag-restore onto real places stays allowed (dest-based, not
  // view-based, so it never blocks legitimate outs). Subtree check lives in
  // ./fsutil (isInTrashFiles) next to the other Trash path semantics.

  // stash the replace victim in the trash so ctrl+z can bring it back.
  // Shared by runTransfer collisions and performRename collisions (same 13
  // lines twice before). Re-checks existence first — the target may have
  // vanished while the conflict prompt was up. Returns true when an undo
  // unit was recorded; appends the journal mirror to dUnits alongside.
  const stashVictim = async (
    victimDest: string,
    units: UndoUnit[],
    dUnits: UndoStep[],
    onStashFailed: (err: unknown) => void,
  ): Promise<boolean> => {
    try {
      if (!existsSync(victimDest)) return false;
      const trashLoc = await xdgTrashMove(victimDest);
      units.push(async () => {
        await safeRestoreMove(trashLoc, victimDest);
        await rmTrashInfo(path.basename(trashLoc), ctx.log);
      });
      dUnits.push({ op: "restore-move", from: trashLoc, to: victimDest });
      dUnits.push({ op: "rm-trashinfo", name: path.basename(trashLoc) });
      return true;
    } catch (err) {
      onStashFailed(err);
      return false;
    }
  };

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
  // are asked once and undo covers the whole batch. Serialized through the
  // shared op queue so concurrent pastes/moves/trashes never interleave.
  // Crash semantics: each file lands via tmp+rename (no half-visible dest);
  // a multi-file batch is per-file atomic, not batch-atomic — completed files
  // stay undoable via the pushed batch.
  const runTransfer = (op: "copy" | "move", destDir: string, srcs: string[], label: string): Promise<void> =>
    queue.enqueue(() => runTransferInner(op, destDir, srcs, label));
  const runTransferInner = async (
    op: "copy" | "move",
    destDir: string,
    srcs: string[],
    label: string,
  ): Promise<void> => {
    conflict.resetPolicy();
    // self-drops filter everything out upstream (moveInto) — landing here
    // with nothing to do would report a confusing "Moved 0 items"
    if (!srcs.length) {
      ctx.setStatusMsg(op === "copy" ? "Nothing to copy" : "Nothing to move");
      return;
    }
    // best-effort sweep of crashed-transfer orphans (<dest>.tfm-part-*) so a
    // SIGKILL during the last run doesn't pile up tmp files in the dest dir
    try {
      const kids = await readdir(destDir).catch(() => [] as string[]);
      for (const k of kids) {
        if (k.includes(".tfm-part-")) {
          try {
            await rm(path.join(destDir, k), { recursive: true, force: true });
          } catch {}
        }
      }
    } catch {}
    const units: UndoUnit[] = [];
    const redos: UndoUnit[] = [];
    // journal mirror of units/redos as fs-step data (persisted when
    // [ui] persist-undo is on; closures alone can't cross a restart)
    const dUnits: UndoStep[] = [];
    const dRedos: UndoStep[] = [];
    let ok = 0,
      skipped = 0,
      replaced = 0,
      failed = 0,
      gone = 0;
    const failWhy = new Set<string>();
    const total = srcs.length;
    // moves across a filesystem boundary go through the copy engine too
    // (rename can't cross devices) — those need the same pre-scan + toast
    // copies get, or a big cross-device move sits there silently for minutes.
    // Same-device moves skip the toast deliberately: they are O(1) renames,
    // so even a thousand files finish before a toast would matter.
    // Stale toast flags must never outlive the transfer that set them: the ✕
    // button sets cancelled=true and only toast-bearing transfers used to
    // reset it, so every later plain move broke on iteration 1 ("Moved 0
    // items") until some progress transfer happened to run. Reset always.
    prog.paused = false;
    prog.cancelled = false;
    prog.doneFiles = 0;
    prog.bytes = 0;
    const withProgress = op === "copy" || srcs.some((s) => isCrossDevice(s, destDir));
    if (withProgress) {
      prog.verb = op === "copy" ? "copying" : "moving";
      let files = 0,
        bytes = 0;
      for (const s of srcs) {
        try {
          const r = await scanTree(s);
          files += r.files;
          bytes += r.bytes;
        } catch {}
      }
      prog.totalFiles = files || Math.max(1, total);
      prog.totalBytes = bytes;
      if (shouldToast(prog.totalBytes, prog.totalFiles)) {
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
        // preflight is inherently racy (TOCTOU: external delete/replace can
        // land between check and act) — so this is only a fast-path hint for
        // a clear message; every op below still catches ENOENT and reports
        // "source gone" / "FAILED" instead of crashing
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
          else if (
            await stashVictim(target, units, dUnits, (err) => {
              failWhy.add(fsErrText(err));
              ctx.log(`replace stash failed ${target}: ${fsErrText(err)} — proceeding without undo`);
            })
          ) {
            replaced++;
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
            dUnits.push({ op: "trash", path: t });
            redos.push(async () => {
              try {
                if (!existsSync(t)) await copyTreeProgressWired(src, t);
              } catch (err) {
                ctx.log(`redo copy ${t}: ${fsErrText(err)}`);
              }
            });
            dRedos.push({ op: "copy-tree-if-missing", src, dest: t });
          } else {
            units.push(() => safeRestoreMove(t, s).then(() => undefined));
            dUnits.push({ op: "restore-move", from: t, to: s });
            redos.push(async () => {
              try {
                if (existsSync(s) && !existsSync(t)) await fsMove(s, t);
              } catch (err) {
                ctx.log(`redo move ${t}: ${fsErrText(err)}`);
              }
            });
            dRedos.push({ op: "rename-if", from: s, to: t });
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
    ctx.pushUndoBatch(label, units, redos, { units: dUnits, redos: dRedos });
    ctx.renderAll();
    const verb = op === "copy" ? "Copied" : "Moved";
    const opNoun = op === "copy" ? "Copy" : "Move";
    // status and notify share the full sentence including the destination —
    // they diverged before (status dropped the "to ~/…" tail) for no reason.
    // The destination folds into the verb phrase ("Copied 2 items to ~/Docs"),
    // never after the undo hint ("…undo to ~/Docs" misreads).
    const landed = !cancelled && !failed && ok + replaced > 0;
    const destTail = landed ? ` to ~/${path.relative(ctx.home, destDir) || "/"}` : "";
    const bits = [`${verb} ${ok} item${ok === 1 ? "" : "s"}${destTail}`];
    if (replaced) bits.push(`${replaced} replaced`);
    if (skipped) bits.push(`${skipped} skipped`);
    if (gone) bits.push(`${gone} source gone`);
    if (failed) bits.push(failSuffix(failed, failWhy));
    if (ok || replaced) bits.push("ctrl+z to undo");
    const msg = bits.join(" · ");
    ctx.setStatusMsg(msg);
    // always surface the outcome — success, failure, or cancel
    if (prog.toastUp) {
      ctx.finishProgressToast(cancelled ? `✗ ${opNoun} cancelled` : failed ? `✗ ${opNoun} failed` : `✓ ${verb} ${ok}`);
    }
    if (cancelled) ctx.notify(msg, `${op} cancelled`);
    else if (failed > 0) ctx.notify(msg, `${op} failed`);
    else ctx.notify(msg, op);
    try {
      ctx.onFileOp?.(op, [...srcs], destDir, { cancelled, failed });
    } catch {}
  };

  // rename with nautilus-style collision handling: rename() would otherwise
  // silently overwrite the existing file
  const performRename = async (p: string, v: string): Promise<void> => {
    const dest = path.join(path.dirname(p), v);
    if (path.resolve(dest) === path.resolve(p)) {
      ctx.setStatusMsg("Name unchanged");
      ctx.renderAll();
      return;
    }
    let finalDest = dest;
    const units: UndoUnit[] = [];
    const redos: UndoUnit[] = [];
    const dUnits: UndoStep[] = [];
    const dRedos: UndoStep[] = [];
    if (existsSync(finalDest)) {
      // single target: the bulk policy row never shows (promptConflict only
      // offers "…all" when remaining > 0), so there is no policy to reset
      const choice = await conflict.promptConflict(finalDest, 0);
      if (choice === "skip") return;
      if (choice === "keepBoth") {
        finalDest = uniqueTarget(path.dirname(finalDest), path.basename(finalDest));
      } else {
        await stashVictim(finalDest, units, dUnits, (err) => {
          ctx.log(`replace stash failed ${finalDest}: ${fsErrText(err)} — proceeding without undo`);
        });
      }
    }
    try {
      await fsRename(p, finalDest);
      units.push(() => fsRename(finalDest, p));
      dUnits.push({ op: "rename", from: finalDest, to: p });
      redos.push(async () => {
        try {
          if (existsSync(p) && !existsSync(finalDest)) await fsRename(p, finalDest);
        } catch (err) {
          ctx.log(`redo rename ${finalDest}: ${fsErrText(err)}`);
        }
      });
      dRedos.push({ op: "rename-if", from: p, to: finalDest });
      const renameLabel = `rename ${path.basename(p)} → ${path.basename(finalDest)}`;
      ctx.pushUndoBatch(renameLabel, units, redos, { units: dUnits, redos: dRedos });
      ctx.renderAll();
      // status and notify share the sentence (they diverged on the basename
      // prefix before); the arrow names both ends so multi-tab renames stay clear
      const renamedMsg = `Renamed ${path.basename(p)} → ${path.basename(finalDest)} · ctrl+z to undo`;
      ctx.setStatusMsg(renamedMsg);
      ctx.notify(renamedMsg, "rename");
      try {
        ctx.onFileOp?.("rename", [p], finalDest, { cancelled: false, failed: 0 });
      } catch {}
    } catch (err) {
      const summary = `Rename failed (${fsErrText(err)})`;
      ctx.setStatusMsg(summary);
      ctx.notify(summary, "rename failed");
      try {
        ctx.onFileOp?.("rename", [p], finalDest, { cancelled: false, failed: 1 });
      } catch {}
    }
  };

  // bulk rename: pairs come from the planner in ./bulk-rename (no collisions,
  // no swaps), so plain sequential renames are safe and the whole batch is ONE
  // undo step. A vanished source or fs error counts per pair; the rest land.
  const performBulkRename = async (pairs: Array<{ from: string; to: string }>): Promise<void> => {
    if (!pairs.length) {
      ctx.setStatusMsg("Nothing to rename");
      return;
    }
    const units: UndoUnit[] = [];
    const redos: UndoUnit[] = [];
    const dUnits: UndoStep[] = [];
    const dRedos: UndoStep[] = [];
    let ok = 0;
    let failed = 0;
    const failWhy = new Set<string>();
    for (const { from, to } of pairs) {
      try {
        if (!existsSync(from)) {
          failed++;
          failWhy.add("source gone");
          continue;
        }
        await fsRename(from, to);
        units.push(() => fsRename(to, from));
        dUnits.push({ op: "rename", from: to, to: from });
        redos.push(async () => {
          try {
            if (existsSync(from) && !existsSync(to)) await fsRename(from, to);
          } catch (err) {
            ctx.log(`redo rename ${to}: ${fsErrText(err)}`);
          }
        });
        dRedos.push({ op: "rename-if", from, to });
        ok++;
      } catch (err) {
        failed++;
        failWhy.add(fsErrText(err));
      }
    }
    ctx.pushUndoBatch(`rename ${ok} item${ok === 1 ? "" : "s"}`, units, redos, { units: dUnits, redos: dRedos });
    ctx.renderAll();
    const bits = [`Renamed ${ok} item${ok === 1 ? "" : "s"}`];
    if (failed) bits.push(failSuffix(failed, failWhy));
    if (ok) bits.push("ctrl+z to undo");
    const msg = bits.join(" · ");
    ctx.setStatusMsg(msg);
    ctx.notify(msg, failed ? "rename failed" : "rename");
    try {
      ctx.onFileOp?.(
        "rename",
        pairs.map((p) => p.from),
        undefined,
        { cancelled: false, failed },
      );
    } catch {}
  };

  // duplicate = copy in place: runTransfer's same-path branch makes
  // "name (copy)" without a conflict prompt. A cross-directory selection
  // (search results, recent view) groups by parent so each copy lands next to
  // its source instead of flattening into one dir. One undo batch per dir.
  //
  // Re-entry guard: a spammed ctrl+d (terminal autorepeat) used to start one
  // batch per keypress — each a real copy + renderAll + notify — and the
  // native renderer OOMs on the flood (crash log: "Failed to create
  // SyntaxStyle" → console overlay alloc fails → exit). Ignore while running.
  let duplicating = false;
  const duplicate = async (paths: string[]): Promise<void> => {
    if (duplicating) return;
    duplicating = true;
    try {
      const byDir = new Map<string, string[]>();
      for (const p of paths) {
        const d = path.dirname(p);
        const group = byDir.get(d);
        if (group) group.push(p);
        else byDir.set(d, [p]);
      }
      for (const [dir, group] of byDir) {
        await runTransfer("copy", dir, group, `duplicate ${group.length} item${group.length === 1 ? "" : "s"}`);
      }
    } finally {
      duplicating = false;
    }
  };

  // --- internal clipboard (cut/copy pending items) ---
  let clipboard: { mode: "copy" | "cut"; items: ClipItem[] } | null = null;

  // tfm publishes x-special/gnome-copied-files (copy|cut header + file://
  // URIs) so Tfm->Nautilus / Tfm->Tfm paste-as-files works (bridge lives in
  // ./clipboard, tested)
  const setClipboard = (mode: "copy" | "cut", items: ClipItem[]): void => {
    clipboard = items.length ? { mode, items } : null;
    if (clipboard) publishPathsToSystemClipboard(mode, items, ctx.log);
    // staging, not done — "Copied …" here made paste look already finished
    ctx.setStatusMsg(
      clipboard
        ? `${mode === "cut" ? "Cut" : "Copy"} ${items.length} item${items.length === 1 ? "" : "s"} · paste to complete`
        : "",
    );
    ctx.refreshCutVisuals();
  };

  const doPaste = async (dest: string): Promise<void> => {
    if (!clipboard || clipboard.items.length === 0) return;
    const mode = clipboard.mode === "copy" ? "copy" : "move";
    const srcs = clipboard.items.map((i) => i.path);
    const n = srcs.length;
    clipboard = null;
    ctx.refreshCutVisuals();
    await runTransfer(
      mode,
      dest,
      srcs,
      mode === "copy"
        ? `paste ${n} item${n === 1 ? "" : "s"}`
        : `move ${n} item${n === 1 ? "" : "s"} to ${path.basename(dest) || "/"}`,
    );
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
      if (res) {
        const n = res.paths.length;
        void runTransfer(
          res.op === "move" ? "move" : "copy",
          dest,
          res.paths,
          `paste ${n} item${n === 1 ? "" : "s"} (external)`,
        );
      } else {
        // neither internal nor system clipboard holds files — say so instead
        // of a silent no-op (bare-text clips intentionally don't qualify)
        ctx.setStatusMsg("Nothing to paste");
      }
    });
  };

  const moveInto = async (destDir: string, items: ClipItem[]): Promise<void> => {
    // trashing goes through trashPaths (trashinfo metadata) — a raw move
    // into Trash/files orphans the .trashinfo OriginalPath chain
    if (isInTrashFiles(destDir)) {
      ctx.setStatusMsg("Can't move into Trash");
      return;
    }
    const srcs = items
      .filter((it) => !(it.isDir && (destDir === it.path || destDir.startsWith(it.path + path.sep))))
      .map((it) => it.path);
    // everything filtered out = drop onto itself — say so instead of
    // reporting a confusing "Moved 0 items" via runTransfer
    if (!srcs.length) {
      ctx.setStatusMsg("Already here");
      return;
    }
    ctx.log(
      `moveInto dest=${destDir} in=${items.length} out=${srcs.length} dropped=[${items
        .filter((it) => it.isDir && (destDir === it.path || destDir.startsWith(it.path + path.sep)))
        .map((it) => it.path.split("/").pop())
        .join(",")}]`,
    );
    await runTransfer(
      "move",
      destDir,
      srcs,
      `move ${srcs.length} item${srcs.length === 1 ? "" : "s"} to ${path.basename(destDir) || "/"}`,
    );
  };

  return {
    runTransfer,
    performRename,
    performBulkRename,
    duplicate,
    // the same progress sink transfers report into — the trash wiring drives
    // deleteForever through it so deletes get the toast + cancel for free
    progressSink: transferSink,
    setClipboard,
    pasteSmart,
    moveInto,
    // live read — index/menus need the current clipboard without owning it
    clipboard: (): { mode: "copy" | "cut"; items: ClipItem[] } | null => clipboard,
  };
};
