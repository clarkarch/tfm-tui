import { afterAll, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  renameSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  copyStagedPlugin,
  hashPluginFolder,
  makePluginRegistry,
  makePluginStore,
  pluginBuildDir,
  pluginsDir,
} from "./plugins";
import type { LoadedPlugin, PluginApi } from "./plugin-api";

// Loader contract: each *.ts file in the plugins dir contributes its
// activate(api) rows; a broken plugin is isolated (recorded + warned, never
// fatal); non-.ts entries are ignored; per-plugin JSON state round-trips.
// Fixture dirs are per-test mkdtemp (never the real ~/.config) — and distinct
// paths defeat Bun's module cache across tests.

// staged builds must never leak into the real ~/.cache (same rule as the
// icons raster tests) — one file-level sandbox, restored afterwards.
const cacheSandbox = mkdtempSync(path.join(os.tmpdir(), "tfm-plugins-cache-"));
const prevCacheHome = process.env.XDG_CACHE_HOME;
process.env.XDG_CACHE_HOME = cacheSandbox;
afterAll(() => {
  if (prevCacheHome === undefined) delete process.env.XDG_CACHE_HOME;
  else process.env.XDG_CACHE_HOME = prevCacheHome;
  rmSync(cacheSandbox, { recursive: true, force: true });
});

const loadPlugins = async (deps: {
  dir: string;
  api: PluginApi;
  warn(message: string): void;
}): Promise<{ plugins: LoadedPlugin[]; errors: string[] }> => {
  const reg = makePluginRegistry(deps);
  await reg.scan();
  return { plugins: [...reg.plugins], errors: [...reg.errors] };
};

const mkApi = (dir: string, notes: string[]): PluginApi => ({
  notify: (message) => {
    notes.push(message);
  },
  setStatusMsg: () => {},
  log: (message) => {
    notes.push(message);
  },
  store: (name) => makePluginStore(dir, name),
  selection: () => [],
  cwd: () => "/home/u",
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
});

const mkDir = (): string => mkdtempSync(path.join(os.tmpdir(), "tfm-plugins-test-"));

const writePlugin = (dir: string, file: string, body: string): void => {
  writeFileSync(path.join(dir, file), body);
};

const GOOD_A = `export default { name: "aaa", activate: (api) => ({ rows: [{ kind: "action", label: "hi-a", run: () => api.notify("hi-a") }] }) };\n`;
const GOOD_B = `export default { name: "bbb", activate: () => ({ rows: [{ kind: "toggle", label: "tog-b", get: () => false, set: () => {} }] }) };\n`;

