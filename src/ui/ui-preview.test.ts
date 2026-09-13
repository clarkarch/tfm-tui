import { describe, expect, test } from "bun:test";
import { makePreview } from "./ui-preview";
import type { Scheduler } from "../lib/uiutil";

// Manual clock: debounced clears its pending handle, so a coalescing test can
// assert "N calls, one render" by flushing only what is still queued.
const mkClock = (): { sched: Scheduler; flush: () => void } => {
  let seq = 0;
  const timers = new Map<number, () => void>();
  return {
    sched: {
      setTimeout: (cb) => {
        const id = ++seq;
        timers.set(id, cb);
        return id;
      },
      clearTimeout: (h) => {
        timers.delete(h as number);
      },
    },
    flush: () => {
      const cbs = [...timers.values()];
      timers.clear();
      for (const cb of cbs) cb();
    },
  };
};

const mkPane = () => {
  const kids: any[] = [];
  return {
    node: {
      getChildren: () => kids,
      remove: (c: any) => {
        const i = kids.indexOf(c);
        if (i >= 0) kids.splice(i, 1);
      },
      add: (c: any) => {
        kids.push(c);
      },
    },
    childCount: () => kids.length,
  };
};

const COLORS: any = { sidebarFg: "#aaa", sidebarFgMuted: "#666", divider: "#333", white: "#fff", sidebarBg: "#000" };

const mkPreview = (opts: { visible: boolean; clock: ReturnType<typeof mkClock>; pane: ReturnType<typeof mkPane> }) =>
  makePreview({
    renderer: null,
    byId: () => opts.pane.node,
    colors: () => COLORS,
    uiStyle: () => "solid",
    previewEnabled: () => true,
    previewWidth: () => 40,
    visible: () => opts.visible,
    sched: opts.clock.sched,
    termH: () => 24,
    cellMetrics: () => ({ cellW: 10, cellH: 20, aspect: 0.5 }),
    focusKey: () => null,
    tileRefs: new Map(),
    pushThumbJob: () => {},
    drainThumbs: () => {},
    drainIconQueue: () => {},
    nextIconId: () => "slot",
    fallbackGlyphFor: () => "?",
  });

describe("preview visibility guard", () => {
  test("rebuilds nothing while the pane is hidden/collapsed", () => {
    const clock = mkClock();
    const pane = mkPane();
    const p = mkPreview({ visible: false, clock, pane });
    p.renderPreview();
    clock.flush();
    expect(pane.childCount()).toBe(0);
  });

  test("renders the no-selection state when visible", () => {
    const clock = mkClock();
    const pane = mkPane();
    const p = mkPreview({ visible: true, clock, pane });
    p.renderPreview();
    clock.flush();
    expect(pane.childCount()).toBeGreaterThan(0);
  });

  test("coalesces a burst into a single rebuild", () => {
    const clock = mkClock();
    const pane = mkPane();
    const p = mkPreview({ visible: true, clock, pane });
    for (let i = 0; i < 5; i++) p.renderPreview();
    clock.flush();
    const once = pane.childCount();
    // the trailing call is the only one that ran; without debounce the 5th
    // would still be queued and flush would render twice
    expect(once).toBeGreaterThan(0);
    expect(once).toBe(2); // the "no selection" Box + Text pair, exactly once
  });
});
