import { describe, expect, test } from "bun:test";
import {
  BENIGN_FULL_PATH,
  FULL_PATH_IMAGES,
  FULL_PATH_NON_LOCAL,
  FULL_PATH_OPTIONS,
  FULL_PATH_SCREEN,
  FULL_PATH_TAINTED,
  FULL_PATH_UNRETAINED,
  fullPathNames,
  makePaintWatch,
  paintLine,
  startPaintTrace,
  type FrameWork,
} from "./frame-stats";

// The native renderer reports WHY a frame took the full repaint path. The
// names are the debug log's vocabulary, so they must stay stable and
// greppable — a rename here silently breaks every log grep.

describe("fullPathNames", () => {
  test("names every reason bit", () => {
    expect(
      fullPathNames(
        FULL_PATH_SCREEN |
          FULL_PATH_IMAGES |
          FULL_PATH_TAINTED |
          FULL_PATH_UNRETAINED |
          FULL_PATH_OPTIONS |
          FULL_PATH_NON_LOCAL,
      ),
    ).toEqual(["screen", "images", "tainted", "unretained", "options", "non-local"]);
  });

  test("an empty reason set has no names", () => {
    expect(fullPathNames(0)).toEqual([]);
  });
});

describe("paintLine", () => {
  test("a damage-only frame reports the rows it repainted", () => {
    const w: FrameWork = { damageRows: 12, fullPathReasons: 0, rowsDiffed: 12, workFrameId: 7 };
    expect(paintLine(w)).toBe("paint rows=12 diffed=12");
  });

  test("a full-repaint frame names the reasons", () => {
    const w: FrameWork = { damageRows: 40, fullPathReasons: FULL_PATH_IMAGES, rowsDiffed: 40, workFrameId: 8 };
    expect(paintLine(w)).toBe("paint rows=40 diffed=40 full=images");
  });

  test("a missing source reads n/a rather than throwing", () => {
    expect(paintLine(null)).toBe("paint n/a");
  });
});

describe("makePaintWatch", () => {
  test("a frame is reported once, even when sampled repeatedly", () => {
    let work: FrameWork | null = { damageRows: 3, fullPathReasons: 0, rowsDiffed: 3, workFrameId: 1 };
    const watch = makePaintWatch(() => work);
    expect(watch.sample()?.damageRows).toBe(3);
    expect(watch.sample()).toBeNull(); // same frame, sampled again
    work = { damageRows: 5, fullPathReasons: 0, rowsDiffed: 5, workFrameId: 2 };
    expect(watch.sample()?.damageRows).toBe(5);
    expect(watch.last?.workFrameId).toBe(2);
  });

  test("an unavailable source reports nothing and keeps the last frame", () => {
    let work: FrameWork | null = { damageRows: 4, fullPathReasons: 0, rowsDiffed: 4, workFrameId: 1 };
    const watch = makePaintWatch(() => work);
    expect(watch.sample()?.damageRows).toBe(4);
    work = null;
    expect(watch.sample()).toBeNull();
    expect(watch.last?.damageRows).toBe(4);
  });
});

describe("BENIGN_FULL_PATH", () => {
  test("covers the routine reasons (first frame, resize, the debug flag)", () => {
    expect(BENIGN_FULL_PATH & FULL_PATH_SCREEN).toBe(FULL_PATH_SCREEN);
    expect(BENIGN_FULL_PATH & FULL_PATH_UNRETAINED).toBe(FULL_PATH_UNRETAINED);
    // images and tainted are NOT benign: they mean a real full repaint.
    expect(BENIGN_FULL_PATH & FULL_PATH_IMAGES).toBe(0);
    expect(BENIGN_FULL_PATH & FULL_PATH_TAINTED).toBe(0);
  });
});

describe("startPaintTrace", () => {
  const harness = (frames: FrameWork[]) => {
    let i = -1;
    const logs: string[] = [];
    let fire: (() => void) | null = null;
    const stop = startPaintTrace({
      subscribe: (onFrame) => {
        fire = onFrame;
        return () => {
          fire = null;
        };
      },
      source: () => (i >= 0 ? (frames[Math.min(i, frames.length - 1)] ?? null) : null),
      log: (msg) => logs.push(msg),
    });
    return {
      logs,
      stop,
      frame: () => {
        if (i < frames.length - 1) i++;
        fire?.();
      },
    };
  };

  test("a frame that painted is logged", () => {
    const h = harness([{ damageRows: 24, fullPathReasons: 0, rowsDiffed: 24, workFrameId: 1 }]);
    h.frame();
    expect(h.logs).toEqual(["paint rows=24 diffed=24"]);
  });

  test("an idle frame stays silent (it painted nothing)", () => {
    const h = harness([{ damageRows: 0, fullPathReasons: 0, rowsDiffed: 0, workFrameId: 1 }]);
    h.frame();
    expect(h.logs).toEqual([]);
  });

  test("a full-repaint frame names the reason", () => {
    const h = harness([{ damageRows: 24, fullPathReasons: FULL_PATH_IMAGES, rowsDiffed: 0, workFrameId: 1 }]);
    h.frame();
    expect(h.logs).toEqual(["paint rows=24 diffed=0 full=images"]);
  });

  test("the same frame is never logged twice", () => {
    const h = harness([{ damageRows: 24, fullPathReasons: 0, rowsDiffed: 24, workFrameId: 1 }]);
    h.frame();
    h.frame(); // the same presented frame, sampled twice
    expect(h.logs).toHaveLength(1);
  });

  test("stopping unsubscribes", () => {
    const h = harness([{ damageRows: 24, fullPathReasons: 0, rowsDiffed: 24, workFrameId: 1 }]);
    h.stop();
    h.frame();
    expect(h.logs).toEqual([]);
  });
});
