// Benchmarks archive lanes for the "minimize manual installs" question:
// system-tool spawns (the incumbent src/fs/archive.ts path) vs Bun.Archive
// (zero-dep) vs fflate (tiny pure-JS zip).
//
//   bun scripts/bench-archive.ts                    # tar.gz+zip, 3 runs each
//   bun scripts/bench-archive.ts --runs 5
//   bun scripts/bench-archive.ts --formats tar.gz,tar,zip,7z
//   bun scripts/bench-archive.ts --only spawn-tar,bun-archive,fflate
//
// Corpus is generated at runtime (no fixtures). Missing tools never fail the
// run — the lane reports MISSING, same philosophy as bench-raster.ts.
// fflate is a bench-only devDep until it wins (precedent: @jsquash/avif).
import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, readdir, readFile, stat } from "node:fs/promises";
import { lstatSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { compressPlan, extractPlan, runArchiveTool } from "../src/fs/archive.ts";

const TMP = mkdtempSync(path.join(tmpdir(), "tfm-bench-arch-"));

type Args = { runs: number; only?: string; formats?: string };
const parseArgs = (argv: string[]): Args => {
  let runs = 3;
  let only: string | undefined;
  let formats: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--runs") runs = Number(argv[++i]);
    else if (argv[i] === "--only") only = argv[++i];
    else if (argv[i] === "--formats") formats = argv[++i];
  }
  return { runs, only, formats };
};

// --- shared helpers (mirror bench-raster.ts) ---
const percentile = (sorted: number[], p: number): number =>
  sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] ?? 0;
const fmt = (ms: number): string => `${ms.toFixed(2)}ms`;
const stats = (samples: number[]) => {
  const s = [...samples].sort((a, b) => a - b);
  const sum = s.reduce((a, b) => a + b, 0);
  return { total: sum, mean: sum / s.length, median: percentile(s, 50), p95: percentile(s, 95), min: s[0] ?? 0 };
};

// --- corpus ---
const writeRand = (file: string, bytes: number): void => {
  const buf = Buffer.alloc(bytes);
  for (let i = 0; i < bytes; i++) buf[i] = (i * 2654435761) % 251;
  require("node:fs").writeFileSync(file, buf);
};

const buildCorpus = async (root: string): Promise<{ names: string[] }> => {
  const src = path.join(root, "src");
  await mkdir(path.join(src, "many"), { recursive: true });
  await mkdir(path.join(src, "med"), { recursive: true });
  await mkdir(path.join(src, "nested", "deep"), { recursive: true });
  await mkdir(path.join(src, "emptydir"), { recursive: true });
  const names: string[] = [];
  for (let i = 0; i < 500; i++) {
    const n = `many/f${i}.txt`;
    await Bun.write(path.join(src, n), `file-${i}-${"x".repeat(2048)}`);
    names.push(n);
  }
  for (let i = 0; i < 20; i++) {
    const n = `med/m${i}.bin`;
    writeRand(path.join(src, n), 256 * 1024);
    names.push(n);
  }
  writeRand(path.join(src, "large.bin"), 32 * 1024 * 1024);
  names.push("large.bin");
  await Bun.write(path.join(src, "nested", "deep", "leaf.txt"), "leaf");
  names.push("nested/deep/leaf.txt");
  await Bun.write(path.join(src, "-v"), "dash");
  names.push("-v");
  await Bun.write(path.join(src, "héllo-ünïcode.txt"), "unicode");
  names.push("héllo-ünïcode.txt");
  await Bun.write(path.join(src, "run.sh"), "#!/bin/sh\necho hi\n");
  await Bun.spawn(["chmod", "755", path.join(src, "run.sh")]).exited;
  names.push("run.sh");
  names.push("emptydir");
  return { names };
};

type Fidel = {
  contents: boolean;
  emptyDir: boolean;
  execBit: boolean;
  symlink: string;
  unicode: boolean;
  dash: boolean;
  detail: string;
};

