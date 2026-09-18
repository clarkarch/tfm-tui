import { existsSync } from "node:fs";
import { readdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { failSuffix, countTrashItems, fsErrText, rmTrashInfo, trashDir, xdgTrashMove, safeRestoreMove } from "./fsutil";
import { isPrivilegeError, sudoRmArgv, sudoExecError, runSudo } from "./elevate";
import { rmTreeProgress, scanTree, type TransferSink } from "./transfer";
import { sharedOpQueue } from "../lib/op-queue";
import { sharedPluginHooks } from "../lib/plugin-hooks";
import type { NotifyLevel } from "../lib/notify-level";
import { isNetworkPath } from "./network";
import type { UndoJournalData, UndoStep, UndoUnit } from "../app/undo";

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

// delete-progress driver (optional; the wiring supplies the prog/toast glue,
// which lives in ui-progress). When present, deleteForever/emptyTrash pre-scan
// for totals and stream per-file checkpoints through `sink`, so the toast
// shows counts and cancel stops mid-tree. Absent = plain rm (headless callers).
export type DeleteProgress = {
  sink: TransferSink;
  /** reset counters, set totals, arm the toast when it's worth showing */
  start(totalFiles: number, totalBytes: number): void;
  cancelled(): boolean;
  /** swap the live toast for the final state (no-op when none showed) */
  finish(msg: string): void;
  /** clear the active flag */
  stop(): void;
};

export type TrashOpsSink = {
  /** push a completed undo batch (already paired with redos) */
  pushUndoBatch(label: string, units: UndoUnit[], redos: UndoUnit[], data?: UndoJournalData): void;
  /** optional delete-progress driver (see DeleteProgress) */
  deleteProgress?: DeleteProgress;
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
  // sudo escalation seams (wiring injects the prompt-backed impl; tests fake).
  // Only the irreversible deletes escalate: trash/restore stay unprivileged
  // by design (a sudo-trashed file is root-owned in the user's trash, and the
  // undo closures have no privilege — the restore would fail with no undo).
  ensureSudo?: (opLabel: string) => Promise<boolean>;
  sudoExec?: (argv: string[]) => Promise<{ status: number | null; stderr: string }>;
};

// XDG trashinfo -> original absolute path. Spec says URL-encoded; nautilus
// writes bare encoded abs paths (and sometimes file:// URIs).
export const trashOrigPath = async (name: string): Promise<string | null> => {
  try {
    const raw = await readFile(path.join(trashDir(), "info", `${name}.trashinfo`), "utf8");
    const m = raw.match(/^Path=(.+)$/m);
    if (!m?.[1]) return null;
    let p = m[1].trim();
    if (p.startsWith("file://")) p = p.slice(7);
    try {
      p = decodeURIComponent(p);
    } catch {}
    return path.resolve(p);
  } catch {
    return null;
  }
};

export const makeTrashOps = (sink: TrashOpsSink) => {
  const queue = sharedOpQueue();
  const sudoExec =
    sink.sudoExec ?? (async (argv) => runSudo(argv).then((r) => ({ status: r.status, stderr: r.stderr })));
  // one password gate per op (memoized per call below via needSudo closures)
  const sudoRm = async (p: string): Promise<void> => {
    const r = await sudoExec(sudoRmArgv(p));
    if (r.status !== 0) throw sudoExecError(r.stderr);
  };
  const emit = (op: TrashOpName, paths: string[]): void => {
    try {
      sink.onEvent?.(op, [...paths]);
    } catch {}
  };
  // plugin veto channel: a beforeFileOp hook can block trash/restore/delete
  const vetoedByPlugin = (op: TrashOpName, paths: string[]): boolean => {
    const veto = sharedPluginHooks().beforeFileOp({ op, paths });
    if (!veto) return false;
    const msg = `Blocked by plugin${veto.reason ? `: ${veto.reason}` : ""}`;
    sink.notify(msg, "blocked", "info");
    return true;
  };

  const trashPaths = (paths: string[]): Promise<void> => {
    // network shares have no usable trash: xdgTrashMove would write a LOCAL
    // .trashinfo pointing at a FUSE path that dies on unmount (unrestorable,
    // remote file gone) — refuse instead of pretending it worked
    if (paths.some(isNetworkPath)) {
      sink.notify("Trash isn't available on network locations", "trash", "error");
      return Promise.resolve();
    }
    if (vetoedByPlugin("trash", paths)) return Promise.resolve();
    const run = queue.enqueue(async () => {
      const units: UndoUnit[] = [];
      const redos: UndoUnit[] = [];
      const dUnits: UndoStep[] = [];
      const dRedos: UndoStep[] = [];
      let ok = 0;
      const failWhy = new Set<string>();
      for (const p of paths) {
        // always trash via our own xdg path: we control the final name, so the
        // undo unit pairs deterministically (a before/after listing diff could
        // mis-pair when something else trashes a similar name concurrently)
        try {
          const loc = await xdgTrashMove(p);
          const hit = path.basename(loc);
          const from = path.join(path.dirname(loc), hit);
          units.push(async () => {
            await safeRestoreMove(from, p);
            await rmTrashInfo(hit, sink.log?.bind(sink));
          });
          dUnits.push({ op: "restore-move", from, to: p });
          dUnits.push({ op: "rm-trashinfo", name: hit });
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
          failWhy.add(fsErrText(err));
        }
      }
      if (units.length)
        sink.pushUndoBatch(`trash ${ok} item${ok === 1 ? "" : "s"}`, units, redos, { units: dUnits, redos: dRedos });
      sink.renderAll();
      const failed = paths.length - ok;
      // full success omits the total (it equals ok); partial failures read
      // "ok of N". The undo hint shows whenever anything landed (ok > 0),
      // not just on clean sweeps.
      const summary = failed
        ? `Trashed ${ok} of ${paths.length} · ${failSuffix(failed, failWhy)}`
        : `Trashed ${ok} item${ok === 1 ? "" : "s"}`;
      const hinted = ok > 0 ? `${summary} · ctrl+z to undo` : summary;
      if (failed > 0) sink.notify(hinted, "trash failed", "error");
      else sink.notify(hinted, "trash", "success");
      emit("trash", paths);
    });
    // fire-and-forget safe: outcomes are reported via sink, never thrown
    run.catch(() => {});
    return run;
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
      const failWhy = new Set<string>();
      for (const src of paths) {
        const orig = await trashOrigPath(path.basename(src));
        if (!orig) {
          failWhy.add("no trashinfo");
          continue;
        }
        try {
          // safeRestoreMove owns the occupied-target bump (never clobbers)
          // and returns the final dest for the journal + cleanup below
          const restoredDest = await safeRestoreMove(src, orig);
          await rmTrashInfo(path.basename(src), sink.log?.bind(sink));
          // undo = send it back to trash; redo = restore again (trashinfo
          // still resolves via Path= after the undo re-trash)
          units.push(async () => {
            try {
              await xdgTrashMove(restoredDest);
            } catch (err) {
              sink.log?.(`undo restore ${restoredDest}: ${fsErrText(err)}`);
              throw err;
            }
          });
          dUnits.push({ op: "trash", path: restoredDest });
          redos.push(async () => {
            try {
              const loc = await xdgTrashMove(restoredDest).catch(() => null);
              if (loc) {
                const back = await trashOrigPath(path.basename(loc));
                await safeRestoreMove(loc, back ?? restoredDest);
                await rmTrashInfo(path.basename(loc));
              }
            } catch (err) {
              sink.log?.(`redo restore ${restoredDest}: ${fsErrText(err)}`);
            }
          });
          ok++;
        } catch (err) {
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
      const base = failed
        ? `Restored ${ok} of ${paths.length} · ${failSuffix(failed, failWhy)}`
        : `Restored ${ok} item${ok === 1 ? "" : "s"}`;
      const summary = !failed || ok > 0 ? `${base} · ctrl+z to undo` : base;
      sink.notify(summary, failed ? "restore failed" : "restore", failed ? "error" : "success");
      emit("restore", paths);
    });
    run.catch(() => {});
    return run;
  };

  const deleteForever = (paths: string[]): Promise<void> => {
    if (vetoedByPlugin("delete-forever", paths)) return Promise.resolve();
    const run = queue.enqueue(async () => {
      const dp = sink.deleteProgress;
      // pre-scan so the toast has honest totals; a vanished path scans as 0
      if (dp) {
        let files = 0;
        let bytes = 0;
        for (const p of paths) {
          try {
            const r = await scanTree(p);
            files += r.files;
            bytes += r.bytes;
          } catch {}
        }
        dp.start(files || Math.max(1, paths.length), bytes);
      }
      let ok = 0;
      let cancelled = false;
      const failWhy = new Set<string>();
      let sudoOk: boolean | null = null;
      try {
        for (const p of paths) {
          if (dp?.cancelled()) {
            cancelled = true;
            break;
          }
          try {
            if (dp) await rmTreeProgress(p, dp.sink);
            else await rm(p, { recursive: true });
            await rmTrashInfo(path.basename(p), sink.log?.bind(sink));
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
              if (sudoOk === null)
                sudoOk = sink.ensureSudo ? await sink.ensureSudo(`delete ${paths.length} items`) : false;
              if (dp?.cancelled()) {
                cancelled = true;
                break;
              }
              if (sudoOk) {
                try {
                  await sudoRm(p);
                  await rmTrashInfo(path.basename(p), sink.log?.bind(sink));
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
      emit("delete-forever", paths);
    });
    run.catch(() => {});
    return run;
  };

  const emptyTrash = (): Promise<void> => {
    if (vetoedByPlugin("empty", [])) return Promise.resolve();
    const run = queue.enqueue(async () => {
      const filesDir = path.join(trashDir(), "files");
      let names: string[];
      try {
        names = await readdir(filesDir);
      } catch (err) {
        const reason = fsErrText(err);
        sink.renderAll();
        sink.notify(`Could not read trash (${reason})`, "empty failed", "error");
        emit("empty", []);
        return;
      }
      const dp = sink.deleteProgress;
      if (dp) {
        let files = 0;
        let bytes = 0;
        for (const k of names) {
          try {
            const r = await scanTree(path.join(filesDir, k));
            files += r.files;
            bytes += r.bytes;
          } catch {}
        }
        dp.start(files || Math.max(1, names.length), bytes);
      }
      let n = 0;
      let cancelled = false;
      const failWhy = new Set<string>();
      let emptySudoOk: boolean | null = null;
      try {
        for (const k of names) {
          if (dp?.cancelled()) {
            cancelled = true;
            break;
          }
          try {
            if (dp) await rmTreeProgress(path.join(filesDir, k), dp.sink);
            else await rm(path.join(filesDir, k), { recursive: true });
            await rmTrashInfo(k, sink.log?.bind(sink));
            n++;
          } catch (err) {
            if (dp?.cancelled()) {
              cancelled = true;
              break;
            }
            let failure: unknown = err;
            if (isPrivilegeError(err)) {
              if (emptySudoOk === null) emptySudoOk = sink.ensureSudo ? await sink.ensureSudo("empty trash") : false;
              if (dp?.cancelled()) {
                cancelled = true;
                break;
              }
              if (emptySudoOk) {
                try {
                  await sudoRm(path.join(filesDir, k));
                  await rmTrashInfo(k, sink.log?.bind(sink));
                  n++;
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
      sink.renderAll();
      const failed = names.length - n;
      if (cancelled) {
        const summary = `Empty cancelled · ${n} of ${names.length} removed`;
        sink.notify(summary, "empty cancelled", "info");
        dp?.finish("✗ Delete cancelled");
        return;
      }
      if (failed > 0) {
        dp?.finish("✗ Delete failed");
        sink.notify(`Emptied ${n} of ${names.length} · ${failSuffix(failed, failWhy)}`, "empty failed", "error");
        return;
      }
      dp?.finish(`✓ Emptied ${n}`);
      // irreversible by design — no undo batch; say so explicitly.
      const summary = `Emptied ${n} item${n === 1 ? "" : "s"} · cannot be undone`;
      sink.notify(summary, "empty", "success");
      emit("empty", []);
    });
    run.catch(() => {});
    return run;
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
