import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { makeSettingModel, type SettingsModelCtx } from "./settings-model";
import { defaultConfig, KEY_SCHEMA, type Config } from "../config/config-schema";
import { THEME_PRESETS } from "../config/themes";
import { makePluginStore } from "../plugins/plugins";
import type { LoadedPlugin } from "../plugins/plugin-api";
import type { SettingGroup, SettingRow } from "./settings";

// The fake ctx mirrors the REAL applyConfig contract (ui-retheme): it merges
// the fresh object's sections into the live config via Object.assign — rows
// read through ctx.config on every call, so a fake that ignored the merge
// would lie about coverage (AGENTS.md fake-guard rule).
const mk = (plugins?: () => LoadedPlugin[]) => {
  const config = structuredClone(defaultConfig);
  const state = { showHidden: false };
  const applied: Config[] = [];
  const warns: { message: string; title?: string }[] = [];
  let saves = 0;
  let roots = 0;
  const ctx: SettingsModelCtx = {
    config,
    state,
    applyConfig: (fresh) => {
      applied.push(structuredClone(fresh));
      Object.assign(config.ui, fresh.ui);
      Object.assign(config.theme, fresh.theme);
      Object.assign(config.keys, fresh.keys);
    },
    scheduleSaveConfig: () => {
      saves++;
    },
    showRoot: () => {
      roots++;
    },
    warn: (message, title) => {
      warns.push({ message, title });
    },
    ...(plugins ? { plugins } : {}),
  };
  const model = makeSettingModel(ctx);
  const groups = (): SettingGroup[] => model.settingGroups();
  const rows = (): SettingRow[] => groups().flatMap((g) => g.rows);
  const byLabel = (label: string): SettingRow => {
    const r = rows().find((x) => x.label === label);
    if (!r) throw new Error(`no row ${label}`);
    return r;
  };
  return { ctx, config, state, applied, warns, model, groups, rows, byLabel, saves: () => saves, roots: () => roots };
};

const mkPlugin = (over: Partial<LoadedPlugin> & { name: string }): LoadedPlugin => ({
  rows: [],
  fileMenu: null,
  sidebarMenu: null,
  emptyAreaMenu: null,
  commands: [],
  preview: [],
  store: {
    get: (_k: string, fb: unknown) => fb as never,
    set: () => {},
  },
  deactivate: null,
  file: `/fake/${over.name}.ts`,
  ...over,
});

const isKeybind = (r: SettingRow): r is Extract<SettingRow, { kind: "keybind" }> => r.kind === "keybind";
const asToggle = (r: SettingRow): Extract<SettingRow, { kind: "toggle" }> => {
  if (r.kind !== "toggle") throw new Error(`not a toggle: ${r.label}`);
  return r;
};
const asStepper = (r: SettingRow): Extract<SettingRow, { kind: "stepper" }> => {
  if (r.kind !== "stepper") throw new Error(`not a stepper: ${r.label}`);
  return r;
};
const asCycle = (r: SettingRow): Extract<SettingRow, { kind: "cycle" }> => {
  if (r.kind !== "cycle") throw new Error(`not a cycle: ${r.label}`);
  return r;
};
const asKeybind = (r: SettingRow): Extract<SettingRow, { kind: "keybind" }> => {
  if (r.kind !== "keybind") throw new Error(`not a keybind: ${r.label}`);
  return r;
};

