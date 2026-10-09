// Benchmarks tfm's TypeScript hot paths against Zig equivalents called over
// bun:ffi (same methodology as bench-raster.ts: wall time is the metric,
// run 0 warms, stats over the rest, missing toolchain never fails the run).
//
//   bun scripts/bench-ts-vs-zig.ts                  # all benches, 5 runs each
//   bun scripts/bench-ts-vs-zig.ts --runs 10
//   bun scripts/bench-ts-vs-zig.ts --only filter,hash
//
// Each bench maps to a real tfm path:
//   overhead  call floor (FFI boundary cost everything else pays per call)
//   filter    name.toLowerCase().includes(q) per file per keystroke (searchTree, grid filter)
//   ext       path.extname().slice(1).toLowerCase() per tile (compareEntries, filetype, icon routing)
//   hash      createHash("sha1") per lookup (icon/thumb disk keys) vs Bun.hash vs Zig FNV-1a
//   sort      full-array sort via Intl.Collator (compareEntries) vs codepoint vs FFI comparator
//   readdir   readdirSync vs Zig getdents64 count-only loop (scanDir shape — FFI drops
//             names, so this isolates syscall batching, not a replaceable scanDir)
//   stat      readdir+lstatSync loop vs Zig getdents64+statx bulk loop (fillStatsInto)
//
// Honesty notes (semantics differ, so "faster" is not always "replaceable"):
//   - Zig lowerIncludes/extLen are ASCII-only; TS lowercases Unicode.
//   - FNV-1a/cityHash are NOT sha1 (non-crypto key throughput only).
//   - Byte-order sort is NOT locale collation (correctness differs by design).
//
// Verdict (2026-10, all MATCH, medians over 5-10 runs): do NOT add FFI.
// The only stable FFI wins are bulk syscalls (stat ~2x, readdir-count ~2-6x,
// ~ms-scale per listing) while the bigger wins are dependency-free (dot-scan
// over extOf ~2x landed in src/fs/filetype.ts; Bun.hash over sha1 unshipped —
// ~3µs/key ≈ 1ms/full drain is not worth a cache-key migration that orphans
// every disk entry). Gate for revisiting: a profile showing fillStatsInto
// dominating real big-dir loads, then ONE packed-buffer scanBulk lane with
// fallback, never per-call FFI (the sort lane proves per-call loses).
import { createHash } from "node:crypto";
import { lstatSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { dlopen, FFIType } from "bun:ffi";

const TMP = mkdtempSync(path.join(tmpdir(), "tfm-bench-tszig-"));

type Args = { runs: number; only?: string };
const BENCH_NAMES = ["overhead", "filter", "ext", "hash", "sort", "readdir", "stat"] as const;
const parseArgs = (argv: string[]): Args => {
  let runs = 5;
  let only: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--runs") {
      const n = Number(argv[++i]);
      runs = Number.isFinite(n) ? Math.max(1, Math.floor(n)) : 5;
    } else if (argv[i] === "--only") only = argv[++i];
  }
  return { runs, only };
};

const percentile = (sorted: number[], p: number): number =>
  sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] ?? 0;
const fmtNs = (ns: number): string =>
  ns >= 1_000_000
    ? `${(ns / 1_000_000).toFixed(2)}ms`
    : ns >= 1_000
      ? `${(ns / 1_000).toFixed(1)}µs`
      : `${ns.toFixed(1)}ns`;
const stats = (samples: number[]) => {
  const s = [...samples].sort((a, b) => a - b);
  const sum = s.reduce((a, b) => a + b, 0);
  return { total: sum, mean: sum / s.length, median: percentile(s, 50), p95: percentile(s, 95), min: s[0] ?? 0 };
};

// --- corpus: tfm-shaped names (mixed case, mixed exts, some dotfiles) ---
const EXTS = ["txt", "md", "ts", "tsx", "png", "jpg", "mp4", "pdf", "rs", "zig", "toml", "json", ""];
const NAMES: string[] = [];
{
  let seed = 0x12345678;
  const rnd = (): number => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 0x100000000;
  };
  const WORDS = ["Document", "final", "REPORT", "photo", "IMG", "notes", "draft", "Archive", "src", "config"];
  for (let i = 0; i < 5000; i++) {
    const w = WORDS[Math.floor(rnd() * WORDS.length)] ?? "file";
    const e = EXTS[Math.floor(rnd() * EXTS.length)] ?? "";
    const v = rnd() < 0.3 ? `_v${Math.floor(rnd() * 20)}` : "";
    NAMES.push(`${w}_${i}${v}${e ? `.${rnd() < 0.5 ? e.toUpperCase() : e}` : ""}`);
  }
  NAMES.push(".bashrc", ".gitignore", "Makefile", "noext");
}
const NAME_BUFS = NAMES.map((n) => Buffer.from(n));

