import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import {
  availableCompressionFormats,
  canExtract,
  commonParent,
  compressPlan,
  compressionExt,
  compressionHint,
  countArchiveEntries,
  countTarEntries,
  countZipEntries,
  detectArchiveFormat,
  extractPlan,
  isArchiveEntryLine,
  listArchiveEntries,
  makeLineCounter,
  parseToolLine,
  runArchiveTask,
  runArchiveTool,
  selectArchiveLane,
  uniqueArchiveTarget,
} from "./archive";

type FakeChild = EventEmitter & { stdout: PassThrough; stderr: PassThrough; kill: () => void; pid: number };

const fakeChild = (): FakeChild => {
  const c = new EventEmitter() as FakeChild;
  c.stdout = new PassThrough();
  c.stderr = new PassThrough();
  c.kill = () => {};
  c.pid = 123;
  return c;
};

const which =
  (...bins: string[]) =>
  (bin: string) =>
    bins.includes(bin) ? `/usr/bin/${bin}` : null;

describe("detectArchiveFormat", () => {
  test("compound suffixes win over shorter ones", () => {
    expect(detectArchiveFormat("a.tar.gz")).toBe("tar.gz");
    expect(detectArchiveFormat("a.TGZ")).toBe("tar.gz");
    expect(detectArchiveFormat("a.tar.bz2")).toBe("tar.bz2");
    expect(detectArchiveFormat("a.tbz2")).toBe("tar.bz2");
    expect(detectArchiveFormat("a.txz")).toBe("tar.xz");
    expect(detectArchiveFormat("a.tar.zst")).toBe("tar.zst");
    expect(detectArchiveFormat("a.tar.lz4")).toBe("tar.lz4");
    expect(detectArchiveFormat("a.tar.br")).toBe("tar.br");
    expect(detectArchiveFormat("a.tar.lzma")).toBe("tar.lzma");
    expect(detectArchiveFormat("a.tar.lzo")).toBe("tar.lzo");
    expect(detectArchiveFormat("a.tar.Z")).toBe("tar.Z");
    expect(detectArchiveFormat("a.tar")).toBe("tar");
    expect(detectArchiveFormat("a.zip")).toBe("zip");
    expect(detectArchiveFormat("a.7z")).toBe("7z");
  });

  test("single-file compressed streams are not archives", () => {
    expect(detectArchiveFormat("a.gz")).toBeNull();
    expect(detectArchiveFormat("a.xz")).toBeNull();
    expect(detectArchiveFormat("a.bz2")).toBeNull();
    expect(detectArchiveFormat("a.zst")).toBeNull();
    expect(detectArchiveFormat("a.lz4")).toBeNull();
    expect(detectArchiveFormat("notes.txt")).toBeNull();
    expect(detectArchiveFormat(".bashrc")).toBeNull();
  });
});

describe("extractPlan", () => {
  test("tar carries -v (progress) and the filter (auto-detect is not enough for -I lz4/brotli)", () => {
    expect(extractPlan("tar.gz", "/x/a.tar.gz", "/stage", which("tar", "gzip"))).toEqual({
      tool: "tar",
      args: ["-x", "-v", "-z", "-f", "/x/a.tar.gz", "-C", "/stage", "--no-same-owner"],
    });
    expect(extractPlan("tar.lz4", "/x/a.tar.lz4", "/stage", which("tar", "lz4"))).toEqual({
      tool: "tar",
      args: ["-x", "-v", "-I", "lz4", "-f", "/x/a.tar.lz4", "-C", "/stage", "--no-same-owner"],
    });
    expect(extractPlan("tar", "/x/a.tar", "/stage", which("tar")).args).not.toContain("-z");
  });

  test("zip uses unzip when present, 7z otherwise", () => {
    expect(extractPlan("zip", "/x/a.zip", "/stage", which("unzip"))).toEqual({
      tool: "unzip",
      args: ["-o", "/x/a.zip", "-d", "/stage"],
    });
    expect(extractPlan("zip", "/x/a.zip", "/stage", which("7z"))).toEqual({
      tool: "7z",
      args: ["x", "-bb1", "-bso2", "-y", "-o/stage", "/x/a.zip"],
    });
  });

  test("7z extracts via 7z", () => {
    expect(extractPlan("7z", "/x/a.7z", "/stage", which("7z"))).toEqual({
      tool: "7z",
      args: ["x", "-bb1", "-bso2", "-y", "-o/stage", "/x/a.7z"],
    });
  });

  test("7z carries -bb1 (one line per file) so the file-count bar advances", () => {
    // plain `7z a/x` emits a fixed ~6 header lines no matter the entry count,
    // so the bar sat at 0 until completion — same freeze class as tar without -v
    expect(extractPlan("7z", "/x/a.7z", "/stage", which("7z")).args).toContain("-bb1");
    expect(extractPlan("zip", "/x/a.zip", "/stage", which("7z")).args).toContain("-bb1");
    expect(compressPlan("7z", "/out/a.7z", ["foo"], "/src", which("7z")).args).toContain("-bb1");
    expect(compressPlan("zip", "/out/a.zip", ["foo"], "/src", which("7z")).args).toContain("-bb1");
  });

  test("7z carries -bso2 (entry log to stderr) so lines stream live when piped", () => {
    // probed: 7z block-buffers stdout when piped — every line (including the
    // -bb1 per-file lines) arrived at process exit, so the compress bar sat at
    // 0/N then jumped to done. stderr is unbuffered, and -bso2 moves the entry
    // log there; tar -v and unzip flush per entry and never needed this.
    // (tar/zip-tool/unzip plans must NOT carry it — unknown switches break them)
    expect(compressPlan("7z", "/out/a.7z", ["foo"], "/src", which("7z")).args).toContain("-bso2");
    expect(extractPlan("7z", "/x/a.7z", "/stage", which("7z")).args).toContain("-bso2");
    expect(compressPlan("zip", "/out/a.zip", ["foo"], "/src", which("7z")).args).toContain("-bso2");
    expect(extractPlan("zip", "/x/a.zip", "/stage", which("7z")).args).toContain("-bso2");
    expect(compressPlan("tar.gz", "/out/a.tar.gz", ["foo"], "/src", which("tar", "gzip")).args).not.toContain("-bso2");
    expect(compressPlan("zip", "/out/a.zip", ["foo"], "/src", which("zip")).args).not.toContain("-bso2");
    expect(extractPlan("zip", "/x/a.zip", "/stage", which("unzip")).args).not.toContain("-bso2");
  });

  test("zip via Info-ZIP is stdbuf-wrapped when available (same piped-stdout freeze class as 7z)", () => {
    // `zip -r` has no stream switch, so unbuffer with stdbuf when present;
    // without it the plain spec runs (today's end-batched behavior, not a failure)
    expect(compressPlan("zip", "/o/a.zip", ["f"], "/src", which("zip", "stdbuf"))).toEqual({
      tool: "stdbuf",
      args: ["-o0", "-e0", "zip", "-r", "/o/a.zip", "f"],
    });
    expect(compressPlan("zip", "/o/a.zip", ["f"], "/src", which("zip"))).toEqual({
      tool: "zip",
      args: ["-r", "/o/a.zip", "f"],
    });
  });
});

