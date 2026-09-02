// --- Debug mode (--debug / -d): writes a single event log + crash dump to
// /tmp/tfm-debug.log so testers paste one file instead of a screenshot. ---

import { appendFileSync } from "node:fs";

export const isDebug = process.argv.includes("--debug") || process.argv.includes("-d");
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
