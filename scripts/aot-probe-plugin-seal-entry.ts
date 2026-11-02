// --- What does the AOT "seal" actually cover?
//
//   bun scripts/aot-probe-plugin-seal.ts <variant> [outfile]
//
// The question the plugin gate rests on: "an ahead-of-time build without
// --aot-allow-code-from-disk cannot load a plugin file from disk". The
// answer this probe gives is RUNTIME, and it is not what the question
// assumes:
//
//   * the refusal the AOT runtime raises ("it isn't in this executable")
//     belongs to the runtime's OWN disk-code path (Bun's
//     `createNotInExecutableError`, src/jsc/bindings/BunCompiledModules.cpp:
//     629-648);
//   * a Bun PLUGIN that serves the source itself (an onLoad that returns
//     the file's text) never goes through that path — the runtime never
//     reads the file, the plugin hands it over;
//   * OpenTUI's runtime-module support IS such a plugin: it installs a
//     resolve hook for EVERY specifier and a load hook for every source
//     path it resolves, and it reads the file with Bun.file().text().
//
// So the sealed build may load a plugin after all — through the plugin
// support tfm itself installs at boot (src/wiring/plugins.ts calls
// installPluginRuntimeSupport() before the first plugin import).
//
// The probe therefore measures THREE things, in this order (the runtime
// support is global once installed, so the first two must run before it):
//
//   1. the runtime's own disk path — a plain module imported from disk
//   2. tfm's own loader, with nothing serving the source
//   3. tfm's own loader, with OpenTUI's runtime plugin support installed
//
// It prints one line per answer:
//   runtime's own disk path: LOADED|REFUSED
//   plugin load (nothing serves the source): ok|FAILED
//   plugin load (a plugin serves the source): ok|FAILED

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { makePluginRegistry } from "../src/plugins/plugins";
import { installPluginRuntimeSupport } from "../src/ui/ui-plugin-runtime";
import { AOT_ALLOWS_CODE_FROM_DISK, AOT_BUILD } from "../src/plugins/plugin-gate";
import type { PluginApi } from "../src/plugins/plugin-api";

// the loop: identical in the host program and in the plugin. `n` and the
// seed come from the environment so neither the AOT compiler nor the JIT
// can constant-fold the loop away.
const N = Number(process.env.PROBE_N ?? "4000000");
const SEED = Number(process.env.PROBE_SEED ?? "12345");
const ROUNDS = Number(process.env.PROBE_ROUNDS ?? "7");

function hot(n: number, seed: number): number {
  let x = seed;
  for (let i = 0; i < n; i++) {
    x = (x + i * 3) % 1000003;
    x = (x ^ (x >>> 7)) + i;
  }
  return x;
}

function timeIt(fn: () => number, rounds: number): number {
  let best = Number.POSITIVE_INFINITY;
  for (let r = 0; r < rounds; r++) {
    const t0 = performance.now();
    const v = fn();
    const dt = performance.now() - t0;
    // the result is used, so the loop cannot be dropped
    if (v === -1) console.log("unreachable");
    if (dt < best) best = dt;
  }
  return best;
}

const sandbox = mkdtempSync(path.join(os.tmpdir(), "tfm-aot-seal-probe-"));
const configHome = path.join(sandbox, "config");
process.env.XDG_CONFIG_HOME = configHome;
process.env.XDG_CACHE_HOME = path.join(sandbox, "cache");
const resultFile = path.join(sandbox, "plugin-result.txt");
process.env.PROBE_RESULT_FILE = resultFile;

console.log(`build mode: ${AOT_BUILD ? "aot" : "jit"}`);
console.log(`build allows code from disk: ${AOT_ALLOWS_CODE_FROM_DISK ? "yes" : "no"}`);

// the api the loader hands to the plugin. Only the members the probe's
// plugin touches are real; the rest are inert stubs — the probe asks the
// loader to load a plugin, it does not run a file manager.
const logs: string[] = [];
const api = {
  notify: () => {},
  setStatusMsg: () => {},
  log: (m: string) => logs.push(m),
  store: () => ({ get: () => undefined, set: () => {}, delete: () => {}, keys: () => [] }),
  selection: () => [],
  cwd: () => sandbox,
  navigate: () => {},
  open: () => {},
  reveal: () => {},
  select: () => {},
  commands: () => [],
  ui: {
    pick: () => {},
    confirm: async () => false,
    prompt: async () => null,
    notifySticky: () => () => {},
  },
  events: { on: () => () => {} },
  hooks: { beforeFileOp: () => () => {} },
} as unknown as PluginApi;

