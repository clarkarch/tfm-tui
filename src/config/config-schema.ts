// --- THE single source of truth for every config key. One row describes a
// key's TOML section, type, bounds, default, doc comment and GUI presentation;
// the parser (config.ts), the serializer (which regenerates per-key doc
// comments), the example TOML and the settings rows (settings-model.ts) all
// derive from this table. Adding a knob = adding a row here, nothing else.
// Pure module: no fs, no renderer. ---

export type Theme = {
  bg: string;
  sidebarBg: string;
  sidebarFg: string;
  sidebarFgMuted: string;
  accent: string;
  accentBg: string;
  hoverBg: string;
  border: string;
  divider: string;
  white: string;
  syntaxString: string;
  syntaxNumber: string;
  syntaxType: string;
  syntaxFunction: string;
  syntaxOperator: string;
  syntaxProperty: string;
  ansi0: string;
  ansi1: string;
  ansi2: string;
  ansi3: string;
  ansi4: string;
  ansi5: string;
  ansi6: string;
  ansi7: string;
  ansi8: string;
  ansi9: string;
  ansi10: string;
  ansi11: string;
  ansi12: string;
  ansi13: string;
  ansi14: string;
  ansi15: string;
};

export type ViewMode = "grid" | "list";

// surface-style vocabulary — the ui-style key's value type. The solid/outline
// painting decisions live in ./style (the surface seam), which re-exports this.
export type UiStyle = "solid" | "outline";

export type UiConfig = {
  sidebarWidth: number;
  tileWidth: number;
  tileHeight: number;
  iconCells: number;
  doubleClickMs: number;
  showHidden: boolean;
  previewEnabled: boolean;
  previewWidth: number;
  restoreSession: boolean;
  transparentBg: boolean;
  uiStyle: UiStyle;
  tabBar: boolean;
  viewMode: ViewMode;
  toastDurationMs: number;
  dragThresholdCells: number;
  listRowHeight: number;
  wordWrap: boolean;
  showLaunchTime: boolean;
};

// --- keybind actions (section [keys], kebab-case in TOML, camel props here) ---
export type KeyAction =
  | "quit"
  | "openMenu"
  | "toggleHidden"
  | "reloadPlaces"
  | "newTab"
  | "closeTab"
  | "nextTab"
  | "prevTab"
  | "selectAll"
  | "trash"
  | "renameOrRestore"
  | "copy"
  | "cut"
  | "paste"
  | "undo"
  | "redo"
  | "parentDir";

export type KeysConfig = Record<KeyAction, string[]>;

export type Config = { ui: UiConfig; theme: Theme; keys: KeysConfig };

// --- schema ---

export type GuiGroup = "general" | "layout" | "behavior" | "keys";

type RowCommon = { tomlKey: string; prop: string; doc: string; label: string; group?: GuiGroup };

export type SchemaRow =
  | (RowCommon & { kind: "int"; section: "ui"; min: number; max: number; step: number; def: number })
  | (RowCommon & { kind: "bool"; section: "ui"; def: boolean })
  | (RowCommon & { kind: "enum"; section: "ui"; values: readonly string[]; def: string })
  | (RowCommon & { kind: "key"; section: "keys"; action: KeyAction; def: string[] })
  | (RowCommon & { kind: "hex"; section: "theme"; def: string; group?: undefined });

export type KeyRow = Extract<SchemaRow, { kind: "key" }>;
export type ThemeRow = Extract<SchemaRow, { kind: "hex" }>;
export type UiSchemaRow = Extract<SchemaRow, { section: "ui" }>;

