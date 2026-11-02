# Bun AOT for tfm — evaluation

Status: shipped. The release workflow (`.github/workflows/release.yml`)
compiles tfm ahead of time for both architectures; this page is the
evaluation behind that decision — and behind the plugin gate that goes
with it.

Bun's ahead-of-time compiler (`bun build --compile --aot`) is in **no
released Bun yet** (latest: 1.4.4). It was merged into Bun's main, so
evaluating it means building that Bun from a pinned commit
(`4f7f658ed173fc23500de183b3713a8ddc18ba33`, which reports itself as
`1.4.4-canary.1+17faecf82`) first — about an hour on a GitHub runner,
and it needs a pinned LLVM, a pinned Rust nightly and the WebKit prebuilt
tarball.

The experiment: build that Bun, compile tfm with it, boot the result, and
compare it against a **JIT executable built by the same Bun** (so the two
differ in exactly one thing: whether the code was compiled ahead of time).

Everything below is measured by `.github/workflows/aot-experiment.yml`,
and the probes it runs are in `scripts/aot-probe-*.ts`.

**Result in one line: the AOT build reaches its first line of app code
about 7× faster than the JIT binary it replaces and paints its first
frame 1.6–2.6× faster (the runner and this box disagree; the ratio to
the first line of app code does not), and it is 12–18 MiB smaller
gzipped — and the "closed world" it was supposed to be is not closed: an
AOT build can load a plugin from disk anyway, because a Bun plugin that
*serves* the source bypasses the seal. The plugin gate is therefore a
policy, and it says so.**

## What had to change in tfm

One thing: the plugin loader. A plugin is a TypeScript file on disk that
the loader imports at run time. Whether the loader may run it depends on
what the **build opted in to**, not on whether the build asked for
ahead-of-time compilation:

| build | `tfm plugins` | `tfm plugins --help` |
| --- | --- | --- |
| JIT | lists the installed plugins (exit 0) | answers (exit 0) |
| AOT **without** `--aot-allow-code-from-disk` | `tfm: plugins are disabled in this build — it was not built with --aot-allow-code-from-disk (the build did not opt in to running code from disk)` (exit 1) | answers (exit 0) |
| AOT **with** `--aot-allow-code-from-disk` | lists the installed plugins (exit 0) | answers (exit 0) |

