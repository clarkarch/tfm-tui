// Benchmarks SVG rasterizers used for icon/thumbnail rendering, replicating the
// exact stdin->stdout pipe src/ui/icons.ts uses (`rasterizeSvg`).
//
//   bun scripts/bench-raster.ts                 # both size profiles, 5 runs each
//   bun scripts/bench-raster.ts --runs 20
//   bun scripts/bench-raster.ts --size 32x32
//   bun scripts/bench-raster.ts --pixels        # per-icon pixel diff (needs magick)
//
// Wall time per invocation is the metric that matters: tfm spawns one process
// per icon, so process startup dominates the actual raster. resvg's own --perf
// breakdown is printed separately (rsvg-convert has no equivalent).
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const ICON_DIR = new URL("../assets/icons", import.meta.url).pathname;
const TMP = mkdtempSync(path.join(tmpdir(), "tfm-bench-"));

// tfm's default cell pixel sizes: chrome icons are 2 cells wide x 1 tall
// (ui-slots makeIconSlot), grid icons are `icon-cells` (default 3) rows tall and
// twice that wide - 2px inset each axis (`- 2` in drainIconQueue).
const PROFILES: Record<string, { w: number; h: number }> = {
  chrome: { w: 18, h: 16 },
  tile: { w: 54, h: 54 },
};

type Args = { runs: number; size?: { w: number; h: number }; pixels: boolean };
const parseArgs = (argv: string[]): Args => {
  let runs = 5;
  let size: { w: number; h: number } | undefined;
  let pixels = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--runs") runs = Number(argv[++i]);
    else if (argv[i] === "--size") {
      const [w, h] = (argv[++i] ?? "").split("x").map(Number);
      if (!w || !h) throw new Error("--size expects WxH");
      size = { w, h };
    } else if (argv[i] === "--pixels") pixels = true;
  }
  return { runs, size, pixels };
};

// Same tint as src/ui/icons.ts (replace hex fills, else inject a fill on <svg>).
const tint = (svg: string, fg: string): string =>
  /#[0-9a-fA-F]{6}/.test(svg) ? svg.replace(/#[0-9a-fA-F]{6}/g, fg) : svg.replace(/<svg\b/, `<svg fill="${fg}"`);

const FG = "#cdd6f4";
const BG = "#1e1e2e";

