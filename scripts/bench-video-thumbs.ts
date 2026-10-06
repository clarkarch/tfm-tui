// Benchmarks video-thumbnail lanes for the ffmpeg frame job
// (src/ui/icons.ts renderVideoPng) against npm alternatives, ranking speed
// AND OS-dependence (the point: fewer deps on whatever the user's OS has).
//
//   bun scripts/bench-video-thumbs.ts                  # all lanes, 5 runs each
//   bun scripts/bench-video-thumbs.ts --runs 10
//   bun scripts/bench-video-thumbs.ts --only spawn,fluent
//   bun scripts/bench-video-thumbs.ts --sample /path/to/clip.mp4
//   bun scripts/bench-video-thumbs.ts --pixels          # pixel diff vs spawn
//
// Corpus is generated at runtime via the bundled dev ffmpeg (testsrc2 exercises a
// real demux+decode per container/codec). A real sample via --sample covers
// what synthetics can't (B-frames, odd SAR, attached pics). The generator is
// whatever ffmpeg is handy — it only builds the corpus, never the thumbs
// under test (except lane `spawn`, the legacy system binary kept as the
// before/after reference).
//
// Lanes benched: system-ffmpeg spawn (incumbent, exact renderVideoPng argv),
// fluent-ffmpeg (stands in for ffmpeg-forge/peasy-video/mediax-sdk — same
// spawn engine under the hood, so benching all four buys nothing),
// @ffmpeg-installer/ffmpeg bundled-binary spawn (same engine, zero system
// dep), ffmpeg-static install-time-downloaded static spawn (same engine,
// zero system dep — the maintained one: measured 7.0.2 on disk vs the
// installer's 2018 build), beamcoder native libav bindings (the only true non-spawn contender),
// @ffmpeg/ffmpeg wasm (no OS dep at all), Bun.Image (negative control).
// Excluded with reason: totem-video-thumbnailer/ffmpegthumbnailer (just
// another OS spawn, against the goal), videoframer/framewise (LLM-pipeline
// shaped, same ffmpeg engine anyway).
import { PassThrough } from "node:stream";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const TMP = mkdtempSync(path.join(tmpdir(), "tfm-bench-video-"));
const PX = 64; // tile thumb box (matches the icons.ts drain default scale)
const VF = `scale=${PX}:${PX}:force_original_aspect_ratio=increase,crop=${PX}:${PX}`;

type Args = { runs: number; pixels: boolean; only?: string; sample?: string };
const parseArgs = (argv: string[]): Args => {
  let runs = 5;
  let pixels = false;
  let only: string | undefined;
  let sample: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--runs") runs = Number(argv[++i]);
    else if (argv[i] === "--pixels") pixels = true;
    else if (argv[i] === "--only") only = argv[++i];
    else if (argv[i] === "--sample") sample = argv[++i];
  }
  return { runs, pixels, only, sample };
};

// --- corpus (runtime-generated, except --sample) ---
// Dev sidecar first, system binary as generator-only fallback (the product
// never touches PATH; the bench just needs any ffmpeg to mint testsrc).
const genBin = (): string | null => {
  try {
    // biome-ignore lint/suspicious/noExplicitAny: untyped CJS export (a path string)
    const mod: any = require("ffmpeg-static");
    if (typeof mod === "string") return mod;
  } catch {}
  return Bun.which("ffmpeg");
};
const GEN = genBin();

const gen = (args: string[], out: string): boolean => {
  if (!GEN) return false;
  const p = Bun.spawnSync([GEN, "-hide_banner", "-loglevel", "error", ...args, out]);
  return p.exitCode === 0;
};

const hasEncoder = (name: string): boolean => {
  if (!GEN) return false;
  const p = Bun.spawnSync([GEN, "-hide_banner", "-encoders"]);
  const txt = p.stdout ? Buffer.from(p.stdout).toString() : "";
  return txt.includes(name);
};

