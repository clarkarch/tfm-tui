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

// ONE record for the watch lifecycle. The three facts used to live in three
// variables (watcher / watchedDir / watchErrored) and the re-arm guard was
// their conjunction — adding a fourth fact silently broke the conjunction and
// the grid went PERMANENTLY STALE (the exact failure the old comment warned
// about). The record names the states instead:
//   "none"     — no dir recorded, no watcher
//   "watching" — a live watcher on `dir`
//   "dead"     — `dir` is recorded but NO live watcher covers it (the arm is
//                still in flight, the arm failed, or the kernel watch died):
//                the next sync RE-ARMS it
type WatchState =
  | { kind: "none" }
  | { kind: "watching"; dir: string; watcher: ReturnType<typeof watch> }
  | { kind: "dead"; dir: string; watcher: ReturnType<typeof watch> | null };

export const makeCwdWatcher = (ctx: CwdWatcherCtx) => {
  let state: WatchState = { kind: "none" };
  const doWatch =
    ctx.watchImpl ?? ((dir: string, cb: (filename?: string | null) => void) => watch(dir, (_ev, fname) => cb(fname)));

  // the dir the watcher is bound to (null when there is none) — the ignored
  // paths are resolved against it
  const watchedDir = (): string | null => (state.kind === "none" ? null : state.dir);

  // fs events burst in clusters; coalesce them into one grid rebuild
  const onCwdChanged = debounced(
    200,
    () => {
      if (ctx.isRenaming()) return;
      if (path.resolve(ctx.cwd()) === watchedDir()) void ctx.renderGrid();
    },
    ctx.sched ?? globalThis,
  );

  const isIgnoredEvent = (filename?: string | null): boolean => {
    const dir = watchedDir();
    if (!filename || !dir || !ctx.ignorePaths) return false;
    // node reports a dir-relative name; be lenient if an impl sends absolute
    const abs = path.isAbsolute(filename) ? path.normalize(filename) : path.join(dir, filename);
    return ctx.ignorePaths().some((p) => path.resolve(p) === abs);
  };

  const onFsEvent = (filename?: string | null): void => {
    if (isIgnoredEvent(filename)) return;
    onCwdChanged();
  };

  const closeWatcher = (): void => {
    if (state.kind === "none") return;
    if (state.watcher) {
      try {
        state.watcher.close();
      } catch (err) {
        ctx.log?.(`watcher close failed: ${err}`);
      }
    }
    state = { kind: "none" };
  };

  const syncCwdWatcher = (): void => {
    if (ctx.isVirtualCwd()) {
      closeWatcher();
      return;
    }
    const dir = path.resolve(ctx.cwd());
    // recorded == alive is NOT an invariant: a watch() throw or a kernel
    // error event (dir replaced under us) leaves the recorded dir with a
    // DEAD watcher. The state says so, and the next sync re-arms — the grid
    // otherwise goes permanently stale with no signal.
    if (state.kind === "watching" && state.dir === dir) return;
    closeWatcher();
    // the dir is recorded BEFORE the watch call: an event that arrives while
    // the watch is being armed (or a pending rebuild that fires in that
    // window) still resolves against the dir we are watching
    state = { kind: "dead", dir, watcher: null };
    try {
      const watcher = doWatch(dir, onFsEvent) as ReturnType<typeof watch>;
      state = { kind: "watching", dir, watcher };
      watcher.on("error", (err) => {
        // never swallow silently: mark dead so the next sync re-arms (ANY
        // error — ENOENT or otherwise — means the kernel watch is gone).
        // A LATE error from a watcher we already REPLACED belongs to the old
        // one — it must not mark the live watch dead.
        if (state.kind === "watching" && state.watcher === watcher) state = { kind: "dead", dir, watcher };
        ctx.log?.(`watcher error on ${dir}: ${err}`);
      });
    } catch (err) {
      // dir vanished between resolve and watch — retried on the next sync
      state = { kind: "dead", dir, watcher: null };
      ctx.log?.(`watcher failed on ${dir}: ${err}`);
    }
  };

  return { syncCwdWatcher, closeWatcher };
};
