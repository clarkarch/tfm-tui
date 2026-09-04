import { describe, expect, test } from "bun:test";
import { makeSearch } from "./search";

// virtual scheduler: no wall-clock sleeps — the focus timer and the debounced
// render both fire when the test advances the clock
const makeClock = () => {
  const jobs: { at: number; fn: () => void }[] = [];
  let now = 0;
  const api = {
    setTimeout(cb: () => void, ms: number): unknown {
      const job = { at: now + ms, fn: cb };
      jobs.push(job);
      return job;
    },
    clearTimeout(handle: unknown): void {
      const i = jobs.findIndex((j) => j === handle);
      if (i >= 0) jobs.splice(i, 1);
    },
    advance(ms: number): void {
      const end = now + ms;
      for (;;) {
        jobs.sort((a, b) => a.at - b.at);
        const next = jobs[0];
        if (!next || next.at > end) break;
        now = next.at;
        jobs.shift()!.fn();
      }
      now = end;
    },
  };
  return api;
};

const stubInput = () => {
  const listeners: Record<string, (() => void)[]> = {};
  return {
    visible: false,
    value: "",
    focused: false,
    blurred: 0,
    focus() {
      this.focused = true;
    },
    blur() {
      this.focused = false;
      this.blurred++;
    },
    on(ev: string, fn: () => void) {
      // biome-ignore lint/suspicious/noAssignInExpressions: init-on-first-use idiom
      (listeners[ev] ??= []).push(fn);
    },
    fire(ev: string) {
      for (const fn of listeners[ev] ?? []) fn();
    },
    hasOn: true,
  };
};

const makeHarness = () => {
  const el = stubInput();
  const clock = makeClock();
  let renders = 0;
  const search = makeSearch({
    byId: (id) => (id === "tfm-search" ? el : null),
    renderGrid: () => {
      renders++;
    },
    termHasFocus: () => false,
    sched: clock,
  });
  return { el, clock, search, renders: () => renders };
};

describe("makeSearch", () => {
  test("beginTypeToSearch seeds the query, shows + focuses the box", () => {
    const h = makeHarness();
    h.search.beginTypeToSearch("a");
    expect(h.search.getQuery()).toBe("a");
    expect(h.el.visible).toBe(true);
    expect(h.el.value).toBe("a");
    expect(h.renders()).toBe(1);
    h.clock.advance(30); // focus is deferred 10ms
    expect(h.el.focused).toBe(true);
  });

  test("termHasFocus guard: the shell keeps the keyboard", () => {
    const el = stubInput();
    let renders = 0;
    const search = makeSearch({
      byId: (id) => (id === "tfm-search" ? el : null),
      renderGrid: () => {
        renders++;
      },
      termHasFocus: () => true,
      sched: makeClock(),
    });
    search.beginTypeToSearch("a");
    expect(search.getQuery()).toBe("");
    expect(el.visible).toBe(false);
    expect(renders).toBe(0);
  });

  test("clearSearch blurs the hidden box so it cannot eat keys invisibly", () => {
    // clearSearch used to only hide the input; it kept renderer focus and its
    // input handler kept updating searchQuery — the folder filtered with no
    // visible box and no structural escape (the type-to-search catch-all
    // requires searchVisible(), the keymap never sees the key)
    const h = makeHarness();
    h.search.beginTypeToSearch("x");
    h.clock.advance(30); // focus lands
    expect(h.el.focused).toBe(true);
    h.search.clearSearch();
    expect(h.search.getQuery()).toBe("");
    expect(h.el.value).toBe("");
    expect(h.el.visible).toBe(false);
    expect(h.el.focused).toBe(false); // THE fix
  });

  test("clearSearch cancels the pending focus timer (no focus after hide)", () => {
    const h = makeHarness();
    h.search.beginTypeToSearch("x");
    h.search.clearSearch(); // before the 10ms focus timer fires
    h.clock.advance(30);
    expect(h.el.focused).toBe(false); // a hidden box must never steal focus
  });

  test("missing/malformed search node never throws", () => {
    const search = makeSearch({
      byId: () => null,
      renderGrid: () => {},
      termHasFocus: () => false,
      sched: makeClock(),
    });
    expect(() => {
      search.beginTypeToSearch("a");
      search.clearSearch();
    }).not.toThrow();
  });

  test("wireSearchInput mirrors typed text into the query (debounced render)", () => {
    const h = makeHarness();
    h.search.wireSearchInput();
    h.el.value = "report";
    h.el.fire("input");
    expect(h.search.getQuery()).toBe("report");
    expect(h.renders()).toBe(0); // debounced, not yet
    h.clock.advance(200);
    expect(h.renders()).toBe(1);
  });

  test("wireSearchInput without a node is a no-op", () => {
    const search = makeSearch({
      byId: () => null,
      renderGrid: () => {},
      termHasFocus: () => false,
      sched: makeClock(),
    });
    expect(() => search.wireSearchInput()).not.toThrow();
  });
});
