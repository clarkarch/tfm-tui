import { describe, expect, test } from "bun:test";
import { makeSettingModel, type SettingsModelCtx } from "./settings-model";
import { defaultConfig, KEY_SCHEMA, type Config } from "../config/config-schema";
import { THEME_PRESETS } from "../config/themes";
import type { SettingGroup, SettingRow } from "./settings";

// The fake ctx mirrors the REAL applyConfig contract (ui-retheme): it merges
// the fresh object's sections into the live config via Object.assign — rows
// read through ctx.config on every call, so a fake that ignored the merge
// would lie about coverage (AGENTS.md fake-guard rule).
const mk = () => {
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
    expect(h.groups().map((g) => g.header)).toEqual(["general", "layout", "behavior", "keybindings", "config"]);
  });

  test("every keybind action gets a row", () => {
    const h = mk();
    const kb = h.groups().find((g) => g.header === "keybindings")!.rows;
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
    expect(asCycle(row).names).toEqual(["solid", "outline"]);
    asCycle(row).setIdx(1);
    expect(h.config.ui.uiStyle).toBe("outline");
  });

  test("panel-repainting rows are flagged (theme / ui style / transparent bg)", () => {
    const h = mk();
    for (const label of ["theme", "ui style", "transparent bg"]) {
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
    asKeybind(h.byLabel("undo last file op")).set(["ctrl+g"]);
    expect(h.applied.length).toBe(1);
    expect(h.config.keys.undo).toEqual(["ctrl+g"]);
    expect(h.config.keys.quit).toEqual(defaultConfig.keys.quit);
  });

  test("get reads the live config (remaps visible without rebuild)", () => {
    const h = mk();
    h.config.keys.redo = ["ctrl+j"];
    const row = h.byLabel("redo (ctrl+shift+z works too)");
    expect(asKeybind(row).get()).toEqual(["ctrl+j"]);
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
