// --- In-app update checking: one cached "is there a newer tfm?" question
// shared by the boot notice, the About row and the `checkUpdates` command, plus
// the confirmed install (which delegates to install.sh through ./update-run).
// Renderer-free: toasts, the confirm dialog and the repaint arrive as
// callbacks, so the whole module is testable headlessly. ---

import { errMessage } from "../lib/uiutil";
import type { NotifyLevel } from "../lib/notify-level";
import {
  cacheFresh,
  readUpdateCache,
  statusFor,
  UPDATE_PROMPT_MESSAGE,
  updatePromptYesLabel,
  updateRowValue,
  updateRowActionable,
  updateToast,
  writeUpdateCache,
  type UpdateCache,
  type UpdateStatus,
} from "../app/update";
import {
  fetchLatestTag,
  installDirOf,
  isDevBuild,
  runInstaller,
  type InstallerResult,
  type RunInstallerDeps,
} from "../app/update-run";

export type UpdatesCtx = {
  current: string;
  execPath: string;
  // live read of [ui] check-updates: the boot notice is the only thing this
  // gates (a manual check always works)
  enabled(): boolean;
  notify(msg: string, title?: string, level?: NotifyLevel): void;
  // indeterminate progress toast; null when the stack refuses to build one
  sticky?(msg: string): { close(): void } | null;
  confirm(message: string, yesLabel: string, onYes: () => void): boolean;
  // repaint the About view if it is open (row value changed)
  repaint(): void;
  now?(): number;
  log?(msg: string): void;
  fetchTag?(o: { signal?: AbortSignal }): Promise<string | null>;
  install?(o: RunInstallerDeps): Promise<InstallerResult>;
  installDir?: string;
  cache?: { read(): Promise<UpdateCache | null>; write(c: UpdateCache): Promise<void> };
};

// toast policy: a manual check always answers, the boot notice speaks once per
// version, and the pre-step of a click says nothing extra
type ToastMode = "always" | "once" | "never";

export const wireUpdates = (ctx: UpdatesCtx) => {
  const isDev = isDevBuild(ctx.execPath);
  const installDir = ctx.installDir ?? installDirOf(ctx.execPath);
  const now = ctx.now ?? (() => Date.now());
  const cache = ctx.cache ?? {
    read: () => readUpdateCache(),
    write: (c: UpdateCache) => writeUpdateCache(c),
  };
  const fetchTag = ctx.fetchTag ?? ((o: { signal?: AbortSignal }) => fetchLatestTag(o));
  const install = ctx.install ?? runInstaller;

  // null until something asked: the About row shows a plain "check for updates"
  let status: UpdateStatus | null = null;
  let inFlight: Promise<UpdateStatus> | null = null;
  let applying = false;
  // generation guard: a check that lands after quit/stop must not toast or
  // write state into a torn-down renderer
  let gen = 0;
  let aborter: AbortController | null = null;

  const say = (s: UpdateStatus): void => {
    const t = updateToast(s);
    ctx.notify(t.message, t.title, t.level);
  };

  const publish = (s: UpdateStatus): UpdateStatus => {
    status = s;
    try {
      ctx.repaint();
    } catch (err) {
      ctx.log?.(`update row repaint failed: ${errMessage(err)}`);
    }
    return s;
  };

  const run = async (force: boolean): Promise<UpdateStatus> => {
    const current = ctx.current;
    if (isDev) return publish({ kind: "dev", current });
    let cached: UpdateCache | null = null;
    try {
      cached = await cache.read();
    } catch {}
    let latest: string | null;
    if (!force && cacheFresh(cached, now())) {
      latest = cached?.latest ?? null;
    } else {
      const myGen = gen;
      aborter = new AbortController();
      latest = await fetchTag({ signal: aborter.signal });
      if (myGen !== gen) return status ?? { kind: "idle" };
      try {
        await cache.write({ checkedAt: now(), latest, notified: cached?.notified ?? null });
      } catch {}
    }
    return publish(statusFor({ current, latest, isDev }));
  };

  const check = async (mode: ToastMode, force: boolean): Promise<UpdateStatus> => {
    if (inFlight) return inFlight;
    const myGen = gen;
    if (mode !== "never") publish({ kind: "checking" });
    const p = run(force).finally(() => {
      inFlight = null;
    });
    inFlight = p;
    const s = await p;
    if (myGen !== gen) return s;
    if (mode === "always") say(s);
    if (mode === "once" && s.kind === "available") {
      const cached = await cache.read().catch(() => null);
      if (cached?.notified === s.latest) return s;
      say(s);
      try {
        await cache.write({ checkedAt: now(), latest: s.latest, notified: s.latest });
      } catch {}
    }
    return s;
  };

  const apply = async (target: string): Promise<void> => {
    if (applying) return;
    applying = true;
    const progress = ctx.sticky?.("Updating tfm…") ?? null;
    try {
      const res = await install({ tag: `v${target}`, installDir, capture: true });
      if (res.ok) {
        // the running process keeps its old inode, so the row must stop
        // offering a version that is now on disk
        publish({ kind: "current", current: target });
        ctx.notify(`tfm ${target} is installed, restart tfm to use it`, "Update", "success");
      } else {
        ctx.notify(
          `Couldn't update tfm${res.detail ? `, ${res.detail}` : ""}. Try again, or run 'tfm update' in a terminal`,
          "Update",
          "error",
        );
      }
    } catch (err) {
      ctx.notify(`Couldn't update tfm, ${errMessage(err)}`, "Update", "error");
    } finally {
      try {
        progress?.close();
      } catch {}
      applying = false;
    }
  };

  const ask = (s: Extract<UpdateStatus, { kind: "available" }>): void => {
    const yes = (): void => {
      void apply(s.latest);
    };
    try {
      ctx.confirm(UPDATE_PROMPT_MESSAGE, updatePromptYesLabel(s.latest), yes);
    } catch (err) {
      ctx.log?.(`update prompt failed: ${errMessage(err)}`);
      ctx.notify("A newer tfm is available, run 'tfm update' in a terminal", "Update", "info");
    }
  };

  const activate = async (): Promise<UpdateStatus> => {
    const known = status;
    if (known?.kind === "available") {
      ask(known);
      return known;
    }
    const s = await check("never", true);
    if (s.kind !== "available") {
      say(s);
      return s;
    }
    // a click already asked the question: record it as told so the next boot
    // notice does not repeat a version the user just saw
    try {
      await cache.write({ checkedAt: now(), latest: s.latest, notified: s.latest });
    } catch {}
    ask(s);
    return s;
  };

  const stop = (): void => {
    gen++;
    inFlight = null;
    try {
      aborter?.abort();
    } catch {}
    aborter = null;
  };

  return {
    status: (): UpdateStatus | null => status,
    rowValue: (): string => updateRowValue(status ?? { kind: "idle" }),
    actionable: (): boolean => updateRowActionable(status ?? { kind: "idle" }),
    // boot: one cached question, and the notice speaks once per version
    checkOnBoot: (): Promise<UpdateStatus> => {
      if (!ctx.enabled()) return Promise.resolve(status ?? { kind: "idle" });
      return check("once", false);
    },
    // manual: always asks the network, always answers
    checkNow: (o: { toast?: ToastMode } = {}): Promise<UpdateStatus> => check(o.toast ?? "always", true),
    activate,
    applyUpdate: apply,
    stop,
  };
};