// Flat dir for the syscall benches (2000 small files).
const FLAT = path.join(TMP, "flat");
const FLAT_COUNT = 2000;

// The real tfm ext helper (src/fs/filetype.ts extOf shape).
const extOf = (name: string): string => path.extname(name).slice(1).toLowerCase();

const main = async (): Promise<void> => {
  const args = parseArgs(process.argv.slice(2));
  const wanted = args.only
    ?.split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const keep = (name: string): boolean => !wanted || wanted.includes(name);
  const unknown = wanted?.filter((w) => !(BENCH_NAMES as readonly string[]).includes(w));

  try {
    if (unknown && unknown.length > 0) {
      console.log(`unknown bench names: ${unknown.join(", ")} (known: ${BENCH_NAMES.join(", ")})`);
      return;
    }
    await runBenches(args, keep);
  } finally {
    rmSync(TMP, { recursive: true, force: true });
  }
};

const runBenches = async (args: Args, keep: (name: string) => boolean): Promise<void> => {
  for (let i = 0; i < FLAT_COUNT; i++) {
    await Bun.write(path.join(FLAT, `f${i}.txt`), `payload-${i}`);
  }

  // --- Zig shared lib (runtime-built, like the corpus: no committed .so) ---
  type ZigSyms = {
    noop(a: number): number;
    lowerIncludes(hay: Buffer, hayLen: number, needle: Buffer, needleLen: number): number;
    extLen(name: Buffer, nameLen: number): bigint;
    fnv1a64(ptr: Buffer, len: number): bigint;
    strCmp(a: Buffer, aLen: number, b: Buffer, bLen: number): number;
    scanCount(dir: Buffer, dirLen: number): bigint;
    scanStatSum(dir: Buffer, dirLen: number, out: BigUint64Array): bigint;
  };
  let zig: ZigSyms | null = null;
  // (bun:ffi supports usize at runtime but its types omit it — alias with a u64 fallback.)
  const FFI_EXTRA = FFIType as unknown as Record<string, (typeof FFIType)[keyof typeof FFIType]>;
  // biome-ignore lint/complexity/useLiteralKeys: FFIType types omit usize, so a literal key errors
  const USIZE = FFI_EXTRA["usize"] ?? FFIType.u64;
  if (Bun.which("zig")) {
    const src = new URL("./bench-ts-vs-zig.zig", import.meta.url).pathname;
    const out = path.join(TMP, "libbench.so");
    const proc = Bun.spawnSync(["zig", "build-lib", "-dynamic", "-O", "ReleaseFast", src, `-femit-bin=${out}`], {
      stdout: "pipe",
      stderr: "pipe",
    });
    if (proc.exitCode === 0) {
      try {
        const lib = dlopen(out, {
          noop: { args: [FFIType.i32], returns: FFIType.i32 },
          lowerIncludes: { args: [FFIType.ptr, USIZE, FFIType.ptr, USIZE], returns: FFIType.u8 },
          extLen: { args: [FFIType.ptr, USIZE], returns: USIZE },
          fnv1a64: { args: [FFIType.ptr, USIZE], returns: FFIType.u64 },
          strCmp: { args: [FFIType.ptr, USIZE, FFIType.ptr, USIZE], returns: FFIType.i32 },
          scanCount: { args: [FFIType.ptr, USIZE], returns: USIZE },
          scanStatSum: { args: [FFIType.ptr, USIZE, FFIType.ptr], returns: FFIType.u64 },
        });
        zig = lib.symbols as unknown as ZigSyms;
      } catch (e) {
        console.log(`zig lib dlopen failed, FFI lanes skipped: ${String(e).slice(0, 120)}`);
      }
    } else {
      console.log(`zig build failed, FFI lanes skipped:\n${proc.stderr.toString().slice(0, 500)}`);
    }
  } else {
    console.log("zig: MISSING — FFI lanes skipped, TS baselines still run");
  }
  console.log(`zig: ${zig ? "LOADED" : "SKIPPED"} | corpus: ${NAMES.length} names, ${FLAT_COUNT} flat files`);
  console.log(`runs: ${args.runs}${args.only ? `, only: ${args.only}` : ""}\n`);

  // run0 warms JIT/module/caches; samples start at run 1 (bench-raster.ts rule).
  const bench = async (label: string, lanes: Record<string, () => void>): Promise<void> => {
    if (!keep(label)) return;
    console.log(`== ${label} ==`);
    const medians: Record<string, number> = {};
    for (const [name, fn] of Object.entries(lanes)) {
      const samples: number[] = [];
      for (let i = 0; i <= args.runs; i++) {
        const t0 = Bun.nanoseconds();
        fn();
        const dt = Bun.nanoseconds() - t0;
        if (i > 0) samples.push(dt);
      }
      const s = stats(samples);
      medians[name] = s.median;
      console.log(
        `${name.padEnd(18)} total=${fmtNs(s.total).padEnd(10)} mean=${fmtNs(s.mean).padEnd(10)} median=${fmtNs(s.median).padEnd(10)} p95=${fmtNs(s.p95)}`,
      );
    }
    const [n0, ...rest] = Object.keys(lanes);
    if (n0) {
      for (const n of rest) {
        const a = medians[n0] ?? 0;
        const b = medians[n] ?? 1;
        console.log(`→ ${n} is ${(a / b).toFixed(2)}x ${b <= a ? "faster" : "SLOWER"} than ${n0} (median)`);
      }
    }
    console.log("");
  };

  // 1. call floor
  {
    const jsId = (a: number): number => a;
    let sink = 0;
    const lanes: Record<string, () => void> = {
      "ts-call": () => {
        for (let i = 0; i < 200_000; i++) sink += jsId(i);
      },
    };
    if (zig) {
      const z = zig;
      lanes["ffi-noop"] = () => {
        for (let i = 0; i < 200_000; i++) sink += z.noop(i);
      };
    }
    await bench("overhead", lanes);
    if (sink === -1) console.log("unreachable");
  }

  // 2. substring filter (per file per keystroke)
  {
    const needle = Buffer.from("doc");
    const q = "doc";
    let tsHits = 0;
    let ffiHits = 0;
    for (const s of NAMES) if (s.toLowerCase().includes(q)) tsHits++;
    const lanes: Record<string, () => void> = {
      "ts-includes": () => {
        let h = 0;
        for (let r = 0; r < 5; r++) for (const s of NAMES) if (s.toLowerCase().includes(q)) h++;
        if (h < 0) console.log(h);
      },
    };
    if (zig) {
      const z = zig;
      for (const b of NAME_BUFS) ffiHits += z.lowerIncludes(b, b.length, needle, needle.length);
      lanes["ffi-includes"] = () => {
        let h = 0;
        for (let r = 0; r < 5; r++) for (const b of NAME_BUFS) h += z.lowerIncludes(b, b.length, needle, needle.length);
        if (h < 0) console.log(h);
      };
    }
    await bench("filter", lanes);
    if (keep("filter"))
      console.log(
        `  check: ts hits=${tsHits}${zig ? `, ffi hits=${ffiHits} ${tsHits === ffiHits ? "MATCH" : "DIFFER (ASCII vs Unicode lowercase — see header)"}` : ""}\n`,
      );
  }

  // 3. ext extraction (per tile per render)
  {
    let tsLen = 0;
    let dotLen = 0;
    let ffiLen = 0;
    for (const s of NAMES) tsLen += extOf(s).length;
    for (const s of NAMES) {
      const d = s.lastIndexOf(".");
      dotLen += d <= 0 ? 0 : s.length - d - 1;
    }
    const lanes: Record<string, () => void> = {
      "ts-extOf": () => {
        let h = 0;
        for (let r = 0; r < 5; r++) for (const s of NAMES) h += extOf(s).length;
        if (h < 0) console.log(h);
      },
      "ts-dotidx": () => {
        let h = 0;
        for (let r = 0; r < 5; r++)
          for (const s of NAMES) {
            const d = s.lastIndexOf(".");
            h += d <= 0 ? 0 : s.length - d - 1;
          }
        if (h < 0) console.log(h);
      },
    };
    if (zig) {
      const z = zig;
      for (const b of NAME_BUFS) ffiLen += Number(z.extLen(b, b.length));
      lanes["ffi-extlen"] = () => {
        let h = 0n;
        for (let r = 0; r < 5; r++) for (const b of NAME_BUFS) h += z.extLen(b, b.length);
        if (h < 0) console.log(h);
      };
    }
    await bench("ext", lanes);
    if (keep("ext"))
      console.log(
        `  check: ts=${tsLen}, dotidx=${dotLen}, ffi=${ffiLen} ${tsLen === dotLen && (!zig || dotLen === ffiLen) ? "MATCH" : "DIFFER"}\n`,
      );
  }

  // 4. cache-key hash (per icon/thumb lookup)
  {
    const keys = NAMES.slice(0, 500).map((n) => `icon:${n}:fg#ffffff:bg#000000:54x54|src12345`);
    const keyBufs = keys.map((k) => Buffer.from(k));
    const lanes: Record<string, () => void> = {
      "ts-sha1": () => {
        let h = "";
        for (let r = 0; r < 5; r++) for (const k of keys) h = createHash("sha1").update(k).digest("hex");
        if (h.length < 0) console.log(h);
      },
      "bun-hash": () => {
        let h = 0n;
        for (let r = 0; r < 5; r++) for (const k of keys) h += BigInt(Bun.hash(k));
        if (h < 0) console.log(h);
      },
    };
    if (zig) {
      const z = zig;
      lanes["ffi-fnv1a"] = () => {
        let h = 0n;
        for (let r = 0; r < 5; r++) for (const b of keyBufs) h += z.fnv1a64(b, b.length);
        if (h < 0) console.log(h);
      };
    }
    await bench("hash", lanes);
    if (keep("hash"))
      console.log(
        "  note: sha1 is crypto, cityHash/FNV-1a are not; sha1 lane includes hex encoding, the others return ints — throughput only, not interchangeable\n",
      );
  }

  // 5. full-sorts (compareEntries shape: n log n comparator calls)
  {
    const coll = new Intl.Collator();
    const shuffled = (): string[] => {
      const a = [...NAMES];
      let s = 0x9e3779b9;
      for (let i = a.length - 1; i > 0; i--) {
        s = (s * 1664525 + 1013904223) >>> 0;
        const j = s % (i + 1);
        [a[i], a[j]] = [a[j] ?? "", a[i] ?? ""];
      }
      return a;
    };
    const lanes: Record<string, () => void> = {
      "ts-collator": () => {
        shuffled().sort((x, y) => coll.compare(x, y));
      },
      "ts-codepoint": () => {
        shuffled().sort((x, y) => (x < y ? -1 : x > y ? 1 : 0));
      },
    };
    if (zig) {
      const z = zig;
      const bufs = new Map<string, Buffer>();
      for (const n of NAMES) bufs.set(n, Buffer.from(n));
      const empty = Buffer.alloc(0);
      // One Map lookup per element (not per comparison) so the lane isolates
      // FFI call cost instead of TS lookup cost.
      lanes["ffi-strcmp"] = () => {
        const decorated = shuffled().map((s) => ({ s, b: bufs.get(s) ?? empty }));
        decorated.sort((x, y) => z.strCmp(x.b, x.b.length, y.b, y.b.length));
      };
    }
    await bench("sort", lanes);
    if (keep("sort"))
      console.log("  note: byte order != locale collation — FFI lane measures call cost, not a replacement\n");
  }

  // 6. readdir (scanDir)
  {
    const dirBuf = Buffer.from(FLAT);
    const lanes: Record<string, () => void> = {
      "ts-readdir": () => {
        readdirSync(FLAT);
      },
    };
    if (zig) {
      const z = zig;
      lanes["ffi-getdents"] = () => {
        z.scanCount(dirBuf, dirBuf.length);
      };
    }
    await bench("readdir", lanes);
    if (keep("readdir")) {
      const tsN = readdirSync(FLAT).length;
      const ffiN = zig ? Number(zig.scanCount(dirBuf, dirBuf.length)) : -1;
      console.log(
        `  check: ts n=${tsN}${zig ? (ffiN === tsN ? `, ffi n=${ffiN} MATCH` : `, ffi n=${ffiN} DIFFER`) : ""}`,
      );
      console.log(
        "  note: FFI lane counts only (drops names); TS materializes every name — syscall batching, not a replaceable scanDir\n",
      );
    }
  }

  // 7. stat batch (fillStatsInto)
  {
    const dirBuf = Buffer.from(FLAT);
    const lanes: Record<string, () => void> = {
      "ts-lstat": () => {
        let sum = 0;
        for (const f of readdirSync(FLAT)) {
          try {
            sum += Number(lstatSync(path.join(FLAT, f)).size);
          } catch {
            // count-and-skip mirrors the Zig lane
          }
        }
        if (sum < 0) console.log(sum);
      },
    };
    if (zig) {
      const z = zig;
      const out = new BigUint64Array(1);
      lanes["ffi-statx"] = () => {
        z.scanStatSum(dirBuf, dirBuf.length, out);
      };
    }
    await bench("stat", lanes);
    if (keep("stat")) {
      const statOne = (): { sum: number; n: number } => {
        let sum = 0;
        let n = 0;
        for (const f of readdirSync(FLAT)) {
          try {
            sum += Number(lstatSync(path.join(FLAT, f)).size);
            n++;
          } catch {
            // count-and-skip mirrors the Zig lane (statx failure skips the size)
          }
        }
        return { sum, n };
      };
      const ts = statOne();
      if (zig) {
        const z = zig;
        const out = new BigUint64Array(1);
        const ffiSum = z.scanStatSum(dirBuf, dirBuf.length, out);
        const match = BigInt(ts.sum) === ffiSum && BigInt(ts.n) === out[0];
        console.log(
          `  check: ts sum=${ts.sum} n=${ts.n}, ffi sum=${ffiSum} n=${out[0]} ${match ? "MATCH" : "DIFFER"}\n`,
        );
      } else {
        console.log(`  check: ts sum=${ts.sum} n=${ts.n}\n`);
      }
    }
  }
};

await main();
