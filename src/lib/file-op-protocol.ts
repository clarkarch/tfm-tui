// --- The data shapes the file-operation layer exchanges with the UI layer.
//
// fs/fileops.ts used to import these from the widgets that OWN them
// (ui/ui-dialogs.ts, ui/ui-progress.ts, input/grid-input.ts). fs/ is the
// LOWEST layer, so every one of those was an upward import — and ui/
// imports @opentui/core, so fs/fileops.ts's type graph dragged the renderer
// in behind it. They were also latent cycles: the day ui/ui-dialogs.ts
// (which owns the conflict prompt fileops drives) imported fs/fileops.ts,
// the import-graph test would go red.
//
// One leaf for the whole protocol: these three shapes exist for the SAME
// reason — they are how fs/fileops.ts talks to the widgets that render its
// outcomes — so they belong together rather than in three one-type files.

import type { ReadStream } from "node:fs";

// How a conflict is resolved: overwrite the destination, keep both under a
// new name, or skip the item.
export type ConflictChoice = "replace" | "keepBoth" | "skip";

// One selected item in a clipboard/drag payload.
export type ClipItem = { path: string; isDir: boolean };

// The live state of the progress toast that reports a running copy/move/
// delete/archive op.
//
// ONE phase field replaces the old active/paused/cancelled/counting
// booleans. Those four were independent flags: they formed a PRODUCT state
// space (so "paused AND cancelled" was representable), and — worse — the
// project had TWO reset routines that cleared DIFFERENT field sets
// (fileops' resetProg and the driver's start). A reset that missed one flag
// is how a stale ✕ from an earlier op poisoned the next one ("Moved 0
// items"). A phase has exactly one legal value at a time, so the illegal
// combinations are unrepresentable and there is only ONE reset.
//
// `toastUp` stays a separate field on purpose: the toast's visibility is
// ORTHOGONAL to the op's phase (a small op runs with no toast at all, and a
// finished op leaves its toast lingering its result). It is UI-owned
// (src/ui/ui-progress.ts); the fs side only READS it.
export type ProgressPhase =
  /** no op running */
  | "idle"
  /** pre-scan: totals unknown, the bar is indeterminate */
  | "counting"
  /** op in flight */
  | "running"
  /** op in flight, the user paused it */
  | "paused"
  /** the user asked to cancel; the op is unwinding */
  | "cancelling"
  /** the op finished (the toast may still be lingering its result) */
  | "done";

export type ProgressState = {
  phase: ProgressPhase;
  verb: string;
  doneFiles: number;
  totalFiles: number;
  bytes: number;
  totalBytes: number;
  currentRs: ReadStream | null;
  /** the progress toast is on screen (UI-owned; the fs side only reads it) */
  toastUp: boolean;
  // external-process controls (archive tools): cancel/pause hooks the toast
  // buttons invoke when no ReadStream is live
  processCancel?: (() => void) | null;
  processPause?: (() => void) | null;
};

// The phase predicates. Every reader goes through one of these so the
// mapping from phase to meaning lives in ONE place.
export const progressActive = (p: ProgressState): boolean =>
  p.phase === "counting" || p.phase === "running" || p.phase === "paused" || p.phase === "cancelling";
export const progressPaused = (p: ProgressState): boolean => p.phase === "paused";
export const progressCancelled = (p: ProgressState): boolean => p.phase === "cancelling";
export const progressCounting = (p: ProgressState): boolean => p.phase === "counting";

// The ONE reset for the OP-level fields. It clears every field the op owns:
// the phase, the counters and the totals.
//
// It deliberately does NOT touch the three fields with a DIFFERENT owner and
// a DIFFERENT lifetime:
//   - `toastUp`      — the UI owns the toast's lifetime; a re-show during the
//                      done-linger must REUSE the toast, not stack a second one.
//   - `currentRs`    — the sink owns the live stream (`setStream`/`clearStream`).
//   - `processCancel`/`processPause` — the archive layer owns the child hooks
//                      (`onArchiveChild`/`clearArchiveChild`).
// The stale-flag bug this replaces was always about the OP flags (a stale ✕
// from an earlier op poisoning the next one — "Moved 0 items"), and the old
// code had TWO reset routines clearing DIFFERENT field sets. There is now one.
export const resetProgressState = (p: ProgressState): void => {
  p.phase = "idle";
  p.doneFiles = 0;
  p.totalFiles = 0;
  p.bytes = 0;
  p.totalBytes = 0;
};

// End an op WITHOUT losing the "the user cancelled it" fact: the cancelled
// flag was STICKY in the old boolean model (it stayed true until the next op
// started), and some paths read it after the op unwound. `done`/`idle` mean
// "not cancelled"; `cancelling` survives both.
export const finishProgressPhase = (p: ProgressState): void => {
  if (p.phase !== "cancelling") p.phase = "done";
};
export const stopProgressPhase = (p: ProgressState): void => {
  if (p.phase !== "cancelling") p.phase = "idle";
};

// The progress seam the copy/delete engines report into. It lives in this leaf
// (not in fs/transfer.ts) because BOTH sides need it: the fs engines define
// the contract, the ui widgets implement it, and the driver below wires one to
// the other — a leaf keeps the import graph acyclic in both directions.
export type TransferSink = {
  // gate between files AND before each entry: waits while paused, throws
  // Error("cancelled") when the transfer was cancelled
  checkpoint: () => Promise<void>;
  // mid-stream queries: the data handler pauses/destroys the live stream
  paused: () => boolean;
  cancelled: () => boolean;
  addBytes: (n: number) => void;
  fileDone: () => void;
  // mid-stream cancel path: the toast's cancel button destroys the current
  // stream, so the sink owns the "which stream is live" bookkeeping
  setStream: (rs: ReadStream) => void;
  clearStream: (rs: ReadStream) => void;
  repaint: (full?: boolean) => void;
};

// A progress DRIVER: the fs side asks it to start an op, reports into its
// sink, and asks it for the outcome. The ui side owns the toast; the driver
// is the bridge (see ui/ui-progress.ts's makeOpProgress).
export type OpProgress = {
  sink: TransferSink;
  /** reset counters, set totals, arm the toast when it's worth showing */
  start(totalFiles: number, totalBytes: number, verb?: string): void;
  /** pre-scan tick (optional): live "counting N files…" before totals exist */
  counting?: (files: number) => void;
  cancelled(): boolean;
  /** swap the live toast for the final state (no-op when none showed) */
  finish(msg: string): void;
  /** clear the active flag */
  stop(): void;
};

// --- Terminal notifications for finished operations.
//
// The in-app toast is enough for a quick op: the user is watching. A DESKTOP
// notification (OSC 99 / OSC 777 / OSC 9 — the renderer negotiates the
// protocol with the terminal) is the channel for an op that finished while
// the user was somewhere else, and the only signal we have for "somewhere
// else" is that the op took a while.
//
// 5s is the line: below it the toast is still on screen when the op ends, so
// a notification would only duplicate it; above it the user has plausibly
// switched away. A cancelled or failed op never notifies — the toast carries
// the honest outcome and a desktop notification that says "done" for a
// half-finished op would be a lie.
export const OP_NOTIFY_MIN_MS = 5000;

export const shouldNotifyTerminal = (elapsedMs: number, cancelled: boolean, failed: number): boolean =>
  !cancelled && failed === 0 && elapsedMs >= OP_NOTIFY_MIN_MS;