const checkFidelity = async (src: string, stage: string, archRoot: string): Promise<Fidel> => {
  const out: Fidel = {
    contents: true,
    emptyDir: false,
    execBit: false,
    symlink: "n/a",
    unicode: false,
    dash: false,
    detail: "",
  };
  // contents: compare every regular file except the symlink probe
  const walk = async (dir: string, base: string): Promise<string[]> => {
    const out: string[] = [];
    for (const e of await readdir(dir, { withFileTypes: true })) {
      const rel = path.join(base, e.name);
      if (e.isDirectory()) out.push(...(await walk(path.join(dir, e.name), rel)));
      else if (e.isFile()) out.push(rel);
    }
    return out;
  };
  const srcFiles = (await walk(src, "")).filter((f) => f !== "link-to-leaf");
  for (const f of srcFiles) {
    // fflate/bun lanes store names with / separators; stage uses native sep (same on linux)
    const a = await readFile(path.join(src, f)).catch(() => null);
    const b = await readFile(path.join(stage, f)).catch(() => null);
    if (a === null || b === null || !a.equals(b)) {
      out.contents = false;
      out.detail = `content mismatch: ${f} (src ${a?.length} vs stage ${b?.length})`;
      break;
    }
  }
  try {
    out.emptyDir = (await stat(path.join(stage, "emptydir"))).isDirectory();
  } catch {
    out.detail += " | empty dir missing";
  }
  try {
    // eslint-disable-next-line no-bitwise
    out.execBit = ((await stat(path.join(stage, "run.sh"))).mode & 0o111) !== 0;
    if (!out.execBit) out.detail += " | exec bit lost";
  } catch {
    out.detail += " | run.sh missing";
  }
  try {
    const st = lstatSync(path.join(stage, "link-to-leaf"));
    out.symlink = st.isSymbolicLink() ? "symlink" : "followed-to-file";
    if (!st.isSymbolicLink()) out.detail += " | symlink followed, not preserved";
  } catch {
    out.symlink = "missing";
    out.detail += " | symlink missing";
  }
  try {
    out.unicode = (await readFile(path.join(stage, "héllo-ünïcode.txt"), "utf8")) === "unicode";
  } catch {
    out.detail += " | unicode file missing";
  }
  try {
    out.dash = (await readFile(path.join(stage, "-v"), "utf8")) === "dash";
  } catch {
    out.detail += " | dash file missing";
  }
  // silence unused (archRoot is the probe's home for future link-target checks)
  void archRoot;
  return out;
};

// --- lanes ---
type Lane = {
  name: string;
  format: "tar.gz" | "tar" | "zip" | "7z";
  compress: (names: string[], parent: string, out: string) => Promise<{ ms: number; extra?: string } | null>;
  extract: (arch: string, stage: string) => Promise<{ ms: number; extra?: string } | null>;
};

const spawnLane = (name: Lane["name"], format: Lane["format"]): Lane => ({
  name,
  format,
  compress: async (names, parent, out) => {
    const spec = compressPlan(format, out, names, parent);
    const t0 = performance.now();
    let lines = 0;
    const res = await runArchiveTool(spec, { cwd: parent, onLine: () => lines++ });
    if (res.code !== 0 && res.code !== 1) return null;
    return { ms: performance.now() - t0, extra: `tool=${spec.tool} lines=${lines}` };
  },
  extract: async (arch, stage) => {
    const spec = extractPlan(format, arch, stage);
    const t0 = performance.now();
    let lines = 0;
    const res = await runArchiveTool(spec, { onLine: () => lines++ });
    if (res.code !== 0 && res.code !== 1) return null;
    return { ms: performance.now() - t0, extra: `tool=${spec.tool} lines=${lines}` };
  },
});