const buildCorpus = (sample?: string): { name: string; file: string }[] => {
  const out: { name: string; file: string }[] = [];
  const put = (name: string, ok: boolean, file: string) => {
    console.log(`  corpus ${name}: ${ok ? "ok" : "FAILED"}`);
    if (ok) out.push({ name, file });
  };
  const src = (size: string, rate: number, dur: number): string[] => [
    "-f",
    "lavfi",
    "-i",
    `testsrc2=size=${size}:rate=${rate}:duration=${dur}`,
  ];
  put(
    "h264.mp4",
    gen([...src("320x240", 15, 2), "-c:v", "libx264", "-pix_fmt", "yuv420p"], path.join(TMP, "h264.mp4")),
    path.join(TMP, "h264.mp4"),
  );
  put(
    "mpeg4.avi",
    gen([...src("320x240", 15, 2), "-c:v", "mpeg4"], path.join(TMP, "mpeg4.avi")),
    path.join(TMP, "mpeg4.avi"),
  );
  put(
    "vp9.webm",
    gen([...src("320x240", 15, 2), "-c:v", "libvpx-vp9", "-b:v", "1M"], path.join(TMP, "vp9.webm")),
    path.join(TMP, "vp9.webm"),
  );
  put(
    "h264.mov",
    gen([...src("320x240", 15, 2), "-c:v", "libx264", "-pix_fmt", "yuv420p"], path.join(TMP, "h264.mov")),
    path.join(TMP, "h264.mov"),
  );
  if (hasEncoder("libx265")) {
    put(
      "hevc.mp4",
      gen([...src("320x240", 15, 2), "-c:v", "libx265"], path.join(TMP, "hevc.mp4")),
      path.join(TMP, "hevc.mp4"),
    );
  } else {
    console.log("  corpus hevc.mp4: SKIPPED (no libx265 encoder)");
  }
  put(
    "big-h264.mp4",
    gen(
      [...src("1280x720", 30, 5), "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p"],
      path.join(TMP, "big-h264.mp4"),
    ),
    path.join(TMP, "big-h264.mp4"),
  );
  if (sample) {
    try {
      const dst = path.join(TMP, `sample${path.extname(sample) || ".mp4"}`);
      writeFileSync(dst, readFileSync(sample));
      put(`sample (${path.basename(sample)})`, true, dst);
    } catch {
      put(`sample (${sample})`, false, "");
    }
  } else {
    console.log("  corpus sample: SKIPPED (pass --sample <file>)");
  }
  return out;
};

