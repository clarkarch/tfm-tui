// --- Debug mode (--debug / -d): writes a single event log + crash dump to
// /tmp/tfm-debug.log so testers paste one file instead of a screenshot. ---

import { appendFileSync } from "node:fs";

export const isDebug = process.argv.includes("--debug") || process.argv.includes("-d");
export const DEBUG_LOG = "/tmp/tfm-debug.log";

export const appendLog = (msg: string): void => {
  try { appendFileSync(DEBUG_LOG, `${new Date().toISOString()} ${msg}\n`); } catch {}
};

export const debugLog = (msg: string): void => {
  if (!isDebug) return;
  appendLog(msg);
};

process.on("uncaughtException", (err) => {
  appendLog(`UNCAUGHT EXCEPTION: ${err?.stack ?? err}`);
  try { process.stderr.write(`[tfm] crash — see ${DEBUG_LOG}\n`); } catch {}
  process.exit(1);
});
process.on("unhandledRejection", (reason) => {
  appendLog(`UNHANDLED REJECTION: ${reason instanceof Error ? reason.stack : String(reason)}`);
});
