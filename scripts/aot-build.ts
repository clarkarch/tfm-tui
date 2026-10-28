// Builds tfm as a standalone executable.
//
//   bun scripts/aot-build.ts aot [outfile] [--trim] [--no-function-source]
//   bun scripts/aot-build.ts jit [outfile]
//
// Both modes go through the JavaScript API of the bundler and build the
// same program the same way, so the two binaries differ in exactly one
// thing: whether the code was compiled ahead of time. The AOT build needs
// a bun that carries the AOT compiler (the `--aot` flag); every other bun
// can run this script, and builds the JIT baseline with it.
//
// The two flags are the size knobs of the AOT compiler:
//
//   --trim              remove the Bun and Node.js APIs the program never
//                       calls from the executable
//   --no-function-source  leave each function's source code out of the
//                       executable (fn.toString() then says "[native code]")
//
// Why the JavaScript API and not `bun build --compile` on the command
// line: the AOT compiler reads every entry point as CODE unless a loader
// says otherwise. The icon assets are entry points (that is how a
// compiled binary carries them), and without the `.svg` loader the
// compiler parses an SVG as TSX and stops the build with
// "Could not resolve: react/jsx-dev-runtime". The API can say what a
// file is; the command line has no flag for it.

import { mkdirSync, readdirSync } from "node:fs";
import path from "node:path";

// the AOT compiler is new enough that the types of the bun this
// repository develops against do not know about it yet
type CompileOptions = Exclude<Parameters<typeof Bun.build>[0]["compile"], boolean | string> & {
  aot?: boolean;
};

const root = path.resolve(import.meta.dir, "..");
const mode = process.argv[2] === "aot" ? "aot" : "jit";
const flags = process.argv.slice(3);
const outfileArg = flags.find((a) => !a.startsWith("--"));
const outfile = path.resolve(root, outfileArg ?? path.join("dist", mode === "aot" ? "tfm-aot" : "tfm-jit"));
const trim = flags.includes("--trim");
const functionSource = flags.includes("--no-function-source") ? false : undefined;

// the icon assets travel with the binary: a compiled executable reads
// them from itself, so the app needs no installation directory
const iconDir = path.join(root, "assets", "icons");
const icons = readdirSync(iconDir)
  .filter((name) => name.endsWith(".svg"))
  .map((name) => path.join(iconDir, name));

mkdirSync(path.dirname(outfile), { recursive: true });

const result = await Bun.build({
  entrypoints: [path.join(root, "src", "index.ts"), ...icons],
  // the assets are files, not code: the compiler embeds them as they are
  loader: { ".svg": "file" },
  // the plugin loader loads code from disk, which an ahead-of-time build
  // cannot do — the gate turns it off, and the define is what makes the
  // compiler see it as off
  define: mode === "aot" ? { __TFM_BUILD_AOT__: "true" } : {},
  // one tsconfig for the whole build: the AOT compiler checks every file
  // it reaches with the nearest tsconfig.json, and the opentui fork's
  // built files are checked with the fork's (module: NodeNext), which
  // reads them as CommonJS — "export" in a CommonJS file is an error
  // under verbatimModuleSyntax. The error is about the fork's build
  // output, not about tfm's code.
  tsconfig: path.join(root, "tsconfig.json"),
  compile: {
    outfile,
    aot: mode === "aot",
    trim,
    ...(functionSource === undefined ? {} : { functionSource }),
  } as CompileOptions,
});

if (!result.success) {
  for (const log of result.logs) console.error(String(log));
  console.error(`the ${mode} build failed`);
  process.exit(1);
}

for (const log of result.logs) console.log(String(log));
console.log(`built the ${mode} executable: ${outfile}`);
