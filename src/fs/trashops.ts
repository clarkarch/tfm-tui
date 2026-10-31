import { existsSync } from "node:fs";
import { readdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import {
  allTrashFilesDirs,
  failSuffix,
  countTrashItems,
  crossDeviceTo,
  fileIdOf,
  fsErrText,
  fsMove,
  rmTrashInfoForPath,
  trashDir,
  trashIfSameFile,
  trashInfoPathForTrashFile,
  xdgTrashMove,
  safeRestoreMove,
  type CrossDeviceCopy,
} from "./fsutil";
import { defaultSudoExec, isPrivilegeError, runSudoTool, sudoRmArgv } from "./elevate";
import { copyTreeProgress, rmTreeProgress, scanTree } from "./transfer";
import { sharedOpQueue } from "../lib/op-queue";
import { checkPluginVeto, sharedPluginHooks } from "../lib/plugin-hooks";
import type { NotifyLevel } from "../lib/notify-level";
import { shouldNotifyTerminal, type OpProgress } from "../lib/file-op-protocol";
import { isNetworkPath } from "./network";
import { isArchiveUri } from "./uri";
import type { UndoJournalData, UndoStep, UndoUnit } from "./undo-steps";

// --- Trash operations: trash / restore / delete-forever / empty. The fs
// primitives come from fsutil; UI feedback (leveled toast notifications,
// refresh) and the undo stack arrive through an injected sink, so this module
// never touches the renderer or app state.
//
// Concurrency: every op runs through the shared serial queue so two rapid
// trashes, a paste during a move, or undo mid-transfer never interleave on
// the same paths. The public methods stay fire-and-forget (void) for
// backwards compat but also return a Promise callers/tests can await. ---

type TrashOpName = "trash" | "restore" | "delete-forever" | "empty";

export type TrashOpsSink = {
  /** push a completed undo batch (already paired with redos) */
  pushUndoBatch(label: string, units: UndoUnit[], redos: UndoUnit[], data?: UndoJournalData): void;
  /** optional progress driver for the deletes (see OpProgress) */
  deleteProgress?: OpProgress;
  /** optional progress driver for the cross-device trash/restore copy */
  trashProgress?: OpProgress;
  /**
   * device split probe — tests inject a fake to force the cross-device path.
   * The default walks up to the nearest EXISTING ancestor of the destination
   * (the trash destination does not exist yet — it is created by the move).
   */
  crossDevice?(a: string, b: string): boolean;
  /** leveled toast notification (the status bar is selection info only) */
  notify(msg: string, title?: string, level?: NotifyLevel): void;
  /** schedule a grid refresh */
  renderAll(): void;
  /** debug event log — undo/redo closures fail silently otherwise */
  log?(msg: string): void;
  // plugin event fan-out: fires on every completion (op names are the stable
  // vocabulary — trash/restore/delete-forever/empty, never method names).
  // Never throws into the op.
  onEvent?(op: TrashOpName, paths: string[]): void;
  // terminal notification for a finished op (OSC 99 / OSC 777 / OSC 9 — the
  // renderer negotiates the protocol with the terminal). Optional: absent =
  // no notification. Only the irreversible deletes raise one, and only when
  // they took long enough that the user plausibly looked away.
  notifyTerminal?(message: string, title: string): void;
  // clock for the "was the user away?" gate (tests inject a fake clock)
  now?(): number;
  // sudo escalation seams (wiring injects the prompt-backed impl; tests fake).
  // Only the irreversible deletes escalate: trash/restore stay unprivileged
  // by design (a sudo-trashed file is root-owned in the user's trash, and the
  // undo closures have no privilege — the restore would fail with no undo).
  ensureSudo?: (opLabel: string) => Promise<boolean>;
  sudoExec?: (argv: string[]) => Promise<{ status: number | null; stderr: string }>;
  // trash FILES dirs to empty (tests inject fakes; default enumerates home +
  // every mounted $topdir/.Trash-$uid via /proc/mounts). Wiring passes nothing.
  trashFilesDirs?: () => string[];
};

// XDG trashinfo -> original absolute path. Spec says URL-encoded; nautilus
// writes bare encoded abs paths (and sometimes file:// URIs).
export const trashOrigPath = async (name: string): Promise<string | null> => {
  try {
    const raw = await readFile(path.join(trashDir(), "info", `${name}.trashinfo`), "utf8");
    return parseTrashOrig(raw);
  } catch {
    return null;
  }
};

// sibling-aware original-path lookup for per-mount trashes: <root>/files/<name>
// resolves via <root>/info/<name>.trashinfo. No home fallback when the sibling
// exists but is unreadable — a home entry with the same basename belongs to a
// different file, and restoring the per-mount file to the home file's Path=
// would misplace it. Home lookup serves bare names (backwards compat) only.
export const trashOrigPathForFile = async (trashFilePath: string): Promise<string | null> => {
  const sibling = trashInfoPathForTrashFile(trashFilePath);
  if (sibling) {
    try {
      return await readFile(sibling, "utf8").then(parseTrashOrig);
    } catch {
      return null;
    }
  }
  return trashOrigPath(path.basename(trashFilePath));
};

const parseTrashOrig = (raw: string): string | null => {
  const m = raw.match(/^Path=(.+)$/m);
  if (!m?.[1]) return null;
  let p = m[1].trim();
  if (p.startsWith("file://")) p = p.slice(7);
  try {
    p = decodeURIComponent(p);
  } catch {}
  return path.resolve(p);
};

export const makeTrashOps = (sink: TrashOpsSink) => {
  const queue = sharedOpQueue();
  const sudoExec = sink.sudoExec ?? defaultSudoExec;
  // the clock the "was the user away?" gate reads (tests inject a fake one)
  const now = sink.now ?? (() => Date.now());
  // one password gate per op (memoized per call below via needSudo closures)
  const sudoRm = (p: string): Promise<void> => runSudoTool(sudoExec, sudoRmArgv(p));
  const emit = (op: TrashOpName, paths: string[]): void => {
    try {
      sink.onEvent?.(op, [...paths]);
    } catch {}
  };
  // A LONG irreversible delete may have finished while the user was elsewhere:
  // the toast is on screen, but a desktop notification is what reaches them in
  // another window. A cancelled/failed delete NEVER notifies — that would
  // claim a done that isn't.
  const notifyDone = (summary: string, elapsedMs: number, cancelled: boolean, failed: number): void => {
    if (!shouldNotifyTerminal(elapsedMs, cancelled, failed)) return;
    try {
      sink.notifyTerminal?.(summary, "tfm");
    } catch {}
  };
  // plugin veto channel: a beforeFileOp hook can block trash/restore/delete
  const vetoedByPlugin = (op: TrashOpName, paths: string[]): boolean =>
    checkPluginVeto(sharedPluginHooks(), sink.notify, op, paths);

  // The cross-device copy: the trash root can live on another filesystem (a
  // USB stick's files fall back to the home trash when the per-mount trash
  // is not writable), and that copy used to run through node's `cp` — no bar,
  // no cancel, minutes of silence. Route it through the transfer engine
  // instead: the SAME progress toast the deletes use, with the same cancel.
  const isCrossDevice = (a: string, b: string): boolean => (sink.crossDevice ?? crossDeviceTo)(a, b);

  // full move for the trash: same-device → an instant rename; cross-device →
  // the progress-aware copy, and the source goes only AFTER the copy landed.
  const trashMove = async (src: string, dest: string): Promise<void> => {
    const dp = sink.trashProgress;
    if (!dp || !isCrossDevice(src, dest)) return fsMove(src, dest);
    // the pre-scan has no honest total yet — count in the open so a big tree
    // never looks dead
    const scan = await scanTree(src, (f) => dp.counting?.(f));
    dp.start(scan.files || 1, scan.bytes, "trashing");
    try {
      // the engine stages + lands atomically: a cancel leaves no half-written
      // trash entry behind, and the source is untouched
      await copyTreeProgress(src, dest, dp.sink);
    } catch (err) {
      dp.finish(dp.cancelled() ? "✗ Trash cancelled" : "✗ Trash failed");
      throw err;
    }
    // the copy landed — now drop the source (the move's mirror)
    await rm(src, { recursive: true, force: true });
    dp.finish("✓ Trashed");
  };

  // copy-only seam for safeRestoreMove (it removes the source itself):
  // absent without a driver → the default `cp` path, no bar.
  const restoreCopy = (verb: string): CrossDeviceCopy | undefined => {
    const dp = sink.trashProgress;
    if (!dp) return undefined;
    return async (src, dest) => {
      const scan = await scanTree(src, (f) => dp.counting?.(f));
      dp.start(scan.files || 1, scan.bytes, verb);
      try {
        await copyTreeProgress(src, dest, dp.sink);
      } catch (err) {
        dp.finish(dp.cancelled() ? "✗ Restore cancelled" : "✗ Restore failed");
        throw err;
      }
      dp.finish("✓ Restored");
    };
  };

  const trashPaths = (paths: string[]): Promise<void> => {
    // network shares have no usable trash: xdgTrashMove would write a LOCAL
    // .trashinfo pointing at a FUSE path that dies on unmount (unrestorable,
    // remote file gone) — refuse instead of pretending it worked
    if (paths.some(isNetworkPath)) {
      sink.notify("Can't trash on network", "trash", "error");
      return Promise.resolve();
    }
    // archive members are URIs inside a file, not fs paths — nothing to trash
    if (paths.some(isArchiveUri)) {
      sink.notify("Archive contents are read-only", "trash", "error");
      return Promise.resolve();
    }
    if (vetoedByPlugin("trash", paths)) return Promise.resolve();
    const run = queue.enqueue(async () => {
      const units: UndoUnit[] = [];
      const redos: UndoUnit[] = [];
      const dUnits: UndoStep[] = [];
      const dRedos: UndoStep[] = [];
      let ok = 0;
      let cancelled = false;
      const failWhy = new Set<string>();
      for (const p of paths) {
        // always trash via our own xdg path: we control the final name, so the
        // undo unit pairs deterministically (a before/after listing diff could
        // mis-pair when something else trashes a similar name concurrently)
        try {
          const loc = await xdgTrashMove(p, {
            move: trashMove,
            // a cancelled copy must not fall through to the next trash root
            isCancelled: () => sink.trashProgress?.cancelled() === true,
          });
          const hit = path.basename(loc);
          const from = path.join(path.dirname(loc), hit);
          units.push(async () => {
            // undo of a trash = move the file back to where it came from. A
            // trashed file from another device lives in the HOME trash, so
            // this restore crosses the boundary — that copy gets the bar too
            // (the plain `cp` fallback showed nothing for minutes).
            await safeRestoreMove(from, p, {
              copy: restoreCopy("restoring"),
              crossDevice: isCrossDevice(from, p),
            });
            await rmTrashInfoForPath(from, sink.log?.bind(sink));
          });
          dUnits.push({ op: "restore-move", from, to: p });
          dUnits.push({ op: "rm-trashinfo", name: hit, path: from });
          redos.push(async () => {
            try {
              if (existsSync(p)) await xdgTrashMove(p);
            } catch (err) {
              sink.log?.(`redo trash ${p}: ${fsErrText(err)}`);
            }
          });
          dRedos.push({ op: "trash-if-exists", path: p });
          ok++;
        } catch (err) {
          // the toast's ✕ during a cross-device copy: the source survived and
          // nothing landed — say "cancelled", not "FAILED"
          if (sink.trashProgress?.cancelled()) {
            cancelled = true;
            break;
          }
          failWhy.add(fsErrText(err));
        }
      }
      if (units.length)
        sink.pushUndoBatch(`trash ${ok} item${ok === 1 ? "" : "s"}`, units, redos, { units: dUnits, redos: dRedos });
      sink.renderAll();
      const failed = paths.length - ok;
      // full success omits the total (it equals ok); partial failures read
      // "ok of N"
      const summary = cancelled
        ? `Trash cancelled · ${ok} of ${paths.length} moved`
        : failed
          ? `Trashed ${ok} of ${paths.length} · ${failSuffix(failed, failWhy)}`
          : `Trashed ${ok} item${ok === 1 ? "" : "s"}`;
      sink.trashProgress?.finish(cancelled ? "✗ Trash cancelled" : failed ? "✗ Trash failed" : `✓ Trashed ${ok}`);
      if (cancelled) sink.notify(summary, "trash cancelled", "info");
      else if (failed > 0) sink.notify(summary, "trash failed", "error");
      else sink.notify(summary, "trash", "success");
      emit("trash", paths);
    });
    // fire-and-forget safe: outcomes are reported via sink, never thrown —
    // return the guarded promise (not the raw one) so `void` callers can
    // never observe an unhandled rejection either
    return run.catch(() => {});
  };

  const restoreFromTrash = (paths: string[]): Promise<void> => {
    if (vetoedByPlugin("restore", paths)) return Promise.resolve();
    const run = queue.enqueue(async () => {
      const units: UndoUnit[] = [];
      const redos: UndoUnit[] = [];
      // journal: undos only. The redo needs a runtime trash location (re-trash
      // then re-resolve), which step data can't express — same precedent as
      // replace-stash batches, which also ship without redos.
      const dUnits: UndoStep[] = [];
      const dRedos: UndoStep[] = [];
      let ok = 0;
      let cancelled = false;
      const failWhy = new Set<string>();
      for (const src of paths) {
        const orig = await trashOrigPathForFile(src);
        if (!orig) {
          failWhy.add("no trashinfo");
          continue;
        }
        try {
          // safeRestoreMove owns the occupied-target bump (never clobbers)
          // and returns the final dest for the journal + cleanup below.
          // The copy seam runs when the restore crosses a filesystem boundary
          // (a USB stick trashed into the home trash) — that copy used to run
          // through `cp` with no bar and no cancel.
          const restoredDest = await safeRestoreMove(src, orig, {
            copy: restoreCopy("restoring"),
            crossDevice: isCrossDevice(src, orig),
          });
          await rmTrashInfoForPath(src, sink.log?.bind(sink));
          // undo = send it back to trash (same-file only: a stranger
          // reoccupying the restored path is skipped, never trashed);
          // redo = restore again (trashinfo still resolves via Path= after
          // the undo re-trash)
          const rid = fileIdOf(restoredDest);
          units.push(async () => {
            try {
              await trashIfSameFile(restoredDest, rid, sink.log?.bind(sink));
            } catch (err) {
              sink.log?.(`undo restore ${restoredDest}: ${fsErrText(err)}`);
              throw err;
            }
          });
          dUnits.push({ op: "trash", path: restoredDest, ...(rid ?? {}) });
          redos.push(async () => {
            try {
              const loc = await xdgTrashMove(restoredDest).catch(() => null);
              if (loc) {
                const back = await trashOrigPathForFile(loc);
                await safeRestoreMove(loc, back ?? restoredDest, {
                  copy: restoreCopy("restoring"),
                  crossDevice: isCrossDevice(loc, back ?? restoredDest),
                });
                await rmTrashInfoForPath(loc, sink.log?.bind(sink));
              }
            } catch (err) {
              sink.log?.(`redo restore ${restoredDest}: ${fsErrText(err)}`);
            }
          });
          ok++;
        } catch (err) {
          // the toast's ✕ during a cross-device restore: nothing landed and
          // the trash copy is intact — say "cancelled", not "FAILED"
          if (sink.trashProgress?.cancelled()) {
            cancelled = true;
            break;
          }
          failWhy.add(fsErrText(err));
        }
      }
      if (units.length)
        sink.pushUndoBatch(`restore ${ok} item${ok === 1 ? "" : "s"}`, units, redos, {
          units: dUnits,
          redos: dRedos,
        });
      sink.renderAll();
      const failed = paths.length - ok;
      const base = cancelled
        ? `Restore cancelled · ${ok} of ${paths.length} restored`
        : failed
          ? `Restored ${ok} of ${paths.length} · ${failSuffix(failed, failWhy)}`
          : `Restored ${ok} item${ok === 1 ? "" : "s"}`;
      sink.trashProgress?.finish(cancelled ? "✗ Restore cancelled" : failed ? "✗ Restore failed" : `✓ Restored ${ok}`);
      if (cancelled) sink.notify(base, "restore cancelled", "info");
      else if (failed) sink.notify(base, "restore failed", "error");
      else sink.notify(base, "restore", "success");
      emit("restore", paths);
    });
    return run.catch(() => {});
  };

  // shared delete core (deleteForever + emptyTrash): pre-scan for honest
  // toast totals, then the per-item loop — cancel checks (including the
  // post-gate re-check: ✕ during the password prompt must abort, not exec),
  // one password gate per batch, sudo rm -rf with the same trashinfo
  // accounting. Irreversible by design — no undo batch either way.
  const scanTotals = async (items: string[], dp: NonNullable<TrashOpsSink["deleteProgress"]>): Promise<void> => {
    let files = 0;
    let bytes = 0;
    for (const p of items) {
      // ✕ during a long pre-scan must stop the scan, not just the later loop
      if (dp.cancelled()) break;
      const base = files;
      try {
        const r = await scanTree(p, (f) => {
          if (dp.cancelled()) throw new Error("cancelled");
          dp.counting?.(base + f);
        });
        files += r.files;
        bytes += r.bytes;
      } catch {
        if (dp.cancelled()) break;
      }
    }
    dp.start(files || Math.max(1, items.length), bytes);
  };
  const rmMany = async (
    items: string[],
    dp: TrashOpsSink["deleteProgress"],
    sudoLabel: string,
  ): Promise<{ ok: number; cancelled: boolean; failWhy: Set<string> }> => {
    let ok = 0;
    let cancelled = false;
    const failWhy = new Set<string>();
    let sudoOk: boolean | null = null;
    try {
      for (const p of items) {
        if (dp?.cancelled()) {
          cancelled = true;
          break;
        }
        try {
          if (dp) await rmTreeProgress(p, dp.sink);
          else await rm(p, { recursive: true });
          await rmTrashInfoForPath(p, sink.log?.bind(sink));
          ok++;
        } catch (err) {
          // cancel raced the last file: the checkpoint threw, not the fs
          if (dp?.cancelled()) {
            cancelled = true;
            break;
          }
          // privilege failure → password gate once, then sudo rm -rf
          // (irreversible op: no undo batch to keep privilege-consistent).
          // Re-check cancel after the gate: ✕ during the password prompt
          // must abort, not exec.
          let failure: unknown = err;
          if (isPrivilegeError(err)) {
            if (sudoOk === null) sudoOk = sink.ensureSudo ? await sink.ensureSudo(sudoLabel) : false;
            if (dp?.cancelled()) {
              cancelled = true;
              break;
            }
            if (sudoOk) {
              try {
                await sudoRm(p);
                await rmTrashInfoForPath(p, sink.log?.bind(sink));
                ok++;
                continue;
              } catch (sudoErr) {
                failure = sudoErr;
              }
            }
          }
          failWhy.add(fsErrText(failure));
        }
      }
    } finally {
      dp?.stop();
    }
    return { ok, cancelled, failWhy };
  };

  const deleteForever = (paths: string[]): Promise<void> => {
    if (vetoedByPlugin("delete-forever", paths)) return Promise.resolve();
    const run = queue.enqueue(async () => {
      const startedAt = now();
      const dp = sink.deleteProgress;
      // pre-scan so the toast has honest totals; a vanished path scans as 0
      if (dp) await scanTotals(paths, dp);
      const { ok, cancelled, failWhy } = await rmMany(paths, dp, `delete ${paths.length} items`);
      sink.renderAll();
      const failed = paths.length - ok;
      // irreversible by design — no undo batch; say so explicitly
      const summary = cancelled
        ? `Delete cancelled · ${ok} of ${paths.length} removed`
        : failed
          ? `Deleted ${ok} of ${paths.length} · ${failSuffix(failed, failWhy)}`
          : `Deleted ${ok} item${ok === 1 ? "" : "s"} · cannot be undone`;
      if (dp) dp.finish(cancelled ? "✗ Delete cancelled" : failed ? "✗ Delete failed" : `✓ Deleted ${ok}`);
      if (cancelled) sink.notify(summary, "delete cancelled", "info");
      else if (failed > 0) sink.notify(summary, "delete failed", "error");
      else sink.notify(summary, "delete", "success");
      notifyDone(summary, now() - startedAt, cancelled, failed);
      emit("delete-forever", paths);
    });
    return run.catch(() => {});
  };

  const emptyTrash = (): Promise<void> => {
    if (vetoedByPlugin("empty", [])) return Promise.resolve();
    const run = queue.enqueue(async () => {
      const startedAt = now();
      const homeFiles = path.join(trashDir(), "files");
      let names: string[];
      try {
        names = await readdir(homeFiles);
      } catch (err) {
        const reason = fsErrText(err);
        sink.renderAll();
        sink.notify(`Couldn't read trash · ${reason}`, "empty failed", "error");
        emit("empty", []);
        return;
      }
      const items = names.map((k) => path.join(homeFiles, k));
      // per-mount trashes ($topdir/.Trash-$uid) accumulate entries with no
      // other UI path to empty them — include every mounted one. Extra roots
      // read best-effort (a device yanked mid-empty just yields per-item
      // failures below); home stays the source of truth above.
      const dirs = sink.trashFilesDirs ? sink.trashFilesDirs() : allTrashFilesDirs();
      for (const dir of new Set(
        dirs.map((d) => {
          try {
            return path.resolve(d);
          } catch {
            return d;
          }
        }),
      )) {
        try {
          if (path.resolve(dir) === path.resolve(homeFiles)) continue;
        } catch {
          continue;
        }
        try {
          for (const k of await readdir(dir)) items.push(path.join(dir, k));
        } catch {
          // unreadable extra root — skip it, home items still empty
        }
      }
      const total = items.length;
      const dp = sink.deleteProgress;
      if (dp) await scanTotals(items, dp);
      const { ok: n, cancelled, failWhy } = await rmMany(items, dp, "empty trash");
      sink.renderAll();
      const failed = total - n;
      if (cancelled) {
        const summary = `Empty cancelled · ${n} of ${total} removed`;
        sink.notify(summary, "empty cancelled", "info");
        dp?.finish("✗ Delete cancelled");
        return;
      }
      if (failed > 0) {
        dp?.finish("✗ Delete failed");
        sink.notify(`Emptied ${n} of ${total} · ${failSuffix(failed, failWhy)}`, "empty failed", "error");
        return;
      }
      dp?.finish(`✓ Emptied ${n}`);
      // irreversible by design — no undo batch; say so explicitly.
      const summary = `Emptied ${n} item${n === 1 ? "" : "s"} · cannot be undone`;
      sink.notify(summary, "empty", "success");
      notifyDone(summary, now() - startedAt, cancelled, failed);
      emit("empty", []);
    });
    // fire-and-forget safe: outcomes are reported via sink, never thrown
    return run.catch(() => {});
  };

  return { trashPaths, restoreFromTrash, deleteForever, emptyTrash };
};

// --- Trash-bound Yes/No wrappers: label + verb bindings onto the floating
// confirm dialog (both are destructive → danger styling). Extracted so the
// exact prompts are testable without a renderer. ---
type TrashConfirmsCtx = {
  confirm(message: string, yesLabel: string, onYes: () => void, danger?: boolean): void;
  emptyTrash(): void;
  deleteForever(paths: string[]): void;
};

export const makeTrashConfirms = (ctx: TrashConfirmsCtx) => {
  const confirmEmptyTrash = (): void => {
    // count is best-effort (home trash only; -1 when unreadable) — the prompt
    // names the count when known so "empty everything" isn't a blind click
    const n = countTrashItems();
    const what = n >= 0 ? `Empty Trash (${n} item${n === 1 ? "" : "s"})?` : "Empty Trash?";
    ctx.confirm(`${what} This cannot be undone.`, "Empty Trash", () => ctx.emptyTrash(), true);
  };

  const confirmDeleteForever = (paths: string[]): void => {
    ctx.confirm(
      `Permanently delete ${paths.length} item${paths.length === 1 ? "" : "s"}? This cannot be undone.`,
      "Delete permanently",
      () => ctx.deleteForever(paths),
      true,
    );
  };

  return { confirmEmptyTrash, confirmDeleteForever };
};
