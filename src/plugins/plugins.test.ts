import { afterAll, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
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
