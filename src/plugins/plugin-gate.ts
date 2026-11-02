// --- Build-time gate for the plugin loader.
//
// A plugin is a TypeScript file on disk that the loader imports at runtime.
// Whether the loader may run it depends on what the BUILD opted in to, not
// on whether the build asked for ahead-of-time compilation:
//
//   * a JIT build (`bun build --compile`) carries a transpiler: the loader
//     imports a plugin file and Bun compiles it — plugins work.
//   * an AOT build WITHOUT `--aot-allow-code-from-disk` did not opt in to
//     running code from disk. The loader stays off.
//   * an AOT build WITH `--aot-allow-code-from-disk` may load code from
//     disk (Bun interprets it — see Bun's `aot_options.rs`: "a path that is
//     known only at run time may name a file with code that the build has
//     not seen. Bun interprets it."). The loader stays ON.
//
// The gate is a POLICY, and the reason it gives has to be honest about
// that. The AOT "seal" is NOT a whole-program property — it is the
// runtime's own disk-code path (Bun's `createNotInExecutableError`, src/
// jsc/bindings/BunCompiledModules.cpp:629-648, reached through
// `errorIfCodeOutsideImageIsRefused`). A Bun plugin that SERVES the
// source itself (an onLoad that returns the file's text) never goes
// through that path: the runtime never reads the file, the plugin hands
// it over. OpenTUI's runtime-module support is exactly such a plugin, so
// a sealed AOT build can in fact load a plugin — measured, see
// `scripts/aot-probe-plugin-seal.ts`.
//
// So "this build cannot load code from disk" would be a false statement.
// What is true — and what the build decides — is "this build was not
// given --aot-allow-code-from-disk". The release build does not make that
// promise, so the release build does not offer plugins.
//
// The switch is injected by the bundler, so ONE source tree serves every
// build:
//
//   __TFM_BUILD_AOT__            true in an ahead-of-time build
//   __TFM_BUILD_AOT_DISK_CODE__  true in an ahead-of-time build that was
//                                given --aot-allow-code-from-disk
//
// A normal build never sees the defines and keeps the loader fully enabled.
//
// The defines fold to constants at bundle time, so the disabled path is
// unreachable at runtime. The loader's own code stays in the bundle (the
// AOT compiler keeps the dynamic import and warns about it), so "dead
// weight" here means "never executed", not "removed from the binary". ---

// injected by the bundler; absent in a normal build
declare const __TFM_BUILD_AOT__: boolean | undefined;
declare const __TFM_BUILD_AOT_DISK_CODE__: boolean | undefined;

// `typeof x !== "undefined"` first: an ABSENT define is an undeclared
// identifier, and reading it unguarded would throw.
const isTrue = (value: boolean | undefined): boolean => value === true;

// true only in an ahead-of-time build
export const AOT_BUILD = typeof __TFM_BUILD_AOT__ !== "undefined" && isTrue(__TFM_BUILD_AOT__);

// true only in an ahead-of-time build that may load code from disk
export const AOT_ALLOWS_CODE_FROM_DISK =
  typeof __TFM_BUILD_AOT_DISK_CODE__ !== "undefined" && isTrue(__TFM_BUILD_AOT_DISK_CODE__);

// the decision, as a pure function of what the build opted in to
export const pluginsEnabledFor = (aot: boolean, allowsCodeFromDisk: boolean): boolean => !aot || allowsCodeFromDisk;

// WHY the loader is off (null when it is on). "plugins are disabled in this
// build" alone does not tell the user which build they are running: an
// ahead-of-time build that did not opt in to code from disk is a different
// binary from one that did, and the difference is the flag, not the app.
//
// The wording is the load-bearing part: it names the FLAG (what the build
// did not get) and never claims the binary is incapable of loading code
// from disk — the seal covers the runtime's own disk path, and a plugin
// that serves the source bypasses it.
export const pluginsDisabledReasonFor = (aot: boolean, allowsCodeFromDisk: boolean): string | null =>
  pluginsEnabledFor(aot, allowsCodeFromDisk)
    ? null
    : "it was not built with --aot-allow-code-from-disk (the build did not opt in to running code from disk)";

export const PLUGINS_ENABLED = pluginsEnabledFor(AOT_BUILD, AOT_ALLOWS_CODE_FROM_DISK);

export const PLUGINS_DISABLED_REASON: string | null = pluginsDisabledReasonFor(AOT_BUILD, AOT_ALLOWS_CODE_FROM_DISK);
