// --- The boot's MODE: one value, one capture.
//
// [ui] lazy-startup picks the startup shape (classic = the app paints in ONE
// burst; lazy = paint first, the rest lands in the background). The old
// code spelled that ONE fact FOUR ways:
//
//   - an INVERTED capture in wireCore
//     (`burstStartup = config.ui.lazyStartup !== true`),
//   - a SECOND capture in wireBoot
//     (`lazyBootFlag = core.config.ui?.lazyStartup === true`),
//   - a LIVE re-read of the config in the chrome wiring (the icon warms),
//   - another LIVE re-read in the plugins wiring (the plugin scan).
//
// Two captures of OPPOSITE polarity and two live reads of the same field:
// the shape the boot runs was decided in more than one place, and a live
// config reload could move the live reads while the captures held the old
// value.
//
// The mode is ONE value now: derived ONCE (the strict `=== true` read lives
// here, so no call site can spell the rule differently) and read everywhere.
// Pure — no config, no fs, no renderer.

export type BootMode = "classic" | "lazy";

// The ONE place [ui] lazy-startup is interpreted. The read is STRICT: only
// the boolean `true` opts in — a hand-edited "yes"/1 never changes the
// boot's shape.
export const bootModeFor = (lazyStartup: unknown): BootMode => (lazyStartup === true ? "lazy" : "classic");

// The mode's one predicate — the shape the app boots with.
export const isLazyBoot = (mode: BootMode): boolean => mode === "lazy";
