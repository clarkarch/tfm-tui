// --- Sidebar row hover nudge: hovering ANY sidebar row (places, pins,
// devices, network — every row makeRow builds) nudges its icon one cell in
// the configured direction, exactly like the tile hover lift. Paint (row bg,
// icon raster, label fg) stays owned by normalizePlaces — this module owns
// ONLY the lift translate, so with the feature off the code path is a no-op
// and today's instant snap is untouched.
//
// Synchronous, one lifted row at a time (a new over settles the abandoned
// row); every node write is try/catch and node identity is re-checked via
// byId, so a sidebar rebuild under a stationary cursor can never write to a
// dead row. No timeline: a whole-cell translate cannot tween. ---

import { hoverOffset, makeHoverTween, type EaseKey } from "./ui-grid-anim";
import type { SidebarHoverOpts } from "../config/config-schema";
import type { MaybeNode } from "../lib/node-like";
import type { CliRenderer } from "@opentui/core";

export type { SidebarHoverOpts };

export type SidebarRowRef = {
  rowId: string;
  iconSlotId: string;
  labelId: string;
  selected: boolean;
};

type SidebarHoverCtx = {
  renderer: () => CliRenderer;
  byId(id: string): MaybeNode;
  rowRefs(): Map<string, SidebarRowRef>;
  hoverOpts(): SidebarHoverOpts;
};

type HoverCur = { key: string; refs: SidebarRowRef; node: MaybeNode };

export const makeSidebarHover = (ctx: SidebarHoverCtx) => {
  let current: HoverCur | null = null;
  // one reused tween drives the hover-in glide when duration > 0 (ms 0 = snap)
  const tween = makeHoverTween(ctx.renderer);

  // A row copied from a previous build may have been destroyed by a sidebar
  // rebuild, so only touch the node refs when byId still resolves to them.
  const ownedNode = (cur: HoverCur | null): MaybeNode => {
    if (!cur) return null;
    try {
      const node = ctx.byId(cur.refs.rowId);
      return node === cur.node ? node : null;
    } catch {
      return null;
    }
  };

  // one write, dx/dy per node (the lift path passes the delta, the release
  // passes 0/0 — includeLabel handled at the lift site)
  const writeLift = (refs: SidebarRowRef, dx: number, dy: number): void => {
    try {
      const slot = refs.iconSlotId ? ctx.byId(refs.iconSlotId) : null;
      if (slot) {
        slot.translateX = dx;
        slot.translateY = dy;
      }
      const label = refs.labelId ? ctx.byId(refs.labelId) : null;
      if (label) {
        label.translateX = dx;
        label.translateY = dy;
      }
    } catch {}
  };

  const dropLift = (cur: HoverCur | null): void => {
    if (!cur) return;
    if (!ownedNode(cur)) return;
    tween.stop();
    writeLift(cur.refs, 0, 0);
  };

  const playHover = (key: string, hovered: boolean): void => {
    try {
      const refs = ctx.rowRefs().get(key);
      if (!refs) return;
      const node = ctx.byId(refs.rowId);
      if (!node) return;
      const opts = ctx.hoverOpts();

      // feature off = today's instant snap (normalizePlaces paints); a lift
      // owned while it was on is still released so no row strands shifted
      if (!opts.enabled) {
        if (current) {
          dropLift(current);
          current = null;
        }
        return;
      }

      // an out always releases a lift we own
      if (!hovered) {
        if (current?.key === key) {
          dropLift(current);
          current = null;
        }
        return;
      }
      // the cwd-selected row keeps its accent paint only (mirrors tiles,
      // where selection owns the hovered tile's visuals) — but a lift WE own
      // on this row gets released first: a repaint can re-fire a synthetic
      // over on the stationary cursor after the row's selection flipped with
      // no out event, and the lift must not survive into the selected state
      if (refs.selected) {
        if (current?.key === key) {
          dropLift(current);
          current = null;
        }
        return;
      }

      // sweep: the pointer moved to another row without an out landing first
      if (current && current.key !== key) {
        dropLift(current);
        current = null;
      }
      const off = hoverOffset(opts.direction, opts.slideCells);
      const nextCur: HoverCur = { key, refs, node };
      current = nextCur;
      // writes the offset at hover progress p; the label rides only when
      // include-label is on. p=1 settled hover, p=0 rest.
      const writeAt = (cur: HoverCur | null, p: number): void => {
        if (!cur) return;
        try {
          const slot = cur.refs.iconSlotId ? ctx.byId(cur.refs.iconSlotId) : null;
          if (slot) {
            slot.translateX = Math.round(off.dx * p);
            slot.translateY = Math.round(off.dy * p);
          }
          const label = cur.refs.labelId ? ctx.byId(cur.refs.labelId) : null;
          if (label) {
            const wl = opts.includeLabel;
            label.translateX = wl ? Math.round(off.dx * p) : 0;
            label.translateY = wl ? Math.round(off.dy * p) : 0;
          }
        } catch {}
      };
      if (opts.ms > 0) {
        tween.run(opts.ms, opts.ease as EaseKey, 0, 1, (p) => writeAt(nextCur, p));
      } else {
        tween.stop();
        writeAt(nextCur, 1);
      }
    } catch {
      // never strand a lifted row when an unexpected lookup fails
      try {
        dropLift(current);
      } catch {}
      current = null;
    }
  };

  // the hover drawer / mounts refresh / watcher rebuild rows under a live
  // hover: rowRefs re-resolve to FRESH nodes while `current` still owns the
  // dead ones. ownedNode identity-checks the write, so a repaint can never
  // touch a destroyed row — but the stale ownership must ALSO be forgotten,
  // or the next out/sweep no-ops against the dead refs and the fresh row's
  // lift (re-applied by the synthetic over after the rebuild) is never
  // released. Called by renderSidebar after every rebuild. Returns whether
  // anything was actually forgotten (lets callers — and tests — tell a real
  // rebuild from a redundant call).
  const forgetStale = (): boolean => {
    if (!current) return false;
    if (!ownedNode(current)) {
      current = null;
      return true;
    }
    return false;
  };

  // release any owned lift. wiring/chrome calls this when a modal takes the
  // screen so a row hovered at that instant can't stay nudged behind the dim.
  const release = (): void => {
    if (!current) return;
    const cur = current;
    current = null;
    dropLift(cur);
  };

  return { playHover, forgetStale, release };
};
