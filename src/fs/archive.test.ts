import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  detectArchiveFormat,
  extractPlan,
  listArchiveEntries,
  makeLineCounter,
  parseToolLine,
  runArchiveTool,
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
      args: ["x", "-y", "-o/stage", "/x/a.zip"],
    });
  });

  test("7z extracts via 7z", () => {
    expect(extractPlan("7z", "/x/a.7z", "/stage", which("7z"))).toEqual({
      tool: "7z",
      args: ["x", "-y", "-o/stage", "/x/a.7z"],
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
      args: ["a", "-tzip", "-y", "/o/a.zip", "--", "./-v"],
    });
  });

  test("zip uses zip when present, 7z otherwise; 7z is 7z", () => {
    expect(compressPlan("zip", "/out/a.zip", ["foo"], "/src", which("zip"))).toEqual({
      tool: "zip",
      args: ["-r", "/out/a.zip", "foo"],
    });
    expect(compressPlan("zip", "/out/a.zip", ["foo"], "/src", which("7z"))).toEqual({
      tool: "7z",
      args: ["a", "-tzip", "-y", "/out/a.zip", "--", "foo"],
    });
    expect(compressPlan("7z", "/out/a.7z", ["foo"], "/src", which("7z"))).toEqual({
      tool: "7z",
      args: ["a", "-t7z", "-y", "/out/a.7z", "--", "foo"],
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
    expect(availableCompressionFormats(which("tar"))).toEqual(["tar"]);
    expect(availableCompressionFormats(which("tar", "gzip"))).toEqual(["tar.gz", "tar"]);
    // no zip binary, no 7z -> no zip row; with 7z it is available
    expect(availableCompressionFormats(which("tar", "zip"))).toContain("zip");
    expect(availableCompressionFormats(which("tar", "7z"))).toContain("zip");
    expect(availableCompressionFormats(which("tar"))).not.toContain("zip");
    expect(availableCompressionFormats(() => null)).toEqual([]);
  });

  test("canExtract needs the matching toolchain", () => {
    expect(canExtract("a.zip", which("unzip"))).toBe(true);
    expect(canExtract("a.zip", which("7z"))).toBe(true);
    expect(canExtract("a.zip", which("tar"))).toBe(false);
    expect(canExtract("a.tar.gz", which("tar", "gzip"))).toBe(true);
    expect(canExtract("a.tar.gz", which("tar"))).toBe(false);
    expect(canExtract("a.tar.lz4", which("tar", "lz4"))).toBe(true);
    expect(canExtract("a.7z", which("7z"))).toBe(true);
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

// real-tool round-trips: pin the exact argv against the actual binaries
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
