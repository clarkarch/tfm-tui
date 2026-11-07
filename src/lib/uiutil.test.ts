import { describe, expect, test } from "bun:test";
import { BoxRenderable, TextRenderable } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import {
  advanceCursor,
  cursorAt,
  cursorIndex,
  debounced,
  destroyChildren,
  destroyNode,
  invokeIsolated,
  NO_CURSOR,
  safeRenderStep,
  stripControlChars,
  withTimeout,
  type Cursor,
  type Scheduler,
} from "./uiutil";

// Bun 1.3.14 has no fake timers, so debounced takes an injected Scheduler:
// these tests advance a virtual clock and never race the wall clock (a
// fixed-sleep version of the trails test flaked red under parallel load).
const mkClock = () => {
  let now = 0;
  let id = 0;
  const timers = new Map<number, { at: number; cb: () => void }>();
  const sched: Scheduler = {
    setTimeout: (cb, ms) => {
      timers.set(++id, { at: now + ms, cb });
      return id;
    },
    clearTimeout: (h) => {
      timers.delete(h as number);
    },
  };
  const advance = (ms: number) => {
    const target = now + ms;
    for (const [k, t] of [...timers]) {
      if (t.at <= target) {
        timers.delete(k);
        now = t.at;
        t.cb();
      }
    }
    now = target;
  };
  return { sched, advance, pending: () => timers.size };
};

// Fakes mirror the REAL collaborator contract (opentui/core Renderable):
// destroy() DETACHES this node's children without destroying them — only the
// recursive API walks down. The helper has to do the walking, so a fake whose
// destroy() recursed would make these tests lie.
const mkNode = (id: string, destroyed: string[], kids: any[] = []): any => {
  const node: any = {
    id,
    getChildren: () => [...kids],
    remove: (c: any) => {
      const i = kids.indexOf(c);
      if (i >= 0) kids.splice(i, 1);
    },
    destroy: () => {
      destroyed.push(id);
      kids.length = 0; // real destroy() clears the child list
    },
  };
  return node;
};

describe("destroyChildren", () => {
  test("removes AND destroys every child (native buffers freed now, not at the GC poke)", () => {
    const removed: any[] = [];
    const destroyed: any[] = [];
    const mkKid = (id: string) => ({ id, destroy: () => destroyed.push(id) });
    const kids = [mkKid("a"), mkKid("b")];
    const node = {
      getChildren: () => [...kids],
      remove: (c: any) => removed.push(c),
    };
    destroyChildren(node);
    expect(removed).toEqual(kids);
    expect(destroyed).toEqual(["a", "b"]);
  });

  test("frees the whole SUBTREE — OpenTUI's destroy() only detaches its own children", () => {
    // content -> inner -> row -> tiles, exactly the grid's shape: a one-level
    // destroy freed `inner` and left every tile's TextBuffer alive until the
    // GC poke (the leak this helper exists for)
    const destroyed: string[] = [];
    const tiles = [mkNode("tile0", destroyed), mkNode("tile1", destroyed)];
    const row = mkNode("row", destroyed, tiles);
    const inner = mkNode("inner", destroyed, [row]);
    const content = mkNode("content", destroyed, [inner]);

    destroyChildren(content);

    expect(destroyed).toEqual(["tile0", "tile1", "row", "inner"]); // bottom-up
    expect(content.getChildren()).toEqual([]);
  });

  test("destroyNode frees one node's subtree (the window-slide row reap)", () => {
    const destroyed: string[] = [];
    const tile = mkNode("tile", destroyed);
    const row = mkNode("row", destroyed, [tile]);
    destroyNode(row);
    expect(destroyed).toEqual(["tile", "row"]);
  });

  test("a `keep` child is removed but NOT destroyed, subtree and all (the preview pane re-adds it)", () => {
    const destroyed: string[] = [];
    const keepKid = mkNode("cached-kid", destroyed);
    const keep = mkNode("cached", destroyed, [keepKid]);
    const other = mkNode("header", destroyed);
    const host = mkNode("pane", destroyed, [other, keep]);

    destroyChildren(host, keep);

    expect(host.getChildren()).toEqual([]); // both detached
    expect(destroyed).toEqual(["header"]); // only the non-keep one freed
    expect(keep.getChildren()).toEqual([keepKid]); // the cached node survives whole
  });

  test("tolerates null nodes, children without destroy, and throwing destroy", () => {
    expect(() => destroyChildren(null)).not.toThrow();
    expect(() => destroyChildren(undefined)).not.toThrow();
    expect(() => destroyChildren({ getChildren: () => [{}, {}], remove: () => {} })).not.toThrow();
    expect(() => destroyNode(undefined)).not.toThrow();
    expect(() =>
      destroyChildren({
        getChildren: () => [
          {
            destroy: () => {
              throw new Error("already dead");
            },
          },
        ],
        remove: () => {},
      }),
    ).not.toThrow();
    // a node whose getChildren throws still gets destroyed, never rethrown
    expect(() =>
      destroyNode({
        getChildren: () => {
          throw new Error("dead");
        },
        destroy: () => {},
      }),
    ).not.toThrow();
  });
});

