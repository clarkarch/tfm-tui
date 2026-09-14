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

import { hoverLiftDelta } from "./ui-grid-anim";
import type { SidebarHoverOpts } from "../config/config-schema";

export type { SidebarHoverOpts };

export type SidebarRowRef = {
  rowId: string;
  iconSlotId: string;
  labelId: string;
  selected: boolean;
};

type SidebarHoverCtx = {
  byId(id: string): any;
  rowRefs(): Map<string, SidebarRowRef>;
  hoverOpts(): SidebarHoverOpts;
};

type HoverCur = { key: string; refs: SidebarRowRef; node: any };

export const makeSidebarHover = (ctx: SidebarHoverCtx) => {
  let current: HoverCur | null = null;

  // A row copied from a previous build may have been destroyed by a sidebar
  // rebuild, so only touch the node refs when byId still resolves to them.
  const ownedNode = (cur: HoverCur | null): any => {
    if (!cur) return null;
    try {
      const node = ctx.byId(cur.refs.rowId);
      return node === cur.node ? node : null;
    } catch {
      return null;
    }
  };

  const writeLift = (refs: SidebarRowRef, dx: number, dy: number): void => {
    try {
      const slot = refs.iconSlotId ? ctx.byId(refs.iconSlotId) : null;
      if (slot) {
        slot.translateX = dx;
        slot.translateY = dy;
      }
    } catch {}
    try {
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
      // where selection owns the hovered tile's visuals)
      if (refs.selected) return;

      // sweep: the pointer moved to another row without an out landing first
      if (current && current.key !== key) {
        dropLift(current);
        current = null;
      }
      const delta = hoverLiftDelta(opts.direction);
      try {
        const slot = refs.iconSlotId ? ctx.byId(refs.iconSlotId) : null;
        if (slot) {
          slot.translateX = delta.dx;
          slot.translateY = delta.dy;
        }
        const label = refs.labelId ? ctx.byId(refs.labelId) : null;
        if (label) {
          const withLabel = opts.includeLabel;
          label.translateX = withLabel ? delta.dx : 0;
          label.translateY = withLabel ? delta.dy : 0;
        }
      } catch {}
      current = { key, refs, node };
    } catch {
      // never strand a lifted row when an unexpected lookup fails
      try {
        dropLift(current);
      } catch {}
      current = null;
    }
  };

  return { playHover };
};
