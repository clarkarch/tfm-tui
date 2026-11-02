// --- The program that does the asking: it is compiled INTO the executable and
// then loads a plugin FROM DISK through tfm's OWN loader.
//
//   bun scripts/aot-probe-plugins.ts <variant> [outfile]
//
// The question it answers: can a compiled tfm load and activate a real
// plugin from disk — and if it can, is the plugin's code compiled ahead of
// time or interpreted?
//
// It uses the REAL loader (src/plugins/plugins.ts), the REAL plugin shape
// (a folder with a `<name>/<name>.ts` file that default-exports
// { name, activate }) and the REAL staging path (the loader copies the
// folder into $XDG_CACHE_HOME/tfm/plugin-build and imports it from there).
// The loader is forced on (`enabled: true`) even in a build whose gate says
// off — the gate is tfm's POLICY (it follows the build's opt-in), this
// probe asks the RUNTIME what it can do.
//
// Nothing here serves the source: the import goes through the runtime's own
// disk-code path, which is what a sealed AOT build refuses.
//
// The plugin's own code runs a tight numeric loop and writes its timing to
// the file named by $PROBE_RESULT_FILE. The host program runs the SAME loop
// in its own (compiled-into-the-binary) code. The two numbers are the
// answer to "is plugin code JIT-compiled or interpreted": code that the
// runtime compiles ahead of time runs at the host's speed, code the runtime
// has to interpret does not.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { makePluginRegistry } from "../src/plugins/plugins";
import { AOT_ALLOWS_CODE_FROM_DISK, AOT_BUILD, PLUGINS_ENABLED } from "../src/plugins/plugin-gate";
import type { PluginApi } from "../src/plugins/plugin-api";

// the loop: identical in the host program and in the plugin. `n` and the seed
// come from the environment so neither the AOT compiler nor the JIT can
// constant-fold the loop away.
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

const sandbox = mkdtempSync(path.join(os.tmpdir(), "tfm-aot-plugin-probe-"));
const configHome = path.join(sandbox, "config");
process.env.XDG_CONFIG_HOME = configHome;
process.env.XDG_CACHE_HOME = path.join(sandbox, "cache");
const resultFile = path.join(sandbox, "plugin-result.txt");
process.env.PROBE_RESULT_FILE = resultFile;

console.log(`build mode: ${AOT_BUILD ? "aot" : "jit"}`);
console.log(`build allows code from disk: ${AOT_ALLOWS_CODE_FROM_DISK ? "yes" : "no"}`);
console.log(`plugin gate in this build: ${PLUGINS_ENABLED ? "enabled" : "disabled"}`);

// the plugin folder, in the shape tfm's loader expects:
//   <XDG_CONFIG_HOME>/tfm/plugins/<name>/<name>.ts
const pluginDir = path.join(configHome, "tfm", "plugins", "aot-probe-plugin");
mkdirSync(pluginDir, { recursive: true });
writeFileSync(
  path.join(pluginDir, "aot-probe-plugin.ts"),
  `// a real tfm plugin: TypeScript, default export, activate(api)
function hot(n: number, seed: number): number {
  let x = seed;
  for (let i = 0; i < n; i++) {
    x = (x + i * 3) % 1000003;
    x = (x ^ (x >>> 7)) + i;
  }
  return x;
}

export default {
  name: "aot-probe-plugin",
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
    api.notify("aot-probe-plugin activated");
    return { rows: [{ kind: "action", label: "aot-probe-plugin", run: () => {} }] };
  },
};
`,
);

// the api the loader hands to the plugin. Only the members the probe's
// plugin touches are real; the rest are inert stubs — the probe asks the
// loader to load a plugin, it does not run a file manager.
const logs: string[] = [];
const api = {
  notify: () => {},
  setStatusMsg: () => {},
  log: (m: string) => logs.push(m),
  store: () => ({
    get: () => undefined,
    set: () => {},
    delete: () => {},
    keys: () => [],
  }),
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

const registry = makePluginRegistry({
  dir: path.join(configHome, "tfm", "plugins"),
  api,
  warn: (m: string) => logs.push(`warn: ${m}`),
  // forced ON: the gate is tfm's POLICY (it follows the build's opt-in);
  // this probe asks the RUNTIME what it can do.
  enabled: true,
});

let diff: Awaited<ReturnType<typeof registry.scan>>;
try {
  diff = await registry.scan();
} catch (err) {
  console.log(`plugin load: FAILED — the scan threw: ${String((err as Error)?.message ?? err).slice(0, 200)}`);
  rmSync(sandbox, { recursive: true, force: true });
  process.exit(1);
}

const loaded = registry.plugins.find((p) => p.name === "aot-probe-plugin");
if (loaded) {
  console.log(`plugin load: ok (name=${loaded.name})`);
} else {
  const why = diff.errors[0] ?? "the loader recorded no plugin and no error";
  console.log(`plugin load: FAILED — ${why.slice(0, 240)}`);
}

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
