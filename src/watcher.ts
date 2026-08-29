// --- Live directory watching: external changes refresh the grid. Owns the
// FSWatcher lifecycle for the active cwd; the app-facing surface is
// syncCwdWatcher(), called from renderAll so the watched dir always matches
// state.cwd. Renderer-free — cwd/renaming/renderGrid arrive as getters. ---

import { watch } from "node:fs";
import path from "node:path";
import { debounced } from "./uiutil";

export type CwdWatcherCtx = {
  cwd: () => string;
  isVirtualCwd: () => boolean;
  // our own create+inline-edit would wipe the editor mid-keystroke
  isRenaming: () => boolean;
  renderGrid: () => void | Promise<void>;
};

export const makeCwdWatcher = (ctx: CwdWatcherCtx) => {
  let watcher: ReturnType<typeof watch> | null = null;
  let watchedDir: string | null = null;

  // fs events burst in clusters; coalesce them into one grid rebuild
  const onCwdChanged = debounced(200, () => {
    if (ctx.isRenaming()) return;
    if (path.resolve(ctx.cwd()) === watchedDir) void ctx.renderGrid();
  });

  const closeWatcher = (): void => {
    if (watcher) { try { watcher.close(); } catch {} watcher = null; }
  };

  const syncCwdWatcher = (): void => {
    if (ctx.isVirtualCwd()) {
      closeWatcher();
      watchedDir = null;
      return;
    }
    const dir = path.resolve(ctx.cwd());
    if (watchedDir === dir) return;
    watchedDir = dir;
    closeWatcher();
    try {
      watcher = watch(dir, onCwdChanged);
      watcher.on("error", () => {});
    } catch {}
  };

  return { syncCwdWatcher };
};
