// --- Default-open pipeline: spawn xdg-open, record the path in the
// freedesktop recent list, toast what launched. Opens are batched + deduped
// into one xbel rewrite (opening a selection of N files fires N times).
// Pure orchestration — the xbel write, the spawn and the app probe arrive
// via ctx. ---

import path from "node:path";
import { existsSync } from "node:fs";
import { debounced } from "../lib/uiutil";
import { canReadSync } from "./fsutil";
import { isArchiveUri } from "./uri";
import { classifyPath, type ExecutableInfo } from "./executable";
import type { SpawnOutcome } from "./spawn-safe";
import type { NotifyLevel } from "../lib/notify-level";

// The open's OUTCOME — settled ONCE. The old shape carried the spawn's fate
// in a callback that wrote a boolean, and the toast's writer raced that
// boolean against the app probe: a failure landing AFTER the probe answered
// produced BOTH the optimistic "Opening …" toast and the failure toast. A
// promise settles once, so the seam cannot deliver two answers, and the
// toast is decided by the outcome alone.
type RecentOpenCtx = {
  inTrashView: () => boolean;
  notify: (msg: string, title?: string, level?: NotifyLevel) => void;
  upsertRecent: (paths: string[]) => void | Promise<void>;
  // the spawn's fate: the spawn either started (ok) or failed with a reason.
  // It settles ONCE — the caller decides the toast from it.
  spawnOpen: (p: string) => Promise<SpawnOutcome>;
  appForFile: (p: string) => Promise<string | null>;
  // readability pre-check (tests fake it; default = R_OK probe). Unreadable
  // files escalate through openAsRoot instead of erroring — the open is
  // adaptive, there is no separate elevated row.
  canRead?: (p: string) => boolean;
  // escalation primitive (never rejects; gate-cancel stays silent, failures
  // toast inside). Elevated opens are not recorded to recent.
  openAsRoot: (p: string) => Promise<void>;
  // executable fork: +x files (and ELF/shebang content without the bit)
  // prompt Run / Run in Terminal / Open anyway instead of xdg-open, which
  // would land them in the browser/editor. Absent = old behavior (fakes).
  isExecutable?: (p: string) => ExecutableInfo;
  // openAnyway re-runs the plain xdg-open path below (the prompt's fallback).
  askExecutable?: (p: string, info: ExecutableInfo, openAnyway: () => void) => void;
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
    // inside an archive cwd the "path" is an archive:// URI: xdg-open can't
    // reach it, and recording it would pollute the recent list. Per-entry
    // extract is not built yet, so say so instead of a bogus spawn.
    if (isArchiveUri(p)) {
      ctx.notify("Can't open archive member", "open", "info");
      return;
    }
    const canRead = ctx.canRead ?? canReadSync;
    // canRead is false for ENOENT too — a file deleted between listing and
    // open (or a dangling symlink, which accessSync follows) takes the plain
    // path: the spawn fails with an honest error instead of popping a sudo
    // prompt for something that isn't there.
    if (!canRead(p) && existsSync(p)) {
      void ctx.openAsRoot(p).catch(() => {});
      return;
    }
    // executables never reach xdg-open (browser/editor fallback): prompt for
    // Run / Run in Terminal / Open anyway. Dirs never classify (statSync on
    // a dir returns not-executable), so navigation is unaffected. Trash never
    // prompts — running from the trash is not a thing, it opens like before.
    const isExec = ctx.isExecutable ?? classifyPath;
    const info = isExec(p);
    const openAnyway = (): void => doSpawnOpen(p);
    if (ctx.askExecutable && info.executable && !ctx.inTrashView()) {
      ctx.askExecutable(p, info, openAnyway);
      return;
    }
    doSpawnOpen(p);
  };

  const doSpawnOpen = (p: string): void => {
    recordOpen(p);
    const base = path.basename(p);
    // the spawn starts SYNCHRONOUSLY (the open is the point) and the app
    // probe runs CONCURRENTLY — its latency overlaps the spawn's, and it
    // never blocks the failure path
    const spawnPromise = ctx.spawnOpen(p);
    void (async () => {
      const appPromise = ctx.appForFile(p).catch(() => null);
      const spawn = await spawnPromise;
      if (!spawn.ok) {
        // ONE toast for a failed open: the error REPLACES the optimistic
        // "Opening …" (the old shape could show both)
        ctx.notify(`Can't open ${base} · ${spawn.reason}`, "open", "error");
        return;
      }
      // the app name rides the same settlement — the probe answered, so the
      // toast can name what launched
      const app = await appPromise;
      ctx.notify(`Opening ${base}${app ? ` · ${app}` : ""}`, "open", "info");
    })();
  };

  return { recordOpen, openFileDefault };
};
