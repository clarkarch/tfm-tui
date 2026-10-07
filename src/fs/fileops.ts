// --- File operations orchestration: every destructive-but-reversible op
// (copy/move/paste/rename) funnels through runTransfer/performRename here so
// overrides are asked once (conflict policy) and undo covers the whole batch.
// The copy engine lives in ./transfer (pure, sink-injected) and the progress
// toast in ./ui-progress — this factory owns the wiring between them plus the
// internal clipboard. Same seam as grid-input.ts: no renderer imports. ---

import path from "node:path";
import type { ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, lstat, readdir, readlink, rm, rename as fsRename } from "node:fs/promises";
import { swallow } from "../app/log";
import {
  failSuffix,
  fileIdMatches,
  fileIdOf,
  fsErrText,
  fsMove,
  isInTrashFiles,
  isWithinOrEqual,
  rmTrashInfoForPath,
  safeRestoreMove,
  shouldToast,
  tmpName,
  trashDir,
  trashIfSameFile,
  trashInfoPathForTrashFile,
  uniqueTarget,
  xdgTrashMoveToRoot,
  xdgTrashMove,
  crossDevice as fsCrossDevice,
} from "./fsutil";
import { defaultSudoExec, isPrivilegeError, runSudoTool, sudoCpArgv, sudoMvArgv, sudoRmArgv } from "./elevate";
import { copyTreeProgress, scanTree, type TransferSink } from "./transfer";
import {
  commonParent,
  compressionExt,
  countArchiveEntries,
  detectArchiveFormat,
  runArchiveTask,
  runArchiveTool,
  uniqueArchiveTarget,
  type ArchiveFormat,
  type ArchiveRun,
  type CompressionFormat,
  type WhichFn,
} from "./archive";
import { publishPathsToSystemClipboard, readCopiedFilesFromSystemClipboard } from "./clipboard";
import { sharedOpQueue } from "../lib/op-queue";
import { checkPluginVeto, sharedPluginHooks } from "../lib/plugin-hooks";
import type { ConflictChoice } from "../ui/ui-dialogs";
import type { NotifyLevel } from "../lib/notify-level";
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
  notify(msg: string, title?: string, level?: NotifyLevel): void;
  home: string;
  // cut-tile dimming repaint (tile visuals live in ./selection)
  refreshCutVisuals(): void;
  // injectable for tests — real impl lstats st.dev (fsutil)
  crossDevice?(a: string, b: string): boolean;
  // injectable source-removal for cross-device moves (tests force a partial
  // rm failure); real impl is rm(p, { recursive: true })
  removeTree?(p: string): Promise<void>;
  // injectable stash (tests force a failed replace-stash); real impl moves
  // the victim to trash via xdgTrashMove
  stashVictim?: (
    victimDest: string,
    units: UndoUnit[],
    dUnits: UndoStep[],
    onStashFailed: (err: unknown) => void,
  ) => Promise<boolean>;
  // archive engine seam (tests inject; default = src/fs/archive, which spawns
  // native tools when present and falls back to the in-process engine
  // otherwise — see selectArchiveLane)
  runArchive?: ArchiveRun;
  listArchive?: (fmt: ArchiveFormat, file: string) => Promise<number>;
  // tool probe for archive lane selection (tests force the fallback with
  // () => null); defaults to the real PATH probe
  archiveWhich?: WhichFn;
  // sudo escalation seams (wiring injects the prompt-backed impl; tests fake):
  // ensureSudo prompts for the password (cached-timestamp-first) once per op,
  // sudoExec runs one sudo argv and reports its exit (default = runSudo)
  ensureSudo?: (opLabel: string) => Promise<boolean>;
  sudoExec?: (argv: string[]) => Promise<{ status: number | null; stderr: string }>;
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
  const archiveWhich = ctx.archiveWhich ?? Bun.which;
  const listArchive =
    ctx.listArchive ?? ((fmt: ArchiveFormat, file: string) => countArchiveEntries(fmt, file, runArchive, archiveWhich));
  // one task call per archive op: spawn when tools exist, in-process fallback
  // otherwise. Cooperative hooks (no child to signal on the js lane — ✕/pause
  // flow through prog like the spawn path).
  const runArchiveOp = (
    task: Parameters<typeof runArchiveTask>[0],
    opts: { onLine?: (line: string) => void; cwd?: string; onLoss?: (loss: { exec: number; links: number }) => void },
  ): Promise<{ code: number; stdout: string; stderr: string }> =>
    runArchiveTask(task, {
      run: runArchive,
      which: archiveWhich,
      cwd: opts.cwd,
      onLine: opts.onLine,
      onChild: onArchiveChild,
      isCancelled: () => prog.cancelled,
      pauseGate: () => ctx.pauseGate(),
      onLoss: opts.onLoss,
      // hung-tool backstop (a wedged tar/7z holds the serial queue, and
      // quit/restart refuse while busy): generous enough for multi-GB
      // archives, fatal only for a truly stuck child
      timeoutMs: 15 * 60 * 1000,
    });

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
  // Shared op-summary tail (transfer/extract/compress — the three tails with
  // the same shape): joined message + toast finish (noun variants) + leveled
  // notify + plugin emit. Bulk rename's tail differs (no toast, title/level
  // co-vary) — it stays inline.
  const finishOpSummary = (
    op: string,
    noun: string,
    successText: string,
    msg: string,
    paths: string[],
    dest: string | undefined,
    cancelled: boolean,
    failed: number,
  ): void => {
    if (prog.toastUp) {
      ctx.finishProgressToast(cancelled ? `✗ ${noun} cancelled` : failed ? `✗ ${noun} failed` : `✓ ${successText}`);
    }
    if (cancelled) ctx.notify(msg, `${op} cancelled`, "info");
    else if (failed > 0) ctx.notify(msg, `${op} failed`, "error");
    else ctx.notify(msg, op, "success");
    try {
      ctx.onFileOp?.(op, paths, dest, { cancelled, failed });
    } catch {}
  };
  // Pre-scan in "counting" mode (nautilus' "Preparing…" counter): a huge
  // source tree used to run scanTree in total silence — seconds of dead UI
  // before the first honest total exists. The toast arms mid-scan once the
  // scan is demonstrably big (>1000 files) or slow (>400ms), so small ops
  // never pay a toast flicker. `armed` tells the caller the toast is already
  // up: keep it for the transfer even if the totals later look toastless
  // (slow disk + small tree is exactly when the user needs to see liveness).
  const preScan = async (
    srcs: string[],
    withBytes: boolean,
  ): Promise<{ files: number; bytes: number; armed: boolean }> => {
    let files = 0,
      bytes = 0,
      armed = false;
    const t0 = Date.now();
    prog.counting = true;
    prog.doneFiles = 0;
    try {
      for (const s of srcs) {
        // ✕ during a long pre-scan must stop the scan, not just the later loop
        if (prog.cancelled) break;
        const base = files;
        try {
          const r = await scanTree(s, (f) => {
            if (prog.cancelled) throw new Error("cancelled");
            prog.doneFiles = base + f;
            if (!armed && (prog.doneFiles >= 1000 || Date.now() - t0 > 400)) {
              armed = true;
              prog.active = true;
              ctx.showProgressToast();
            }
            if (armed) ctx.paintProgress(true);
          });
          files += r.files;
          if (withBytes) bytes += r.bytes;
        } catch {}
      }
    } finally {
      prog.counting = false;
      prog.doneFiles = 0;
    }
    return { files, bytes, armed };
  };
  // register the live child so the toast's ✕ kills it (SIGKILL, SIGCONT first
  // when paused) and the pause button stops/resumes it (SIGSTOP/SIGCONT) —
  // archive tools report no bytes, so the ReadStream path never applies
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

  // first actionable stderr line of a failure. 7z -bso2 moved its whole entry
  // log to stderr, so a 7z failure opens with the version banner — report the
  // trailing error block (Error:/errno lines, probed) instead. No other tool's
  // stderr opens with that banner, so they keep the head untouched.
  const firstErrLine = (s: string): string => {
    const lines: string[] = [];
    for (const line of s.split("\n")) {
      const t = line.trim();
      if (t) lines.push(t);
    }
    const [head] = lines;
    if (head && /^(7-Zip|p7zip) /.test(head)) return lines.at(-1) ?? "";
    return head ?? "";
  };

  // plugin veto channel: a beforeFileOp hook returning { skip: true } blocks the
  // op before any work. Sync + isolated inside the hook bus.
  const vetoedByPlugin = (op: string, paths: string[], dest?: string): boolean =>
    checkPluginVeto(sharedPluginHooks(), ctx.notify, op, paths, dest);

  // fire-and-forget callers (wiring `void` sites, ui-rename, dnd) must never
  // see an unhandled rejection: promptConflict/preScan/readdir can all throw
  // above the per-file handlers, and the crash handler would log them with no
  // toast — a silent failure. Every queued op funnels through here so the
  // returned promise never rejects: unexpected throws log + toast + repaint.
  const guardOp = async (noun: string, fn: () => Promise<void>): Promise<void> => {
    try {
      await fn();
    } catch (err) {
      ctx.log(`${noun} failed: ${fsErrText(err)}`);
      ctx.notify(`${noun} failed (${fsErrText(err)})`, noun.toLowerCase(), "error");
      try {
        ctx.renderAll();
      } catch {}
    }
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
  const stashVictim: FileOpsCtx["stashVictim"] =
    ctx.stashVictim ??
    (async (victimDest, units, dUnits, onStashFailed) => {
      try {
        if (!existsSync(victimDest)) return false;
        const trashLoc = await xdgTrashMove(victimDest);
        units.push(async () => {
          await safeRestoreMove(trashLoc, victimDest);
          await rmTrashInfoForPath(trashLoc, ctx.log);
        });
        dUnits.push({ op: "restore-move", from: trashLoc, to: victimDest });
        dUnits.push({ op: "rm-trashinfo", name: path.basename(trashLoc), path: trashLoc });
        return true;
      } catch (err) {
        onStashFailed(err);
        return false;
      }
    });

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
    repaint: ctx.paintProgress,
  };
  const copyTreeProgressWired = (src: string, dest: string): Promise<void> => copyTreeProgress(src, dest, transferSink);
  const isCrossDevice = (a: string, b: string): boolean => (ctx.crossDevice ?? fsCrossDevice)(a, b);
  const removeTree = ctx.removeTree ?? ((p: string) => rm(p, { recursive: true }));
  const sudoExec = ctx.sudoExec ?? defaultSudoExec;

  // sudo retry: one password gate per op (memoized by the caller), then the
  // same end-state as the normal path via cp -a / mv so undo units below can
  // be reused untouched. Throws the tool's first stderr line on failure.
  const sudoCopy = (src: string, target: string): Promise<void> => runSudoTool(sudoExec, sudoCpArgv(src, target));
  const sudoMove = (src: string, target: string): Promise<void> => runSudoTool(sudoExec, sudoMvArgv(src, target));
  const sudoRemove = (target: string): Promise<void> => runSudoTool(sudoExec, sudoRmArgv(target));
  // sudo replace-stash: the normal stashVictim runs unprivileged BEFORE any
  // sudo retry, so a privileged victim would abort the op as "Replace failed"
  // without ever reaching the gate. Same claim/rename/finalize loop as
  // xdgTrashMoveToRoot with sudo-mv (one loop in fsutil, not a near-clone) —
  // any failure returns false (the caller aborts that iteration).
  //
  // The pushed undo unit is sudo-aware: a sudo-moved victim is root-owned in
  // the user's trash, so the unprivileged restore fails EACCES — retry
  // privileged behind one gate instead of stranding the victim (the failure
  // mode trash/restore refuse to create by never escalating). Journal replay
  // stays best-effort unprivileged (the persisted steps carry no privilege),
  // covered by the "(may need permission)" hint.
  const sudoStashVictim = async (victimDest: string, units: UndoUnit[], dUnits: UndoStep[]): Promise<boolean> => {
    try {
      const trashLoc = await xdgTrashMoveToRoot(victimDest, trashDir(), sudoMove);
      const tid = fileIdOf(trashLoc);
      units.push(async () => {
        if (!existsSync(trashLoc)) return;
        if (tid && !fileIdMatches(tid, trashLoc)) {
          ctx.log(`undo replace ${victimDest}: trashed copy changed, skipped`);
          return;
        }
        let gated: boolean | null = null;
        const gate = async (): Promise<boolean> => {
          if (gated === null) gated = ctx.ensureSudo ? await ctx.ensureSudo("undo replace") : false;
          return gated;
        };
        try {
          await safeRestoreMove(trashLoc, victimDest);
        } catch (err) {
          if (!isPrivilegeError(err) || !(await gate())) throw err;
          await sudoMove(trashLoc, victimDest);
        }
        await rmTrashInfoForPath(trashLoc, ctx.log);
        const infoPath = trashInfoPathForTrashFile(trashLoc);
        // cosmetic cleanup only: never prompt for a password just for a
        // sidecar — escalate only when the gate already passed above
        if (infoPath && existsSync(infoPath) && gated === true) {
          try {
            await sudoRemove(infoPath);
          } catch (infoErr) {
            ctx.log(`undo replace sidecar cleanup ${infoPath}: ${fsErrText(infoErr)}`);
          }
        }
      });
      dUnits.push({ op: "restore-move", from: trashLoc, to: victimDest });
      dUnits.push({ op: "rm-trashinfo", name: path.basename(trashLoc), path: trashLoc });
      return true;
    } catch {
      return false;
    }
  };

  // every destructive-but-reversible file op funnels through here so overrides
  // are asked once and undo covers the whole batch. Serialized through the
  // shared op queue so concurrent pastes/moves/trashes never interleave.
  // Crash semantics: each file lands via tmp+rename (no half-visible dest);
  // a multi-file batch is per-file atomic, not batch-atomic — completed files
  // stay undoable via the pushed batch.
  const runTransfer = (
    op: "copy" | "move",
    destDir: string,
    srcs: string[],
    label: string,
    veto = true,
  ): Promise<void> => {
    // plugin veto BEFORE enqueue (and before any caller side effects — paste
    // clears its clipboard only after this returns false)
    if (veto && vetoedByPlugin(op, srcs, destDir)) return Promise.resolve();
    return queue.enqueue(() =>
      guardOp(op === "copy" ? "Copy" : "Move", () => runTransferInner(op, destDir, srcs, label)),
    );
  };
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
      ctx.notify(op === "copy" ? "Nothing to copy" : "Nothing to move", op, "info");
      return;
    }
    // best-effort sweep of crashed-transfer orphans (<dest>.tfm-part-*) and
    // crashed-extract staging (`.tfm-extract-*`) so a SIGKILL during the last
    // run doesn't pile up tmp dirs in the dest dir. Safe against live ops: the
    // serial op queue means no extract/transfer is running here concurrently.
    try {
      const kids = await readdir(destDir).catch(() => [] as string[]);
      for (const k of kids) {
        // anchor to the exact temp-name shape (<name>.tfm-part-<pid>-<rand8>
        // and .tfm-extract-<pid>-<rand8>) — a substring match silently
        // deleted real user files like notes.tfm-part-2.md
        if (/\.tfm-part-\d+-[0-9a-z]{8}$/.test(k) || /^\.tfm-extract-\d+-[0-9a-z]{8}$/.test(k)) {
          try {
            await rm(path.join(destDir, k), { recursive: true, force: true });
          } catch (err) {
            swallow("crash orphan sweep", err);
          }
        }
      }
    } catch (err) {
      swallow("crash orphan sweep scan", err);
    }
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
      gone = 0,
      selfDrop = 0;
    const failWhy = new Set<string>();
    const total = srcs.length;
    // sudo gate memoized per op: one password prompt per batch, not per file.
    // usedSudo marks the toast hint: set ONLY when a sudo success lands undo
    // units (gate passes for cleanup-only paths must not qualify later
    // unprivileged successes).
    let sudoOk: boolean | null = null;
    let usedSudo = false;
    const needSudo = async (): Promise<boolean> => {
      if (sudoOk !== null) return sudoOk;
      sudoOk = ctx.ensureSudo ? await ctx.ensureSudo(label) : false;
      return sudoOk;
    };
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
      const r = await preScan(srcs, true);
      prog.totalFiles = r.files || Math.max(1, total);
      prog.totalBytes = r.bytes;
      if (r.armed || shouldToast(prog.totalBytes, prog.totalFiles)) {
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
        // pasting a folder into itself / into its own subtree would copy it
        // inside a destination that grows as we copy — unbounded recursion.
        // moveInto filters this upstream for drops; paste has no ancestor
        // check, so refuse here for BOTH ops.
        if (isWithinOrEqual(destDir, src)) {
          selfDrop++;
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
            let stashErr: unknown = null;
            const stashed = await stashVictim(target, units, dUnits, (err) => {
              stashErr = err;
              ctx.log(`replace stash failed ${target}: ${fsErrText(err)} — original kept`);
            });
            // a failed stash must abort the overwrite, not proceed silently
            // without undo (the victim is then destroyed for good) — but a
            // privileged victim gets one sudo retry first (the normal stash
            // runs before any gate, so without this the escalated path is
            // unreachable for replace flows)
            if (!stashed) {
              const sudoStashed =
                isPrivilegeError(stashErr) && (await needSudo()) && (await sudoStashVictim(target, units, dUnits));
              if (sudoStashed) {
                usedSudo = true;
                replaced++;
              } else {
                failWhy.add(fsErrText(stashErr));
                failed++;
                continue;
              }
            } else replaced++;
          }
        }
        // per-iteration: did THIS src go through the streaming copy engine?
        // (cross-device moves need the same half-copy cleanup real copies get)
        let copiedHere = false;
        // cross-device move whose COPY landed but whose source removal failed:
        // `target` is the only complete data — the sudo retry must only retry
        // the removal, never rm/recopy the complete copy (total data loss).
        let sourceRemovalFailed = false;
        const recordSuccess = (): void => {
          const t = target,
            s = src;
          if (op === "copy") {
            const tid = fileIdOf(t);
            units.push(() => trashIfSameFile(t, tid, ctx.log));
            dUnits.push({ op: "trash", path: t, ...(tid ?? {}) });
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
        };
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
            try {
              await removeTree(src);
            } catch (err) {
              // source is partially deleted; the copy in `target` is now the
              // ONLY complete data — clearing it (the half-copy cleanup below)
              // would lose everything. Keep it and report loudly. The sudo
              // retry is told to retry ONLY the removal (sourceRemovalFailed).
              copiedHere = false;
              sourceRemovalFailed = true;
              throw new Error(`source partially removed: ${fsErrText(err)}`);
            }
          } else await fsMove(src, target);
          recordSuccess();
        } catch (err) {
          // privilege failure → one password gate per batch, then the same
          // end-state via sudo; undo units stay identical. Moves across a
          // filesystem boundary retry as sudo cp + sudo rm (rename can't
          // cross devices), preserving the partial-removal accounting below.
          let failure: unknown = err;
          if (!prog.cancelled && isPrivilegeError(err) && (await needSudo())) {
            // ✕ landed while the password prompt was up: abort, don't exec
            if (prog.cancelled) failure = new Error("cancelled");
            else {
              try {
                if (sourceRemovalFailed) {
                  // the copy already landed — only the source needs privilege.
                  // NEVER touch `target` here: the source is partially deleted
                  // and `target` is the only complete copy (an rm+recopy of it
                  // destroys the files the failed rm already removed).
                  try {
                    await sudoRemove(src);
                  } catch (rmErr) {
                    throw new Error(`source partially removed: ${fsErrText(rmErr)}`);
                  }
                } else if (op === "copy") {
                  // clear a partial target first: `cp -a src target` with an
                  // existing directory target nests src inside it — and a
                  // failed clear must abort, not proceed: the nested copy
                  // would report success for the wrong end-state while the
                  // undo unit trashes the wrong path
                  if (existsSync(target)) {
                    try {
                      await sudoRemove(target);
                    } catch (preErr) {
                      throw new Error(`cannot clear partial target: ${fsErrText(preErr)}`);
                    }
                  }
                  await sudoCopy(src, target);
                } else if (isCrossDevice(src, destDir)) {
                  try {
                    await sudoRemove(target);
                  } catch (preErr) {
                    // same nesting hazard as the copy branch above (`cp -a`
                    // into an existing dir) — abort instead of misreporting
                    if (existsSync(target)) throw new Error(`cannot clear partial target: ${fsErrText(preErr)}`);
                  }
                  await sudoCopy(src, target);
                  if (prog.cancelled) throw new Error("cancelled");
                  try {
                    await sudoRemove(src);
                  } catch (rmErr) {
                    throw new Error(`source partially removed: ${fsErrText(rmErr)}`);
                  }
                } else await sudoMove(src, target);
                recordSuccess();
                usedSudo = true;
                continue;
              } catch (sudoErr) {
                failure = sudoErr;
              }
            }
          }
          // don't leave half-copied files behind (copies AND cross-device moves).
          // A root-owned partial needs the sudo remover — the gate already
          // passed if we're here via a sudo attempt (memoized, no re-prompt).
          if (op === "copy" || copiedHere) {
            try {
              await rm(target, { recursive: true });
            } catch (cleanup) {
              ctx.log(`half-copy cleanup failed ${target}: ${fsErrText(cleanup)}`);
              if (isPrivilegeError(cleanup) && (await needSudo())) {
                try {
                  await sudoRemove(target);
                } catch (sudoCleanup) {
                  ctx.log(`half-copy sudo cleanup failed ${target}: ${fsErrText(sudoCleanup)}`);
                }
              }
            }
          }
          if (prog.cancelled) {
            cancelled = true;
            break;
          }
          failed++;
          failWhy.add(fsErrText(failure));
        }
      }
    } finally {
      prog.active = false;
    }
    // a fully-failed batch carries no units — pushing it pollutes the undo
    // stack with a redoable no-op ("Undid: rename 0 items"); stashed victims
    // still count (their restore unit is in units even when the op failed)
    if (units.length) ctx.pushUndoBatch(label, units, redos, { units: dUnits, redos: dRedos });
    ctx.renderAll();
    const verb = op === "copy" ? "Copied" : "Moved";
    const opNoun = op === "copy" ? "Copy" : "Move";
    // the outcome surfaces once, as a leveled toast (the status bar is
    // selection info only). The destination folds into the verb phrase
    // ("Copied 2 items to ~/Docs"), never after the undo hint.
    const landed = !cancelled && !failed && ok + replaced > 0;
    const destTail = landed ? ` to ~/${path.relative(ctx.home, destDir) || "/"}` : "";
    const bits = [`${verb} ${ok} item${ok === 1 ? "" : "s"}${destTail}`];
    if (replaced) bits.push(`${replaced} replaced`);
    if (skipped) bits.push(`${skipped} skipped`);
    if (gone) bits.push(`${gone} source gone`);
    if (selfDrop) bits.push(`${selfDrop} folder into itself`);
    if (failed) bits.push(failSuffix(failed, failWhy));
    if (ok || replaced) bits.push(usedSudo ? "ctrl+z to undo (may need permission)" : "ctrl+z to undo");
    const msg = bits.join(" · ");
    // always surface the outcome — success, failure, or cancel
    finishOpSummary(op, opNoun, `${verb} ${ok}`, msg, [...srcs], destDir, cancelled, failed);
  };

  // rename with nautilus-style collision handling: rename() would otherwise
  // silently overwrite the existing file. Queued like every other destructive
  // op: a rename interleaved with a transfer/trash/undo on the same paths
  // corrupts both, and an unqueued rename is invisible to the quit/restart
  // busy guard (half a bulk batch with no undo entry on teardown).
  const performRename = (p: string, v: string): Promise<void> => {
    const dest = path.join(path.dirname(p), v);
    if (path.resolve(dest) === path.resolve(p)) {
      ctx.notify("Name unchanged", "rename", "info");
      ctx.renderAll();
      return Promise.resolve();
    }
    if (vetoedByPlugin("rename", [p], dest)) return Promise.resolve();
    return queue.enqueue(() => guardOp("Rename", () => performRenameInner(p, dest)));
  };

  const performRenameInner = async (p: string, dest: string): Promise<void> => {
    let finalDest = dest;
    const units: UndoUnit[] = [];
    const redos: UndoUnit[] = [];
    const dUnits: UndoStep[] = [];
    const dRedos: UndoStep[] = [];
    // one password gate per rename (stash + main share it — two prompts for
    // one rename is the UX bug this memo avoids)
    let renameSudoOk: boolean | null = null;
    let renameUsedSudo = false;
    const needRenameSudo = async (): Promise<boolean> => {
      if (renameSudoOk !== null) return renameSudoOk;
      renameSudoOk = ctx.ensureSudo ? await ctx.ensureSudo(`rename ${path.basename(p)}`) : false;
      return renameSudoOk;
    };
    if (existsSync(finalDest)) {
      // single target: the bulk policy row never shows (promptConflict only
      // offers "…all" when remaining > 0), so there is no policy to reset
      const choice = await conflict.promptConflict(finalDest, 0);
      if (choice === "skip") return;
      if (choice === "keepBoth") {
        finalDest = uniqueTarget(path.dirname(finalDest), path.basename(finalDest));
      } else {
        let renameStashErr: unknown = null;
        const stashed = await stashVictim(finalDest, units, dUnits, (err) => {
          renameStashErr = err;
          ctx.log(`replace stash failed ${finalDest}: ${fsErrText(err)} — original kept`);
        });
        // a failed stash must not proceed to rename over the victim (that
        // destroys it with no undo path) — but a privileged victim gets one
        // sudo retry first, same as the transfer replace flow
        if (!stashed) {
          const sudoStashed =
            isPrivilegeError(renameStashErr) &&
            (await needRenameSudo()) &&
            (await sudoStashVictim(finalDest, units, dUnits));
          if (sudoStashed) renameUsedSudo = true;
          else {
            ctx.notify("Replace failed — existing file kept", "rename failed", "error");
            ctx.renderAll();
            return;
          }
        }
      }
    }
    let renameFailed: string | null = null;
    const pushRenameUnits = (): void => {
      units.push(() => safeRestoreMove(finalDest, p).then(() => undefined));
      dUnits.push({ op: "rename", from: finalDest, to: p });
      redos.push(async () => {
        try {
          if (existsSync(p) && !existsSync(finalDest)) await fsRename(p, finalDest);
        } catch (err) {
          ctx.log(`redo rename ${finalDest}: ${fsErrText(err)}`);
        }
      });
      dRedos.push({ op: "rename-if", from: p, to: finalDest });
    };
    try {
      await fsRename(p, finalDest);
      pushRenameUnits();
    } catch (err) {
      // privilege failure → password gate, then sudo mv; undo shape unchanged
      // (but still unprivileged — qualify the hint below)
      let failure: unknown = err;
      if (isPrivilegeError(err) && (await needRenameSudo())) {
        // the gate prompts (a concurrent create can land meanwhile) and
        // sudo mv has no no-clobber flag — re-check so a raced occupant is
        // never silently overwritten
        if (existsSync(finalDest)) {
          failure = new Error(`already exists: ${path.basename(finalDest)}`);
        } else {
          try {
            await sudoMove(p, finalDest);
            pushRenameUnits();
            renameUsedSudo = true;
            failure = null;
          } catch (sudoErr) {
            failure = sudoErr;
          }
        }
      }
      if (failure) {
        renameFailed = fsErrText(failure);
        ctx.log(`rename failed ${p} → ${finalDest}: ${renameFailed}`);
      }
    }
    // the stash's restore unit must survive a failed rename too — otherwise the
    // stashed victim sits in the trash with no undo entry (the batch was pushed
    // inside the try before)
    if (units.length) {
      ctx.pushUndoBatch(`rename ${path.basename(p)} → ${path.basename(finalDest)}`, units, redos, {
        units: dUnits,
        redos: dRedos,
      });
    }
    ctx.renderAll();
    if (renameFailed) {
      ctx.notify(`Rename failed (${renameFailed})`, "rename failed", "error");
      try {
        ctx.onFileOp?.("rename", [p], finalDest, { cancelled: false, failed: 1 });
      } catch {}
    } else {
      // the arrow names both ends so multi-tab renames stay clear
      const renameHint = renameUsedSudo ? "ctrl+z to undo (may need permission)" : "ctrl+z to undo";
      ctx.notify(`Renamed ${path.basename(p)} → ${path.basename(finalDest)} · ${renameHint}`, "rename", "success");
      try {
        ctx.onFileOp?.("rename", [p], finalDest, { cancelled: false, failed: 0 });
      } catch {}
    }
  };

  // bulk rename: pairs come from the planner in ./bulk-rename (no collisions,
  // no swaps), so plain sequential renames are safe and the whole batch is ONE
  // undo step. A vanished source or fs error counts per pair; the rest land.
  // Queued for the same reason as performRename (busy-guard visibility).
  const performBulkRename = (pairs: Array<{ from: string; to: string }>): Promise<void> => {
    if (!pairs.length) {
      ctx.notify("Nothing to rename", "rename", "info");
      return Promise.resolve();
    }
    if (
      vetoedByPlugin(
        "rename",
        pairs.map((x) => x.from),
      )
    )
      return Promise.resolve();
    return queue.enqueue(() => guardOp("Rename", () => performBulkRenameInner(pairs)));
  };

  const performBulkRenameInner = async (pairs: Array<{ from: string; to: string }>): Promise<void> => {
    const units: UndoUnit[] = [];
    const redos: UndoUnit[] = [];
    const dUnits: UndoStep[] = [];
    const dRedos: UndoStep[] = [];
    let ok = 0;
    let failed = 0;
    const failWhy = new Set<string>();
    let bulkSudoOk: boolean | null = null;
    let bulkUsedSudo = false;
    for (const { from, to } of pairs) {
      const recordBulk = (): void => {
        units.push(() => safeRestoreMove(to, from).then(() => undefined));
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
      };
      try {
        if (!existsSync(from)) {
          failed++;
          failWhy.add("source gone");
          continue;
        }
        // plan-time collision check is inherently racy (TOCTOU: an external
        // create — or an earlier pair's target — can land between plan and
        // apply) — re-check here so fsRename never silently overwrites
        if (existsSync(to)) {
          failed++;
          failWhy.add(`already exists: ${path.basename(to)}`);
          continue;
        }
        await fsRename(from, to);
        recordBulk();
      } catch (err) {
        let failure: unknown = err;
        if (isPrivilegeError(err)) {
          if (bulkSudoOk === null) bulkSudoOk = ctx.ensureSudo ? await ctx.ensureSudo("bulk rename") : false;
          // sudo mv has no no-clobber flag and the gate prompts (a concurrent
          // create can land meanwhile) — re-check so a raced occupant is
          // never silently overwritten
          if (bulkSudoOk && existsSync(to)) {
            failure = new Error(`already exists: ${path.basename(to)}`);
          } else if (bulkSudoOk) {
            try {
              await sudoMove(from, to);
              bulkUsedSudo = true;
              recordBulk();
              continue;
            } catch (sudoErr) {
              failure = sudoErr;
            }
          }
        }
        failed++;
        failWhy.add(fsErrText(failure));
      }
    }
    if (units.length)
      ctx.pushUndoBatch(`rename ${ok} item${ok === 1 ? "" : "s"}`, units, redos, { units: dUnits, redos: dRedos });
    ctx.renderAll();
    const bits = [`Renamed ${ok} item${ok === 1 ? "" : "s"}`];
    if (failed) bits.push(failSuffix(failed, failWhy));
    if (ok) bits.push(bulkUsedSudo ? "ctrl+z to undo (may need permission)" : "ctrl+z to undo");
    const msg = bits.join(" · ");
    ctx.notify(msg, failed ? "rename failed" : "rename", failed ? "error" : "success");
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
    if (vetoedByPlugin("duplicate", paths)) return;
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
        // veto=false: duplicate already ran the "duplicate" hook above; the
        // inner copy must not re-fire a copy hook per destination dir
        await runTransfer("copy", dir, group, `duplicate ${group.length} item${group.length === 1 ? "" : "s"}`, false);
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
    // identical re-stage (autorepeat re-cuts/copies the same selection):
    // the op is idempotent, so stay silent instead of stacking a toast per
    // press — a toast is an allocation, a status overwrite was not
    const same =
      clipboard !== null &&
      clipboard.mode === mode &&
      clipboard.items.length === items.length &&
      clipboard.items.every((it, i) => it.path === items[i]?.path);
    clipboard = items.length ? { mode, items } : null;
    if (clipboard) publishPathsToSystemClipboard(mode, items, ctx.log);
    // staging, not done — "Copied …" here made paste look already finished
    if (clipboard && !same)
      ctx.notify(
        `${mode === "cut" ? "Cut" : "Copy"} ${items.length} item${items.length === 1 ? "" : "s"} · paste to complete`,
        mode,
        "info",
      );
    ctx.refreshCutVisuals();
  };

  const doPaste = async (dest: string): Promise<void> => {
    if (!clipboard || clipboard.items.length === 0) return;
    const mode = clipboard.mode === "copy" ? "copy" : "move";
    const srcs = clipboard.items.map((i) => i.path);
    const n = srcs.length;
    // veto BEFORE consuming the clipboard: a blocked paste must leave the
    // pending copy/cut untouched (runTransfer re-checks are skipped below)
    if (vetoedByPlugin(mode, srcs, dest)) return;
    clipboard = null;
    ctx.refreshCutVisuals();
    await runTransfer(
      mode,
      dest,
      srcs,
      mode === "copy"
        ? `paste ${n} item${n === 1 ? "" : "s"}`
        : `move ${n} item${n === 1 ? "" : "s"} to ${path.basename(dest) || "/"}`,
      false,
    );
  };

  const pasteSmart = (dest: string): void => {
    if (isInTrashFiles(dest)) {
      ctx.notify("Can't paste into Trash", "paste", "error");
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
        ctx.notify("Nothing to paste", "paste", "info");
      }
    });
  };

  const moveInto = async (destDir: string, items: ClipItem[]): Promise<void> => {
    // trashing goes through trashPaths (trashinfo metadata) — a raw move
    // into Trash/files orphans the .trashinfo OriginalPath chain
    if (isInTrashFiles(destDir)) {
      ctx.notify("Can't move into Trash", "move", "error");
      return;
    }
    const srcs = items.filter((it) => !(it.isDir && isWithinOrEqual(destDir, it.path))).map((it) => it.path);
    // everything filtered out = drop onto itself — say so instead of
    // reporting a confusing "Moved 0 items" via runTransfer
    if (!srcs.length) {
      ctx.notify("Already here", "move", "info");
      return;
    }
    ctx.log(
      `moveInto dest=${destDir} in=${items.length} out=${srcs.length} dropped=[${items
        .filter((it) => it.isDir && isWithinOrEqual(destDir, it.path))
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
  // Spawn-lane containment: the js lane skips `..`/absolute members, but
  // tar/unzip/7z write them relative to the staging dir — `../evil` lands in
  // destDir (or above) unseen by the stage readdir. Snapshot destDir (+parent
  // for `../../`) across the tool run; anything new that isn't the stage is an
  // escape artifact — trash it (recoverable, never rm) and refuse the archive.
  // Symlinks inside staging that resolve outside it are unlinked for the same
  // reason (a later write through the link escapes staging).
  const snapshotNames = async (dir: string): Promise<Set<string>> => {
    try {
      return new Set(await readdir(dir));
    } catch {
      return new Set();
    }
  };
  const sanitizeStagedLinks = async (stage: string): Promise<number> => {
    const base = path.resolve(stage);
    let removed = 0;
    const stack: string[] = [base];
    while (stack.length) {
      const cur = stack.pop() as string;
      let kids: string[];
      try {
        kids = await readdir(cur);
      } catch {
        continue;
      }
      for (const k of kids) {
        const abs = path.join(cur, k);
        let st: { isDirectory(): boolean; isSymbolicLink(): boolean };
        try {
          st = await lstat(abs);
        } catch {
          continue;
        }
        if (st.isSymbolicLink()) {
          let target: string;
          try {
            target = path.resolve(path.dirname(abs), await readlink(abs));
          } catch {
            continue;
          }
          if (target !== base && !target.startsWith(`${base}${path.sep}`)) {
            try {
              await rm(abs, { force: true });
              removed++;
            } catch (err) {
              ctx.log(`staging link cleanup failed ${abs}: ${fsErrText(err)}`);
            }
          }
        } else if (st.isDirectory()) stack.push(abs);
      }
    }
    return removed;
  };
  const extractArchive = (files: string[], destDir: string): Promise<void> => {
    if (vetoedByPlugin("extract", files, destDir)) return Promise.resolve();
    return queue.enqueue(() => guardOp("Extract", () => extractArchiveInner(files, destDir)));
  };

  const extractArchiveInner = async (files: string[], destDir: string): Promise<void> => {
    if (!files.length) {
      ctx.notify("Nothing to extract", "extract", "info");
      return;
    }
    if (destDir.includes("://")) {
      ctx.notify("Can't extract here", "extract", "error");
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
    // one password gate per op (same memo pattern as runTransferInner)
    let archiveSudoOk: boolean | null = null;
    let usedSudo = false;
    const needArchiveSudo = async (): Promise<boolean> => {
      if (archiveSudoOk !== null) return archiveSudoOk;
      archiveSudoOk = ctx.ensureSudo ? await ctx.ensureSudo("extract") : false;
      return archiveSudoOk;
    };
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
        const stageBase = path.basename(stage);
        // containment snapshots: `../` members escape the stage into destDir
        // (or its parent for `../../`) — anything new there after the tool ran
        // is an escape artifact, never user data created through tfm (the
        // serial queue means no other op runs concurrently; external creates
        // in the window are trashed recoverably, never rm'd)
        const parentDir = path.dirname(path.resolve(destDir));
        const beforeDest = await snapshotNames(destDir);
        const beforeParent = parentDir === path.resolve(destDir) ? beforeDest : await snapshotNames(parentDir);
        await mkdir(stage, { recursive: true });
        staging.push(stage);
        const res = await runArchiveOp(
          { op: "extract", fmt, file, destDir: stage },
          {
            onLine: () => {
              prog.doneFiles++;
              ctx.paintProgress();
            },
          },
        );
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
        // warning-level exits (skipped members) still land in the debug trail —
        // the toast reports success like the spawn path, but the skip is on record
        if (res.code === 1 && res.stderr)
          ctx.log(`extract warnings ${path.basename(file)}: ${firstErrLine(res.stderr)}`);
        // escape sweep first: trash anything the tool wrote outside staging,
        // then refuse the archive (its staged content is from the same
        // untrusted member list, so nothing from it lands)
        let escaped = 0;
        const afterDest = await snapshotNames(destDir);
        for (const name of afterDest) {
          if (name === stageBase || beforeDest.has(name)) continue;
          try {
            await xdgTrashMove(path.join(destDir, name));
            escaped++;
          } catch (err) {
            ctx.log(`escape cleanup failed ${name}: ${fsErrText(err)}`);
          }
        }
        if (parentDir !== path.resolve(destDir)) {
          const afterParent = await snapshotNames(parentDir);
          const destBase = path.basename(path.resolve(destDir));
          for (const name of afterParent) {
            if (name === destBase || beforeParent.has(name)) continue;
            try {
              await xdgTrashMove(path.join(parentDir, name));
              escaped++;
            } catch (err) {
              ctx.log(`escape cleanup failed ${name}: ${fsErrText(err)}`);
            }
          }
        }
        if (escaped) {
          failed++;
          failWhy.add(`archive wrote outside staging (${escaped} moved to trash)`);
          continue;
        }
        const cutLinks = await sanitizeStagedLinks(stage);
        if (cutLinks) ctx.log(`staging links removed ${path.basename(file)}: ${cutLinks}`);
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
            else {
              let stashErr: unknown = null;
              const stashed = await stashVictim(target, units, dUnits, (err) => {
                stashErr = err;
                ctx.log(`replace stash failed ${target}: ${fsErrText(err)} — original kept`);
              });
              // privileged victims get one sudo retry (same as transfer and
              // rename replace flows) — abort only when that fails too
              if (!stashed) {
                const sudoStashed =
                  isPrivilegeError(stashErr) &&
                  (await needArchiveSudo()) &&
                  (await sudoStashVictim(target, units, dUnits));
                if (sudoStashed) usedSudo = true;
                else {
                  failWhy.add(fsErrText(stashErr));
                  failed++;
                  continue;
                }
              }
            }
          }
          try {
            await fsMove(src, target);
            const tid = fileIdOf(target);
            units.push(() => trashIfSameFile(target, tid, ctx.log));
            dUnits.push({ op: "trash", path: target, ...(tid ?? {}) });
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
        } catch (err) {
          // a surviving .tfm-extract-* dir is hidden debris in the user's folder
          swallow("archive staging cleanup", err);
        }
      }
    }
    if (units.length)
      ctx.pushUndoBatch(`extract ${ok} archive${ok === 1 ? "" : "s"}`, units, [], { units: dUnits, redos: [] });
    ctx.renderAll();
    const bits = [cancelled ? `Extract cancelled (${ok} done)` : `Extracted ${ok} archive${ok === 1 ? "" : "s"}`];
    if (skipped) bits.push(`${skipped} skipped`);
    if (failed) bits.push(failSuffix(failed, failWhy));
    if (units.length && !cancelled) bits.push(usedSudo ? "ctrl+z to undo (may need permission)" : "ctrl+z to undo");
    const msg = bits.join(" · ");
    finishOpSummary("extract", "Extract", `Extracted ${ok}`, msg, [...files], destDir, cancelled, failed);
  };

  const compressPaths = (paths: string[], format: CompressionFormat, destDir: string): Promise<void> => {
    if (vetoedByPlugin("compress", paths, destDir)) return Promise.resolve();
    return queue.enqueue(() => guardOp("Compress", () => compressPathsInner(paths, format, destDir)));
  };

  const compressPathsInner = async (paths: string[], format: CompressionFormat, destDir: string): Promise<void> => {
    if (destDir.includes("://")) {
      ctx.notify("Can't compress here", "compress", "error");
      return;
    }
    const srcs = paths.filter((p) => !p.includes("://") && existsSync(p));
    if (!srcs.length) {
      ctx.notify("Nothing to compress", "compress", "info");
      return;
    }
    conflict.resetPolicy();
    resetProg();
    const units: UndoUnit[] = [];
    const dUnits: UndoStep[] = [];
    const failWhy = new Set<string>();
    // non-fatal caveats (fallback fidelity loss): surface as their own
    // summary bit — failWhy only renders when failed > 0
    const warns: string[] = [];
    let failed = 0;
    let cancelled = false;
    // one password gate per op (same memo pattern as runTransferInner)
    let archiveSudoOk: boolean | null = null;
    let usedSudo = false;
    const needArchiveSudo = async (): Promise<boolean> => {
      if (archiveSudoOk !== null) return archiveSudoOk;
      archiveSudoOk = ctx.ensureSudo ? await ctx.ensureSudo("compress") : false;
      return archiveSudoOk;
    };
    const parent = commonParent(srcs);
    // relative to the common parent: a basename-only list silently drops
    // outside-cwd selections (two `foo`s in different dirs collapse to one)
    const names = srcs.map((p) => path.relative(parent, p));
    const ext = compressionExt(format);
    const onlySrc = srcs[0];
    const base = srcs.length === 1 && onlySrc !== undefined ? path.basename(onlySrc) : "archive";
    let out = path.join(destDir, `${base}${ext}`);
    if (existsSync(out)) {
      const choice = conflict.policy() ?? (await conflict.promptConflict(out, 0));
      if (choice === "skip") {
        ctx.notify("Compress cancelled", "compress cancelled", "info");
        return;
      }
      if (choice === "keepBoth") out = uniqueArchiveTarget(destDir, base, ext);
      else {
        let stashErr: unknown = null;
        const stashed = await stashVictim(out, units, dUnits, (err) => {
          stashErr = err;
          failWhy.add(fsErrText(err));
          ctx.log(`replace stash failed ${out}: ${fsErrText(err)} — original kept`);
        });
        // privileged victims get one sudo retry (same as transfer and rename
        // replace flows) — abort only when that fails too
        if (!stashed) {
          const sudoStashed =
            isPrivilegeError(stashErr) && (await needArchiveSudo()) && (await sudoStashVictim(out, units, dUnits));
          if (sudoStashed) usedSudo = true;
          else {
            ctx.notify("Replace failed — existing archive kept", "compress failed", "error");
            return;
          }
        }
      }
    }
    const tmp = tmpName(out);
    const scan = await preScan(srcs, false);
    prog.totalBytes = 0;
    setProgVerb("compressing", scan.files);
    if (scan.armed) {
      prog.active = true;
      ctx.paintProgress(true);
    } else armProgressToast();
    try {
      // tar-family fallback create drops exec bits and follows symlinks
      // (Bun.Archive's input is content-only) — the lane reports what it saw
      // via onLoss so the summary can warn without a second lstat walk.
      // Warn only when affected: plain trees stay silent, and zip needs no
      // note (the fflate lane preserves both and never fires onLoss).
      let loss = { exec: 0, links: 0 };
      const res = await runArchiveOp(
        { op: "compress", fmt: format, outFile: tmp, names, parent },
        {
          cwd: parent,
          onLine: () => {
            prog.doneFiles++;
            ctx.paintProgress();
          },
          onLoss: (l) => {
            loss = l;
          },
        },
      );
      if (prog.cancelled) {
        cancelled = true;
      } else if (res.code !== 0 && res.code !== 1) {
        // exit 1 is a warning (some inputs skipped/changed) — the produced
        // archive is usable, same rule the extract path already applies; only
        // >=2 is a real failure. Discarding a warning-level archive was the
        // asymmetry (extract tolerated 1, compress did not).
        failed++;
        failWhy.add(firstErrLine(res.stderr) || "compress failed");
      } else {
        await fsRename(tmp, out);
        const oid = fileIdOf(out);
        units.push(() => trashIfSameFile(out, oid, ctx.log));
        dUnits.push({ op: "trash", path: out, ...(oid ?? {}) });
        const n = loss.exec + loss.links;
        if (n > 0) warns.push(`${n} stored without exec/symlink (no tar)`);
      }
    } catch (err) {
      failed++;
      failWhy.add(fsErrText(err));
    } finally {
      // success already renamed tmp away; force rm is a no-op then and the
      // cancel/fail cleanup otherwise
      try {
        await rm(tmp, { force: true });
      } catch (err) {
        swallow("compress temp cleanup", err);
      }
      clearArchiveChild();
      prog.active = false;
    }
    if (units.length) ctx.pushUndoBatch(`compress ${path.basename(out)}`, units, [], { units: dUnits, redos: [] });
    ctx.renderAll();
    const bits = [cancelled ? "Compress cancelled" : `Compressed ${path.basename(out)}`];
    if (failed) bits.push(failSuffix(failed, failWhy));
    if (!failed && !cancelled && warns.length) bits.push(...warns);
    if (!failed && !cancelled) bits.push(usedSudo ? "ctrl+z to undo (may need permission)" : "ctrl+z to undo");
    const msg = bits.join(" · ");
    finishOpSummary("compress", "Compress", `${base}${ext}`, msg, srcs, out, cancelled, failed);
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
