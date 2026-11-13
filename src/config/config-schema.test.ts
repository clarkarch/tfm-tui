import { describe, expect, test } from "bun:test";
import {
  GATED_MASTERS,
  KEY_SCHEMA,
  SCHEMA,
  UI_SCHEMA,
  cycleSelectionFromIdx,
  defaultConfig,
  describeKeybindConflicts,
  exampleToml,
  findKeybindConflicts,
  gateAllows,
  keybindConflict,
  keybindValue,
  migrateRow,
  normalizeSettingRow,
  parseConfigDoc,
  serializeConfig,
  swapKeybind,
  type Config,
  type EnumValues,
  type UiConfig,
} from "./config-schema";
import { presetKeys } from "./keymap-presets";
import { keySpecEqual, validateKeybindSpec } from "./keyspec";
import { RENDER_EXEMPT } from "./render-exempt";
import { readFileSync } from "node:fs";
import type { SortMode } from "../lib/sort";

// --- type-level pins (the TYPECHECKER is the runner here) ---
// The mode props' types are DERIVED from their schema rows. A hand-written
// union could drift from the row's legal set, and the drift is invisible at
// runtime (the parser accepts the ROW's set), so the equality is asserted
// here: a false condition is a typecheck error.
type Same<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Expect<T extends true> = T;
export type _EasePropIsTheRowSet = Expect<Same<UiConfig["fileAnimationEase"], EnumValues<"fileAnimationEase">>>;
export type _CollapsePropIsTheRowSet = Expect<
  Same<UiConfig["sidebarCollapseStyle"], EnumValues<"sidebarCollapseStyle">>