const UI_ROWS: SchemaRow[] = [
  {
    kind: "int",
    section: "ui",
    tomlKey: "sidebar-width",
    prop: "sidebarWidth",
    min: 16,
    max: 60,
    step: 1,
    def: 26,
    doc: "16..60 cells (grid + list)",
    label: "sidebar width",
    group: "layout",
  },
  {
    kind: "int",
    section: "ui",
    tomlKey: "tile-width",
    prop: "tileWidth",
    min: 10,
    max: 40,
    step: 1,
    def: 20,
    doc: "10..40 cells (grid view)",
    label: "grid tile width",
    group: "layout",
  },
  {
    kind: "int",
    section: "ui",
    tomlKey: "tile-height",
    prop: "tileHeight",
    min: 3,
    max: 10,
    step: 1,
    def: 5,
    doc: "3..10 cells (grid view)",
    label: "grid tile height",
    group: "layout",
  },
  {
    kind: "int",
    section: "ui",
    tomlKey: "icon-cells",
    prop: "iconCells",
    min: 1,
    max: 5,
    step: 1,
    def: 3,
    doc: "grid icon height in rows, 1..5",
    label: "grid icon size",
    group: "layout",
  },
  {
    kind: "int",
    section: "ui",
    tomlKey: "list-row-height",
    prop: "listRowHeight",
    min: 1,
    max: 3,
    step: 1,
    def: 1,
    doc: "list view row height in cells, 1..3 (icon scales with it)",
    label: "list row height",
    group: "layout",
  },
  {
    kind: "int",
    section: "ui",
    tomlKey: "preview-width",
    prop: "previewWidth",
    min: 20,
    max: 80,
    step: 2,
    def: 40,
    doc: "20..80 cells",
    label: "preview width",
    group: "layout",
  },
  {
    kind: "int",
    section: "ui",
    tomlKey: "double-click-ms",
    prop: "doubleClickMs",
    min: 100,
    max: 2000,
    step: 50,
    def: 400,
    doc: "100..2000",
    label: "double-click ms",
    group: "behavior",
  },
  {
    kind: "int",
    section: "ui",
    tomlKey: "toast-duration-ms",
    prop: "toastDurationMs",
    min: 1000,
    max: 10000,
    step: 500,
    def: 3000,
    doc: "how long notifications stay up, 1000..10000",
    label: "toast duration",
    group: "behavior",
  },
  {
    kind: "int",
    section: "ui",
    tomlKey: "drag-threshold-cells",
    prop: "dragThresholdCells",
    min: 1,
    max: 5,
    step: 1,
    def: 1,
    doc: "cells of movement before a press becomes a drag, 1..5",
    label: "drag threshold",
    group: "behavior",
  },
  {
    kind: "bool",
    section: "ui",
    tomlKey: "show-hidden",
    prop: "showHidden",
    def: false,
    doc: "start with dotfiles visible (ctrl+h toggles at runtime)",
    label: "hidden files",
    group: "general",
  },
  {
    kind: "bool",
    section: "ui",
    tomlKey: "preview-enabled",
    prop: "previewEnabled",
    def: false,
    doc: "right-side preview pane (text files, folder stats)",
    label: "preview pane",
    group: "general",
  },
  {
    kind: "bool",
    section: "ui",
    tomlKey: "restore-session",
    prop: "restoreSession",
    def: false,
    doc: "true = reopen the folder from the last quit instead of the launch cwd",
    label: "restore session",
    group: "general",
  },
  {
    kind: "bool",
    section: "ui",
    tomlKey: "transparent-bg",
    prop: "transparentBg",
    def: false,
    doc: "true = follow a transparent terminal bg (kitty background_opacity); false = force opaque",
    label: "transparent bg",
    group: "general",
  },
  {
    kind: "bool",
    section: "ui",
    tomlKey: "tab-bar",
    prop: "tabBar",
    def: false,
    doc: "true = strip always visible (even with one tab); false = adaptive (only while 2+ tabs are open)",
    label: "tab bar",
    group: "general",
  },
  {
    kind: "enum",
    section: "ui",
    tomlKey: "view-mode",
    prop: "viewMode",
    values: ["grid", "list"],
    def: "grid",
    doc: '"grid" = icon tiles; "list" = compact rows with size + modified columns',
    label: "view mode",
    group: "general",
  },
  {
    kind: "enum",
    section: "ui",
    tomlKey: "ui-style",
    prop: "uiStyle",
    values: ["solid", "outline"],
    def: "solid",
    doc: '"solid" = filled panels; "outline" = rounded borders, no panel fills at rest',
    label: "ui style",
    group: "general",
  },
  {
    kind: "bool",
    section: "ui",
    tomlKey: "word-wrap",
    prop: "wordWrap",
    def: false,
    doc: "true = wrap long file names onto extra tile rows (grid view); false = single line cut with …",
    label: "word wrap (grid)",
    group: "layout",
  },
  {
    kind: "bool",
    section: "ui",
    tomlKey: "show-launch-time",
    prop: "showLaunchTime",
    def: false,
    doc: "true = show a notification with the app launch time in ms (debug aid); also enabled by --debug",
    label: "show launch time",
    group: "general",
  },
];

