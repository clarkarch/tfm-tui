// Benchmarks in-process decoders for the raster-thumbnail fallback gap
// (formats Bun.Image can't decode on Linux) against the incumbent magick spawn.
//
//   bun scripts/bench-niche-decoders.ts                  # all lanes, 5 runs each
//   bun scripts/bench-niche-decoders.ts --runs 20
//   bun scripts/bench-niche-decoders.ts --only candidate,spawn
//   bun scripts/bench-niche-decoders.ts --heic /path/to/sample.heic
//   bun scripts/bench-niche-decoders.ts --pixels          # pixel diff vs spawn
//
// Corpus is generated at runtime via magick (ICO/TIFF/AVIF/JPEG/PNG) except
// HEIC, which no local encoder can write — pass --heic or the HEIC lane skips
// (never fatal, same philosophy as bench-raster's missing-renderer skips).
// magick-wasm is NOT benched: its Memory64 build aborts at init on Bun 1.4.0
// (see probe-magick-wasm.ts) — blocked on oven-sh/bun#35740.
import { mkdtempSync, rmSync } from "node:fs";
import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const TMP = mkdtempSync(path.join(tmpdir(), "tfm-bench-niche-"));

type Args = { runs: number; pixels: boolean; only?: string; heic?: string };
const parseArgs = (argv: string[]): Args => {
  let runs = 5;
  let pixels = false;
  let only: string | undefined;
  let heic: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--runs") runs = Number(argv[++i]);
    else if (argv[i] === "--pixels") pixels = true;
    else if (argv[i] === "--only") only = argv[++i];
    else if (argv[i] === "--heic") heic = argv[++i];
  }
  return { runs, pixels, only, heic };
};

// --- corpus (runtime-generated via magick, except HEIC) ---
const gen = (args: string[], out: string): boolean => {
  const p = Bun.spawnSync(["magick", ...args, out]);
  return p.exitCode === 0;
};

const buildCorpus = (
  heicPath?: string,
): { name: string; file: string; kind: "ico" | "tiff" | "heic" | "avif" | "control" }[] => {
  const out: { name: string; file: string; kind: "ico" | "tiff" | "heic" | "avif" | "control" }[] = [];
  const put = (name: string, kind: (typeof out)[number]["kind"], ok: boolean, file: string) => {
    console.log(`  corpus ${name}: ${ok ? "ok" : "FAILED"}`);
    if (ok) out.push({ name, file, kind });
  };
  put(
    "multi.ico",
    "ico",
    gen(
      ["(", "-size", "16x16", "gradient:blue-yellow", ")", "(", "-size", "256x256", "gradient:red-blue", ")"],
      path.join(TMP, "multi.ico"),
    ),
    path.join(TMP, "multi.ico"),
  );
  put(
    "img-none.tiff",
    "tiff",
    gen(["-size", "256x192", "gradient:red-blue", "-depth", "8", "-compress", "none"], path.join(TMP, "img-none.tiff")),
    path.join(TMP, "img-none.tiff"),
  );
  put(
    "img-lzw.tiff",
    "tiff",
    gen(["-size", "256x192", "gradient:red-blue", "-depth", "8", "-compress", "lzw"], path.join(TMP, "img-lzw.tiff")),
    path.join(TMP, "img-lzw.tiff"),
  );
  put(
    "img.avif",
    "avif",
    gen(["-size", "256x256", "gradient:red-blue", "-depth", "8"], path.join(TMP, "img.avif")),
    path.join(TMP, "img.avif"),
  );
  put(
    "photo.jpg",
    "control",
    gen(["-size", "256x256", "gradient:red-blue", "-depth", "8"], path.join(TMP, "photo.jpg")),
    path.join(TMP, "photo.jpg"),
  );
  if (heicPath) {
    try {
      const dst = path.join(TMP, "sample.heic");
      writeFileSync(dst, readFileSync(heicPath));
      put("sample.heic", "heic", true, dst);
    } catch {
      put("sample.heic", "heic", false, "");
    }
  } else {
    console.log("  corpus sample.heic: SKIPPED (pass --heic <file>)");
  }
  return out;
};

// --- shared helpers (mirror bench-raster.ts) ---
const pngSize = (buf: Buffer): { w: number; h: number } | null =>
  buf.length > 24 && buf.toString("latin1", 12, 16) === "IHDR"
    ? { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) }
    : null;

const percentile = (sorted: number[], p: number): number =>
  sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] ?? 0;
const fmt = (ms: number): string => `${ms.toFixed(2)}ms`;
const stats = (samples: number[]) => {
  const s = [...samples].sort((a, b) => a - b);
  const sum = s.reduce((a, b) => a + b, 0);
  return { total: sum, mean: sum / s.length, median: percentile(s, 50), p95: percentile(s, 95), min: s[0] ?? 0 };
};

