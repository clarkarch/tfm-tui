// --- Keybind vocabulary tests: parse / validate / match / compare. These moved
// with the module out of config-schema.test.ts (which now covers the key table
// and the KEY_ROWS-driven conflict check). ---
import { describe, expect, test } from "bun:test";
import { keyMatch, keySpecEqual, keySpecFromEvent, parseKeySpec, validateKeybindSpec } from "./keyspec";

describe("key specs", () => {
  test("parseKeySpec", () => {
    expect(parseKeySpec("ctrl+q")).toEqual({ name: "q", ctrl: true, shift: false, meta: false });
    expect(parseKeySpec("ctrl+shift+tab")).toEqual({ name: "tab", ctrl: true, shift: true, meta: false });
    expect(parseKeySpec("alt+x")).toEqual({ name: "x", ctrl: false, shift: false, meta: true });
    expect(parseKeySpec("escape")).toEqual({ name: "escape", ctrl: false, shift: false, meta: false });
    expect(parseKeySpec("ctrl+")).toBeNull();
    expect(parseKeySpec("ctrl+a+b")).toBeNull();
    expect(parseKeySpec("")).toBeNull();
  });

  test("keyMatch honors modifiers exactly", () => {
    const ctrlQ = parseKeySpec("ctrl+q")!;
    expect(keyMatch({ name: "q", ctrl: true }, ctrlQ)).toBe(true);
    expect(keyMatch({ name: "q" }, ctrlQ)).toBe(false);
    expect(keyMatch({ name: "q", ctrl: true, shift: true }, ctrlQ)).toBe(false);
    expect(keyMatch({ name: "q", meta: true }, ctrlQ)).toBe(false);
  });

  test("keyMatch falls back to kitty baseCode (non-Latin layouts)", () => {
    const ctrlC = parseKeySpec("ctrl+c")!;
    expect(keyMatch({ name: "ㅊ", baseCode: 99, ctrl: true }, ctrlC)).toBe(true);
  });

  test("keySpecFromEvent", () => {
    expect(keySpecFromEvent({ name: "q", ctrl: true })).toBe("ctrl+q");
    expect(keySpecFromEvent({ name: "tab", ctrl: true, shift: true })).toBe("ctrl+shift+tab");
    expect(keySpecFromEvent({ name: "delete" })).toBe("delete");
    expect(keySpecFromEvent({ name: "" })).toBeNull();
    expect(keySpecFromEvent({})).toBeNull();
  });

  test("validateKeybindSpec reserves bare type-to-search keys", () => {
    expect(validateKeybindSpec("q")).toContain("type-to-search");
    expect(validateKeybindSpec("5")).toContain("type-to-search");
    expect(validateKeybindSpec("ctrl+q")).toBeNull();
    expect(validateKeybindSpec("f2")).toBeNull();
    expect(validateKeybindSpec("delete")).toBeNull();
    expect(validateKeybindSpec("ctrl+shift+z")).toBeNull();
    expect(validateKeybindSpec("no+such+key+here")).toContain("can't parse");
  });

  test("keySpecEqual aliases enter/return (dispatch accepts both spellings)", () => {
    // the router matches enter as return and back — validation must agree or
    // an enter/return collision passes checks but shadows at runtime
    expect(keySpecEqual("enter", "return")).toBe(true);
    expect(keySpecEqual("alt+enter", "alt+return")).toBe(true);
    expect(keySpecEqual("ctrl+q", "ctrl+q")).toBe(true);
    expect(keySpecEqual("ctrl+q", "ctrl+shift+q")).toBe(false);
    expect(keySpecEqual("ctrl+q", "ctrl+w")).toBe(false);
    expect(keySpecEqual("nope++", "ctrl+q")).toBe(false);
  });
});