// [theme] keys are camelCase in TOML (matches the Theme type) and are NOT
// shown as individual GUI rows — the settings panel exposes theme presets.
const THEME_ROWS: ThemeRow[] = (
  [
    ["bg", "#1a1b26", "background"],
    ["sidebarBg", "#16161e", "sidebar background"],
    ["sidebarFg", "#c0caf5", "sidebar text"],
    ["sidebarFgMuted", "#565f89", "sidebar muted text"],
    ["accent", "#7aa2f7", "accent"],
    ["accentBg", "#292e42", "accent background (selection, buttons)"],
    ["hoverBg", "#24283b", "hover background"],
    ["border", "#292e42", "borders"],
    ["divider", "#292e42", "dividers"],
    ["white", "#c0caf5", "primary text"],
    ["syntaxString", "#9ece6a", "syntax: strings"],
    ["syntaxNumber", "#ff9e64", "syntax: numbers"],
    ["syntaxType", "#2ac3de", "syntax: types"],
    ["syntaxFunction", "#7aa2f7", "syntax: functions"],
    ["syntaxOperator", "#89ddff", "syntax: operators"],
    ["syntaxProperty", "#73daca", "syntax: properties"],
    ["ansi0", "#16161e", "terminal color 0 (black)"],
    ["ansi1", "#f7768e", "terminal color 1 (red)"],
    ["ansi2", "#9ece6a", "terminal color 2 (green)"],
    ["ansi3", "#e0af68", "terminal color 3 (yellow)"],
    ["ansi4", "#7aa2f7", "terminal color 4 (blue)"],
    ["ansi5", "#bb9af7", "terminal color 5 (magenta)"],
    ["ansi6", "#7dcfff", "terminal color 6 (cyan)"],
    ["ansi7", "#c0caf5", "terminal color 7 (white)"],
    ["ansi8", "#565f89", "terminal color 8 (bright black)"],
    ["ansi9", "#f7768e", "terminal color 9 (bright red)"],
    ["ansi10", "#9ece6a", "terminal color 10 (bright green)"],
    ["ansi11", "#e0af68", "terminal color 11 (bright yellow)"],
    ["ansi12", "#7aa2f7", "terminal color 12 (bright blue)"],
    ["ansi13", "#bb9af7", "terminal color 13 (bright magenta)"],
    ["ansi14", "#7dcfff", "terminal color 14 (bright cyan)"],
    ["ansi15", "#c0caf5", "terminal color 15 (bright white)"],
  ] as const
).map(([prop, def, doc]) => ({ kind: "hex", section: "theme", tomlKey: prop, prop, def, doc, label: prop }));

