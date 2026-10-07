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
const mk = (plugins?: () => LoadedPlugin[], over: Partial<SettingsModelCtx> = {}) => {
  const config = structuredClone(defaultConfig);
  const state = { showHidden: false };
  const applied: Config[] = [];
  const warns: { message: string; title?: string }[] = [];
  let saves = 0;
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
    warn: (message, title) => {
      warns.push({ message, title });
    },
    ...(plugins ? { plugins } : {}),
    ...over,
  };
  const model = makeSettingModel(ctx);
  const groups = (): SettingGroup[] => model.settingGroups();
  const rows = (): SettingRow[] => groups().flatMap((g) => g.rows);
  const byLabel = (label: string): SettingRow => {
    const r = rows().find((x) => x.label === label);
    if (!r) throw new Error(`no row ${label}`);
    return r;
  };
  return { ctx, config, state, applied, warns, model, groups, rows, byLabel, saves: () => saves };
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

type MkHarness = ReturnType<typeof mk>;

// every gating master from the model: turning them all on surfaces the full
// inventory, turning one off hides exactly its dependents and nothing else
const MASTERS_ON: Record<string, boolean> = {
  fileAnimation: true,
  fileHoverAnimation: true,
  sidebarAnimation: true,
  sidebarHoverAnimation: true,
  topbarAnimation: true,
  directoryBarAnimation: true,
  previewEnabled: true,
  sidebarAutoHide: true,
  previewAutoHide: true,
  terminalAutoHide: true,
  listingsCache: true,
  windowedGrid: true,
};

const withMasters = (h: MkHarness, on: boolean): void => {
  for (const [prop, v] of Object.entries(MASTERS_ON)) {
    (h.config.ui as unknown as Record<string, unknown>)[prop] = on ? v : false;
  }
};

