import { describe, expect, test } from "bun:test";
import { makeSearch } from "./search";

const stubInput = () => {
  const listeners: Record<string, (() => void)[]> = {};
  return {
    visible: false,
    value: "",
    focused: false,
    focus() {
      this.focused = true;
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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("makeSearch", () => {
  test("beginTypeToSearch seeds the query, shows + focuses the box", async () => {
    const el = stubInput();
    let renders = 0;
    const search = makeSearch({
      byId: (id) => (id === "tfm-search" ? el : null),
      renderGrid: () => {
        renders++;
      },
      termHasFocus: () => false,
    });
    search.beginTypeToSearch("a");
    expect(search.getQuery()).toBe("a");
    expect(el.visible).toBe(true);
    expect(el.value).toBe("a");
    expect(renders).toBe(1);
    await sleep(30); // focus is deferred 10ms
    expect(el.focused).toBe(true);
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
    });
    search.beginTypeToSearch("a");
    expect(search.getQuery()).toBe("");
    expect(el.visible).toBe(false);
    expect(renders).toBe(0);
  });

  test("clearSearch resets query and hides the box", () => {
    const el = stubInput();
    const search = makeSearch({
      byId: (id) => (id === "tfm-search" ? el : null),
      renderGrid: () => {},
      termHasFocus: () => false,
    });
    search.beginTypeToSearch("x");
    search.clearSearch();
    expect(search.getQuery()).toBe("");
    expect(el.value).toBe("");
    expect(el.visible).toBe(false);
  });

  test("missing/malformed search node never throws", () => {
    const search = makeSearch({
      byId: () => null,
      renderGrid: () => {},
      termHasFocus: () => false,
    });
    expect(() => {
      search.beginTypeToSearch("a");
      search.clearSearch();
    }).not.toThrow();
  });

  test("wireSearchInput mirrors typed text into the query (debounced render)", async () => {
    const el = stubInput();
    let renders = 0;
    const search = makeSearch({
      byId: (id) => (id === "tfm-search" ? el : null),
      renderGrid: () => {
        renders++;
      },
      termHasFocus: () => false,
    });
    search.wireSearchInput();
    el.value = "report";
    el.fire("input");
    expect(search.getQuery()).toBe("report");
    expect(renders).toBe(0); // debounced, not yet
    await sleep(200);
    expect(renders).toBe(1);
  });

  test("wireSearchInput without a node is a no-op", () => {
    const search = makeSearch({ byId: () => null, renderGrid: () => {}, termHasFocus: () => false });
    expect(() => search.wireSearchInput()).not.toThrow();
  });
});
