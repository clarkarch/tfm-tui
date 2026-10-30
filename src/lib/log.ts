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
// only node:fs, so fs/ and ui/ modules may pull it in without a cycle. It
// lives in lib/ (not app/) because it is a LEAF: app/ is the top layer, so
// fs/ and ui/ importing it upward was a layering inversion that eight files
// paid for.
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

// --- Crash handlers. INSTALLED EXPLICITLY, not as an import side effect.
//
// This used to register `process.on(...)` at module scope. That made the
// handler's installation an accident of module-evaluation order: the app
// needed it registered BEFORE any other module could throw (a failing
// @opentui/core native load), which src/index.ts tried to guarantee with a
// dedicated first import — invisible, fragile, and easy to "optimize" away.
// It also meant every LEAF that imported `swallow` (fs/fsutil, fs/transfer,
// fs/fileops, fs/recent, fs/undo-journal, ui/icons, ui/ui-slots) installed
// process-wide handlers in the shared `bun test` process, where an
// uncaughtException in one test file could exit the whole suite instead of
// failing one test.
//
// installCrashHandlers() is called once, from src/index.ts, before the app
// graph loads. Nothing else may call it (a second registration would double
// every crash report).
export const installCrashHandlers = (): void => {
  process.on("uncaughtException", (err) => {
    appendLog(`UNCAUGHT EXCEPTION: ${err?.stack ?? err}`);
    try {
      process.stderr.write(`[tfm] crash — see ${DEBUG_LOG}\n`);
    } catch {}
    process.exit(1);
  });
  process.on("unhandledRejection", (reason) => {
    appendLog(`UNHANDLED REJECTION: ${reason instanceof Error ? reason.stack : String(reason)}`);
    // the app keeps running by design (a rejected fire-and-forget must not
    // kill the TUI), but staying silent leaves a zombie nobody notices — the
    // crash path above already announces itself on stderr, mirror that here
    try {
      process.stderr.write(`[tfm] unhandled rejection — see ${DEBUG_LOG}\n`);
    } catch {}
  });
};
