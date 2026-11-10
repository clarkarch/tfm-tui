// --- The boot's MODE: one value, one capture.
//
// The startup shape is chosen by [ui] lazy-startup, and the old code spelled
// that ONE fact FOUR ways:
//   - an INVERTED boolean captured in wireCore
//     (`burstStartup = config.ui.lazyStartup !== true`),
//   - a SECOND capture in wireBoot
//     (`lazyBootFlag = core.config.ui?.lazyStartup === true`),
//   - a LIVE re-read of the config in the chrome wiring (the icon warms),
//   - another LIVE re-read in the plugins wiring (the plugin scan).
//
// Two captures of OPPOSITE polarity and two live reads of the same field:
// the shape the boot runs is decided in more than one place, and a live
// config reload could flip the live reads while the captures held the old
// value.
//
// The mode is ONE value now: derived ONCE (the strict `=== true` read lives
// here, so no call site can spell it differently) and read everywhere.

import { describe, expect, test } from "bun:test";
import { bootModeFor, isLazyBoot } from "./boot-mode";

describe("the boot's mode", () => {
  test("only `true` means lazy", () => {
    expect(bootModeFor(true)).toBe("lazy");
    expect(bootModeFor(false)).toBe("classic");
    // a hand-edited config value that is not a boolean never opts in
    expect(bootModeFor(undefined)).toBe("classic");
    expect(bootModeFor("yes")).toBe("classic");
    expect(bootModeFor(1)).toBe("classic");
  });

  test("the mode names its shape", () => {
    expect(isLazyBoot("lazy")).toBe(true);
    expect(isLazyBoot("classic")).toBe(false);
  });
});
