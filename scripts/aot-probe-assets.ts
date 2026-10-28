// Asks a compiled tfm what it carries: how many embedded files it has, what
// they are named, and how many icons tfm's own index finds in them.
//
//   bun scripts/aot-probe-assets.ts aot [outfile]
//   bun scripts/aot-probe-assets.ts jit [outfile]
//
// The icons are embedded files of the executable. A compiled binary names
// them "<name>-<hash>.svg"; an ahead-of-time build may keep the plain
// "<name>.svg" instead. The probe uses tfm's OWN index function, so it
// answers the question that matters: does the app still find its icons? An
// empty index means every icon degrades to a text glyph — and the app looks
// fine while being wrong.
//
// The probe is built with the same script as the app, so the loader for the
// SVG assets is set the same way (see scripts/aot-build.ts).

import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";

type CompileOptions = Exclude<Parameters<typeof Bun.build>[0]["compile"], boolean | string> & {
  aot?: boolean;
};

const root = path.resolve(import.meta.dir, "..");
const mode = process.argv[2] === "jit" ? "jit" : "aot";
const outfile = path.resolve(root, process.argv[3] ?? `dist/probe/probe-assets-${mode}`);

// the program that does the asking
const entry = path.resolve(root, "dist/probe/probe-assets-entry.ts");
mkdirSync(path.dirname(entry), { recursive: true });
writeFileSync(
  entry,
  `import { loadEmbeddedIcons } from "../../src/ui/icons";

// Bun.embeddedFiles is typed as Blob[], but in a compiled binary the
// entries carry a name (they are Files in Bun's own types, plain Blobs
// with a name property at run time).
type Embedded = Blob & { name?: unknown };

const files = (Bun.embeddedFiles ?? []) as Embedded[];
const names = files.map((f) => f.name).filter((n): n is string => typeof n === "string");
const svgs = names.filter((n) => n.toLowerCase().endsWith(".svg"));
console.log(\`embedded files: \${names.length}, svg assets: \${svgs.length}\`);
console.log(\`sample asset names: \${svgs.slice(0, 3).join(", ")}\`);
const map = await loadEmbeddedIcons(files);
console.log(\`resolved icons: \${map.size}\`);
console.log(\`sample icons: \${[...map.keys()].slice(0, 5).join(", ")}\`);
if (map.size < 50) {
  console.error("the embedded icon index is nearly empty — every icon would degrade to a glyph");
  process.exit(1);
}
`,
);

const iconDir = path.join(root, "assets", "icons");
const icons = readdirSync(iconDir)
  .filter((name) => name.endsWith(".svg"))
  .map((name) => path.join(iconDir, name));

const result = await Bun.build({
  entrypoints: [entry, ...icons],
  loader: { ".svg": "file" },
  tsconfig: path.join(root, "tsconfig.json"),
  compile: { outfile, aot: mode === "aot" } as CompileOptions,
});

if (!result.success) {
  for (const log of result.logs) console.error(String(log));
  console.error(`the ${mode} asset probe failed to build`);
  process.exit(1);
}

const probe = Bun.spawn([outfile], { stdout: "pipe", stderr: "pipe" });
const [stdout, stderr, code] = await Promise.all([
  new Response(probe.stdout).text(),
  new Response(probe.stderr).text(),
  probe.exited,
]);
if (stdout) console.log(stdout.trim());
if (stderr) console.error(stderr.trim());
process.exit(code);
