// --- Post-mount node lookup helpers: OpenTUI nodes are findable by id only
// after mount and die on every rebuild, so every lookup must tolerate a miss
// and never run before the renderer boots. The renderer root arrives via a
// getter — this module never imports the renderer. ---

import type { CliRenderer } from "@opentui/core";
import type { MaybeNode, NodeLike, NodeRoot } from "../lib/node-like";

type LookupCtx = { root: () => NodeRoot };

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export const makeLookup = (ctx: LookupCtx) => {
  const byId = (id: string): MaybeNode => {
    try {
      return ctx.root().findDescendantById(id);
    } catch {
      return null;
    }
  };

  // set a TEXT node's content by id — ids must live on the Text, not its
  // wrapper Box (boxes have no .content, mutating them no-ops)
  const setTextOnId = (nodeId: string, s: string): void => {
    const n = byId(nodeId);
    if (n) {
      try {
        n.content = s;
      } catch {}
    }
  };

  const setOnId = (id: string, fn: (n: NodeLike) => void): void => {
    const n = byId(id);
    if (!n) return;
    try {
      fn(n);
    } catch {}
  };

  // text renderables default selectable = true — the renderer's text-selection
  // drag hijacks custom drag flows, so strip it recursively after every rebuild
  const stripSelectable = (node: MaybeNode = ctx.root()): void => {
    if (!node || node.isDestroyed) return;
    try {
      if (node.selectable) node.selectable = false;
    } catch {}
    node.getChildren?.().forEach((c) => {
      stripSelectable(c);
    });
  };

  return { byId, setTextOnId, setOnId, stripSelectable };
};

// --- Pixel-resolution gate --------------------------------------------------
// renderer.resolution is null until the terminal ANSWERS OpenTUI's pixel-size
// query (that reply is the only writer; every RESIZE nulls it again for a
// requery). Terminals that ignore the query — the Linux console, tmux, dumb
// frontends — leave it null FOREVER, and the old waitForResolution parked
// 40 x 50ms on EVERY grid rebuild there: navigation looked dead while the
// previous folder sat on screen. The pane never needed those pixels (it builds
// on cellMetrics' 10x20 fallback, and rasters are gated separately on the REAL
// resolution), so the park is split in two:
//   settle() — the boot wait. One full budget, then LATCH: a terminal that
//     answered nothing by then never will, and later waits are free.
//   wait()  — the render-path wait. Instant once the resolution landed or the
//     gate latched; otherwise a short bounded park (a resize requery nulled it
//     and the reply is milliseconds away).
export const RESOLUTION_POLL_MS = 50;
// boot: the terminal's one chance to report cell pixels (unchanged 2s budget —
// the one place a late reply still buys pixel-accurate rasters)
export const RESOLUTION_SETTLE_MS = 2000;
// render path: only ever paid on a terminal that DOES report pixels, right
// after a resize nulled the resolution for its requery
export const RESOLUTION_RENDER_MS = 200;

export type ResolutionGate = {
  settle(budgetMs?: number): Promise<void>;
  wait(budgetMs?: number): Promise<void>;
};

export const makeResolutionGate = (
  renderer: () => CliRenderer,
  deps?: {
    sleep?: (ms: number) => Promise<void>;
    now?: () => number;
    log?: (msg: string) => void;
    // this terminal paints NO rasters (tty mode / force-glyph), so cell pixels
    // are never read: skip the wait entirely instead of burning the budget on
    // data nothing consumes (the console's leftover startup stall)
    rasterless?: () => boolean;
  },
): ResolutionGate => {
  const sleepFn = deps?.sleep ?? sleep;
  const now = deps?.now ?? Date.now;
  // latched by settle(): this terminal never answered the pixel query, so no
  // render may park on it again (the console/tmux case). A pixel-reporting
  // terminal never latches — its reply lands within milliseconds of boot.
  let neverReports = false;
  const park = async (budgetMs: number): Promise<void> => {
    const deadline = now() + budgetMs;
    while (!renderer().resolution && now() < deadline) await sleepFn(RESOLUTION_POLL_MS);
  };
  return {
    async settle(budgetMs = RESOLUTION_SETTLE_MS): Promise<void> {
      if (renderer().resolution || neverReports) return;
      if (deps?.rasterless?.()) {
        neverReports = true;
        deps.log?.("resolution: skipped — this terminal paints no rasters (tty mode / force-glyph)");
        return;
      }
      await park(budgetMs);
      if (renderer().resolution) return;
      neverReports = true;
      deps?.log?.(
        `resolution: none after ${budgetMs}ms — terminal doesn't report pixels (grid builds on fallback cell metrics)`,
      );
    },
    async wait(budgetMs = RESOLUTION_RENDER_MS): Promise<void> {
      if (renderer().resolution || neverReports) return;
      if (deps?.rasterless?.()) return;
      await park(budgetMs);
    },
  };
};
