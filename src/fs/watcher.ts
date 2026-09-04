// --- Live directory watching: external changes refresh the grid. Owns the
// FSWatcher lifecycle for the active cwd; the app-facing surface is
// syncCwdWatcher(), called from renderAll so the watched dir always matches
// state.cwd. Renderer-free — cwd/renaming/renderGrid arrive as getters. ---

import { watch } from "node:fs";
import path from "node:path";
import { debounced } from "../ui/uiutil";

export type CwdWatcherCtx = {
  cwd: () => string;
  isVirtualCwd: () => boolean;
  // our own create+inline-edit would wipe the editor mid-keystroke
  isRenaming: () => boolean;
  renderGrid: () => void | Promise<void>;
  // injectable for tests; defaults to node:fs watch. Returns a handle with
  // an "error" subscription and close() — the structural surface used here.
  watchImpl?: (dir: string, cb: () => void) => { on(ev: string, cb: (e: unknown) => void): unknown; close(): void };
};

export const makeCwdWatcher = (ctx: CwdWatcherCtx) => {
  let watcher: ReturnType<typeof watch> | null = null;
  let watchedDir: string | null = null;
  let watchErrored = false;
  const doWatch = ctx.watchImpl ?? ((dir: string, cb: () => void) => watch(dir, cb));

  // fs events burst in clusters; coalesce them into one grid rebuild
  const onCwdChanged = debounced(200, () => {
    if (ctx.isRenaming()) return;
    if (path.resolve(ctx.cwd()) === watchedDir) void ctx.renderGrid();
  });

  const closeWatcher = (): void => {
    if (watcher) {
      try {
        watcher.close();
      } catch {}
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
      watcher = doWatch(dir, onCwdChanged) as ReturnType<typeof watch>;
      watcher.on("error", () => {
        // never swallow silently: mark dead so the next sync re-arms
        watchErrored = true;
      });
    } catch {}
  };

  return { syncCwdWatcher };
};
