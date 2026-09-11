// --- File operations orchestration: every destructive-but-reversible op
// (copy/move/paste/rename) funnels through runTransfer/performRename here so
// overrides are asked once (conflict policy) and undo covers the whole batch.
// The copy engine lives in ./transfer (pure, sink-injected) and the progress
// toast in ./ui-progress — this factory owns the wiring between them plus the
// internal clipboard. Same seam as grid-input.ts: no renderer imports. ---

import path from "node:path";
import type { ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readdir, rm, rename as fsRename } from "node:fs/promises";
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
import {
  commonParent,
  compressPlan,
  compressionExt,
  detectArchiveFormat,
  extractPlan,
  listArchiveEntries,
  runArchiveTool,
  uniqueArchiveTarget,
  type ArchiveFormat,
  type ArchiveRun,
  type CompressionFormat,
} from "./archive";
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
  // archive engine seam (tests inject; default = src/fs/archive)
  runArchive?: ArchiveRun;
  listArchive?: (fmt: ArchiveFormat, file: string) => Promise<number>;
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
  const runArchive: ArchiveRun = ctx.runArchive ?? runArchiveTool;
  const listArchive =
    ctx.listArchive ?? ((fmt: ArchiveFormat, file: string) => listArchiveEntries(fmt, file, runArchive));

  // archive progress helpers: reset shared flags per op (stale-cancel lesson),
  // arm the toast only when the total clears shouldToast
  const resetProg = (): void => {
    prog.paused = false;
    prog.cancelled = false;
    prog.doneFiles = 0;
    prog.bytes = 0;
    prog.totalFiles = 0;
    prog.totalBytes = 0;
  };
  const setProgVerb = (verb: string, totalFiles: number, totalBytes = 0): void => {
    prog.verb = verb;
    prog.totalFiles = totalFiles;
    prog.totalBytes = totalBytes;
  };
  const armProgressToast = (): void => {
    if (shouldToast(prog.totalBytes, prog.totalFiles)) {
      prog.active = true;
      ctx.showProgressToast();
      ctx.paintProgress(true);
    }
  };
  // register the live child so the toast's ✕ kills it (SIGTERM) and the pause
  // button stops/resumes it (SIGSTOP/SIGCONT) — archive tools report no bytes,
  // so the ReadStream path never applies
  const onArchiveChild = (child: ChildProcess): void => {
    prog.processCancel = () => {
      // SIGCONT first: a paused (SIGSTOPped) child ignores SIGTERM/SIGKILL
      // until it is resumed, and a stuck child would lock the serial op queue
      try {
        child.kill("SIGCONT");
      } catch {}
      try {
        child.kill("SIGKILL");
      } catch {}
    };
    prog.processPause = () => {
      if (!child.pid) return;
      try {
        process.kill(child.pid, prog.paused ? "SIGSTOP" : "SIGCONT");
      } catch {}
    };
  };
  const clearArchiveChild = (): void => {
    prog.processCancel = null;
    prog.processPause = null;
  };

  // first non-blank line of a tool's stderr — the actionable part of a failure
  const firstErrLine = (s: string): string => {
    for (const line of s.split("\n")) {
      const t = line.trim();
      if (t) return t;
    }
    return "";
  };

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
    // best-effort sweep of crashed-transfer orphans (<dest>.tfm-part-*) and
    // crashed-extract staging (`.tfm-extract-*`) so a SIGKILL during the last
    // run doesn't pile up tmp dirs in the dest dir. Safe against live ops: the
    // serial op queue means no extract/transfer is running here concurrently.
    try {
      const kids = await readdir(destDir).catch(() => [] as string[]);
      for (const k of kids) {
        if (k.includes(".tfm-part-") || k.startsWith(".tfm-extract-")) {
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

  // --- Archive ops. The engine (argv + child runner) is ./archive; here we
  // own conflict/undo/progress. Extract stages into a hidden dir first, then
  // moves the top-level entries into place through the SAME conflict prompt as
  // runTransferInner — a tool that overwrites on its own would silently destroy
  // colliding files. Undo trashes what landed (a move-back to staging would
  // resurrect a deleted staging dir). Compress writes to a `.tfm-part-*` temp
  // so a cancel/crash can't leave a half-written archive (and the existing
  // orphan sweep in runTransferInner cleans a killed run). ---
  const extractArchive = (files: string[], destDir: string): Promise<void> =>
    queue.enqueue(() => extractArchiveInner(files, destDir));

  const extractArchiveInner = async (files: string[], destDir: string): Promise<void> => {
    if (!files.length) {
      ctx.setStatusMsg("Nothing to extract");
      return;
    }
    if (destDir.includes("://")) {
      ctx.setStatusMsg("Can't extract here");
      return;
    }
    conflict.resetPolicy();
    resetProg();
    const units: UndoUnit[] = [];
    const dUnits: UndoStep[] = [];
    const failWhy = new Set<string>();
    const staging: string[] = [];
    let ok = 0;
    let skipped = 0;
    let failed = 0;
    let cancelled = false;
    try {
      // one total across all archives so the bar doesn't reset per file
      let totalFiles = 0;
      for (const f of files) {
        const fmt = detectArchiveFormat(f);
        if (fmt && existsSync(f)) totalFiles += await listArchive(fmt, f);
      }
      setProgVerb("extracting", totalFiles);
      armProgressToast();
      for (const file of files) {
        if (cancelled || prog.cancelled) {
          cancelled = true;
          break;
        }
        const fmt = detectArchiveFormat(file);
        if (!fmt || !existsSync(file)) {
          skipped++;
          continue;
        }
        const stage = path.join(destDir, `.tfm-extract-${process.pid}-${Math.random().toString(36).slice(2, 10)}`);
        await mkdir(stage, { recursive: true });
        staging.push(stage);
        const res = await runArchive(extractPlan(fmt, file, stage), {
          onLine: () => {
            prog.doneFiles++;
            ctx.paintProgress();
          },
          onChild: onArchiveChild,
        });
        if (prog.cancelled) {
          cancelled = true;
          break;
        }
        if (res.code !== 0 && res.code !== 1) {
          // exit 1 is a warning for tar/unzip/7z (some members skipped) — the
          // rest extracted fine, so don't discard the stage over it
          failed++;
          failWhy.add(firstErrLine(res.stderr) || "extract failed");
          continue;
        }
        let entries: string[];
        try {
          entries = await readdir(stage);
        } catch {
          entries = [];
        }
        let movedHere = 0;
        for (const name of entries) {
          const src = path.join(stage, name);
          let target = path.join(destDir, name);
          if (existsSync(target)) {
            const choice = conflict.policy() ?? (await conflict.promptConflict(target, 0));
            if (choice === "skip") {
              skipped++;
              continue;
            }
            if (choice === "keepBoth") target = uniqueTarget(destDir, name);
            else
              await stashVictim(target, units, dUnits, (err) => {
                failWhy.add(fsErrText(err));
                ctx.log(`replace stash failed ${target}: ${fsErrText(err)} — proceeding without undo`);
              });
          }
          try {
            await fsMove(src, target);
            units.push(() => xdgTrashMove(target).then(() => undefined));
            dUnits.push({ op: "trash", path: target });
            movedHere++;
          } catch (err) {
            failed++;
            failWhy.add(fsErrText(err));
          }
        }
        // an archive that yielded nothing is not a success and must not
        // advertise an undo with no units. Collision-skips are already counted
        // per entry — only an empty archive adds an archive-level skip.
        if (movedHere) ok++;
        else if (!entries.length) skipped++;
      }
    } finally {
      clearArchiveChild();
      prog.active = false;
      for (const s of staging) {
        try {
          await rm(s, { recursive: true, force: true });
        } catch {}
      }
    }
    ctx.pushUndoBatch(`extract ${ok} archive${ok === 1 ? "" : "s"}`, units, [], { units: dUnits, redos: [] });
    ctx.renderAll();
    const bits = [cancelled ? `Extract cancelled (${ok} done)` : `Extracted ${ok} archive${ok === 1 ? "" : "s"}`];
    if (skipped) bits.push(`${skipped} skipped`);
    if (failed) bits.push(failSuffix(failed, failWhy));
    if (units.length && !cancelled) bits.push("ctrl+z to undo");
    const msg = bits.join(" · ");
    ctx.setStatusMsg(msg);
    if (prog.toastUp) {
      ctx.finishProgressToast(cancelled ? "✗ Extract cancelled" : failed ? "✗ Extract failed" : `✓ Extracted ${ok}`);
    }
    if (cancelled) ctx.notify(msg, "extract cancelled");
    else if (failed > 0) ctx.notify(msg, "extract failed");
    else ctx.notify(msg, "extract");
    try {
      ctx.onFileOp?.("extract", [...files], destDir, { cancelled, failed });
    } catch {}
  };

  const compressPaths = (paths: string[], format: CompressionFormat, destDir: string): Promise<void> =>
    queue.enqueue(() => compressPathsInner(paths, format, destDir));

  const compressPathsInner = async (paths: string[], format: CompressionFormat, destDir: string): Promise<void> => {
    if (destDir.includes("://")) {
      ctx.setStatusMsg("Can't compress here");
      return;
    }
    const srcs = paths.filter((p) => !p.includes("://") && existsSync(p));
    if (!srcs.length) {
      ctx.setStatusMsg("Nothing to compress");
      return;
    }
    conflict.resetPolicy();
    resetProg();
    const units: UndoUnit[] = [];
    const dUnits: UndoStep[] = [];
    const failWhy = new Set<string>();
    let failed = 0;
    let cancelled = false;
    const parent = commonParent(srcs);
    // relative to the common parent: a basename-only list silently drops
    // outside-cwd selections (two `foo`s in different dirs collapse to one)
    const names = srcs.map((p) => path.relative(parent, p));
    const ext = compressionExt(format);
    const base = srcs.length === 1 ? path.basename(srcs[0]!) : "archive";
    let out = path.join(destDir, `${base}${ext}`);
    if (existsSync(out)) {
      const choice = conflict.policy() ?? (await conflict.promptConflict(out, 0));
      if (choice === "skip") {
        ctx.setStatusMsg("Compress cancelled");
        return;
      }
      if (choice === "keepBoth") out = uniqueArchiveTarget(destDir, base, ext);
      else
        await stashVictim(out, units, dUnits, (err) => {
          failWhy.add(fsErrText(err));
          ctx.log(`replace stash failed ${out}: ${fsErrText(err)} — proceeding without undo`);
        });
    }
    const tmp = `${out}.tfm-part-${process.pid}-${Math.random().toString(36).slice(2, 10)}`;
    let totalFiles = 0;
    for (const s of srcs) {
      try {
        totalFiles += (await scanTree(s)).files;
      } catch {}
    }
    prog.totalBytes = 0;
    setProgVerb("compressing", totalFiles);
    armProgressToast();
    try {
      const res = await runArchive(compressPlan(format, tmp, names, parent), {
        cwd: parent,
        onLine: () => {
          prog.doneFiles++;
          ctx.paintProgress();
        },
        onChild: onArchiveChild,
      });
      if (prog.cancelled) {
        cancelled = true;
      } else if (res.code !== 0) {
        failed++;
        failWhy.add(firstErrLine(res.stderr) || "compress failed");
      } else {
        await fsRename(tmp, out);
        units.push(() => xdgTrashMove(out).then(() => undefined));
        dUnits.push({ op: "trash", path: out });
      }
    } catch (err) {
      failed++;
      failWhy.add(fsErrText(err));
    } finally {
      // success already renamed tmp away; force rm is a no-op then and the
      // cancel/fail cleanup otherwise
      try {
        await rm(tmp, { force: true });
      } catch {}
      clearArchiveChild();
      prog.active = false;
    }
    ctx.pushUndoBatch(`compress ${path.basename(out)}`, units, [], { units: dUnits, redos: [] });
    ctx.renderAll();
    const bits = [cancelled ? "Compress cancelled" : `Compressed ${path.basename(out)}`];
    if (failed) bits.push(failSuffix(failed, failWhy));
    if (!failed && !cancelled) bits.push("ctrl+z to undo");
    const msg = bits.join(" · ");
    ctx.setStatusMsg(msg);
    if (prog.toastUp) {
      ctx.finishProgressToast(cancelled ? "✗ Compress cancelled" : failed ? "✗ Compress failed" : `✓ ${base}${ext}`);
    }
    if (cancelled) ctx.notify(msg, "compress cancelled");
    else if (failed > 0) ctx.notify(msg, "compress failed");
    else ctx.notify(msg, "compress");
    try {
      ctx.onFileOp?.("compress", srcs, out, { cancelled, failed });
    } catch {}
  };

  return {
    runTransfer,
    performRename,
    performBulkRename,
    duplicate,
    extractArchive,
    compressPaths,
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