// --- shared helpers (mirror bench-raster.ts / bench-niche-decoders.ts) ---
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
  const proc = Bun.spawn(["magick", "compare", "-metric", "AE", fa, fb, "null:"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const err = await new Response(proc.stderr).text();
  await proc.exited;
  const n = Number.parseFloat(err);
  return Number.isFinite(n) ? n : null;
};

// require() of an uninstalled lane returns null — lanes probe this way so a
// missing/broken candidate skips instead of failing the whole bench.
let reqErr = "";
// biome-ignore lint/suspicious/noExplicitAny: bench-only dynamic lane loading
const req = (name: string): any => {
  try {
    return require(name);
  } catch (e) {
    reqErr = e instanceof Error ? e.message.slice(0, 160) : String(e).slice(0, 160);
    return null;
  }
};

type LaneResult = { ms: number; out: Buffer } | null;
type Lane = {
  run: (file: string) => Promise<LaneResult>;
  probe: () => Promise<string | null>; // null = usable, else BROKEN reason
};

const spawnThumb = async (bin: string, file: string): Promise<LaneResult> => {
  const t0 = performance.now();
  const proc = Bun.spawn(
    [
      bin,
      "-hide_banner",
      "-loglevel",
      "error",
      "-ss",
      "1",
      "-i",
      file,
      "-frames:v",
      "1",
      "-vf",
      VF,
      "-f",
      "image2pipe",
      "-vcodec",
      "png",
      "-",
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

// --- lane 1: system ffmpeg spawn (incumbent — exact argv from icons.ts) ---
const laneSpawn: Lane = {
  probe: async () => (Bun.which("ffmpeg") ? null : "no ffmpeg on PATH"),
  run: (f) => spawnThumb("ffmpeg", f),
};

// --- lane 2: fluent-ffmpeg wrapper (same spawn engine + JS overhead) ---
// biome-ignore lint/suspicious/noExplicitAny: bench-only dynamic lane loading
let fluentMod: any = null;
const laneFluent: Lane = {
  probe: async () => {
    fluentMod ??= req("fluent-ffmpeg");
    return fluentMod ? null : "fluent-ffmpeg not installed";
  },
  run: async (f) => {
    if (!fluentMod) return null;
    const t0 = performance.now();
    return new Promise((resolve) => {
      const chunks: Buffer[] = [];
      const out = new PassThrough();
      out.on("data", (c: Buffer) => chunks.push(c));
      out.on("end", () => {
        const buf = Buffer.concat(chunks);
        resolve(buf.length > 0 ? { ms: performance.now() - t0, out: buf } : null);
      });
      out.on("error", () => resolve(null));
      try {
        fluentMod(f)
          .inputOptions(["-ss", "1"])
          .outputOptions(["-frames:v", "1", "-vf", VF, "-vcodec", "png", "-f", "image2pipe"])
          .on("error", () => resolve(null))
          .pipe(out, { end: true });
      } catch {
        resolve(null);
      }
    });
  },
};

// --- lane 3: bundled-binary spawn (same engine, zero system dep) ---
let bundledBin: string | null = null;
const laneBundled: Lane = {
  probe: async () => {
    if (bundledBin === null) {
      // biome-ignore lint/suspicious/noExplicitAny: bench-only dynamic lane loading
      const mod: any = req("@ffmpeg-installer/ffmpeg");
      bundledBin = typeof mod?.path === "string" ? mod.path : "";
    }
    if (!bundledBin) return "@ffmpeg-installer/ffmpeg not installed";
    const p = Bun.spawnSync([bundledBin, "-hide_banner", "-version"]);
    return p.exitCode === 0 ? null : `bundled binary won't run: ${bundledBin}`;
  },
  run: (f) => (bundledBin ? spawnThumb(bundledBin, f) : Promise.resolve(null)),
};

// --- lane 3b: ffmpeg-static spawn (install-time-downloaded static binary) ---
// The module exports the path string directly. Freshness gates on the
// maintainer re-pinning the GitHub release per ffmpeg-static release
// (measured 7.0.2 on disk 2026-10; README still claims 6.1.1).
let staticBin: string | null = null;
const laneStatic: Lane = {
  probe: async () => {
    if (staticBin === null) {
      // biome-ignore lint/suspicious/noExplicitAny: bench-only dynamic lane loading
      const mod: any = req("ffmpeg-static");
      staticBin = typeof mod === "string" ? mod : "";
    }
    if (!staticBin) return "ffmpeg-static not installed (or postinstall download blocked)";
    const p = Bun.spawnSync([staticBin, "-hide_banner", "-version"]);
    return p.exitCode === 0 ? null : `static binary won't run: ${staticBin}`;
  },
  run: (f) => (staticBin ? spawnThumb(staticBin, f) : Promise.resolve(null)),
};

// --- lane 4: beamcoder native libav bindings (in-process, no spawn) ---
let beamTried = false;
let beamErr: string | null = null;
const laneBeamcoder: Lane = {
  probe: async () => {
    if (!beamTried) {
      beamTried = true;
      try {
        const mod = req("beamcoder");
        if (!mod) beamErr = "not installed / native binding missing (postinstall blocked under bun)";
        else {
          await mod.demuxer("dummy-probe-never-runs");
          beamErr = null;
        }
      } catch (e) {
        beamErr = e instanceof Error ? e.message.slice(0, 160) : String(e).slice(0, 160);
      }
      if (beamErr === null) {
        // installed AND loadable — still pinned to ffmpeg 5.x shared libs?
        const p = Bun.spawnSync(["ldconfig", "-p"]);
        const libs = p.stdout ? Buffer.from(p.stdout).toString() : "";
        if (!libs.includes("libavcodec.so.59"))
          beamErr = "pins libavcodec.so.59 (ffmpeg 5.x); this box has .so.58/.so.63";
      }
    }
    return beamErr;
  },
  // No run body: the probe IS the verdict — without a loadable binding bound
  // to the box's libav there is nothing to time. If a future box passes the
  // probe, this needs a demux+decode-first-frame+YUV→PNG body.
  run: async () => null,
};

// --- lane 5: @ffmpeg/ffmpeg wasm (in-process, no OS dep at all) ---
// biome-ignore lint/suspicious/noExplicitAny: bench-only dynamic lane loading
let wasm: { ff: any; fetchFile: (f: string) => Promise<Uint8Array> } | null = null;
let wasmFailed: string | null = null;
let wasmInitMs = 0;
const laneWasm: Lane = {
  probe: async () => {
    if (wasm || wasmFailed) return wasmFailed;
    try {
      const t0 = performance.now();
      // NOTE: bare import("@ffmpeg/ffmpeg") resolves the package's "node"
      // condition to dist/esm/empty.mjs — a stub that throws "does not
      // support nodejs". The real build is the UMD bundle, loaded here by
      // absolute path so the export map can't redirect it to the stub.
      // Probed dead anyway (0.12.15, Bun 1.4.0): the UMD needs a real DOM
      // (document.getElementsByTagName("script") for publicPath, then a
      // browser Worker over that URL) — `self is not defined` bare, DOM
      // shims just move the crash one line down. Browser-only by design.
      let ffPkgDir: string;
      try {
        ffPkgDir = path.dirname(Bun.resolveSync("@ffmpeg/ffmpeg/package.json", process.cwd()));
      } catch {
        throw new Error("@ffmpeg/ffmpeg not installed");
      }
      // biome-ignore lint/suspicious/noExplicitAny: bench-only dynamic lane loading
      const umd: any = req(path.join(ffPkgDir, "dist", "umd", "ffmpeg.js"));
      if (!umd?.FFmpeg) throw new Error(reqErr || "UMD bundle has no FFmpeg export");
      const { FFmpeg } = umd;
      // biome-ignore lint/suspicious/noExplicitAny: bench-only dynamic lane loading
      const utilMod: any = req("@ffmpeg/util");
      if (!utilMod?.fetchFile) throw new Error(reqErr || "@ffmpeg/util not installed");
      const { fetchFile } = utilMod;
      let pkgDir: string;
      try {
        pkgDir = path.dirname(Bun.resolveSync("@ffmpeg/core/package.json", process.cwd()));
      } catch {
        throw new Error("@ffmpeg/core not installed");
      }
      const coreJS = readFileSync(path.join(pkgDir, "dist", "esm", "ffmpeg-core.js"));
      const coreWasm = readFileSync(path.join(pkgDir, "dist", "esm", "ffmpeg-core.wasm"));
      const ff = new FFmpeg();
      await ff.load({
        coreURL: URL.createObjectURL(new Blob([coreJS], { type: "text/javascript" })),
        wasmURL: URL.createObjectURL(new Blob([coreWasm], { type: "application/wasm" })),
      });
      wasm = { ff, fetchFile };
      wasmInitMs = performance.now() - t0;
      return null;
    } catch (e) {
      wasmFailed = (e instanceof Error ? e.message : String(e)).slice(0, 200);
      return wasmFailed;
    }
  },
  run: async (f) => {
    if (!wasm) return null;
    const t0 = performance.now();
    const tag = `in-${process.pid}.mp4`;
    try {
      const { ff, fetchFile } = wasm;
      await ff.writeFile(tag, await fetchFile(f));
      const code = await ff.exec(["-ss", "1", "-i", tag, "-frames:v", "1", "-vf", VF, "-f", "image2", "out.png"]);
      const data = code === 0 ? await ff.readFile("out.png") : new Uint8Array(0);
      await ff.deleteFile(tag).catch(() => {});
      await ff.deleteFile("out.png").catch(() => {});
      const buf = Buffer.from(data as Uint8Array);
      return buf.length > 0 ? { ms: performance.now() - t0, out: buf } : null;
    } catch {
      try {
        await wasm.ff.deleteFile(tag).catch(() => {});
        await wasm.ff.deleteFile("out.png").catch(() => {});
      } catch {}
      return null;
    }
  },
};

// --- lane 6: Bun.Image on the mp4 (negative control — documents the gap) ---
const laneBunImage: Lane = {
  probe: async () => null,
  run: async (f) => {
    try {
      const t0 = performance.now();
      const out = await new Bun.Image(f, { autoOrient: true })
        .resize(PX * 2, PX * 2, { fit: "inside" })
        .png()
        .bytes();
      return { ms: performance.now() - t0, out: Buffer.from(out) };
    } catch {
      return null;
    }
  },
};

const OS_DEPS: Record<string, string> = {
  spawn: "needs system ffmpeg binary on PATH (gated by canThumbVideo())",
  fluent: "needs system ffmpeg binary on PATH + fluent-ffmpeg wrapper (same engine, zero independence gain)",
  bundled: "~70MB static ffmpeg binary shipped in node_modules; zero system dep, still a spawn",
  staticbin: "~80MB static ffmpeg binary downloaded at install; zero system dep, still a spawn",
  beamcoder: "needs ffmpeg 5.x SHARED libs on the box + node-gyp build at install (heaviest OS coupling of all)",
  wasm: "zero OS dep: ~31MB core ships in the package; in-process",
  bunimage: "zero dep — and zero video decode (control)",
};

// Isolates process-startup cost from decode cost: a heavily-linked system
// ffmpeg can spend more time starting than decoding a small clip, while a
// static binary starts in ~2ms. Same engine, different startup.
const startupMs = async (bin: string): Promise<number | null> => {
  try {
    const t0 = performance.now();
    const p = Bun.spawn([bin, "-hide_banner", "-version"], { stdout: "pipe", stderr: "pipe" });
    await new Response(p.stdout).arrayBuffer();
    await p.exited;
    return performance.now() - t0;
  } catch {
    return null;
  }
};
const startupStr = (ms: number | null): string => (ms === null ? "n/a" : `~${fmt(ms)}`);

const main = async () => {
  const args = parseArgs(process.argv.slice(2));
  const wanted = args.only
    ?.split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const keep = (name: string): boolean => !wanted || wanted.includes(name);
  const corpus = buildCorpus(args.sample);
  if (corpus.length === 0) {
    console.log("no corpus — no ffmpeg at all (dev sidecar or system)?");
    return;
  }

  const lanes: Record<string, Lane> = {
    spawn: laneSpawn,
    fluent: laneFluent,
    bundled: laneBundled,
    staticbin: laneStatic,
    beamcoder: laneBeamcoder,
    wasm: laneWasm,
    bunimage: laneBunImage,
  };

  // Probe every lane first so a broken candidate fails fast, before the matrix.
  console.log("\nlane availability:");
  const broken: Record<string, string> = {};
  for (const [name, lane] of Object.entries(lanes).filter(([n]) => keep(n))) {
    const reason = await lane.probe();
    if (reason) {
      broken[name] = reason;
      console.log(`  ${name}: BROKEN — ${reason}`);
    } else {
      console.log(`  ${name}: ok`);
    }
  }
  console.log(`\nruns/file/lane: ${args.runs}${args.only ? `, only: ${args.only}` : ""}\n`);

  console.log("spawn startup (`-version`, no decode):");
  if (keep("spawn")) console.log(`  spawn:   ${startupStr(await startupMs("ffmpeg"))}`);
  if (keep("fluent")) console.log(`  fluent:  ${startupStr(await startupMs("ffmpeg"))} (same PATH binary as spawn)`);
  if (keep("bundled") && bundledBin) console.log(`  bundled: ${startupStr(await startupMs(bundledBin))}`);
  if (keep("staticbin") && staticBin) console.log(`  static:  ${startupStr(await startupMs(staticBin))}`);
  console.log("");

  const totals: Record<string, number[]> = {};
  const refOuts: Record<string, Buffer> = {};
  for (const item of corpus) {
    console.log(`== ${item.name} ==`);
    const results: Record<string, { samples: number[]; outs: Buffer[]; failed: number }> = {};
    for (const [lname, lane] of Object.entries(lanes).filter(([n]) => keep(n))) {
      if (broken[lname] || lname === "beamcoder") continue; // beamcoder has no run body (see lane comment)
      const samples: number[] = [];
      const outs: Buffer[] = [];
      let failed = 0;
      for (let i = 0; i < args.runs; i++) {
        const r = await lane.run(item.file);
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
      if (lname === "spawn" && outs[0]) refOuts[item.name] = outs[0];
    }
    for (const [lname, r] of Object.entries(results)) {
      if (r.samples.length === 0) {
        console.log(
          `${lname.padEnd(10)} no result (${r.failed} failed — ${lname === "bunimage" ? "gap confirmed" : "lane broken"})`,
        );
        continue;
      }
      const s = stats(r.samples);
      totals[lname] ??= [];
      totals[lname]?.push(s.median);
      const dims = r.outs[0] ? pngSize(r.outs[0] as Buffer) : null;
      console.log(
        `${lname.padEnd(10)} median ${fmt(s.median).padEnd(9)} p95 ${fmt(s.p95).padEnd(9)} min ${fmt(s.min).padEnd(9)} dims ${dims ? `${dims.w}x${dims.h}` : "?"} failed ${r.failed}`,
      );
    }
    if (args.pixels && refOuts[item.name]) {
      for (const [lname, r] of Object.entries(results)) {
        if (lname === "spawn" || !r.outs[0]) continue;
        const d = await pixelDiff(refOuts[item.name] as Buffer, r.outs[0] as Buffer, item.name.replace(/\W/g, "_"));
        console.log(`  ${lname} vs spawn: ${d === null ? "diff n/a" : `${d} px differ`}`);
      }
    }
    console.log("");
  }

  // Speed rank: sum of per-file medians (each file weighted equally).
  console.log("== speed rank (sum of per-file medians) ==");
  const ranked = Object.entries(totals)
    .map(([name, medians]) => ({ name, total: medians.reduce((a, b) => a + b, 0) }))
    .sort((a, b) => a.total - b.total);
  const best = ranked[0]?.total ?? 0;
  for (const [i, r] of ranked.entries()) {
    console.log(
      `  ${i + 1}. ${r.name.padEnd(10)} ${fmt(r.total).padEnd(10)} ${best > 0 ? `${(r.total / best).toFixed(2)}x` : ""}`,
    );
  }
  for (const [name, reason] of Object.entries(broken)) console.log(`  -. ${name.padEnd(10)} BROKEN — ${reason}`);
  if (!broken.beamcoder)
    console.log("  -. beamcoder  no run body: probe passed but no decode body written (see lane comment)");

  console.log("\n== OS-dependence scorecard (the actual decision axis) ==");
  const ordered = [...ranked.map((r) => r.name), ...Object.keys(broken)];
  if (!broken.beamcoder) ordered.push("beamcoder");
  for (const name of ordered) {
    if (wanted && !wanted.includes(name)) continue;
    console.log(`  ${name.padEnd(10)} ${OS_DEPS[name] ?? ""}`);
  }
  if (wasmInitMs > 0) console.log(`\nwasm cold init (paid once per process, lazy): ${fmt(wasmInitMs)}`);

  rmSync(TMP, { recursive: true, force: true });
};

await main();