const bunArchiveLane = (name: string, format: "tar.gz" | "tar"): Lane => ({
  name,
  format,
  compress: async (names, parent, out) => {
    const rec: Record<string, Uint8Array> = {};
    const dirs = new Set<string>();
    for (const n of names) {
      const abs = path.join(parent, n);
      try {
        const st = await stat(abs);
        if (st.isDirectory()) {
          rec[n.endsWith("/") ? n : `${n}/`] = new Uint8Array(0);
          continue;
        }
        // record the containing dirs so empty ones survive (trailing-slash
        // entries extract as real dirs — probed; non-empty dirs are implied)
        let d = path.posix.dirname(n);
        while (d !== "." && d !== "/" && !dirs.has(d)) {
          dirs.add(d);
          d = path.posix.dirname(d);
        }
      } catch {
        continue;
      }
      // NOTE: Bun.file refs would be ideal (streaming) but on 1.4.0 the
      // object form writes 0-byte entries for file-backed blobs (#28459 —
      // measured above as a 6ms "compress" of a 37MB corpus). Bytes are the
      // correct path here; the append()/stream fix is unmerged upstream.
      rec[n] = await Bun.file(abs).bytes();
    }
    const t0 = performance.now();
    const arch = new Bun.Archive(rec, format === "tar.gz" ? { compress: "gzip" } : undefined);
    // NOTE: Bun.write(out, arch) ignores the gzip setting on 1.4.0 (writes
    // raw tar — probed: 20480B f0.txt magic vs 680B 1f8b via .bytes()).
    // .bytes() is the correct sink until that is fixed upstream.
    await Bun.write(out, await arch.bytes());
    return { ms: performance.now() - t0 };
  },
  extract: async (arch, stage) => {
    const t0 = performance.now();
    const a = new Bun.Archive(await Bun.file(arch).bytes());
    await a.extract(stage);
    return { ms: performance.now() - t0 };
  },
});

let fflateInitMs: number | null = null;
// NOTE: one-shot zipSync (no per-file attrs) — the shipped fallback in
// src/fs/archive.ts uses the streaming Zip API with os/attrs and preserves
// exec bits + symlinks (pinned by round-trip). Speed numbers transfer; the
// fidelity row here does not.
const fflateLane = (): Lane => ({
  name: "fflate",
  format: "zip",
  compress: async (names, parent, out) => {
    const t0 = performance.now();
    const ff = await import("fflate");
    if (fflateInitMs === null) fflateInitMs = performance.now() - t0;
    const t1 = performance.now();
    const rec: Record<string, Uint8Array> = {};
    for (const n of names) {
      const abs = path.join(parent, n);
      try {
        if ((await stat(abs)).isDirectory()) {
          rec[n.endsWith("/") ? n : `${n}/`] = new Uint8Array(0);
          continue;
        }
      } catch {
        continue;
      }
      rec[n] = await Bun.file(abs).bytes();
    }
    const t2 = performance.now();
    const bytes = ff.zipSync(rec, { level: 6 });
    await Bun.write(out, bytes);
    return { ms: performance.now() - t1, extra: `read=${(t2 - t1).toFixed(0)}ms` };
  },
  extract: async (arch, stage) => {
    const t0 = performance.now();
    const { unzipSync } = await import("fflate");
    const map = unzipSync(await Bun.file(arch).bytes());
    // mkdir once per dir (not once per file — the per-file mkdir inflated the
    // first cut 6x vs unzip and no real impl would do that)
    const dirSet = new Set<string>();
    for (const name of Object.keys(map)) {
      if (!name.endsWith("/")) dirSet.add(path.dirname(path.join(stage, name)));
    }
    await Promise.all([...dirSet].map((d) => mkdir(d, { recursive: true })));
    for (const [name, data] of Object.entries(map)) {
      if (name.endsWith("/")) {
        await mkdir(path.join(stage, name), { recursive: true });
        continue;
      }
      await Bun.write(path.join(stage, name), data as Uint8Array);
    }
    return { ms: performance.now() - t0 };
  },
});

