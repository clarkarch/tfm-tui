// --- Live directory watching: external changes refresh the grid. Owns the
// FSWatcher lifecycle for the active cwd; the app-facing surface is
// syncCwdWatcher(), called from renderAll so the watched dir always matches
// state.cwd. Renderer-free — cwd/renaming/renderGrid arrive as getters.
//
// Limits (documented, not hidden): single non-recursive node:fs.watch on cwd
// only — rapid external changes during a long transfer surface on the next
// renderAll/sync. Errors are logged via the injected log (default silent for
// backwards compat) instead of being swallowed invisibly. Events for the
// app's own sink files (dnd/debug logs, see ignorePaths) never schedule a
// rebuild — otherwise browsing /tmp rebuilds the grid after every click. ---

import { watch } from "node:fs";
import path from "node:path";
import { debounced, type Scheduler } from "../lib/uiutil";

type CwdWatcherCtx = {
  cwd: () => string;
  isVirtualCwd: () => boolean;
  // our own create+inline-edit would wipe the editor mid-keystroke
  isRenaming: () => boolean;
  renderGrid: () => void | Promise<void>;
  // self-written sink files (DND_LOG/DEBUG_LOG) that may live inside the
  // watched dir: their events are our own noise, never an external change
  ignorePaths?: () => string[];
  // injectable for tests; defaults to node:fs watch. Returns a handle with
  // an "error" subscription and close() — the structural surface used here.
  // The callback receives the event's filename (null on platforms that
  // don't report one — then we can't filter and refresh as before).
  watchImpl?: (
    dir: string,
    cb: (filename?: string | null) => void,
  ) => { on(ev: string, cb: (e: unknown) => void): unknown; close(): void };
  // injectable clock for the coalesce debounce (tests use a virtual one)
  sched?: Scheduler;
  // errors are surfaced (default silent for backwards compat), never swallowed
  log?: (msg: string) => void;
};

export const makeCwdWatcher = (ctx: CwdWatcherCtx) => {
  let watcher: ReturnType<typeof watch> | null = null;
  let watchedDir: string | null = null;
  let watchErrored = false;
  const doWatch =
    ctx.watchImpl ?? ((dir: string, cb: (filename?: string | null) => void) => watch(dir, (_ev, fname) => cb(fname)));

  // fs events burst in clusters; coalesce them into one grid rebuild
  const onCwdChanged = debounced(
    200,
    () => {
      if (ctx.isRenaming()) return;
      if (path.resolve(ctx.cwd()) === watchedDir) void ctx.renderGrid();
    },
    ctx.sched ?? globalThis,
  );

  const isIgnoredEvent = (filename?: string | null): boolean => {
    if (!filename || !watchedDir || !ctx.ignorePaths) return false;
    // node reports a dir-relative name; be lenient if an impl sends absolute
    const abs = path.isAbsolute(filename) ? path.normalize(filename) : path.join(watchedDir, filename);
    return ctx.ignorePaths().some((p) => path.resolve(p) === abs);
  };

  const onFsEvent = (filename?: string | null): void => {
    if (isIgnoredEvent(filename)) return;
    onCwdChanged();
  };

  const closeWatcher = (): void => {
    if (watcher) {
      try {
        watcher.close();
      } catch (err) {
        ctx.log?.(`watcher close failed: ${err}`);
      }
      watcher = null;
    }
    watchErrored = false;
  };

  const syncCwdWatcher = (): void => {
    if (ctx.isVirtualCwd()) {
      closeWatcher();
      watchedDir = null;
      return;
    }
    const dir = path.resolve(ctx.cwd());
    // recorded == alive is NOT an invariant: a watch() throw or a kernel
    // error event (dir replaced under us) leaves the recorded dir with a
    // DEAD watcher. Track both conditions and re-arm — the grid otherwise
    // goes permanently stale with no signal.
    if (watchedDir === dir && !watchErrored && watcher) return;
    watchedDir = dir;
    closeWatcher();
    try {
      watcher = doWatch(dir, onFsEvent) as ReturnType<typeof watch>;
      watcher.on("error", (err) => {
        // never swallow silently: mark dead so the next sync re-arms (ANY
        // error — ENOENT or otherwise — means the kernel watch is gone)
        watchErrored = true;
        ctx.log?.(`watcher error on ${dir}: ${err}`);
      });
    } catch (err) {
      // dir vanished between resolve and watch — retried on the next sync
      watchErrored = true;
      ctx.log?.(`watcher failed on ${dir}: ${err}`);
    }
  };

  return { syncCwdWatcher };
};
