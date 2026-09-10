import { describe, expect, test } from "bun:test";
import { tdzSafe } from "./plugins";

describe("tdzSafe", () => {
  test("passes the getter value through when healthy", () => {
    expect(tdzSafe(() => 42, 0)()).toBe(42);
  });

  test("a throwing getter (TDZ pre-init access) yields the fallback, never throws", () => {
    // mirrors index.ts: `keymap` is a const initialized after wirePlugins
    // scans, so an eager api.commands() at activate top level would throw a
    // ReferenceError without the guard
    const read = (): string[] => keymap.commands();
    expect(() => read()).toThrow(ReferenceError);
    expect(tdzSafe(read, [] as string[])()).toEqual([]);
    const keymap = { commands: () => ["quit"] };
    expect(tdzSafe(read, [] as string[])()).toEqual(["quit"]);
  });
});
