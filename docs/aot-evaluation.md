# Bun AOT for tfm — evaluation

Status: experiment (branch `exp/aot-bun`). Nothing here is a release path.

Bun's ahead-of-time compiler ([oven-sh/bun#45631](https://github.com/oven-sh/bun/pull/45631))
is in **no released Bun yet** (latest: 1.4.4). The compiler lives in the PR's
head `4f7f658ed173fc23500de183b3713a8ddc18ba33`, so evaluating it means
building that Bun first — about an hour on a GitHub runner, and it needs a
pinned LLVM, a pinned Rust nightly and the WebKit prebuilt tarball.

The experiment: build that Bun, compile tfm with it, boot the result, and
compare it against a **JIT executable built by the same Bun** (so the two
differ in exactly one thing: whether the code was compiled ahead of time).

Everything below is measured by `.github/workflows/aot-experiment.yml`.

## What had to change in tfm

One thing: the plugin loader. A plugin is a TypeScript file on disk that the
loader imports at run time; an AOT executable may only run code that was
compiled **into** it. The loader is gated off at build time
(`src/plugins/plugin-gate.ts`), the code stays in the tree, and a normal build
is unaffected:

| | `tfm plugins` | `tfm plugins --help` |
| --- | --- | --- |
| JIT build | lists the installed plugins (exit 0) | answers (exit 0) |
| AOT build | `tfm: plugins are disabled in this build` (exit 1) | answers (exit 0) |

The gate is a bundler `define` (`__TFM_BUILD_AOT__`), so the disabled path
folds to a constant and the loader is dead code in the AOT binary.

## What the AOT build costs and buys

Measured on a GitHub runner, 5 boots per binary (run
[40620174696](https://github.com/clarkarch/tfm-tui/actions/runs/40620174696)):

| | JIT baseline | AOT | |
| --- | --- | --- | --- |
| gzip size | 77.3 MB | 95.7 MB | **+18.4 MB** |
| startup → first app code | 110 ms | 22 ms | −80 % |
| startup → renderer up | 142 ms | 40 ms | −72 % |
| startup → first paint | 427 ms | 291 ms | −32 % |
| app-reported boot | 350 ms | 286 ms | −18 % |
| RSS at first paint | 101 460 KB | 89 756 KB | −12 % |

AOT is **faster** and uses **less memory** at run time. It is **bigger** on
disk: the compiled program carries its own copy of everything it needs, and
the JIT executable already had the runtime in it.

The size is the one gate the plain AOT build misses: the target was a gzip
delta under 10 MB, the measured delta is +18.4 MB.

### The size lever: `--trim`

The AOT compiler can remove the Bun and Node.js APIs the program never calls
(`--trim`), and leave each function's source code out
(`--no-function-source`). `--no-function-source` alone is worth ~0.9 MB
gzipped — noise. `--trim` needs a Bun that carries the **trim table**, which
only a Bun built with `--trimmable=on` has; a Bun without it says
`this build of Bun doesn't support --trim (NoTrimTable)`.

## Correctness (all gates pass)

* the AOT executable boots and paints: 5/5 runs enter the alternate screen
  and complete the first full frame
* the 97 SVG icons are still embedded, and tfm's own icon index resolves
  all 97 of them (an empty index would degrade every icon to a text glyph
  while the app still "looked fine")
* the resvg native addon loads in the AOT executable and rasterizes the same
  SVG to the same 174 bytes as the JIT baseline
* the AOT executable **refuses to load code from disk** (proved at run time:
  it writes a module and imports it; the AOT build refuses, the JIT control
  loads it) — there is no transpiler in it
* no crashes at teardown, the same number of kitty images drawn

## The compiler's findings (warnings, not errors)

54 findings on the AOT build, all warnings:

| count | code | what |
| --- | --- | --- |
| 32 | TS100150 | missing resvg bindings for other platforms (only the host one exists) |
| 15 | TS100058 | a regular expression runs in the interpreter |
| 6 | TS100064 | a dynamic `import()`/`require()` of code from disk — the plugin loader, which the gate disables |
| 1 | TS100151 | `supports-color` missing from `debug` |

One runtime hazard the compiler reports: `TS100014` — `globalThis[key] ??= {}`
throws in a compiled executable (built-in objects are read-only). It sits in
the opentui fork's plugin path, which AOT disables.

## Three things that are not obvious

1. **The build goes through the JavaScript API** (`Bun.build`), not
   `bun build --compile` on the command line. The AOT compiler reads every
   entry point as *code* unless a loader says otherwise, and the icon assets
   are entry points (that is how a compiled binary carries them). Without
   `loader: { ".svg": "file" }` the compiler parses an SVG as TSX and stops
   with `Could not resolve: "react/jsx-dev-runtime"`. There is no CLI flag
   for it; the API has one.
2. **One tsconfig for the whole build** (`tsconfig: "tsconfig.json"`). The
   AOT compiler checks every file it reaches with the *nearest*
   `tsconfig.json`, and the opentui fork's built files are checked with the
   fork's (module: NodeNext), which reads them as CommonJS — `export` in a
   CommonJS file is an error under `verbatimModuleSyntax` (4× TS1287). The
   error is about the fork's build output, not about tfm's code.
3. **The transpiler proof has to be a run-time proof.** A grep of the build
   log cannot show it: the expected finding ("this import path isn't a
   constant") mentions the flag the build does *not* use. And the probe's
   path must be unique per run — a constant path that exists while the
   compiler runs gets embedded, and the AOT executable then loads it.

## Reproducing

```sh
# the bun that can compile ahead of time (hours; needs the pinned toolchain)
gh workflow run aot-experiment.yml --ref exp/aot-bun

# the tfm side, with such a bun in hand
bun scripts/aot-build.ts aot  dist/tfm-aot        # the AOT executable
bun scripts/aot-build.ts jit  dist/tfm-jit        # the JIT baseline
bun scripts/aot-measure.ts dist/tfm-aot 5 aot     # boot it and measure
```

`scripts/aot-probe-assets.ts` asks a compiled binary for its embedded icons,
`scripts/aot-probe-disk-code.ts` asks it whether it can load code from disk.
