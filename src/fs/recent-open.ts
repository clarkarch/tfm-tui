// --- Default-open pipeline: spawn xdg-open, record the path in the
// freedesktop recent list, toast what launched. Opens are batched + deduped
// into one xbel rewrite (opening a selection of N files fires N times).
// Pure orchestration — the xbel write, the spawn and the app probe arrive
// via ctx. ---

import path from "node:path";
import { accessSync, constants } from "node:fs";
import { debounced } from "../lib/uiutil";
import type { NotifyLevel } from "../lib/notify-level";

type RecentOpenCtx = {
  inTrashView: () => boolean;
  notify: (msg: string, title?: string, level?: NotifyLevel) => void;
  upsertRecent: (paths: string[]) => void | Promise<void>;
  spawnOpen: (p: string) => void;
  appForFile: (p: string) => Promise<string | null>;
  // readability pre-check (tests fake it; default = R_OK probe). Unreadable
  // files escalate through openAsRoot instead of erroring — the open is
  // adaptive, there is no separate elevated row.
  canRead?: (p: string) => boolean;
  // escalation primitive (never rejects; gate-cancel stays silent, failures
  // toast inside). Elevated opens are not recorded to recent.
  openAsRoot: (p: string) => Promise<void>;
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
    const canRead =
      ctx.canRead ??
      ((q: string): boolean => {
        try {
          accessSync(q, constants.R_OK);
          return true;
        } catch {
          return false;
        }
      });
    if (!canRead(p)) {
      void ctx.openAsRoot(p);
      return;
    }
    recordOpen(p);
    ctx.spawnOpen(p);
    // resolve what xdg-open will pick so the toast can say what launched
    void (async () => {
      const base = path.basename(p);
      const app = await ctx.appForFile(p);
      ctx.notify(`Opening ${base}${app ? ` · ${app}` : ""}`, "open", "info");
    })();
  };

  return { recordOpen, openFileDefault };
};
