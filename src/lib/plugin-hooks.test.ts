import { describe, expect, test } from "bun:test";
import { makePluginHooks } from "./plugin-hooks";

describe("plugin pre-op hooks", () => {
  test("first skip wins and later hooks don't run", () => {
    const h = makePluginHooks();
    const ran: string[] = [];
    h.onBeforeFileOp(() => {
      ran.push("a");
    });
    h.onBeforeFileOp(() => {
      ran.push("b");
      return { skip: true, reason: "no" };
    });
    h.onBeforeFileOp(() => {
      ran.push("c");
    });
    expect(h.beforeFileOp({ op: "trash", paths: ["/x"] })).toEqual({ skip: true, reason: "no" });
    expect(ran).toEqual(["a", "b"]);
  });

  test("a throwing hook is isolated; no veto yields null", () => {
    const h = makePluginHooks();
    h.onBeforeFileOp(() => {
      throw new Error("boom");
    });
    expect(h.beforeFileOp({ op: "copy", paths: [] })).toBeNull();
  });

  test("skip without a reason still vetoes", () => {
    const h = makePluginHooks();
    h.onBeforeFileOp(() => ({ skip: true }));
    expect(h.beforeFileOp({ op: "move", paths: [] })).toEqual({ skip: true });
  });

  test("unsubscribe removes the hook", () => {
    const h = makePluginHooks();
    const off = h.onBeforeFileOp(() => ({ skip: true }));
    off();
    expect(h.beforeFileOp({ op: "copy", paths: [] })).toBeNull();
  });
});
