import { describe, expect, test } from "bun:test";
import {
  activeFacade,
  activeMapFacade,
  activeState,
  makePanePair,
  mergedMapFacade,
  otherState,
  setActivePane,
  togglePane,
} from "./panes";

describe("pane pair", () => {
  test("starts on the first pane with both states held independently", () => {
    const p = makePanePair({ cwd: "/a" }, { cwd: "/b" });
    expect(p.active).toBe(0);
    expect(activeState(p).cwd).toBe("/a");
    expect(otherState(p).cwd).toBe("/b");
  });

  test("setActivePane selects a pane; toggling flips between them", () => {
    const p = makePanePair("left", "right");
    setActivePane(p, 1);
    expect(activeState(p)).toBe("right");
    expect(otherState(p)).toBe("left");
    togglePane(p);
    expect(activeState(p)).toBe("left");
    togglePane(p);
    expect(activeState(p)).toBe("right");
  });

  test("mutating the active state does not touch the other pane", () => {
    const p = makePanePair({ cwd: "/a" }, { cwd: "/b" });
    activeState(p).cwd = "/a/sub";
    expect(otherState(p).cwd).toBe("/b");
  });
});

describe("active facade", () => {
  test("reads and writes follow the active pane", () => {
    const p = makePanePair({ cwd: "/a", n: 1 }, { cwd: "/b", n: 2 });
    const f = activeFacade(() => activeState(p));
    expect(f.cwd).toBe("/a");
    f.cwd = "/a2";
    expect(p.states[0].cwd).toBe("/a2");
    expect(p.states[1].cwd).toBe("/b");
    togglePane(p);
    expect(f.cwd).toBe("/b");
    expect(f.n).toBe(2);
  });

  test("methods are bound to the real target, not the facade", () => {
    const p = makePanePair(
      {
        v: 10,
        read(this: { v: number }) {
          return this.v;
        },
      },
      {
        v: 20,
        read(this: { v: number }) {
          return this.v;
        },
      },
    );
    const f = activeFacade(() => activeState(p));
    expect(f.read()).toBe(10);
    togglePane(p);
    expect(f.read()).toBe(20);
  });

  test("a method reference captured before a pane switch stays pane-live", () => {
    const p = makePanePair(
      {
        v: 10,
        read(this: { v: number }) {
          return this.v;
        },
      },
      {
        v: 20,
        read(this: { v: number }) {
          return this.v;
        },
      },
    );
    const f = activeFacade(() => activeState(p));
    // captured once at construction-time object build (bandCtx/menu/dnd)
    const read = f.read as () => number;
    expect(read()).toBe(10);
    togglePane(p);
    expect(read()).toBe(20);
  });

  test("overrides return a stable live value regardless of active pane", () => {
    const live = new Map<string, unknown>([["fixed", true]]);
    const p = makePanePair({ tile: new Map<string, unknown>() }, { tile: new Map<string, unknown>() });
    const f = activeFacade(() => activeState(p), { tile: live });
    expect(f.tile).toBe(live);
    togglePane(p);
    expect(f.tile).toBe(live);
  });
});

describe("active map facade", () => {
  test("forwards all map operations to the active pane's map", () => {
    const a = new Map<string, number>([["x", 1]]);
    const b = new Map<string, number>([["y", 2]]);
    const p = makePanePair(a, b);
    const f = activeMapFacade(() => activeState(p));
    expect(f.get("x")).toBe(1);
    expect(f.size).toBe(1);
    expect([...f.keys()]).toEqual(["x"]);
    f.set("z", 9);
    expect(a.get("z")).toBe(9);
    togglePane(p);
    expect(f.get("y")).toBe(2);
    expect(f.has("x")).toBe(false);
    expect([...f.keys()]).toEqual(["y"]);
  });

  test("forEach and iteration see the active pane after a switch", () => {
    const p = makePanePair(
      new Map([["a", 1]]),
      new Map([
        ["b", 2],
        ["c", 3],
      ]),
    );
    const f = activeMapFacade(() => activeState(p));
    const seen: string[] = [];
    f.forEach((_v, k) => {
      seen.push(k);
    });
    expect(seen).toEqual(["a"]);
    togglePane(p);
    seen.length = 0;
    f.forEach((_v, k) => {
      seen.push(k);
    });
    expect(seen).toEqual(["b", "c"]);
  });
});

describe("merged map facade", () => {
  test("get/has/size/iteration/forEach span every map", () => {
    const a = new Map<string, number>([["a", 1]]);
    const b = new Map<string, number>([
      ["b", 2],
      ["c", 3],
    ]);
    const f = mergedMapFacade(() => [a, b]);
    expect(f.get("a")).toBe(1);
    expect(f.get("c")).toBe(3);
    expect(f.get("missing")).toBeUndefined();
    expect(f.has("b")).toBe(true);
    expect(f.size).toBe(3);
    expect([...f.keys()].sort()).toEqual(["a", "b", "c"]);
    const seen: string[] = [];
    f.forEach((_v, k) => {
      seen.push(k);
    });
    expect(seen.sort()).toEqual(["a", "b", "c"]);
  });
});
