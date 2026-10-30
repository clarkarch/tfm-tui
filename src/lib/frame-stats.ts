// --- Frame stats: what the native renderer actually repainted.
//
// OpenTUI 0.8.0 made the frame diff damage-aware: an unchanged frame paints
// nothing, and a frame with a small change clears and repaints only the rows
// around the change. `renderer.getNativeStats().frameWork.damageRows` is the
// ground truth — the terminal rows the last PRESENTED frame repainted.
//
// This is the instrument tfm's windowed grid was missing: "only the entering
// rows repaint" used to be a wall-clock claim (load-dependent, noisy, and it
// cannot tell a cheap rebuild from an expensive one); the native row count is
// exact and deterministic.
//
// The shape is narrowed HERE on purpose — src/lib/ must not import OpenTUI's
// types (the node-like.ts rule) — so the seam is a plain shape the wiring
// fills from the renderer's PUBLIC accessor.

// The last presented frame's work counters (OpenTUI 0.8.0 `ot_scene_stats`).
export type FrameWork = {
  // Terminal rows the frame cleared and repainted. 0 = the frame painted nothing.
  damageRows: number;
  // Bit set of reasons the frame took the FULL repaint path (0 = damage-only).
  fullPathReasons: number;
  // Rows the encoder compared against the previous frame.
  rowsDiffed: number;
  // Monotonic id of the frame the counters belong to.
  workFrameId: number;
};

// Reads the last presented frame's counters; null when unavailable.
export type FrameWorkSource = () => FrameWork | null;

// OT_SCENE_FULL_PATH_* (packages/native/include/opentui.h) — why a frame took
// the full repaint path instead of the damage-only path.
export const FULL_PATH_FORCED = 1;
export const FULL_PATH_SCREEN = 2;
export const FULL_PATH_IMAGES = 4;
export const FULL_PATH_TAINTED = 8;
export const FULL_PATH_UNRETAINED = 16;
export const FULL_PATH_OPTIONS = 32;
export const FULL_PATH_NON_LOCAL = 64;

// The ROUTINE reasons: the first frame has no previous frame to compare with,
// a resize invalidates the retained frame, and the debug flag asks for a full
// frame on purpose. A frame carrying only these is not a finding.
export const BENIGN_FULL_PATH = FULL_PATH_FORCED | FULL_PATH_SCREEN | FULL_PATH_UNRETAINED;

// Names the full-repaint reasons in a stable order, so a debug line stays
// greppable ("full=images" must keep meaning the same thing tomorrow).
export const fullPathNames = (reasons: number): string[] => {
  const names: string[] = [];
  if (reasons & FULL_PATH_FORCED) names.push("forced");
  if (reasons & FULL_PATH_SCREEN) names.push("screen");
  if (reasons & FULL_PATH_IMAGES) names.push("images");
  if (reasons & FULL_PATH_TAINTED) names.push("tainted");
  if (reasons & FULL_PATH_UNRETAINED) names.push("unretained");
  if (reasons & FULL_PATH_OPTIONS) names.push("options");
  if (reasons & FULL_PATH_NON_LOCAL) names.push("non-local");
  return names;
};

// One "paint ..." line: what the last presented frame repainted, and why.
export const paintLine = (w: FrameWork | null): string => {
  if (!w) return "paint n/a";
  const why = fullPathNames(w.fullPathReasons);
  const base = `paint rows=${w.damageRows} diffed=${w.rowsDiffed}`;
  return why.length ? `${base} full=${why.join(",")}` : base;
};

export type PaintWatch = {
  // The counters of the last frame this watch saw.
  readonly last: FrameWork | null;
  // Sample the source. Returns the counters only when they belong to a frame
  // this watch has not seen yet: the native reports the LAST presented frame,
  // so sampling twice between two frames yields the same workFrameId.
  readonly sample: () => FrameWork | null;
};

export const makePaintWatch = (source: FrameWorkSource): PaintWatch => {
  let last: FrameWork | null = null;
  let seenId = -1;
  return {
    get last(): FrameWork | null {
      return last;
    },
    sample(): FrameWork | null {
      const w = source();
      if (!w) return null;
      if (w.workFrameId === seenId) return null;
      seenId = w.workFrameId;
      last = w;
      return w;
    },
  };
};

// --- The --debug paint trace: one line per frame that PAINTED something.
//
// The renderer publishes a frame event per PRESENTED frame; the counters
// describe that frame. An idle frame (nothing changed) repaints zero rows —
// logging it would bury the interesting frames, so the trace skips it.
//
// The trace is the instrument for the questions tfm could not answer before:
// "does a hover repaint the whole screen?", "why is my SSH link busy?", "is
// the windowed grid's incremental slide actually cheaper?". The answer is
// often "full=images": a kitty thumbnail on screen forces the full repaint
// path on every frame (the native clears the screen and re-draws the
// placements), which no amount of windowing can avoid.
export type PaintTraceCtx = {
  // Subscribe to the renderer's per-presented-frame event. Returns the
  // unsubscribe.
  subscribe(onFrame: () => void): () => void;
  // The last presented frame's counters.
  source: FrameWorkSource;
  // Where the trace goes (the --debug log).
  log: (msg: string) => void;
};

export const startPaintTrace = (ctx: PaintTraceCtx): (() => void) => {
  const watch = makePaintWatch(ctx.source);
  return ctx.subscribe(() => {
    const w = watch.sample();
    if (!w) return;
    // an idle frame painted nothing — silence is the point
    if (w.damageRows <= 0 && w.fullPathReasons === 0) return;
    ctx.log(paintLine(w));
  });
};
