import type { ChildProcess, SpawnOptions } from "node:child_process";
import { existsSync } from "node:fs";
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
};
export type ArchiveRun = (spec: ToolSpec, opts?: ArchiveRunOpts) => Promise<ArchiveRunResult>;
type SpawnFn = (cmd: string, args: string[], opts: SpawnOptions, onFail: (err: Error) => void) => ChildProcess;
type WhichFn = (bin: string) => string | null;

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
  const def = DEF.get(fmt)!;
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
  const def = DEF.get(fmt)!;
  if (def.kind === "tar")
    // -v: emit entry names so the file-count progress bar advances
    // --no-same-owner: extracting as non-root otherwise warns/fails on ownership
    return {
      tool: "tar",
      args: ["-x", "-v", ...def.filter, "-f", file, "-C", destDir, "--no-same-owner"],
    };
  if (def.kind === "7z") return { tool: "7z", args: ["x", "-y", `-o${destDir}`, file] };
  return zipExtractTool(which) === "unzip"
    ? { tool: "unzip", args: ["-o", file, "-d", destDir] }
    : { tool: "7z", args: ["x", "-y", `-o${destDir}`, file] };
};

export const listArgs = (fmt: ArchiveFormat, file: string, which: WhichFn = Bun.which): string[] => {
  const def = DEF.get(fmt)!;
  if (def.kind === "tar") return ["-t", ...def.filter, "-f", file];
  if (def.kind === "7z") return ["l", "-ba", file];
  return zipExtractTool(which) === "unzip" ? ["-Z1", file] : ["l", "-ba", file];
};

export const compressionExt = (fmt: CompressionFormat): string => DEF.get(fmt)!.ext;
export const compressionHint = (fmt: CompressionFormat): string => DEF.get(fmt)!.hint;

// -C <parent> + basenames: the archive stores the selected entries relative to
// their common parent, never absolute paths (tar strips leading / with a warning)
export const compressPlan = (
  fmt: CompressionFormat,
  outFile: string,
  names: string[],
  parent: string,
  which: WhichFn = Bun.which,
): ToolSpec => {
  const def = DEF.get(fmt)!;
  // a name starting with "-" would otherwise be parsed as an option (tar -v,
  // --files-from=…): tar/7z get an explicit `--`, zip an escaped "./" operand
  if (def.kind === "tar")
    return { tool: "tar", args: ["-c", ...def.filter, "-v", "-f", outFile, "-C", parent, "--", ...names] };
  if (def.kind === "7z") return { tool: "7z", args: ["a", "-t7z", "-y", outFile, "--", ...names] };
  const zipNames = names.map((n) => (n.startsWith("-") ? `./${n}` : n));
  return zipCreateTool(which) === "zip"
    ? { tool: "zip", args: ["-r", outFile, ...zipNames] }
    : { tool: "7z", args: ["a", "-tzip", "-y", outFile, "--", ...zipNames] };
};

export const availableCompressionFormats = (which: WhichFn = Bun.which): CompressionFormat[] =>
  COMPRESSIONS.filter((d) => canCreate(d, which)).map((d) => d.fmt);

export const canExtract = (file: string, which: WhichFn = Bun.which): boolean => {
  const fmt = detectArchiveFormat(file);
  if (!fmt) return false;
  return canExtractFmt(DEF.get(fmt)!, which);
};

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
  if (!paths.length) return "/";
  let p = path.dirname(paths[0]!);
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
      stderr = appendCapped(stderr, err instanceof Error ? err.message : String(err));
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
