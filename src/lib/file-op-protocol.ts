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
