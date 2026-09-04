// --- Live directory watching: external changes refresh the grid. Owns the
// FSWatcher lifecycle for the active cwd; the app-facing surface is
// syncCwdWatcher(), called from renderAll so the watched dir always matches
// state.cwd. Renderer-free — cwd/renaming/renderGrid arrive as getters.
//
// Limits (documented, not hidden): single non-recursive node:fs.watch on cwd
// only — rapid external changes during a long transfer surface on the next
// renderAll/sync. Errors are logged via the injected log (default silent for
// backwards compat) instead of being swallowed invisibly. ---

import { watch } from "node:fs";
import path from "node:path";
import { debounced } from "../lib/uiutil";

export type CwdWatcherCtx = {
  cwd: () => string;
  isVirtualCwd: () => boolean;
  // our own create+inline-edit would wipe the editor mid-keystroke
  isRenaming: () => boolean;
  renderGrid: () => void | Promise<void>;
  log?: (msg: string) => void;
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
    if (watcher) {
      try {
        watcher.close();
      } catch (err) {
        ctx.log?.(`watcher close failed: ${err}`);
      }
      watcher = null;
    }
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
      watcher.on("error", (err) => {
        // ENOENT = dir deleted/moved from under us — drop the watcher so the
        // next sync re-establishes it; anything else gets logged, never thrown
        const code =
          typeof err === "object" && err !== null && "code" in err ? String((err as { code: unknown }).code) : "";
        ctx.log?.(`watcher error on ${dir}: ${err}`);
        if (code === "ENOENT") {
          closeWatcher();
          watchedDir = null;
        }
      });
    } catch (err) {
      // dir vanished between resolve and watch — retry on the next sync
      ctx.log?.(`watcher failed on ${dir}: ${err}`);
      watchedDir = null;
    }
  };

  return { syncCwdWatcher, closeWatcher };
};
