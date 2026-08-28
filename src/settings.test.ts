import { describe, expect, test } from "bun:test";
import { applyAdjust, flattenRows, themePresetIdx, type SettingGroup, type SettingRow } from "./settings";
import { THEME_PRESETS } from "./themes";

const rec = () => {
  const calls: string[] = [];
  return { calls, log: (s: string) => calls.push(s) };
};

describe("applyAdjust", () => {
  test("toggle inverts through the getter/setter pair", () => {
    const r = rec();
    let v = false;
    const row: SettingRow = { kind: "toggle", label: "t", get: () => v, set: (x) => { v = x; r.log(`set ${x}`); } };
    expect(applyAdjust(row, 1)).toBe(true);
    expect(v).toBe(true);
    expect(r.calls).toEqual(["set true"]);
  });

  test("stepper steps by step within min/max", () => {
    let v = 20;
    const proper: SettingRow = { kind: "stepper", label: "s", min: 16, max: 60, step: 2, fmt: (x) => `${x}`, get: () => v, set: (x) => { v = x; } };
    expect(applyAdjust(proper, 1)).toBe(true);
    expect(v).toBe(22);
    expect(applyAdjust(proper, -1)).toBe(true);
    expect(v).toBe(20);
    expect(applyAdjust(proper, -1)).toBe(true);
    expect(v).toBe(18);
  });

  test("stepper clamps at min and reports false when pinned", () => {
    let v = 17;
    const row: SettingRow = { kind: "stepper", label: "s", min: 16, max: 60, step: 2, fmt: (x) => `${x}`, get: () => v, set: (x) => { v = x; } };
    expect(applyAdjust(row, -1)).toBe(true); // 17 → 16 (clamped, changed)
    expect(v).toBe(16);
    expect(applyAdjust(row, -1)).toBe(false); // pinned — no set() call
    expect(v).toBe(16);
  });

  test("cycle wraps forward and backward", () => {
    let idx = 0;
    const row: SettingRow = { kind: "cycle", label: "c", names: ["a", "b", "c"], getIdx: () => idx, setIdx: (i) => { idx = i; } };
    expect(applyAdjust(row, 1)).toBe(true);
    expect(idx).toBe(1);
    expect(applyAdjust(row, 1)).toBe(true);
    expect(idx).toBe(2);
    expect(applyAdjust(row, 1)).toBe(true);
    expect(idx).toBe(0); // wraps forward
    expect(applyAdjust(row, -1)).toBe(true);
    expect(idx).toBe(2); // wraps backward
  });

  test("cycle with getIdx() < 0 (custom value) picks an end based on direction", () => {
    let idx = -1;
    let set = -9;
    const row: SettingRow = { kind: "cycle", label: "c", names: ["a", "b"], getIdx: () => idx, setIdx: (i) => { set = i; } };
    applyAdjust(row, 1);
    expect(set).toBe(0);
    applyAdjust(row, -1);
    expect(set).toBe(1);
    expect(idx).toBe(-1); // setIdx owns the state; getIdx untouched
  });

  test("action rows never adjust", () => {
    const r = rec();
    const row: SettingRow = { kind: "action", label: "a", run: () => r.log("ran") };
    expect(applyAdjust(row, 1)).toBe(false);
    expect(r.calls).toEqual([]);
  });
});

describe("flattenRows", () => {
  test("concatenates group rows in order", () => {
    const groups: SettingGroup[] = [
      { rows: [{ kind: "action", label: "one", run: () => {} }] },
      { header: "h", rows: [{ kind: "action", label: "two", run: () => {} }, { kind: "action", label: "three", run: () => {} }] },
    ];
    expect(flattenRows(groups).map((r) => r.label)).toEqual(["one", "two", "three"]);
  });
});

describe("themePresetIdx", () => {
  test("finds the preset matching the live theme, -1 when customized", () => {
    const live = structuredClone(THEME_PRESETS[1]!.theme);
    expect(themePresetIdx(THEME_PRESETS, live)).toBe(1);
    live.bg = "#000001"; // any mutation → customized
    expect(themePresetIdx(THEME_PRESETS, live)).toBe(-1);
  });
});
