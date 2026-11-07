import { describe, expect, test } from "bun:test";
import {
  dispatchDrag,
  dragActive,
  dragCtrl,
  dragDropTarget,
  dragKeys,
  dragPending,
  dragState,
  IDLE_DRAG,
  resetDragState,
  transitionDrag,
  type DragEvent,
} from "./drag-state";

const keys = [{ path: "/w/a.txt", isDir: false }];

const arm = (over: Partial<Extract<DragEvent, { type: "arm" }>> = {}): DragEvent => ({
  type: "arm",
  keys,
  ctrl: false,
  x: 0,
  y: 0,
  pending: null,
  ...over,
});

describe("the drag state is an explicit union", () => {
  test("idle carries NO payload, NO ctrl flag and NO drop target", () => {
    expect(dragKeys(IDLE_DRAG)).toBeNull();
    expect(dragActive(IDLE_DRAG)).toBe(false);
    expect(dragCtrl(IDLE_DRAG)).toBe(false);
    expect(dragDropTarget(IDLE_DRAG)).toBeNull();
    expect(dragPending(IDLE_DRAG)).toBeNull();
  });

  test("armed carries the payload + press point, but NO drop target", () => {
    const s = transitionDrag(IDLE_DRAG, arm({ x: 4, y: 7 }));
    expect(s.kind).toBe("armed");
    expect(dragKeys(s)).toEqual(keys);
    expect(dragActive(s)).toBe(false);
    // a drop target only exists while a drag is in flight
    expect(dragDropTarget(s)).toBeNull();
  });

  test("dragging carries the drop target and NO pending toggle", () => {
    const armed = transitionDrag(IDLE_DRAG, arm({ pending: { key: "/w/a.txt", state: true } }));
    const dragging = transitionDrag(armed, { type: "trip" });
    expect(dragging.kind).toBe("dragging");
    expect(dragActive(dragging)).toBe(true);
    // the deferred click-toggle is GONE once the press became a drag
    expect(dragPending(dragging)).toBeNull();
    const hovered = transitionDrag(dragging, { type: "hover-target", key: "/w/sub" });
    expect(dragDropTarget(hovered)).toBe("/w/sub");
  });

  test("the pending toggle exists ONLY in the armed phase", () => {
    const armed = transitionDrag(IDLE_DRAG, arm({ pending: { key: "/w/a.txt", state: true } }));
    expect(dragPending(armed)).toEqual({ key: "/w/a.txt", state: true });
    expect(dragPending(transitionDrag(IDLE_DRAG, { type: "release" }))).toBeNull();
    expect(dragPending(transitionDrag(armed, { type: "consume-pending" }))).toBeNull();
  });
});

describe("the drag transitions", () => {
  test("arming REPLACES the whole state — a stale pending toggle cannot survive", () => {
    const armed = transitionDrag(IDLE_DRAG, arm({ pending: { key: "/w/a.txt", state: true } }));
    // a new gesture arms over the old one
    const rearmed = transitionDrag(armed, arm({ keys: [{ path: "/w/b.txt", isDir: false }] }));
    expect(dragPending(rearmed)).toBeNull();
    expect(dragKeys(rearmed)).toEqual([{ path: "/w/b.txt", isDir: false }]);
  });

  test("a release keeps the payload for the imminent drop but drops the ctrl flag", () => {
    const armed = transitionDrag(IDLE_DRAG, arm({ ctrl: true }));
    const released = transitionDrag(armed, { type: "release" });
    expect(released.kind).toBe("released");
    expect(dragKeys(released)).toEqual(keys);
    // the ctrl flag belonged to the GESTURE — after the release there is no
    // gesture, so nothing can consult a stale "this was a ctrl drag"
    expect(dragCtrl(released)).toBe(false);
    expect(dragActive(released)).toBe(false);
    // an armed press was not a drag — the status has nothing to restore
    expect((released as { wasDragging: boolean }).wasDragging).toBe(false);
  });

  test("a release from dragging keeps the drop target for the un-highlight", () => {
    const dragging = transitionDrag(transitionDrag(transitionDrag(IDLE_DRAG, arm()), { type: "trip" }), {
      type: "hover-target",
      key: "/w/sub",
    });
    const released = transitionDrag(dragging, { type: "release" });
    expect(dragDropTarget(released)).toBe("/w/sub");
    // the gesture WAS a drag — the cleanup restores the selection status
    expect((released as { wasDragging: boolean }).wasDragging).toBe(true);
  });

  test("a trip only arms from `armed` (an idle state cannot start dragging)", () => {
    expect(transitionDrag(IDLE_DRAG, { type: "trip" })).toBe(IDLE_DRAG);
    const released = transitionDrag(transitionDrag(IDLE_DRAG, arm()), { type: "release" });
    expect(transitionDrag(released, { type: "trip" }).kind).toBe("released");
  });

  test("a hover target only applies while dragging", () => {
    const armed = transitionDrag(IDLE_DRAG, arm());
    expect(transitionDrag(armed, { type: "hover-target", key: "/w/sub" }).kind).toBe("armed");
    expect(dragDropTarget(transitionDrag(armed, { type: "hover-target", key: "/w/sub" }))).toBeNull();
  });

  test("reset returns to idle", () => {
    const dragging = transitionDrag(transitionDrag(IDLE_DRAG, arm()), { type: "trip" });
    expect(transitionDrag(dragging, { type: "reset" })).toEqual(IDLE_DRAG);
  });
});

describe("the shared drag state", () => {
  test("the singleton is driven through dispatchDrag and reset by resetDragState", () => {
    resetDragState();
    expect(dragState()).toEqual(IDLE_DRAG);
    dispatchDrag(arm({ ctrl: true }));
    expect(dragKeys(dragState())).toEqual(keys);
    expect(dragCtrl(dragState())).toBe(true);
    resetDragState();
    expect(dragState()).toEqual(IDLE_DRAG);
    expect(dragKeys(dragState())).toBeNull();
  });
});
