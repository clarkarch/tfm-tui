// --- Plugin pre-op hooks: the INTERCEPT channel. Unlike plugin-events
// (observe-only), a hook can veto an operation before core starts it. Kept
// tiny and sync-only on purpose: hooks run inside file-op orchestration, so a
// hook that throws or hangs must never block the op (isolation + first-skip
// wins). Pure module (no renderer/fs imports) so app/fs modules can consult it
// without an import cycle. Shared singleton mirrors sharedPluginEvents. ---

import type { NotifyLevel } from "./notify-level";

export type FileOpHookPayload = {
  // vocabulary: copy | move | rename | duplicate | trash | delete-forever | empty
  op: string;
  paths: string[];
  dest?: string;
};

// return { skip: true, reason? } to veto; anything else lets the op proceed
// biome-ignore lint/suspicious/noConfusingVoidType: hooks may return nothing
export type FileOpHookDecision = { skip?: boolean; reason?: string } | undefined | void;
export type FileOpHook = (payload: FileOpHookPayload) => FileOpHookDecision;

export type PluginHooks = {
  onBeforeFileOp(fn: FileOpHook): () => void;
  // null when no hook vetoed; else the first veto's reason
  beforeFileOp(payload: FileOpHookPayload): { skip: true; reason?: string } | null;
};

export const makePluginHooks = (): PluginHooks => {
  const listeners = new Set<FileOpHook>();
  return {
    onBeforeFileOp: (fn) => {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
    beforeFileOp: (payload) => {
      for (const fn of [...listeners]) {
        try {
          const d = fn(payload);
          // hooks are sync-only; an async hook's rejection must not surface as
          // an unhandled rejection (swallow it, proceed as no-decision)
          if (d && typeof (d as PromiseLike<unknown>).then === "function") {
            void Promise.resolve(d).catch(() => {});
            continue;
          }
          if (d?.skip) return { skip: true, ...(d.reason ? { reason: d.reason } : {}) };
        } catch {}
      }
      return null;
    },
  };
};

let shared: PluginHooks | null = null;
export const sharedPluginHooks = (): PluginHooks => {
  if (!shared) shared = makePluginHooks();
  return shared;
};

// Shared veto check for the two callers (fileops + trashops): consults the
// bus, notifies on veto — "first skip wins" lives in beforeFileOp above.
export const checkPluginVeto = (
  hooks: Pick<PluginHooks, "beforeFileOp">,
  notify: (msg: string, title?: string, level?: NotifyLevel) => void,
  op: string,
  paths: string[],
  dest?: string,
): boolean => {
  const veto = hooks.beforeFileOp({ op, paths, ...(dest ? { dest } : {}) });
  if (!veto) return false;
  notify(`Blocked by plugin${veto.reason ? `: ${veto.reason}` : ""}`, "blocked", "info");
  return true;
};
