// Asks a compiled tfm whether it can load code from disk.
//
//   bun scripts/aot-probe-disk-code.ts aot [outfile] [--trim]
//   bun scripts/aot-probe-disk-code.ts jit [outfile]
//
// An ahead-of-time executable carries no transpiler: it may not load a
// module from disk. The probe writes a module to a file and imports it —
// the AOT build must refuse it, the JIT baseline (the control) must load
// it. That is a run-time proof; a grep of the build log cannot give it,
// because the compiler's finding about a dynamic import mentions the
// flag the build does NOT use.
//
// The path is unique per run and the specifier is assembled at run time,
// so the compiler can neither find the file on disk while it builds the
// executable nor resolve the import to a constant: the module exists
// only while the program runs.
//
// The --trim flag builds the probe the way the trimmed tfm build is built:
// the trim report says the program can reach eval() and a dynamic import(),
// so the trimmed executable KEEPS the JavaScript interpreter and the
// transpiler — and may therefore load code from disk after all. The probe
// is the only way to know.

import { mkdirSync } from "node:fs";
import path from "node:path";

type CompileOptions = Exclude<Parameters<typeof Bun.build>[0]["compile"], boolean | string> & {
  aot?: boolean;
};

const root = path.resolve(import.meta.dir, "..");
const mode = process.argv[2] === "jit" ? "jit" : "aot";
const outfile = path.resolve(root, process.argv[3] ?? `dist/probe/probe-disk-code-${mode}`);
const trim = process.argv.includes("--trim");

// the program that does the asking
const entry = path.resolve(root, "dist/probe/probe-disk-code-entry.ts");
mkdirSync(path.dirname(entry), { recursive: true });
await Bun.write(
  entry,
  `const stamp = \`\${process.pid}-\${Date.now()}\`;
const file = \`/tmp/aot-code-from-disk-\${stamp}.js\`;
await Bun.write(file, "export const fromDisk = 42;\\n");
let refused = false;
let detail = "";
try {
  // the specifier is assembled at run time: the compiler sees no
  // constant path, so it cannot embed the module in the executable
  const specifier = [file].join("");
  const m = await import(specifier);
  detail = \`loaded \${String((m as { fromDisk?: number }).fromDisk)}\`;
} catch (err) {
  refused = true;
  detail = String((err as Error)?.message ?? err).slice(0, 160);
}
console.log(\`code from disk: \${refused ? "refused" : "LOADED"} — \${detail}\`);
`,
);

const result = await Bun.build({
  entrypoints: [entry],
  tsconfig: path.join(root, "tsconfig.json"),
  compile: { outfile, aot: mode === "aot", trim } as CompileOptions,
});

if (!result.success) {
  for (const log of result.logs) console.error(String(log));
  console.log(`the ${mode} disk-code probe failed to build`);
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
process.exit(code);
