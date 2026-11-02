// --- renderAll orchestration: the ONE repaint path. Tab-sync and cwd-sync
// run first (chip titles must not lag a switch), then every named step through
// safeRenderStep so one throwing widget cannot blank the rest, in the
// CANONICAL order below. The session save is scheduled last so the write sees
// the settled state. Steps arrive as a record of closures — index wires them
// to the live widgets via arrows. ---

import { safeRenderStep } from "../lib/uiutil";
import { debugLog, isDebug } from "../lib/log";
import type { AppState } from "./nav";

// The ONE step order. It was the KEY ORDER of the steps record — an implicit
// contract: reordering the literal silently changed the paint order (sidebar
// before grid before preview is load-bearing — the preview renders against
// the listing the grid just built). The order is data now, and the wiring
// types its steps record as Record<RenderStepName, …>, so the compiler
// rejects a missing, misspelled or extra step.
export const RENDER_STEP_ORDER = [
  "cwdWatcher",
  "tabbar",
  "nav",
  "crumbs",
  "sidebar",
  "iconQueue",
  "grid",
  "paneFocus",
  "preview",
  "pluginSlots",
  "stripSelectable",
] as const;

export type RenderStepName = (typeof RENDER_STEP_ORDER)[number];

// The render itself plus a way to WAIT for it: some steps are async (the
// grid build lists the folder and re-rasterizes the tiles), so a caller that
// needs the paint to be COMPLETE — the boot, which reveals the app in one
// burst — must be able to await the async tail.
export type RenderAll = (() => void) & {
  settled(): Promise<void>;
};

export type RenderAllCtx = {
  state: AppState;
  syncTabFromState(): void;
  scheduleSaveSession(): void;
  log(msg: string): void;
  // open record (test fakes use their own step names); the production wiring
  // narrows it to Record<RenderStepName, …>
  steps: Record<string, () => void | Promise<void>>;
  // dual pane: sync EVERY pane's cwd from its history, not just the active one
  // (the active `state` facade handles its own). Optional for single-pane tests.
  syncPaneCwds?(): void;
};

export const makeRenderAll = (ctx: RenderAllCtx): RenderAll => {
  // canonical order FIRST, then any step the record adds beyond it (in the
  // record's own order) — a new step is never silently dropped, and the
  // production wiring cannot have one (the compiler enforces the set).
  const known = RENDER_STEP_ORDER as readonly string[];
  const names = [...known.filter((n) => n in ctx.steps), ...Object.keys(ctx.steps).filter((n) => !known.includes(n))];
  // the async steps still in flight (the grid build, the preview read):
  // settled() waits for them, and a step that starts MORE work (a late
  // plugin repaint re-rendering the grid) keeps the wait open
  const inflight = new Set<Promise<void>>();
  const renderAll = (() => {
    ctx.syncTabFromState();
    ctx.state.cwd = ctx.state.history[ctx.state.histIdx] ?? ctx.state.cwd;
    ctx.syncPaneCwds?.();
    for (const name of names) {
      const step = ctx.steps[name];
      if (!step) continue;
      // per-step timings feed slow-boot reports; measured always (ns-cheap),
      // logged only under --debug so hot-path renders stay quiet
      const t0 = isDebug ? performance.now() : 0;
      const pending = safeRenderStep(name, step, ctx.log);
      if (pending) {
        inflight.add(pending);
        void pending.finally(() => inflight.delete(pending));
      }
      if (isDebug) debugLog(`render: ${name} ${Math.round(performance.now() - t0)}ms`);
    }
    ctx.scheduleSaveSession();
  }) as RenderAll;
  renderAll.settled = async (): Promise<void> => {
    // loop, not a single await: a settling step can queue another render
    // (the lazy plugin scan's late repaint), which queues more async work
    while (inflight.size > 0) {
      await Promise.all([...inflight]);
    }
  };
  return renderAll;
};
