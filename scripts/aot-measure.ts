// --- Boot measurement for the AOT experiment.
//
// Boots a tfm binary (an AOT executable or the JIT one) in an isolated
// sandbox and reports, per run:
//   * altMs   — spawn → the renderer entered the alternate screen,
//   * paintMs — spawn → the first full paint finished,
//   * appMs   — the app's own "launched in N ms" report,
//   * the resident set size (and the peak) at the first paint.
//
// paintMs and appMs come from the app's OWN log timestamps (the debug log
// stamps every line with an ISO time), so they carry no polling slop; altMs
// is measured here because the renderer only speaks on stdout.
//
// The boot is POLLED, never slept: a cold AOT boot can take seconds, and a
// fixed window would read back empty (the same rule as src/index-smoke.test.ts).
// The run waits for the app's launch report — the LAST boot step — before it
// tears the session down, so the app's own number is on record.
//
// The sandbox is deliberately headless: no tty answers the terminal's
// cell-pixel probe, so the classic boot parks on that probe for its full 2s
// budget — a constant that says nothing about the compiler. The sandbox
// config turns [ui] lazy-startup on (it caps that probe at 250ms) and
// pre-seeds the default-file-manager verdict ("no" = silent), so the first
// boot prompt never fires.
//
// Usage: bun scripts/aot-measure.ts <binary> [runs] [label]
// Prints one JSON object on stdout.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const ENTER = "\x1b[?1049h";
// the kitty graphics protocol: every rasterized icon (the SVG assets are
// embedded in the binary and rasterized at runtime) lands as one image
// placement. Counting them tells us whether the embedded assets survived
// the build — without them the app silently falls back to text glyphs.
const IMAGE = "\x1b]72;";

type Run = {
  // the renderer entered the alternate screen
  ok: boolean;
  // the first full paint finished
  painted: boolean;
  // spawn → the app's first line of code (the module graph is loaded)
  readyMs: number | null;
  altMs: number | null;
  paintMs: number | null;
  appMs: number | null;
  rssKb: number | null;
  hwmKb: number | null;
  // how many images the renderer drew (the embedded icon assets)
  images: number;
  crashed: boolean;
  stderr: string;
  debugTail: string;
};

const procStatus = (pid: number): { rssKb: number | null; hwmKb: number | null } => {
  const read = (key: string): number | null => {
    try {
      const raw = readFileSync(`/proc/${pid}/status`, "utf8");
      const m = raw.match(new RegExp(`^${key}:\\s+(\\d+) kB`, "m"));
      return m?.[1] ? Number(m[1]) : null;
    } catch {
      return null;
    }
  };
  return { rssKb: read("VmRSS"), hwmKb: read("VmHWM") };
};

// the debug log's lines look like "2026-10-27T22:56:42.250Z <message>"
const logTime = (line: string): number | null => {
  const ts = Date.parse(line.slice(0, 24));
  return Number.isNaN(ts) ? null : ts;
};

type Markers = {
  // when the app's first line ran (the module graph is loaded)
  readyTs: number | null;
  // when the first full paint finished (the app's own clock)
  paintTs: number | null;
  // the app-reported boot time
  appMs: number | null;
};

const scanLog = (logPath: string): Markers => {
  let raw = "";
  try {
    raw = readFileSync(logPath, "utf8");
  } catch {
    return { readyTs: null, paintTs: null, appMs: null };
  }
  let readyTs: number | null = null;
  let paintTs: number | null = null;
  let appMs: number | null = null;
  for (const line of raw.split("\n")) {
    if (!line) continue;
    // the very first line is the app's own "tfm starting" — the module
    // graph has been evaluated by then
    if (readyTs === null) readyTs = logTime(line);
    // "bootstep: renderAll 141ms" — the first full paint is done
    if (paintTs === null && line.includes("bootstep: renderAll")) paintTs = logTime(line);
    const m = /boot: launched in (\d+) ms/.exec(line);
    if (m) appMs = Number(m[1]);
  }
  return { readyTs, paintTs, appMs };
};

// the tail of the debug log: what the app wrote before it died (a crash
// leaves its stack there)
const debugTail = (logPath: string, lines = 12): string => {
  try {
    return readFileSync(logPath, "utf8")
      .split("\n")
      .filter((l) => l.length)
      .slice(-lines)
      .join("\n");
  } catch {
    return "";
  }
};

