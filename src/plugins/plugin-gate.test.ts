import { describe, expect, test } from "bun:test";
import {
  AOT_BUILD,
  PLUGINS_ENABLED,
  PLUGINS_DISABLED_REASON,
  pluginsDisabledReasonFor,
  pluginsEnabledFor,
} from "./plugin-gate";

// The plugin gate is a BUILD-TIME switch, not a runtime one: the bundler
// injects `__TFM_BUILD_AOT__=true` for an ahead-of-time build
// (`bun build --define __TFM_BUILD_AOT__=true --compile`) and
// `__TFM_BUILD_AOT_DISK_CODE__=true` for an ahead-of-time build that was
// given `--aot-allow-code-from-disk`. A normal build never sees the
// defines, so the plugin loader stays fully enabled.
//
// What the loader may do depends on what the BUILD opted in to, not on
// whether the build asked for AOT:
//
//   * a JIT build carries a transpiler — plugins work.
//   * an AOT build WITHOUT --aot-allow-code-from-disk did not opt in to
//     running code from disk — the loader stays off.
//   * an AOT build WITH --aot-allow-code-from-disk did opt in — the loader
//     stays on.
//
// The gate is a POLICY, and the reason it gives has to be honest about
// that. The AOT "seal" is not a whole-program property: it is the
// runtime's own disk-code path (Bun's `createNotInExecutableError`, src/
// jsc/bindings/BunCompiledModules.cpp:629-648). A Bun plugin that SERVES
// the source itself (an onLoad that returns the file's text) never goes
// through that path — OpenTUI's runtime-module support is exactly such a
// plugin, so a sealed build can in fact load a plugin. The gate therefore
// follows the build's opt-in, and the message names the FLAG — it must
// not claim that the binary is incapable of loading code from disk.
//
// These tests run against a NORMAL build — they pin the default side of
// the gate. The AOT side is verified by the aot-experiment workflow, which
// builds with the defines and asserts the same constants flip.

describe("plugin build gate", () => {
  test("a normal build is not an AOT build", () => {
    expect(AOT_BUILD).toBe(false);
  });

  test("plugins stay enabled in a normal build", () => {
    expect(PLUGINS_ENABLED).toBe(true);
  });

  test("an enabled build has no disabled reason", () => {
    expect(PLUGINS_DISABLED_REASON).toBeNull();
  });
});

describe("plugin gate decision", () => {
  test("a JIT build loads plugins (it carries a transpiler)", () => {
    expect(pluginsEnabledFor(false, false)).toBe(true);
  });

  test("an AOT build without --aot-allow-code-from-disk does not load plugins", () => {
    expect(pluginsEnabledFor(true, false)).toBe(false);
  });

  test("an AOT build with --aot-allow-code-from-disk loads plugins", () => {
    expect(pluginsEnabledFor(true, true)).toBe(true);
  });

  test("the disk-code flag alone does not change a JIT build", () => {
    expect(pluginsEnabledFor(false, true)).toBe(true);
  });
});

describe("the disabled reason", () => {
  test("a JIT build has no reason", () => {
    expect(pluginsDisabledReasonFor(false, false)).toBeNull();
  });

  test("an AOT build with --aot-allow-code-from-disk has no reason", () => {
    expect(pluginsDisabledReasonFor(true, true)).toBeNull();
  });

  test("an AOT build without the flag names the flag that would change it", () => {
    const reason = pluginsDisabledReasonFor(true, false);
    expect(reason).toContain("--aot-allow-code-from-disk");
  });

  test("the reason does not claim the binary cannot load code from disk", () => {
    // the seal is the runtime's own disk path; a plugin that serves the
    // source bypasses it. A message that says the binary "cannot" would be
    // a false statement about what the build can do.
    const reason = pluginsDisabledReasonFor(true, false) ?? "";
    expect(reason).not.toContain("cannot load code from disk");
  });
});
