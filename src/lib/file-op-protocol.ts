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
export type ProgressState = {
  active: boolean;
  verb: string;
  doneFiles: number;
  totalFiles: number;
  bytes: number;
  totalBytes: number;
  paused: boolean;
  cancelled: boolean;
  // pre-scan "counting" mode: totals are still unknown, so paintProgress shows
  // an indeterminate `counting N files…` (nautilus' "Preparing" counter)
  counting?: boolean;
  currentRs: ReadStream | null;
  toastUp: boolean;
  // external-process controls (archive tools): cancel/pause hooks the toast
  // buttons invoke when no ReadStream is live
  processCancel?: (() => void) | null;
  processPause?: (() => void) | null;
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
