// --- The grid's internal drag: ONE explicit state machine.
//
// The drag used to be EIGHT parallel fields on a plain mutable object
// (`keys`, `ctrl`, `active`, `dropTarget`, `startX`, `startY`,
// `pendingKey`, `pendingState`) that every module could write. They formed
// a PRODUCT state space, so combinations like "a drag that is active but has
// no payload" or "a pending ctrl-toggle outside a press" were representable
// — and reachable:
//
//   - `pendingKey` survived a press whose mouseup never arrived (released
//     over the sidebar), so the NEXT gesture's mouseup fired the stale
//     toggle on a file the user never clicked.
//   - `ctrl` survived the gesture that set it, so a later kitty drag offer
//     could be declined by a stale "this was a ctrl drag".
//   - `scheduleDragCleanup` defers the reset by a tick (the release fires
//     on the source BEFORE the drop reaches the target), so between the
//     mouseup and the timer the state still claimed to be a live drag.
//
// The union makes each phase say what it carries:
//
//   idle     — no gesture. No payload, no ctrl flag, no drop target.
//   armed    — a press happened: the payload, the press point, whether it
//              was a ctrl press, and the DEFERRED click-toggle (which can
//              only exist here — a press that became a drag drops it).
//   dragging — the press crossed the threshold: the payload and the
//              drop target under the cursor. No pending toggle.
//   released — the gesture ended but the drop still has to read the
//              payload; the ctrl flag is GONE (the gesture is over).
//
// The reducer below is the ONLY way to change it; the readers are the only
// way to see it. Nothing outside this module can write a field.

import type { ClipItem } from "./file-op-protocol";

/** A deferred ctrl+click toggle: apply `state` to `key` if the press was a click. */
export type DragPendingToggle = { key: string; state: boolean };

export type DragState =
  | { kind: "idle" }
  | {
      kind: "armed";
      keys: ClipItem[];
      /** ctrl+drag = internal move, plain drag = external OSC 72 */
      ctrl: boolean;
      /** the press point (the drag threshold is measured from here) */
      x: number;
      y: number;
      /** the deferred click-toggle — only a ctrl press arms one */
      pending: DragPendingToggle | null;
    }
  | {
      kind: "dragging";
      keys: ClipItem[];
      ctrl: boolean;
      /** the folder key under the cursor (a drop target), if any */
      dropTarget: string | null;
    }
  | {
      kind: "released";
      keys: ClipItem[];
      dropTarget: string | null;
      /** the gesture that just ended WAS a drag (its status must be restored) */
      wasDragging: boolean;
    };

export const IDLE_DRAG: DragState = { kind: "idle" };

export type DragEvent =
  /** a press: arm the payload at (x, y) */
  | { type: "arm"; keys: ClipItem[]; ctrl: boolean; x: number; y: number; pending: DragPendingToggle | null }
  /** the press crossed the threshold: it became a drag (the pending toggle dies) */
  | { type: "trip" }
  /** the cursor moved over a drop target (or off it) */
  | { type: "hover-target"; key: string | null }
  /** the gesture ended; the payload survives for the imminent drop */
  | { type: "release" }
  /** the deferred toggle was applied (or discarded) */
  | { type: "consume-pending" }
  /** everything is cleaned up */
  | { type: "reset" };

export const transitionDrag = (state: DragState, ev: DragEvent): DragState => {
  switch (ev.type) {
    case "arm":
      // arming REPLACES the whole state: a pending toggle from an earlier
      // gesture can never outlive the press that armed it
      return { kind: "armed", keys: ev.keys, ctrl: ev.ctrl, x: ev.x, y: ev.y, pending: ev.pending };
    case "trip":
      if (state.kind !== "armed") return state;
      return { kind: "dragging", keys: state.keys, ctrl: state.ctrl, dropTarget: null };
    case "hover-target":
      if (state.kind !== "dragging") return state;
      return { ...state, dropTarget: ev.key };
    case "release":
      if (state.kind === "idle" || state.kind === "released") return state;
      return {
        kind: "released",
        keys: state.keys,
        dropTarget: state.kind === "dragging" ? state.dropTarget : null,
        wasDragging: state.kind === "dragging",
      };
    case "consume-pending":
      if (state.kind !== "armed" || !state.pending) return state;
      return { ...state, pending: null };
    case "reset":
      return IDLE_DRAG;
  }
};

// --- The readers. Every consumer goes through one of these, so the mapping
// from phase to meaning lives in ONE place. ---

/** the drag payload, or null when there is no gesture */
export const dragKeys = (state: DragState): ClipItem[] | null => (state.kind === "idle" ? null : state.keys);
/** true only while a drag is IN FLIGHT (the threshold was crossed) */
export const dragActive = (state: DragState): boolean => state.kind === "dragging";
/** true while the current gesture is a ctrl press (internal move) */
export const dragCtrl = (state: DragState): boolean =>
  state.kind === "armed" ? state.ctrl : state.kind === "dragging" ? state.ctrl : false;
/** the folder key under the cursor, if the drag has one */
export const dragDropTarget = (state: DragState): string | null =>
  state.kind === "dragging" || state.kind === "released" ? state.dropTarget : null;
/** the deferred click-toggle — it exists ONLY while a press is armed */
export const dragPending = (state: DragState): DragPendingToggle | null =>
  state.kind === "armed" ? state.pending : null;

// --- The shared instance. The grid's mouse pipeline drives it; every other
// module only reads it. ---

let current: DragState = IDLE_DRAG;

export const dragState = (): DragState => current;

export const dispatchDrag = (ev: DragEvent): void => {
  current = transitionDrag(current, ev);
};

export const resetDragState = (): void => {
  current = IDLE_DRAG;
};