// section-scoped row lookup: knob labels repeat per animation section (the
// pinned duplicate set), so the section header disambiguates them
const inSection = (h: MkHarness, groupHeader: string, section: string, label: string): SettingRow => {
  const rows = h.groups().find((g) => g.header === groupHeader)?.rows ?? [];
  const start = rows.findIndex((r) => r.kind === "header" && r.label === section);
  const tail = start < 0 ? rows : rows.slice(start + 1);
  const end = tail.findIndex((r) => r.kind === "header");
  const scope = end < 0 ? tail : tail.slice(0, end);
  const r = scope.find((x) => x.label === label);
  if (!r) throw new Error(`no row ${label} in ${groupHeader}::${section}`);
  return r;
};

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
      "animations",
      "files & session",
      "behavior",
      "keys",
      "optimization",
      "advanced",
    ]);
  });

  test("every schema prop surfaces a GUI row (reachability, not label-uniqueness)", () => {
    const h = mk();
    withMasters(h, true);
    // knob labels intentionally repeat per animation section (the section
    // header supplies context: duration/travel/direction/spread/easing read
    // under ##files, ##sidebar intro, ##top bar, ##directory bar), so the
    // invariant keys on props: a row whose group doesn't match the table
    // would otherwise silently never render. "follow terminal" is the one
    // exception: it has no row of its own — the theme cycle's System entry
    // owns the knob (pinned below).
    const labels = h.groups().flatMap((g) => g.rows.map((r) => r.label));
    for (const row of UI_SCHEMA) {
      if (row.prop === "followTerminal") {
        expect(labels).not.toContain(row.label);
        continue;
      }
      expect(labels, `${row.prop} never surfaces`).toContain(row.label);
    }
  });

  test("only the animation knobs share labels (pinned duplicate set)", () => {
    const h = mk();
    withMasters(h, true);
    const counts = new Map<string, number>();
    for (const g of h.groups()) {
      for (const r of g.rows) {
        if (r.kind === "header") continue;
        counts.set(r.label, (counts.get(r.label) ?? 0) + 1);
      }
    }
    const dups = [...counts.entries()].filter(([, n]) => n > 1).sort(([a], [b]) => (a < b ? -1 : 1));
    // section header supplies the context (##files vs ##sidebar intro vs
    // ##top bar vs ##directory bar); a NEW duplicate outside this set is a
    // naming regression, not progressive disclosure
    expect(dups).toEqual([
      ["direction", 4],
      ["duration", 4],
      ["easing", 4],
      ["spread", 4],
      ["style", 3],
      ["travel", 4],
    ]);
  });

  test("every surfaced row carries a plain-language one-line blurb (description footer)", () => {
    const h = mk();
    withMasters(h, true);
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

  test("key labels fit the settings label column (detail lives in the footer blurb)", () => {
    // the keys view pairs each label with a 24-wide keybind column — a label
    // past the label column truncates mid-word, so verbose labels shorten and
    // carry their context in the footer blurb instead
    const h = mk();
    const kb = h.groups().find((g) => g.header === "keys")!.rows;
    for (const r of kb) {
      if (r.kind === "header") continue;
      expect(r.label.length).toBeLessThanOrEqual(27);
    }
  });

  test("auto-hide toggles and their hover timing share the layout category", () => {
    const h = mk();
    withMasters(h, true);
    const layout = h
      .groups()
      .find((g) => g.header === "layout")!
      .rows.map((r) => r.label);
    for (const label of ["sidebar auto-hide", "hover zone", "slide duration", "preview pane"]) {
      expect(layout).toContain(label);
    }
  });

  test("long groups carry section headers between topics (dividers)", () => {
    const h = mk();
    withMasters(h, true);
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
    expect(anim.indexOf("lift direction")).toBeLessThan(anim.indexOf("##sidebar intro"));
    expect(anim.indexOf("include logo")).toBeLessThan(anim.indexOf("##sidebar hover"));
    // every performance knob lives in the optimization category, nowhere here
    expect(anim).not.toContain("##performance");
    expect(anim).not.toContain("reveal delay");
  });

  test("optimization holds every performance knob (##rendering/##caching/##performance)", () => {
    const h = mk();
    withMasters(h, true);
    const seq = h
      .groups()
      .find((g) => g.header === "optimization")!
      .rows.map((r) => (r.kind === "header" ? `##${r.label}` : r.label));
    expect(seq).toEqual([
      "##rendering",
      "windowed grid",
      "loading delay",
      "##caching",
      "cache folder listings",
      "cache file stats",
      "cache age",
      "##performance",
      "one-layer fade",
      "visible only",
      "row cascade",
      "max animated files",
      "reveal delay",
    ]);
  });

  test("layout group is one surface-ordered category: view/sidebar/preview/terminal/panes/grid/list/timing", () => {
    const h = mk();
    withMasters(h, true);
    const layout = h
      .groups()
      .find((g) => g.header === "layout")!
      .rows.map((r) => (r.kind === "header" ? `##${r.label}` : r.label));
    expect(layout).toEqual([
      "##view",
      "view mode",
      "wrap mode",
      "tab bar",
      "##sidebar",
      "sidebar width",
      "sidebar title",
      "recent",
      "starred",
      "trash",
      "user folders",
      "bookmarks",
      "devices",
      "network",
      "sidebar auto-hide",
      "sidebar collapse",
      "##preview",
      "preview pane",
      "preview width",
      "preview auto-hide",
      "preview collapse",
      "##terminal",
      "terminal height",
      "terminal auto-hide",
      "terminal collapse",
      "##panes",
      "dual pane",
      "##grid",
      "grid tile width",
      "grid tile height",
      "grid icon size",
      "##list",
      "list row height",
      "##hover timing",
      "hover zone",
      "hover open delay",
      "hover close delay",
      "slide duration",
    ]);
  });

  test("behavior/appearance/files carry subsection dividers (related options grouped)", () => {
    const h = mk();
    const seq = (header: string): string[] =>
      h
        .groups()
        .find((g) => g.header === header)!
        .rows.map((r) => (r.kind === "header" ? `##${r.label}` : r.label));
    // every section headed (no trailing headerless rows): general leads,
    // mouse gestures share a section
    expect(seq("behavior")).toEqual([
      "##general",
      "type to search",
      "toast duration",
      "##mouse",
      "double-click",
      "drag threshold",
    ]);
    // hidden files splices in under the listing header; session persistence
    // is its own section
    expect(seq("files & session")).toEqual([
      "##listing",
      "hidden files",
      "recursive search",
      "sort mode",
      "##session",
      "restore session",
      "persistent undo",
    ]);
    // theme rides under the look header (its presets are the look), then
    // the compatibility pair — plain words only ("chrome" is jargon, and the
    // old `style` header would collide with the per-surface animation
    // `style` knob rows)
    expect(seq("appearance")).toEqual([
      "##look",
      "theme",
      "transparent bg",
      "icons",
      "icon style",
      "ui style",
      "##compatibility",
      "tty mode",
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
      "##split panes",
    ]);
    // spot-check section membership across the boundaries (preset leads)
    expect(seq.slice(0, 5)).toEqual(["keymap preset", "##app", "quit", "restart", "open menu"]);
    expect(seq.slice(seq.indexOf("##tabs") + 1, seq.indexOf("##tabs") + 5)).toEqual([
      "new tab",
      "close tab",
      "next tab",
      "previous tab",
    ]);
    expect(seq.slice(seq.indexOf("##split panes") + 1)).toEqual([
      "toggle dual pane",
      "switch pane",
      "copy to other pane",
      "move to other pane",
      "open terminal here",
    ]);
    expect(seq).toContain("connect to server");
    expect(seq.indexOf("connect to server")).toBeGreaterThan(seq.indexOf("##navigation"));
    expect(seq.indexOf("connect to server")).toBeLessThan(seq.indexOf("##view"));
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

  test("appearance/keys/optimization use the outline category icons", () => {
    // Outline slots (pure-outlines set): palette/keyboard/lightning-bolt. A
    // wrong slot name silently falls back to a generic glyph, so pin the
    // exact names. (pencil/sort/power stay for their own surfaces: rename
    // row, toolbar sort button, Quit.)
    const byHeader = new Map(
      mk()
        .groups()
        .map((g) => [g.header, g.icon]),
    );
    expect(byHeader.get("appearance")).toBe("palette");
    expect(byHeader.get("keys")).toBe("keyboard");
    expect(byHeader.get("optimization")).toBe("lightning-bolt");
  });

  test("every keybind action gets a row", () => {
    const h = mk();
    const kb = h.groups().find((g) => g.header === "keys")!.rows;
    expect(kb.length).toBe(KEY_SCHEMA.length + 8);
    expect(kb.filter((r) => r.kind !== "header" && r.label !== "keymap preset").every(isKeybind)).toBe(true);
  });

  test("hover controls share one vocabulary per mechanism (lift vs nudge)", () => {
    const h = mk();
    withMasters(h, true);
    const anim = h
      .groups()
      .find((g) => g.header === "animations")!
      .rows.map((r) => r.label);
    for (const label of [
      "lift icons",
      "lift labels",
      "lift direction",
      "nudge icons",
      "nudge labels",
      "nudge direction",
    ]) {
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
    // one surface, one home: widths, content toggles and auto-hide share layout
    expect(layout).toContain("sidebar width");
    expect(layout).toContain("preview pane");
    expect(layout).toContain("dual pane");
    const appearance = h
      .groups()
      .find((g) => g.header === "appearance")!
      .rows.map((r) => r.label);
    expect(appearance).not.toContain("sidebar width");
    expect(appearance).not.toContain("preview pane");
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
        "animations",
        "files & session",
        "behavior",
        "keys",
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
      expect(rows.map((r) => r.label)).toEqual(["enabled", "Say hello", "update from git", "remove…"]);
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
      const enabledChanges: Array<[string, boolean]> = [];
      const h = mk(() => [mkPlugin({ name: "hello", rows: [hello], store: makePluginStore(dir, "hello") })], {
        onPluginEnabledChanged: (name, enabled) => enabledChanges.push([name, enabled]),
      });
      const toggle = h.model.pluginGroups().find((g) => g.header === "hello")!.rows[0]!;
      if (toggle.kind !== "toggle") throw new Error("first plugin row must be the enabled toggle");
      // the toggle rebuilds the panel so the rows vanish/appear live
      expect(toggle.repaint).toBe(true);
      toggle.set(false);
      // the wiring must be told to drop the plugin's slots/action surfaces
      expect(enabledChanges).toEqual([["hello", false]]);
      expect(
        h.model
          .pluginGroups()
          .find((g) => g.header === "hello")!
          .rows.map((r) => r.label),
      ).toEqual(["enabled", "update from git", "remove…"]);
      toggle.set(true);
      expect(
        h.model
          .pluginGroups()
          .find((g) => g.header === "hello")!
          .rows.map((r) => r.label),
      ).toEqual(["enabled", "Say hello", "update from git", "remove…"]);
      expect(enabledChanges).toEqual([
        ["hello", false],
        ["hello", true],
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("installer category exists even without plugins (Plugins view is discoverable pre-install)", () => {
    for (const h of [mk(), mk(() => [])]) {
      expect(h.model.pluginGroups().map((g) => g.header)).toEqual(["add plugins"]);
      expect(h.model.pluginGroups()[0]!.rows.map((r) => r.label)).toEqual([
        "add from git URL…",
        "open plugins folder…",
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
      const res = asKeybind(h.byLabel("undo")).set(["ctrl+j"]); // owned by demo:hi
      expect(res).toEqual({ status: "rejected", spec: "ctrl+j" });
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
        "update from git",
        "remove…",
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

  test("stepper values carry units (ms tight-singular, % tight, cells singular at 1)", () => {
    const h = mk();
    withMasters(h, true);
    // knob labels repeat per animation section (pinned duplicate set above),
    // so section-scope the lookups — the section header is the context
    const files = (label: string): SettingRow => inSection(h, "animations", "files", label);
    const intro = (label: string): SettingRow => inSection(h, "animations", "sidebar intro", label);
    // ms must not singularize to "m" (the old /s$/ strip did exactly that)
    expect(asStepper(h.byLabel("double-click")).fmt(400)).toBe("400 ms");
    expect(asStepper(h.byLabel("double-click")).fmt(1)).toBe("1 ms");
    expect(asStepper(h.byLabel("toast duration")).fmt(3000)).toBe("3000 ms");
    expect(asStepper(h.byLabel("slide duration")).fmt(120)).toBe("120 ms");
    // percents render tight, no space
    expect(asStepper(files("spread")).fmt(40)).toBe("40%");
    expect(asStepper(files("travel")).fmt(70)).toBe("70%");
    // cells singularize only at 1
    expect(asStepper(h.byLabel("sidebar width")).fmt(26)).toBe("26 cells");
    expect(asStepper(h.byLabel("sidebar width")).fmt(1)).toBe("1 cell");
    expect(asStepper(intro("travel")).fmt(8)).toBe("8 cells");
    // counts + seconds
    expect(asStepper(h.byLabel("max animated files")).fmt(2000)).toBe("2000 files");
    expect(asStepper(h.byLabel("max animated files")).fmt(1)).toBe("1 file");
    expect(asStepper(h.byLabel("cache age")).fmt(2)).toBe("2 s");
  });

  test("panel-repainting rows are flagged (theme / ui style / transparent bg / icons)", () => {
    const h = mk();
    for (const label of ["theme", "ui style", "transparent bg", "icons"]) {
      const row = h.byLabel(label);
      expect("repaint" in row && row.repaint).toBe(true);
    }
    const plain = h.byLabel("wrap mode");
    expect("repaint" in plain && plain.repaint).toBeFalsy();
  });

  test("cold-boot-only rows carry the restart flag (sidebar/topbar intro + session + launch time)", () => {
    const h = mk();
    withMasters(h, true);
    for (const label of ["restore session", "launch time", "sidebar animation", "top bar animation"]) {
      const row = h.byLabel(label);
      expect("restart" in row && row.restart, `${label} should need restart`).toBe(true);
    }
    // knob labels repeat per animation section — scope them
    for (const [section, labels] of [
      ["sidebar intro", ["style", "duration", "travel", "direction", "spread", "easing", "include logo"]],
      ["top bar", ["style", "duration", "travel", "direction", "spread", "easing"]],
    ] as Array<[string, string[]]>) {
      for (const label of labels) {
        const row = inSection(h, "animations", section, label);
        expect("restart" in row && row.restart, `${section}/${label} should need restart`).toBe(true);
      }
    }
    // live neighbors stay unflagged
    for (const label of ["dual pane", "sidebar auto-hide", "persistent undo", "directory bar animation"]) {
      const row = h.byLabel(label);
      expect("restart" in row && row.restart, `${label} should be live`).toBeFalsy();
    }
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
    (h.ctx as SettingsModelCtx).isTtyMode = () => true;
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
  test("conflicting bind returns a swap offer: no commit, no warn (panel offers Enter-to-swap)", () => {
    const h = mk();
    const undo = h.byLabel("undo");
    expect(undo.kind).toBe("keybind");
    const res = asKeybind(undo).set(["ctrl+q"]); // owned by quit
    expect(res).toEqual({ status: "conflict", spec: "ctrl+q", owner: "quit", ownerLabel: "quit" });
    expect(h.warns.length).toBe(0);
    expect(h.applied.length).toBe(0);
    expect(h.config.keys.undo).toEqual(defaultConfig.keys.undo);
  });

  test("swap() steals the bind in one commit, owner keeps its other binds", () => {
    const h = mk();
    h.config.keys.quit = ["ctrl+q", "alt+q"];
    const undo = asKeybind(h.byLabel("undo"));
    undo.swap?.("ctrl+q");
    expect(h.applied.length).toBe(1);
    expect(h.config.keys.undo).toEqual(["ctrl+q"]);
    expect(h.config.keys.quit).toEqual(["alt+q"]);
  });

  test("swap() when the owner moved on just sets the bind", () => {
    const h = mk();
    h.config.keys.quit = ["alt+q"]; // ctrl+q now free
    asKeybind(h.byLabel("undo")).swap?.("ctrl+q");
    expect(h.applied.length).toBe(1);
    expect(h.config.keys.undo).toEqual(["ctrl+q"]);
  });

  test("second core bind onto the same spec re-offers (still no commit)", () => {
    const h = mk();
    h.config.keys.undo = ["ctrl+b"];
    const res = asKeybind(h.byLabel("quit")).set(["ctrl+b"]);
    expect(res).toEqual({ status: "conflict", spec: "ctrl+b", owner: "undo", ownerLabel: "undo" });
    expect(h.applied.length).toBe(0);
  });

  test("free bind commits through commitKeys, other actions untouched", () => {
    const h = mk();
    asKeybind(h.byLabel("undo")).set(["ctrl+b"]);
    expect(h.applied.length).toBe(1);
    expect(h.config.keys.undo).toEqual(["ctrl+b"]);
    expect(h.config.keys.quit).toEqual(defaultConfig.keys.quit);
  });

  test("get reads the live config (remaps visible without rebuild)", () => {
    const h = mk();
    h.config.keys.redo = ["ctrl+j"];
    const row = h.byLabel("redo");
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
      for (const row of demo.rows.filter((r) => r.label === "update from git" || r.label === "remove…")) {
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
      for (const label of ["add from git URL…", "open plugins folder…", "update from git", "remove…"]) {
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

describe("dependent rows hide behind their master toggle (progressive disclosure)", () => {
  const labelsOf = (h: MkHarness, header: string): string[] =>
    h
      .groups()
      .find((g) => g.header === header)!
      .rows.map((r) => (r.kind === "header" ? `##${r.label}` : r.label));

  test("factory defaults show only masters: dependents hidden, sections pruned", () => {
    const h = mk();
    // animations: every intro/hover/files section collapses to its master
    expect(labelsOf(h, "animations")).toEqual([
      "##files",
      "file animation",
      "##file hover",
      "lift icons",
      "##sidebar intro",
      "sidebar animation",
      "##sidebar hover",
      "nudge icons",
      "##top bar",
      "top bar animation",
      "##directory bar",
      "directory bar animation",
    ]);
    // layout: collapse styles and gated widths hidden; hover timing gone entirely
    expect(labelsOf(h, "layout")).toEqual([
      "##view",
      "view mode",
      "wrap mode",
      "tab bar",
      "##sidebar",
      "sidebar width",
      "sidebar title",
      "recent",
      "starred",
      "trash",
      "user folders",
      "bookmarks",
      "devices",
      "network",
      "sidebar auto-hide",
      "##preview",
      "preview pane",
      "##terminal",
      "terminal height",
      "terminal auto-hide",
      "##panes",
      "dual pane",
      "##grid",
      "grid tile width",
      "grid tile height",
      "grid icon size",
      "##list",
      "list row height",
    ]);
    // optimization: the listings cache defaults on, so its stats rows show;
    // (flipping it off hides them — pinned below). The perf knobs need file
    // animation (off by default), but reveal delay answers to windowed grid
    // alone (on) — so ##performance keeps one row at defaults.
    expect(labelsOf(h, "optimization")).toEqual([
      "##rendering",
      "windowed grid",
      "loading delay",
      "##caching",
      "cache folder listings",
      "cache file stats",
      "cache age",
      "##performance",
      "reveal delay",
    ]);
  });

  test("flipping one master reveals exactly its dependents", () => {
    const h = mk();
    h.config.ui.previewEnabled = true;
    expect(labelsOf(h, "layout")).toContain("preview width");
    expect(labelsOf(h, "layout")).toContain("preview auto-hide");
    expect(labelsOf(h, "layout")).not.toContain("preview collapse");
    h.config.ui.previewAutoHide = true;
    expect(labelsOf(h, "layout")).toContain("preview collapse");
    h.config.ui.previewEnabled = false;
    expect(labelsOf(h, "layout")).not.toContain("preview width");
    expect(labelsOf(h, "layout")).not.toContain("preview auto-hide");
    expect(labelsOf(h, "layout")).not.toContain("preview collapse");
    // listings cache off hides its stats rows but keeps the master
    // (reveal delay rides windowed grid, still on)
    h.config.ui.listingsCache = false;
    expect(labelsOf(h, "optimization")).toEqual([
      "##rendering",
      "windowed grid",
      "loading delay",
      "##caching",
      "cache folder listings",
      "##performance",
      "reveal delay",
    ]);
  });

  test("reveal delay follows windowed grid alone (the switch users find)", () => {
    const h = mk();
    // windowed grid defaults on: the delay shows even with file animation off
    expect(labelsOf(h, "optimization")).toContain("reveal delay");
    h.config.ui.windowedGrid = false;
    expect(labelsOf(h, "optimization")).not.toContain("reveal delay");
    h.config.ui.windowedGrid = true;
    expect(labelsOf(h, "optimization")).toContain("reveal delay");
  });

  test("perf knobs hide with file animation (reveal delay excepted)", () => {
    const h = mk();
    withMasters(h, true);
    expect(labelsOf(h, "optimization")).toContain("one-layer fade");
    expect(labelsOf(h, "optimization")).toContain("reveal delay");
    h.config.ui.fileAnimation = false;
    expect(labelsOf(h, "optimization")).not.toContain("one-layer fade");
    expect(labelsOf(h, "optimization")).not.toContain("max animated files");
    // reveal delay answers to windowed grid only, so it stays
    expect(labelsOf(h, "optimization")).toContain("reveal delay");
  });

  test("hover timing appears when any auto-hide turns on, with its header", () => {
    const h = mk();
    expect(labelsOf(h, "layout")).not.toContain("##hover timing");
    h.config.ui.terminalAutoHide = true;
    const layout = labelsOf(h, "layout");
    expect(layout).toContain("##hover timing");
    for (const label of ["hover zone", "hover open delay", "hover close delay", "slide duration"]) {
      expect(layout).toContain(label);
    }
    expect(layout).toContain("terminal collapse");
  });

  test("gating masters rebuild the panel (repaint) so children appear live", () => {
    const h = mk();
    withMasters(h, true);
    for (const label of [
      "file animation",
      "lift icons",
      "sidebar animation",
      "nudge icons",
      "top bar animation",
      "directory bar animation",
      "preview pane",
      "sidebar auto-hide",
      "preview auto-hide",
      "terminal auto-hide",
      "cache folder listings",
      "windowed grid",
    ]) {
      const row = h.byLabel(label);
      expect("repaint" in row && row.repaint, `${label} should rebuild`).toBe(true);
    }
    // dependents themselves paint by id (no rebuild needed)
    const plain = h.byLabel("toast duration");
    expect("repaint" in plain && plain.repaint).toBeFalsy();
  });
});
