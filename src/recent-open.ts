// --- Default-open pipeline: spawn xdg-open, record the path in the
// freedesktop recent list, toast what launched. Opens are batched + deduped
// into one xbel rewrite (opening a selection of N files fires N times).
// Pure orchestration — the xbel write, the spawn and the app probe arrive
// via ctx. ---

import path from "node:path";
import { debounced } from "./uiutil";

export type RecentOpenCtx = {
  inTrashView: () => boolean;
  notify: (msg: string, title?: string) => void;
  upsertRecent: (paths: string[]) => void | Promise<void>;
  spawnOpen: (p: string) => void;
  appForFile: (p: string) => Promise<string | null>;
};

export const makeRecentOpen = (ctx: RecentOpenCtx) => {
  let pending: string[] = [];

  const flushRecordOpen = debounced(150, () => {
    const paths = [...new Set(pending)];
    pending = [];
    void ctx.upsertRecent(paths);
  });

  const recordOpen = (p: string): void => {
    if (ctx.inTrashView()) return;
    pending.push(p);
    flushRecordOpen();
  };

  const openFileDefault = (p: string): void => {
    recordOpen(p);
    ctx.spawnOpen(p);
    // resolve what xdg-open will pick so the toast can say what launched
    void (async () => {
      const base = path.basename(p);
      const app = await ctx.appForFile(p);
      ctx.notify(`Opening ${base}${app ? ` · ${app}` : ""}`, "open");
    })();
  };

  return { recordOpen, openFileDefault };
};
