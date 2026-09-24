import { describe, expect, test } from "bun:test";
import {
  EXAMPLE_HEADER,
  KEY_SCHEMA,
  SCHEMA,
  UI_SCHEMA,
  defaultConfig,
  exampleToml,
  keybindConflict,
  parseConfigDoc,
  serializeBody,
  serializeConfig,
  type Config,
} from "./config-schema";
import { validateKeybindSpec } from "./keyspec";
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

  test("[keys]: filters unparseable specs, dedupes; an empty array is a real unbind", () => {
    const cfg = parseConfigDoc({ keys: { "new-tab": ["ctrl+n", "ctrl+n", "bogus+keys+x"], quit: [] } });
    expect(cfg.keys.newTab).toEqual(["ctrl+n"]);
    // explicit [] must NOT fall back to the default — presets emit [] to
    // disable a bind, and the default coming back silently duplicated ctrl+r
    expect(cfg.keys.quit).toEqual([]);
    // a NON-empty array that parses to nothing still falls back (typo safety)
    expect(parseConfigDoc({ keys: { quit: ["bogus+keys+x"] } }).keys.quit).toEqual(["ctrl+q"]);
  });

  test("[keys]: bare letters load from file (presets bind j/k…; capture UI still reserves them)", () => {
    const cfg = parseConfigDoc({ keys: { "toggle-hidden": ["ctrl+h", "."] } });
    expect(cfg.keys.toggleHidden).toEqual(["ctrl+h", "."]);
    // validateKeybindSpec stays strict for the settings capture flow
    expect(validateKeybindSpec(".")).not.toBeNull();
  });

  test("icons defaults to opaque, parses the mode enum", () => {
    expect(parseConfigDoc(undefined).ui.icons).toBe("opaque");
    expect(parseConfigDoc({ ui: { icons: "transparent" } }).ui.icons).toBe("transparent");
    expect(parseConfigDoc({ ui: { icons: "transparent-partial" } }).ui.icons).toBe("transparent-partial");
    expect(parseConfigDoc({ ui: { icons: "yes" } }).ui.icons).toBe("opaque");
  });

  test("icons ignores the impossible legacy boolean form", () => {
    // the pre-enum key was transparent-icons (renamed, never aliased), so an
    // `icons = true` line never existed in any release — it falls back to the
    // default like any other bad value instead of being promoted to a setting
    expect(parseConfigDoc({ ui: { icons: true } }).ui.icons).toBe("opaque");
    expect(parseConfigDoc({ ui: { icons: false } }).ui.icons).toBe("opaque");
  });

  test("tty-mode parses the enum; the old compat-mode spelling is not read", () => {
    expect(parseConfigDoc(undefined).ui.ttyMode).toBe("auto");
    expect(parseConfigDoc({ ui: { "tty-mode": "on" } }).ui.ttyMode).toBe("on");
    expect(parseConfigDoc({ ui: { "tty-mode": "nonsense" } }).ui.ttyMode).toBe("auto");
    // pre-release rename: the old spelling is deliberately dead, NOT aliased —
    // an unknown key falls back to the default like any other typo
    expect(parseConfigDoc({ ui: { "compat-mode": "on" } }).ui.ttyMode).toBe("auto");
  });

  test("force-glyph defaults off, parses a plain bool", () => {
    expect(parseConfigDoc(undefined).ui.forceGlyph).toBe(false);
    expect(parseConfigDoc({ ui: { "force-glyph": true } }).ui.forceGlyph).toBe(true);
    expect(parseConfigDoc({ ui: { "force-glyph": "yes" } }).ui.forceGlyph).toBe(false);
  });

  test("hover lift options parse with fallbacks (no distance knob: fixed 1 cell)", () => {
    const defs = parseConfigDoc(undefined).ui;
    expect(defs.fileHoverIncludeLabel).toBe(false);
    expect(defs.fileHoverDirection).toBe("up");
    expect("fileHoverDistance" in defs).toBe(false);
    const cfg = parseConfigDoc({
      ui: { "file-hover-include-label": true, "file-hover-direction": "sideways" },
    }).ui;
    expect(cfg.fileHoverIncludeLabel).toBe(true);
    expect(cfg.fileHoverDirection).toBe("up");
  });

  test("round-trip: serialize -> parse -> identical config", () => {
    const cfg: Config = structuredClone(defaultConfig);
    cfg.ui.sidebarWidth = 40;
    cfg.ui.toastDurationMs = 5000;
    cfg.keys.quit = ["ctrl+q", "alt+f4"];
    const cfg2 = parseConfigDocBody(serializeConfig(cfg));
    expect(cfg2).toEqual(cfg);
  });

  test("ui-style outline-partial round-trips; garbage still falls back to solid", () => {
    const cfg: Config = structuredClone(defaultConfig);
    cfg.ui.uiStyle = "outline-partial";
    expect(parseConfigDocBody(serializeConfig(cfg)).ui.uiStyle).toBe("outline-partial");
    expect(parseConfigDoc({ ui: { "ui-style": "neon" } }).ui.uiStyle).toBe("solid");
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
    expect(exampleToml()).toMatch(/drag-threshold-cells\s+=\s+1/);
  });
});

// keybindConflict reads the schema's KEY_ROWS (which action already owns a
// spec), so it stays with the table even though the spec vocabulary moved to
// ./keyspec.
describe("keybindConflict", () => {
  test("finds other actions owning a spec", () => {
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
    const repoFile = new URL("../../config.example.toml", import.meta.url);
    expect(readFileSync(repoFile, "utf8")).toBe(exampleToml());
  });
});
