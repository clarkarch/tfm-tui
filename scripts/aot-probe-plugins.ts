// Asks a compiled tfm whether it can load a PLUGIN from disk.
//
//   bun scripts/aot-probe-plugins.ts <variant> [outfile]
//
// The variants are the ones scripts/aot-build.ts knows:
//
//   jit              bun build --compile                      (the control)
//   aot              --aot
//   aot-trim         --aot --trim
//   aot-lean         --aot --trim --no-function-source
//   aot-disk         --aot --aot-allow-code-from-disk
//   aot-disk-trim    --aot --aot-allow-code-from-disk --trim
//   aot-disk-lean    --aot --aot-allow-code-from-disk --trim --no-function-source
//
// The probe compiles scripts/aot-probe-plugins-entry.ts with the variant's
// flags, runs it, and prints what it said. The entry uses tfm's OWN plugin
// loader against a REAL plugin folder (`<name>/<name>.ts`, TypeScript,
// default export, activate(api)) — the loader stages it into the cache and
// imports it from there, so the probe exercises the production path, not a
// stand-in.
//
// It is also a GATE: the exit code says whether the variant behaved the way
// its flags promise.
//
//   * a JIT build MUST load the plugin (it carries a transpiler)
//   * an AOT build WITHOUT --aot-allow-code-from-disk MUST refuse it
//   * an AOT build WITH --aot-allow-code-from-disk MUST load it
//
// The refusal has to be a RUN-TIME proof: a grep of the build log cannot
// answer it (the compiler's finding about a dynamic import mentions the
// flag the build does NOT use).
//
// WHAT THIS MEASURES: the RAW seal — the runtime's own disk-code path.
// Nothing here serves the source, so the import goes through the runtime
// and the runtime refuses it in a sealed build. The seal is not a
// whole-program property: a Bun plugin that SERVES the source bypasses it,
// and OpenTUI's runtime-module support (which tfm installs at boot) is
// exactly such a plugin. `scripts/aot-probe-plugin-seal.ts` measures that
// side; this probe measures this side.

import { mkdirSync } from "node:fs";
import path from "node:path";

type CompileOptions = Exclude<Parameters<typeof Bun.build>[0]["compile"], boolean | string> & {
  aot?: boolean;
  allowCodeFromDisk?: boolean;
};

type Variant = { aot: boolean; allowCodeFromDisk: boolean; trim: boolean };

const VARIANTS: Record<string, Variant> = {
  jit: { aot: false, allowCodeFromDisk: false, trim: false },
  aot: { aot: true, allowCodeFromDisk: false, trim: false },
  "aot-trim": { aot: true, allowCodeFromDisk: false, trim: true },
  "aot-lean": { aot: true, allowCodeFromDisk: false, trim: true },
  "aot-disk": { aot: true, allowCodeFromDisk: true, trim: false },
  "aot-disk-trim": { aot: true, allowCodeFromDisk: true, trim: true },
  "aot-disk-lean": { aot: true, allowCodeFromDisk: true, trim: true },
};

const root = path.resolve(import.meta.dir, "..");
const variantName = process.argv[2] ?? "jit";
const variant = VARIANTS[variantName];
if (!variant) {
  console.error(`unknown variant ${JSON.stringify(variantName)}`);
  console.error(`known variants: ${Object.keys(VARIANTS).join(", ")}`);
  process.exit(2);
}
const outfile = path.resolve(root, process.argv[3] ?? `dist/probe/probe-plugins-${variantName}`);
const entry = path.join(root, "scripts", "aot-probe-plugins-entry.ts");
mkdirSync(path.dirname(outfile), { recursive: true });

const result = await Bun.build({
  entrypoints: [entry],
  loader: { ".svg": "file" },
  // the same defines the app build uses, so the probe can report the mode
  // it was built as
  define: variant.aot
    ? {
        __TFM_BUILD_AOT__: "true",
        __TFM_BUILD_AOT_DISK_CODE__: variant.allowCodeFromDisk ? "true" : "false",
      }
    : {},
  tsconfig: path.join(root, "tsconfig.json"),
  compile: {
    outfile,
    aot: variant.aot,
    trim: variant.trim,
    ...(variant.allowCodeFromDisk ? { allowCodeFromDisk: true } : {}),
  } as CompileOptions,
});

if (!result.success) {
  for (const log of result.logs) console.error(String(log));
  console.error(`the ${variantName} plugin probe failed to build`);
  process.exit(1);
}
// the compiler's findings are worth seeing, but they are not the answer:
// the answer is what the executable does at run time
for (const log of result.logs) console.error(String(log));

const probe = Bun.spawn([outfile], { stdout: "pipe", stderr: "pipe" });
const [stdout, stderr, code] = await Promise.all([
  new Response(probe.stdout).text(),
  new Response(probe.stderr).text(),
  probe.exited,
]);
if (stderr) console.error(stderr.trim());
if (stdout) console.log(stdout.trim());

// the gate: what the variant's flags promise is what the binary must do
const loaded = /^plugin load: ok/m.test(stdout);
const wantLoad = !variant.aot || variant.allowCodeFromDisk;
if (loaded !== wantLoad) {
  console.error(
    wantLoad
      ? `GATE FAILED: the ${variantName} build did not load a plugin from disk`
      : `GATE FAILED: the ${variantName} build loaded a plugin from disk — the runtime's own disk path is not sealed`,
  );
  process.exit(1);
}
console.error(`GATE PASSED: the ${variantName} build ${wantLoad ? "loads" : "refuses"} plugins from disk`);
process.exit(code);
