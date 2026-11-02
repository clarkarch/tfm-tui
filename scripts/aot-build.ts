// Builds tfm as a standalone executable.
//
//   bun scripts/aot-build.ts <variant> [outfile] [--explain-trim]
//
// The variants are the configurations the AOT experiment measures:
//
//   jit              bun build --compile                      (the control)
//   aot              --aot
//   aot-trim         --aot --trim
//   aot-lean         --aot --trim --no-function-source
//   aot-disk         --aot --aot-allow-code-from-disk
//   aot-disk-trim    --aot --aot-allow-code-from-disk --trim
//   aot-disk-lean    --aot --aot-allow-code-from-disk --trim --no-function-source
//
// Every mode goes through the JavaScript API of the bundler and builds the
// same program the same way, so the binaries differ in exactly one thing:
// whether the code was compiled ahead of time (and whether the build may
// load code from disk). The AOT build needs a bun that carries the AOT
// compiler (the `--aot` flag); every other bun can run this script, and
// builds the JIT baseline with it.
//
// The flags are the size knobs of the AOT compiler:
//
//   --trim              remove the Bun and Node.js APIs the program never
//                       calls from the executable (needs a bun that carries
//                       the trim table: one built with --trimmable=on)
//   --no-function-source  leave each function's source code out of the
//                       executable (fn.toString() then says "[native code]")
//   --explain-trim      report which APIs the program uses and why each
//                       feature was kept or removed (the report is what
//                       says whether the trimmed build lost something)
//
// Why the JavaScript API and not `bun build --compile` on the command
// line: the AOT compiler reads every entry point as CODE unless a loader
// says otherwise. The icon assets are entry points (that is how a
// compiled binary carries them), and without the `.svg` loader the
// compiler parses an SVG as TSX and stops the build with
// "Could not resolve: react/jsx-dev-runtime". The API can say what a
// file is; the command line has no flag for it.
//
// THE SILENT-FALLBACK TRAP: a bun WITHOUT the AOT compiler accepts
// `--aot` and IGNORES it. The build succeeds, the binary is a plain JIT
// binary, and it still loads code from disk — so a project can believe it
// ships AOT while shipping JIT. `assertAotCompiler` below is the guard: it
// asks the built binary at RUN TIME whether it can load code from disk (a
// grep of the build log cannot answer it — the compiler's finding about a
// dynamic import mentions the flag the build does NOT use).

import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";

// the AOT compiler is new enough that the types of the bun this
// repository develops against do not know about it yet
type CompileOptions = Exclude<Parameters<typeof Bun.build>[0]["compile"], boolean | string> & {
  aot?: boolean;
  // `compile.allowCodeFromDisk` is the JavaScript API spelling of
  // `--aot-allow-code-from-disk` (Bun's src/runtime/api/JSBundler.rs reads
  // it as `allowCodeFromDisk`).
  allowCodeFromDisk?: boolean;
};

type Variant = {
  aot: boolean;
  allowCodeFromDisk: boolean;
  trim: boolean;
  functionSource?: boolean;
};

const VARIANTS: Record<string, Variant> = {
  jit: { aot: false, allowCodeFromDisk: false, trim: false },
  aot: { aot: true, allowCodeFromDisk: false, trim: false },
  "aot-trim": { aot: true, allowCodeFromDisk: false, trim: true },
  "aot-lean": { aot: true, allowCodeFromDisk: false, trim: true, functionSource: false },
  "aot-disk": { aot: true, allowCodeFromDisk: true, trim: false },
  "aot-disk-trim": { aot: true, allowCodeFromDisk: true, trim: true },
  "aot-disk-lean": { aot: true, allowCodeFromDisk: true, trim: true, functionSource: false },
};

const root = path.resolve(import.meta.dir, "..");
const variantName = process.argv[2] ?? "jit";
const baseVariant = VARIANTS[variantName];
if (!baseVariant) {
  console.error(`unknown variant ${JSON.stringify(variantName)}`);
  console.error(`known variants: ${Object.keys(VARIANTS).join(", ")}`);
  process.exit(2);
}
const flags = process.argv.slice(3);
const outfileArg = flags.find((a) => !a.startsWith("--"));
const outfile = path.resolve(root, outfileArg ?? path.join("dist", `tfm-${variantName}`));
const explainTrim = flags.includes("--explain-trim");

// explicit flags win over the variant (the package scripts use
// "aot --trim"; the variants exist so the experiment can name a
// configuration in one word)
const variant: Variant = {
  ...baseVariant,
  trim: baseVariant.trim || flags.includes("--trim"),
  functionSource: flags.includes("--no-function-source") ? false : baseVariant.functionSource,
  allowCodeFromDisk: baseVariant.allowCodeFromDisk || flags.includes("--allow-code-from-disk"),
};

