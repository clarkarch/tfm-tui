import { describe, expect, test } from "bun:test";
import { parse } from "smol-toml";
import { KEY_SCHEMA, defaultConfig, keybindConflict, parseConfigDoc, serializeConfig } from "./config-schema";
import { parseKeySpec } from "./keyspec";
import { PRESET_VIEW_MODE, keymapPresetIdx, presetKeys, yaziKeys } from "./keymap-presets";

describe("keymap presets", () => {
  test("tfm preset equals the schema defaults", () => {
    expect(presetKeys("tfm")).toEqual(defaultConfig.keys);
  });

  test("every table covers every KeyAction with parseable specs", () => {
    for (const name of ["tfm", "yazi"] as const) {
      const table = presetKeys(name);
      expect(Object.keys(table).sort()).toEqual(KEY_SCHEMA.map((r) => r.action).sort());
      for (const [action, binds] of Object.entries(table)) {
        for (const spec of binds) {
          expect(parseKeySpec(spec), `${name}:${action}:${spec}`).not.toBeNull();
        }
      }
    }
  });

  test("no preset binds one spec to two actions (would shadow at runtime)", () => {
    for (const name of ["tfm", "yazi"] as const) {
      const cfg = { ...structuredClone(defaultConfig), keys: presetKeys(name) };
      for (const row of KEY_SCHEMA) {
        for (const spec of cfg.keys[row.action]) {
          expect(keybindConflict(cfg, row.action, spec), `${name}:${row.action}:${spec}`).toBeNull();
        }
      }
    }
  });

  test("yazi preset carries the hjkl core", () => {
    const y = yaziKeys();
    expect(y.moveDown).toContain("j");
    expect(y.moveUp).toContain("k");
    expect(y.parentDir).toContain("h");
    expect(y.openSelected).toContain("l");
    expect(y.copy).toContain("y");
    expect(y.paste).toContain("p");
    expect(y.trash).toContain("d");
    expect(y.toggleFocused).toContain("space");
  });

  test("preset view flip: yazi forces list, tfm forces grid", () => {
    expect(PRESET_VIEW_MODE).toEqual({ tfm: "grid", yazi: "list" });
  });

  test("keymapPresetIdx recognizes both tables, -1 for hand edits", () => {
    expect(keymapPresetIdx(presetKeys("tfm"))).toBe(0);
    expect(keymapPresetIdx(presetKeys("yazi"))).toBe(1);
    expect(keymapPresetIdx({ ...presetKeys("tfm"), quit: ["ctrl+q", "q"] })).toBe(-1);
  });

  test("yazi preset round-trips a save+load: explicit unbinds survive", () => {
    // the preset persists [] for duplicate/reloadPlaces; if parsing reverts an
    // empty array to the default, the reloaded preset re-binds ctrl+d and
    // lands ctrl+r on two actions while reading as "custom"
    const cfg = { ...structuredClone(defaultConfig), keys: presetKeys("yazi") };
    const reloaded = parseConfigDoc(parse(serializeConfig(cfg)));
    expect(reloaded.keys).toEqual(cfg.keys);
    expect(keymapPresetIdx(reloaded.keys)).toBe(1);
  });
});
