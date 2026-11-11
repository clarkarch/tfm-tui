// --- Sidebar row hover nudge: hovering ANY sidebar row (places, pins,
// devices, network — every row makeRow builds) nudges its icon one cell in
// the configured direction, exactly like the tile hover lift. Paint (row bg,
// icon raster, label fg) stays owned by normalizePlaces — this module owns
// ONLY the lift translate, so with the feature off the code path is a no-op
// and today's instant snap is untouched.
//
// Synchronous, one lifted row at a time (a new over settles the abandoned
// row). ONE state record ("none" | "lifted") + ONE liveness rule: the
// animator reconciles its own ownership when a sidebar rebuild kills the
// row nodes — the fresh rows take the SAME ids, so a write that is not
// guarded by "do we still own a LIVE row?" lands on the NEW row and strands
// the nudge (nothing releases it: the old row's out never fires, the fresh
// row was never lifted). No external "a rebuild happened" call is needed.
// No timeline: a whole-cell translate cannot tween. ---

import { hoverOffset, makeHoverTween } from "./ui-grid-anim";
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

// ONE state record. The old code had a nullable `current` + a separate
// node-identity probe + an EXTERNAL obligation ("a rebuild happened, forget
// your refs") that every rebuild path had to remember — and a path that
// forgot it stranded the nudge.
type SidebarHoverState = { kind: "none" } | { kind: "lifted"; key: string; refs: SidebarRowRef; node: MaybeNode };

export const makeSidebarHover = (ctx: SidebarHoverCtx) => {
  let state: SidebarHoverState = { kind: "none" };
  // one reused tween drives the hover-in glide when duration > 0 (ms 0 = snap)
  const tween = makeHoverTween(ctx.renderer);

  // is the owned row still the LIVE one? A sidebar rebuild replaces the row
  // nodes under the same ids, so the identity check IS the rebuild probe.
  const ownedLive = (st: SidebarHoverState): boolean => {
    if (st.kind !== "lifted") return false;
    try {
      return ctx.byId(st.refs.rowId) === st.node;
    } catch {
      return false;
    }
  };

  // The animator notices a rebuild ITSELF: the owned row node dies with the
  // rebuild (the fresh rows take the same ids), so the stale ownership is
  // reconciled away right here. Returns whether the ownership is still LIVE:
  // every write asks first — a stale write would land on the fresh row.
  const reconcile = (): boolean => {
    if (state.kind !== "lifted") return false;
    if (ownedLive(state)) return true;
    state = { kind: "none" };
    return false;
  };

  // one write, dx/dy per node (the lift path passes the delta, the release
  // passes 0/0 — includeLabel handled at the lift site). The nodes are
  // resolved LIVE, so the caller must own a live row (see reconcile).
  const writeLift = (refs: SidebarRowRef, dx: number, dy: number, rideLabel: boolean): void => {
    try {
      const slot = refs.iconSlotId ? ctx.byId(refs.iconSlotId) : null;
      if (slot) {
        slot.translateX = dx;
        slot.translateY = dy;
      }
      const label = refs.labelId ? ctx.byId(refs.labelId) : null;
      if (label) {
        label.translateX = rideLabel ? dx : 0;
        label.translateY = rideLabel ? dy : 0;
      }
    } catch {}
  };

  // drop the lift we own: stop the glide (ALWAYS — a stale glide must not
  // keep running) and put the row back at rest.
  const dropLift = (st: SidebarHoverState): void => {
    if (st.kind !== "lifted") return;
    tween.stop();
    // a dead row has nothing to write (its nodes are gone; the fresh row was
    // never lifted by us)
    if (!ownedLive(st)) return;
    writeLift(st.refs, 0, 0, true);
  };

  const playHover = (key: string, hovered: boolean): void => {
    try {
      // a rebuild under the pointer invalidates the ownership — the animator
      // sees it (the owned row node is dead), so no external call is needed
      reconcile();
      const refs = ctx.rowRefs().get(key);
      if (!refs) return;
      const node = ctx.byId(refs.rowId);
      if (!node) return;
      const opts = ctx.hoverOpts();

      // feature off = today's instant snap (normalizePlaces paints); a lift
      // owned while it was on is still released so no row strands shifted
      if (!opts.enabled) {
        if (state.kind === "lifted") {
          dropLift(state);
          state = { kind: "none" };
        }
        return;
      }

      // an out always releases a lift we own
      if (!hovered) {
        if (state.kind === "lifted" && state.key === key) {
          dropLift(state);
          state = { kind: "none" };
        }
        return;
      }
      // the cwd-selected row keeps its accent paint only (mirrors tiles,
      // where selection owns the hovered tile's visuals) — but a lift WE own
      // on this row gets released first: a repaint can re-fire a synthetic
      // over on the stationary cursor after the row's selection flipped with
      // no out event, and the lift must not survive into the selected state
      if (refs.selected) {
        if (state.kind === "lifted" && state.key === key) {
          dropLift(state);
          state = { kind: "none" };
        }
        return;
      }

      // sweep: the pointer moved to another row without an out landing first
      if (state.kind === "lifted" && state.key !== key) {
        dropLift(state);
        state = { kind: "none" };
      }
      const off = hoverOffset(opts.direction, opts.slideCells);
      state = { kind: "lifted", key, refs, node };
      // writes the offset at hover progress p; the label rides only when
      // include-label is on. p=1 settled hover, p=0 rest. The glide asks the
      // animator first: a rebuild kills the owned row, and a stale write on
      // the fresh row strands the nudge.
      const writeAt = (p: number): void => {
        if (!reconcile()) return;
        const st = state;
        if (st.kind !== "lifted") return;
        writeLift(st.refs, Math.round(off.dx * p), Math.round(off.dy * p), opts.includeLabel);
      };
      if (opts.ms > 0) {
        tween.run(opts.ms, opts.ease, 0, 1, (p) => writeAt(p));
      } else {
        tween.stop();
        writeAt(1);
      }
    } catch {
      // never strand a lifted row when an unexpected lookup fails
      try {
        dropLift(state);
      } catch {}
      state = { kind: "none" };
    }
  };

  // release any owned lift. wiring/chrome calls this when a modal takes the
  // screen so a row hovered at that instant can't stay nudged behind the dim.
  const release = (): void => {
    reconcile();
    if (state.kind !== "lifted") return;
    const st = state;
    state = { kind: "none" };
    dropLift(st);
  };

  return { playHover, release };
};