const main = async () => {
  const args = parseArgs(process.argv.slice(2));
  const wanted = args.only
    ?.split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const formats = (args.formats ?? "tar.gz,zip")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const keep = (name: string): boolean => !wanted || wanted.includes(name);

  console.log(`bun ${Bun.version}`);
  for (const t of ["tar", "gzip", "zip", "unzip", "7z"]) console.log(`  ${t}: ${Bun.which(t) ?? "MISSING"}`);
  try {
    const probe = new Bun.Archive({ "hi.txt": "hello" }, { format: "zip" } as never);
    const bytes = await probe.bytes();
    const isZip = bytes[0] === 0x50 && bytes[1] === 0x4b;
    console.log(`  Bun.Archive zip probe: ${isZip ? "ZIP (PK magic)" : "NOT zip — silently produces tar"}`);
  } catch (e) {
    console.log(`  Bun.Archive zip probe: throws (${String(e).slice(0, 120)})`);
  }
  console.log(`runs/lane: ${args.runs}, formats: ${formats.join(",")}${args.only ? `, only: ${args.only}` : ""}\n`);

  const lanes: Lane[] = [
    spawnLane("spawn-tar", "tar.gz"),
    bunArchiveLane("bun-archive", "tar.gz"),
    spawnLane("spawn-tar-plain", "tar"),
    bunArchiveLane("bun-archive-plain", "tar"),
    spawnLane("spawn-zip", "zip"),
    fflateLane(),
    spawnLane("spawn-7z", "7z"),
  ].filter((l) => formats.includes(l.format) && keep(l.name));

  const { names } = await buildCorpus(TMP);
  const src = path.join(TMP, "src");
  // symlink probe (archived as symlink by tar/zip CLIs; in-process lanes may follow it)
  await Bun.spawn(["ln", "-s", "nested/deep/leaf.txt", path.join(src, "link-to-leaf")]).exited;
  names.push("link-to-leaf");

  for (const lane of lanes) {
    const archName = `out-${lane.name}.${lane.format === "tar.gz" ? "tar.gz" : lane.format}`;
    const compSamples: number[] = [];
    const extSamples: number[] = [];
    let compExtra = "";
    let extExtra = "";
    let failed = 0;
    let fidel: Fidel | null = null;
    let archSize = "";
    for (let i = 0; i < args.runs; i++) {
      const arch = path.join(TMP, `run${i}-${archName}`);
      const c = await lane.compress(names, src, arch).catch(() => null);
      if (c === null) {
        failed++;
        continue;
      }
      if (i > 0) compSamples.push(c.ms);
      if (i === 0) {
        compExtra = c.extra ?? "";
        try {
          const b = (await stat(arch)).size;
          archSize = b >= 1048576 ? `${(b / 1048576).toFixed(1)}MB` : `${(b / 1024).toFixed(0)}KB`;
        } catch {}
      }
      const stage = path.join(TMP, `stage-${lane.name}-${i}`);
      await mkdir(stage, { recursive: true });
      const e = await lane.extract(arch, stage).catch(() => null);
      if (e === null) {
        failed++;
        continue;
      }
      if (i > 0) extSamples.push(e.ms);
      if (i === 0) {
        extExtra = e.extra ?? "";
        fidel = await checkFidelity(src, stage, arch);
      }
    }
    const cs = compSamples.length ? stats(compSamples) : null;
    const es = extSamples.length ? stats(extSamples) : null;
    if (!cs || !es) {
      console.log(`${lane.name} [${lane.format}]: NO RESULT (${failed} failed — lane broken or tool missing)`);
      continue;
    }
    console.log(
      `${lane.name} [${lane.format}]: compress median ${fmt(cs.median)} p95 ${fmt(cs.p95)} size=${archSize} ${compExtra} | extract median ${fmt(es.median)} p95 ${fmt(es.p95)} ${extExtra}${failed ? ` | failed ${failed}` : ""}`,
    );
    if (fidel) {
      const f = fidel;
      console.log(
        `  fidelity: contents ${f.contents ? "ok" : "FAIL"} | emptyDir ${f.emptyDir ? "ok" : "FAIL"} | exec ${f.execBit ? "ok" : "FAIL"} | symlink ${f.symlink} | unicode ${f.unicode ? "ok" : "FAIL"} | dash ${f.dash ? "ok" : "FAIL"}${f.detail ? ` —${f.detail}` : ""}`,
      );
    }
  }
  if (fflateInitMs !== null) console.log(`\nfflate cold import: ${fmt(fflateInitMs)} (paid once per process)`);
  rmSync(TMP, { recursive: true, force: true });
};

await main();