describe("compressPlan / compressionExt / compressionHint", () => {
  test("tar stores names relative to the common parent", () => {
    expect(compressPlan("tar.gz", "/out/a.tar.gz", ["foo", "bar"], "/src", which("tar", "gzip"))).toEqual({
      tool: "tar",
      args: ["-c", "-z", "-v", "-f", "/out/a.tar.gz", "-C", "/src", "--", "foo", "bar"],
    });
    expect(compressPlan("tar.zst", "/out/a.tar.zst", ["foo"], "/src").args.slice(0, 4)).toEqual([
      "-c",
      "--zstd",
      "-v",
      "-f",
    ]);
    expect(compressPlan("tar.lz4", "/out/a.tar.lz4", ["foo"], "/src").args.slice(0, 3)).toEqual(["-c", "-I", "lz4"]);
    expect(compressPlan("tar", "/out/a.tar", ["foo"], "/src").args.slice(0, 2)).toEqual(["-c", "-v"]);
  });

  test("a dash-leading name is never parsed as an option", () => {
    // tar/7z get `--`; zip has no reliable `--`, so its operands escape to ./
    expect(compressPlan("tar.gz", "/o/a.tar.gz", ["-v"], "/src", which("tar", "gzip")).args.at(-2)).toBe("--");
    expect(compressPlan("zip", "/o/a.zip", ["-v"], "/src", which("zip"))).toEqual({
      tool: "zip",
      args: ["-r", "/o/a.zip", "./-v"],
    });
    expect(compressPlan("zip", "/o/a.zip", ["-v"], "/src", which("7z"))).toEqual({
      tool: "7z",
      args: ["a", "-bb1", "-bso2", "-tzip", "-y", "/o/a.zip", "--", "./-v"],
    });
  });

  test("zip uses zip when present, 7z otherwise; 7z is 7z", () => {
    expect(compressPlan("zip", "/out/a.zip", ["foo"], "/src", which("zip"))).toEqual({
      tool: "zip",
      args: ["-r", "/out/a.zip", "foo"],
    });
    expect(compressPlan("zip", "/out/a.zip", ["foo"], "/src", which("7z"))).toEqual({
      tool: "7z",
      args: ["a", "-bb1", "-bso2", "-tzip", "-y", "/out/a.zip", "--", "foo"],
    });
    expect(compressPlan("7z", "/out/a.7z", ["foo"], "/src", which("7z"))).toEqual({
      tool: "7z",
      args: ["a", "-bb1", "-bso2", "-t7z", "-y", "/out/a.7z", "--", "foo"],
    });
  });

  test("extension + hint per format", () => {
    expect(compressionExt("tar.gz")).toBe(".tar.gz");
    expect(compressionExt("tar.Z")).toBe(".tar.Z");
    expect(compressionExt("7z")).toBe(".7z");
    expect(compressionHint("tar.lz4")).toBe("lz4");
    expect(compressionHint("tar")).toBe("tar (no compression)");
  });
});

describe("availableCompressionFormats / canExtract", () => {
  test("every compressor present yields the full table in picker order", () => {
    const all = which(
      ...["tar", "gzip", "zip", "7z", "xz", "bzip2", "zstd", "lzma", "lz4", "brotli", "lzip", "lzop", "compress"],
    );
    expect(availableCompressionFormats(all)).toEqual([
      "tar.gz",
      "zip",
      "7z",
      "tar",
      "tar.xz",
      "tar.bz2",
      "tar.zst",
      "tar.lzma",
      "tar.lz4",
      "tar.br",
      "tar.lz",
      "tar.lzo",
      "tar.Z",
    ]);
  });

  test("missing compressors hide their tar rows; zip falls back to 7z", () => {
    expect(availableCompressionFormats(which("tar"))).toEqual(["tar.gz", "zip", "tar"]);
    expect(availableCompressionFormats(which("tar", "gzip"))).toEqual(["tar.gz", "zip", "tar"]);
    // no zip binary, no 7z -> the js fallback still offers zip
    expect(availableCompressionFormats(which("tar", "zip"))).toContain("zip");
    expect(availableCompressionFormats(which("tar", "7z"))).toContain("zip");
    // 7z and exotic filters have no fallback: without their tools they hide
    expect(availableCompressionFormats(which("tar"))).not.toContain("7z");
    expect(availableCompressionFormats(which("tar"))).not.toContain("tar.xz");
    expect(availableCompressionFormats(() => null)).toEqual(["tar.gz", "zip", "tar"]);
  });

  test("canExtract needs the matching toolchain — except fallback formats", () => {
    expect(canExtract("a.zip", which("unzip"))).toBe(true);
    expect(canExtract("a.zip", which("7z"))).toBe(true);
    expect(canExtract("a.zip", which("tar"))).toBe(true); // js fallback, no tools needed
    expect(canExtract("a.tar.gz", which("tar", "gzip"))).toBe(true);
    expect(canExtract("a.tar.gz", which("tar"))).toBe(true); // js fallback (gzip is not optional for spawn)
    expect(canExtract("a.tar.gz", () => null)).toBe(true);
    expect(canExtract("a.tar.lz4", which("tar", "lz4"))).toBe(true);
    expect(canExtract("a.tar.lz4", which("tar"))).toBe(false); // no fallback for exotic filters
    expect(canExtract("a.7z", which("7z"))).toBe(true);
    expect(canExtract("a.7z", () => null)).toBe(false); // no fallback for 7z
    expect(canExtract("a.txt", which("tar", "gzip"))).toBe(false);
  });
});

describe("commonParent", () => {
  test("siblings share their dir; a single entry uses its parent", () => {
    expect(commonParent(["/a/foo", "/a/bar"])).toBe("/a");
    expect(commonParent(["/a/foo"])).toBe("/a");
    expect(commonParent(["/a/b/foo", "/a/b/c/bar"])).toBe("/a/b");
  });

  test("falls back to root when trees diverge", () => {
    expect(commonParent(["/a/foo", "/x/y"])).toBe("/");
  });
});