// a plugin in the shape tfm's loader expects:
//   <XDG_CONFIG_HOME>/tfm/plugins/<name>/<name>.ts
const writePlugin = (name: string, withLoop: boolean): void => {
  const dir = path.join(configHome, "tfm", "plugins", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, `${name}.ts`),
    withLoop
      ? `function hot(n: number, seed: number): number {
  let x = seed;
  for (let i = 0; i < n; i++) {
    x = (x + i * 3) % 1000003;
    x = (x ^ (x >>> 7)) + i;
  }
  return x;
}

export default {
  name: ${JSON.stringify(name)},
  version: "0.0.1",
  activate(api: { notify(message: string, title?: string): void }) {
    const n = Number(process.env.PROBE_N ?? "4000000");
    const seed = Number(process.env.PROBE_SEED ?? "12345");
    const rounds = Number(process.env.PROBE_ROUNDS ?? "7");
    let best = Number.POSITIVE_INFINITY;
    let value = 0;
    for (let r = 0; r < rounds; r++) {
      const t0 = performance.now();
      value = hot(n, seed);
      const dt = performance.now() - t0;
      if (value === -1) console.log("unreachable");
      if (dt < best) best = dt;
    }
    require("node:fs").writeFileSync(process.env.PROBE_RESULT_FILE ?? "", String(best) + "\\n" + String(value) + "\\n");
    api.notify("activated");
    return { rows: [{ kind: "action", label: ${JSON.stringify(name)}, run: () => {} }] };
  },
};
`
      : `export default {
  name: ${JSON.stringify(name)},
  version: "0.0.1",
  activate(api: { notify(message: string, title?: string): void }) {
    api.notify("activated");
    return { rows: [{ kind: "action", label: ${JSON.stringify(name)}, run: () => {} }] };
  },
};
`,
  );
};

// load a plugin through tfm's OWN loader (forced on: the gate is tfm's
// POLICY, this asks the RUNTIME what it can do)
const loadPlugin = async (name: string): Promise<string> => {
  const registry = makePluginRegistry({
    dir: path.join(configHome, "tfm", "plugins"),
    api,
    warn: (m: string) => logs.push(`warn: ${m}`),
    enabled: true,
  });
  let diff: Awaited<ReturnType<typeof registry.scan>>;
  try {
    diff = await registry.scan();
  } catch (err) {
    return `FAILED — the scan threw: ${String((err as Error)?.message ?? err).slice(0, 200)}`;
  }
  const loaded = registry.plugins.find((p) => p.name === name);
  if (loaded) return "ok";
  const why = diff.errors[0] ?? "the loader recorded no plugin and no error";
  return `FAILED — ${why.slice(0, 240)}`;
};

// 1. the runtime's OWN disk path: the control. Nothing serves this file.
const plainFile = path.join(sandbox, "plain-module.ts");
writeFileSync(plainFile, "export const x: number = 42;\n");
try {
  const specifier = [Bun.pathToFileURL(plainFile).href].join("");
  const m = await import(specifier);
  console.log(`runtime's own disk path: LOADED (${String(m.x)})`);
} catch (err) {
  console.log(`runtime's own disk path: REFUSED (${String((err as Error)?.message ?? err).slice(0, 140)})`);
}

// 2. tfm's loader, with nothing serving the source.
writePlugin("seal-probe-unserved", false);
console.log(`plugin load (nothing serves the source): ${await loadPlugin("seal-probe-unserved")}`);

// 3. the app's own boot step: install OpenTUI's runtime plugin support.
//    From here on the runtime asks the plugin for every specifier, and the
//    plugin serves the source itself.
const support = installPluginRuntimeSupport();
console.log(`runtime plugin support installed: ${support}`);

writePlugin("seal-probe-served", true);
console.log(`plugin load (a plugin serves the source): ${await loadPlugin("seal-probe-served")}`);

// the plugin's own code: how fast is it, compared with the same code
// compiled into this executable?
const hostMs = timeIt(() => hot(N, SEED), ROUNDS);
console.log(`host loop: ${hostMs.toFixed(2)}ms`);
let pluginMs: number | null = null;
try {
  const raw = readFileSync(resultFile, "utf8").trim().split("\n");
  pluginMs = Number(raw[0]);
} catch {
  // the plugin never ran (the load failed) — the ratio is undefined
}
if (pluginMs === null || !Number.isFinite(pluginMs)) {
  console.log("plugin loop: not measured (the plugin never ran)");
} else {
  console.log(`plugin loop: ${pluginMs.toFixed(2)}ms`);
  console.log(`plugin loop vs host loop: ${(pluginMs / hostMs).toFixed(2)}x`);
}

for (const l of logs) console.log(`loader log: ${l}`);
rmSync(sandbox, { recursive: true, force: true });