const bootOnce = async (bin: string, sandbox: string): Promise<Run> => {
  const runDir = mkdtempSync(path.join(sandbox, "run-"));
  const configPath = path.join(runDir, "config.toml");
  // lazy-startup caps the (unanswered) cell-pixel probe at 250ms instead of
  // 2s — the sandbox has no tty, so the classic budget would be a constant
  // wait that hides the very difference we measure
  writeFileSync(configPath, "[ui]\nlazy-startup = true\n");
  const stateDir = path.join(runDir, "state", "tfm");
  mkdirSync(stateDir, { recursive: true });
  // "no" = the default-file-manager question is answered and stays silent
  writeFileSync(path.join(stateDir, "default-file-manager"), "no\n");
  const logPath = path.join(runDir, "debug.log");

  const started = Date.now();
  const proc = Bun.spawn([bin, "--debug", runDir], {
    cwd: runDir,
    env: {
      ...process.env,
      TFM_CONFIG: configPath,
      XDG_CONFIG_HOME: path.join(runDir, "config"),
      XDG_DATA_HOME: path.join(runDir, "data"),
      XDG_CACHE_HOME: path.join(runDir, "cache"),
      XDG_STATE_HOME: path.join(runDir, "state"),
      TFM_DEBUG_LOG: logPath,
      TFM_DND_LOG: path.join(runDir, "dnd.log"),
    },
    stdout: "pipe",
    stderr: "pipe",
  });

  let out = "";
  let err = "";
  const decoder = new TextDecoder();
  const drain = async (stream: ReadableStream<Uint8Array> | null, append: (s: string) => void): Promise<void> => {
    if (!stream) return;
    const reader = stream.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        append(decoder.decode(value, { stream: true }));
      }
    } catch {
      // the teardown races the kill below; a read throw just ends the drain
    } finally {
      reader.releaseLock();
    }
  };
  const outDone = drain(proc.stdout as ReadableStream<Uint8Array> | null, (s) => {
    out += s;
  });
  const errDone = drain(proc.stderr as ReadableStream<Uint8Array> | null, (s) => {
    err += s;
  });

  let altMs: number | null = null;
  let mem = { rssKb: null as number | null, hwmKb: null as number | null };
  let readyTs: number | null = null;
  let paintTs: number | null = null;
  let appMs: number | null = null;
  const deadline = started + 30000;
  // wait for the app's launch report (the last boot step): until it lands,
  // the app-reported number does not exist yet
  while (appMs === null && proc.exitCode === null && Date.now() < deadline) {
    if (altMs === null && out.includes(ENTER)) altMs = Date.now() - started;
    const markers = scanLog(logPath);
    if (readyTs === null) readyTs = markers.readyTs;
    if (paintTs === null && markers.paintTs !== null) {
      paintTs = markers.paintTs;
      mem = procStatus(proc.pid);
    }
    if (markers.appMs !== null) {
      appMs = markers.appMs;
      break;
    }
    await new Promise((r) => setTimeout(r, 20));
  }
  const ok = altMs !== null;
  if (altMs === null && out.includes(ENTER)) altMs = Date.now() - started;

  try {
    proc.kill("SIGTERM");
  } catch {}
  const killDeadline = Date.now() + 8000;
  while (proc.exitCode === null && Date.now() < killDeadline) {
    await new Promise((r) => setTimeout(r, 25));
  }
  try {
    proc.kill("SIGKILL");
  } catch {}
  await proc.exited;
  await Promise.all([outDone, errDone]);

  // final read: the app may have logged more before it died
  const final = scanLog(logPath);
  if (appMs === null) appMs = final.appMs;
  if (readyTs === null) readyTs = final.readyTs;
  if (paintTs === null) paintTs = final.paintTs;
  const readyMs = readyTs === null ? null : readyTs - started;
  const paintMs = paintTs === null ? null : paintTs - started;
  return {
    ok,
    painted: paintMs !== null,
    readyMs,
    altMs,
    paintMs,
    appMs,
    rssKb: mem.rssKb,
    hwmKb: mem.hwmKb,
    images: countOf(out, IMAGE),
    crashed: err.includes("[tfm] crash"),
    stderr: err.trim().slice(0, 800),
    debugTail: debugTail(logPath),
  };
};

// how many times a needle appears in a haystack (no regex: the haystack is
// megabytes of escape sequences)
const countOf = (haystack: string, needle: string): number => {
  let n = 0;
  let at = haystack.indexOf(needle);
  while (at !== -1) {
    n++;
    at = haystack.indexOf(needle, at + needle.length);
  }
  return n;
};

const median = (xs: number[]): number | null => {
  if (!xs.length) return null;
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  if (sorted.length % 2) return sorted[mid] ?? null;
  const lo = sorted[mid - 1];
  const hi = sorted[mid];
  if (lo === undefined || hi === undefined) return null;
  return Math.round((lo + hi) / 2);
};

const nums = (xs: (number | null)[]): number[] => xs.filter((x): x is number => x !== null);

const [binArg, runsArg, label] = process.argv.slice(2);
if (!binArg) {
  console.error("usage: bun scripts/aot-measure.ts <binary> [runs] [label]");
  process.exit(2);
}
// absolute: every run spawns with its own cwd (the sandbox dir)
const bin = path.resolve(binArg);
const runs = Math.max(1, Number(runsArg ?? "3") || 3);
const sandbox = mkdtempSync(path.join(os.tmpdir(), "tfm-aot-measure-"));
const results: Run[] = [];
try {
  for (let i = 0; i < runs; i++) {
    results.push(await bootOnce(bin, sandbox));
  }
} finally {
  rmSync(sandbox, { recursive: true, force: true });
}

const okRuns = results.filter((r) => r.ok);
console.log(
  JSON.stringify(
    {
      label: label ?? bin,
      binary: bin,
      runs: results.length,
      booted: okRuns.length,
      painted: results.filter((r) => r.painted).length,
      crashed: results.filter((r) => r.crashed).length,
      medianReadyMs: median(nums(okRuns.map((r) => r.readyMs))),
      medianAltMs: median(nums(okRuns.map((r) => r.altMs))),
      medianPaintMs: median(nums(okRuns.map((r) => r.paintMs))),
      medianAppMs: median(nums(okRuns.map((r) => r.appMs))),
      medianRssKb: median(nums(okRuns.map((r) => r.rssKb))),
      medianImages: median(nums(okRuns.map((r) => r.images))),
      results,
    },
    null,
    2,
  ),
);
