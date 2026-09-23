// --- Install OpenTUI's runtime-module support exactly once, BEFORE any
// external plugin file is imported. It registers a Bun runtime plugin that
// rewrites "@opentui/core" (and friend) imports inside dynamically imported
// plugin files to the HOST's singleton, so a plugin's renderables share tfm's
// renderer instead of a second OpenTUI instance. Idempotent + best-effort:
// a failure just means plugin files can't import @opentui/core. ---

import { ensureRuntimePluginSupport } from "@opentui/core/runtime-plugin-support/configure";

let installed = false;

export const installPluginRuntimeSupport = (): boolean => {
  if (installed) return true;
  try {
    const ok = ensureRuntimePluginSupport();
    // only latch on success: a throwing first call must not make every later
    // caller report a false "installed"
    installed = ok;
    return ok;
  } catch {
    return false;
  }
};