const pixelDiff = async (a: Buffer, b: Buffer, tag: string): Promise<number | null> => {
  const fa = path.join(TMP, `${tag}-a.png`);
  const fb = path.join(TMP, `${tag}-b.png`);
  writeFileSync(fa, a);
  writeFileSync(fb, b);
  const proc = Bun.spawn(["magick", "compare", "-metric", "AE", fa, fb, "null:"], { stdout: "pipe", stderr: "pipe" });
  const err = await new Response(proc.stderr).text();
  await proc.exited;
  const n = Number.parseFloat(err);
  return Number.isFinite(n) ? n : null;
};

// --- lane 1: Bun.Image (control — documents the gap empirically) ---
const laneBunImage = async (file: string, pxW: number, pxH: number): Promise<{ ms: number; out: Buffer } | null> => {
  try {
    const t0 = performance.now();
    const out = await new Bun.Image(file, { autoOrient: true })
      .resize(pxW * 2, pxH * 2, { fit: "inside" })
      .png()
      .bytes();
    return { ms: performance.now() - t0, out: Buffer.from(out) };
  } catch {
    return null;
  }
};

// --- lane 2: magick spawn (incumbent — exact argv from icons.ts renderRasterPng) ---
const laneSpawn = async (file: string, pxW: number, pxH: number): Promise<{ ms: number; out: Buffer } | null> => {
  const t0 = performance.now();
  const proc = Bun.spawn(
    [
      "magick",
      "-define",
      `jpeg:size=${pxW * 2}x${pxH * 2}`,
      file,
      "-auto-orient",
      "-background",
      "#1e1e2e",
      "-thumbnail",
      `${pxW}x${pxH}^`,
      "-gravity",
      "center",
      "-extent",
      `${pxW}x${pxH}`,
      "png:-",
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  const [out, , code] = await Promise.all([
    new Response(proc.stdout).arrayBuffer(),
    new Response(proc.stderr).arrayBuffer(),
    proc.exited,
  ]);
  if (code !== 0 || out.byteLength === 0) return null;
  return { ms: performance.now() - t0, out: Buffer.from(out) };
};

// --- lane 3: in-process candidate per kind ---
// Lazy singleton inits: wasm compile + module load paid once, reported as
// cold-init separately from steady-state below.
let heicDecode:
  | ((opts: { buffer: Buffer }) => Promise<{ width: number; height: number; data: Uint8ClampedArray }>)
  | null = null;
let avifDecode: ((buf: ArrayBuffer) => Promise<{ width: number; height: number; data: Uint8ClampedArray }>) | null =
  null;
const coldInit: Record<string, number> = {};

const rgbaToPng = (data: Uint8Array | Uint8ClampedArray, w: number, h: number): Buffer => {
  // pngjs is the bridge: Bun.Image cannot construct from raw RGBA
  // (uncaught ERR_IMAGE_UNKNOWN_FORMAT — probed, never do it).
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { PNG } = require("pngjs") as typeof import("pngjs");
  const png = new PNG({ width: w, height: h });
  png.data = Buffer.from(data);
  return PNG.sync.write(png);
};

const laneCandidate = async (
  file: string,
  kind: "ico" | "tiff" | "heic" | "avif" | "control",
  pxW: number,
  pxH: number,
): Promise<{ ms: number; out: Buffer } | null> => {
  const t0 = performance.now();
  try {
    if (kind === "ico") {
      const { extractImagesAsPng } = await import("@humanwhocodes/ico-to-png");
      const imgs = extractImagesAsPng(new Uint8Array(readFileSync(file)));
      const pngBytes = imgs.map((i) => i.data).sort((a, b) => b.length - a.length)[0];
      if (!pngBytes) return null;
      const out = await new Bun.Image(pngBytes, { autoOrient: true })
        .resize(pxW * 2, pxH * 2, { fit: "inside" })
        .png()
        .bytes();
      return { ms: performance.now() - t0, out: Buffer.from(out) };
    }
    if (kind === "tiff") {
      const UTIF = await import("utif2");
      const buf = readFileSync(file);
      const ifds = UTIF.decode(buf);
      const ifd = ifds[0];
      if (!ifd) return null;
      UTIF.decodeImage(buf, ifd);
      const rgba = UTIF.toRGBA8(ifd);
      const pngBytes = rgbaToPng(rgba, ifd.width, ifd.height);
      const out = await new Bun.Image(pngBytes, { autoOrient: true })
        .resize(pxW * 2, pxH * 2, { fit: "inside" })
        .png()
        .bytes();
      return { ms: performance.now() - t0, out: Buffer.from(out) };
    }
    if (kind === "heic") {
      if (!heicDecode) {
        const t = performance.now();
        heicDecode = (await import("heic-decode")).default;
        coldInit["heic-import"] = performance.now() - t;
      }
      const dec = heicDecode;
      if (!dec) return null;
      const { width, height, data } = await dec({ buffer: readFileSync(file) });
      const pngBytes = rgbaToPng(data, width, height);
      const out = await new Bun.Image(pngBytes, { autoOrient: true })
        .resize(pxW * 2, pxH * 2, { fit: "inside" })
        .png()
        .bytes();
      return { ms: performance.now() - t0, out: Buffer.from(out) };
    }
    if (kind === "avif") {
      // Bench-only lane (devDep): documents WHY there is no AVIF wasm lane
      // in icons.ts — jsquash loses to spawn AND needs manual wasm init
      // under bun --compile. Re-run after Bun/jsquash upgrades to re-check.
      if (!avifDecode) {
        const t = performance.now();
        avifDecode = (await import("@jsquash/avif")).decode;
        coldInit["avif-import"] = performance.now() - t;
      }
      const dec = avifDecode;
      if (!dec) return null;
      const raw = readFileSync(file);
      const img = await dec(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength));
      const pngBytes = rgbaToPng(img.data, img.width, img.height);
      const out = await new Bun.Image(pngBytes, { autoOrient: true })
        .resize(pxW * 2, pxH * 2, { fit: "inside" })
        .png()
        .bytes();
      return { ms: performance.now() - t0, out: Buffer.from(out) };
    }
    return null; // controls have no candidate lane (Bun.Image IS the path)
  } catch {
    return null;
  }
};

const main = async () => {
  const args = parseArgs(process.argv.slice(2));
  const wanted = args.only
    ?.split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const keep = (name: string): boolean => !wanted || wanted.includes(name);
  const corpus = buildCorpus(args.heic);
  if (corpus.length === 0) {
    console.log("no corpus — magick missing?");
    return;
  }
  const PX = 64; // tile thumb box (icons.ts drain default scale)

  console.log(`\nruns/file/lane: ${args.runs}${args.only ? `, only: ${args.only}` : ""}\n`);

  for (const item of corpus) {
    console.log(`== ${item.name} (${item.kind}) ==`);
    const results: Record<string, { samples: number[]; outs: Buffer[]; failed: number }> = {};
    const lanes: Record<string, (f: string) => Promise<{ ms: number; out: Buffer } | null>> = {
      bunimage: (f) => laneBunImage(f, PX, PX),
      spawn: (f) => laneSpawn(f, PX, PX),
    };
    if (item.kind !== "control") lanes.candidate = (f) => laneCandidate(f, item.kind, PX, PX);
    for (const [lname, run] of Object.entries(lanes).filter(([n]) => keep(n))) {
      const samples: number[] = [];
      const outs: Buffer[] = [];
      let failed = 0;
      for (let i = 0; i < args.runs; i++) {
        const r = await run(item.file);
        if (r === null) {
          failed++;
          continue;
        }
        if (i > 0) samples.push(r.ms); // run 0 warms module/wasm/JIT caches
        if (i === 0 || (i === 1 && outs.length === 0)) {
          const dims = pngSize(r.out);
          if (!dims) failed++;
          else outs.push(r.out);
        }
      }
      results[lname] = { samples, outs, failed };
    }
    for (const [lname, r] of Object.entries(results)) {
      if (r.samples.length === 0) {
        console.log(
          `${lname.padEnd(10)} no result (${r.failed} failed — ${lname === "bunimage" ? "gap confirmed" : "lane broken"})`,
        );
        continue;
      }
      const s = stats(r.samples);
      const dims = r.outs[0] ? pngSize(r.outs[0]) : null;
      console.log(
        `${lname.padEnd(10)} median ${fmt(s.median).padEnd(9)} p95 ${fmt(s.p95).padEnd(9)} min ${fmt(s.min).padEnd(9)} dims ${dims ? `${dims.w}x${dims.h}` : "?"} failed ${r.failed}`,
      );
    }
    // pixel diff candidate vs spawn (spawn is the visual reference)
    if (args.pixels && results.spawn?.outs[0] && results.candidate?.outs[0]) {
      const d = await pixelDiff(
        results.spawn.outs[0] as Buffer,
        results.candidate.outs[0] as Buffer,
        item.name.replace(/\W/g, "_"),
      );
      console.log(`  candidate vs spawn: ${d === null ? "diff n/a" : `${d} px differ`}`);
    }
    console.log("");
  }

  if (Object.keys(coldInit).length > 0) {
    console.log("cold init (paid once per process, lazy per format):");
    for (const [k, v] of Object.entries(coldInit)) console.log(`  ${k}: ${fmt(v)}`);
  }
  rmSync(TMP, { recursive: true, force: true });
};

await main();