const spawnOnce = async (
  cmd: string,
  args: string[],
  input: Buffer,
): Promise<{ ms: number; out: Buffer; stderr: string; code: number | null }> => {
  const t0 = performance.now();
  const proc = Bun.spawn([cmd, ...args], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  proc.stdin.write(input);
  proc.stdin.end();
  const [out, err] = await Promise.all([new Response(proc.stdout).arrayBuffer(), new Response(proc.stderr).text()]);
  const code = await proc.exited;
  return { ms: performance.now() - t0, out: Buffer.from(out), stderr: err, code };
};

// PNG IHDR: 8-byte signature + 4 length + 4 type, then width/height as BE u32.
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

const magick = Bun.which("magick");

const pixelDiff = async (a: Buffer, b: Buffer, tag: string): Promise<number | null> => {
  if (!magick) return null;
  const fa = path.join(TMP, `${tag}-a.png`);
  const fb = path.join(TMP, `${tag}-b.png`);
  writeFileSync(fa, a);
  writeFileSync(fb, b);
  const proc = Bun.spawn([magick, "compare", "-metric", "AE", fa, fb, "null:"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const err = await new Response(proc.stderr).text();
  await proc.exited;
  const n = Number.parseFloat(err);
  return Number.isFinite(n) ? n : null;
};

const RENDERERS = {
  "rsvg-convert": (w: number, h: number): string[] => ["--background-color", BG, "-w", String(w), "-h", String(h)],
  // `-` = stdin, `-c` = PNG to stdout. --quiet drops the stdin/resources-dir warning.
  resvg: (w: number, h: number): string[] => [
    "--quiet",
    "--background",
    BG,
    "-w",
    String(w),
    "-h",
    String(h),
    "-",
    "-c",
  ],
} as const;

const main = async () => {
  const args = parseArgs(process.argv.slice(2));
  const icons = readdirSync(ICON_DIR)
    .filter((f) => f.endsWith(".svg"))
    .sort();
  const corpus = icons.map((f) => ({
    name: f,
    svg: Buffer.from(tint(readFileSync(path.join(ICON_DIR, f), "utf8"), FG)),
  }));
  const profiles = args.size ? { custom: args.size } : PROFILES;

  console.log(`corpus: ${corpus.length} icons from assets/icons`);
  for (const cmd of Object.keys(RENDERERS)) {
    const v = await spawnOnce(cmd, ["--version"], Buffer.alloc(0)).catch(() => null);
    console.log(`  ${cmd}: ${v ? v.out.toString().split("\n")[0] || v.stderr.split("\n")[0] : "MISSING"}`);
  }
  console.log(
    `runs/icon: ${args.runs}, profiles: ${Object.keys(profiles).join(", ")}${magick ? "" : " (no magick: pixel diff off)"}\n`,
  );

  for (const [pname, { w, h }] of Object.entries(profiles)) {
    console.log(`== ${pname} ${w}x${h} ==`);
    const results: Record<string, { samples: number[]; wrong: number; baseline?: Buffer[] }> = {};
    for (const [cmd, mkArgs] of Object.entries(RENDERERS)) {
      const samples: number[] = [];
      const outs: Buffer[] = [];
      let wrong = 0;
      for (const icon of corpus) {
        for (let i = 0; i < args.runs; i++) {
          const r = await spawnOnce(cmd, mkArgs(w, h), icon.svg);
          if (i > 0) samples.push(r.ms); // run 0 of each icon warms the binary, for both renderers
          if (i === 0) {
            const dims = pngSize(r.out);
            if (r.code !== 0 || !dims || dims.w !== w || dims.h !== h) {
              wrong++;
              if (wrong <= 3)
                console.log(`  ! ${cmd} ${icon.name}: code=${r.code} dims=${dims ? `${dims.w}x${dims.h}` : "no-png"}`);
            }
            outs.push(r.out);
          }
        }
      }
      results[cmd] = { samples, wrong, baseline: outs };
    }

    // Cross-check dims + optional pixel diff against the first renderer.
    const names = Object.keys(RENDERERS);
    const refName = names[0];
    const ref = refName === undefined ? undefined : results[refName];
    if (!ref) continue;
    for (const name of names.slice(1)) {
      const other = results[name];
      if (!other) continue;
      let differing = 0;
      let maxPx = 0;
      if (args.pixels) {
        for (let i = 0; i < corpus.length; i++) {
          const baseA = ref.baseline?.[i];
          const baseB = other.baseline?.[i];
          if (baseA === undefined || baseB === undefined) break;
          const d = await pixelDiff(baseA, baseB, `${pname}-${i}`);
          if (d === null) break;
          if (d > 0) differing++;
          maxPx = Math.max(maxPx, d);
        }
      }
      console.log(
        `${name.padEnd(14)} vs ${refName}: ${other.wrong} wrong dims${args.pixels ? `, ${differing} icons differ (max ${maxPx} px)` : ""}`,
      );
      if (other.wrong > 0)
        console.log(
          `  note: resvg -w/-h fits INSIDE the box (aspect-preserving), rsvg-convert -w/-h STRETCHES to exact dims`,
        );
    }

    console.log("renderer        total (all icons)   mean     median   p95      min");
    for (const [cmd, r] of Object.entries(results)) {
      const s = stats(r.samples);
      console.log(
        `${cmd.padEnd(15)} ${fmt(s.total).padEnd(19)} ${fmt(s.mean).padEnd(8)} ${fmt(s.median).padEnd(8)} ${fmt(s.p95).padEnd(8)} ${fmt(s.min)}`,
      );
    }
    const names2 = Object.keys(RENDERERS);
    const [n0, n1] = names2;
    const r0 = n0 === undefined ? undefined : results[n0];
    const r1 = n1 === undefined ? undefined : results[n1];
    if (r0 && r1 && n1 !== undefined) {
      const a = stats(r0.samples);
      const b = stats(r1.samples);
      console.log(
        `→ ${n1} is ${(a.median / b.median).toFixed(2)}x faster per icon (median), ${(a.total / b.total).toFixed(2)}x on the full corpus\n`,
      );
    }

    // resvg's internal breakdown (Reading / XML / SVG parse / Render). Render to
    // a file here: --perf prints to stdout, so -c would interleave PNG bytes.
    if (corpus[0]) {
      const perf = await spawnOnce(
        "resvg",
        ["--perf", "--quiet", "--background", BG, "-w", String(w), "-h", String(h), "-", path.join(TMP, "perf.png")],
        corpus[0].svg,
      );
      console.log(`resvg --perf (${corpus[0].name}):`);
      console.log(
        perf.out
          .toString()
          .split("\n")
          .filter((l) => l.trim())
          .map((l) => `  ${l}`)
          .join("\n"),
      );
      console.log("");
    }
  }

  rmSync(TMP, { recursive: true, force: true });
};

await main();
