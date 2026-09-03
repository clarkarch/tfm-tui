// --- renderAll orchestration: the ONE repaint path. Tab-sync and cwd-sync
// run first (chip titles must not lag a switch), then every named step through
// safeRenderStep so one throwing widget cannot blank the rest, in insertion
// order (load-bearing: sidebar before grid, grid before preview). The session
// save is scheduled last so the write sees the settled state. Steps arrive as
// a record of closures — index wires them to the live widgets via arrows. ---

import { safeRenderStep } from "../ui/uiutil";
import { debugLog, isDebug } from "./log";
import type { AppState } from "./nav";

export type RenderAllCtx = {
  state: AppState;
  syncTabFromState(): void;
  scheduleSaveSession(): void;
  log(msg: string): void;
  steps: Record<string, () => void | Promise<void>>;
};

export const makeRenderAll = (ctx: RenderAllCtx): (() => void) => {
  const names = Object.keys(ctx.steps);
  return () => {
    ctx.syncTabFromState();
    ctx.state.cwd = ctx.state.history[ctx.state.histIdx] ?? ctx.state.cwd;
    for (const name of names) {
      // per-step timings feed slow-boot reports; measured always (ns-cheap),
      // logged only under --debug so hot-path renders stay quiet
      const t0 = isDebug ? performance.now() : 0;
      safeRenderStep(name, () => ctx.steps[name]!(), ctx.log);
      if (isDebug) debugLog(`render: ${name} ${Math.round(performance.now() - t0)}ms`);
    }
    ctx.scheduleSaveSession();
  };
};
