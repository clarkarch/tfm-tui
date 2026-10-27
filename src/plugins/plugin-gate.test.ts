import { describe, expect, test } from "bun:test";
import { AOT_BUILD, PLUGINS_ENABLED } from "./plugin-gate";

// The plugin gate is a BUILD-TIME switch, not a runtime one: the bundler
// injects `__TFM_BUILD_AOT__=true` for an ahead-of-time build
// (`bun build --define __TFM_BUILD_AOT__=true --compile`). A normal build
// never sees the define, so the plugin loader stays fully enabled.
//
// These tests run against a NORMAL build — they pin the default side of the
// gate. The AOT side is verified by the aot-experiment workflow, which builds
// with the define and asserts the same constants flip.

describe("plugin build gate", () => {
  test("a normal build is not an AOT build", () => {
    expect(AOT_BUILD).toBe(false);
  });

  test("plugins stay enabled in a normal build", () => {
    expect(PLUGINS_ENABLED).toBe(true);
  });
});