>;
export type _ThumbnailFitPropIsTheRowSet = Expect<Same<UiConfig["thumbnailFit"], EnumValues<"thumbnailFit">>>;
// the sort mode is the ONE mode whose type lives in a LEAF (lib/sort.ts —
// fs/ and app/ need it without importing config/), so it cannot be derived
// FROM the schema (that would invert the layering). The two copies must
// agree, and THIS pin is what keeps them honest.
export type _SortModeRowMatchesTheLeafUnion = Expect<Same<EnumValues<"sortMode">, SortMode>>;

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

  test("[keys]: the row's state is ONE tag — unbound / bound / invalid", () => {
    // The old shape encoded three states in ONE array field: an explicit
    // empty array (a real UNBIND), a non-empty array (bound), and a
    // non-empty array whose specs all fail to parse (invalid → the row's
    // default). The rule that told them apart (`raw.length === 0`) lived
    // inside the coercion with no name and no owner — so a second reader
    // could not tell "unbound" from "nothing parsed".
    expect(keybindValue([])).toEqual({ kind: "unbound" });
    expect(keybindValue(["ctrl+n"])).toEqual({ kind: "bound", specs: ["ctrl+n"] });
    // a NON-empty array that parses to nothing is the THIRD state — not
    // "unbound" (that would silently disable the bind instead of falling
    // back to the default)
    expect(keybindValue(["bogus+keys+x"])).toEqual({ kind: "invalid" });
    // not an array at all → invalid (the row's default applies)
    expect(keybindValue("ctrl+n")).toEqual({ kind: "invalid" });
    // the parse is parse-only and dedupes
    expect(keybindValue(["ctrl+n", "ctrl+n", "bogus+keys+x"])).toEqual({ kind: "bound", specs: ["ctrl+n"] });
  });

  test("the legacy spellings are DATA on the row, not a code block that overrides the coercion", () => {
    const row = (prop: string) => UI_SCHEMA.find((r) => r.prop === prop);
    // each row that has a legacy spelling DECLARES it — the migration table
    // is a column, not a block that runs after the coercion and wins by
    // ORDER
    expect(typeof row("wrapMode")!.migrate).toBe("function");
    expect(typeof row("transparentBg")!.migrate).toBe("function");
    expect(typeof row("sidebarTitle")!.migrate).toBe("function");
    // the migration answers with a value in the row's OWN legal set (the
    // answer goes through the row's coercion): the alias "opaque" is not a
    // legal transparent-bg value, so the answer is "off", not the alias
    expect(row("transparentBg")!.migrate!({ "transparent-bg": "opaque" })).toBe("off");
    expect(row("transparentBg")!.migrate!({ "transparent-bg": "transparent" })).toBe("on");
    // the RENAME only applies when the NEW key is absent — the old key
    // never overrides the new one
    expect(row("wrapMode")!.migrate!({ "word-wrap": true })).toBe("char");
    expect(row("wrapMode")!.migrate!({ "word-wrap": true, "wrap-mode": "word" })).toBeUndefined();
    // a row with no legacy spelling says so
    expect(row("icons")!.migrate).toBeUndefined();
  });

  test("a migration's answer goes through the row's OWN coercion", () => {
    const row = UI_SCHEMA.find((r) => r.prop === "transparentBg")!;
    // the alias "opaque" is not a legal transparent-bg value — the row's
    // migration answers with the LEGAL value ("off"), and the answer comes
    // back coerced
    expect(migrateRow(row, { "transparent-bg": "opaque" })).toEqual({ value: "off" });
    // a migration that answers with an ILLEGAL value is refused — the row
    // keeps its default (the migration table can never land a bad value)
    expect(migrateRow({ ...row, migrate: () => "bogus" }, {})).toBeNull();
    // no legacy spelling answered → null (the row keeps its default)
    expect(migrateRow(row, { "transparent-bg": "on" })).toBeNull();
  });

  test("a present-but-invalid value still migrates", () => {
    // the legacy spellings are values the row's own coercion REJECTS (they
    // are not in its legal set), so the migration is the fallback that
    // answers for them
    expect(parseConfigDoc({ ui: { "transparent-bg": "transparent" } }).ui.transparentBg).toBe("on");
    expect(parseConfigDoc({ ui: { "sidebar-title": false } }).ui.sidebarTitle).toBe("none");
    // the renamed key: the old bool migrates when the new key is absent
    expect(parseConfigDoc({ ui: { "word-wrap": true } }).ui.wrapMode).toBe("char");
    expect(parseConfigDoc({ ui: { "word-wrap": false } }).ui.wrapMode).toBe("none");
    // ...and the new key wins when it is there (even hand-edited to an
    // illegal value — the old key does not paper over it)
    expect(parseConfigDoc({ ui: { "word-wrap": true, "wrap-mode": "word" } }).ui.wrapMode).toBe("word");
    expect(parseConfigDoc({ ui: { "word-wrap": true, "wrap-mode": "bogus" } }).ui.wrapMode).toBe("none");
  });

  test("[keys]: bare letters load from file (presets bind j/k…; capture UI still reserves them)", () => {
    const cfg = parseConfigDoc({ keys: { "toggle-hidden": ["ctrl+h", "."] } });
    expect(cfg.keys.toggleHidden).toEqual(["ctrl+h", "."]);
    // validateKeybindSpec stays strict for the settings capture flow
    expect(validateKeybindSpec(".")).not.toBeNull();
  });

  test("sidebar-title defaults to the tfm wordmark, parses the mode enum", () => {
    expect(parseConfigDoc(undefined).ui.sidebarTitle).toBe("tfm");
    expect(parseConfigDoc({ ui: { "sidebar-title": "files" } }).ui.sidebarTitle).toBe("files");
    expect(parseConfigDoc({ ui: { "sidebar-title": "none" } }).ui.sidebarTitle).toBe("none");
    expect(parseConfigDoc({ ui: { "sidebar-title": "banner" } }).ui.sidebarTitle).toBe("tfm");
  });

  test("legacy sidebar-title bool migrates (true=tfm, false=none)", () => {
    expect(parseConfigDoc({ ui: { "sidebar-title": true } }).ui.sidebarTitle).toBe("tfm");
    expect(parseConfigDoc({ ui: { "sidebar-title": false } }).ui.sidebarTitle).toBe("none");
  });

  test("transparent-bg defaults to off, parses the mode enum", () => {
    expect(parseConfigDoc(undefined).ui.transparentBg).toBe("off");
    expect(parseConfigDoc({ ui: { "transparent-bg": "on" } }).ui.transparentBg).toBe("on");
    expect(parseConfigDoc({ ui: { "transparent-bg": "force" } }).ui.transparentBg).toBe("force");
    expect(parseConfigDoc({ ui: { "transparent-bg": "off" } }).ui.transparentBg).toBe("off");
    expect(parseConfigDoc({ ui: { "transparent-bg": "yes" } }).ui.transparentBg).toBe("off");
  });

  test("legacy transparent-bg bool migrates (true=on, false=off), new key wins", () => {
    expect(parseConfigDoc({ ui: { "transparent-bg": true } }).ui.transparentBg).toBe("on");
    expect(parseConfigDoc({ ui: { "transparent-bg": false } }).ui.transparentBg).toBe("off");
  });

  test("first enum spelling (opaque/transparent) aliases to off/on", () => {
    // never shipped a release, but a hand-edited config may carry it
    expect(parseConfigDoc({ ui: { "transparent-bg": "opaque" } }).ui.transparentBg).toBe("off");
    expect(parseConfigDoc({ ui: { "transparent-bg": "transparent" } }).ui.transparentBg).toBe("on");
  });

  test("icons defaults to opaque, parses the mode enum", () => {
    expect(parseConfigDoc(undefined).ui.icons).toBe("opaque");
    expect(parseConfigDoc({ ui: { icons: "transparent" } }).ui.icons).toBe("transparent");
    expect(parseConfigDoc({ ui: { icons: "transparent-partial" } }).ui.icons).toBe("transparent-partial");
    expect(parseConfigDoc({ ui: { icons: "yes" } }).ui.icons).toBe("opaque");
  });

  test("thumbnail-fit defaults to fit and parses every global thumbnail policy", () => {
    expect(parseConfigDoc(undefined).ui.thumbnailFit).toBe("fit");
    expect(parseConfigDoc({ ui: { "thumbnail-fit": "fit" } }).ui.thumbnailFit).toBe("fit");
    expect(parseConfigDoc({ ui: { "thumbnail-fit": "crop" } }).ui.thumbnailFit).toBe("crop");
    expect(parseConfigDoc({ ui: { "thumbnail-fit": "stretch" } }).ui.thumbnailFit).toBe("stretch");
    // a hand-edited value outside the row's legal set keeps the row default
    expect(parseConfigDoc({ ui: { "thumbnail-fit": "fill" } }).ui.thumbnailFit).toBe("fit");
    expect(parseConfigDoc({ ui: { "thumbnail-fit": true } }).ui.thumbnailFit).toBe("fit");
  });

  test("icons ignores the impossible legacy boolean form", () => {
    // the pre-enum key was transparent-icons (renamed, never aliased), so an
    // `icons = true` line never existed in any release — it falls back to the
    // default like any other bad value instead of being promoted to a setting
    expect(parseConfigDoc({ ui: { icons: true } }).ui.icons).toBe("opaque");
    expect(parseConfigDoc({ ui: { icons: false } }).ui.icons).toBe("opaque");
  });

  test("icon-style defaults to filled, parses the style enum", () => {
    expect(parseConfigDoc(undefined).ui.iconStyle).toBe("filled");
    expect(parseConfigDoc({ ui: { "icon-style": "outline" } }).ui.iconStyle).toBe("outline");
    expect(parseConfigDoc({ ui: { "icon-style": "filled" } }).ui.iconStyle).toBe("filled");
    expect(parseConfigDoc({ ui: { "icon-style": "yes" } }).ui.iconStyle).toBe("filled");
    expect(parseConfigDoc({ ui: { "icon-style": true } }).ui.iconStyle).toBe("filled");
  });

  test("sort-mode defaults to type, parses the enum, bad values fall back", () => {
    expect(parseConfigDoc(undefined).ui.sortMode).toBe("type");
    expect(parseConfigDoc({ ui: { "sort-mode": "name" } }).ui.sortMode).toBe("name");
    expect(parseConfigDoc({ ui: { "sort-mode": "size" } }).ui.sortMode).toBe("size");
    expect(parseConfigDoc({ ui: { "sort-mode": "nonsense" } }).ui.sortMode).toBe("type");
    expect(parseConfigDoc({ ui: { "sort-mode": true } }).ui.sortMode).toBe("type");
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

  test("row granularity defaults off (per-file cascade; rows opt into the cheaper path)", () => {
    expect(parseConfigDoc(undefined).ui.fileAnimationRowGranularity).toBe(false);
  });

  test("device poll interval defaults 1000ms, parses and clamps to [250, 10000]", () => {
    expect(parseConfigDoc(undefined).ui.devicePollMs).toBe(1000);
    expect(parseConfigDoc({ ui: { "device-poll-ms": 500 } }).ui.devicePollMs).toBe(500);
    expect(parseConfigDoc({ ui: { "device-poll-ms": 100 } }).ui.devicePollMs).toBe(250);
    expect(parseConfigDoc({ ui: { "device-poll-ms": 60000 } }).ui.devicePollMs).toBe(10000);
    expect(parseConfigDoc({ ui: { "device-poll-ms": "fast" } }).ui.devicePollMs).toBe(1000);
  });

  test("hover options parse with fallbacks (duration/travel/dir/ease defaults)", () => {
    const defs = parseConfigDoc(undefined).ui;
    expect(defs.fileHoverIncludeLabel).toBe(false);
    expect(defs.fileHoverSlideDir).toBe("up");
    expect(defs.fileHoverMs).toBe(0);
    expect(defs.fileHoverSlideCells).toBe(1);
    expect(defs.fileHoverEase).toBe("ease-out");
    const cfg = parseConfigDoc({
      ui: { "file-hover-include-label": true, "file-hover-slide-dir": "sideways" },
    }).ui;
    expect(cfg.fileHoverIncludeLabel).toBe(true);
    expect(cfg.fileHoverSlideDir).toBe("up");
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

  test("example toml carries the default body", () => {
    expect(exampleToml()).toMatch(/drag-threshold-cells\s+=\s+1/);
  });

  test("restart flag marks exactly the cold-boot-only ui keys", () => {
    const flagged = UI_SCHEMA.filter((r) => r.restart).map((r) => r.prop);
    expect(new Set(flagged)).toEqual(
      new Set([
        "restoreSession",
        "showLaunchTime",
        "lazyStartup",
        "sidebarAnimation",
        "sidebarAnimationStyle",
        "sidebarAnimationMs",
        "sidebarAnimationSlideCells",
        "sidebarAnimationSlideDir",
        "sidebarAnimationStaggerPct",
        "sidebarAnimationEase",
        "sidebarAnimationIncludeTitle",
        "topbarAnimation",
        "topbarAnimationStyle",
        "topbarAnimationMs",
        "topbarAnimationSlideCells",
        "topbarAnimationSlideDir",
        "topbarAnimationStaggerPct",
        "topbarAnimationEase",
      ]),
    );
  });

  test("restart rows serialize their doc with a (needs restart) marker", () => {
    const text = serializeConfig(defaultConfig);
    expect(text).toContain("# true = reopen the folder from the last quit instead of the launch cwd (needs restart)");
    expect(text).toContain(
      "# true = animate the places sidebar on boot (style = sidebar-animation-style) (needs restart)",
    );
    // live keys carry no marker
    expect(text).not.toMatch(/single pane \(needs restart\)/);
    expect(text).not.toMatch(/undo history survives restarts.*\(needs restart\)/);
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

describe("findKeybindConflicts", () => {
  test("clean defaults and both presets scan empty", () => {
    expect(findKeybindConflicts(defaultConfig)).toEqual([]);
    for (const name of ["tfm", "yazi"] as const) {
      const cfg: Config = { ...structuredClone(defaultConfig), keys: presetKeys(name) };
      expect(findKeybindConflicts(cfg)).toEqual([]);
    }
  });

  test("same spec on two actions groups them (enter/return aliased)", () => {
    const cfg: Config = structuredClone(defaultConfig);
    cfg.keys.undo = ["ctrl+q"]; // quit owns it
    expect(findKeybindConflicts(cfg)).toEqual([{ spec: "ctrl+q", actions: ["quit", "undo"] }]);
    const aliased: Config = structuredClone(defaultConfig);
    aliased.keys.paste = ["alt+return"]; // showProps owns alt+enter
    const found = findKeybindConflicts(aliased);
    expect(found).toHaveLength(1);
    expect(found[0]!.actions).toContain("showProps");
    expect(found[0]!.actions).toContain("paste");
  });

  test("multi-bind actions and explicit unbinds are not conflicts", () => {
    const cfg: Config = structuredClone(defaultConfig);
    cfg.keys.duplicate = []; // yazi-style unbind
    expect(findKeybindConflicts(cfg)).toEqual([]);
  });
});

describe("swapKeybind", () => {
  test("steals only the clashing spec, target takes it alone", () => {
    const keys = { ...structuredClone(defaultConfig.keys), quit: ["ctrl+q", "alt+q"] };
    const next = swapKeybind(keys, "quit", "undo", "ctrl+q");
    expect(next.quit).toEqual(["alt+q"]);
    expect(next.undo).toEqual(["ctrl+q"]);
    expect(keys.quit).toEqual(["ctrl+q", "alt+q"]); // fresh object, input untouched
  });

  test("stealing an owner's last bind unbinds it (explicit [] is legal)", () => {
    const next = swapKeybind(structuredClone(defaultConfig.keys), "quit", "undo", "ctrl+q");
    expect(next.quit).toEqual([]);
    expect(next.undo).toEqual(["ctrl+q"]);
  });
});

describe("describeKeybindConflicts", () => {
  test("one human line per clash, empty when clean", () => {
    expect(describeKeybindConflicts(defaultConfig)).toBe("");
    const cfg: Config = structuredClone(defaultConfig);
    cfg.keys.undo = ["ctrl+q"];
    const text = describeKeybindConflicts(cfg);
    expect(text).toContain('"ctrl+q"');
    expect(text).toContain("quit");
    expect(text).toContain("undo");
  });
});

describe("schema invariants", () => {
  test("every key row maps to a unique action and toml key", () => {
    const actions = KEY_SCHEMA.map((r) => r.action);
    expect(new Set(actions).size).toBe(actions.length);
    const tomlKeys = SCHEMA.map((r) => `${r.section}:${r.tomlKey}`);
    expect(new Set(tomlKeys).size).toBe(tomlKeys.length);
  });

  test("defaultConfig carries exactly the schema's props", () => {
    // defaultConfig is BUILT from the rows, so a value check would be
    // tautological — the real invariant is the KEY SET: no duplicate prop
    // (fromEntries would collapse it) and no key the schema does not know.
    expect(Object.keys(defaultConfig.ui).sort()).toEqual(UI_SCHEMA.map((r) => r.prop).sort());
    expect(Object.keys(defaultConfig.keys).sort()).toEqual(KEY_SCHEMA.map((r) => r.prop).sort());
  });

  test("every row's default is a legal value for its own row", () => {
    // A default outside the row's own bounds (or outside its enum) is an
    // illegal state the app STARTS in: the parser clamps it on the first
    // read, so "the value in the file" and "the value the app boots with"
    // disagree, and the settings stepper shows something the config never
    // held.
    for (const row of UI_SCHEMA) {
      if (row.kind === "int") {
        expect(row.def, `ui.${row.prop} below min`).toBeGreaterThanOrEqual(row.min);
        expect(row.def, `ui.${row.prop} above max`).toBeLessThanOrEqual(row.max);
      } else if (row.kind === "enum") {
        expect(row.values, `ui.${row.prop} default not in values`).toContain(row.def);
      } else if (row.kind === "bool") {
        expect(typeof row.def, `ui.${row.prop} default not a boolean`).toBe("boolean");
      }
    }
  });

  test("every enum row's legal set is non-empty and duplicate-free", () => {
    // The prop types are DERIVED from these sets, so an empty set would
    // derive `never` (every assignment an error) and a repeat would put a
    // duplicate in the union (the legal set and the type would disagree).
    for (const row of UI_SCHEMA) {
      if (row.kind !== "enum") continue;
      expect(row.values.length, `ui.${row.prop} has no legal values`).toBeGreaterThan(0);
      expect(new Set(row.values).size, `ui.${row.prop} repeats a legal value`).toBe(row.values.length);
    }
  });

  test("every enum prop's parsed value is inside its row's legal set (the type is honest)", () => {
    // The derived prop type says a mode prop can only hold its row's legal
    // values — that is a RUNTIME claim too: the parser REJECTS an unknown
    // value (it keeps the row's default), so a hand-edited TOML can never
    // put a mode prop outside its own legal set. Without this, the type
    // would be a promise the parser does not keep.
    for (const row of UI_SCHEMA) {
      if (row.kind !== "enum") continue;
      const cfg = parseConfigDoc({ ui: { [row.tomlKey]: "definitely-not-a-mode" } });
      const value = (cfg.ui as unknown as Record<string, unknown>)[row.prop];
      expect(row.values, `ui.${row.prop} holds a value outside its legal set`).toContain(value as string);
    }
  });

  test("a config mode prop is not a bare string (a bogus mode does not type-check)", () => {
    // The animation/collapse modes were typed `string`: a consumer could
    // write `cfg.ui.fileAnimationEase === "ease-in"` and COMPILE — the legal
    // set was a runtime array nobody could see at the type level. The legal
    // set is the schema ROW's `values` (the one source of truth), so the
    // prop type is derived from it. The @ts-expect-error directives are the
    // pin: an UNUSED directive is a typecheck error.
    const ui = { ...defaultConfig.ui };
    // @ts-expect-error "ease-in" is not a legal file-animation ease
    ui.fileAnimationEase = "ease-in";
    // @ts-expect-error "bogus" is not a legal sidebar collapse style
    ui.sidebarCollapseStyle = "bogus";
    // @ts-expect-error "left" is not a legal terminal collapse style
    ui.terminalCollapseStyle = "left";
    // @ts-expect-error "sideways" is not a legal topbar animation direction
    ui.topbarAnimationSlideDir = "sideways";
    // the copy was mutated; the shared default is untouched
    expect(defaultConfig.ui.fileAnimationEase).toBe("ease-out");
    expect(defaultConfig.ui.sidebarCollapseStyle).toBe("hidden");
  });

  test("every mode prop's type IS its row's legal set (derived, not hand-written)", () => {
    // A hand-written union could drift from the row's legal set, and the
    // drift is invisible at runtime (the parser accepts the ROW's set). The
    // type-level assertion below is the pin: it fails the typecheck when
    // the two disagree.
    const ui = { ...defaultConfig.ui };
    // @ts-expect-error the derived type is the row's union, so "nope" is out
    ui.fileHoverEase = "nope";
    expect(Object.keys(defaultConfig.ui).length).toBeGreaterThan(0);
  });
  test("RENDER_EXEMPT names are real [ui] keys (a typo exempts nothing)", () => {
    // A name that is not a config key silently exempts NOTHING: the knob
    // rebuilds the world on every stepper click (native-alloc churn) and the
    // exemption reads as "it works" in the code.
    const known = new Set(UI_SCHEMA.map((r) => r.prop));
    const unknown = [...RENDER_EXEMPT].filter((k) => !known.has(k));
    expect(unknown).toEqual([]);
  });

  test("no two default actions share a bind (one key = one action)", () => {
    const rows = KEY_SCHEMA.filter((r) => r.def.length > 0);
    for (let i = 0; i < rows.length; i++) {
      for (const bind of rows[i]!.def) {
        for (let j = i + 1; j < rows.length; j++) {
          for (const other of rows[j]!.def) {
            expect(keySpecEqual(bind, other), `"${bind}" is on both ${rows[i]!.prop} and ${rows[j]!.prop}`).toBe(false);
          }
        }
      }
    }
  });
});

describe("progressive-disclosure gate", () => {
  test("the rebuild set is the union of every gate's terms", () => {
    // derived, never hand-kept: a gated row that missed the old list lost
    // its dependent forever (the master flipped, the row never appeared)
    const derived = new Set<string>();
    for (const row of UI_SCHEMA) {
      if (row.section !== "ui" || !row.gate) continue;
      const terms = "all" in row.gate ? row.gate.all : row.gate.any;
      for (const t of terms) derived.add(t.prop);
    }
    expect([...derived].sort()).toEqual([...GATED_MASTERS].sort());
    expect(derived.size).toBeGreaterThan(0);
  });

  test("a gate holds only while its terms hold (all / any / a named value)", () => {
    const ui = { ...defaultConfig.ui };
    expect(gateAllows({ all: [{ prop: "fileAnimation" }] }, ui)).toBe(false);
    expect(gateAllows({ all: [{ prop: "fileAnimation" }] }, { ...ui, fileAnimation: true })).toBe(true);
    expect(
      gateAllows(
        { all: [{ prop: "previewEnabled" }, { prop: "previewAutoHide" }] },
        {
          ...ui,
          previewEnabled: true,
        },
      ),
    ).toBe(false);
    expect(
      gateAllows(
        { all: [{ prop: "previewEnabled" }, { prop: "previewAutoHide" }] },
        {
          ...ui,
          previewEnabled: true,
          previewAutoHide: true,
        },
      ),
    ).toBe(true);
    expect(
      gateAllows(
        { any: [{ prop: "sidebarAutoHide" }, { prop: "terminalAutoHide" }] },
        {
          ...ui,
          terminalAutoHide: true,
        },
      ),
    ).toBe(true);
    expect(gateAllows({ all: [{ prop: "scrimMode", eq: "dim" }] }, { ...ui, scrimMode: "fill" })).toBe(false);
    expect(gateAllows({ all: [{ prop: "scrimMode", eq: "dim" }] }, { ...ui, scrimMode: "dim" })).toBe(true);
  });
});

describe("plugin settings rows", () => {
  test("a legacy cycle row (getIdx + customLabel) is normalized into the tagged selection", () => {
    let label = "~nearest";
    const legacy = {
      kind: "cycle",
      label: "legacy",
      names: ["a", "b"],
      getIdx: () => -1,
      customLabel: () => label,
      setIdx: () => {},
    };
    const row = normalizeSettingRow(legacy);
    if (row?.kind !== "cycle") throw new Error("expected a cycle row");
    expect(row.get()).toEqual({ kind: "custom", label: "~nearest" });
    // the label stays LIVE (a callback, not a snapshot)
    label = "~other";
    expect(row.get()).toEqual({ kind: "custom", label: "~other" });
  });

  test("a legacy cycle row with a live index reports that index", () => {
    const legacy = {
      kind: "cycle",
      label: "legacy",
      names: ["a", "b"],
      getIdx: () => 1,
      setIdx: () => {},
    };
    const row = normalizeSettingRow(legacy);
    if (row?.kind !== "cycle") throw new Error("expected a cycle row");
    expect(row.get()).toEqual({ kind: "index", index: 1 });
  });

  test("the current cycle shape passes through unchanged", () => {
    const row = normalizeSettingRow({
      kind: "cycle",
      label: "current",
      names: ["a"],
      get: () => ({ kind: "index", index: 0 }),
      setIdx: () => {},
    });
    if (row?.kind !== "cycle") throw new Error("expected a cycle row");
    expect(row.get()).toEqual({ kind: "index", index: 0 });
  });

  test("the legacy -1 index becomes a tagged selection through ONE helper", () => {
    // The "-1 = custom" convention is the PLUGIN API's contract (it cannot
    // change), so the sentinel is READ in exactly ONE place — the helper.
    // The app's own rows never speak it: they answer the tagged selection.
    expect(cycleSelectionFromIdx(-1)).toEqual({ kind: "custom", label: "custom" });
    expect(cycleSelectionFromIdx(-1, () => "~nearest")).toEqual({ kind: "custom", label: "~nearest" });
    expect(cycleSelectionFromIdx(1)).toEqual({ kind: "index", index: 1 });
    // the theme row's presets sit at +1 (the "System" entry leads at 0)
    expect(cycleSelectionFromIdx(0, undefined, 1)).toEqual({ kind: "index", index: 1 });
    expect(cycleSelectionFromIdx(-1, () => "~nearest", 1)).toEqual({ kind: "custom", label: "~nearest" });
  });

  test("a malformed row is still dropped", () => {
    expect(normalizeSettingRow({ kind: "toggle", label: "x" })).toBeNull();
    expect(normalizeSettingRow({ kind: "cycle", label: "x", names: ["a"] })).toBeNull();
  });
});

describe("config.example.toml is in sync", () => {
  test("repo file matches exampleToml()", () => {
    const repoFile = new URL("../../config.example.toml", import.meta.url);
    expect(readFileSync(repoFile, "utf8")).toBe(exampleToml());
  });
});

describe("wrap-mode", () => {
  test("defaults to none (clip, the old false behavior)", () => {
    expect(parseConfigDoc(undefined).ui.wrapMode).toBe("none");
  });

  test("parses all three modes, rejects garbage to the default", () => {
    expect(parseConfigDoc({ ui: { "wrap-mode": "char" } }).ui.wrapMode).toBe("char");
    expect(parseConfigDoc({ ui: { "wrap-mode": "word" } }).ui.wrapMode).toBe("word");
    expect(parseConfigDoc({ ui: { "wrap-mode": "none" } }).ui.wrapMode).toBe("none");
    expect(parseConfigDoc({ ui: { "wrap-mode": "ribbon" } }).ui.wrapMode).toBe("none");
  });

  test("legacy word-wrap bool migrates (true=char, false=none), new key wins", () => {
    expect(parseConfigDoc({ ui: { "word-wrap": true } }).ui.wrapMode).toBe("char");
    expect(parseConfigDoc({ ui: { "word-wrap": false } }).ui.wrapMode).toBe("none");
    expect(parseConfigDoc({ ui: { "wrap-mode": "word", "word-wrap": true } }).ui.wrapMode).toBe("word");
  });
});
