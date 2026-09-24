// --- Debug mode (--debug / -d): writes a single event log + crash dump to
// /tmp/tfm-debug.log so testers paste one file instead of a screenshot. ---

import { appendFileSync } from "node:fs";

// Honor `--` the same way cli.parseArgs does: `tfm -- --debug` opens a folder
// literally named "--debug" and must NOT turn on debug logging.
const debugFlagIn = (argv: string[]): boolean => {
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") break;
    if (a === "--debug" || a === "-d") return true;
  }
  return false;
};

export const isDebug = debugFlagIn(process.argv);
// env overrides exist so tests (and sandboxes) can redirect the logs off the
// real /tmp files; defaults are the documented tester-paste paths
export const DEBUG_LOG = process.env.TFM_DEBUG_LOG ?? "/tmp/tfm-debug.log";

export const appendLog = (msg: string): void => {
  try {
    appendFileSync(DEBUG_LOG, `${new Date().toISOString()} ${msg}\n`);
  } catch {}
};

export const debugLog = (msg: string): void => {
  if (!isDebug) return;
  appendLog(msg);
};

// --- Best-effort failure reporting. A bare `catch {}` makes an UNEXPECTED
// failure (SVG rasterizer missing, cache dir unwritable, bookmarks unreadable, a
// mistyped icon slot name) invisible forever: the reported symptom is always
// one step removed from the cause — a fallback glyph that never swaps, a
// trash entry with no .trashinfo, a config that silently doesn't save. This
// keeps the swallow (callers stay best-effort) but leaves a line in the debug
// log, so `tfm --debug` turns "it just does nothing" into a cause.
//
// Deliberately NOT always-on: hot paths (per-file metadata restore, per-slot
// icon rasters at boot) would flood the log for failures that are already
// known and harmless. Expected misses ALSO stay bare `catch {}` at the call
// site — an ENOENT probe for "does this exist" is not an error, and routing
// them here just adds noise. This is for failures nobody asked for.
//
// Lives with the log because that is the one diagnostic sink; log.ts imports
// only node:fs, so fs/ and ui/ modules may pull it in without a cycle.
export const swallow = (what: string, err: unknown): void => {
  if (!isDebug) return;
  let detail: string;
  try {
    detail = err instanceof Error ? (err.stack ?? err.message) : String(err);
  } catch {
    detail = "<unprintable error>";
  }
  debugLog(`swallowed: ${what}: ${detail}`);
};

// --- Drag diagnosis: the whole DnD path (drag offer accept/decline + why,
// tile mousedown/drop payload counts, moveInto in/out filtering) goes here so
// a "Moved 0 items" toast can be traced backwards. Always-on (cheap appends),
// mirrored into the debug event log under --debug. ---

export const DND_LOG = process.env.TFM_DND_LOG ?? "/tmp/tfm-dnd.log";

export const dlog = (msg: string): void => {
  try {
    appendFileSync(DND_LOG, `${new Date().toISOString()} ${msg}\n`);
  } catch {}
  if (isDebug) appendLog(`[dnd] ${msg}`);
};

process.on("uncaughtException", (err) => {
  appendLog(`UNCAUGHT EXCEPTION: ${err?.stack ?? err}`);
  try {
    process.stderr.write(`[tfm] crash — see ${DEBUG_LOG}\n`);
  } catch {}
  process.exit(1);
});
process.on("unhandledRejection", (reason) => {
  appendLog(`UNHANDLED REJECTION: ${reason instanceof Error ? reason.stack : String(reason)}`);
});
