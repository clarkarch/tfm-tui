// Asks a compiled binary whether it can still rasterize SVG.
//
//   bun scripts/aot-probe-resvg.ts aot [outfile]
//   bun scripts/aot-probe-resvg.ts jit [outfile]
//
// tfm draws its icons as SVG and rasterizes them with the resvg-js native
// addon (a napi addon, loaded through a sync require-dlopen). A compiled
// binary has to CARRY the .node file and dlopen it at run time; if the build
// drops it, every icon silently degrades to a text glyph and the app still
// "works" — the failure is invisible.
//
// The probe renders one SVG and prints the size of the PNG. The AOT build
// and the JIT baseline must answer the same number: a different rasterizer
// (or a different font set) would change the bytes.
//
// Run it with the bun that can build the variant asked for: the AOT variant
// needs a bun that carries the AOT compiler.

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

type CompileOptions = Exclude<Parameters<typeof Bun.build>[0]["compile"], boolean | string> & {
  aot?: boolean;
};

const root = path.resolve(import.meta.dir, "..");
const mode = process.argv[2] === "jit" ? "jit" : "aot";
const outfile = path.resolve(root, process.argv[3] ?? `dist/probe/probe-resvg-${mode}`);

// the program that does the asking
const entry = path.resolve(root, "dist/probe/probe-resvg-entry.ts");
mkdirSync(path.dirname(entry), { recursive: true });
writeFileSync(
  entry,
  `import { Resvg } from "@resvg/resvg-js";

const svg =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">' +
  '<path d="M3 5 H9 L11 7.5 H21 V19 H3 Z" fill="#cdd6f4"/></svg>';
const r = new Resvg(svg, { logLevel: "off", font: { loadSystemFonts: false } });
const png = r.render().asPng();
console.log(\`resvg png bytes: \${png.length}\`);
if (png.length < 100) {
  console.error("the rasterized png is suspiciously small");
  process.exit(1);
}
`,
);

const result = await Bun.build({
  entrypoints: [entry],
  tsconfig: path.join(root, "tsconfig.json"),
  compile: { outfile, aot: mode === "aot" } as CompileOptions,
});

if (!result.success) {
  for (const log of result.logs) console.error(String(log));
  console.log(`the ${mode} resvg probe failed to build`);
  process.exit(1);
}
for (const log of result.logs) console.error(String(log));

const probe = Bun.spawn([outfile], { stdout: "pipe", stderr: "pipe" });
const [stdout, stderr, code] = await Promise.all([
  new Response(probe.stdout).text(),
  new Response(probe.stderr).text(),
  probe.exited,
]);
if (stderr) console.error(stderr.trim());
if (stdout) console.log(stdout.trim());
process.exit(code);