The gate is a bundler `define` pair (`__TFM_BUILD_AOT__` and
`__TFM_BUILD_AOT_DISK_CODE__`), so the disabled path folds to a constant
and is **never executed**. (The loader's own code is still *in* the
bundle: the AOT compiler keeps the dynamic import and warns about it —
`TS100064`, *"this import path isn't a constant … or build with
--aot-allow-code-from-disk"* — so "free of dead weight" means "the path
does not run", not "the bytes are gone".) The decision is a pure function
(`pluginsEnabledFor(aot, allowsCodeFromDisk)` in
`src/plugins/plugin-gate.ts`), pinned by `plugin-gate.test.ts`.

**The message is load-bearing.** It names the *flag* — "it was not built
with `--aot-allow-code-from-disk`" — and it must never say "this build
cannot load code from disk", because that is **not true**: see *The seal*
below. A sealed AOT build *can* load a plugin; the release build chooses
not to offer one, and says exactly that.

## The measurement

Two measurements of the same thing, both with 5 boots per binary and
medians, every variant built by the **same** AOT Bun
(`1.4.4-canary.1+17faecf82`, from the pinned commit
`4f7f658ed173fc23500de183b3713a8ddc18ba33`):

* **on a GitHub runner** (run `41446122109`, 2026-11-02) — the
  authoritative numbers, the ones the CI gates judge;
* **on the box this was written on** (Linux, 2 CPUs, 7.2 GiB of RAM, a
  loaded machine) — the numbers the probes below were developed against.

Every variant booted and painted 5/5 and crashed 0/5 times in both.

### On the GitHub runner (run `41446122109`)

| | JIT control | AOT | AOT `--trim` | AOT `--trim --no-function-source` | AOT +disk | AOT +disk `--trim` | AOT +disk `--trim --no-function-source` |
| --- | --- | --- | --- | --- | --- | --- | --- |
| gzip size | 71.9 MiB | 59.7 MiB | 54.1 MiB | **53.2 MiB** | 60.0 MiB | 54.9 MiB | 54.0 MiB |
| startup → first app code | 138 ms | **19 ms** | 19 ms | 19 ms | 22 ms | 20 ms | 19 ms |
| startup → renderer up | 162 ms | 41 ms | 41 ms | 41 ms | 41 ms | 41 ms | 41 ms |
| startup → first paint | 475 ms | 296 ms | 294 ms | **293 ms** | 297 ms | 294 ms | 293 ms |
| app-reported boot | 380 ms | 290 ms | 288 ms | 288 ms | 290 ms | 288 ms | 288 ms |
| RSS at first paint | 97 000 KB | 83 900 KB | 81 392 KB | 81 392 KB | 83 912 KB | 81 848 KB | 81 672 KB |
| kitty images drawn | 4 | 4 | 4 | 4 | 4 | 4 | 4 |
| crashes at teardown | 0 | 0 | 0 | 0 | 0 | 0 | 0 |

Read it as: **the AOT build reaches its first line of app code in 19 ms
against the JIT control's 138 ms (−86 %), and paints its first frame in
293–297 ms against 475 ms (−38 %).** The resident set at the first paint
is 13–15 MB smaller.

### On this box

| | JIT control | AOT | AOT `--trim` | AOT +disk | AOT +disk `--trim` | AOT +disk `--trim --no-function-source` |
| --- | --- | --- | --- | --- | --- | --- |
| gzip size | 71.9 MiB | 59.7 MiB | 54.1 MiB | 60.0 MiB | 54.9 MiB | **54.0 MiB** |
| raw size | 159.3 MiB | 137.4 MiB | 125.4 MiB | 137.8 MiB | 128.3 MiB | 124.6 MiB |
| startup → first app code | 351 ms | **49 ms** | 49 ms | 49 ms | 48 ms | 49 ms |
| startup → renderer up | 422 ms | 82 ms | 83 ms | 63 ms | 82 ms | 85 ms |
| startup → first paint | 972 ms | 378 ms | 374 ms | 375 ms | 369 ms | **372 ms** |
| app-reported boot | 754 ms | 362 ms | 362 ms | 363 ms | 356 ms | 360 ms |
| RSS at first paint | 81 096 KB | 67 804 KB | 67 612 KB | 68 092 KB | 67 500 KB | 66 468 KB |
| kitty images drawn | 4 | 4 | 4 | 4 | 4 | 4 |
| crashes at teardown | 0 | 0 | 0 | 0 | 0 | 0 |

Same read, a slower box: **49 ms against 351 ms to the first line of app
code (−86 %), and ~370 ms against ~970 ms to the first frame (−62 %).**
The percentages are what travel; the absolute times are the machine's.

Three caveats, all load-bearing:

* **The sizes are the same measurement on both machines** — same commit,
  same Bun, and the runner's gzip sizes agree with this box's to the
  MiB. The *times* are not comparable across machines: the runner is
  about twice as fast as this loaded box, which is why its first-paint
  delta (−38 %) is smaller than this box's (−62 %). Same ratio to the
  first line of app code (−86 %) on both.
* The **absolute sizes are not comparable with the 2026-10-28 table** that
  used to live here. tfm's source has moved since (the plugin gate, the
  OpenTUI fork bump, the paint-burst change), so both ends of the
  comparison moved. Only these tables' internal ratios are meaningful.
* The local table has no sealed `--no-function-source` variant: it was
  built and measured on the runner only (53.2 MiB gzip — the smallest
  sealed binary of the seven).

The JIT control is a **JIT binary built by the AOT Bun** — the
apples-to-apples comparison, where the only difference is whether the code
was compiled ahead of time; the stock Bun that ships today builds a
different (and bigger) JIT binary.

## What `--trim` costs and buys

