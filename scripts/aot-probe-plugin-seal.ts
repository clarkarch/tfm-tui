// --- What does the AOT "seal" actually cover?
//
//   bun scripts/aot-probe-plugin-seal.ts <variant> [outfile]
//
// The question the plugin gate rests on: "an ahead-of-time build without
// --aot-allow-code-from-disk cannot load a plugin file from disk". The
// answer is RUNTIME, and it is not what the question assumes:
//
//   * the refusal the AOT runtime raises ("it isn't in this executable")
//     belongs to the runtime's OWN disk-code path (Bun's
//     `createNotInExecutableError`, src/jsc/bindings/BunCompiledModules.cpp:
//     629-648);
//   * a Bun PLUGIN that serves the source itself (an onLoad that returns
//     the file's text) never goes through that path — the runtime never
//     reads the file, the plugin hands it over;
//   * OpenTUI's runtime-module support IS such a plugin, and tfm installs
//     it at boot (src/wiring/plugins.ts).
//
// So the gate is a POLICY: it follows the build's opt-in
// (--aot-allow-code-from-disk), and its message names that flag rather
// than claiming the binary is incapable of loading code from disk.
//
// This probe is the GATE for that understanding. It compiles
// scripts/aot-probe-plugin-seal-entry.ts with the variant's flags and
// checks what the executable actually does:
//
//   * a JIT build: the runtime's own disk path loads, and both plugin
//     loads succeed;
//   * an AOT build WITH --aot-allow-code-from-disk: the same;
//   * an AOT build WITHOUT it: the runtime's own disk path is REFUSED and
//     the loader refuses the plugin — but once a plugin serves the source,
//     the plugin LOADS. That last line is the finding: the seal covers
//     the runtime's own path, not the program.
//
// The gate is the opposite of what the old probe asserted: the sealed
// build is expected to LOAD the plugin that a serving plugin hands it.

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
const outfile = path.resolve(root, process.argv[3] ?? `dist/probe/probe-plugin-seal-${variantName}`);
const entry = path.join(root, "scripts", "aot-probe-plugin-seal-entry.ts");
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
  console.error(`the ${variantName} plugin-seal probe failed to build`);
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

// ─── the gate ──────────────────────────────────────────────────────────────
//
// Three answers, three expectations:
//
//   the runtime's own disk path   refused in a sealed build, loaded otherwise
//   the plugin, nothing serving it refused in a sealed build, loaded otherwise
//   the plugin, a plugin serving it   LOADED in EVERY build — that is the
//                                     finding: the seal covers the
//                                     runtime's own path, not the program
const ownPath = /^runtime's own disk path: (LOADED|REFUSED)/m.exec(stdout)?.[1] ?? "none";
const unserved = /^plugin load \(nothing serves the source\): (ok|FAILED)/m.exec(stdout)?.[1] ?? "none";
const served = /^plugin load \(a plugin serves the source\): (ok|FAILED)/m.exec(stdout)?.[1] ?? "none";

const sealed = variant.aot && !variant.allowCodeFromDisk;
const wantOwn = sealed ? "REFUSED" : "LOADED";
const wantUnserved = sealed ? "FAILED" : "ok";
const problems: string[] = [];
if (ownPath !== wantOwn) problems.push(`the runtime's own disk path was ${ownPath}, expected ${wantOwn}`);
if (unserved !== wantUnserved) {
  problems.push(`the plugin with nothing serving it was ${unserved}, expected ${wantUnserved}`);
}
if (served !== "ok") {
  problems.push(`the plugin a serving plugin handed over was ${served} — the seal was NOT bypassed`);
}
if (problems.length > 0) {
  console.error(`GATE FAILED: the ${variantName} build — ${problems.join("; ")}`);
  process.exit(1);
}
console.error(
  `GATE PASSED: the ${variantName} build — the runtime's own disk path is ${ownPath}, and a plugin that serves the source loads the plugin (the seal covers the runtime's path, not the program)`,
);
process.exit(code);
