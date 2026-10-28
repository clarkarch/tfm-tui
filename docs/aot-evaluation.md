# Bun AOT for tfm — evaluation

Status: shipped. The release workflow (`.github/workflows/release.yml`)
compiles tfm ahead of time for both architectures; this page is the
evaluation behind that decision.

Bun's ahead-of-time compiler (`bun build --compile --aot`) is in **no released
Bun yet** (latest: 1.4.4). It was merged into Bun's main, so evaluating it
means building that Bun from a pinned commit
(`4f7f658ed173fc23500de183b3713a8ddc18ba33`) first — about an hour on a
GitHub runner, and it needs a pinned LLVM, a pinned Rust nightly and the
WebKit prebuilt tarball.

The experiment: build that Bun, compile tfm with it, boot the result, and
compare it against a **JIT executable built by the same Bun** (so the two
differ in exactly one thing: whether the code was compiled ahead of time).

Everything below is measured by `.github/workflows/aot-experiment.yml`.

**Result in one line: the AOT build starts about 1.5× faster than the JIT
binary it replaces, browses about twice as fast in a large directory, and
ships about the same size** — 302 ms vs 475 ms to the first painted frame on
the release runner, 53.2 MiB gzipped against the 50.9 MiB of v1.1.0 — but it
needs a Bun that nobody ships yet, and it takes the plugin system with it.

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
[40633106092](https://github.com/clarkarch/tfm-tui/actions/runs/40633106092),
every gate green; the sizes are byte-identical across the three green runs
[40622551742](https://github.com/clarkarch/tfm-tui/actions/runs/40622551742),
[40631228427](https://github.com/clarkarch/tfm-tui/actions/runs/40631228427)
and this one, whose timings differ by a few percent — the runner is noisy,
the sizes are not):

| | JIT baseline | AOT | AOT `--trim` | AOT `--trim --no-function-source` |
| --- | --- | --- | --- | --- |
| gzip size | 77.6 MiB | 64.8 MiB | 59.2 MiB | **58.4 MiB** |
| raw size | 180.6 MiB | 157.7 MiB | 145.7 MiB | 142.1 MiB |
| startup → first app code | 153 ms | 35 ms | 28 ms | 30 ms |
| startup → renderer up | 181 ms | 61 ms | 41 ms | 41 ms |
| startup → first paint | 500 ms | 311 ms | 302 ms | **306 ms** |
| app-reported boot | 394 ms | 304 ms | 296 ms | 298 ms |
| RSS at first paint | 96 632 KB | 82 144 KB | 79 576 KB | 79 736 KB |
| kitty images drawn | 4 | 4 | 4 | 4 |
| crashes at teardown | 0 | 0 | 0 | 0 |

Two things about this table. Its **JIT baseline is a JIT binary built by the
AOT Bun** — the apples-to-apples comparison, where the only difference is
whether the code was compiled ahead of time; the stock Bun that ships today
builds a different (and bigger) JIT binary, and "the size story" below puts
the two side by side. And every size in the table was measured **before the
debug symbols were stripped out of the staged native library** — the release
strips them, which takes about 6 MiB off every column.

The **candidate** — the smallest variant that boots and paints every run — is
the last column: **19.2 MiB smaller gzipped than the JIT build and 30–39 %
faster to the first frame** (the three green runs measured −30.2 %, −37.4 %
and −38.8 %). Both gates of the experiment pass:

```
PASS  gzip size delta under 10 MB (aot-lean) — aot-lean 58.4MB vs jit 77.6MB (-19.2MB)
PASS  first paint is at least 10% faster (aot-lean) — aot-lean 306ms vs jit 500ms (-38.8%)
```

What the AOT build buys at run time: the module graph is machine code, so the
program reaches its first line of app code in ~30 ms instead of ~150 ms
(−80 %), and the whole frame is painted ~195 ms earlier. The runtime it does
not need is also not in the executable, so the resident set at the first frame
is ~16 MiB smaller (96 632 KB → 79 736 KB).

### The size story: what ships, and against what

The table above compares two builds made by the same Bun. What a user
downloads is a different question, and the honest answer needs three numbers
per architecture — the release, the release before it, and the fallback:

| release artifact | raw | gzip |
| --- | --- | --- |
| v1.1.0 x86_64 — JIT, stock Bun 1.4.0 | 130.9 MiB | 50.9 MiB |
| **v1.2.0 x86_64 — AOT, `--trim`** | **123.6 MiB** | **53.2 MiB** |
| v1.1.0 aarch64 — JIT, stock Bun 1.4.0 | 129.3 MiB | 50.2 MiB |
| **v1.2.0 aarch64 — AOT, `--trim`** | **125.9 MiB** | **52.2 MiB** |
| v1.2.0 fallback (x86_64) — JIT, stock Bun 1.4.4 | 133.9 MiB | 59.3 MiB |

So the AOT release is **2.0–2.4 MiB bigger than v1.1.0** — and it starts
**about 1.5× faster**. The release measures both on the runner that builds
it (median of three boots, the numbers the release notes print):

| | AOT first paint | JIT baseline first paint | |
| --- | --- | --- | --- |
| x86_64 | 302 ms | 475 ms | 1.57× |
| aarch64 | 295 ms | 444 ms | 1.51× |

(On a slower machine the gap grows: on the machine this was written on, the
same comparison is 373 ms vs 1008 ms — 2.7×. The faster the machine, the
less there is to win: the AOT binary skips the compilation work, not the
I/O.)

The AOT executable is smaller than a JIT binary built by the same Bun (the
AOT one does not carry the JIT compiler — the code is machine code instead),
but Bun itself grew between 1.4.0 and 1.4.4 (77 MiB → 102 MiB for the
runtime), and that eats the difference.

#### The 23 MB of debug symbols

Every compiled binary **embeds the native library it loads** — twice: the
patched `libopentui` that `scripts/sync-opentui-lib.sh` stages, and the npm
one that comes with the platform package. The fork's prebuilt library keeps
its debug symbols: 28.5 MB per target, of which 5.3 MB is code. Staged as it
was, **23 MB of symbols went into every binary** — and about 6 MiB into every
gzipped download.

The staging script now strips the copy it stages (`strip --strip-unneeded`,
which keeps the dynamic symbols — the ABI — and drops the rest). The fork
keeps its own file intact, so its debugging is not affected. On the x86_64
binary: 28 456 600 → 5 301 144 bytes, and the release artifact went from
59.2 MiB to 53.2 MiB gzipped (aarch64: 58.0 MiB → 52.2 MiB).

### The size lever: `--trim`, and the Bun it needs

The AOT compiler can remove the Bun and Node.js APIs the program never calls
(`--trim`), and leave each function's source code out
(`--no-function-source`). `--no-function-source` on top of `--trim` is worth
~0.8 MiB gzipped — noise. `--trim` is worth ~5.6 MiB on top of the plain AOT
build.

`--trim` needs a Bun that carries the **trim table**, which only a Bun built
with `--trimmable=on` has; a Bun without it says
`this build of Bun doesn't support --trim (NoTrimTable)`. The trim table is
baked in at Bun's **link** time, so the Bun has to be built with the flag —
there is no way around it from the tfm side. The same Bun also makes the
*plain* AOT build smaller (its linker trims what the program does not use:
95.7 MiB → 64.8 MiB gzipped), so a stock Bun build is not a fair baseline for
the AOT numbers either.

The experiment therefore builds its own Bun:

```
bun scripts/build.ts --profile=release --aot=on --webkit=prebuilt \
  --trimmable=on --lto=off
```

and reuses that binary for every later run (the artifact `bun-aot` lives for
90 days; the workflow takes a `bun_run_id` input to point at it).

### What `--trim` actually removes

The build can explain itself: `--explain-trim` prints the report. For tfm it
says **63 feature groups removed, 167 kept, and 27 "blocked" reasons** —
features the compiler could not remove because some path might reach them:

| blocked by | count | why |
| --- | --- | --- |
| eval | 11 | the program can reach `eval`/`new Function` — `AsyncGeneratorFunction` at `src/app/nav.ts:70`, `new Function` in the opentui fork |
| dynamic-import | 11 | `require()` with a computed path (opentui, the plugin loader, `fflate`, `bindings`) |
| native-code | 3 | `dlopen` of the resvg addon and of the x11 helper |
| runtime-code | 2 | `Bun.plugin` and `Bun.serve` |

What it removed: the development server and the bundler (`Bun.build`), the
package manager (`bun install`, `bunx`), the test runner (`bun:test`), the
linter and formatter, `bun:sqlite`, Redis, cron, Markdown, TOML, YAML, XML,
JSON5/JSONC, `node:http2`, `node:quic`, `node:vm`, `node:v8`, `node:repl`,
`undici`, the hash and crypto classes that nothing names, the `--watch`/`--hot`
spawn paths, the run-time loading of `package.json`/`tsconfig.json`, most of
`Intl` and `Temporal`, **the ahead-of-time compiler itself** — and dozens more
Bun and Node.js API groups.

What it had to keep: `node:os`, `node:path`, `node:zlib`, `node:net`,
`node:util`, `Bun.serve`, `Bun.ffi`, the native addon loader, **and the whole
JavaScript interpreter** — the report says so explicitly: *"kept eval, new
Function and the JavaScript interpreter (interpreter)"*.

**So `--trim` does not take eval away from tfm** — the program can reach it,
and the interpreter stays in the binary. Two things follow:

* eval works in the AOT executable, plain and trimmed alike (the feature
  probe asks: `eval: ok (42)` in both). The "AOT has no JavaScript" picture
  is wrong: the compiler needs an interpreter for the regular expressions it
  cannot compile (15 × TS100058), and eval rides along with it.
* the trimmed binary is *bigger* than it needs to be because of it. The
  5.6 MiB `--trim` saves is the Bun/Node API surface, not the engine.

The interesting part: **the trimmed build still refuses to load code from
disk.** The interpreter is in the binary, but the AOT runtime only runs code
that was compiled into the executable — the probe that writes a module and
imports it gets *"it isn't in this executable, which only runs code that was
compiled into it"* from the plain **and** from the trimmed build. The
workflow asks both, because the trimmed build is the candidate a release
would ship.

## Runtime performance: browsing, not just booting

The startup numbers above are the headline, but a file manager is used for
*browsing*. The question that matters after the first frame is: does the
ahead-of-time binary navigate faster, or only start faster?

**Answer: yes, on a directory big enough to notice — about twice as fast.**
Measured on the machine this was written on (Linux, 7.2 GB of RAM, a slow
box: the absolute numbers are worse than the runner's, the ratios are what
matters), in a directory with **12 000 files**. The app writes its own
timings to its debug log: `list` is the directory read plus the sort,
`build` is the layout and the paint of the grid. The binaries were driven
through a PTY (a plain pipe delivers no keys), and the numbers are medians of
three runs.

| build | first listing (boot) | navigation into a subdirectory |
| --- | --- | --- |
| **AOT (the shipping artifact)** | 62 ms list + 56 ms build | **59 ms list + 36 ms build = 96 ms** |
| JIT, same pipeline (JS API, same Bun) | 139 ms list + 150 ms build | 82 ms list + 113 ms build = 195 ms |
| JIT, stock Bun 1.4.4 (the fallback build) | 113 ms list + 136 ms build | 80 ms list + 133 ms build = 213 ms |

**The navigation rebuild is about twice as fast** — 86–96 ms against
192–213 ms, whichever JIT baseline is used. The effect does not depend on the
order the binaries run in (JIT first: 192 ms, AOT second: 86 ms), so it is not
a warm-up artifact.

Two caveats, both measured:

* **A small directory shows nothing.** With 100 files the navigation costs
  0–1 ms in *every* build — the difference is below the noise floor, and only
  the startup still separates them (344 ms vs 624 ms). The win is real when
  there is enough work to do.
* The JIT baselines are stock Bun **1.4.4**; v1.1.0 shipped 1.4.0.

### Where the win comes from — and where it does not

Two synthetic workloads, compiled the same way, five runs each:

| workload | JIT | AOT | |
| --- | --- | --- | --- |
| sort + regex filter + string formatting + JSON (200 000 items) | 101 ms | 94 ms | 1.07× |
| 12 000 items, six small helpers called per item (the shape of the grid build) | 42 ms | 24 ms | **1.75×** |

The pattern is the mechanism: the AOT binary is faster where the work is
**JavaScript the JIT would have had to compile at run time** — many small
functions, called many times — and it is a wash where the work is **already
native** (`Array.prototype.sort`, `RegExp.test`, `JSON.stringify`; the JIT
never compiled those either, they are C++ inside Bun).

tfm's grid build is the second shape: it asks a dozen small helpers (format
the size, format the date, take the extension, decide the icon) for every
entry in the directory, and then lays out a tile for each. That is the work
the AOT build does at machine-code speed.

## Correctness (all gates pass)

* the AOT executable boots and paints: 5/5 runs enter the alternate screen
  and complete the first full frame — for the plain, the trimmed and the lean
  build alike
* the 97 SVG icons are still embedded (99 embedded files), and tfm's own icon
  index resolves all 97 of them (an empty index would degrade every icon to a
  text glyph while the app still "looked fine")
* the resvg native addon loads in the AOT executable and rasterizes the same
  SVG to the same 174 bytes as the JIT baseline
* the AOT executable **refuses to load code from disk** (proved at run time:
  it writes a module and imports it; the AOT build refuses, the JIT control
  loads it) — there is no transpiler in it, in the trimmed build either
* the runtime features tfm leans on survive: file system, directory read,
  child process, PTY, timer, eval
* no crashes at teardown, the same number of kitty images drawn

## What does not survive

**A Worker started from an embedded file never answers in an AOT executable.**
Bun's docs are explicit: only an *entry point* of the build can run as a
worker, a file that is merely embedded cannot ("blocked by dynamic-import").
opentui's tree-sitter parser worker is exactly such a file, so the tree-sitter
preview of a file would hang in an AOT build. tfm does not use that worker
today (its preview is plain text), so nothing breaks today — but it is a
landmine for the first feature that wants it.

**Plugins are gone in the AOT build** (by design, see above).

**Nothing else was lost** — every runtime feature the app uses answers the
same way in the AOT build as in the JIT baseline.

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

## Five things that are not obvious

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
4. **The Bun has to be built with `--trimmable=on`**, and the flag is about
   Bun's *link*, not about tfm's build. A Bun without the trim table cannot
   trim, and it also makes the plain AOT build bigger than the JIT one — the
   size conclusion only holds with the right Bun.
5. **A compiled binary embeds the native library it loads — symbols and
   all.** `libopentui` is 28.5 MB with its debug symbols and 5.3 MB without
   them, and the binary ships whatever the staged file holds. That is 23 MB
   per binary, and it is invisible in the build log: the compile succeeds
   either way.

## The decision

**Go.** The release binary is compiled ahead of time:

* about the same size as v1.1.0: 53.2 MiB gzipped against 50.9 MiB
  (+2.4 MiB) — and 23 MB smaller than the same build without the debug
  symbols stripped
* faster: 302 ms to the first frame vs 475 ms for the JIT binary the
  release replaces (1.57×, measured on the release runner)
* faster after the first frame too: the navigation rebuild in a 12 000-file
  directory takes 96 ms against 213 ms for the fallback build (about 2×)
* the plugin loader is gated off, the code is still in the tree
* no transpiler in the binary, no code from disk, icons and the native
  rasterizer intact

The three caveats, and what each one costs:

* **Bun AOT is in no release yet** — it was merged into Bun's main, but no
  release carries it, so every release of tfm ships a Bun that the project
  pins itself, built from that commit with a pinned LLVM/Rust toolchain. The
  pin lives in `bun-aot.ref` next to the opentui fork's pin, the binary is
  cached by that pin, and the release workflow builds it from scratch when
  the pin moves.
* **Plugins do not work in an AOT build** — the plugin system is the first
  thing users will miss. The release notes say so, the README says so, and
  a build from source still has plugins.
* **A Worker from an embedded file cannot run** — the tree-sitter worker
  is exactly such a file. The code preview still works (as plain text, no
  syntax highlighting), and opentui's client gives up on the worker after
  10 s instead of hanging forever.

**The fallback**: if the AOT build fails on an architecture, that
architecture ships the JIT binary instead — built by the stock Bun, the build
that ships today, so nobody regresses. The unreleased AOT Bun is deliberately
NOT used for it: an unreleased runtime is the last thing to ship when
something already went wrong. The fallback is loud: a warning in the log,
a row in the release notes, and `dist/build-mode-<arch>.txt` in the
artifact. A release never breaks over an unreleased compiler.

**The tree-sitter worker**: the AOT preview is plain text. If a later
version wants highlighting back, the worker has to become an entry point
of the build (Bun runs an entry point as a worker) — a change in the
opentui fork, not in tfm.

## Reproducing

```sh
# the release path: build the binaries and gate them, without publishing
gh workflow run release.yml --ref main -f publish=false

# the experiment behind the numbers (hours; needs the pinned toolchain)
gh workflow run aot-experiment.yml --ref exp/aot-bun

# or reuse the bun of an earlier run (its artifact lives for 90 days)
gh workflow run aot-experiment.yml --ref exp/aot-bun \
  -f bun_run_id=40622551742 -f runs=5 -f lto=off

# the tfm side, with such a bun in hand
bun scripts/aot-build.ts aot  dist/tfm-aot        # the AOT executable
bun scripts/aot-build.ts jit  dist/tfm-jit        # the JIT baseline
bun scripts/aot-build.ts aot  dist/tfm-aot-trim --trim --explain-trim
bun scripts/aot-measure.ts dist/tfm-aot 5 aot     # boot it and measure
```

`scripts/aot-probe-assets.ts` asks a compiled binary for its embedded icons,
`scripts/aot-probe-disk-code.ts` asks it whether it can load code from disk,
`scripts/aot-probe-features.ts` asks it for the file system, a child process,
a PTY, a worker, a timer and `eval`, and `scripts/aot-probe-resvg.ts` asks
it whether the native rasterizer still works.