`--trim` removes the Bun and Node.js APIs the program never calls; it
needs a Bun built with `--trimmable=on` (the trim table is baked in at
Bun's *link* time, so there is no way around it from the tfm side).
`--no-function-source` on top of it is worth ~0.8 MiB gzipped — noise.

**The old claim ("`--trim` is worth ~5.6 MiB") was measured on a sealed
build and is only true there.** Re-measured on both sides of the seal:

| | gzip | raw |
| --- | --- | --- |
| `--trim` on a **sealed** build (aot → aot-trim) | **5.64 MiB** | 11.96 MiB |
| `--trim` on an **open** build (aot+disk → aot+disk+trim) | **5.10 MiB** | 9.44 MiB |
| what survives | 90.4 % of the gzip win | 78.9 % of the raw win |
| the same, measured on the runner | **5.64 MiB** / 5.11 MiB | 11.96 MiB / 9.47 MiB |

So the trim win is real in both worlds, and an open build gives up about
a tenth of it.

The cost of the open seal itself (`--aot-allow-code-from-disk`):

| | gzip | raw |
| --- | --- | --- |
| plain AOT → AOT+disk | **+0.25 MiB** | +0.38 MiB |
| `--trim` AOT → `--trim` AOT+disk | **+0.79 MiB** | +2.89 MiB |
| the same, measured on the runner | **+0.25 MiB** / **+0.79 MiB** | +0.38 MiB / +2.86 MiB |

The flag is cheap: **under a megabyte gzipped**, and it costs nothing
measurable at boot (the first paint is 375 ms sealed against 375 ms open
on this box, 296 ms against 297 ms on the runner — the difference is
inside the noise of a loaded machine).

`--trim` does **not** take eval away from tfm. The trim report says so
explicitly: *"kept eval, new Function and the JavaScript interpreter
(interpreter)"* — the program can reach `eval`/`new Function`, so the
interpreter stays in the binary. The 5.6 MiB `--trim` saves is the
Bun/Node API surface, not the engine.

## What the plugin path costs

A plugin is not compiled ahead of time in an AOT build — **Bun
interprets it** (Bun's own words: *"`--aot-allow-code-from-disk`: a path
that is known only at run time may name a file with code that the build
has not seen. Bun interprets it."* — `src/options_types/aot_options.rs:87`).
The measurement is a tight numeric loop, run identically in the host
program (compiled into the binary) and in the plugin (loaded from disk):

| build | host loop | plugin loop | plugin vs host |
| --- | --- | --- | --- |
| JIT — this box | 24.7 ms | 25.0 ms | 1.01× |
| JIT — runner | 21.2 ms | 20.6 ms | 0.97× |
| AOT +disk — this box | 86.3 ms | 137.0 ms | **1.59×** |
| AOT +disk — runner | 51.4 ms | 68.9 ms | **1.34×** |
| AOT (sealed, plugin served by a Bun plugin) — this box | 88.4 ms | 137.8 ms | **1.56×** |
| AOT (sealed, plugin served by a Bun plugin) — runner | 50.7 ms | 69.1 ms | **1.36×** |

Two things to read here, and one to be careful about:

* **Plugin code is interpreted, and it does not tier up.** Repeated calls
  of a plugin function in an AOT build stay flat (140, 151, 146, 192,
  174, 152, 169, 137, 143, 164, 158, 131 ms), while the same function in
  the JIT build tiers up (31.8 → 24.4 ms). The plugin code is running in
  the interpreter, always.
* **The same plugin code is slower in an AOT build than in a JIT one**:
  **5.5× on this box** (137 ms against 25 ms for the identical loop),
  **3.3× on the runner** (69 ms against 21 ms). The ratio is the price
  of "plugins in a release binary": they work, and they are slow. The
  two machines disagree on how slow — the gap between an interpreted
  loop and a JIT-compiled one depends on the CPU — so quote the number
  with the machine it came from.
* Careful: for *this particular* loop, the AOT **host** code was also
  slower than the JIT host code (86 ms against 25 ms here, 51 ms against
  21 ms on the runner) — it is a float-to-uint conversion (`>>>` on a
  double) that the AOT compiler handles badly. So "plugin vs host" is a
  **within-build** ratio, and the honest cross-build statement is the
  5.5×/3.3× one above.

## Workers and tree-sitter

The old claim in this document was *"a Worker started from an embedded
file never answers in an AOT executable"* and *"the tree-sitter preview
of a file would hang in an AOT build"*. **Both were wrong**, and the
reason the first one was wrong is a bug in the probe, not in Bun.

Bun's AOT compiler **tracks the code a Worker runs** (`src/aot/load/
worker_files.rs:34`: *"Code that the program starts a Worker with: a file
that it embeds with the `file` loader, a file that it names by a path, or
a text that it holds"*), and it can follow the shapes listed at
`worker_files.rs:267` — `import path from "./worker.js" with { type:
"file" }; new Worker(path)`, `new Worker("./worker.js")`,
`new Worker("data:text/javascript,..")` — plus the dynamic form
`(await import("./worker.js", { with: { type: "file" } })).default`
(`worker_files.rs:1125`).

Measured matrix (`scripts/aot-probe-worker.ts`) — the runner
(run `41446122109`) answers the same in every cell:

| shape | JIT | AOT | AOT +disk |
| --- | --- | --- | --- |
| embedded file, static `with { type: "file" }` import | ok | **ok** | ok |
| embedded file, dynamic import | ok | **ok** | ok |
| entry point of the build, named by a literal path | ok | **ok** | ok |
| a file on disk the build never saw (computed path) | ok | **FAILED** | **FAILED** |
| Blob URL | ok | ok | ok |
| data: URL | ok | ok | ok |

The one that fails is the one that cannot work: a Worker started from a
path the build never saw is not in the image, and
`--aot-allow-code-from-disk` does **not** help it (the flag opens the
runtime's own disk-code path, not the worker-file table).

The first version of that probe loaded the fixture with a build-wide
`loader: { ".js": "file" }` and reached it through a `const` — a shape
the compiler cannot follow. That made the embedded-file case look broken
and produced the false claim this section now corrects. The probe now
uses the import attribute, which is the shape OpenTUI uses.

**The feature probe used to use that broken shape**, and it reported
`worker: FAILED` for the AOT build: `scripts/aot-probe-features.ts`
embedded its fixture through a build-wide `loader: { ".js": "file" }` map.
Measured side by side on this box (the same fixture, the same import
attribute; the only difference being the build-wide loader map):

| build | build-wide `.js → file` map | import attribute only |
| --- | --- | --- |
| JIT | worker ok | worker ok |
| AOT | **worker FAILED** | **worker ok** |

So the failure was a **shape the AOT compiler cannot follow**, not a limit
on Workers. The probe now uses the import attribute — and does not list
the fixture as an entry point either (a file that is *both* an entry
point and an embedded file loses its default export in a JIT build).
The workflow's worker difference is now a **gate**, not a tolerated
difference: a worker regression in an AOT build fails the build instead
of being explained away.

**OpenTUI's tree-sitter worker works in an AOT build.** It is the
embedded-file shape (`await import("./parser.worker.js", { with: { type:
"file" } })`), so the compiler tracks it. Measured with OpenTUI's own
client (`scripts/aot-probe-tree-sitter.ts`):

| build | client init (this box) | client init (runner) | highlight |
| --- | --- | --- | --- |
| JIT | ok (70 ms) | ok (22 ms) | ok (15 ranges) |
| AOT | **ok (22 ms)** | **ok (10 ms)** | **ok (15 ranges)** |
| AOT +disk | ok | ok (12 ms) | ok (15 ranges) |

The AOT build initializes the highlighter *faster* than the JIT one on
both machines (22 ms against 70 ms here, 10 ms against 22 ms on the
runner): the worker is compiled code there, while the JIT build has to
transpile it at run time.

## The seal: what it actually covers

This is the finding that changed the design, and it is worth stating
precisely, because the intuitive picture ("an AOT executable only runs
code that was compiled into it") is wrong in a way that matters.

**The seal is the runtime's own disk-code path — not a property of the
whole program.**

* The refusal lives in Bun's compiled-module loader:
  `createNotInExecutableError` (`src/jsc/bindings/BunCompiledModules.cpp:629-648`)
  raises *"Cannot load '…': it isn't in this executable, which only runs
  code that was compiled into it. Pass the file to bun compile as another
  entry point, or build with `--aot-allow-code-from-disk`."* It is
  reached through `errorIfCodeOutsideImageIsRefused` → `AOT::refusesCodeOutsideImage`
  (`:637-647`), and the flag flips it through
  `Bun__AOT__loadsCodeOutsideImage` → `ImageFlag::LoadsCodeOutsideImage`
  (`src/jsc/bindings/BunAOTRuntime.cpp:184-188`,
  `src/jsc/compiled_program.rs:140-143`). The build sets that flag from
  `options.loads_code_from_disk` (`src/aot/engine.rs:162-164`).
* **A Bun plugin that serves the source never goes through that path.**
  The runtime never reads the file — the plugin hands it over, and the
  runtime compiles what it is given. The AOT loader asks the plugins
  first (`src/aot/load/host.rs`: `plugins.read(...)` at `:347` and `:685`,
  `plugin_loader` at `:320`, `is_read_by_plugin` at `:693`;
  `src/aot/load/plugin_modules.rs` holds the plugin answers).
* **OpenTUI's runtime-module support is exactly such a plugin.** It
  registers a resolve hook for *every* specifier and a load hook that
  reads the file with `Bun.file(...).text()` and returns
  `{ contents, loader }` — `packages/core/src/runtime-plugin.ts:633-679`
  (the catch-all `onResolve`) and `:502-539` (`installRewriteLoader`).
* **tfm installs that plugin at boot**, in every build:
  `src/wiring/plugins.ts` calls `installPluginRuntimeSupport()` before
  the first plugin import (it is what lets a plugin import
  `@opentui/core` and share tfm's renderer).

Measured, all three builds, by `scripts/aot-probe-plugin-seal.ts`:

| | JIT | AOT (sealed) | AOT +disk |
| --- | --- | --- | --- |
| the runtime's own disk path | LOADED | **REFUSED** | LOADED |
| tfm's loader, nothing serving the source | ok | **FAILED** | ok |
| tfm's loader, once a plugin serves the source | ok | **ok** | ok |

So: **the sealed AOT build loads a plugin.** The gate is a policy — the
release build does not opt in to running code from disk, so it does not
offer plugins — and the message names the flag rather than claiming a
capability the binary does not lack.

(One more detail, for the record: the refusal is *per path*. A plugin
that serves **one** file does not open the disk to the program; what
bypasses the seal is the serving plugin's own answer, and a build that
installs no such plugin keeps the refusal.)

## The silent-fallback trap

**A Bun without the AOT compiler accepts `--aot` and ignores it.** The
build succeeds, the binary is a plain JIT binary, and it still loads code
from disk — so a project can believe it ships AOT while shipping JIT.
Measured with stock Bun 1.4.4: `bun build --compile --aot` exits 0,
produces a binary, and that binary **LOADS** a module it writes at run
time.

A grep of the build log cannot catch this (the compiler's finding about
a dynamic import mentions the flag the build does *not* use), so the
check has to be a run-time proof. `scripts/aot-build.ts` therefore builds
a tiny program that writes a module and imports it, and **refuses to
produce a binary** unless the probe answers `REFUSED` (`assertAotCompiler`).
The probe is built without `--aot-allow-code-from-disk` on purpose: the
flag lifts the seal, so a probe built with it could not tell an AOT
binary from a JIT one.

## Correctness

* the AOT executable boots and paints: 5/5 runs enter the alternate
  screen and complete the first full frame — for every variant
* the SVG icons are still embedded, and tfm's own icon index resolves
  them (an empty index would degrade every icon to a text glyph while the
  app still "looked fine")
* the resvg native addon loads in the AOT executable and rasterizes the
  same SVG to the same bytes as the JIT baseline
* the AOT executable **refuses to load code from disk on the runtime's
  own path** — proved at run time (it writes a module and imports it;
  the AOT build refuses, the JIT control loads it), in the plain **and**
  the trimmed build
* the tree-sitter worker (the preview pane's highlighter) starts and
  highlights in the AOT build
* no crashes at teardown, the same number of kitty images drawn

## What does not survive

* **A Worker started from a path the build never saw** (a file the
  program computes at run time) does not run in an AOT build — with or
  without `--aot-allow-code-from-disk`. A Worker from an *embedded* file
  or from an *entry point* of the build runs fine.
* **Plugin code is interpreted**, so it is ~5.5× slower than the same
  plugin in a JIT build on this box, ~3.3× on the runner.
* Nothing else was lost — every runtime feature the app uses answers the
  same way in the AOT build as in the JIT baseline.

## The decision

**Go.** The release binary is compiled ahead of time, trimmed:

* faster: **293–297 ms to the first frame against 475 ms** for the JIT
  binary the release replaces, on the GitHub runner (−38 %; on this box
  ~370 ms against ~970 ms, −62 % — the runner is faster in absolute
  terms, the ratios differ)
* faster to the first line of app code: **19 ms against 138 ms** on the
  runner (−86 %; 49 ms against 351 ms on this box — the same −86 %)
* smaller: 54.1 MiB gzipped against 71.9 MiB for the JIT control built
  by the same Bun (−17.1 MiB for the plugin-capable variant; the smallest
  sealed binary of the seven is 53.2 MiB)
* the plugin loader is gated off unless the build opts in with
  `--aot-allow-code-from-disk` — and the gate says why
* the tree-sitter highlighter, the icons and the native rasterizer are
  all intact

The three caveats, and what each one costs:

* **Bun AOT is in no release yet** — it was merged into Bun's main, but
  no release carries it, so every release of tfm ships a Bun that the
  project pins itself, built from that commit with a pinned
  LLVM/Rust toolchain. The pin lives in `bun-aot.ref`, the binary is
  cached by that pin, and the release workflow builds it from scratch
  when the pin moves.
* **Plugins do not work in the release build** — by policy. The release
  build is not given `--aot-allow-code-from-disk`, so tfm does not offer
  plugins; a build from source still has them.
* **Plugin code would be interpreted** even where it works, so it is
  ~5.5× slower than in a JIT build on this box (~3.3× on the runner).

**The fallback**: if the AOT build fails on an architecture, that
architecture ships the JIT binary instead — built by the stock Bun, the
build that ships today, so nobody regresses. The unreleased AOT Bun is
deliberately NOT used for it: an unreleased runtime is the last thing to
ship when something already went wrong. The fallback is loud: a warning
in the log, a row in the release notes, and `dist/build-mode-<arch>.txt`
in the artifact. A release never breaks over an unreleased compiler.

## Recommended build flags (for another Bun project)

The flags this evaluation supports, in the order they matter:

| flag | what it does | cost |
| --- | --- | --- |
| `--aot` | compiles the program ahead of time | the big startup win; needs a Bun with the AOT compiler |
| `--trim` | removes the Bun/Node APIs the program never calls | **−5.1 to −5.6 MiB** gzipped; needs a Bun built with `--trimmable=on` |
| `--no-function-source` | leaves function sources out of the binary | ~0.8 MiB gzipped — noise, but free |
| `--aot-allow-code-from-disk` | lets the binary load code the build never saw (interpreted) | **+0.25 MiB** gzipped plain, **+0.79 MiB** with `--trim` |

So: `--aot --trim --no-function-source` for a project that needs no
runtime plugins, and add `--aot-allow-code-from-disk` only if it must
load code from disk — and then measure the plugin path, because that
code runs interpreted.

## Reproducing

```sh
# the release path: build the binaries and gate them, without publishing
gh workflow run release.yml --ref main -f publish=false

# the experiment behind the numbers (hours; needs the pinned toolchain)
gh workflow run aot-experiment.yml --ref exp/aot-bun

# or reuse the bun of an earlier run (its artifact lives for 90 days) —
# this is how the numbers above were produced (run 41446122109)
gh workflow run aot-experiment.yml --ref feat/aot-plugins \
  -f bun_run_id=40633106092 -f runs=5 -f lto=off

# the tfm side, with such a bun in hand
bun scripts/aot-build.ts aot  dist/tfm-aot        # the AOT executable
bun scripts/aot-build.ts jit  dist/tfm-jit        # the JIT baseline
bun scripts/aot-build.ts aot  dist/tfm-aot-trim --trim --explain-trim
bun scripts/aot-build.ts aot-disk dist/tfm-aot-disk   # may load code from disk
bun scripts/aot-measure.ts dist/tfm-aot 5 aot     # boot it and measure
```

The probes:

* `scripts/aot-probe-assets.ts` — asks a compiled binary for its embedded
  icons
* `scripts/aot-probe-disk-code.ts` — asks it whether it can load code
  from disk on the runtime's own path
* `scripts/aot-probe-plugins.ts` — loads a real plugin through tfm's own
  loader with nothing serving the source (the raw seal), and measures the
  host-vs-plugin loop ratio
* `scripts/aot-probe-plugin-seal.ts` — measures what the seal actually
  covers: the runtime's own path, the loader with nothing serving the
  source, and the loader once a plugin serves it
* `scripts/aot-probe-worker.ts` — the worker matrix
* `scripts/aot-probe-tree-sitter.ts` — OpenTUI's tree-sitter client, asked
  to initialize and to highlight
* `scripts/aot-probe-features.ts` — the file system, a child process, a
  PTY, a worker, a timer and `eval`
* `scripts/aot-probe-resvg.ts` — the native rasterizer