describe("parseToolLine / makeLineCounter", () => {
  test("blank lines are dropped", () => {
    expect(parseToolLine("  ")).toBeNull();
    expect(parseToolLine("foo/\r")).toBe("foo/");
  });

  test("splits chunks on newlines and flushes the tail", () => {
    const got: string[] = [];
    const c = makeLineCounter((l) => got.push(l));
    c.push("a\nb");
    c.push("\nc\n");
    c.flush();
    expect(got).toEqual(["a", "b", "c"]);
  });
});

describe("isArchiveEntryLine", () => {
  // fixtures are verbatim tool output captured with piped stdout/stderr (see
  // /tmp/opencode/probe-*.ts transcripts): headers must not advance the bar,
  // only real member lines may
  test("7z: only + / - entry lines count", () => {
    expect(isArchiveEntryLine("7z", "+ src/f0.bin")).toBe(true);
    expect(isArchiveEntryLine("7z", "- src/f0.bin")).toBe(true);
    for (const h of [
      "7-Zip 26.03 (x64) : Copyright (c) 1999-2026 Igor Pavlov : 2026-09-03",
      " 64-bit locale=en_PH.UTF-8 Threads:2 OPEN_MAX:1048576, ASM",
      "Scanning the drive:",
      "1 folder, 12 files, 25165824 bytes (24 MiB)",
      "Creating archive: /tmp/x/s.7z",
      "Add new data to archive: 1 folder, 12 files, 25165824 bytes (24 MiB)",
      "Files read from disk: 12",
      "Archive size: 21866 bytes (22 KiB)",
      "Everything is Ok",
      "--",
      "Path = /tmp/x/s.7z",
      "Type = 7z",
      "Folders: 1",
    ])
      expect(isArchiveEntryLine("7z", h)).toBe(false);
  });

  test("zip: adding/updating count on the Info-ZIP lane, + lines on the 7z lane", () => {
    expect(isArchiveEntryLine("zip", "  adding: src/f0.bin (deflated 99%)")).toBe(true);
    expect(isArchiveEntryLine("zip", "  updating: src/f0.bin (deflated 99%)")).toBe(true);
    expect(isArchiveEntryLine("zip", "+ src/f0.bin")).toBe(true);
    expect(isArchiveEntryLine("zip", "7-Zip 26.03 (x64) : Copyright (c) 1999-2026 Igor Pavlov")).toBe(false);
    expect(isArchiveEntryLine("zip", "Add new data to archive: 1 folder, 12 files")).toBe(false);
    expect(isArchiveEntryLine("zip", "Everything is Ok")).toBe(false);
  });

  test("zip extract: inflating/creating count (unzip lane), Archive: header doesn't", () => {
    expect(isArchiveEntryLine("zip", "  inflating: /tmp/x/src/f0.bin  ")).toBe(true);
    expect(isArchiveEntryLine("zip", "   creating: /tmp/x/src/")).toBe(true);
    expect(isArchiveEntryLine("zip", "  extracting: /tmp/x/src/f0.bin  ")).toBe(true);
    expect(isArchiveEntryLine("zip", "Archive:  /tmp/x/s.zip")).toBe(false);
    expect(isArchiveEntryLine("zip", "- src/f0.bin")).toBe(true);
  });

  test("tar: every line is a member (no headers in -v output)", () => {
    expect(isArchiveEntryLine("tar.gz", "src/")).toBe(true);
    expect(isArchiveEntryLine("tar.gz", "src/f0.bin")).toBe(true);
  });
});

describe("runArchiveTask progress filtering", () => {
  test("spawn-lane progress counts entry lines only (headers don't advance the bar)", async () => {
    const seen: string[] = [];
    const toolLog = [
      "7-Zip 26.03 (x64) : Copyright (c) 1999-2026 Igor Pavlov : 2026-09-03",
      "Scanning the drive:",
      "Add new data to archive: 1 folder, 2 files",
      "+ a.txt",
      "+ sub/b.txt",
      "Files read from disk: 2",
      "Everything is Ok",
    ];
    const res = await runArchiveTask(
      { op: "compress", fmt: "7z", outFile: "/o/a.7z", names: ["a.txt"], parent: "/" },
      {
        which: which("7z"),
        run: async (_spec, opts) => {
          for (const l of toolLog) opts?.onLine?.(l);
          return { code: 0, stdout: "", stderr: "" };
        },
        onLine: (l) => seen.push(l),
      },
    );
    expect(res.code).toBe(0);
    expect(seen).toEqual(["+ a.txt", "+ sub/b.txt"]);
  });
});

describe("runArchiveTask stdbuf fallback", () => {
  const zipStdbuf = (bin: string): string | null => (bin === "zip" || bin === "stdbuf" ? `/usr/bin/${bin}` : null);

  test("a failed stdbuf shim retries once unwrapped", async () => {
    const seen: string[] = [];
    let n = 0;
    const res = await runArchiveTask(
      { op: "compress", fmt: "zip", outFile: "/o/a.zip", names: ["f"], parent: "/src" },
      {
        which: zipStdbuf,
        run: async (spec) => {
          seen.push(spec.tool);
          // the shim's own spawn failure surfaces as code -1; the plain run lands
          return n++ === 0
            ? { code: -1, stdout: "", stderr: "spawn stdbuf ENOENT" }
            : { code: 0, stdout: "", stderr: "" };
        },
      },
    );
    expect(res.code).toBe(0);
    expect(seen).toEqual(["stdbuf", "zip"]);
  });

  test("a cancelled op never retries (✕ also surfaces as code -1)", async () => {
    const seen: string[] = [];
    const res = await runArchiveTask(
      { op: "compress", fmt: "zip", outFile: "/o/a.zip", names: ["f"], parent: "/src" },
      {
        which: zipStdbuf,
        isCancelled: () => true,
        run: async (spec) => {
          seen.push(spec.tool);
          return { code: -1, stdout: "", stderr: "" };
        },
      },
    );
    expect(res.code).toBe(-1);
    expect(seen).toEqual(["stdbuf"]);
  });
});