// The fake contract above is an ASSUMPTION about OpenTUI that the whole fix
// rests on, so pin it against the real renderable: destroy() must be shown to
// leave grandchildren alive, and destroyChildren must then free them.
describe("destroyChildren against real renderables", () => {
  test("the subtree of a destroyed node survives (the premise), and destroyChildren then frees it", async () => {
    const setup = await createTestRenderer({ width: 20, height: 5 });
    const { renderer, renderOnce } = setup;
    const content = new BoxRenderable(renderer, { id: "rev-content" });
    const inner = new BoxRenderable(renderer, { id: "rev-inner" });
    const row = new BoxRenderable(renderer, { id: "rev-row" });
    const text = new TextRenderable(renderer, { id: "rev-text", content: "hi" });
    renderer.root.add(content);
    content.add(inner);
    inner.add(row);
    row.add(text);

    // premise: OpenTUI's destroy() detaches its own children WITHOUT destroying
    // them — a one-level teardown left this text alive (the real leak)
    const probeText = new TextRenderable(renderer, { id: "rev-probe-text", content: "probe" });
    const probeRow = new BoxRenderable(renderer, { id: "rev-probe-row" });
    row.add(probeRow);
    probeRow.add(probeText);
    await renderOnce();
    probeRow.destroy();
    expect(probeText.isDestroyed).toBe(false);

    destroyChildren(content);
    expect(inner.isDestroyed).toBe(true);
    expect(row.isDestroyed).toBe(true);
    expect(text.isDestroyed).toBe(true);
    await setup.dispose(); // 0.6.0: destroy + await closed
  });
});

describe("debounced", () => {
  test("trails: every call pushes the run back, body sees latest closure state", () => {
    const { sched, advance, pending } = mkClock();
    let state = "a";
    let runs = 0;
    const run = debounced(
      30,
      () => {
        runs++;
        state += "!";
      },
      sched,
    );
    run();
    advance(10);
    state = "b";
    run(); // pushes the pending run back
    advance(10);
    expect(runs).toBe(0); // still waiting
    advance(40);
    expect(runs).toBe(1);
    expect(state).toBe("b!"); // body read the latest state when it fired
    expect(pending()).toBe(0);
  });

  test("without new calls it fires exactly once", () => {
    const { sched, advance } = mkClock();
    let runs = 0;
    const run = debounced(20, () => runs++, sched);
    run();
    advance(1000);
    expect(runs).toBe(1);
    advance(1000);
    expect(runs).toBe(1);
  });

  test("cancel drops the pending run (a cleared operation leaves no work behind)", () => {
    const { sched, advance, pending } = mkClock();
    let runs = 0;
    const run = debounced(20, () => runs++, sched);
    run();
    expect(pending()).toBe(1);
    run.cancel();
    expect(pending()).toBe(0);
    advance(1000);
    expect(runs).toBe(0); // the body never ran
  });

  test("default scheduler still works against the real clock", async () => {
    let runs = 0;
    const run = debounced(5, () => runs++);
    run();
    await Bun.sleep(50);
    expect(runs).toBe(1);
  });
});