describe("settingGroups shape", () => {
  test("headers in the documented order", () => {
    const h = mk();
    expect(h.groups().map((g) => g.header)).toEqual(["general", "layout", "behavior", "keys", "config"]);
  });

  test("every keybind action gets a row", () => {
    const h = mk();
    const kb = h.groups().find((g) => g.header === "keys")!.rows;
    expect(kb.length).toBe(KEY_SCHEMA.length);
    expect(kb.every(isKeybind)).toBe(true);
  });

  test("schema rows land in their declared group", () => {
    const h = mk();
    const layout = h
      .groups()
      .find((g) => g.header === "layout")!
      .rows.map((r) => r.label);
    expect(layout).toContain("sidebar width");
    expect(layout).not.toContain("preview pane");
  });

  test("each plugin gets its OWN category with an on/off toggle first", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "tfm-model-plugins-"));
    try {
      const hello: SettingRow = { kind: "action", label: "Say hello", run: () => {} };
      const plug = (): LoadedPlugin[] => [
        mkPlugin({ name: "hello", rows: [hello], store: makePluginStore(dir, "hello") }),
      ];
      // settings groups stay frozen at the five core categories…
      expect(
        mk(plug)
          .groups()
          .map((g) => g.header),
      ).toEqual(["general", "layout", "behavior", "keys", "config"]);
      expect(() => mk(plug).byLabel("Say hello")).toThrow();
      // …plugin rows live behind pluginGroups(), one category per plugin
      // (plus the leading "add plugins" installer category — always first
      // so the Plugins view exists before anything is installed)
      const h = mk(plug);
      expect(h.model.pluginGroups().map((g) => g.header)).toEqual(["add plugins", "hello"]);
      const rows = h.model.pluginGroups().find((g) => g.header === "hello")!.rows;
      expect(rows.map((r) => r.label)).toEqual(["enabled", "Say hello", "Update from git", "Remove…"]);
      const toggle = rows[0]!;
      if (toggle.kind !== "toggle") throw new Error("first plugin row must be the enabled toggle");
      expect(toggle.get()).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("disabling a plugin hides its rows but keeps the toggle (re-enable path)", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "tfm-model-plugins-"));
    try {
      const hello: SettingRow = { kind: "action", label: "Say hello", run: () => {} };
      const h = mk(() => [mkPlugin({ name: "hello", rows: [hello], store: makePluginStore(dir, "hello") })]);
      const toggle = h.model.pluginGroups().find((g) => g.header === "hello")!.rows[0]!;
      if (toggle.kind !== "toggle") throw new Error("first plugin row must be the enabled toggle");
      // the toggle rebuilds the panel so the rows vanish/appear live
      expect(toggle.repaint).toBe(true);
      toggle.set(false);
      expect(
        h.model
          .pluginGroups()
          .find((g) => g.header === "hello")!
          .rows.map((r) => r.label),
      ).toEqual(["enabled", "Update from git", "Remove…"]);
      toggle.set(true);
      expect(
        h.model
          .pluginGroups()
          .find((g) => g.header === "hello")!
          .rows.map((r) => r.label),
      ).toEqual(["enabled", "Say hello", "Update from git", "Remove…"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("installer category exists even without plugins (Plugins view is discoverable pre-install)", () => {
    for (const h of [mk(), mk(() => [])]) {
      expect(h.model.pluginGroups().map((g) => g.header)).toEqual(["add plugins"]);
      expect(h.model.pluginGroups()[0]!.rows.map((r) => r.label)).toEqual([
        "Add from git URL…",
        "Open plugins folder…",
      ]);
    }
  });

  test("plugin commands get remappable keybind rows (persisted in own store)", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "tfm-model-plugins-"));
    try {
      const h = mk(() => [
        mkPlugin({
          name: "demo",
          commands: [{ id: "demo:hi", title: "Say hi", run: () => {}, defaultBinds: ["ctrl+j"] }],
          store: makePluginStore(dir, "demo"),
        }),
      ]);
      const group = h.model.pluginGroups().find((g) => g.header === "demo")!;
      const keyRow = group.rows.find((r) => r.label === "Say hi (key)")!;
      if (keyRow.kind !== "keybind") throw new Error("expected keybind row");
      expect(keyRow.get()).toEqual(["ctrl+j"]);
      keyRow.set(["ctrl+k"]);
      expect(keyRow.get()).toEqual(["ctrl+k"]);
      expect(makePluginStore(dir, "demo").get<string[]>("keys:demo:hi", [])).toEqual(["ctrl+k"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("plugin remap conflicting with core is rejected with a warn", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "tfm-model-plugins-"));
    try {
      const h = mk(() => [
        mkPlugin({
          name: "demo",
          commands: [{ id: "demo:hi", title: "Say hi", run: () => {}, defaultBinds: ["ctrl+j"] }],
          store: makePluginStore(dir, "demo"),
        }),
      ]);
      const group = h.model.pluginGroups().find((g) => g.header === "demo")!;
      const keyRow = group.rows.find((r) => r.label === "Say hi (key)")!;
      if (keyRow.kind !== "keybind") throw new Error("expected keybind row");
      keyRow.set(["ctrl+q"]); // owned by core quit
      expect(h.warns.length).toBe(1);
      expect(h.warns[0]!.message).toContain("ctrl+q");
      expect(keyRow.get()).toEqual(["ctrl+j"]); // unchanged
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("core remap onto a plugin bind is rejected (no silent shadowing)", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "tfm-model-plugins-"));
    try {
      const h = mk(() => [
        mkPlugin({
          name: "demo",
          commands: [{ id: "demo:hi", title: "Say hi", run: () => {}, defaultBinds: ["ctrl+j"] }],
          store: makePluginStore(dir, "demo"),
        }),
      ]);
      asKeybind(h.byLabel("undo last file op")).set(["ctrl+j"]); // owned by demo:hi
      expect(h.warns.length).toBe(1);
      expect(h.warns[0]!.message).toContain("Say hi");
      expect(h.applied.length).toBe(0);
      expect(h.config.keys.undo).toEqual(defaultConfig.keys.undo);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("plugin remap conflicting with a sibling plugin is rejected", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "tfm-model-plugins-"));
    try {
      const h = mk(() => [
        mkPlugin({
          name: "aaa",
          commands: [{ id: "aaa:hi", title: "Hi A", run: () => {}, defaultBinds: ["ctrl+j"] }],
          store: makePluginStore(dir, "aaa"),
        }),
        mkPlugin({
          name: "bbb",
          commands: [{ id: "bbb:hi", title: "Hi B", run: () => {} }],
          store: makePluginStore(dir, "bbb"),
        }),
      ]);
      const bGroup = h.model.pluginGroups().find((g) => g.header === "bbb")!;
      const bKey = bGroup.rows.find((r) => r.label === "Hi B (key)")!;
      if (bKey.kind !== "keybind") throw new Error("expected keybind row");
      bKey.set(["ctrl+j"]); // owned by aaa:hi
      expect(h.warns.length).toBe(1);
      expect(h.warns[0]!.message).toContain("Hi A");
      expect(bKey.get()).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a throwing plugin store degrades to toggle-only, other plugins intact", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "tfm-model-plugins-"));
    try {
      const bad: LoadedPlugin = mkPlugin({
        name: "bad",
        rows: [{ kind: "action", label: "Bad row", run: () => {} }],
        store: {
          get: () => {
            throw new Error("store-boom");
          },
          set: () => {
            throw new Error("store-boom");
          },
        },
      });
      const good: LoadedPlugin = mkPlugin({
        name: "good",
        rows: [{ kind: "action", label: "Good row", run: () => {} }],
        store: makePluginStore(dir, "good"),
      });
      const h = mk(() => [bad, good]);
      const groups = h.model.pluginGroups();
      expect(groups.map((g) => g.header)).toEqual(["add plugins", "bad", "good"]);
      // bad plugin keeps its toggle (enabled=true fallback), rows still listed
      // but toggle get/set never throw
      const badToggle = groups.find((g) => g.header === "bad")!.rows[0]!;
      if (badToggle.kind !== "toggle") throw new Error("expected toggle");
      expect(() => badToggle.get()).not.toThrow();
      expect(() => badToggle.set(false)).not.toThrow();
      expect(h.warns.length).toBeGreaterThan(0);
      expect(groups.find((g) => g.header === "good")!.rows.map((r) => r.label)).toEqual([
        "enabled",
        "Good row",
        "Update from git",
        "Remove…",
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("generic schema rows", () => {
  test("stepper set commits a fresh ui patch and schedules a save", () => {
    const h = mk();
    const row = h.byLabel("sidebar width");
    expect(asStepper(row).get()).toBe(defaultConfig.ui.sidebarWidth);
    asStepper(row).set(50);
    expect(h.applied.length).toBe(1);
    expect(h.applied[0]!.ui.sidebarWidth).toBe(50);
    expect(h.config.ui.sidebarWidth).toBe(50);
    expect(h.saves()).toBe(1);
  });

  test("commit always carries ui + theme + keys (never a partial Config)", () => {
    const h = mk();
    asToggle(h.byLabel("preview pane")).set(true);
    const last = h.applied[h.applied.length - 1]!;
    expect(last.theme).toEqual(h.config.theme);
    expect(last.keys).toEqual(h.config.keys);
    expect(last.ui).toBeDefined();
  });

  test("cycle row maps index -> schema value", () => {
    const h = mk();
    const row = h.byLabel("ui style");
    // outline-partial added intentionally: outline chrome + solid floats
    expect(asCycle(row).names).toEqual(["solid", "outline", "outline-partial"]);
    asCycle(row).setIdx(1);
    expect(h.config.ui.uiStyle).toBe("outline");
    asCycle(row).setIdx(2);
    expect(h.config.ui.uiStyle).toBe("outline-partial");
  });

  test("panel-repainting rows are flagged (theme / ui style / transparent bg / transparent icons)", () => {
    const h = mk();
    for (const label of ["theme", "ui style", "transparent bg", "transparent icons"]) {
      const row = h.byLabel(label);
      expect("repaint" in row && row.repaint).toBe(true);
    }
    const plain = h.byLabel("word wrap (grid)");
    expect("repaint" in plain && plain.repaint).toBeFalsy();
  });
});

describe("hand-written rows", () => {
  test("hidden files toggles live state AND persists config", () => {
    const h = mk();
    const row = h.byLabel("hidden files");
    expect(row.kind).toBe("toggle");
    asToggle(row).set(true);
    expect(h.state.showHidden).toBe(true);
    expect(h.config.ui.showHidden).toBe(true);
  });

  test("only ONE hidden-files row exists (schema duplicate is skipped)", () => {
    const h = mk();
    expect(h.rows().filter((r) => r.label === "hidden files").length).toBe(1);
    expect(h.rows().filter((r) => r.label === "tab bar").length).toBe(1);
  });

  test("tab bar is a cycle (adaptive/on), not a toggle", () => {
    const h = mk();
    const row = h.byLabel("tab bar");
    expect(asCycle(row).names).toEqual(["adaptive", "on"]);
    asCycle(row).setIdx(1);
    expect(h.config.ui.tabBar).toBe(true);
    asCycle(row).setIdx(0);
    expect(h.config.ui.tabBar).toBe(false);
  });

  test("theme cycle commits the preset's theme verbatim", () => {
    const h = mk();
    const row = h.byLabel("theme");
    expect(row.kind).toBe("cycle");
    asCycle(row).setIdx(1);
    expect(h.config.theme).toEqual(THEME_PRESETS[1]!.theme);
    expect(h.config.theme).not.toBe(THEME_PRESETS[1]!.theme); // fresh copy, not the preset object
  });

  test("hand-edited theme reports ~nearest preset, exact match reports none needed", () => {
    const h = mk();
    const row = h.byLabel("theme");
    if (row.kind !== "cycle" || !row.customLabel) throw new Error("theme row must be a cycle with customLabel");
    // default config IS Tokyo Night (preset 0) — nearest is itself
    expect(row.getIdx()).toBe(0);
    h.config.theme = { ...THEME_PRESETS[2]!.theme, bg: "#000000" };
    expect(row.getIdx()).toBe(-1);
    expect(row.customLabel()).toBe(`~${THEME_PRESETS[2]!.name}`);
  });
});

describe("keybind rows", () => {
  test("conflicting bind is rejected with a warn toast naming the owner", () => {
    const h = mk();
    const undo = h.byLabel("undo last file op");
    expect(undo.kind).toBe("keybind");
    asKeybind(undo).set(["ctrl+q"]); // owned by quit
    expect(h.warns.length).toBe(1);
    expect(h.warns[0]!.message).toContain("ctrl+q");
    expect(h.warns[0]!.message).toContain("quit tfm");
    expect(h.applied.length).toBe(0);
    expect(h.config.keys.undo).toEqual(defaultConfig.keys.undo);
  });

  test("free bind commits through commitKeys, other actions untouched", () => {
    const h = mk();
    asKeybind(h.byLabel("undo last file op")).set(["ctrl+b"]);
    expect(h.applied.length).toBe(1);
    expect(h.config.keys.undo).toEqual(["ctrl+b"]);
    expect(h.config.keys.quit).toEqual(defaultConfig.keys.quit);
  });

  test("get reads the live config (remaps visible without rebuild)", () => {
    const h = mk();
    h.config.keys.redo = ["ctrl+j"];
    const row = h.byLabel("redo (ctrl+shift+z works too)");
    expect(asKeybind(row).get()).toEqual(["ctrl+j"]);
  });
});

describe("plugin installer rows", () => {
  const asAction = (r: SettingRow): Extract<SettingRow, { kind: "action" }> => {
    if (r.kind !== "action") throw new Error(`not an action: ${r.label}`);
    return r;
  };

  test("installer + update/remove rows dispatch to the injected installer", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "tfm-model-plugins-"));
    try {
      const h = mk(() => [mkPlugin({ name: "demo", store: makePluginStore(dir, "demo") })]);
      const calls: string[] = [];
      h.ctx.pluginInstall = {
        addFromUrl: () => calls.push("add"),
        openFolder: () => calls.push("open"),
        update: (n) => calls.push(`update:${n}`),
        remove: (n) => calls.push(`remove:${n}`),
      };
      const install = h.model.pluginGroups().find((g) => g.header === "add plugins")!;
      for (const row of install.rows) asAction(row).run();
      const demo = h.model.pluginGroups().find((g) => g.header === "demo")!;
      for (const row of demo.rows.filter((r) => r.label === "Update from git" || r.label === "Remove…")) {
        asAction(row).run();
      }
      expect(calls).toEqual(["add", "open", "update:demo", "remove:demo"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("installer rows render and no-op without an injected installer (never throw)", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "tfm-model-plugins-"));
    try {
      const h = mk(() => [mkPlugin({ name: "demo", store: makePluginStore(dir, "demo") })]);
      expect(h.ctx.pluginInstall).toBeUndefined();
      const all = h.model.pluginGroups().flatMap((g) => g.rows);
      for (const label of ["Add from git URL…", "Open plugins folder…", "Update from git", "Remove…"]) {
        const row = all.find((r) => r.label === label)!;
        expect(() => asAction(row).run()).not.toThrow();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("config group", () => {
  test("reset to defaults commits a clone of the defaults and syncs state", () => {
    const h = mk();
    h.config.ui.sidebarWidth = 44;
    h.state.showHidden = true;
    h.model.resetToDefaults();
    const last = h.applied[h.applied.length - 1]!;
    expect(last).toEqual(structuredClone(defaultConfig));
    expect(last).not.toBe(h.config); // fresh object, not the live ref
    expect(h.state.showHidden).toBe(defaultConfig.ui.showHidden);
    expect(h.config.ui.sidebarWidth).toBe(defaultConfig.ui.sidebarWidth);
  });

  test("back row routes to showRoot", () => {
    const h = mk();
    const cfg = h.groups().find((g) => g.header === "config")!.rows;
    const back = cfg.find((r) => r.label === "back")!;
    expect(back.kind).toBe("action");
    if (back.kind === "action") back.run();
    expect(h.roots()).toBe(1);
  });
});