// [keys] — one row per remappable action. Modal-internal nav keys (arrows,
// enter, esc inside menus/dialogs) and the type-to-search catch-all are
// structural and intentionally NOT remappable.
const KEY_ROWS: KeyRow[] = (
  [
    ["quit", "quit tfm", ["ctrl+q"]],
    ["openMenu", "open the esc menu", ["escape"]],
    ["toggleHidden", "toggle hidden files", ["ctrl+h"]],
    ["reloadPlaces", "reload sidebar places", ["ctrl+r"]],
    ["newTab", "new tab", ["ctrl+t"]],
    ["closeTab", "close tab", ["ctrl+w"]],
    ["nextTab", "next tab (cycle)", ["ctrl+tab"]],
    ["prevTab", "previous tab (cycle)", ["ctrl+shift+tab"]],
    ["selectAll", "select all", ["ctrl+a"]],
    ["trash", "trash selection (delete forever in trash)", ["delete"]],
    ["renameOrRestore", "rename (restore in trash)", ["f2"]],
    ["copy", "copy selection", ["ctrl+c"]],
    ["cut", "cut selection", ["ctrl+x"]],
    ["paste", "paste clipboard", ["ctrl+v"]],
    ["undo", "undo last file op", ["ctrl+z"]],
    ["redo", "redo (ctrl+shift+z works too)", ["ctrl+y", "ctrl+shift+z"]],
    ["parentDir", "go to parent directory", ["backspace"]],
  ] as const
).map(([action, label, def]) => ({
  kind: "key",
  section: "keys",
  tomlKey: action.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`),
  prop: action,
  action: action as KeyAction,
  doc: `default: ${def.join(" or ")}`,
  label,
  group: "keys" as GuiGroup,
  def: [...def],
}));

export const SCHEMA: SchemaRow[] = [...UI_ROWS, ...THEME_ROWS, ...KEY_ROWS];

export const UI_SCHEMA = UI_ROWS;
export const THEME_SCHEMA = THEME_ROWS;
export const KEY_SCHEMA = KEY_ROWS;

// GUI categories that derive rows from the schema (theme is preset-only and
// the config-actions group is hand-written in settings-model).
export const SCHEMA_GROUPS: GuiGroup[] = ["general", "layout", "behavior", "keys"];

export const defaultConfig: Config = {
  ui: Object.fromEntries(UI_ROWS.map((r) => [r.prop, r.def])),
  theme: Object.fromEntries(THEME_ROWS.map((r) => [r.prop, r.def])),
  keys: Object.fromEntries(KEY_ROWS.map((r) => [r.prop, [...r.def]])),
} as Config;

// --- key specs ---

export type KeySpec = { name: string; ctrl: boolean; shift: boolean; meta: boolean };

export const parseKeySpec = (s: string): KeySpec | null => {
  if (typeof s !== "string") return null;
  const parts = s
    .split("+")
    .map((p) => p.trim().toLowerCase())
    .filter(Boolean);
  if (!parts.length) return null;
  const spec: KeySpec = { name: "", ctrl: false, shift: false, meta: false };
  for (const p of parts) {
    if (p === "ctrl" || p === "control") spec.ctrl = true;
    else if (p === "shift") spec.shift = true;
    else if (p === "alt" || p === "meta" || p === "option") spec.meta = true;
    else if (spec.name)
      return null; // two key names
    else spec.name = p;
  }
  if (!spec.name) return null;
  return spec;
};

export const specToString = (spec: KeySpec): string => {
  const mods = [spec.ctrl ? "ctrl" : "", spec.shift ? "shift" : "", spec.meta ? "alt" : ""].filter(Boolean);
  return [...mods, spec.name].join("+");
};

// bare unmodified printable keys feed type-to-search — binding them to an
// action would make the action unreachable in the grid
const BARE_KEY_RE = /^[a-z0-9._-]$/;

// multi-char key names OpenTUI's parser can produce (single printable chars
// are matched by length); anything else is garbage and rejected at parse time
const KNOWN_KEY_NAMES = new Set([
  ...Array.from({ length: 24 }, (_, i) => `f${i + 1}`),
  "escape",
  "return",
  "enter",
  "tab",
  "backspace",
  "delete",
  "insert",
  "home",
  "end",
  "pageup",
  "pagedown",
  "up",
  "down",
  "left",
  "right",
  "space",
  "menu",
  "clear",
  "capslock",
  "numlock",
  "scrolllock",
  "printscreen",
  "pause",
  "contextmenu",
]);

export const validateKeybindSpec = (s: string): string | null => {
  const spec = parseKeySpec(s);
  if (!spec) return `can't parse key "${s}"`;
  if (BARE_KEY_RE.test(spec.name) && !spec.ctrl && !spec.shift && !spec.meta)
    return "bare letters/numbers are used for type-to-search";
  if (spec.name.length > 1 && !KNOWN_KEY_NAMES.has(spec.name)) return `unknown key "${spec.name}"`;
  if (spec.name.length === 1 && !/[a-z0-9._-]/i.test(spec.name) && !spec.ctrl && !spec.meta)
    return "symbol keys must carry ctrl/alt";
  return null;
};

// mirror OpenTUI's matcher (keybinding.internal.ts): name + modifiers, with
// the kitty base-layout codepoint as a fallback for non-Latin layouts
export type KeyEventLike = {
  name?: string;
  ctrl?: boolean;
  shift?: boolean;
  meta?: boolean;
  option?: boolean;
  baseCode?: number;
};

export const keyMatch = (e: KeyEventLike, spec: KeySpec): boolean => {
  if (!!e.ctrl !== spec.ctrl || !!e.shift !== spec.shift || (!!e.meta || !!e.option) !== spec.meta) return false;
  if (e.name === spec.name) return true;
  const bc = e.baseCode;
  if (typeof bc === "number" && bc >= 32 && bc !== 127) {
    try {
      if (String.fromCodePoint(bc).toLowerCase() === spec.name) return true;
    } catch {}
  }
  return false;
};

export const keySpecFromEvent = (e: KeyEventLike): string | null => {
  const name = typeof e.name === "string" ? e.name.trim().toLowerCase() : "";
  if (!name || name.length > 24) return null;
  const mods = [e.ctrl ? "ctrl" : "", e.shift ? "shift" : "", e.meta || e.option ? "alt" : ""].filter(Boolean);
  return [...mods, name].join("+");
};

// first OTHER action that already owns this spec, for conflict checks
export const keybindConflict = (cfg: Config, action: KeyAction, specStr: string): KeyAction | null => {
  const spec = parseKeySpec(specStr);
  if (!spec) return null;
  for (const row of KEY_ROWS) {
    if (row.action === action) continue;
    for (const s of cfg.keys[row.action] ?? []) {
      const other = parseKeySpec(s);
      if (
        other &&
        other.name === spec.name &&
        other.ctrl === spec.ctrl &&
        other.shift === spec.shift &&
        other.meta === spec.meta
      )
        return row.action;
    }
  }
  return null;
};

// --- parse / serialize ---

const HEX_RE = /^#[0-9a-fA-F]{6}$/;

const clampInt = (v: unknown, min: number, max: number, fallback: number): number => {
  const n = typeof v === "number" ? Math.round(v) : NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
};

// per-row coercion of one raw TOML value; undefined = keep default
const coerceRow = (row: SchemaRow, raw: unknown): { ok: boolean; value: unknown } => {
  switch (row.kind) {
    case "int":
      return { ok: true, value: clampInt(raw, row.min, row.max, row.def) };
    case "bool":
      return typeof raw === "boolean" ? { ok: true, value: raw } : { ok: false, value: row.def };
    case "enum":
      return typeof raw === "string" && (row.values as readonly string[]).includes(raw)
        ? { ok: true, value: raw }
        : { ok: false, value: row.def };
    case "hex":
      return typeof raw === "string" && HEX_RE.test(raw) ? { ok: true, value: raw } : { ok: false, value: row.def };
    case "key": {
      if (!Array.isArray(raw)) return { ok: false, value: row.def };
      const specs = raw
        .filter((s): s is string => typeof s === "string" && validateKeybindSpec(s) === null)
        .filter((s, i, a) => a.indexOf(s) === i);
      return { ok: true, value: specs.length ? specs : row.def };
    }
  }
};

export function parseConfigDoc(doc: unknown): Config {
  const cfg = structuredClone(defaultConfig);
  if (typeof doc !== "object" || doc === null) return cfg;
  for (const row of SCHEMA) {
    const section = (doc as Record<string, unknown>)[row.section];
    if (typeof section !== "object" || section === null) continue;
    const raw = (section as Record<string, unknown>)[row.tomlKey];
    if (raw === undefined) continue;
    const { ok, value } = coerceRow(row, raw);
    if (!ok) continue;
    if (row.section === "theme") (cfg.theme as Record<string, unknown>)[row.prop] = value;
    else if (row.section === "keys") (cfg.keys as Record<string, unknown>)[row.prop] = value;
    else (cfg.ui as Record<string, unknown>)[row.prop] = value;
  }
  return cfg;
}

const tomlString = (s: string): string => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")}"`;

const tomlValue = (v: string | number | boolean | string[]): string => {
  if (Array.isArray(v)) return `[${v.map(tomlString).join(", ")}]`;
  if (typeof v === "string") return tomlString(v);
  return String(v);
};

const valueFor = (cfg: Config, row: SchemaRow): string | number | boolean | string[] => {
  if (row.section === "theme") return (cfg.theme as Record<string, unknown>)[row.prop] as string;
  if (row.section === "keys") return ((cfg.keys as Record<string, unknown>)[row.prop] as string[]) ?? row.def;
  return (cfg.ui as Record<string, unknown>)[row.prop] as string | number | boolean;
};

// hand-built TOML (all values are scalars) so each key's doc comment is
// regenerated — smol-toml can't round-trip comments, but the schema knows
// them. Column-aligned within each section.
export function serializeBody(cfg: Config): string {
  const sections: Array<{ name: string; rows: SchemaRow[] }> = [
    { name: "ui", rows: UI_ROWS },
    { name: "theme", rows: THEME_ROWS },
    { name: "keys", rows: KEY_ROWS },
  ];
  let out = "";
  for (const sec of sections) {
    out += `\n[${sec.name}]\n`;
    const keyW = Math.max(...sec.rows.map((r) => r.tomlKey.length));
    const valW = Math.max(...sec.rows.map((r) => tomlValue(valueFor(cfg, r)).length));
    for (const row of sec.rows) {
      const val = tomlValue(valueFor(cfg, row));
      out += `${row.tomlKey.padEnd(keyW)} = ${val.padEnd(valW)}  # ${row.doc}\n`;
    }
  }
  return out;
}

export function serializeConfig(cfg: Config): string {
  return (
    "# tfm configuration\n" +
    "# Also editable live: press esc -> Settings in the app.\n" +
    "# Per-key comments below are regenerated from the app's schema on save.\n" +
    serializeBody(cfg)
  );
}

export const EXAMPLE_HEADER =
  "# tfm configuration\n" +
  "# Location: ~/.config/tfm/config.toml (or $XDG_CONFIG_HOME/tfm/config.toml)\n" +
  "# Override path with $TFM_CONFIG. Missing file = all defaults.\n" +
  "# Invalid values are ignored per-key (falls back to default), never fatal.\n" +
  "# [keys]: every action can carry several binds. Bare letters/numbers are\n" +
  "# reserved for type-to-search.\n";

export function exampleToml(): string {
  return EXAMPLE_HEADER + serializeBody(defaultConfig);
}