describe("withTimeout", () => {
  test("resolves with the value and clears its timer", async () => {
    const { sched, advance, pending } = mkClock();
    const p = withTimeout(Promise.resolve("ok"), 5000, sched);
    advance(1);
    await expect(p).resolves.toBe("ok");
    expect(pending()).toBe(0);
  });

  test("rejects with the inner error and clears its timer", async () => {
    const { sched, advance, pending } = mkClock();
    const p = withTimeout(Promise.reject(new Error("inner")), 5000, sched);
    advance(1);
    await expect(p).rejects.toThrow("inner");
    expect(pending()).toBe(0);
  });

  test("times out a hanging promise and clears nothing stale", async () => {
    const { sched, advance, pending } = mkClock();
    const p = withTimeout(new Promise(() => {}), 5000, sched);
    const settled: string[] = [];
    p.then(
      () => settled.push("resolved"),
      (e: unknown) => settled.push(`rejected:${e instanceof Error ? e.message : e}`),
    );
    expect(settled).toEqual([]);
    advance(4999);
    await Promise.resolve();
    expect(settled).toEqual([]);
    advance(1);
    await Promise.resolve();
    expect(settled).toEqual(["rejected:timeout"]);
    expect(pending()).toBe(0);
  });
});

describe("invokeIsolated", () => {
  test("sync return passes through silently", () => {
    const errs: unknown[] = [];
    expect(() =>
      invokeIsolated(
        () => 42,
        (e: unknown) => errs.push(e),
      ),
    ).not.toThrow();
    expect(errs).toEqual([]);
  });

  test("sync throw is reported, not rethrown", () => {
    const errs: unknown[] = [];
    expect(() =>
      invokeIsolated(
        () => {
          throw new Error("sync-boom");
        },
        (e: unknown) => errs.push(e),
      ),
    ).not.toThrow();
    expect(errs.length).toBe(1);
  });

  test("async rejection is reported (no unhandled rejection)", async () => {
    const errs: unknown[] = [];
    invokeIsolated(
      async () => {
        throw new Error("async-boom");
      },
      (e: unknown) => errs.push(e),
    );
    await Bun.sleep(10);
    expect(errs.length).toBe(1);
    expect(String(errs[0])).toContain("async-boom");
  });

  test("a throwing reporter never propagates", async () => {
    expect(() =>
      invokeIsolated(
        async () => {
          throw new Error("x");
        },
        () => {
          throw new Error("reporter-boom");
        },
      ),
    ).not.toThrow();
    await Bun.sleep(10);
  });
});

describe("safeRenderStep", () => {
  test("sync throw is logged, not thrown", () => {
    const logs: string[] = [];
    expect(() =>
      safeRenderStep(
        "step",
        () => {
          throw new Error("boom");
        },
        (m) => logs.push(m),
      ),
    ).not.toThrow();
    expect(logs.length).toBe(1);
    // logged as `render <name>: <stack-or-error>`
    expect(logs[0]).toContain("render step:");
    expect(logs[0]).toContain("boom");
  });

  test("async rejection is caught and logged", async () => {
    const logs: string[] = [];
    safeRenderStep(
      "async-step",
      async () => {
        throw new Error("late boom");
      },
      (m) => logs.push(m),
    );
    await Bun.sleep(20);
    expect(logs.length).toBe(1);
    expect(logs[0]).toContain("render async-step (async):");
    expect(logs[0]).toContain("late boom");
  });

  test("happy path runs the fn", () => {
    let ran = false;
    safeRenderStep("ok", () => {
      ran = true;
    });
    expect(ran).toBe(true);
  });
});