describe("loadPlugins", () => {
  test("aggregates per plugin in file order (identity kept for categories)", async () => {
    // per-plugin shape (not flat rows): the model renders one category per
    // plugin plus its on/off toggle — identity must survive the loader
    const dir = mkDir();
    try {
      writePlugin(dir, "aaa.ts", GOOD_A);
      writePlugin(dir, "bbb.ts", GOOD_B);
      const notes: string[] = [];
      const { plugins, errors } = await loadPlugins({ dir, api: mkApi(dir, notes), warn: (m) => notes.push(m) });
      expect(errors).toEqual([]);
      expect(plugins.map((p) => p.name)).toEqual(["aaa", "bbb"]);
      expect(plugins[0]!.rows.map((r) => r.label)).toEqual(["hi-a"]);
      expect(plugins[1]!.rows.map((r) => r.label)).toEqual(["tog-b"]);
      // the row is live: running it calls the plugin's closure through api
      const action = plugins[0]!.rows[0]!;
      if (action.kind !== "action") throw new Error("expected action row");
      action.run();
      expect(notes).toContain("hi-a");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a throwing plugin is isolated; the rest still load", async () => {
    const dir = mkDir();
    try {
      writePlugin(dir, "aaa.ts", GOOD_A);
      writePlugin(dir, "bad.ts", `export default { name: "bad", activate: () => { throw new Error("boom"); } };\n`);
      writePlugin(dir, "shapeless.ts", `export default { name: "shapeless" };\n`);
      const notes: string[] = [];
      const warns: string[] = [];
      const { plugins, errors } = await loadPlugins({ dir, api: mkApi(dir, notes), warn: (m) => warns.push(m) });
      expect(plugins.map((p) => p.name)).toEqual(["aaa"]);
      expect(errors.length).toBe(2);
      expect(warns.length).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("duplicate plugin names: first wins, later file skipped with an error", async () => {
    const dir = mkDir();
    try {
      writePlugin(dir, "aaa.ts", GOOD_A);
      writePlugin(dir, "zzz.ts", `export default { name: "aaa", activate: () => ({ rows: [] }) };\n`);
      const notes: string[] = [];
      const warns: string[] = [];
      const { plugins, errors } = await loadPlugins({ dir, api: mkApi(dir, notes), warn: (m) => warns.push(m) });
      expect(plugins.map((p) => p.name)).toEqual(["aaa"]);
      expect(plugins[0]!.rows.map((r) => r.label)).toEqual(["hi-a"]);
      expect(errors.length).toBe(1);
      expect(warns.length).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  test("an invalid rows shape after activate tears the plugin down (no leaked listeners)", async () => {
    const dir = mkDir();
    try {
      // activate subscribes, then returns a malformed rows value; the loader
      // must run deactivate or the listener leaks forever (the plugin never
      // reaches `plugins`, so deactivateAll can't see it)
      writePlugin(
        dir,
        "leaky.ts",
        `export default { name: "leaky", activate: (api) => ({
           deactivate: () => api.notify("leaky-deactivated"),
           rows: "nope",
         }) };\n`,
      );
      const notes: string[] = [];
      const { plugins, errors } = await loadPlugins({ dir, api: mkApi(dir, notes), warn: (m) => notes.push(m) });
      expect(plugins).toEqual([]);
      expect(errors.some((e) => e.includes("rows must be an array"))).toBe(true);
      expect(notes).toContain("leaky-deactivated");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a disabled plugin receives no events and cannot veto (live, no restart)", async () => {
    const dir = mkDir();
    try {
      const eventCbs: Array<(p: unknown) => void> = [];
      const hooks: Array<(p: unknown) => unknown> = [];
      const notes: string[] = [];
      const base = mkApi(dir, notes);
      const api: PluginApi = {
        ...base,
        events: {
          on: (_evt, cb) => {
            eventCbs.push(cb as (p: unknown) => void);
            return () => {};
          },
        },
        hooks: {
          beforeFileOp: (fn) => {
            hooks.push(fn as (p: unknown) => unknown);
            return () => {};
          },
        },
      };
      writePlugin(
        dir,
        "gated.ts",
        `export default { name: "gated", activate: (api) => {
           api.events.on("quit", () => api.notify("gated-event"));
           api.hooks.beforeFileOp(() => ({ skip: true, reason: "gated-veto" }));
           return { rows: [] };
         } };\n`,
      );
      const { plugins } = await loadPlugins({ dir, api, warn: (m) => notes.push(m) });
      expect(plugins.map((p) => p.name)).toEqual(["gated"]);
      const p = plugins[0]!;

      // enabled: the push fires and the veto blocks
      eventCbs[0]!({});
      expect(notes).toContain("gated-event");
      expect(hooks[0]!({ op: "trash", paths: [] })).toEqual({ skip: true, reason: "gated-veto" });

      // toggled off in the Plugins view: both channels go quiet immediately
      p.store.set("enabled", false);
      eventCbs[0]!({});
      expect(notes.filter((n) => n === "gated-event").length).toBe(1);
      expect(hooks[0]!({ op: "trash", paths: [] })).toBeUndefined();

      // re-enable restores them (live read, no restart)
      p.store.set("enabled", true);
      eventCbs[0]!({});
      expect(notes.filter((n) => n === "gated-event").length).toBe(2);
      expect(hooks[0]!({ op: "trash", paths: [] })).toEqual({ skip: true, reason: "gated-veto" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("concurrent scans share one in-flight pass (no duplicate load)", async () => {
    // reloadPlugins fires from esc-menu open AND from install/update/remove;
    // overlapping rescans could both pass the prev check and double-load
    const dir = mkDir();
    try {
      writePlugin(dir, "aaa.ts", GOOD_A);
      const notes: string[] = [];
      const reg = makePluginRegistry({ dir, api: mkApi(dir, notes), warn: (m) => notes.push(m) });
      const p1 = reg.scan();
      const p2 = reg.scan();
      expect(p1).toBe(p2);
      await p1;
      expect(reg.plugins.map((p) => p.name)).toEqual(["aaa"]);
      expect(reg.scan()).not.toBe(p1);
      await reg.scan();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("each loaded plugin carries a working store", async () => {
    const dir = mkDir();
    try {
      writePlugin(dir, "aaa.ts", GOOD_A);
      const notes: string[] = [];
      const { plugins } = await loadPlugins({ dir, api: mkApi(dir, notes), warn: () => {} });
      const store = plugins[0]!.store;
      expect(store.get("k", 0)).toBe(0);
      store.set("k", 7);
      expect(makePluginStore(dir, "aaa").get("k", 0)).toBe(7);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("duplicate-name loser never activates (no leaked listeners/timers/slots)", async () => {
    const dir = mkDir();
    try {
      writePlugin(
        dir,
        "aaa.ts",
        `export default { name: "dup", activate: () => ({ slots: { statusbar: () => ({}) } }) };\n`,
      );
      writePlugin(
        dir,
        "zzz.ts",
        `export default { name: "dup", activate: () => ({ slots: { statusbar: () => ({}) } }) };\n`,
      );
      const notes: string[] = [];
      const registered: string[] = [];
      const reg = makePluginRegistry({
        dir,
        api: mkApi(dir, notes),
        warn: () => {},
        registerSlots: (name) => {
          registered.push(name);
          return () => {};
        },
      });
      await reg.scan();
      // slot registration happens INSIDE loadOne after activate — the
      // pre-flight duplicate check must trip before that, or the loser's slots
      // (and listeners/timers) are live forever
      expect(registered).toEqual(["dup"]);
      expect(reg.plugins.map((p) => p.name)).toEqual(["dup"]);
      expect(reg.errors.length).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a renamed plugin folder loads on the SAME rescan (no false duplicate error)", async () => {
    const dir = mkDir();
    try {
      mkdirSync(path.join(dir, "old"));
      writePlugin(path.join(dir, "old"), "old.ts", GOOD_A);
      const notes: string[] = [];
      const warns: string[] = [];
      const reg = makePluginRegistry({ dir, api: mkApi(dir, notes), warn: (m) => warns.push(m) });
      await reg.scan();
      expect(reg.plugins.map((p) => p.name)).toEqual(["aaa"]);
      // rename the folder AND its main file -> the old path is removed and the
      // new one loads; removals-first ordering means the duplicate check no
      // longer trips on the plugin's own previous name
      renameSync(path.join(dir, "old"), path.join(dir, "new"));
      renameSync(path.join(dir, "new", "old.ts"), path.join(dir, "new", "new.ts"));
      await reg.scan();
      expect(warns).toEqual([]);
      expect(reg.plugins.map((p) => p.name)).toEqual(["aaa"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("malformed settings rows drop individually; the plugin still loads", async () => {
    const dir = mkDir();
    try {
      writePlugin(
        dir,
        "rows.ts",
        `export default {
          name: "rows",
          activate: () => ({
            rows: [
              { kind: "toggle", label: "good", get: () => false, set: () => {} },
              { kind: "toggle", label: "missing-setters" },
              { kind: "stepper", label: "bad-stepper", get: () => 1, set: () => {} },
              { kind: "nope", label: "unknown-kind" },
            ],
          }),
        };\n`,
      );
      const notes: string[] = [];
      const { plugins, errors } = await loadPlugins({ dir, api: mkApi(dir, notes), warn: () => {} });
      expect(errors).toEqual([]);
      expect(plugins.map((p) => p.name)).toEqual(["rows"]);
      expect(plugins[0]!.rows.map((r) => r.label)).toEqual(["good"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("fileMenu builders are collected per plugin", async () => {
    const dir = mkDir();
    try {
      writePlugin(
        dir,
        "aaa.ts",
        `export default { name: "aaa", activate: () => ({ fileMenu: (sel) => [{ label: "Inspect", run: (paths) => {} }] }) };\n`,
      );
      const notes: string[] = [];
      const { plugins, errors } = await loadPlugins({ dir, api: mkApi(dir, notes), warn: () => {} });
      expect(errors).toEqual([]);
      expect(typeof plugins[0]!.fileMenu).toBe("function");
      expect(plugins[0]!.fileMenu!({ paths: ["/a"] }).map((e) => e.label)).toEqual(["Inspect"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a non-function fileMenu skips the plugin with an error", async () => {
    const dir = mkDir();
    try {
      writePlugin(dir, "aaa.ts", GOOD_A);
      writePlugin(dir, "bad.ts", `export default { name: "bad", activate: () => ({ fileMenu: "nope" }) };\n`);
      const warns: string[] = [];
      const { plugins, errors } = await loadPlugins({ dir, api: mkApi(dir, []), warn: (m) => warns.push(m) });
      expect(plugins.map((p) => p.name)).toEqual(["aaa"]);
      expect(errors.length).toBe(1);
      expect(warns.length).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("ignores non-ts files, directories and empty dirs", async () => {
    const dir = mkDir();
    try {
      writePlugin(dir, "notes.txt", "not a plugin");
      writePlugin(dir, "data.json", "{}");
      const notes: string[] = [];
      const { plugins, errors } = await loadPlugins({ dir, api: mkApi(dir, notes), warn: () => {} });
      expect(plugins).toEqual([]);
      expect(errors).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("missing dir loads nothing (first run has no plugins yet)", async () => {
    const dir = path.join(mkdtempSync(path.join(os.tmpdir(), "tfm-plugins-parent-")), "no-such-dir");
    const notes: string[] = [];
    const { plugins, errors } = await loadPlugins({ dir, api: mkApi(dir, notes), warn: () => {} });
    expect(plugins).toEqual([]);
    expect(errors).toEqual([]);
  });

  // The AOT build gates the loader off: an ahead-of-time executable may only
  // run code that was compiled INTO it, so a plugin file on disk must never
  // be imported. The module-level side effect is the observable — it proves
  // the file was never IMPORTED, not merely never activated.
  test("a disabled registry never imports a plugin file", async () => {
    const dir = mkDir();
    (globalThis as unknown as { __tfmPluginImported: boolean }).__tfmPluginImported = false;
    try {
      writePlugin(
        dir,
        "aaa.ts",
        `globalThis.__tfmPluginImported = true;\nexport default { name: "aaa", activate: () => ({ rows: [] }) };\n`,
      );
      const notes: string[] = [];
      const reg = makePluginRegistry({
        dir,
        api: mkApi(dir, notes),
        warn: (m) => notes.push(m),
        enabled: false,
      });
      const diff = await reg.scan();
      expect(diff).toEqual({ added: [], removed: [], changed: [], errors: [] });
      expect(reg.plugins).toEqual([]);
      expect((globalThis as unknown as { __tfmPluginImported: boolean }).__tfmPluginImported).toBe(false);
      // a rescan stays empty — the gate is not a one-shot
      await reg.scan();
      expect(reg.plugins).toEqual([]);
    } finally {
      delete (globalThis as unknown as { __tfmPluginImported?: boolean }).__tfmPluginImported;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("makePluginStore", () => {
  // state lives INSIDE the plugin folder (plugins/<name>/state.json) so a
  // plugin is one self-contained directory — moved here intentionally when
  // folders became the layout (the old flat plugins/<name>.json migrates).
  const stateFile = (dir: string, name: string): string => path.join(dir, name, "state.json");

  test("set/get round-trips through the plugin's JSON file", () => {
    const dir = mkDir();
    try {
      const store = makePluginStore(dir, "hello");
      expect(store.get("enthusiastic", false)).toBe(false);
      store.set("enthusiastic", true);
      expect(store.get("enthusiastic", false)).toBe(true);
      expect(JSON.parse(readFileSync(stateFile(dir, "hello"), "utf8"))).toEqual({ enthusiastic: true });
      // a fresh handle sees the same file
      expect(makePluginStore(dir, "hello").get("enthusiastic", false)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("corrupt JSON falls back instead of throwing", () => {
    const dir = mkDir();
    try {
      mkdirSync(path.join(dir, "hello"), { recursive: true });
      writeFileSync(stateFile(dir, "hello"), "{oops");
      const store = makePluginStore(dir, "hello");
      expect(store.get("k", 42)).toBe(42);
      expect(() => store.set("k", 1)).not.toThrow();
      expect(store.get("k", 42)).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("unsafe plugin names are rejected (no path escape)", () => {
    const dir = mkDir();
    try {
      for (const bad of ["../evil", "a/b", "", ".", ".."]) {
        expect(() => makePluginStore(dir, bad)).toThrow();
      }
      expect(existsSync(path.join(dir, "evil.json"))).toBe(false);
      expect(existsSync(path.join(dir, "evil"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a deleted state file resets to fallbacks (no restart needed)", () => {
    const dir = mkDir();
    try {
      const store = makePluginStore(dir, "hello");
      store.set("k", 1);
      expect(store.get("k", 42)).toBe(1);
      rmSync(stateFile(dir, "hello"));
      expect(store.get("k", 42)).toBe(42);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an externally rewritten state file is picked up (mtime check)", () => {
    const dir = mkDir();
    try {
      const store = makePluginStore(dir, "hello");
      store.set("k", 1);
      // force a distinct mtime (same-ms writes would compare equal)
      const t = Date.now() - 5000;
      writeFileSync(stateFile(dir, "hello"), JSON.stringify({ k: 2 }));
      utimesSync(stateFile(dir, "hello"), new Date(t), new Date(t));
      expect(store.get("k", 42)).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a failed stat after a write does not serve a stale cache", () => {
    // The write's post-rename stat failed → the cached mtime still said
    // "missing" (the old shape's -1 sentinel doubled as a timestamp) → a
    // later DELETION of the state file was invisible and the stale cache
    // was served.
    const dir = mkDir();
    try {
      let statFails = false;
      const store = makePluginStore(dir, "hello", {
        stat: (f) => {
          if (statFails) throw Object.assign(new Error("stat-boom"), { code: "EIO" });
          return statSync(f).mtimeMs;
        },
      });
      // the file does not exist yet — the cached mtime is the "missing" marker
      expect(store.get("k", 42)).toBe(42);
      // a write whose post-rename stat fails
      statFails = true;
      store.set("k", 1);
      expect(JSON.parse(readFileSync(stateFile(dir, "hello"), "utf8"))).toEqual({ k: 1 });
      statFails = false;
      // the state file is gone → the store must reset, not serve the stale cache
      rmSync(stateFile(dir, "hello"));
      expect(store.get("k", 42)).toBe(42);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a stat failure does not wipe the cached state", () => {
    // The old shape read a failed stat as "missing" and replaced the cache
    // with {} — the next write then persisted a TRUNCATED state (every other
    // key was lost).
    const dir = mkDir();
    try {
      let statFails = false;
      const store = makePluginStore(dir, "hello", {
        stat: (f) => {
          if (statFails) throw Object.assign(new Error("stat-boom"), { code: "EIO" });
          return statSync(f).mtimeMs;
        },
      });
      store.set("a", 1);
      statFails = true;
      store.set("b", 2);
      statFails = false;
      expect(JSON.parse(readFileSync(stateFile(dir, "hello"), "utf8"))).toEqual({ a: 1, b: 2 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a store whose first probe fails refuses to write (a silent truncation is worse)", () => {
    // We do not know what the file holds, so persisting a view of it would
    // TRUNCATE it. The old shape read the failed probe as "missing" and
    // wrote an empty state over the file.
    const dir = mkDir();
    try {
      const store = makePluginStore(dir, "hello", {
        stat: () => {
          throw Object.assign(new Error("stat-boom"), { code: "EIO" });
        },
      });
      // the read degrades to the fallback …
      expect(store.get("k", 42)).toBe(42);
      // … and the write refuses instead of truncating (the refusal is
      // DELIBERATE — a legible error, not an incidental crash)
      expect(() => store.set("k", 1)).toThrow(/unreadable/);
      expect(existsSync(stateFile(dir, "hello"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a write whose post-write probe failed keeps what it wrote", () => {
    // The write landed; only the STAMP is unknown. The store must not
    // forget what it wrote: the contents are ours, so a read serves them.
    // (The old shape kept a stamp it never learned — the "-1 missing"
    // sentinel — and the next read served a cache that no longer matched
    // the file.)
    const dir = mkDir();
    try {
      let statFails = false;
      const store = makePluginStore(dir, "hello", {
        stat: (f) => {
          if (statFails) throw Object.assign(new Error("stat-boom"), { code: "EIO" });
          return statSync(f).mtimeMs;
        },
      });
      store.set("a", 1);
      // now every probe fails — the write lands, the stamp does not
      statFails = true;
      store.set("b", 2);
      expect(JSON.parse(readFileSync(stateFile(dir, "hello"), "utf8"))).toEqual({ a: 1, b: 2 });
      // the contents are ours even though the stamp is unknown
      expect(store.get("a", 0)).toBe(1);
      expect(store.get("b", 0)).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("legacy flat state migrates into the folder (content preserved)", () => {
    const dir = mkDir();
    try {
      writeFileSync(path.join(dir, "hello.json"), JSON.stringify({ k: 9 }));
      const store = makePluginStore(dir, "hello");
      expect(store.get("k", 42)).toBe(9);
      expect(existsSync(stateFile(dir, "hello"))).toBe(true);
      expect(existsSync(path.join(dir, "hello.json"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("pluginsDir", () => {
  test("honors XDG_CONFIG_HOME (sandboxable), defaults under home", () => {
    const prev = process.env.XDG_CONFIG_HOME;
    try {
      const sandbox = mkdtempSync(path.join(os.tmpdir(), "tfm-xdg-"));
      process.env.XDG_CONFIG_HOME = sandbox;
      expect(pluginsDir()).toBe(path.join(sandbox, "tfm", "plugins"));
      rmSync(sandbox, { recursive: true, force: true });
    } finally {
      if (prev === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = prev;
    }
    expect(pluginsDir().endsWith(path.join("tfm", "plugins"))).toBe(true);
  });
});
describe("plugin commands", () => {
  test("commands are collected per plugin; malformed ones drop, plugin stays", async () => {
    const dir = mkDir();
    try {
      writePlugin(
        dir,
        "aaa.ts",
        `export default { name: "aaa", activate: () => ({ commands: [{ id: "aaa:hi", title: "Say hi", run: () => {} }, { id: "aaa:bad" }] }) };\n`,
      );
      const notes: string[] = [];
      const { plugins, errors } = await loadPlugins({ dir, api: mkApi(dir, notes), warn: () => {} });
      expect(errors).toEqual([]);
      expect(plugins[0]!.commands.map((c) => c.id)).toEqual(["aaa:hi"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("folder layout", () => {
  const writeFolderPlugin = (dir: string, name: string, body: string): void => {
    mkdirSync(path.join(dir, name), { recursive: true });
    writeFileSync(path.join(dir, name, `${name}.ts`), body);
  };

  test("a plugin folder loads by its matching main file", async () => {
    const dir = mkDir();
    try {
      writeFolderPlugin(dir, "aaa", GOOD_A);
      const notes: string[] = [];
      const { plugins, errors } = await loadPlugins({ dir, api: mkApi(dir, notes), warn: () => {} });
      expect(errors).toEqual([]);
      expect(plugins.map((p) => p.name)).toEqual(["aaa"]);
      expect(plugins[0]!.rows.map((r) => r.label)).toEqual(["hi-a"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("legacy flat files auto-migrate into folders (logged, not warned)", async () => {
    const dir = mkDir();
    try {
      writePlugin(dir, "aaa.ts", GOOD_A);
      const notes: string[] = [];
      const { plugins, errors } = await loadPlugins({ dir, api: mkApi(dir, notes), warn: () => {} });
      expect(errors).toEqual([]);
      expect(plugins.map((p) => p.name)).toEqual(["aaa"]);
      expect(existsSync(path.join(dir, "aaa", "aaa.ts"))).toBe(true);
      expect(existsSync(path.join(dir, "aaa.ts"))).toBe(false);
      expect(notes.some((n) => n.includes("moved"))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a folder without its main file is skipped with a warning", async () => {
    const dir = mkDir();
    try {
      mkdirSync(path.join(dir, "empty"));
      writeFolderPlugin(dir, "aaa", GOOD_A);
      const warns: string[] = [];
      const { plugins, errors } = await loadPlugins({ dir, api: mkApi(dir, []), warn: (m) => warns.push(m) });
      expect(plugins.map((p) => p.name)).toEqual(["aaa"]);
      expect(errors).toEqual([]);
      expect(warns.length).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a folder shadows a same-named flat file (flat skipped, warned)", async () => {
    const dir = mkDir();
    try {
      writePlugin(dir, "aaa.ts", GOOD_B);
      writeFolderPlugin(dir, "aaa", GOOD_A);
      const warns: string[] = [];
      const { plugins } = await loadPlugins({ dir, api: mkApi(dir, []), warn: (m) => warns.push(m) });
      expect(plugins.map((p) => p.name)).toEqual(["aaa"]);
      expect(plugins[0]!.rows.map((r) => r.label)).toEqual(["hi-a"]); // folder version won
      expect(warns.length).toBe(1);
      expect(existsSync(path.join(dir, "aaa.ts"))).toBe(true); // untouched, not migrated
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("registry reload (no restart for add/remove)", () => {
  const writeFolderPlugin = (dir: string, name: string, body: string): void => {
    mkdirSync(path.join(dir, name), { recursive: true });
    writeFileSync(path.join(dir, name, `${name}.ts`), body);
  };

  test("added folders appear, deleted ones drop, untouched ones keep identity", async () => {
    const dir = mkDir();
    try {
      writeFolderPlugin(dir, "aaa", GOOD_A);
      const reg = makePluginRegistry({ dir, api: mkApi(dir, []), warn: () => {} });
      const first = await reg.scan();
      expect(first.added).toEqual(["aaa"]);
      const before = reg.plugins[0];
      writeFolderPlugin(dir, "bbb", GOOD_B);
      rmSync(path.join(dir, "aaa"), { recursive: true, force: true });
      const second = await reg.scan();
      expect(second.added).toEqual(["bbb"]);
      expect(second.removed).toEqual(["aaa"]);
      expect(reg.plugins.map((p) => p.name)).toEqual(["bbb"]);
      // an untouched plugin is never re-imported (same object = same closures)
      writeFolderPlugin(dir, "ccc", GOOD_A.replaceAll("aaa", "ccc"));
      await reg.scan();
      const c1 = reg.plugins.find((p) => p.name === "ccc")!;
      await reg.scan();
      expect(reg.plugins.find((p) => p.name === "ccc")).toBe(c1);
      expect(before).toBeDefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("edited code hot-reloads live (staged import defeats Bun cache)", async () => {
    const dir = mkDir();
    try {
      writeFolderPlugin(dir, "aaa", GOOD_A);
      const warns: string[] = [];
      const logs: string[] = [];
      const api = mkApi(dir, logs);
      const reg = makePluginRegistry({ dir, api, warn: (m) => warns.push(m) });
      await reg.scan();
      expect(reg.plugins[0]!.rows.map((r) => r.label)).toEqual(["hi-a"]);
      // force a distinct mtime (same-ms writes would compare equal on the
      // fingerprint fast path) — same plugin name, new rows proves live
      // reload, not stale serving
      writeFolderPlugin(dir, "aaa", GOOD_A.replace("hi-a", "hi-a2"));
      const main = path.join(dir, "aaa", "aaa.ts");
      const t = new Date(Date.now() + 5000);
      utimesSync(main, t, t);
      const res = await reg.scan();
      expect(res.changed).toEqual(["aaa"]);
      // live rows, not stale — no restart toast
      expect(reg.plugins[0]!.rows.map((r) => r.label)).toEqual(["hi-a2"]);
      expect(warns.some((w) => w.includes("restart"))).toBe(false);
      expect(logs.some((l) => l.includes("reloaded"))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("helper-file edits reload too (fingerprint covers the whole folder)", async () => {
    const dir = mkDir();
    try {
      mkdirSync(path.join(dir, "aaa"), { recursive: true });
      writeFileSync(
        path.join(dir, "aaa", "aaa.ts"),
        `import { msg } from "./helper.ts";\nexport default { name: "aaa", activate: () => ({ rows: [{ kind: "action", label: msg, run: () => {} }] }) };\n`,
      );
      writeFileSync(path.join(dir, "aaa", "helper.ts"), `export const msg = "v1";\n`);
      const reg = makePluginRegistry({ dir, api: mkApi(dir, []), warn: () => {} });
      await reg.scan();
      expect(reg.plugins[0]!.rows.map((r) => r.label)).toEqual(["v1"]);
      // main file untouched — only the helper changes (plus a forced mtime so
      // the fingerprint can't compare equal on coarse filesystems)
      writeFileSync(path.join(dir, "aaa", "helper.ts"), `export const msg = "v2";\n`);
      const t = new Date(Date.now() + 5000);
      utimesSync(path.join(dir, "aaa", "helper.ts"), t, t);
      const res = await reg.scan();
      expect(res.changed).toEqual(["aaa"]);
      expect(reg.plugins[0]!.rows.map((r) => r.label)).toEqual(["v2"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a throwing reload keeps the old instance live (no dead-but-listed corpse)", async () => {
    const dir = mkDir();
    try {
      writeFolderPlugin(dir, "aaa", GOOD_A);
      const warns: string[] = [];
      const reg = makePluginRegistry({ dir, api: mkApi(dir, []), warn: (m) => warns.push(m) });
      await reg.scan();
      const before = reg.plugins[0]!;
      expect(before.rows.map((r) => r.label)).toEqual(["hi-a"]);
      writeFolderPlugin(
        dir,
        "aaa",
        `export default { name: "aaa", activate: () => { throw new Error("new-boom"); } };\n`,
      );
      const main = path.join(dir, "aaa", "aaa.ts");
      const t = new Date(Date.now() + 5000);
      utimesSync(main, t, t);
      const res = await reg.scan();
      expect(res.changed).toEqual([]);
      expect(res.errors.length).toBe(1);
      expect(res.errors[0]).toContain("failed to reload");
      // old instance still listed with its rows (identity preserved)
      expect(reg.plugins[0]).toBe(before);
      expect(reg.plugins[0]!.rows.map((r) => r.label)).toEqual(["hi-a"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("the per-file lifecycle", () => {
  const writeFolderPlugin = (dir: string, name: string, body: string): void => {
    mkdirSync(path.join(dir, name), { recursive: true });
    writeFileSync(path.join(dir, name, `${name}.ts`), body);
  };

  test("a broken plugin that is deleted and re-installed warns AGAIN", async () => {
    // The warning dedupe belongs to the FILE: a file that never loaded has
    // no snap, so the removal sweep never reached its dedupe key — the key
    // outlived the file, and the re-install of the SAME broken content was
    // SILENT (no toast for a plugin that does not load).
    const dir = mkDir();
    try {
      const warns: string[] = [];
      const reg = makePluginRegistry({ dir, api: mkApi(dir, []), warn: (m) => warns.push(m) });
      const broken = `export default { name: "bad", activate: () => { throw new Error("boom"); } };\n`;
      writeFolderPlugin(dir, "bad", broken);
      await reg.scan();
      expect(warns.length).toBe(1);
      expect(warns[0]).toContain("failed to load");
      // the user deletes the broken plugin …
      rmSync(path.join(dir, "bad"), { recursive: true, force: true });
      await reg.scan();
      // … and installs the very same broken content again
      writeFolderPlugin(dir, "bad", broken);
      await reg.scan();
      expect(reg.errors.length).toBe(1);
      // the file is new again — the user must be told their plugin does not
      // load (the old key belonged to a file that is gone)
      expect(warns.length).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a failed reload is retried on the next scan", async () => {
    // The stale-fp retry path: the live plugin is the OLD version while the
    // disk holds a new one that failed to load. The next scan must ATTEMPT
    // the reload again (a transient failure self-heals) — the activate
    // counter is the observable, not the error list.
    const dir = mkDir();
    try {
      const key = `__tfmPluginActivateCount_${process.pid}_${Date.now()}`;
      const count = (): number => ((globalThis as Record<string, unknown>)[key] as number | undefined) ?? 0;
      writeFolderPlugin(dir, "aaa", GOOD_A);
      const reg = makePluginRegistry({ dir, api: mkApi(dir, []), warn: () => {} });
      await reg.scan();
      expect(reg.plugins.length).toBe(1);
      expect(count()).toBe(0);
      // break it: the reload fails and the old instance stays live
      writeFolderPlugin(
        dir,
        "aaa",
        `export default { name: "aaa", activate: () => { globalThis[${JSON.stringify(key)}] = (globalThis[${JSON.stringify(key)}] ?? 0) + 1; throw new Error("boom"); } };\n`,
      );
      const main = path.join(dir, "aaa", "aaa.ts");
      const t = new Date(Date.now() + 5000);
      utimesSync(main, t, t);
      const first = await reg.scan();
      expect(first.changed).toEqual([]);
      expect(reg.errors.length).toBe(1);
      expect(count()).toBe(1);
      // the next scan attempts the reload AGAIN (the retry)
      await reg.scan();
      expect(count()).toBe(2);
      expect(reg.errors.length).toBe(1);
      delete (globalThis as Record<string, unknown>)[key];
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a plugin that renames itself on reload is retired when its file is removed", async () => {
    // The loader joins a file's snap to its live instance by the FILE (the
    // name lives in ONE place — the instance). A name-based join retires the
    // WRONG instance (or none) once the plugin renamed itself.
    const dir = mkDir();
    try {
      const reg = makePluginRegistry({ dir, api: mkApi(dir, []), warn: () => {} });
      writeFolderPlugin(dir, "aaa", GOOD_A);
      await reg.scan();
      expect(reg.plugins.map((p) => p.name)).toEqual(["aaa"]);
      // the plugin renames itself (the file keeps its name)
      writeFolderPlugin(
        dir,
        "aaa",
        `export default { name: "zzz", activate: () => ({ rows: [{ kind: "action", label: "hi-z", run: () => {} }] }) };\n`,
      );
      const main = path.join(dir, "aaa", "aaa.ts");
      const t = new Date(Date.now() + 5000);
      utimesSync(main, t, t);
      await reg.scan();
      expect(reg.plugins.map((p) => p.name)).toEqual(["zzz"]);
      // the file goes away — the instance goes with it (the name no longer
      // matches the file's basename)
      rmSync(path.join(dir, "aaa"), { recursive: true, force: true });
      const res = await reg.scan();
      expect(res.removed).toEqual(["zzz"]);
      expect(reg.plugins).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("one plugin's warning does not clear another's", async () => {
    // the dedupe keys are PER FILE: removing one plugin must not wipe
    // another file's key (the old cleanup deleted every key that STARTED
    // with the removed path)
    const dir = mkDir();
    try {
      const warns: string[] = [];
      const reg = makePluginRegistry({ dir, api: mkApi(dir, []), warn: (m) => warns.push(m) });
      writeFolderPlugin(dir, "aaa", GOOD_A);
      writeFolderPlugin(dir, "bbb", `export default { name: "bbb", activate: () => { throw new Error("boom"); } };\n`);
      await reg.scan();
      expect(warns.length).toBe(1);
      // remove the GOOD plugin — the broken one keeps its dedupe key
      rmSync(path.join(dir, "aaa"), { recursive: true, force: true });
      await reg.scan();
      await reg.scan();
      // the broken plugin still fails on every scan, but its warning was
      // already said (the dedupe survived the neighbour's removal)
      expect(warns.length).toBe(1);
      expect(reg.errors.length).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("plugin extra menus", () => {
  test("sidebarMenu/emptyAreaMenu builders are collected per plugin", async () => {
    const dir = mkDir();
    try {
      writePlugin(
        dir,
        "aaa.ts",
        `export default { name: "aaa", activate: () => ({ sidebarMenu: (place) => [{ label: "Side", run: (paths) => {} }], emptyAreaMenu: (area) => [{ label: "Here", run: (paths) => {} }] }) };\n`,
      );
      const { plugins, errors } = await loadPlugins({ dir, api: mkApi(dir, []), warn: () => {} });
      expect(errors).toEqual([]);
      expect(typeof plugins[0]!.sidebarMenu).toBe("function");
      expect(typeof plugins[0]!.emptyAreaMenu).toBe("function");
      expect(plugins[0]!.sidebarMenu!({ path: "/x" }).map((e) => e.label)).toEqual(["Side"]);
      expect(plugins[0]!.emptyAreaMenu!({ cwd: "/y" }).map((e) => e.label)).toEqual(["Here"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a non-function sidebarMenu skips the plugin with an error", async () => {
    const dir = mkDir();
    try {
      writePlugin(dir, "aaa.ts", GOOD_A);
      writePlugin(dir, "bad.ts", `export default { name: "bad", activate: () => ({ sidebarMenu: "nope" }) };\n`);
      const warns: string[] = [];
      const { plugins, errors } = await loadPlugins({ dir, api: mkApi(dir, []), warn: (m) => warns.push(m) });
      expect(plugins.map((p) => p.name)).toEqual(["aaa"]);
      expect(errors.length).toBe(1);
      expect(warns.length).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("plugin preview contributions", () => {
  test("preview entries validate exts+render; malformed ones drop", async () => {
    const dir = mkDir();
    try {
      writePlugin(
        dir,
        "aaa.ts",
        `export default { name: "aaa", activate: () => ({ preview: [{ exts: ["CSV"], render: (p) => "csv!" }, { exts: "nope", render: () => "" }, { exts: ["x"] }] }) };\n`,
      );
      const { plugins, errors } = await loadPlugins({ dir, api: mkApi(dir, []), warn: () => {} });
      expect(errors).toEqual([]);
      expect(plugins[0]!.preview.length).toBe(1);
      expect(plugins[0]!.preview[0]!.exts).toEqual(["csv"]);
      expect(await plugins[0]!.preview[0]!.render("/f.csv")).toBe("csv!");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("plugin commands with defaultBinds", () => {
  test("commands carry defaultBinds; malformed binds drop the entry, plugin stays", async () => {
    const dir = mkDir();
    try {
      writePlugin(
        dir,
        "aaa.ts",
        `export default { name: "aaa", activate: () => ({ commands: [{ id: "aaa:hi", title: "Hi", run: () => {}, defaultBinds: ["ctrl+j"] }, { id: "aaa:bad", title: "Bad", run: () => {}, defaultBinds: "nope" }, { id: "aaa:nope" }] }) };\n`,
      );
      const { plugins, errors } = await loadPlugins({ dir, api: mkApi(dir, []), warn: () => {} });
      expect(errors).toEqual([]);
      expect(plugins[0]!.commands.map((c) => c.id)).toEqual(["aaa:hi"]);
      expect(plugins[0]!.commands[0]!.defaultBinds).toEqual(["ctrl+j"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("bare-key defaultBinds drop the entry (would swallow type-to-search)", async () => {
    const dir = mkDir();
    try {
      writePlugin(
        dir,
        "aaa.ts",
        `export default { name: "aaa", activate: () => ({ commands: [{ id: "aaa:hi", title: "Hi", run: () => {}, defaultBinds: ["j"] }, { id: "aaa:ok", title: "Ok", run: () => {}, defaultBinds: ["ctrl+j"] }] }) };\n`,
      );
      const logs: string[] = [];
      const { plugins, errors } = await loadPlugins({ dir, api: mkApi(dir, logs), warn: () => {} });
      expect(errors).toEqual([]);
      // the bare-key entry drops (plugin dispatches before type-to-search, so
      // it would make plain "j" unreachable); the valid sibling survives
      expect(plugins[0]!.commands.map((c) => c.id)).toEqual(["aaa:ok"]);
      expect(logs.some((l) => l.includes("aaa:hi") && l.includes("defaultBind"))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("lifecycle v2 (async activate + deactivate + store scope)", () => {
  const writeFolderPlugin = (dir: string, name: string, body: string): void => {
    mkdirSync(path.join(dir, name), { recursive: true });
    writeFileSync(path.join(dir, name, `${name}.ts`), body);
  };

  test("async activate is awaited (rows present after scan)", async () => {
    const dir = mkDir();
    try {
      writeFolderPlugin(
        dir,
        "aaa",
        `export default { name: "aaa", activate: async (api) => { await new Promise((r) => setTimeout(r, 5)); return { rows: [{ kind: "action", label: "async-hi", run: () => {} }] }; } };\n`,
      );
      const { plugins, errors } = await loadPlugins({ dir, api: mkApi(dir, []), warn: () => {} });
      expect(errors).toEqual([]);
      expect(plugins.map((p) => p.name)).toEqual(["aaa"]);
      expect(plugins[0]!.rows.map((r) => r.label)).toEqual(["async-hi"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("deactivate runs on removal (result-level hook)", async () => {
    const dir = mkDir();
    try {
      const marker = path.join(dir, "deactivated.txt");
      writeFolderPlugin(
        dir,
        "aaa",
        `import { writeFileSync } from "node:fs";\nexport default { name: "aaa", activate: () => ({ rows: [], deactivate: () => { writeFileSync(${JSON.stringify(marker)}, "bye"); } }) };\n`,
      );
      const reg = makePluginRegistry({ dir, api: mkApi(dir, []), warn: () => {} });
      await reg.scan();
      expect(reg.plugins.map((p) => p.name)).toEqual(["aaa"]);
      expect(typeof reg.plugins[0]!.deactivate).toBe("function");
      rmSync(path.join(dir, "aaa"), { recursive: true, force: true });
      const diff = await reg.scan();
      expect(diff.removed).toEqual(["aaa"]);
      expect(existsSync(marker)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("module-level deactivate is used when result carries none", async () => {
    const dir = mkDir();
    try {
      const marker = path.join(dir, "mod-bye.txt");
      writeFolderPlugin(
        dir,
        "aaa",
        `import { writeFileSync } from "node:fs";\nexport default { name: "aaa", activate: () => ({}), deactivate: () => { writeFileSync(${JSON.stringify(marker)}, "bye"); } };\n`,
      );
      const reg = makePluginRegistry({ dir, api: mkApi(dir, []), warn: () => {} });
      await reg.scan();
      expect(typeof reg.plugins[0]!.deactivate).toBe("function");
      rmSync(path.join(dir, "aaa"), { recursive: true, force: true });
      await reg.scan();
      expect(existsSync(marker)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("minApiVersion above core rejects with an error", async () => {
    const dir = mkDir();
    try {
      writeFolderPlugin(dir, "aaa", `export default { name: "aaa", minApiVersion: 99, activate: () => ({}) };\n`);
      const warns: string[] = [];
      const { plugins, errors } = await loadPlugins({ dir, api: mkApi(dir, []), warn: (m) => warns.push(m) });
      expect(plugins).toEqual([]);
      expect(errors.length).toBe(1);
      expect(errors[0]).toContain("requires apiVersion");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("store() is namespaced: asking for another plugin returns your own", async () => {
    const dir = mkDir();
    try {
      writeFolderPlugin(
        dir,
        "aaa",
        `export default { name: "aaa", activate: (api) => { const s = api.store("bbb"); s.set("k", "from-aaa"); return {}; } };\n`,
      );
      writeFolderPlugin(dir, "bbb", GOOD_B);
      const logs: string[] = [];
      const api = mkApi(dir, logs);
      await loadPlugins({ dir, api, warn: () => {} });
      // aaa's write landed in aaa's store, not bbb's
      expect(makePluginStore(dir, "aaa").get("k", "")).toBe("from-aaa");
      expect(makePluginStore(dir, "bbb").get("k", "")).toBe("");
      expect(logs.some((l) => l.includes("asked for store"))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("staged builds (hot-reload machinery)", () => {
  test("pruning a stages only its own name-hash dirs (prefix collision)", () => {
    const src = mkdtempSync(path.join(os.tmpdir(), "tfm-stage-src-"));
    try {
      mkdirSync(path.join(src, "a"), { recursive: true });
      mkdirSync(path.join(src, "a-b"), { recursive: true });
      writeFileSync(path.join(src, "a", "a.ts"), `export default { name: "a", activate: () => ({}) };\n`);
      writeFileSync(path.join(src, "a-b", "a-b.ts"), `export default { name: "a-b", activate: () => ({}) };\n`);
      const stagedAB = copyStagedPlugin(
        path.join(src, "a-b"),
        "a-b",
        hashPluginFolder(path.join(src, "a-b")),
        "a-b.ts",
      );
      expect(existsSync(stagedAB)).toBe(true);
      // staging `a` prunes `a-*` but must leave `a-b-*` alone
      copyStagedPlugin(path.join(src, "a"), "a", hashPluginFolder(path.join(src, "a")), "a.ts");
      expect(existsSync(stagedAB)).toBe(true);
      expect(existsSync(path.join(pluginBuildDir(), `${"a-b"}-${hashPluginFolder(path.join(src, "a-b"))}`))).toBe(true);
    } finally {
      rmSync(src, { recursive: true, force: true });
    }
  });

  test("symlinks are excluded from hash and staged copy", () => {
    const src = mkdtempSync(path.join(os.tmpdir(), "tfm-stage-src-"));
    const outside = mkdtempSync(path.join(os.tmpdir(), "tfm-stage-out-"));
    try {
      mkdirSync(path.join(src, "aaa"), { recursive: true });
      writeFileSync(path.join(src, "aaa", "aaa.ts"), `export default { name: "aaa", activate: () => ({}) };\n`);
      writeFileSync(path.join(outside, "secret.txt"), "top-secret\n");
      const before = hashPluginFolder(path.join(src, "aaa"));
      symlinkSync(path.join(outside, "secret.txt"), path.join(src, "aaa", "evil-link"));
      // the link changes neither the hash nor the staged tree
      expect(hashPluginFolder(path.join(src, "aaa"))).toBe(before);
      const staged = copyStagedPlugin(path.join(src, "aaa"), "aaa", before, "aaa.ts");
      expect(existsSync(staged)).toBe(true);
      expect(existsSync(path.join(path.dirname(staged), "evil-link"))).toBe(false);
    } finally {
      rmSync(src, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test("a failing load leaves no staged dir behind", async () => {
    const dir = mkDir();
    try {
      writePlugin(
        dir,
        "bad.ts",
        `export default { name: "bad", activate: () => { throw new Error("load-boom"); } };\n`,
      );
      const { plugins, errors } = await loadPlugins({ dir, api: mkApi(dir, []), warn: () => {} });
      expect(plugins).toEqual([]);
      expect(errors.length).toBe(1);
      // no `bad-<hash>` dir referenced by nothing may linger in the build root
      let lingering: string[] = [];
      try {
        const { readdirSync: rd } = await import("node:fs");
        lingering = rd(pluginBuildDir()).filter((e) => e.startsWith("bad-"));
      } catch {}
      expect(lingering).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a rename past the byte cap changes the hash (tail paths fold in)", () => {
    // content beyond the 10MB cap can't be hashed (that defeats the cap), so
    // the unhashed tail's PATHS fold into the hash — an add/remove/rename there
    // still reloads (a content-only edit there still misses; the cap is the tradeoff)
    const src = mkdtempSync(path.join(os.tmpdir(), "tfm-hash-cap-"));
    try {
      const folder = path.join(src, "big");
      mkdirSync(folder, { recursive: true });
      writeFileSync(path.join(folder, "big.ts"), "x");
      writeFileSync(path.join(folder, "blob.bin"), Buffer.alloc(11 * 1024 * 1024));
      writeFileSync(path.join(folder, "tail.txt"), "tail");
      const before = hashPluginFolder(folder);
      renameSync(path.join(folder, "tail.txt"), path.join(folder, "tail2.txt"));
      expect(hashPluginFolder(folder)).not.toBe(before);
    } finally {
      rmSync(src, { recursive: true, force: true });
    }
  });
});

describe("manifest metadata", () => {
  test("version/author/description surface on the loaded plugin (capped, defaulted)", async () => {
    const dir = mkDir();
    try {
      writePlugin(
        dir,
        "meta.ts",
        `export default { name: "meta", version: "1.2.3", author: "someone", description: "does things", activate: () => ({}) };\n`,
      );
      writePlugin(dir, "plain.ts", `export default { name: "plain", activate: () => ({}) };\n`);
      const { plugins } = await loadPlugins({ dir, api: mkApi(dir, []), warn: () => {} });
      const meta = plugins.find((p) => p.name === "meta")!;
      expect([meta.version, meta.author, meta.description]).toEqual(["1.2.3", "someone", "does things"]);
      const plain = plugins.find((p) => p.name === "plain")!;
      expect([plain.version, plain.author, plain.description]).toEqual(["", "", ""]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("deactivateAll (quit teardown)", () => {
  test("calls each plugin's deactivate synchronously", async () => {
    const dir = mkDir();
    const mark = path.join(dir, "marks.txt");
    process.env.TFM_TEST_MARK = mark;
    try {
      writePlugin(
        dir,
        "d.ts",
        `import { appendFileSync } from "node:fs";\n` +
          `export default { name: "d", activate: () => ({}), deactivate() { appendFileSync(process.env.TFM_TEST_MARK, "d\\n"); } };\n`,
      );
      const reg = makePluginRegistry({ dir, api: mkApi(dir, []), warn: () => {} });
      await reg.scan();
      reg.deactivateAll();
      expect(readFileSync(mark, "utf8")).toBe("d\n");
    } finally {
      delete process.env.TFM_TEST_MARK;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("slot contributions (loader bridge)", () => {
  test("registerSlots receives the contribution; remove disposes it", async () => {
    const dir = mkDir();
    const registered: string[] = [];
    const disposed: string[] = [];
    try {
      writePlugin(
        dir,
        "bars.ts",
        `export default { name: "bars", activate: () => ({ slots: { statusbar: () => null } }) };\n`,
      );
      const reg = makePluginRegistry({
        dir,
        api: mkApi(dir, []),
        warn: () => {},
        registerSlots: (name, slots) => {
          registered.push(`${name}:${Object.keys(slots).join(",")}`);
          return () => disposed.push(name);
        },
      });
      await reg.scan();
      expect(registered).toEqual(["bars:statusbar"]);
      // removing the plugin folder must unregister its slots (no leak)
      rmSync(path.join(dir, "bars"), { recursive: true, force: true });
      await reg.scan();
      expect(disposed).toEqual(["bars"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a disabled plugin's slots are unregistered", async () => {
    // The flag and the slots are ONE transition: the plugin's store owns the
    // flag, the slot registration is DERIVED from it. The old shape wrote the
    // store in the settings model and unregistered the slots in a separate
    // registry call — the two could disagree, and a disabled plugin kept
    // painting UI.
    const dir = mkDir();
    const registered: string[] = [];
    const disposed: string[] = [];
    try {
      writePlugin(
        dir,
        "bars.ts",
        `export default { name: "bars", activate: () => ({ slots: { statusbar: () => null } }) };\n`,
      );
      const reg = makePluginRegistry({
        dir,
        api: mkApi(dir, []),
        warn: () => {},
        registerSlots: (name, slots) => {
          registered.push(`${name}:${Object.keys(slots).join(",")}`);
          return () => disposed.push(name);
        },
      });
      await reg.scan();
      expect(registered).toEqual(["bars:statusbar"]);
      // toggling off moves BOTH: the flag's owner (the store) says off …
      reg.setEnabled("bars", false);
      expect(reg.plugins[0]!.enabled).toBe(false);
      // … and the registration is gone (ONE tagged state, not a nullable fn)
      expect(disposed).toEqual(["bars"]);
      expect(reg.plugins[0]!.slotRegistration.kind).toBe("none");
      // toggling back on brings the slots with the flag
      reg.setEnabled("bars", true);
      expect(reg.plugins[0]!.enabled).toBe(true);
      expect(registered).toEqual(["bars:statusbar", "bars:statusbar"]);
      expect(reg.plugins[0]!.slotRegistration.kind).toBe("registered");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("toggling twice does not leak a registration", async () => {
    // The unregister handle was DROPPED even when the unregister THREW (the
    // old shape nulled the handle after the call) → the next enable
    // registered a SECOND copy and the plugin's UI painted twice. The state
    // advances only on success: a failed dispose KEEPS the handle.
    const dir = mkDir();
    let registrations = 0;
    try {
      writePlugin(
        dir,
        "bars.ts",
        `export default { name: "bars", activate: () => ({ slots: { statusbar: () => null } }) };\n`,
      );
      const reg = makePluginRegistry({
        dir,
        api: mkApi(dir, []),
        warn: () => {},
        registerSlots: () => {
          registrations++;
          return () => {
            throw new Error("unregister-boom");
          };
        },
      });
      await reg.scan();
      expect(registrations).toBe(1);
      // off: the unregister fails — the handle is kept, so the next enable
      // cannot register a second copy
      reg.setEnabled("bars", false);
      reg.setEnabled("bars", true);
      expect(registrations).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a plugin whose unregister fails is retried (the handle is never lost)", async () => {
    // The removal path drops the plugin object — a failed unregister would
    // lose the handle with it and the contribution would stay in the UI
    // registry forever. The registry keeps the plugin and retries.
    const dir = mkDir();
    let disposals = 0;
    try {
      writePlugin(
        dir,
        "bars.ts",
        `export default { name: "bars", activate: () => ({ slots: { statusbar: () => null } }) };\n`,
      );
      const reg = makePluginRegistry({
        dir,
        api: mkApi(dir, []),
        warn: () => {},
        registerSlots: () => () => {
          disposals++;
          if (disposals === 1) throw new Error("unregister-boom");
        },
      });
      await reg.scan();
      expect(disposals).toBe(0);
      // removing the plugin unregisters its slots — that unregister fails
      rmSync(path.join(dir, "bars"), { recursive: true, force: true });
      await reg.scan();
      expect(disposals).toBe(1);
      // the handle survived the removal: the next scan retries it
      await reg.scan();
      expect(disposals).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a malformed slots field fails the plugin load", async () => {
    const dir = mkDir();
    try {
      writePlugin(dir, "bad.ts", `export default { name: "bad", activate: () => ({ slots: [] }) };\n`);
      const { plugins, errors } = await loadPlugins({ dir, api: mkApi(dir, []), warn: () => {} });
      expect(plugins).toEqual([]);
      expect(errors.length).toBe(1);
      expect(errors[0]).toContain("slots must be an object");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
