import type { ChildProcess, SpawnOptions } from "node:child_process";
import type { Stats } from "node:fs";
import { chmodSync, existsSync, mkdirSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { lstat, readdir, readlink } from "node:fs/promises";
import { errMessage } from "../lib/uiutil";
import path from "node:path";
import { spawnSafe } from "./spawn-safe";

// --- Archive engine: extension -> format detection, exact argv for tar/unzip/
// zip/7z, listing for a total count, and a line-streaming child runner. Pure
// (spawn/which injectable) so tests never shell out; fileops owns the
// orchestration (conflict/undo/progress). Single-file compressed streams
// (bare .gz/.xz/…) are deliberately out of scope — everything here is a
// multi-entry archive. One COMPRESSIONS table drives availability, argv and
// labels so a new format is a single row. ---

export type ArchiveFormat =
  | "tar"
  | "tar.gz"
  | "tar.bz2"
  | "tar.xz"
  | "tar.lzma"
  | "tar.zst"
  | "tar.lz4"
  | "tar.br"
  | "tar.lz"
  | "tar.lzo"
  | "tar.Z"
  | "zip"
  | "7z";
// every format we can create we can also list/extract
export type CompressionFormat = ArchiveFormat;
export type ToolSpec = { tool: string; args: string[] };
export type ArchiveRunResult = { code: number; stdout: string; stderr: string };
export type ArchiveRunOpts = {
  cwd?: string;
  // every line of stdout AND stderr, for progress (tar -v writes names to
  // stderr, unzip writes them to stdout)
  onLine?: (line: string) => void;
  // the live child, so the caller can register cancel (SIGTERM) / pause
  // (SIGSTOP/SIGCONT)
  onChild?: (child: ChildProcess) => void;
  spawn?: SpawnFn;
  // cooperative control for the in-process (js) lanes, which have no child
  // to signal: polled between entries, so ✕/pause behave like the spawn path
  isCancelled?: () => boolean;
  pauseGate?: () => Promise<void>;
  // fidelity report from the tar-family js create (its input is content-only,
  // so exec bits/symlinks are dropped): fired once on success with what the
  // walk saw, so fileops can warn without a second lstat walk. The zip lane
  // preserves both and never fires it.
  onLoss?: (loss: { exec: number; links: number }) => void;
};
export type ArchiveRun = (spec: ToolSpec, opts?: ArchiveRunOpts) => Promise<ArchiveRunResult>;
type SpawnFn = (cmd: string, args: string[], opts: SpawnOptions, onFail: (err: Error) => void) => ChildProcess;
export type WhichFn = (bin: string) => string | null;

type CompressionDef = {
  fmt: ArchiveFormat;
  ext: string;
  hint: string;
  kind: "tar" | "zip" | "7z";
  // tar argv filter used for create AND extract AND list (GNU tar needs it on
  // extract for -I filters — lz4/brotli are not auto-detected)
  filter: string[];
  need: string[];
};

// picker order: most common first
const COMPRESSIONS: CompressionDef[] = [
  { fmt: "tar.gz", ext: ".tar.gz", hint: "gzip", kind: "tar", filter: ["-z"], need: ["tar", "gzip"] },
  { fmt: "zip", ext: ".zip", hint: "zip", kind: "zip", filter: [], need: [] },
  { fmt: "7z", ext: ".7z", hint: "7z", kind: "7z", filter: [], need: ["7z"] },
  { fmt: "tar", ext: ".tar", hint: "tar (no compression)", kind: "tar", filter: [], need: ["tar"] },
  { fmt: "tar.xz", ext: ".tar.xz", hint: "xz", kind: "tar", filter: ["-J"], need: ["tar", "xz"] },
  { fmt: "tar.bz2", ext: ".tar.bz2", hint: "bzip2", kind: "tar", filter: ["-j"], need: ["tar", "bzip2"] },
  { fmt: "tar.zst", ext: ".tar.zst", hint: "zstd", kind: "tar", filter: ["--zstd"], need: ["tar", "zstd"] },
  { fmt: "tar.lzma", ext: ".tar.lzma", hint: "lzma", kind: "tar", filter: ["--lzma"], need: ["tar", "lzma"] },
  { fmt: "tar.lz4", ext: ".tar.lz4", hint: "lz4", kind: "tar", filter: ["-I", "lz4"], need: ["tar", "lz4"] },
  { fmt: "tar.br", ext: ".tar.br", hint: "brotli", kind: "tar", filter: ["-I", "brotli"], need: ["tar", "brotli"] },
  { fmt: "tar.lz", ext: ".tar.lz", hint: "lzip", kind: "tar", filter: ["--lzip"], need: ["tar", "lzip"] },
  { fmt: "tar.lzo", ext: ".tar.lzo", hint: "lzop", kind: "tar", filter: ["--lzop"], need: ["tar", "lzop"] },
  { fmt: "tar.Z", ext: ".tar.Z", hint: "compress", kind: "tar", filter: ["-Z"], need: ["tar", "compress"] },
];

const DEF = new Map<ArchiveFormat, CompressionDef>(COMPRESSIONS.map((d) => [d.fmt, d]));

// COMPRESSIONS is the single source of truth and DEF is built from it, so a
// miss means the two drifted — a programming error, never a caller's input.
// Named accessor so every read is one call instead of an assertion.
const defOf = (fmt: ArchiveFormat): CompressionDef => {
  const d = DEF.get(fmt);
  if (!d) throw new Error(`archive: no definition for format ${fmt}`);
  return d;
};

// longest suffixes first: `.tar.lzma` must beat `.tar.lz`, `.tar.zst` beat
// `.tar.z`; the bare single-stream extensions are intentionally absent
const SUFFIXES: Array<[string, ArchiveFormat]> = [
  [".tar.lzma", "tar.lzma"],
  [".tar.bz2", "tar.bz2"],
  [".tar.zst", "tar.zst"],
  [".tar.lz4", "tar.lz4"],
  [".tar.lzo", "tar.lzo"],
  [".tar.gz", "tar.gz"],
  [".tar.xz", "tar.xz"],
  [".tar.lz", "tar.lz"],
  [".tar.br", "tar.br"],
  [".tar.z", "tar.Z"],
  [".tbz2", "tar.bz2"],
  [".tbz", "tar.bz2"],
  [".tgz", "tar.gz"],
  [".txz", "tar.xz"],
  [".tzst", "tar.zst"],
  [".tar", "tar"],
  [".zip", "zip"],
  [".7z", "7z"],
];

export const detectArchiveFormat = (file: string): ArchiveFormat | null => {
  const lower = file.toLowerCase();
  for (const [suffix, fmt] of SUFFIXES) {
    if (lower.endsWith(suffix)) return fmt;
  }
  return null;
};

// create and extract prefer different zip tools: `zip` writes, `unzip` reads,
// 7z does both as the fallback
const zipCreateTool = (which: WhichFn): "zip" | "7z" => (which("zip") ? "zip" : "7z");
const zipExtractTool = (which: WhichFn): "unzip" | "7z" => (which("unzip") ? "unzip" : "7z");

const canCreate = (def: CompressionDef, which: WhichFn): boolean =>
  def.kind === "zip" ? !!which("zip") || !!which("7z") : def.need.every((b) => !!which(b));

const canExtractFmt = (def: CompressionDef, which: WhichFn): boolean =>
  def.kind === "zip" ? !!which("unzip") || !!which("7z") : def.need.every((b) => !!which(b));

const listTool = (fmt: ArchiveFormat, which: WhichFn): string => {
  const def = defOf(fmt);
  if (def.kind === "tar") return "tar";
  if (def.kind === "7z") return "7z";
  return zipExtractTool(which);
};

export const extractPlan = (
  fmt: ArchiveFormat,
  file: string,
  destDir: string,
  which: WhichFn = Bun.which,
): ToolSpec => {
  const def = defOf(fmt);
  if (def.kind === "tar")
    // -v: emit entry names so the file-count progress bar advances
    // --no-same-owner: extracting as non-root otherwise warns/fails on ownership
    return {
      tool: "tar",
      args: ["-x", "-v", ...def.filter, "-f", file, "-C", destDir, "--no-same-owner"],
    };
  // -bb1: one line per entry — plain `7z x` emits a fixed header no matter
  // the entry count, freezing the file-count bar at 0 (same class as tar -v)
  if (def.kind === "7z") return { tool: "7z", args: ["x", "-bb1", "-y", `-o${destDir}`, file] };
  return zipExtractTool(which) === "unzip"
    ? { tool: "unzip", args: ["-o", file, "-d", destDir] }
    : { tool: "7z", args: ["x", "-bb1", "-y", `-o${destDir}`, file] };
};

export const listArgs = (fmt: ArchiveFormat, file: string, which: WhichFn = Bun.which): string[] => {
  const def = defOf(fmt);
  if (def.kind === "tar") return ["-t", ...def.filter, "-f", file];
  if (def.kind === "7z") return ["l", "-ba", file];
  return zipExtractTool(which) === "unzip" ? ["-Z1", file] : ["l", "-ba", file];
};

export const compressionExt = (fmt: CompressionFormat): string => defOf(fmt).ext;
export const compressionHint = (fmt: CompressionFormat): string => defOf(fmt).hint;

// -C <parent> + basenames: the archive stores the selected entries relative to
// their common parent, never absolute paths (tar strips leading / with a warning)
export const compressPlan = (
  fmt: CompressionFormat,
  outFile: string,
  names: string[],
  parent: string,
  which: WhichFn = Bun.which,
): ToolSpec => {
  const def = defOf(fmt);
  // a name starting with "-" would otherwise be parsed as an option (tar -v,
  // --files-from=…): tar/7z get an explicit `--`, zip an escaped "./" operand
  if (def.kind === "tar")
    return { tool: "tar", args: ["-c", ...def.filter, "-v", "-f", outFile, "-C", parent, "--", ...names] };
  // -bb1: one `+ name` line per added file — `zip -r` is chatty by default
  // but 7z is not, and without it the file-count bar never advances
  if (def.kind === "7z") return { tool: "7z", args: ["a", "-bb1", "-t7z", "-y", outFile, "--", ...names] };
  const zipNames = names.map((n) => (n.startsWith("-") ? `./${n}` : n));
  return zipCreateTool(which) === "zip"
    ? { tool: "zip", args: ["-r", outFile, ...zipNames] }
    : { tool: "7z", args: ["a", "-bb1", "-tzip", "-y", outFile, "--", ...zipNames] };
};

export const availableCompressionFormats = (which: WhichFn = Bun.which): CompressionFormat[] =>
  // tar/tar.gz/zip always show: the js fallback covers a tool-less machine
  // (7z and exotic tar filters still need their binaries and hide without)
  COMPRESSIONS.filter((d) => canCreate(d, which) || JS_FORMATS.has(d.fmt)).map((d) => d.fmt);

export const canExtract = (file: string, which: WhichFn = Bun.which): boolean => {
  const fmt = detectArchiveFormat(file);
  if (!fmt) return false;
  return canExtractFmt(defOf(fmt), which) || JS_FORMATS.has(fmt);
};

// --- fallback lanes: tar/tar.gz/zip work with no system tools (Bun.Archive
// + fflate); 7z and the exotic tar filters stay host-gated (no pure-JS 7z
// exists, and those users already install toolchains). canExtract /
// availableCompressionFormats above flip unconditionally for the three in a
// later step, once the js engine below lands. ---

export type ArchiveLane = "spawn" | "js" | "unavailable";

const JS_FORMATS: ReadonlySet<ArchiveFormat> = new Set(["tar", "tar.gz", "zip"]);

export const selectArchiveLane = (
  fmt: ArchiveFormat,
  mode: "create" | "extract",
  which: WhichFn = Bun.which,
): ArchiveLane => {
  const def = defOf(fmt);
  if (mode === "create" ? canCreate(def, which) : canExtractFmt(def, which)) return "spawn";
  return JS_FORMATS.has(fmt) ? "js" : "unavailable";
};

// entry count for the js lanes (no tool to ask): walk the container headers
// directly. Both never throw — like listArchiveEntries, corruption yields 0
// so the op proceeds with no total instead of dying on a count.

// tar: 512-byte headers, size at 124..135 (octal, null/space padded). pax
// extended headers (typeflags 'x'/'g') are skipped like `tar -t` skips them —
// counting them would overshoot both tar's listing and Bun.Archive.extract's
// return (the round-trip totals test pins the equality).
export const countTarEntries = (bytes: Uint8Array): number => {
  try {
    let off = 0;
    let n = 0;
    for (;;) {
      if (off === bytes.length) return n;
      if (off + 512 > bytes.length) return 0;
      let zero = true;
      for (let i = 0; i < 512; i++) {
        if (bytes[off + i] !== 0) {
          zero = false;
          break;
        }
      }
      if (zero) return n;
      // all header-relative: bare indices only work for the first header
      // (bit us: aligned sizes made every test pass while every later
      // header re-read block 0's size and walked off into data blocks)
      let end = off + 124;
      while (end < off + 136 && bytes[end] !== 0 && bytes[end] !== 0x20) end++;
      const size = parseInt(Buffer.from(bytes.slice(off + 124, end)).toString("latin1"), 8);
      // base-256 (GNU >8GB) sizes can't occur on the fallback path (the
      // fileops size guard refuses long before) — treat as corrupt, not a lie
      if (!Number.isSafeInteger(size) || size < 0) return 0;
      const type = bytes[off + 156];
      off += 512 + Math.ceil(size / 512) * 512;
      if (off > bytes.length) return 0;
      // eslint-disable-next-line no-bitwise
      if (type !== 0x78 && type !== 0x67) n++; // 'x' / 'g'
    }
  } catch {
    return 0;
  }
};

// zip: entry count + central-directory offset from EOCD (searched in the
// last 64KB+22 for the comment), then a validating walk so a truncated
// download yields 0 instead of a plausible lie. Zip64 (0xFFFF counts)
// yields 0 — the op still proceeds, just with no total.
export const countZipEntries = (bytes: Uint8Array): number => readZipEntries(bytes)?.length ?? 0;

// basename + ext-aware "(copy)" naming: uniqueTarget would split "foo.tar.gz"
// as "foo.tar" + ".gz" and yield "foo.tar (copy).gz"
export const uniqueArchiveTarget = (dir: string, base: string, ext: string): string => {
  for (let i = 2; ; i++) {
    const cand = path.join(dir, i === 2 ? `${base} (copy)${ext}` : `${base} (copy ${i - 1})${ext}`);
    if (!existsSync(cand)) return cand;
  }
};

// deepest directory that contains every path; a single entry returns its
// parent, so the archive holds the entry itself rather than its contents
export const commonParent = (paths: string[]): string => {
  const firstPath = paths[0];
  if (firstPath === undefined) return "/";
  let p = path.dirname(firstPath);
  for (const q of paths.slice(1)) {
    while (p !== path.sep && q !== p && !q.startsWith(p + path.sep)) {
      const up = path.dirname(p);
      if (up === p) break;
      p = up;
    }
  }
  return p;
};

// drop blank lines (tar -t and -v both trail a newline); everything else is an
// entry name, which is all the progress counter needs
export const parseToolLine = (line: string): string | null => {
  const t = line.replace(/\r$/, "").trim();
  return t ? t : null;
};

// fire a line reader over a stream without pulling in readline: split on \n,
// flush the tail on close
export const makeLineCounter = (onLine: (line: string) => void) => {
  let buf = "";
  return {
    push: (chunk: string) => {
      buf += chunk;
      for (;;) {
        const i = buf.indexOf("\n");
        if (i < 0) break;
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (parseToolLine(line)) onLine(line);
      }
    },
    flush: () => {
      if (parseToolLine(buf)) onLine(buf);
      buf = "";
    },
  };
};

// cap what we retain: archives can emit hundreds of MB of names, and the app
// targets low-memory machines. Progress/listing go through onLine, so only the
// (small) error-head needs to survive.
const MAX_CAPTURE = 256 * 1024;
const appendCapped = (cur: string, s: string): string =>
  cur.length >= MAX_CAPTURE ? cur : cur + s.slice(0, MAX_CAPTURE - cur.length);

export const runArchiveTool = (spec: ToolSpec, opts: ArchiveRunOpts = {}): Promise<ArchiveRunResult> =>
  new Promise((resolve) => {
    const spawnFn: SpawnFn = opts.spawn ?? spawnSafe;
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (code: number): void => {
      if (settled) return;
      settled = true;
      stdoutCounter.flush();
      stderrCounter.flush();
      resolve({ code, stdout, stderr });
    };
    const stdoutCounter = makeLineCounter((l) => opts.onLine?.(l));
    const stderrCounter = makeLineCounter((l) => opts.onLine?.(l));
    let child: ChildProcess;
    try {
      child = spawnFn(spec.tool, spec.args, { cwd: opts.cwd, stdio: ["ignore", "pipe", "pipe"] }, (err) => {
        stderr = appendCapped(stderr, err.message);
        finish(-1);
      });
    } catch (err) {
      stderr = appendCapped(stderr, errMessage(err));
      finish(-1);
      return;
    }
    opts.onChild?.(child);
    child.stdout?.on("data", (c: Buffer | string) => {
      const s = typeof c === "string" ? c : c.toString();
      stdout = appendCapped(stdout, s);
      stdoutCounter.push(s);
    });
    child.stderr?.on("data", (c: Buffer | string) => {
      const s = typeof c === "string" ? c : c.toString();
      stderr = appendCapped(stderr, s);
      stderrCounter.push(s);
    });
    child.on("error", (err) => {
      stderr = appendCapped(stderr, err.message);
      finish(-1);
    });
    child.on("close", (code) => finish(code ?? -1));
  });

// entry count for the progress total (tar/tar.gz must decompress once here;
// zip reads just its central directory). Counted via onLine so the retained
// stdout capture can stay capped. Any non-fatal exit -> 0, caller proceeds.
export const listArchiveEntries = async (
  fmt: ArchiveFormat,
  file: string,
  run: ArchiveRun = runArchiveTool,
  which: WhichFn = Bun.which,
): Promise<number> => {
  let n = 0;
  const res = await run({ tool: listTool(fmt, which), args: listArgs(fmt, file, which) }, { onLine: () => n++ });
  if (res.code !== 0 && res.code !== 1) return 0;
  return n;
};

// --- in-process fallback engine: tar/tar.gz via Bun.Archive, zip via fflate.
// Used when selectArchiveLane says "js" (no native tools). Same
// ArchiveRunResult contract as the spawn path — and the same never-throws
// rule (a throw would escape fileops' fire-and-forget `void` into the crash
// handler): every failure resolves { code: 2, stderr }. Cancellation is
// cooperative via opts.isCancelled/pauseGate (no child to signal); on cancel
// the op resolves code 0 unwritten and fileops' prog.cancelled check owns
// the outcome, exactly like the spawn path. ---

// everything here holds the archive (and its decompressed form) in RAM, so
// refuse past this instead of OOM-crashing the renderer. The spawn path
// streams and has no such ceiling — the refusal names the missing tool.
export const JS_ARCHIVE_MEMORY_LIMIT = 512 * 1024 * 1024;

export type ArchiveTask =
  | { op: "extract"; fmt: ArchiveFormat; file: string; destDir: string }
  | { op: "compress"; fmt: CompressionFormat; outFile: string; names: string[]; parent: string };
export type ArchiveTaskRun = (
  task: ArchiveTask,
  opts?: ArchiveRunOpts & { run?: ArchiveRun; which?: WhichFn },
) => Promise<ArchiveRunResult>;

// tool-aware entry count: native listing when tools exist, header walks when
// on the js lane. Never throws (missing/unreadable file -> 0).
export const countArchiveEntries = async (
  fmt: ArchiveFormat,
  file: string,
  run: ArchiveRun = runArchiveTool,
  which: WhichFn = Bun.which,
): Promise<number> => {
  if (selectArchiveLane(fmt, "extract", which) !== "js") return listArchiveEntries(fmt, file, run, which);
  try {
    // stat first: a total must never OOM the renderer to compute itself
    const st = statSync(file, { throwIfNoEntry: false });
    if (!st || st.size > JS_ARCHIVE_MEMORY_LIMIT) return 0;
    const bytes = await Bun.file(file).bytes();
    if (fmt === "zip") return countZipEntries(bytes);
    const raw = fmt === "tar" ? bytes : Bun.gunzipSync(bytes);
    return countTarEntries(raw);
  } catch {
    return 0;
  }
};

// central-directory entries with their unix metadata (local headers don't
// carry it). Null on any corruption — callers treat it like a 0 count.
type ZipEntry = { name: string; dir: boolean; symlink: boolean; mode: number; size: number };
const readZipEntries = (bytes: Uint8Array): ZipEntry[] | null => {
  try {
    if (bytes.length < 22) return null;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
    const floor = Math.max(0, bytes.length - (65557 + 22));
    for (let eocd = bytes.length - 22; eocd >= floor; eocd--) {
      if (view.getUint32(eocd, true) !== 0x06054b50) continue;
      const total = view.getUint16(eocd + 10, true);
      const cdOff = view.getUint32(eocd + 16, true);
      if (total === 0xffff) return null; // zip64 — no total rather than a misparse
      const out: ZipEntry[] = [];
      let p = cdOff;
      let ok = true;
      for (let i = 0; i < total; i++) {
        if (p + 46 > bytes.length || view.getUint32(p, true) !== 0x02014b50) {
          ok = false;
          break;
        }
        const nameLen = view.getUint16(p + 28, true);
        const nameBytes = bytes.slice(p + 46, p + 46 + nameLen);
        // general-purpose flag (+8) bit 11 = UTF-8; otherwise the name is in
        // a legacy codepage (cp437/latin1) — decoding it as UTF-8 would
        // produce mojibake keys that match nothing (and previously extracted
        // as silent 0-byte files)
        // eslint-disable-next-line no-bitwise
        const rawName =
          (view.getUint16(p + 8, true) & 0x800) !== 0
            ? Buffer.from(nameBytes).toString("utf8")
            : Buffer.from(nameBytes).toString("latin1");
        // version-made-by is version(+4)/os(+5): unix attrs are valid only for os 3
        // eslint-disable-next-line no-bitwise
        const mode = view.getUint8(p + 5) === 3 ? view.getUint32(p + 38, true) >>> 16 : 0;
        out.push({
          name: rawName,
          dir: rawName.endsWith("/"),
          // eslint-disable-next-line no-bitwise
          symlink: mode !== 0 && (mode & 0o170000) === 0o120000,
          mode,
          size: view.getUint32(p + 24, true),
        });
        p += 46 + view.getUint16(p + 28, true) + view.getUint16(p + 30, true) + view.getUint16(p + 32, true);
      }
      if (ok) return out;
    }
    return null;
  } catch {
    return null;
  }
};

const stopRequested = (opts: ArchiveRunOpts): boolean => opts.isCancelled?.() === true;

// one shared selection walk for both js create lanes (vanished entries skip,
// cancel/pause checked between entries): the per-node sink is the only
// caller-specific part. Returns false when the walk stopped early.
const walkSelection = async (
  names: string[],
  parent: string,
  opts: ArchiveRunOpts,
  onNode: (rel: string, abs: string, st: Stats) => Promise<boolean>,
): Promise<boolean> => {
  const walk = async (rel: string): Promise<boolean> => {
    const abs = path.join(parent, rel);
    let st: Stats | undefined;
    try {
      st = await lstat(abs);
    } catch {
      return true; // vanished mid-walk: skip (spawn warns exit-1 and proceeds too)
    }
    if (!(await onNode(rel, abs, st))) return false;
    if (st.isDirectory()) {
      for (const kid of await readdir(abs)) {
        if (stopRequested(opts)) return false;
        await opts.pauseGate?.();
        if (!(await walk(path.join(rel, kid)))) return false;
      }
    }
    return true;
  };
  for (const n of names) {
    if (stopRequested(opts)) return false;
    await opts.pauseGate?.();
    if (!(await walk(n))) return false;
  }
  return true;
};

const jsTarCompress = async (
  names: string[],
  parent: string,
  outFile: string,
  gzip: boolean,
  opts: ArchiveRunOpts,
): Promise<ArchiveRunResult> => {
  try {
    const rec: Record<string, Uint8Array> = {};
    let held = 0;
    let exec = 0;
    let links = 0;
    const done = await walkSelection(names, parent, opts, async (rel, abs, st) => {
      const key = rel.split(path.sep).join("/");
      if (st.isDirectory()) {
        rec[`${key}/`] = new Uint8Array(0);
        opts.onLine?.(rel);
        return true;
      }
      // links land as their target's bytes — Bun.Archive has no link entries.
      // Counted here so fileops can warn via onLoss without a second walk.
      if (st.isSymbolicLink()) links++;
      // eslint-disable-next-line no-bitwise
      else if ((st.mode & 0o111) !== 0) exec++;
      const data = await Bun.file(abs).bytes();
      held += data.length;
      if (held > JS_ARCHIVE_MEMORY_LIMIT)
        throw new Error(`source too large for fallback (>${JS_ARCHIVE_MEMORY_LIMIT / 1048576}MB held): install tar`);
      rec[key] = data;
      opts.onLine?.(rel);
      return true;
    });
    if (!done) return { code: 0, stdout: "", stderr: "" };
    // one last gate before the heavy serialize+write tail (a walk of many
    // small files can hand hundreds of MB to this single uninterruptible
    // stretch — don't start it on an already-cancelled op)
    if (stopRequested(opts)) return { code: 0, stdout: "", stderr: "" };
    await opts.pauseGate?.();
    // NOTE: Bun.write(out, arch) ignores { compress } on 1.4.0 (writes raw
    // tar — probed) and Bun.file refs write 0-byte entries (#28459): bytes
    // in, .bytes() out is the only correct sink until upstream fixes both.
    const arch = new Bun.Archive(rec, gzip ? { compress: "gzip" } : undefined);
    await Bun.write(outFile, await arch.bytes());
    opts.onLoss?.({ exec, links });
    return { code: 0, stdout: "", stderr: "" };
  } catch (err) {
    return { code: 2, stdout: "", stderr: errMessage(err) };
  }
};

const jsTarExtract = async (
  file: string,
  destDir: string,
  gunzip: boolean,
  opts: ArchiveRunOpts,
): Promise<ArchiveRunResult> => {
  try {
    // stat BEFORE the read: the guard must fire before the load it guards
    const st = statSync(file, { throwIfNoEntry: false });
    if (!st) return { code: 2, stdout: "", stderr: `cannot read ${file}` };
    if (st.size > JS_ARCHIVE_MEMORY_LIMIT)
      return { code: 2, stdout: "", stderr: `archive too large for fallback: install tar` };
    const raw = await Bun.file(file).bytes();
    const data = gunzip ? Bun.gunzipSync(raw) : raw;
    if (data.length > JS_ARCHIVE_MEMORY_LIMIT)
      return { code: 2, stdout: "", stderr: `archive too large for fallback: install tar` };
    if (stopRequested(opts)) return { code: 0, stdout: "", stderr: "" };
    // Bun.Archive.extract restores modes/symlinks/empty dirs of real
    // tarballs (probed) — the create-side loss above doesn't apply here.
    // No per-entry callback exists, so progress lands as one honest jump.
    const n = await new Bun.Archive(data).extract(destDir);
    for (let i = 0; i < n; i++) {
      if (stopRequested(opts)) break;
      opts.onLine?.("entry");
    }
    return { code: 0, stdout: "", stderr: "" };
  } catch (err) {
    return { code: 2, stdout: "", stderr: errMessage(err) };
  }
};

const jsZipCompress = async (
  names: string[],
  parent: string,
  outFile: string,
  opts: ArchiveRunOpts,
): Promise<ArchiveRunResult> => {
  // lazy import INSIDE the guarded promise: only zip-fallback runs pay the
  // module load (~84ms cold, benched) — and an import failure resolves
  // {code:2} instead of rejecting into fileops' fire-and-forget `void`.
  let settled = false;
  return new Promise<ArchiveRunResult>((resolve) => {
    const done = (r: ArchiveRunResult): void => {
      if (!settled) {
        settled = true;
        resolve(r);
      }
    };
    (async () => {
      try {
        const { Zip, ZipDeflate, ZipPassThrough } = await import("fflate");
        const chunks: Uint8Array[] = [];
        let outBytes = 0;
        const zip = new Zip((err, data, final) => {
          if (err) {
            done({ code: 2, stdout: "", stderr: errMessage(err) });
            return;
          }
          if (data.length) {
            chunks.push(data);
            outBytes += data.length;
          }
          if (final) {
            Bun.write(outFile, Buffer.concat(chunks)).then(
              () => done({ code: 0, stdout: "", stderr: "" }),
              (e: unknown) => done({ code: 2, stdout: "", stderr: errMessage(e) }),
            );
          }
        });
        const overLimit = (): boolean => outBytes > JS_ARCHIVE_MEMORY_LIMIT;
        try {
          let held = 0;
          const finished = await walkSelection(names, parent, opts, async (rel, abs, st) => {
            // output chunks live in RAM until zip.end(): bail loudly (code 2,
            // never a silent partial) past the limit on ANY entry kind
            if (overLimit())
              throw new Error(
                `source too large for fallback (>${JS_ARCHIVE_MEMORY_LIMIT / 1048576}MB held): install zip`,
              );
            const key = rel.split(path.sep).join("/");
            if (st.isDirectory()) {
              const d = new ZipPassThrough(`${key}/`);
              d.os = 3;
              // eslint-disable-next-line no-bitwise
              d.attrs = (st.mode << 16) >>> 0;
              zip.add(d);
              d.push(new Uint8Array(0), true);
              opts.onLine?.(rel);
              return true;
            }
            const f = new ZipDeflate(key, { level: 6 });
            // instance props, NOT ctor opts (ctor only reads level — probed:
            // opts form silently writes FAT defaults and drops exec bits)
            f.os = 3;
            if (st.isSymbolicLink()) {
              let target: string;
              try {
                target = await readlink(abs);
              } catch {
                return true; // raced away mid-walk: skip like a vanished file
              }
              // eslint-disable-next-line no-bitwise
              f.attrs = (0o120777 << 16) >>> 0;
              zip.add(f);
              f.push(new TextEncoder().encode(target), true);
            } else {
              // eslint-disable-next-line no-bitwise
              f.attrs = (st.mode << 16) >>> 0;
              zip.add(f);
              const data = await Bun.file(abs).bytes();
              held += data.length;
              if (held > JS_ARCHIVE_MEMORY_LIMIT || overLimit())
                throw new Error(
                  `source too large for fallback (>${JS_ARCHIVE_MEMORY_LIMIT / 1048576}MB held): install zip`,
                );
              f.push(data, true);
            }
            opts.onLine?.(rel);
            return true;
          });
          if (!finished) {
            done({ code: 0, stdout: "", stderr: "" });
            return;
          }
          zip.end();
        } catch (err) {
          done({ code: 2, stdout: "", stderr: errMessage(err) });
        }
      } catch (err) {
        done({ code: 2, stdout: "", stderr: errMessage(err) });
      }
    })();
  });
};

const jsZipExtract = async (file: string, destDir: string, opts: ArchiveRunOpts): Promise<ArchiveRunResult> => {
  try {
    const { unzipSync } = await import("fflate");
    const st = statSync(file, { throwIfNoEntry: false });
    if (!st) return { code: 2, stdout: "", stderr: `cannot read ${file}` };
    if (st.size > JS_ARCHIVE_MEMORY_LIMIT)
      return { code: 2, stdout: "", stderr: `archive too large for fallback: install unzip` };
    const raw = await Bun.file(file).bytes();
    const entries = readZipEntries(raw);
    if (!entries) return { code: 2, stdout: "", stderr: `cannot list ${file}` };
    const total = entries.reduce((n, e) => n + e.size, 0);
    if (total > JS_ARCHIVE_MEMORY_LIMIT)
      return { code: 2, stdout: "", stderr: `archive too large for fallback: install unzip` };
    if (stopRequested(opts)) return { code: 0, stdout: "", stderr: "" };
    const map = unzipSync(raw);
    const base = path.resolve(destDir);
    const writeOne = (e: (typeof entries)[number]): void => {
      // empty names and escapes never touch disk: skip, don't fail (spawn
      // unzip has its own rules; a new parser must not add a traversal).
      if (!e.name) return;
      const dest = path.resolve(base, e.name);
      if (dest !== base && !dest.startsWith(`${base}${path.sep}`)) return;
      if (e.dir) {
        mkdirSync(dest, { recursive: true });
      } else if (!e.symlink) {
        const data = map[e.name];
        if (!data) return; // undecodable entry: skip rather than a 0-byte success file
        mkdirSync(path.dirname(dest), { recursive: true });
        writeFileSync(dest, Buffer.from(data));
        // mask to rwx: never restore setuid/setgid/sticky from an archive,
        // and one bad mode skips its file instead of aborting the op
        try {
          // eslint-disable-next-line no-bitwise
          if (e.mode !== 0) chmodSync(dest, e.mode & 0o777);
        } catch {}
      }
      // links land DEAD LAST (second pass below): an entry that resolves
      // through an on-disk link would otherwise write outside staging.
    };
    for (const e of entries) {
      if (e.symlink) continue;
      if (stopRequested(opts)) return { code: 0, stdout: "", stderr: "" };
      await opts.pauseGate?.();
      try {
        writeOne(e);
      } catch {}
      opts.onLine?.(e.name);
    }
    for (const e of entries) {
      if (!e.symlink) continue;
      if (stopRequested(opts)) return { code: 0, stdout: "", stderr: "" };
      await opts.pauseGate?.();
      try {
        if (!e.name) continue;
        const dest = path.resolve(base, e.name);
        if (dest !== base && !dest.startsWith(`${base}${path.sep}`)) continue;
        const data = map[e.name];
        if (!data) continue;
        mkdirSync(path.dirname(dest), { recursive: true });
        try {
          symlinkSync(Buffer.from(data).toString("utf8"), dest);
        } catch {}
      } catch {}
      opts.onLine?.(e.name);
    }
    return { code: 0, stdout: "", stderr: "" };
  } catch (err) {
    return { code: 2, stdout: "", stderr: errMessage(err) };
  }
};

const runJsArchive = (task: ArchiveTask, opts: ArchiveRunOpts): Promise<ArchiveRunResult> => {
  if (task.op === "extract" && task.fmt === "zip") return jsZipExtract(task.file, task.destDir, opts);
  if (task.op === "extract") return jsTarExtract(task.file, task.destDir, task.fmt === "tar.gz", opts);
  if (task.op === "compress" && task.fmt === "zip") return jsZipCompress(task.names, task.parent, task.outFile, opts);
  return jsTarCompress(task.names, task.parent, task.outFile, task.fmt === "tar.gz", opts);
};

// spawn when tools exist, js fallback for tar/tar.gz/zip, refusal otherwise.
// `run`/`which` are injectable so tests never shell out; fileops passes its
// ctx seam + archiveWhich through.
export const runArchiveTask: ArchiveTaskRun = async (task, opts = {}) => {
  const which = opts.which ?? Bun.which;
  const lane = selectArchiveLane(task.fmt, task.op === "extract" ? "extract" : "create", which);
  if (lane === "spawn") {
    const spec =
      task.op === "extract"
        ? extractPlan(task.fmt, task.file, task.destDir, which)
        : compressPlan(task.fmt, task.outFile, task.names, task.parent, which);
    return (opts.run ?? runArchiveTool)(spec, opts);
  }
  if (lane === "js") return runJsArchive(task, opts);
  const need =
    task.fmt === "7z" ? "7z" : defOf(task.fmt).need.length ? defOf(task.fmt).need.join(", ") : "zip/unzip/7z";
  return { code: 127, stdout: "", stderr: `cannot handle .${task.fmt} archives (missing ${need})` };
};