describe("stripControlChars", () => {
  test("drops C0/C1 + DEL but keeps tab/CR/LF (the 0.6.0 Input-legal set)", () => {
    // 0.6.0 Input value/initialValue/edits throw NativeError on any other
    // control char — seeds (filenames, pasted URLs, gio output) must pass
    // through this or a weird name crashes the dialog at construction
    expect(stripControlChars("a\x00b\x01c\x1bd\x7fe")).toBe("abcde");
    expect(stripControlChars("a\x80b\x9fc")).toBe("abc");
    expect(stripControlChars("a\tb\rc\nd")).toBe("a\tb\rc\nd");
    expect(stripControlChars("plain")).toBe("plain");
    expect(stripControlChars("")).toBe("");
  });

  test("boundary codes: 08/0B/0C/1F drop, 20/7E/A0 stay, surrogates survive", () => {
    // every C0 except 09/0A/0D drops, including the whitespace-adjacent ones
    expect(stripControlChars("\x08\x0b\x0c\x1f")).toBe("");
    // printable ASCII edges + NBSP (U+00A0, first code above the C1 band)
    expect(stripControlChars(" \x7e\u00a0")).toBe(" \x7e\u00a0");
    // astral chars ride UTF-16 surrogate pairs — checked per unit, and
    // surrogates (D800-DFFF) are outside every drop band, so the pair
    // survives intact (no half-surrogate output)
    expect(stripControlChars("a\u{10000}b\u0085c")).toBe("a\u{10000}bc");
  });
});

// --- The floating-list cursor: ONE vocabulary for "no row highlighted" and
// "row N is highlighted". `-1` was the implicit sentinel every consumer
// re-implemented on its own; a consumer that forgot the guard indexed
// entries[-1] -> undefined -> a SILENT no-op. ---
describe("Cursor", () => {
  test("cursorAt/cursorIndex round-trip, and a negative index means NO cursor", () => {
    expect(cursorAt(3)).toEqual({ kind: "row", index: 3 });
    expect(cursorAt(-1)).toEqual({ kind: "none" });
    expect(cursorIndex(NO_CURSOR)).toBe(-1);
    expect(cursorIndex(cursorAt(2))).toBe(2);
    // the NONE sentinel is a distinct value, never a magic -1 row
    expect(NO_CURSOR.kind).toBe("none");
  });

  test("from NO cursor, down fills the FIRST row and up fills the LAST", () => {
    expect(advanceCursor(NO_CURSOR, 1, 3)).toEqual({ kind: "row", index: 0 });
    expect(advanceCursor(NO_CURSOR, -1, 3)).toEqual({ kind: "row", index: 2 });
  });

  test("from a row it wraps in both directions", () => {
    expect(advanceCursor(cursorAt(2), 1, 3)).toEqual({ kind: "row", index: 0 });
    expect(advanceCursor(cursorAt(0), -1, 3)).toEqual({ kind: "row", index: 2 });
    expect(advanceCursor(cursorAt(0), 1, 3)).toEqual({ kind: "row", index: 1 });
  });

  test("separators are skipped (bounded — an all-separator list cannot spin)", () => {
    const entries = [{ sep: true }, { sep: false }, { sep: true }];
    expect(advanceCursor(NO_CURSOR, 1, 3, entries)).toEqual({ kind: "row", index: 1 });
    expect(advanceCursor(cursorAt(1), 1, 3, entries)).toEqual({ kind: "row", index: 1 });
    // every entry is a separator: the walk is bounded and lands somewhere
    const allSep = [{ sep: true }, { sep: true }];
    expect(advanceCursor(NO_CURSOR, 1, 2, allSep).kind).toBe("row");
  });

  test("an EMPTY list yields NO cursor — it can never point at a row", () => {
    expect(advanceCursor(NO_CURSOR, 1, 0)).toEqual({ kind: "none" });
    expect(advanceCursor(cursorAt(4), -1, 0)).toEqual({ kind: "none" });
  });

  test("a cursor is a VALUE, so a stale index can never be mistaken for a row", () => {
    // the old sentinel made `idx` a number where -1 was "none" and every
    // other number was "a row" — a consumer that forgot the guard indexed
    // entries[-1] and got a silent no-op
    const c: Cursor = NO_CURSOR;
    expect(c.kind === "row").toBe(false);
  });
});
