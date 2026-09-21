import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { makeSettingModel, type SettingsModelCtx } from "./settings-model";
import { defaultConfig, KEY_SCHEMA, UI_SCHEMA, type Config } from "../config/config-schema";
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
  version: "",
  author: "",
  description: "",
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
  test("headers in the documented order (everyday priority: look first, tuning last)", () => {
    const h = mk();
    expect(h.groups().map((g) => g.header)).toEqual([
      "appearance",
      "layout",
      "files & session",
      "behavior",
      "panes",
      "keys",
      "animations",
      "optimization",
      "advanced",
    ]);
  });

  test("every schema row is reachable in exactly one GUI category", () => {
    const h = mk();
    // label is unique per core row; a row that lost its group would silently
    // never render (the discoverability invariant this regroup must protect).
    // "follow terminal" is the one exception: it has no row of its own — the
    // theme cycle's System entry owns the knob (pinned below).
    const labels = h.groups().flatMap((g) => g.rows.map((r) => r.label));
    for (const row of UI_SCHEMA) {
      if (row.prop === "followTerminal") {
        expect(labels).not.toContain(row.label);
        continue;
      }
      expect(labels.filter((l) => l === row.label)).toHaveLength(1);
    }
  });

  test("every surfaced row carries a plain-language one-line blurb (description footer)", () => {
    const h = mk();
    // the footer shows `blurb`, never the TOML `doc` (ranges, true/false,
    // units) — a blurb that leaks tech markers regresses to doc-paste.
    const banned = ["..", "true", "false", "cells", "ms"];
    const rows = h.groups().flatMap((g) => g.rows);
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      if (r.kind === "header") continue;
      const blurb = (r as { blurb?: unknown }).blurb;
      expect(typeof blurb).toBe("string");
      const text = blurb as string;
      expect(text.length).toBeGreaterThan(0);
      expect(text.length).toBeLessThanOrEqual(60);
      expect(/\d/.test(text)).toBe(false);
      for (const marker of banned) expect(text).not.toContain(marker);
    }
  });

  test("auto-hide toggles and their hover timing share the panes category", () => {
    const h = mk();
    const panes = h
      .groups()
      .find((g) => g.header === "panes")!
      .rows.map((r) => r.label);
    for (const label of ["sidebar auto-hide", "hover zone", "hover animation", "preview pane"]) {
      expect(panes).toContain(label);
    }
  });

  test("long groups carry section headers between topics (dividers)", () => {
    const h = mk();
    const anim = h
      .groups()
      .find((g) => g.header === "animations")!
      .rows.map((r) => (r.kind === "header" ? `##${r.label}` : r.label));
    expect(anim).toContain("##files");
    expect(anim).toContain("##file hover");
    expect(anim).toContain("##sidebar intro");
    expect(anim).toContain("##sidebar hover");
    expect(anim).toContain("##top bar");
    expect(anim).toContain("##directory bar");
    // the FIRST section gets a divider too — headers sit before AND between topics
    expect(anim[0]).toBe("##files");
    expect(anim.indexOf("file animation")).toBeGreaterThan(anim.indexOf("##files"));
    expect(anim.indexOf("file animation")).toBeLessThan(anim.indexOf("##file hover"));
    expect(anim.indexOf("hover lift direction")).toBeLessThan(anim.indexOf("##sidebar intro"));
    expect(anim.indexOf("include title in intro")).toBeLessThan(anim.indexOf("##sidebar hover"));
  });

  test("panes group carries auto-hide / hover-timing section headers", () => {
    const h = mk();
    const panes = h
      .groups()
      .find((g) => g.header === "panes")!
      .rows.map((r) => (r.kind === "header" ? `##${r.label}` : r.label));
    expect(panes[0]).toBe("##panes");
    expect(panes).toContain("##auto-hide");
    expect(panes).toContain("##hover timing");
    expect(panes.indexOf("preview pane")).toBeGreaterThan(panes.indexOf("##panes"));
    expect(panes.indexOf("dual pane")).toBeLessThan(panes.indexOf("##auto-hide"));
    expect(panes.indexOf("hover animation")).toBeGreaterThan(panes.indexOf("##hover timing"));
  });

  test("layout group sections sizes/grid/list/view, terminal height beside the widths", () => {
    const h = mk();
    const layout = h
      .groups()
      .find((g) => g.header === "layout")!
      .rows.map((r) => (r.kind === "header" ? `##${r.label}` : r.label));
    expect(layout).toEqual([
      "view mode",
      "##sizes",
      "sidebar width",
      "preview width",
      "terminal height",
      "##grid",
      "grid tile width",
      "grid tile height",
      "grid icon size",
      "word wrap (grid)",
      "##list",
      "list row height",
    ]);
  });

  test("behavior/appearance/files carry subsection dividers (related options grouped)", () => {
    const h = mk();
    const seq = (header: string): string[] =>
      h
        .groups()
        .find((g) => g.header === header)!
        .rows.map((r) => (r.kind === "header" ? `##${r.label}` : r.label));
    // type-to-search leads (highest traffic); mouse gestures share a section, the lone toast trails headerless
    expect(seq("behavior")).toEqual([
      "type to search",
      "##mouse",
      "double-click ms",
      "drag threshold",
      "gpm mouse",
      "toast duration",
    ]);
    // hidden files leads into its listing topic; session persistence is its own section
    expect(seq("files & session")).toEqual([
      "hidden files",
      "##listing",
      "recursive search",
      "##session",
      "restore session",
      "persistent undo",
    ]);
    // theme preset leads, then style, chrome (sidebar title with tab bar
    // trailing it), and the compatibility pair bottoms out the group
    expect(seq("appearance")).toEqual([
      "theme",
      "##style",
      "transparent bg",
      "icons",
      "ui style",
      "##chrome",
      "sidebar title",
      "tab bar",
      "##compatibility",
      "compat mode",
      "force glyph",
    ]);
  });

  test("keys category groups binds under subsection dividers", () => {
    const h = mk();
    const kb = h.groups().find((g) => g.header === "keys")!.rows;
    const seq = kb.map((r) => (r.kind === "header" ? `##${r.label}` : r.label));
    expect(kb.length).toBe(KEY_SCHEMA.length + 8);
    expect(seq.filter((s) => s.startsWith("##"))).toEqual([
      "##app",
      "##tabs",
      "##files",
      "##navigation",
      "##selection",
      "##view",
      "##panes",
    ]);
    // spot-check section membership across the boundaries (preset leads)
    expect(seq.slice(0, 5)).toEqual(["keymap preset", "##app", "quit tfm", "restart tfm", "open the esc menu"]);
    expect(seq.slice(seq.indexOf("##tabs") + 1, seq.indexOf("##tabs") + 5)).toEqual([
      "new tab",
      "close tab",
      "next tab (cycle)",
      "previous tab (cycle)",
    ]);
    expect(seq.slice(seq.indexOf("##panes") + 1)).toEqual([
      "toggle dual pane",
      "switch active pane (dual pane)",
      "copy selection to the other pane",
      "move selection to the other pane",
      "open terminal here",
    ]);
    expect(seq).toContain("connect to a network server (gvfs)");
    expect(seq.indexOf("connect to a network server (gvfs)")).toBeGreaterThan(seq.indexOf("##navigation"));
    expect(seq.indexOf("connect to a network server (gvfs)")).toBeLessThan(seq.indexOf("##view"));
  });

  test("keymap preset row applies the yazi batch + type-to-search flip + list view", () => {
    const h = mk();
    const row = h.byLabel("keymap preset");
    if (row.kind !== "cycle") throw new Error("keymap preset must be a cycle");
    expect(row.names).toEqual(["tfm", "yazi"]);
    expect(row.getIdx()).toBe(0);
    row.setIdx(1);
    expect(h.config.keys.moveDown).toEqual(["down", "j"]);
    expect(h.config.keys.copy).toEqual(["y"]);
    expect(h.config.ui.typeToSearch).toBe(false);
    expect(h.config.ui.viewMode).toBe("list");
    expect(h.saves()).toBe(1);
    expect(h.warns.at(-1)?.title).toBe("keymap preset");
    expect(h.warns.at(-1)?.message).toContain("list view");
    // switching back restores canonical defaults exactly (batch, no stash)
    row.setIdx(0);
    expect(h.config.keys).toEqual(defaultConfig.keys);
    expect(h.config.ui.typeToSearch).toBe(true);
    expect(h.config.ui.viewMode).toBe("grid");
  });

  test("keymap preset row is repaint (batch rewrites every row's value)", () => {
    const h = mk();
    const row = h.byLabel("keymap preset");
    if (row.kind !== "cycle") throw new Error("keymap preset must be a cycle");
    expect(row.repaint).toBe(true);
  });

  test("keymap preset row reports custom once hand-edited", () => {
    const h = mk();
    h.config.keys.quit = ["ctrl+q", "q"];
    const row = h.byLabel("keymap preset");
    if (row.kind !== "cycle") throw new Error("keymap preset must be a cycle");
    expect(row.getIdx()).toBe(-1);
    expect(row.customLabel?.()).toBe("custom");
  });

  test("terminal height stepper commits through the ui patch", () => {
    const h = mk();
    const row = h.byLabel("terminal height");
    if (row.kind !== "stepper") throw new Error("terminal height must be a stepper");
    expect(row.get()).toBe(12);
    row.set(16);
    expect(h.config.ui.terminalHeight).toBe(16);
    expect(h.applied[h.applied.length - 1]!.ui.terminalHeight).toBe(16);
    expect(h.saves()).toBe(1);
  });

  test("section headers never collide with schema row labels (discoverability invariant)", () => {
    const h = mk();
    const schemaLabels = new Set(UI_SCHEMA.map((r) => r.label));
    for (const g of h.groups()) {
      for (const r of g.rows) {
        if (r.kind === "header") expect(schemaLabels.has(r.label)).toBe(false);
      }
    }
  });

  test("every core category carries an icon (silent-fallback guard)", () => {
    for (const g of mk().groups()) expect(typeof g.icon).toBe("string");
  });

  test("every keybind action gets a row", () => {
    const h = mk();
    const kb = h.groups().find((g) => g.header === "keys")!.rows;
    expect(kb.length).toBe(KEY_SCHEMA.length + 8);
    expect(kb.filter((r) => r.kind !== "header" && r.label !== "keymap preset").every(isKeybind)).toBe(true);
  });

  test("hover lift controls live in animations under sensible labels", () => {
    const anim = mk()
      .groups()
      .find((g) => g.header === "animations")!
      .rows.map((r) => r.label);
    for (const label of ["tile hover animation", "include filename in lift", "hover lift direction"]) {
      expect(anim).toContain(label);
    }
    expect(anim).not.toContain("tile hover pop");
    expect(anim).not.toContain("hover lift distance");
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
      // settings groups stay frozen at the core categories…
      expect(
        mk(plug)
          .groups()
          .map((g) => g.header),
      ).toEqual([
        "appearance",
        "layout",
        "files & session",
        "behavior",
        "panes",
        "keys",
        "animations",
        "optimization",
        "advanced",
      ]);
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

  test("panel-repainting rows are flagged (theme / ui style / transparent bg / icons)", () => {
    const h = mk();
    for (const label of ["theme", "ui style", "transparent bg", "icons"]) {
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
    // index 0 is the System entry — presets sit behind it at +1
    asCycle(row).setIdx(2);
    expect(h.config.theme).toEqual(THEME_PRESETS[1]!.theme);
    expect(h.config.theme).not.toBe(THEME_PRESETS[1]!.theme); // fresh copy, not the preset object
    expect(h.config.ui.followTerminal).toBe(false);
  });

  test("theme cycle leads with System: select flips follow-terminal + resolves", () => {
    let resolved = 0;
    const h = mk();
    (h.ctx as SettingsModelCtx).resolveSystemTheme = () => {
      resolved++;
    };
    const row = h.byLabel("theme");
    expect(asCycle(row).names[0]).toBe("System");
    expect(asCycle(row).names[1]).toBe(THEME_PRESETS[0]!.name);
    // default config is Tokyo Night at preset 0 → cycle index 1
    expect(asCycle(row).getIdx()).toBe(1);
    asCycle(row).setIdx(0);
    expect(h.config.ui.followTerminal).toBe(true);
    expect(resolved).toBe(1);
    expect(asCycle(h.byLabel("theme")).getIdx()).toBe(0);
    // picking a preset leaves System mode
    asCycle(h.byLabel("theme")).setIdx(1);
    expect(h.config.ui.followTerminal).toBe(false);
    expect(h.config.theme).toEqual(THEME_PRESETS[0]!.theme);
  });

  test("no standalone follow-terminal row exists (System owns the knob)", () => {
    const h = mk();
    expect(h.rows().filter((r) => r.label === "follow terminal")).toHaveLength(0);
  });

  test("hand-edited theme reports ~nearest preset, exact match reports none needed", () => {
    const h = mk();
    const row = h.byLabel("theme");
    if (row.kind !== "cycle" || !row.customLabel) throw new Error("theme row must be a cycle with customLabel");
    // default config IS Tokyo Night (preset 0) — behind the System entry at 1
    expect(row.getIdx()).toBe(1);
    h.config.theme = { ...THEME_PRESETS[2]!.theme, bg: "#000000" };
    expect(row.getIdx()).toBe(-1);
    expect(row.customLabel()).toBe(`~${THEME_PRESETS[2]!.name}`);
  });

  test("console mode: theme row is display-only (adjust warns, commits nothing)", () => {
    const h = mk();
    (h.ctx as SettingsModelCtx).compatActive = () => true;
    const row = h.byLabel("theme");
    if (row.kind !== "cycle" || !row.customLabel) throw new Error("theme row must be a cycle with customLabel");
    expect(row.getIdx()).toBe(-1);
    expect(row.customLabel()).toBe("Console"); // dark default config
    const before = structuredClone(h.config.theme);
    asCycle(row).setIdx(2);
    expect(h.config.theme).toEqual(before); // no commit
    expect(h.applied).toHaveLength(0);
    expect(h.warns).toHaveLength(1);
    expect(h.warns[0]!.title).toBe("theme");
    h.config.theme = { ...h.config.theme, bg: "#e1e2e7" };
    expect(row.customLabel()).toBe("Console Light");
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

  test("advanced has no back row (esc closes the menu)", () => {
    const h = mk();
    const cfg = h.groups().find((g) => g.header === "advanced")!.rows;
    expect(cfg.some((r) => r.label === "back")).toBe(false);
    expect(cfg.map((r) => r.label)).toContain("reset to defaults");
    expect(cfg.map((r) => r.label)).toContain("edit config.toml…");
  });
});

describe("plugin manifest header", () => {
  test("version/author/description surface in the category header (name-only when absent)", () => {
    const h = mk(() => [
      mkPlugin({ name: "meta", version: "1.2.3", author: "someone", description: "does things", rows: [] }),
      mkPlugin({ name: "plain", rows: [] }),
    ]);
    const headers = h.model.pluginGroups().map((g) => g.header);
    expect(headers).toContain("meta · 1.2.3 · someone · does things");
    expect(headers).toContain("plain");
  });
});
