import { describe, expect, test } from "bun:test";
import {
  EXAMPLE_HEADER,
  KEY_SCHEMA,
  SCHEMA,
  UI_SCHEMA,
  defaultConfig,
  exampleToml,
  keyMatch,
  keySpecFromEvent,
  keybindConflict,
  parseConfigDoc,
  parseKeySpec,
  serializeBody,
  serializeConfig,
  specToString,
  validateKeybindSpec,
  type Config,
} from "./config-schema";
import { readFileSync } from "node:fs";

describe("parseConfigDoc", () => {
  test("empty doc = all defaults", () => {
    const cfg = parseConfigDoc(undefined);
    expect(cfg.ui.toastDurationMs).toBe(3000);
    expect(cfg.ui.dragThresholdCells).toBe(1);
    expect(cfg.keys.quit).toEqual(["ctrl+q"]);
    expect(cfg.theme.bg).toBe("#1a1b26");
  });

  test("clamps ints, rejects bad bools/enums/hex per key", () => {
    const cfg = parseConfigDoc({
      ui: {
        "sidebar-width": 999,
        "double-click-ms": "nope",
        "show-hidden": "yes",
        "view-mode": "gallery",
        "ui-style": "neon",
        "tile-width": 12,
      },
      theme: { bg: "red", accent: "#7aa2f7" },
    });
    expect(cfg.ui.sidebarWidth).toBe(60);
    expect(cfg.ui.doubleClickMs).toBe(400);
    expect(cfg.ui.showHidden).toBe(false);
    expect(cfg.ui.viewMode).toBe("grid");
    expect(cfg.ui.uiStyle).toBe("solid");
    expect(cfg.ui.tileWidth).toBe(12);
    expect(cfg.theme.bg).toBe("#1a1b26");
    expect(cfg.theme.accent).toBe("#7aa2f7");
  });

  test("[keys]: filters invalid specs, dedupes, falls back when none left", () => {
    const cfg = parseConfigDoc({ keys: { "new-tab": ["ctrl+n", "ctrl+n", "bare", "bogus+keys+x"], "quit": [] } });
    expect(cfg.keys.newTab).toEqual(["ctrl+n"]);
    expect(cfg.keys.quit).toEqual(["ctrl+q"]);
  });

  test("round-trip: serialize -> parse -> identical config", () => {
    const cfg: Config = structuredClone(defaultConfig);
    cfg.ui.sidebarWidth = 40;
    cfg.ui.toastDurationMs = 5000;
    cfg.keys.quit = ["ctrl+q", "alt+f4"];
    const cfg2 = parseConfigDocBody(serializeConfig(cfg));
    expect(cfg2).toEqual(cfg);
  });
});

// parse a serialized config without touching the fs (strip nothing: smol-toml
// handles comments) — keeps round-trip tests honest about the real format
const parseConfigDocBody = (text: string): Config => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { parse } = require("smol-toml") as typeof import("smol-toml");
  return parseConfigDoc(parse(text));
};

describe("serializeConfig", () => {
  test("writes kebab-case ui keys, camelCase theme keys, kebab-case keys keys", () => {
    const text = serializeConfig(defaultConfig);
    expect(text).toContain("[ui]");
    expect(text).toContain("[theme]");
    expect(text).toContain("[keys]");
    expect(text).toContain("sidebar-width");
    expect(text).toContain("toast-duration-ms");
    expect(text).toMatch(/new-tab\s*= \["ctrl\+t"\]/);
    expect(text).toMatch(/bg\s*= "#1a1b26"/);
    expect(text).toMatch(/sidebarBg\s*= "#16161e"/);
  });

  test("regenerates doc comments for every key", () => {
    for (const row of SCHEMA) {
      expect(serializeConfig(defaultConfig)).toContain(`# ${row.doc}`);
    }
  });

  test("example toml = header + default body", () => {
    expect(exampleToml()).toBe(EXAMPLE_HEADER + serializeBody(defaultConfig));
    expect(exampleToml()).toContain("drag-threshold-cells = 1");
  });
});

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

  test("specToString is canonical", () => {
    expect(specToString(parseKeySpec("shift+ctrl+z")!)).toBe("ctrl+shift+z");
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

  test("keybindConflict finds other actions owning a spec", () => {
    expect(keybindConflict(defaultConfig, "newTab", "ctrl+q")).toBe("quit");
    expect(keybindConflict(defaultConfig, "quit", "ctrl+q")).toBeNull();
    expect(keybindConflict(defaultConfig, "quit", "ctrl+n")).toBeNull();
    // redo carries ctrl+shift+z AND ctrl+y — both are taken
    expect(keybindConflict(defaultConfig, "undo", "ctrl+shift+z")).toBe("redo");
  });
});

describe("schema invariants", () => {
  test("every key row maps to a unique action and toml key", () => {
    const actions = KEY_SCHEMA.map((r) => r.action);
    expect(new Set(actions).size).toBe(actions.length);
    const tomlKeys = SCHEMA.map((r) => `${r.section}:${r.tomlKey}`);
    expect(new Set(tomlKeys).size).toBe(tomlKeys.length);
  });

  test("defaultConfig covers every schema prop", () => {
    expect(Object.keys(defaultConfig.ui).length).toBe(UI_SCHEMA.length);
    expect(Object.keys(defaultConfig.keys).length).toBe(KEY_SCHEMA.length);
  });
});

describe("config.example.toml is in sync", () => {
  test("repo file matches exampleToml()", () => {
    const repoFile = new URL("../config.example.toml", import.meta.url);
    expect(readFileSync(repoFile, "utf8")).toBe(exampleToml());
  });
});