describe("uniqueArchiveTarget", () => {
  test("inserts (copy) before the compound extension", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "tfm-archive-"));
    try {
      writeFileSync(path.join(dir, "foo.tar.gz"), "");
      expect(uniqueArchiveTarget(dir, "foo", ".tar.gz")).toBe(path.join(dir, "foo (copy).tar.gz"));
      writeFileSync(path.join(dir, "foo (copy).tar.gz"), "");
      expect(uniqueArchiveTarget(dir, "foo", ".tar.gz")).toBe(path.join(dir, "foo (copy 2).tar.gz"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("runArchiveTool", () => {
  test("streams both pipes line-buffered and reports the exit code", async () => {
    const child = fakeChild();
    const lines: string[] = [];
    const p = runArchiveTool(
      { tool: "tar", args: [] },
      {
        spawn: (() => {
          setTimeout(() => {
            child.stdout.write("a/\nb\n");
            child.stderr.write("c\n");
            child.emit("close", 0);
          }, 0);
          return child;
        }) as never,
        onLine: (l) => lines.push(l),
      },
    );
    const res = await p;
    expect(res.code).toBe(0);
    expect(res.stdout).toBe("a/\nb\n");
    expect(res.stderr).toBe("c\n");
    expect(lines).toEqual(["a/", "b", "c"]);
  });

  test("a missing binary (async error) resolves instead of throwing", async () => {
    const res = await runArchiveTool(
      { tool: "nope", args: [] },
      {
        spawn: ((_cmd: string, _args: string[], _opts: unknown, onFail: (e: Error) => void) => {
          onFail(new Error("spawn nope ENOENT"));
          return fakeChild();
        }) as never,
      },
    );
    expect(res.code).toBe(-1);
    expect(res.stderr).toContain("ENOENT");
  });

  test("timeoutMs kills a hung child instead of wedging the op queue", async () => {
    // without the backstop this test hangs forever (red via the suite timeout):
    // a wedged tar/7z holds the serial queue, and quit/restart refuse while busy
    const child = fakeChild();
    const killed: unknown[] = [];
    child.kill = ((sig: unknown) => {
      killed.push(sig);
    }) as never;
    const res = await runArchiveTool({ tool: "tar", args: [] }, { spawn: (() => child) as never, timeoutMs: 20 });
    expect(res.code).toBe(-1);
    expect(res.stderr).toContain("timed out");
    expect(killed).toContain("SIGKILL");
  });
});

describe("listArchiveEntries", () => {
  test("counts the lines streamed through onLine", async () => {
    const run = async (_spec: unknown, opts?: { onLine?: (l: string) => void }) => {
      opts?.onLine?.("a/");
      opts?.onLine?.("a/b.txt");
      return { code: 0, stdout: "", stderr: "" };
    };
    expect(await listArchiveEntries("tar.gz", "x.tar.gz", run)).toBe(2);
  });

  test("fatal listing failure yields 0 so the op still proceeds", async () => {
    const run = async () => ({ code: 2, stdout: "", stderr: "bad" });
    expect(await listArchiveEntries("zip", "x.zip", run, which("unzip"))).toBe(0);
  });
});

describe("selectArchiveLane", () => {
  test("spawn when the native toolchain is present", () => {
    expect(selectArchiveLane("tar.gz", "extract", which("tar", "gzip"))).toBe("spawn");
    expect(selectArchiveLane("tar.gz", "create", which("tar", "gzip"))).toBe("spawn");
    expect(selectArchiveLane("tar", "create", which("tar"))).toBe("spawn");
    expect(selectArchiveLane("zip", "create", which("zip"))).toBe("spawn");
    expect(selectArchiveLane("zip", "extract", which("unzip"))).toBe("spawn");
    expect(selectArchiveLane("7z", "extract", which("7z"))).toBe("spawn");
    expect(selectArchiveLane("tar.bz2", "extract", which("tar", "bzip2"))).toBe("spawn");
  });

  test("zip uses either native writer on create, either reader on extract", () => {
    expect(selectArchiveLane("zip", "create", which("7z"))).toBe("spawn");
    expect(selectArchiveLane("zip", "extract", which("7z"))).toBe("spawn");
  });

  test("tar/tar.gz/zip fall back to js with no tools at all", () => {
    const none = () => null;
    expect(selectArchiveLane("tar.gz", "extract", none)).toBe("js");
    expect(selectArchiveLane("tar.gz", "create", none)).toBe("js");
    expect(selectArchiveLane("tar", "extract", none)).toBe("js");
    expect(selectArchiveLane("zip", "extract", none)).toBe("js");
    expect(selectArchiveLane("zip", "create", none)).toBe("js");
  });

  test("a half toolchain still falls back for tar.gz (gzip is not optional)", () => {
    expect(selectArchiveLane("tar.gz", "extract", which("tar"))).toBe("js");
  });

  test("7z and exotic tar filters stay unavailable without their tools (no js lane)", () => {
    const none = () => null;
    expect(selectArchiveLane("7z", "extract", none)).toBe("unavailable");
    expect(selectArchiveLane("7z", "create", none)).toBe("unavailable");
    expect(selectArchiveLane("tar.bz2", "extract", which("tar"))).toBe("unavailable");
    expect(selectArchiveLane("tar.xz", "create", which("tar"))).toBe("unavailable");
  });
});

// hand-built tar: 2 files + 1 dir, no library involved (Bun.Archive's own
// layout must not be what we assert against)
const tarBytes = (): Uint8Array => {
  const blocks: Uint8Array[] = [];
  const header = (name: string, size: number, type: string): Uint8Array => {
    const h = new Uint8Array(512);
    h.set(new TextEncoder().encode(name), 0);
    h.set(new TextEncoder().encode("0000777"), 100);
    h.set(new TextEncoder().encode(size.toString(8).padStart(11, "0")), 124);
    h.set(new TextEncoder().encode(type), 156);
    h.set(new TextEncoder().encode("ustar"), 257);
    return h;
  };
  const data = (body: string): Uint8Array => {
    const raw = new TextEncoder().encode(body);
    const b = new Uint8Array(Math.ceil(raw.length / 512) * 512);
    b.set(raw, 0);
    return b;
  };
  blocks.push(header("a.txt", 2, "0"), data("hi"));
  blocks.push(header("sub/", 0, "5"));
  blocks.push(header("sub/b.txt", 600, "0"), data("x".repeat(600)));
  blocks.push(new Uint8Array(1024)); // end-of-archive zero blocks
  const out = new Uint8Array(blocks.reduce((n, b) => n + b.length, 0));
  let o = 0;
  for (const b of blocks) {
    out.set(b, o);
    o += b.length;
  }
  return out;
};

describe("countTarEntries", () => {
  test("counts files and dirs, stops at the zero blocks", () => {
    expect(countTarEntries(tarBytes())).toBe(3);
  });

  test("pax extended headers are skipped like tar -t skips them", () => {
    // 'x' entry with a 100-byte payload ahead of a real file: counted once
    const header = (name: string, size: number, type: string): Uint8Array => {
      const h = new Uint8Array(512);
      h.set(new TextEncoder().encode(name), 0);
      h.set(new TextEncoder().encode(size.toString(8).padStart(11, "0")), 124);
      h.set(new TextEncoder().encode(type), 156);
      return h;
    };
    const body = new Uint8Array(512);
    body.set(new TextEncoder().encode("x".repeat(100)), 0);
    const parts = [header("pax", 100, "x"), body, header("a.txt", 2, "0"), body, new Uint8Array(1024)];
    const out = new Uint8Array(parts.reduce((n, b) => n + b.length, 0));
    let o = 0;
    for (const b of parts) {
      out.set(b, o);
      o += b.length;
    }
    expect(countTarEntries(out)).toBe(1);
  });

  test("truncated and garbage inputs yield 0, never throw", () => {
    expect(countTarEntries(new Uint8Array(0))).toBe(0);
    expect(countTarEntries(new Uint8Array([1, 2, 3]))).toBe(0);
    expect(countTarEntries(tarBytes().slice(0, 700))).toBe(0);
  });

  test("base-256 (GNU >8GB) sizes yield 0 instead of a misparse", () => {
    const bytes = tarBytes();
    bytes[124] = 0x80; // high bit set = base-256, unrepresentable past the guard
    expect(countTarEntries(bytes)).toBe(0);
  });
});

describe("countZipEntries", () => {
  test("counts files and dir entries from the central directory", async () => {
    const { zipSync } = await import("fflate");
    const bytes = zipSync({
      "a.txt": new TextEncoder().encode("hi"),
      "empty/": new Uint8Array(0),
      "sub/b.txt": new TextEncoder().encode("yo"),
    });
    expect(countZipEntries(bytes)).toBe(3);
  });

  test("garbage and truncated inputs yield 0, never throw", () => {
    expect(countZipEntries(new Uint8Array(0))).toBe(0);
    expect(countZipEntries(new TextEncoder().encode("not a zip at all"))).toBe(0);
  });

  test("zip64 counts yield 0 instead of a misparse", async () => {
    const { zipSync } = await import("fflate");
    const bytes = Buffer.from(zipSync({ "a.txt": new TextEncoder().encode("hi") }));
    const eocd = bytes.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
    expect(eocd).toBeGreaterThan(0);
    bytes.writeUInt16LE(0xffff, eocd + 10); // total-entries sentinel
    expect(countZipEntries(bytes)).toBe(0);
  });

  test("a trailing fake EOCD fails validation and the real one still counts", async () => {
    const { zipSync } = await import("fflate");
    const real = Buffer.from(
      zipSync({ "a.txt": new TextEncoder().encode("hi"), "b.txt": new TextEncoder().encode("yo") }),
    );
    expect(countZipEntries(real)).toBe(2);
    // bogus EOCD appended past the real one: claims 99 entries at offset 0
    // (offset 0 holds a local header, not a central entry -> walk rejects it)
    const fake = Buffer.alloc(22);
    fake.writeUInt32LE(0x06054b50, 0);
    fake.writeUInt16LE(99, 10);
    fake.writeUInt32LE(0, 16);
    expect(countZipEntries(Buffer.concat([real, fake]))).toBe(2);
  });
});

describe("js lanes round-trip (no tools installed)", () => {
  const none = () => null;
  const seed = (dir: string): void => {
    mkdirSync(path.join(dir, "src", "sub"), { recursive: true });
    mkdirSync(path.join(dir, "src", "emptydir"), { recursive: true });
    writeFileSync(path.join(dir, "src", "a.txt"), "hi");
    writeFileSync(path.join(dir, "src", "sub", "b.txt"), "yo");
    writeFileSync(path.join(dir, "src", "-v"), "dash");
    writeFileSync(path.join(dir, "src", "héllo.txt"), "unicode");
  };

  test("tar.gz fallback preserves contents, dirs, unicode and dash names", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "tfm-jsrt-"));
    try {
      seed(dir);
      const out = path.join(dir, "out.tar.gz");
      const c = await runArchiveTask(
        { op: "compress", fmt: "tar.gz", outFile: out, names: ["src"], parent: dir },
        { which: none },
      );
      expect(c.code).toBe(0);
      expect(existsSync(out)).toBe(true);
      const stage = path.join(dir, "stage");
      mkdirSync(stage);
      let lines = 0;
      const e = await runArchiveTask(
        { op: "extract", fmt: "tar.gz", file: out, destDir: stage },
        { which: none, onLine: () => lines++ },
      );
      expect(e.code).toBe(0);
      expect(lines).toBeGreaterThan(0);
      expect(readFileSync(path.join(stage, "src", "a.txt"), "utf8")).toBe("hi");
      expect(readFileSync(path.join(stage, "src", "sub", "b.txt"), "utf8")).toBe("yo");
      expect(readFileSync(path.join(stage, "src", "-v"), "utf8")).toBe("dash");
      expect(readFileSync(path.join(stage, "src", "héllo.txt"), "utf8")).toBe("unicode");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("tar.gz fallback is lossy on exec bits and symlinks (documented, not silent)", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "tfm-jsloss-"));
    try {
      seed(dir);
      writeFileSync(path.join(dir, "src", "run.sh"), "#!/bin/sh\n");
      Bun.spawnSync(["chmod", "755", path.join(dir, "src", "run.sh")]);
      Bun.spawnSync(["ln", "-s", "a.txt", path.join(dir, "src", "link1")]);
      const out = path.join(dir, "out.tar.gz");
      const c = await runArchiveTask(
        { op: "compress", fmt: "tar.gz", outFile: out, names: ["run.sh", "link1"], parent: path.join(dir, "src") },
        { which: none },
      );
      // names are relative to parent: run.sh/link1 live directly under src
      expect(c.code).toBe(0);
      const stage = path.join(dir, "stage");
      mkdirSync(stage);
      const e = await runArchiveTask({ op: "extract", fmt: "tar.gz", file: out, destDir: stage }, { which: none });
      expect(e.code).toBe(0);
      // contents land, but the mode is gone and the link became a plain file
      expect(readFileSync(path.join(stage, "run.sh"), "utf8")).toBe("#!/bin/sh\n");
      // eslint-disable-next-line no-bitwise
      expect(statSync(path.join(stage, "run.sh")).mode & 0o111).toBe(0);
      expect(lstatSync(path.join(stage, "link1")).isSymbolicLink()).toBe(false);
      expect(readFileSync(path.join(stage, "link1"), "utf8")).toBe("hi");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("zip fallback preserves contents, dirs AND exec bits AND symlinks", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "tfm-jszip-"));
    try {
      seed(dir);
      writeFileSync(path.join(dir, "src", "run.sh"), "#!/bin/sh\n");
      Bun.spawnSync(["chmod", "755", path.join(dir, "src", "run.sh")]);
      Bun.spawnSync(["ln", "-s", "a.txt", path.join(dir, "src", "link1")]);
      const out = path.join(dir, "out.zip");
      const c = await runArchiveTask(
        {
          op: "compress",
          fmt: "zip",
          outFile: out,
          names: ["a.txt", "sub", "emptydir", "-v", "run.sh", "link1"],
          parent: path.join(dir, "src"),
        },
        { which: none },
      );
      expect(c.code).toBe(0);
      const stage = path.join(dir, "stage");
      mkdirSync(stage);
      const e = await runArchiveTask({ op: "extract", fmt: "zip", file: out, destDir: stage }, { which: none });
      expect(e.code).toBe(0);
      expect(readFileSync(path.join(stage, "a.txt"), "utf8")).toBe("hi");
      // eslint-disable-next-line no-bitwise
      expect(statSync(path.join(stage, "run.sh")).mode & 0o111).not.toBe(0);
      expect(lstatSync(path.join(stage, "link1")).isSymbolicLink()).toBe(true);
      expect(readlinkSync(path.join(stage, "link1"))).toBe("a.txt");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("js extract of a tool-made tar.gz keeps exec bits (loss is create-side only)", async () => {
    if (!Bun.which("tar") || !Bun.which("gzip")) return;
    const dir = mkdtempSync(path.join(os.tmpdir(), "tfm-jssys-"));
    try {
      mkdirSync(path.join(dir, "src"));
      writeFileSync(path.join(dir, "src", "run.sh"), "#!/bin/sh\n");
      Bun.spawnSync(["chmod", "755", path.join(dir, "src", "run.sh")]);
      const made = await runArchiveTool(compressPlan("tar.gz", path.join(dir, "a.tar.gz"), ["src"], dir));
      expect(made.code).toBe(0);
      const stage = path.join(dir, "stage");
      mkdirSync(stage);
      const e = await runArchiveTask(
        { op: "extract", fmt: "tar.gz", file: path.join(dir, "a.tar.gz"), destDir: stage },
        { which: none },
      );
      expect(e.code).toBe(0);
      // eslint-disable-next-line no-bitwise
      expect(statSync(path.join(stage, "src", "run.sh")).mode & 0o111).not.toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("isCancelled halts a js zip extract mid-way instead of hanging", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "tfm-jscancel-"));
    try {
      mkdirSync(path.join(dir, "src"));
      for (let i = 0; i < 200; i++) writeFileSync(path.join(dir, "src", `f${i}.txt`), "x".repeat(1000));
      const out = path.join(dir, "out.zip");
      const c = await runArchiveTask(
        { op: "compress", fmt: "zip", outFile: out, names: ["src"], parent: dir },
        { which: none },
      );
      expect(c.code).toBe(0);
      const stage = path.join(dir, "stage");
      mkdirSync(stage);
      let lines = 0;
      const e = await runArchiveTask(
        { op: "extract", fmt: "zip", file: out, destDir: stage },
        { which: none, onLine: () => lines++, isCancelled: () => lines >= 5 },
      );
      expect(e.code).toBe(0);
      expect(lines).toBeLessThan(200);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("countArchiveEntries counts without tools (tar.gz + zip)", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "tfm-jscount-"));
    try {
      seed(dir);
      const tgz = path.join(dir, "a.tar.gz");
      expect(
        (
          await runArchiveTask(
            { op: "compress", fmt: "tar.gz", outFile: tgz, names: ["src"], parent: dir },
            { which: none },
          )
        ).code,
      ).toBe(0);
      expect(await countArchiveEntries("tar.gz", tgz, undefined, none)).toBeGreaterThan(0);
      const zip = path.join(dir, "a.zip");
      expect(
        (
          await runArchiveTask(
            { op: "compress", fmt: "zip", outFile: zip, names: ["src"], parent: dir },
            { which: none },
          )
        ).code,
      ).toBe(0);
      expect(await countArchiveEntries("zip", zip, undefined, none)).toBeGreaterThan(0);
      expect(await countArchiveEntries("zip", path.join(dir, "missing.zip"), undefined, none)).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("isCancelled halts a js tar compress mid-walk, and pauseGate is honored", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "tfm-jstcancel-"));
    try {
      mkdirSync(path.join(dir, "src"));
      for (let i = 0; i < 50; i++) writeFileSync(path.join(dir, "src", `f${i}.txt`), "x".repeat(100));
      let lines = 0;
      let gates = 0;
      const out = path.join(dir, "out.tar.gz");
      const e = await runArchiveTask(
        { op: "compress", fmt: "tar.gz", outFile: out, names: ["src"], parent: dir },
        {
          which: none,
          onLine: () => lines++,
          isCancelled: () => lines >= 5,
          pauseGate: async () => {
            gates++;
          },
        },
      );
      expect(e.code).toBe(0);
      expect(lines).toBeLessThan(50);
      expect(gates).toBeGreaterThan(0);
      expect(existsSync(out)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a pre-cancelled js tar extract writes nothing", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "tfm-jstxcancel-"));
    try {
      mkdirSync(path.join(dir, "src"));
      writeFileSync(path.join(dir, "src", "a.txt"), "hi");
      const out = path.join(dir, "out.tar");
      expect(
        (
          await runArchiveTask(
            { op: "compress", fmt: "tar", outFile: out, names: ["src"], parent: dir },
            { which: none },
          )
        ).code,
      ).toBe(0);
      const stage = path.join(dir, "stage");
      mkdirSync(stage);
      const e = await runArchiveTask(
        { op: "extract", fmt: "tar", file: out, destDir: stage },
        { which: none, isCancelled: () => true },
      );
      expect(e.code).toBe(0);
      expect(readdirSync(stage)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("js totals match js progress emissions exactly on a benign tree", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "tfm-jstotals-"));
    try {
      mkdirSync(path.join(dir, "src", "sub"), { recursive: true });
      writeFileSync(path.join(dir, "src", "a.txt"), "hi");
      writeFileSync(path.join(dir, "src", "sub", "b.txt"), "yo");
      const tgz = path.join(dir, "a.tar.gz");
      expect(
        (
          await runArchiveTask(
            { op: "compress", fmt: "tar.gz", outFile: tgz, names: ["src"], parent: dir },
            { which: none },
          )
        ).code,
      ).toBe(0);
      const total = await countArchiveEntries("tar.gz", tgz, undefined, none);
      const stage = path.join(dir, "stage");
      mkdirSync(stage);
      let lines = 0;
      await runArchiveTask(
        { op: "extract", fmt: "tar.gz", file: tgz, destDir: stage },
        { which: none, onLine: () => lines++ },
      );
      expect(total).toBeGreaterThan(0);
      expect(lines).toBe(total);

      const zip = path.join(dir, "a.zip");
      expect(
        (
          await runArchiveTask(
            { op: "compress", fmt: "zip", outFile: zip, names: ["src"], parent: dir },
            { which: none },
          )
        ).code,
      ).toBe(0);
      const ztotal = await countArchiveEntries("zip", zip, undefined, none);
      const zstage = path.join(dir, "zstage");
      mkdirSync(zstage);
      let zlines = 0;
      await runArchiveTask(
        { op: "extract", fmt: "zip", file: zip, destDir: zstage },
        { which: none, onLine: () => zlines++ },
      );
      expect(ztotal).toBeGreaterThan(0);
      expect(zlines).toBe(ztotal);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the memory guard fires on stated size before reading a single byte", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "tfm-jsguard-"));
    try {
      // sparse: 600MB stated, ~0 bytes on disk — instant, no RAM
      const big = path.join(dir, "big.tar.gz");
      const p = Bun.spawnSync(["truncate", "-s", "600M", big]);
      expect(p.exitCode).toBe(0);
      expect(await countArchiveEntries("tar.gz", big, undefined, none)).toBe(0);
      const stage = path.join(dir, "stage");
      mkdirSync(stage);
      const e = await runArchiveTask({ op: "extract", fmt: "tar.gz", file: big, destDir: stage }, { which: none });
      expect(e.code).toBe(2);
      expect(e.stderr).toContain("too large");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("unavailable formats refuse with a tool hint instead of running", async () => {
    const res = await runArchiveTask(
      { op: "extract", fmt: "7z", file: "/x/a.7z", destDir: "/stage" },
      { which: () => null },
    );
    expect(res.code).not.toBe(0);
    expect(res.stderr).toContain("7z");
  });
});

describe("js zip traversal guards", () => {
  const none = () => null;
  const zipOf = async (entries: Record<string, Uint8Array>): Promise<Uint8Array> => {
    const { zipSync } = await import("fflate");
    return zipSync(entries);
  };

  test("../ and absolute entries never touch disk outside staging", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "tfm-slip-"));
    try {
      const evil = path.join(dir, "ESCAPED.txt");
      const bytes = await zipOf({
        "../ESCAPED.txt": new TextEncoder().encode("evil"),
        "/abs.txt": new TextEncoder().encode("evil"),
        "ok.txt": new TextEncoder().encode("fine"),
      });
      // point the .. at THIS dir: stage is dir/stage so ../ESCAPED.txt == dir/ESCAPED.txt
      const arch = path.join(dir, "inner", "a.zip");
      mkdirSync(path.dirname(arch), { recursive: true });
      writeFileSync(arch, Buffer.from(bytes));
      const stage = path.join(dir, "inner", "stage");
      mkdirSync(stage);
      const e = await runArchiveTask({ op: "extract", fmt: "zip", file: arch, destDir: stage }, { which: none });
      // skipped members are a warning (code 1), not silent success: the stage
      // is kept like the spawn lane, but the skip is on record
      expect(e.code).toBe(1);
      expect(existsSync(evil)).toBe(false);
      expect(existsSync("/abs.txt")).toBe(false);
      expect(readFileSync(path.join(stage, "ok.txt"), "utf8")).toBe("fine");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("symlink entries land last: write-through to an outside target is impossible", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "tfm-sliplink-"));
    try {
      const outside = path.join(dir, "outside.txt");
      writeFileSync(outside, "precious");
      // link -> dir (outside stage), then link/pwn: with single-pass order
      // the second entry would write THROUGH the just-created link
      const { Zip, ZipDeflate } = await import("fflate");
      const chunks: Uint8Array[] = [];
      await new Promise<void>((resolve, reject) => {
        const zip = new Zip((err, data, final) => {
          if (err) {
            reject(err);
            return;
          }
          if (data.length) chunks.push(data);
          if (final) resolve();
        });
        const link = new ZipDeflate("link", { level: 6 });
        link.os = 3;
        // eslint-disable-next-line no-bitwise
        link.attrs = (0o120777 << 16) >>> 0;
        zip.add(link);
        link.push(new TextEncoder().encode(dir), true);
        const pwn = new ZipDeflate("link/pwn", { level: 6 });
        zip.add(pwn);
        pwn.push(new TextEncoder().encode("pwned"), true);
        zip.end();
      });
      const arch = path.join(dir, "a.zip");
      writeFileSync(arch, Buffer.concat(chunks));
      const stage = path.join(dir, "stage");
      mkdirSync(stage);
      const e = await runArchiveTask({ op: "extract", fmt: "zip", file: arch, destDir: stage }, { which: none });
      // the refused write-through counts as a skipped member (warning, code 1)
      expect(e.code).toBe(1);
      // readdir, NOT existsSync: the write-through lands as a DANGLING
      // symlink, which existsSync reports as missing (false green)
      expect(readdirSync(dir)).not.toContain("pwn");
      expect(readFileSync(outside, "utf8")).toBe("precious");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("non-UTF8 (latin1, no EFS flag) names extract with contents intact", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "tfm-slipenc-"));
    try {
      const { zipSync } = await import("fflate");
      const bytes = Buffer.from(zipSync({ "caf\u00e9.txt": new TextEncoder().encode("coffee") }));
      // clear the EFS bit (general-purpose flag bit 11) in local + central headers
      const clearBit = (sig: number): void => {
        const at = bytes.indexOf(sig);
        if (at >= 0) bytes.writeUInt16LE(bytes.readUInt16LE(at + 8) & ~0x800, at + 8);
      };
      clearBit(0x04034b50);
      clearBit(0x02014b50);
      const arch = path.join(dir, "a.zip");
      writeFileSync(arch, bytes);
      const stage = path.join(dir, "stage");
      mkdirSync(stage);
      const e = await runArchiveTask({ op: "extract", fmt: "zip", file: arch, destDir: stage }, { which: none });
      expect(e.code).toBe(0);
      expect(readFileSync(path.join(stage, "caf\u00e9.txt"), "utf8")).toBe("coffee");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
const roundTrip = async (fmt: Parameters<typeof compressPlan>[0], need: string[]): Promise<void> => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "tfm-archint-"));
  try {
    mkdirSync(path.join(dir, "src"));
    writeFileSync(path.join(dir, "src", "a.txt"), "hi");
    const out = path.join(dir, `out${compressionExt(fmt)}`);
    const c = await runArchiveTool(compressPlan(fmt, out, ["src"], dir), { cwd: dir });
    expect(c.code, `${need.join("+")} compress: ${c.stderr}`).toBe(0);
    expect(existsSync(out)).toBe(true);

    const stage = path.join(dir, "stage");
    mkdirSync(stage);
    let lines = 0;
    const e = await runArchiveTool(extractPlan(fmt, out, stage), { onLine: () => lines++ });
    expect(e.code, `${need.join("+")} extract: ${e.stderr}`).toBe(0);
    expect(readFileSync(path.join(stage, "src", "a.txt"), "utf8")).toBe("hi");
    // extraction must stream entry names or the file-count progress bar is dead
    expect(lines, `${need.join("+")} extraction emitted progress lines`).toBeGreaterThan(0);
    expect(await listArchiveEntries(fmt, out)).toBeGreaterThan(0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

describe("tar integration", () => {
  test.skipIf(!Bun.which("tar") || !Bun.which("gzip"))("round-trips a tar.gz", async () => {
    await roundTrip("tar.gz", ["tar", "gzip"]);
  });

  test.skipIf(!Bun.which("tar"))("round-trips a plain tar", async () => {
    await roundTrip("tar", ["tar"]);
  });

  test.skipIf(!Bun.which("tar") || !Bun.which("xz"))("round-trips a tar.xz", async () => {
    await roundTrip("tar.xz", ["tar", "xz"]);
  });

  test.skipIf(!Bun.which("tar") || !Bun.which("lz4"))("round-trips tar.lz4 through the -I filter", async () => {
    await roundTrip("tar.lz4", ["tar", "lz4"]);
  });

  test.skipIf(!Bun.which("tar") || !Bun.which("brotli"))("round-trips tar.br through the -I filter", async () => {
    await roundTrip("tar.br", ["tar", "brotli"]);
  });

  test.skipIf(!Bun.which("tar") || !Bun.which("zstd"))("round-trips tar.zst", async () => {
    await roundTrip("tar.zst", ["tar", "zstd"]);
  });

  test.skipIf(!Bun.which("tar") || !Bun.which("gzip"))("compresses a dash-leading filename via --", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "tfm-dashint-"));
    try {
      writeFileSync(path.join(dir, "-v"), "x");
      const out = path.join(dir, "out.tar.gz");
      const c = await runArchiveTool(compressPlan("tar.gz", out, ["-v"], dir));
      expect(c.code, c.stderr).toBe(0);
      // if `-v` had been parsed as an option there would be no member
      expect(await listArchiveEntries("tar.gz", out)).toBeGreaterThan(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// flat file lists (no subdirs, so no dir entries): the filtered spawn-lane
// progress must equal the file count exactly — headers in, entries out
const expectFlatCompressProgress = async (fmt: Parameters<typeof compressPlan>[0]): Promise<void> => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "tfm-archprog-"));
  try {
    const N = 12;
    const src = path.join(dir, "src");
    mkdirSync(src, { recursive: true });
    const names: string[] = [];
    for (let i = 0; i < N; i++) {
      writeFileSync(path.join(src, `f${i}.txt`), "x".repeat(1000));
      names.push(`f${i}.txt`);
    }
    const out = path.join(dir, `out${compressionExt(fmt)}`);
    let cm = 0;
    const c = await runArchiveTask(
      { op: "compress", fmt, outFile: out, names, parent: src },
      // cwd: 7z/zip resolve their relative operands against the process cwd
      // (only tar carries -C), so the caller must pass parent — fileops does
      { cwd: src, onLine: () => cm++ },
    );
    expect(c.code, `${fmt} compress: ${c.stderr}`).toBe(0);
    expect(cm, `${fmt} compress progress counts entries, not headers`).toBe(N);
    const stage = path.join(dir, "stage");
    mkdirSync(stage);
    let xm = 0;
    const e = await runArchiveTask({ op: "extract", fmt, file: out, destDir: stage }, { onLine: () => xm++ });
    expect(e.code, `${fmt} extract: ${e.stderr}`).toBe(0);
    expect(xm, `${fmt} extract progress counts entries, not headers`).toBe(N);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

describe("compress progress end-to-end (real tools, filtered onLine)", () => {
  test.skipIf(!Bun.which("tar") || !Bun.which("gzip"))("tar.gz progress equals the file count", async () => {
    await expectFlatCompressProgress("tar.gz");
  });

  test.skipIf(!Bun.which("7z"))("7z progress equals the file count", async () => {
    await expectFlatCompressProgress("7z");
  });

  test.skipIf(!Bun.which("zip") && !Bun.which("7z"))("zip progress equals the file count", async () => {
    await expectFlatCompressProgress("zip");
  });
});

describe("7z / zip integration", () => {
  test.skipIf(!Bun.which("7z"))("round-trips a .7z", async () => {
    await roundTrip("7z", ["7z"]);
  });

  test.skipIf(!Bun.which("zip") || !Bun.which("unzip"))("round-trips a .zip", async () => {
    await roundTrip("zip", ["zip", "unzip"]);
  });

  test.skipIf(!Bun.which("7z"))("round-trips a .zip via the 7z fallback", async () => {
    // force the fallback by pretending zip is absent
    const dir = mkdtempSync(path.join(os.tmpdir(), "tfm-zip7z-"));
    try {
      mkdirSync(path.join(dir, "src"));
      writeFileSync(path.join(dir, "src", "a.txt"), "hi");
      const out = path.join(dir, "out.zip");
      const c = await runArchiveTool(compressPlan("zip", out, ["src"], dir, which("7z")), { cwd: dir });
      expect(c.code, c.stderr).toBe(0);
      const stage = path.join(dir, "stage");
      mkdirSync(stage);
      const e = await runArchiveTool(extractPlan("zip", out, stage, which("7z")));
      expect(e.code, e.stderr).toBe(0);
      expect(readFileSync(path.join(stage, "src", "a.txt"), "utf8")).toBe("hi");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
