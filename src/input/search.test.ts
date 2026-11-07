import { describe, expect, test } from "bun:test";
import { readdirSync, statSync } from "node:fs";
import path from "node:path";
import { makeSearch } from "./search";
import type { MaybeNode } from "../lib/node-like";

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
      const i = jobs.indexOf(handle as { at: number; fn: () => void });
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
  const pointers: string[] = [];
  const search = makeSearch({
    byId: (id) => (id === "tfm-search" ? (el as unknown as MaybeNode) : null),
    inputId: "tfm-search",
    renderGrid: () => {
      renders++;
    },
    termHasFocus: () => false,
    sched: clock,
    setPointer: (s) => void pointers.push(s),
  });
  return { el, clock, search, renders: () => renders, pointers };
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

  test("begin sets the text pointer, clear restores default", () => {
    const h = makeHarness();
    h.search.beginTypeToSearch("a");
    expect(h.pointers).toEqual(["text"]);
    h.search.clearSearch();
    expect(h.pointers).toEqual(["text", "default"]);
  });

  test("termHasFocus guard: the shell keeps the keyboard", () => {
    const el = stubInput();
    let renders = 0;
    const search = makeSearch({
      byId: (id) => (id === "tfm-search" ? (el as unknown as MaybeNode) : null),
      inputId: "tfm-search",
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

  test("clearSearch leaves the box unfocused (a closed search never steals the focus back)", () => {
    const h = makeHarness();
    h.search.beginTypeToSearch("x");
    expect(h.el.focused).toBe(true);
    h.search.clearSearch();
    expect(h.el.focused).toBe(false); // the close blurs it
    h.clock.advance(30);
    expect(h.el.focused).toBe(false); // and nothing focuses it again
  });

  test("missing/malformed search node never throws", () => {
    const search = makeSearch({
      byId: () => null,
      inputId: "tfm-search",
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
    // the input only receives typed text while the search OWNS the keyboard,
    // so the search is open first (the production sequence)
    h.search.beginTypeToSearch("r");
    const before = h.renders();
    h.el.value = "report";
    h.el.fire("input");
    expect(h.search.getQuery()).toBe("report");
    expect(h.renders()).toBe(before); // debounced, not yet
    h.clock.advance(200);
    expect(h.renders()).toBe(before + 1);
  });

  test("wireSearchInput without a node is a no-op", () => {
    const search = makeSearch({
      byId: () => null,
      inputId: "tfm-search",
      renderGrid: () => {},
      termHasFocus: () => false,
      sched: makeClock(),
    });
    expect(() => search.wireSearchInput()).not.toThrow();
  });
});

// --- the search's open state: ONE owner, in the MODULE ---
//
// "The search is open" used to be TWO truths: the module owned the QUERY,
// while the router read the input NODE's `visible` flag (and the toolbar's
// search button flipped that flag itself — a third writer). Worse, the
// focus was DEFERRED by 10 ms: in that window the router believed the
// search owned the keys (the box was visible) while the input did not have
// the focus, so the first character typed after opening was swallowed and
// lost.
//
// The module now owns the state; the node is its projection.

describe("the search state", () => {
  test("the input is focused SYNCHRONOUSLY (no window where the keys go nowhere)", () => {
    const h = makeHarness();
    h.search.beginTypeToSearch("a");
    // NO clock advance: the focus must have landed already — a deferred
    // focus leaves a window where the search swallows the keys and the
    // input never sees them
    expect(h.el.focused).toBe(true);
  });

  test("clearing the search cancels the pending re-render", () => {
    const h = makeHarness();
    h.search.wireSearchInput();
    // the search owns the keyboard, so the typed text arms the debounced
    // re-render of the filtered grid
    h.search.beginTypeToSearch("r");
    h.el.value = "report";
    h.el.fire("input");
    const before = h.renders();
    h.search.clearSearch();
    h.clock.advance(500);
    expect(h.renders()).toBe(before); // the pending render was dropped
  });

  test("the open state is the module's, not the node's visible flag", () => {
    const h = makeHarness();
    // `isOpen` is the NEW reader (the module state). The optional call keeps
    // this file loadable while the reader lands — the assertion below fails
    // for the RIGHT reason (the reader does not exist yet), not with a
    // module-load error.
    const isOpen = (): boolean => (h.search as unknown as { isOpen?: () => boolean }).isOpen?.() ?? false;
    expect(isOpen()).toBe(false);
    h.search.beginTypeToSearch("a");
    expect(isOpen()).toBe(true);
    // the node's flag went stale (something hid the box) — the module still
    // owns the search, so the router must not read the node
    h.el.visible = false;
    expect(isOpen()).toBe(true);
    h.search.clearSearch();
    expect(isOpen()).toBe(false);
  });

  test("a closed search ignores a stray input event", () => {
    // the clear writes an empty value back into the node, which fires the
    // input event — a closed search must not resurrect a query
    const h = makeHarness();
    h.search.wireSearchInput();
    h.search.beginTypeToSearch("ab");
    h.search.clearSearch();
    h.el.value = "zzz";
    h.el.fire("input");
    expect(h.search.getQuery()).toBe("");
  });
});

describe("no-drift rule", () => {
  // The search's open state has ONE owner: the module (./search). The router
  // used to READ the input node's visible flag (a second truth) and the
  // toolbar's button WROTE it (a third writer) — with the module in charge,
  // either one lets the router's view and the box on screen disagree.
  //
  // A behavioral test cannot catch that class (the wiring is a one-liner),
  // so the rule is enforced structurally: the old forms may not come back.
  const collectTsFiles = (dir: string): string[] => {
    const out: string[] = [];
    for (const name of readdirSync(dir)) {
      const p = path.join(dir, name);
      if (statSync(p).isDirectory()) out.push(...collectTsFiles(p));
      else if (name.endsWith(".ts")) out.push(p);
    }
    return out;
  };

  test("no source file reads or writes the search input's visible flag", async () => {
    const root = path.resolve(import.meta.dir, "..");
    const offenders: string[] = [];
    for (const file of collectTsFiles(root)) {
      if (file.endsWith(".test.ts")) continue;
      // the owner writes the flag (it is the projection of the state)
      if (file === path.join(root, "input", "search.ts")) continue;
      const src = (await Bun.file(file).text()).replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
      // the old READ: byId(`tfm-p${...}-search`)?.visible
      const reads = /(tfm-p[01]-search|tfm-p\$\{[^}]*\}-search)[^;\n]*\)?\.visible/;
      // the old WRITE: const el = byId(id("search")); ... el.visible = ...
      const writes = /byId\(id\("search"\)\)\s*;[\s\S]{0,200}?\.visible\s*=/;
      if (reads.test(src) || writes.test(src)) offenders.push(path.relative(root, file));
    }
    expect(offenders).toEqual([]);
  });
});
