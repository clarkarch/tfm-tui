import { describe, expect, test } from "bun:test";
import { makeTeardownState } from "./teardown-state";

// The teardown lifecycle has ONE owner. Before this, "the app is shutting
// down" was three unrelated booleans (quitOnce / rendererTornDown / the exit
// chain) and a held ctrl+q ran the whole teardown twice.
describe("teardown state", () => {
  test("the first caller wins the transition", () => {
    const s = makeTeardownState();
    expect(s.get()).toBe("live");
    expect(s.begin()).toBe(true);
    expect(s.get()).toBe("tearing-down");
    // the second caller is refused — ONE teardown, not two
    expect(s.begin()).toBe(false);
    expect(s.get()).toBe("tearing-down");
  });

  test("finish moves to exited and begin stays refused", () => {
    const s = makeTeardownState();
    s.begin();
    s.finish();
    expect(s.get()).toBe("exited");
    expect(s.begin()).toBe(false);
  });

  test("abort returns a failed restart to live", () => {
    const s = makeTeardownState();
    s.begin();
    s.abort();
    expect(s.get()).toBe("live");
    expect(s.begin()).toBe(true);
  });

  test("abort only reverts a teardown in flight", () => {
    const s = makeTeardownState();
    s.begin();
    s.finish();
    s.abort();
    expect(s.get()).toBe("exited");
  });

  test("abort on a live app is a no-op", () => {
    const s = makeTeardownState();
    s.abort();
    expect(s.get()).toBe("live");
    expect(s.begin()).toBe(true);
  });
});
