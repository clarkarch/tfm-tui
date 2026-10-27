// --- Build-time gate for the plugin loader.
//
// A plugin is a TypeScript file on disk that the loader imports at runtime.
// An ahead-of-time (AOT) executable may only run code that was compiled INTO
// it — a file on disk is not part of the executable — so an AOT build ships
// with the loader switched off.
//
// The switch is injected by the bundler (`bun build --define
// __TFM_BUILD_AOT__=true --compile`), so ONE source tree serves both builds:
// a normal build never sees the define and keeps the loader fully enabled.
//
// The define folds to a constant at bundle time, so the disabled path is
// unreachable at runtime. The loader code stays in the bundle (never
// executed) and the AOT compiler's "code from disk" finding stays a warning
// instead of becoming a build failure. ---

// injected by the bundler; absent in a normal build
declare const __TFM_BUILD_AOT__: boolean | undefined;

// true only in an ahead-of-time build
export const AOT_BUILD = typeof __TFM_BUILD_AOT__ !== "undefined" && __TFM_BUILD_AOT__ === true;

// the plugin loader needs code from disk, which an AOT executable forbids
export const PLUGINS_ENABLED = !AOT_BUILD;
