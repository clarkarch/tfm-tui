// --- Default-open pipeline: spawn xdg-open, record the path in the
// freedesktop recent list, toast what launched. Opens are batched + deduped
// into one xbel rewrite (opening a selection of N files fires N times).
// Pure orchestration — the xbel write, the spawn and the app probe arrive
// via ctx. ---

import path from "node:path";
import { existsSync } from "node:fs";
import { debounced } from "../lib/uiutil";
import { canReadSync } from "./fsutil";
import type { NotifyLevel } from "../lib/notify-level";

type RecentOpenCtx = {
  inTrashView: () => boolean;
  notify: (msg: string, title?: string, level?: NotifyLevel) => void;
  upsertRecent: (paths: string[]) => void | Promise<void>;
  // onFailed fires when the spawn itself fails (missing binary etc.) so the
  // optimistic Opening toast below can stand down — a failure toast already
  // went out. (Success-first ordering can still double-toast: the spawn is
  // fire-and-forget by design, so a late failure reads as a correction.)
  spawnOpen: (p: string, onFailed: () => void) => void;
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
    const canRead = ctx.canRead ?? canReadSync;
    // canRead is false for ENOENT too — a file deleted between listing and
    // open (or a dangling symlink, which accessSync follows) takes the plain
    // path: the spawn fails with an honest error instead of popping a sudo
    // prompt for something that isn't there.
    if (!canRead(p) && existsSync(p)) {
      void ctx.openAsRoot(p).catch(() => {});
      return;
    }
    recordOpen(p);
    let failed = false;
    ctx.spawnOpen(p, () => {
      failed = true;
    });
    // resolve what xdg-open will pick so the toast can say what launched
    void (async () => {
      const base = path.basename(p);
      const app = await ctx.appForFile(p);
      if (!failed) ctx.notify(`Opening ${base}${app ? ` · ${app}` : ""}`, "open", "info");
    })();
  };

  return { recordOpen, openFileDefault };
};