// the icon assets travel with the binary: a compiled executable reads
// them from itself, so the app needs no installation directory
const iconDir = path.join(root, "assets", "icons");
const icons = readdirSync(iconDir)
  .filter((name) => name.endsWith(".svg"))
  .map((name) => path.join(iconDir, name));

mkdirSync(path.dirname(outfile), { recursive: true });

// --- the mode assertion ---------------------------------------------------
//
// "This build is AOT" is a claim about the TOOLCHAIN, not about the flags
// this script passes: a bun without the AOT compiler accepts `--aot` and
// ignores it, and the result is a JIT binary that still loads plugins from
// disk. The only honest answer is a RUN-TIME proof: build a tiny program
// that writes a module and imports it, and see whether the executable
// refuses. An AOT executable refuses; a JIT one loads it.
//
// The probe is built WITHOUT --aot-allow-code-from-disk on purpose: the
// flag lifts the seal, so a probe built with it could not tell an AOT
// binary from a JIT one.
const assertAotCompiler = async (): Promise<void> => {
  const probeDir = path.join(root, "dist", "probe");
  mkdirSync(probeDir, { recursive: true });
  const entry = path.join(probeDir, "aot-mode-probe-entry.ts");
  writeFileSync(
    entry,
    `const file = \`/tmp/aot-mode-probe-\${process.pid}-\${Date.now()}.js\`;
await Bun.write(file, "export const x = 42;\\n");
try {
  const specifier = [file].join("");
  const m = await import(specifier);
  console.log("LOADED " + String(m.x));
} catch (err) {
  console.log("REFUSED " + String((err as Error)?.message ?? err).slice(0, 120));
}
`,
  );
  const probeOut = path.join(probeDir, "aot-mode-probe");
  const probe = await Bun.build({
    entrypoints: [entry],
    tsconfig: path.join(root, "tsconfig.json"),
    compile: { outfile: probeOut, aot: true } as CompileOptions,
  });
  if (!probe.success) {
    for (const log of probe.logs) console.error(String(log));
    console.error("the AOT mode probe failed to build — this bun has no AOT compiler");
    process.exit(1);
  }
  const run = Bun.spawn([probeOut], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr] = await Promise.all([new Response(run.stdout).text(), new Response(run.stderr).text()]);
  await run.exited;
  if (stderr.trim()) console.error(stderr.trim());
  const answer = stdout.trim();
  if (!answer.startsWith("REFUSED")) {
    console.error(
      "this bun does not have the AOT compiler: `--aot` was accepted and IGNORED, " +
        "so the executable would be a plain JIT binary (it still loads code from disk).",
    );
    console.error(`the mode probe said: ${answer || "(nothing)"}`);
    process.exit(1);
  }
};

if (variant.aot) await assertAotCompiler();

const result = await Bun.build({
  entrypoints: [path.join(root, "src", "index.ts"), ...icons],
  // the assets are files, not code: the compiler embeds them as they are
  loader: { ".svg": "file" },
  // the plugin loader loads code from disk. An ahead-of-time build may only
  // do that when it was given --aot-allow-code-from-disk, so the gate is
  // told what the build actually allows — the defines are what makes the
  // compiler see it as off (and fold the disabled path away).
  define: variant.aot
    ? {
        __TFM_BUILD_AOT__: "true",
        __TFM_BUILD_AOT_DISK_CODE__: variant.allowCodeFromDisk ? "true" : "false",
      }
    : {},
  // one tsconfig for the whole build: the AOT compiler checks every file
  // it reaches with the nearest tsconfig.json, and the opentui fork's
  // built files are checked with the fork's (module: NodeNext), which
  // reads them as CommonJS — "export" in a CommonJS file is an error
  // under verbatimModuleSyntax. The error is about the fork's build
  // output, not about tfm's code.
  tsconfig: path.join(root, "tsconfig.json"),
  compile: {
    outfile,
    aot: variant.aot,
    trim: variant.trim,
    // the seal: an ahead-of-time build may only load code from disk when
    // it is told it may (Bun interprets that code — it is not compiled
    // ahead of time).
    ...(variant.allowCodeFromDisk ? { allowCodeFromDisk: true } : {}),
    ...(variant.functionSource === undefined ? {} : { functionSource: variant.functionSource }),
    ...(explainTrim ? { aotExplain: "trim" } : {}),
  } as CompileOptions,
});

if (!result.success) {
  for (const log of result.logs) console.error(String(log));
  console.error(`the ${variantName} build failed`);
  process.exit(1);
}

for (const log of result.logs) console.log(String(log));
console.log(`built the ${variantName} executable: ${outfile}`);
