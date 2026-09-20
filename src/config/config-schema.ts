// --- THE single source of truth for every config key. One row describes a
// key's TOML section, type, bounds, default, doc comment, GUI presentation
// and a one-line plain-language blurb (the settings description footer —
// never ranges/units/true-false, pinned by settings-model.test.ts);
// the parser (config.ts), the serializer (which regenerates per-key doc
// comments), the example TOML and the settings rows (settings-model.ts) all
// derive from this table. Adding a knob = adding a row here, nothing else.
// Pure module: no fs, no renderer. ---
// The key-spec vocabulary (parse / validate / match / compare) is its own leaf,
// ./keyspec — imported back only for the KEY_ROWS-driven conflict check below.

import { keySpecEqual, parseKeySpec } from "./keyspec";
// Settings-row type lives HERE (a leaf, no imports) so the plugin api can
// reference plugin-provided rows without importing a ui/ module — ui/settings
// re-exports it, keeping the layering acyclic.
// `repaint` rows (theme / ui-style / transparent-bg) change the panel's own
// colors — their adjust re-renders the panel; other value rows update their
// value text by id (targeted, no rebuild — see the OOM note in AGENTS.md)
export type SettingRow =
  | { kind: "toggle"; label: string; blurb?: string; repaint?: boolean; get: () => boolean; set: (v: boolean) => void }
  | {
      kind: "stepper";
      label: string;
      blurb?: string;
      repaint?: boolean;
      min: number;
      max: number;
      step: number;
      fmt: (v: number) => string;
      get: () => number;
      set: (v: number) => void;
    }
  | {
      kind: "cycle";
      label: string;
      blurb?: string;
      repaint?: boolean;
      names: string[];
      getIdx: () => number;
      setIdx: (i: number) => void;
      // shown when getIdx() is -1 (value matches no preset). Only the theme
      // row goes custom today — a bare "custom" never says custom *what*,
      // so the theme row reports "~<nearest preset>" instead.
      customLabel?: () => string;
    }
  // key rows are enter/click-driven (capture flow in ui-settings), not adjustable
  | { kind: "keybind"; label: string; blurb?: string; get: () => string[]; set: (v: string[]) => void }
  | { kind: "action"; label: string; blurb?: string; keepOpen?: boolean; run: () => void }
  // divider rows split a long category into labeled sections (animations/panes).
  // Non-interactive: never take the cursor, never adjust/activate — the settings
  // shell + panel skip them the way the file menu skips separators.
  | { kind: "header"; label: string };

export type SettingGroup = { header?: string; icon?: string; rows: SettingRow[] };

// structural validation for plugin settings rows (mirrors per-entry preview/
// commands validation): a malformed row like {kind:"toggle"} with no get/set
// would otherwise crash the settings panel at render or throw out of the
// keypress handler on adjust — invalid entries drop, the plugin stays.
export const isValidSettingRow = (r: unknown): boolean => {
  if (typeof r !== "object" || r === null) return false;
  const row = r as Record<string, unknown>;
  if (typeof row.label !== "string") return false;
  switch (row.kind) {
    case "toggle":
      return typeof row.get === "function" && typeof row.set === "function";
    case "stepper":
      return (
        typeof row.min === "number" &&
        typeof row.max === "number" &&
        typeof row.step === "number" &&
        typeof row.fmt === "function" &&
        typeof row.get === "function" &&
        typeof row.set === "function"
      );
    case "cycle":
      return (
        Array.isArray(row.names) &&
        row.names.every((s) => typeof s === "string") &&
        typeof row.getIdx === "function" &&
        typeof row.setIdx === "function"
      );
    case "keybind":
      return typeof row.get === "function" && typeof row.set === "function";
    case "action":
      return typeof row.run === "function";
    case "header":
      return true; // label already checked above; no handlers to validate
    default:
      return false;
  }
};

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

type ViewMode = "grid" | "list";

// surface-style vocabulary — the ui-style key's value type. The solid/outline
// painting decisions live in ./style (the surface seam), which re-exports this.
export type UiStyle = "solid" | "outline" | "outline-partial";

// tile hover-lift controls ([ui] file-hover-*): which way the icon moves (one
// cell, the terminal minimum) and whether the filename rides along. The grid
// only lifts tiles that have one spare cell; the rest keep the highlight.
export type HoverLiftDirection = "up" | "down" | "left" | "right";
export type HoverLiftOpts = {
  enabled: boolean;
  direction: HoverLiftDirection;
  includeLabel: boolean;
};

// sidebar row hover-nudge controls ([ui] sidebar-hover-*). Rows are one cell
// tall with icons in a shared column, so a vertical nudge would always paint
// over a neighbour's icon — only the horizontal pair is offered.
export type SidebarHoverDirection = "left" | "right";
export type SidebarHoverOpts = {
  enabled: boolean;
  direction: SidebarHoverDirection;
  includeLabel: boolean;
};

// icon-raster mode. `opaque` flattens every icon onto its surface bg
// (default); `transparent` keeps alpha everywhere (may fringe on some
// terminals); `transparent-partial` keeps alpha except inside FLOATING layers
// (menus/dialogs), whose rasters flatten so an opaque island never blends the
// desktop through.
export type IconMode = "opaque" | "transparent" | "transparent-partial";

// compat mode for the Linux console / dumb terminals (no kitty graphics, no
// Nerd-Font PUA): forces list view + ASCII glyphs + no rasters/thumbs/anims.
// `auto` follows the TERM prefix (same rule as gpm mouse), `on`/`off` override.
export type CompatMode = "auto" | "on" | "off";

export type UiConfig = {
  sidebarWidth: number;
  tileWidth: number;
  tileHeight: number;
  iconCells: number;
  doubleClickMs: number;
  showHidden: boolean;
  recursiveSearch: boolean;
  previewEnabled: boolean;
  previewWidth: number;
  terminalHeight: number;
  dualPane: boolean;
  sidebarAutoHide: boolean;
  sidebarCollapseStyle: string;
  previewAutoHide: boolean;
  previewCollapseStyle: string;
  terminalAutoHide: boolean;
  terminalCollapseStyle: string;
  hoverZoneCells: number;
  hoverOpenDelayMs: number;
  hoverCloseDelayMs: number;
  hoverAnimMs: number;
  restoreSession: boolean;
  persistUndo: boolean;
  followTerminal: boolean;
  transparentBg: boolean;
  icons: IconMode;
  compatMode: CompatMode;
  forceGlyph: boolean;
  sidebarTitle: boolean;
  uiStyle: UiStyle;
  tabBar: boolean;
  viewMode: ViewMode;
  toastDurationMs: number;
  typeToSearch: boolean;
  gpmMouse: boolean;
  dragThresholdCells: number;
  listRowHeight: number;
  wordWrap: boolean;
  fileAnimation: boolean;
  fileAnimationSlide: boolean;
  fileAnimationStagger: boolean;
  fileAnimationMs: number;
  fileAnimationStaggerPct: number;
  fileAnimationSlidePct: number;
  fileAnimationSlideDir: string;
  fileAnimationEase: string;
  fileAnimationScrollRevealDelayMs: number;
  fileAnimationContainerFade: boolean;
  fileAnimationVisibleOnly: boolean;
  fileAnimationRowGranularity: boolean;
  fileAnimationMaxFiles: number;
  windowedGrid: boolean;
  listingsCache: boolean;
  listingsCacheStats: boolean;
  listingsCacheTtl: number;
  fileHoverAnimation: boolean;
  fileHoverIncludeLabel: boolean;
  fileHoverDirection: HoverLiftDirection;
  sidebarAnimation: boolean;
  sidebarAnimationStyle: string;
  sidebarAnimationMs: number;
  sidebarAnimationSlideCells: number;
  sidebarAnimationSlideDir: string;
  sidebarAnimationStaggerPct: number;
  sidebarAnimationEase: string;
  sidebarAnimationIncludeTitle: boolean;
  sidebarHoverAnimation: boolean;
  sidebarHoverIncludeLabel: boolean;
  sidebarHoverDirection: SidebarHoverDirection;
  topbarAnimation: boolean;
  topbarAnimationStyle: string;
  topbarAnimationMs: number;
  topbarAnimationSlideCells: number;
  topbarAnimationSlideDir: string;
  topbarAnimationStaggerPct: number;
  topbarAnimationEase: string;
  directoryBarAnimation: boolean;
  directoryBarStyle: string;
  directoryBarMs: number;
  directoryBarSlideCells: number;
  directoryBarDir: string;
  directoryBarStaggerPct: number;
  directoryBarEase: string;
  showLaunchTime: boolean;
};

// --- keybind actions (section [keys], kebab-case in TOML, camel props here) ---
// Directional nav (move*/openSelected/extend*/page*/first/last) is one shared
// vocabulary read in every context (grid, sidebar focus, file menu, esc menu,
// search commit) — one row moves everywhere, so no cross-action conflicts.
export type KeyAction =
  | "quit"
  | "restart"
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
  | "duplicate"
  | "paste"
  | "undo"
  | "redo"
  | "parentDir"
  | "histBack"
  | "histForward"
  | "showProps"
  | "newFolder"
  | "newFile"
  | "pathEdit"
  | "togglePreview"
  | "openTerminal"
  | "connectServer"
  | "toggleView"
  | "zoomIn"
  | "zoomOut"
  | "toggleDualPane"
  | "switchPane"
  | "copyToOtherPane"
  | "moveToOtherPane"
  | "moveUp"
  | "moveDown"
  | "moveLeft"
  | "moveRight"
  | "openSelected"
  | "extendUp"
  | "extendDown"
  | "extendLeft"
  | "extendRight"
  | "pageUp"
  | "pageDown"
  | "firstItem"
  | "lastItem"
  | "toggleFocused"
  | "invertSelection"
  | "startSearch"
  | "cycleSort"
  | "goHome";

type KeysConfig = Record<KeyAction, string[]>;

export type Config = { ui: UiConfig; theme: Theme; keys: KeysConfig };

// --- schema ---

type GuiGroup =
  | "appearance"
  | "layout"
  | "animations"
  | "optimization"
  | "panes"
  | "behavior"
  | "files"
  | "advanced"
  | "keys";

type RowCommon = {
  tomlKey: string;
  prop: string;
  doc: string;
  label: string;
  group?: GuiGroup;
  // GUI-only section divider (ignored by parse/serialize): when set on
  // consecutive rows, settings-model renders one header row where the
  // subsection name changes. Rows without one belong to the group's namesake.
  subsection?: string;
};

type SchemaRow =
  | (RowCommon & { kind: "int"; section: "ui"; min: number; max: number; step: number; def: number; blurb: string })
  | (RowCommon & { kind: "bool"; section: "ui"; def: boolean; blurb: string })
  | (RowCommon & { kind: "enum"; section: "ui"; values: readonly string[]; def: string; blurb: string })
  | (RowCommon & { kind: "key"; section: "keys"; action: KeyAction; def: string[] })
  | (RowCommon & { kind: "hex"; section: "theme"; def: string; group?: undefined });

type KeyRow = Extract<SchemaRow, { kind: "key" }>;
type ThemeRow = Extract<SchemaRow, { kind: "hex" }>;
export type UiSchemaRow = Extract<SchemaRow, { section: "ui" }>;

const UI_ROWS: SchemaRow[] = [
  {
    kind: "enum",
    section: "ui",
    tomlKey: "view-mode",
    prop: "viewMode",
    values: ["grid", "list"],
    def: "grid",
    doc: '"grid" = icon tiles; "list" = compact rows with size + modified columns',
    label: "view mode",
    blurb: "Icons grid or compact list",
    group: "layout",
  },
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
    blurb: "How wide the sidebar is",
    group: "layout",
    subsection: "sizes",
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
    blurb: "How wide the preview pane is",
    group: "layout",
    subsection: "sizes",
  },
  {
    kind: "int",
    section: "ui",
    tomlKey: "terminal-height",
    prop: "terminalHeight",
    min: 4,
    max: 30,
    step: 1,
    def: 12,
    doc: "embedded terminal pane height in rows, 4..30 (applies live to the open pane)",
    label: "terminal height",
    blurb: "How tall the terminal pane is",
    group: "layout",
    subsection: "sizes",
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
    blurb: "How wide grid tiles are",
    group: "layout",
    subsection: "grid",
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
    blurb: "How tall grid tiles are",
    group: "layout",
    subsection: "grid",
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
    blurb: "How big file icons are",
    group: "layout",
    subsection: "grid",
  },
  {
    kind: "bool",
    section: "ui",
    tomlKey: "word-wrap",
    prop: "wordWrap",
    def: false,
    doc: "true = wrap long file names onto extra tile rows (grid view); false = single line cut with …",
    label: "word wrap (grid)",
    blurb: "Wrap long file names instead of cutting them",
    group: "layout",
    subsection: "grid",
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
    blurb: "How tall list rows are",
    group: "layout",
    subsection: "list",
  },
  {
    kind: "bool",
    section: "ui",
    tomlKey: "preview-enabled",
    prop: "previewEnabled",
    def: false,
    doc: "right-side preview pane (text files, folder stats)",
    label: "preview pane",
    blurb: "Show a preview of the selected file",
    group: "panes",
    subsection: "panes",
  },
  {
    kind: "bool",
    section: "ui",
    tomlKey: "dual-pane",
    prop: "dualPane",
    def: false,
    doc: "true = two independent file panes side by side (tab switches the active pane); false = single pane",
    label: "dual pane",
    blurb: "Two file panes side by side",
    group: "panes",
    subsection: "panes",
  },
  {
    kind: "bool",
    section: "ui",
    tomlKey: "sidebar-auto-hide",
    prop: "sidebarAutoHide",
    def: false,
    doc: "true = collapse the places sidebar until the mouse nears its edge (see sidebar-collapse-style)",
    label: "sidebar auto-hide",
    blurb: "Hide the sidebar until the mouse nears it",
    group: "panes",
    subsection: "auto-hide",
  },
  {
    kind: "enum",
    section: "ui",
    tomlKey: "sidebar-collapse-style",
    prop: "sidebarCollapseStyle",
    values: ["rail", "hidden", "min"],
    def: "hidden",
    doc: '"rail" = icon-only strip; "hidden" = width 0; "min" = shrink to a sliver',
    label: "sidebar collapse",
    blurb: "How the sidebar hides itself",
    group: "panes",
    subsection: "auto-hide",
  },
  {
    kind: "bool",
    section: "ui",
    tomlKey: "preview-auto-hide",
    prop: "previewAutoHide",
    def: false,
    doc: "true = collapse the preview pane until the mouse nears the right edge",
    label: "preview auto-hide",
    blurb: "Hide the preview until the mouse nears it",
    group: "panes",
    subsection: "auto-hide",
  },
  {
    kind: "enum",
    section: "ui",
    tomlKey: "preview-collapse-style",
    prop: "previewCollapseStyle",
    values: ["rail", "hidden", "min"],
    def: "hidden",
    doc: '"rail" = narrow strip; "hidden" = width 0; "min" = shrink to a sliver',
    label: "preview collapse",
    blurb: "How the preview hides itself",
    group: "panes",
    subsection: "auto-hide",
  },
  {
    kind: "bool",
    section: "ui",
    tomlKey: "terminal-auto-hide",
    prop: "terminalAutoHide",
    def: false,
    doc: "true = the open terminal pane collapses to its header until the mouse nears the bottom edge (the shell stays alive)",
    label: "terminal auto-hide",
    blurb: "Hide the terminal until the mouse nears it",
    group: "panes",
    subsection: "auto-hide",
  },
  {
    kind: "enum",
    section: "ui",
    tomlKey: "terminal-collapse-style",
    prop: "terminalCollapseStyle",
    values: ["header", "hidden"],
    def: "hidden",
    doc: '"header" = keep the title row visible; "hidden" = height 0',
    label: "terminal collapse",
    blurb: "How the terminal hides itself",
    group: "panes",
    subsection: "auto-hide",
  },
  {
    kind: "int",
    section: "ui",
    tomlKey: "hover-zone-cells",
    prop: "hoverZoneCells",
    min: 1,
    max: 8,
    step: 1,
    def: 8,
    doc: "cells from the edge that trigger an auto-hide expand, 1..8",
    label: "hover zone",
    blurb: "How close the mouse gets before panels pop out",
    group: "panes",
    subsection: "hover timing",
  },
  {
    kind: "int",
    section: "ui",
    tomlKey: "hover-open-delay-ms",
    prop: "hoverOpenDelayMs",
    min: 0,
    max: 1000,
    step: 25,
    def: 195,
    doc: "delay before an auto-hide panel expands, 0..1000 ms",
    label: "hover open delay",
    blurb: "Wait before hidden panels slide out",
    group: "panes",
    subsection: "hover timing",
  },
  {
    kind: "int",
    section: "ui",
    tomlKey: "hover-close-delay-ms",
    prop: "hoverCloseDelayMs",
    min: 0,
    max: 2000,
    step: 25,
    def: 175,
    doc: "delay before an auto-hide panel collapses (anti-flicker), 0..2000 ms",
    label: "hover close delay",
    blurb: "Wait before panels hide again",
    group: "panes",
    subsection: "hover timing",
  },
  {
    kind: "int",
    section: "ui",
    tomlKey: "hover-anim-ms",
    prop: "hoverAnimMs",
    min: 0,
    max: 600,
    step: 20,
    def: 120,
    doc: "auto-hide slide duration, 0..600 ms (0 = instant)",
    label: "hover animation",
    blurb: "How fast panels slide in and out",
    group: "panes",
    subsection: "hover timing",
  },
  {
    kind: "bool",
    section: "ui",
    tomlKey: "type-to-search",
    prop: "typeToSearch",
    def: true,
    doc: "true = typing filters the folder (bare keys); false = bare keys never filter (yazi preset flips it off, startSearch re-arms on demand)",
    label: "type to search",
    blurb: "Type to jump to files",
    group: "behavior",
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
    blurb: "How fast a double-click is",
    group: "behavior",
    subsection: "mouse",
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
    blurb: "How far you drag before it counts",
    group: "behavior",
    subsection: "mouse",
  },
  {
    kind: "bool",
    section: "ui",
    tomlKey: "gpm-mouse",
    prop: "gpmMouse",
    def: true,
    doc: "true = read mouse events from the gpm daemon on a Linux text console (no-op off a console or without gpm)",
    label: "gpm mouse",
    blurb: "Mouse support on the Linux text console",
    group: "behavior",
    subsection: "mouse",
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
    blurb: "How long notifications stay up",
    group: "behavior",
  },
  {
    kind: "bool",
    section: "ui",
    tomlKey: "follow-terminal",
    prop: "followTerminal",
    def: false,
    doc: "true = build the theme from the terminal's own colors (OSC fg/bg + palette; picked as the System theme row) instead of a fixed preset",
    label: "follow terminal",
    blurb: "Match the terminal look",
    group: "appearance",
    subsection: "style",
  },
  {
    kind: "bool",
    section: "ui",
    tomlKey: "transparent-bg",
    prop: "transparentBg",
    def: false,
    doc: "true = follow a transparent terminal bg (kitty background_opacity); false = force opaque",
    label: "transparent bg",
    blurb: "Let a transparent terminal show through",
    group: "appearance",
    subsection: "style",
  },
  {
    kind: "enum",
    section: "ui",
    tomlKey: "icons",
    prop: "icons",
    values: ["opaque", "transparent", "transparent-partial"],
    def: "opaque",
    doc: '"opaque" = icons flattened onto the tile bg (default); "transparent" = rasters keep alpha (may fringe on some terminals); "transparent-partial" = transparent except inside floating menus/dialogs',
    label: "icons",
    blurb: "How icons blend with tile backgrounds",
    group: "appearance",
    subsection: "style",
  },
  {
    kind: "enum",
    section: "ui",
    tomlKey: "ui-style",
    prop: "uiStyle",
    values: ["solid", "outline", "outline-partial"],
    def: "solid",
    doc: '"solid" = filled panels; "outline" = rounded borders, no panel fills at rest; "outline-partial" = outline chrome, solid floating panels',
    label: "ui style",
    blurb: "Filled panels or outlined ones",
    group: "appearance",
    subsection: "style",
  },
  {
    kind: "bool",
    section: "ui",
    tomlKey: "sidebar-title",
    prop: "sidebarTitle",
    def: true,
    doc: 'true = show the ASCII "tfm" logo at the top of the places sidebar; false = hide it',
    label: "sidebar title",
    blurb: "Show the logo above the sidebar",
    group: "appearance",
    subsection: "chrome",
  },
  {
    kind: "bool",
    section: "ui",
    tomlKey: "tab-bar",
    prop: "tabBar",
    def: false,
    doc: "true = strip always visible (even with one tab); false = adaptive (only while 2+ tabs are open)",
    label: "tab bar",
    blurb: "Always show the tab strip",
    group: "appearance",
  },
  {
    kind: "enum",
    section: "ui",
    tomlKey: "compat-mode",
    prop: "compatMode",
    values: ["auto", "on", "off"],
    def: "auto",
    doc: '"auto" = list + ASCII glyphs on linux/dumb terms; "on" = force it; "off" = never',
    label: "compat mode",
    blurb: "Plain fallback for the Linux console",
    group: "appearance",
    subsection: "compatibility",
  },
  {
    kind: "bool",
    section: "ui",
    tomlKey: "force-glyph",
    prop: "forceGlyph",
    def: false,
    doc: "true = skip kitty icon/thumbnail rasters, use Nerd-Font glyphs (for terminals with buggy graphics)",
    label: "force glyph",
    blurb: "Glyphs instead of image icons",
    group: "appearance",
    subsection: "compatibility",
  },
  {
    kind: "bool",
    section: "ui",
    tomlKey: "file-animation",
    prop: "fileAnimation",
    def: false,
    doc: "true = animate files appearing in the content area (style derived from file-animation-slide + file-animation-stagger)",
    label: "file animation",
    blurb: "Files glide in when folders open",
    group: "animations",
    subsection: "files",
  },
  {
    kind: "bool",
    section: "ui",
    tomlKey: "file-animation-slide",
    prop: "fileAnimationSlide",
    def: false,
    doc: "true = files rise up into place (distance = file-animation-slide-pct)",
    label: "slide",
    blurb: "Files rise into place",
    group: "animations",
    subsection: "files",
  },
  {
    kind: "bool",
    section: "ui",
    tomlKey: "file-animation-stagger",
    prop: "fileAnimationStagger",
    def: false,
    doc: "true = top-to-bottom cascade instead of one wave",
    label: "stagger",
    blurb: "Files appear one after another",
    group: "animations",
    subsection: "files",
  },
  {
    kind: "int",
    section: "ui",
    tomlKey: "file-animation-ms",
    prop: "fileAnimationMs",
    min: 0,
    max: 800,
    step: 20,
    def: 180,
    doc: "content-area file animation duration, 0..800 ms (0 = instant)",
    label: "animation ms",
    blurb: "How long file animations play",
    group: "animations",
    subsection: "files",
  },
  {
    kind: "int",
    section: "ui",
    tomlKey: "file-animation-stagger-pct",
    prop: "fileAnimationStaggerPct",
    min: 0,
    max: 300,
    step: 5,
    def: 40,
    doc: "how spread the cascade wave is, 0..300% (0 = all tiles at once; over 100 = the wave outlives the duration)",
    label: "stagger spread",
    blurb: "How spread out the cascade is",
    group: "animations",
    subsection: "files",
  },
  {
    kind: "int",
    section: "ui",
    tomlKey: "file-animation-slide-pct",
    prop: "fileAnimationSlidePct",
    min: 0,
    max: 150,
    step: 5,
    def: 70,
    doc: "how far files slide, 0..150% of the viewport (0 = fade in place; clamped to whole cells)",
    label: "slide distance",
    blurb: "How far files glide in from",
    group: "animations",
    subsection: "files",
  },
  {
    kind: "enum",
    section: "ui",
    tomlKey: "file-animation-slide-dir",
    prop: "fileAnimationSlideDir",
    values: ["up", "down", "left", "right"],
    def: "up",
    doc: '"up"/"down" = files rise/drop vertically; "left"/"right" = files slide in horizontally',
    label: "slide direction",
    blurb: "Which way files glide in from",
    group: "animations",
    subsection: "files",
  },
  {
    kind: "enum",
    section: "ui",
    tomlKey: "file-animation-ease",
    prop: "fileAnimationEase",
    values: ["linear", "ease-out", "ease-in-out"],
    def: "ease-out",
    doc: '"linear" = constant velocity; "ease-out" = fast start, soft landing; "ease-in-out" = soft both ends',
    label: "easing",
    blurb: "How the animation speeds up and settles",
    group: "animations",
    subsection: "files",
  },
  {
    kind: "bool",
    section: "ui",
    tomlKey: "file-animation-container-fade",
    prop: "fileAnimationContainerFade",
    def: true,
    doc: "true = fade the grid as one layer instead of per tile (same look, one opacity update per frame instead of one per file)",
    label: "container fade",
    blurb: "Smoother animation on big folders",
    group: "optimization",
    subsection: "performance",
  },
  {
    kind: "bool",
    section: "ui",
    tomlKey: "file-animation-visible-only",
    prop: "fileAnimationVisibleOnly",
    def: true,
    doc: "true = only animate the files inside the viewport; off-screen files appear instantly (keeps very large folders cheap)",
    label: "visible files only",
    blurb: "Only animate files you can see",
    group: "optimization",
    subsection: "performance",
  },
  {
    kind: "bool",
    section: "ui",
    tomlKey: "file-animation-row-granularity",
    prop: "fileAnimationRowGranularity",
    def: true,
    doc: "true = cascades animate grid rows instead of each file (same look at a distance, far cheaper on huge folders; tiles in one row appear together)",
    label: "row granularity",
    blurb: "Animate rows instead of single files",
    group: "optimization",
    subsection: "performance",
  },
  {
    kind: "int",
    section: "ui",
    tomlKey: "file-animation-max-files",
    prop: "fileAnimationMaxFiles",
    min: 0,
    max: 50000,
    step: 100,
    def: 2000,
    doc: "skip the file animation entirely above this many files (any animation frame re-walks the whole grid render list, huge folders jank; 0 = never skip)",
    label: "max animated files",
    blurb: "Skip animation in huge folders",
    group: "optimization",
    subsection: "performance",
  },
  {
    kind: "int",
    section: "ui",
    tomlKey: "file-animation-scroll-reveal-delay-ms",
    prop: "fileAnimationScrollRevealDelayMs",
    min: 0,
    max: 1000,
    step: 10,
    def: 0,
    doc: "wait for scroll to settle this long before playing the scroll-reveal (0 = play every notch; higher = one wave per pause: cheaper on huge folders and the wave actually completes visibly)",
    label: "scroll reveal delay",
    blurb: "Wait for scrolling to settle first",
    group: "optimization",
    subsection: "performance",
  },
  {
    kind: "bool",
    section: "ui",
    tomlKey: "windowed-grid",
    prop: "windowedGrid",
    def: true,
    doc: "true = render only the visible rows (plus overscan) of a folder, sliding as you scroll (huge folders stop rebuilding/relaying thousands of off-screen tiles; selection and search still see every file)",
    label: "windowed grid",
    blurb: "Only draw the rows on screen",
    group: "optimization",
    subsection: "performance",
  },
  {
    kind: "bool",
    section: "ui",
    tomlKey: "listings-cache",
    prop: "listingsCache",
    def: true,
    doc: "true = reuse a folder's file list across repaints until the folder itself changes (back/forward and selection changes skip the disk; some network/fuse mounts freeze the folder timestamp, so entries refresh after ~2s regardless)",
    label: "cache folder listings",
    blurb: "Remember folder contents between views",
    group: "optimization",
    subsection: "performance",
  },
  {
    kind: "bool",
    section: "ui",
    tomlKey: "listings-cache-stats",
    prop: "listingsCacheStats",
    def: true,
    doc: "true = keep file sizes/dates inside the cached folder listing too, so size/date sorts stop re-stating every file on every repaint (displayed stats can lag a live edit by up to the cache ttl)",
    label: "cache file stats",
    blurb: "Remember file sizes too, for faster sorting",
    group: "optimization",
    subsection: "performance",
  },
  {
    kind: "int",
    section: "ui",
    tomlKey: "listings-cache-ttl",
    prop: "listingsCacheTtl",
    min: 1,
    max: 300,
    step: 1,
    def: 2,
    doc: "seconds a cached folder listing may serve possibly-stale sizes/dates (or files at all on mounts whose folder timestamps freeze) before re-reading; 1 = freshest, 300 = best on slow network mounts",
    label: "listing cache ttl",
    blurb: "How long cached folder info is trusted",
    group: "optimization",
    subsection: "performance",
  },
  {
    kind: "bool",
    section: "ui",
    tomlKey: "file-hover-animation",
    prop: "fileHoverAnimation",
    def: false,
    doc: "true = hover nudges the tile icon one cell in the lift direction (rest layout unchanged; up skips the top row, tiles without room keep the highlight only)",
    label: "tile hover animation",
    blurb: "Icons lift when hovered",
    group: "animations",
    subsection: "file hover",
  },
  {
    kind: "bool",
    section: "ui",
    tomlKey: "file-hover-include-label",
    prop: "fileHoverIncludeLabel",
    def: false,
    doc: "true = the filename rides along with the hover lift",
    label: "include filename in lift",
    blurb: "File names ride along on hover",
    group: "animations",
    subsection: "file hover",
  },
  {
    kind: "enum",
    section: "ui",
    tomlKey: "file-hover-direction",
    prop: "fileHoverDirection",
    values: ["up", "down", "left", "right"],
    def: "up",
    doc: '"up"/"down" = the icon rises/drops vertically; "left"/"right" = it nudges horizontally',
    label: "hover lift direction",
    blurb: "Which way icons lift on hover",
    group: "animations",
    subsection: "file hover",
  },
  {
    kind: "bool",
    section: "ui",
    tomlKey: "sidebar-animation",
    prop: "sidebarAnimation",
    def: false,
    doc: "true = animate the places sidebar on boot (style = sidebar-animation-style)",
    label: "sidebar animation",
    blurb: "Animate the sidebar when the app starts",
    group: "animations",
    subsection: "sidebar intro",
  },
  {
    kind: "enum",
    section: "ui",
    tomlKey: "sidebar-animation-style",
    prop: "sidebarAnimationStyle",
    values: ["fade", "slide", "stagger", "stagger-slide"],
    def: "fade",
    doc: '"fade" = the whole sidebar fades in; "slide" = it slides in from the edge; "stagger" = places rows cascade in; "stagger-slide" = each row slides+fades in, files-style',
    label: "sidebar style",
    blurb: "How the sidebar arrives on startup",
    group: "animations",
    subsection: "sidebar intro",
  },
  {
    kind: "int",
    section: "ui",
    tomlKey: "sidebar-animation-ms",
    prop: "sidebarAnimationMs",
    min: 0,
    max: 800,
    step: 20,
    def: 180,
    doc: "sidebar intro duration, 0..800 ms (0 = instant)",
    label: "sidebar ms",
    blurb: "How long the sidebar intro plays",
    group: "animations",
    subsection: "sidebar intro",
  },
  {
    kind: "int",
    section: "ui",
    tomlKey: "sidebar-animation-slide-cells",
    prop: "sidebarAnimationSlideCells",
    min: 0,
    max: 32,
    step: 1,
    def: 8,
    doc: "how far the sidebar slides in, 0..32 cells (0 = fade in place)",
    label: "sidebar slide",
    blurb: "How far the sidebar slides in from",
    group: "animations",
    subsection: "sidebar intro",
  },
  {
    kind: "enum",
    section: "ui",
    tomlKey: "sidebar-animation-slide-dir",
    prop: "sidebarAnimationSlideDir",
    values: ["left", "right", "up", "down"],
    def: "left",
    doc: '"left"/"right" = slides in horizontally from the edge; "up"/"down" = slides vertically',
    label: "sidebar direction",
    blurb: "Which edge the sidebar enters from",
    group: "animations",
    subsection: "sidebar intro",
  },
  {
    kind: "int",
    section: "ui",
    tomlKey: "sidebar-animation-stagger-pct",
    prop: "sidebarAnimationStaggerPct",
    min: 0,
    max: 300,
    step: 5,
    def: 40,
    doc: "how spread the sidebar cascade is, 0..300% (0 = all rows at once)",
    label: "sidebar stagger",
    blurb: "How spread out the sidebar cascade is",
    group: "animations",
    subsection: "sidebar intro",
  },
  {
    kind: "enum",
    section: "ui",
    tomlKey: "sidebar-animation-ease",
    prop: "sidebarAnimationEase",
    values: ["linear", "ease-out", "ease-in-out"],
    def: "ease-out",
    doc: '"linear" = constant velocity; "ease-out" = fast start, soft landing; "ease-in-out" = soft both ends',
    label: "sidebar easing",
    blurb: "How the sidebar intro speeds and settles",
    group: "animations",
    subsection: "sidebar intro",
  },
  {
    kind: "bool",
    section: "ui",
    tomlKey: "sidebar-animation-include-title",
    prop: "sidebarAnimationIncludeTitle",
    def: false,
    doc: "true = the sidebar title joins the boot cascade first (stagger/stagger-slide only; fade/slide already move it with the whole panel)",
    label: "include title in intro",
    blurb: "Include the logo in the intro",
    group: "animations",
    subsection: "sidebar intro",
  },
  {
    kind: "bool",
    section: "ui",
    tomlKey: "sidebar-hover-animation",
    prop: "sidebarHoverAnimation",
    def: false,
    doc: "true = hovering a sidebar row nudges its icon one cell (rest layout unchanged; the cwd-selected row keeps its paint only)",
    label: "sidebar hover animation",
    blurb: "Sidebar icons nudge on hover",
    group: "animations",
    subsection: "sidebar hover",
  },
  {
    kind: "bool",
    section: "ui",
    tomlKey: "sidebar-hover-include-label",
    prop: "sidebarHoverIncludeLabel",
    def: false,
    doc: "true = the row label rides along with the hover nudge",
    label: "include label in nudge",
    blurb: "Row labels ride along on hover",
    group: "animations",
    subsection: "sidebar hover",
  },
  {
    kind: "enum",
    section: "ui",
    tomlKey: "sidebar-hover-direction",
    prop: "sidebarHoverDirection",
    values: ["left", "right"],
    def: "left",
    doc: '"left" = the icon nudges into the row padding; "right" = it nudges toward the label',
    label: "hover nudge direction",
    blurb: "Which way sidebar icons nudge",
    group: "animations",
    subsection: "sidebar hover",
  },
  {
    kind: "bool",
    section: "ui",
    tomlKey: "topbar-animation",
    prop: "topbarAnimation",
    def: false,
    doc: "true = cascade each top bar button + crumb in on boot (style = topbar-animation-style)",
    label: "top bar animation",
    blurb: "Animate the top bar when the app starts",
    group: "animations",
    subsection: "top bar",
  },
  {
    kind: "enum",
    section: "ui",
    tomlKey: "topbar-animation-style",
    prop: "topbarAnimationStyle",
    values: ["fade", "slide", "stagger", "stagger-slide"],
    def: "fade",
    doc: '"fade" = all items fade in together; "slide" = they slide in from the edge as one wave; "stagger" = buttons + crumbs cascade left-to-right; "stagger-slide" = each item slides+fades in, files-style',
    label: "top bar style",
    blurb: "How the top bar arrives on startup",
    group: "animations",
    subsection: "top bar",
  },
  {
    kind: "int",
    section: "ui",
    tomlKey: "topbar-animation-ms",
    prop: "topbarAnimationMs",
    min: 0,
    max: 800,
    step: 20,
    def: 180,
    doc: "top bar intro duration, 0..800 ms (0 = instant)",
    label: "top bar ms",
    blurb: "How long the top bar intro plays",
    group: "animations",
    subsection: "top bar",
  },
  {
    kind: "int",
    section: "ui",
    tomlKey: "topbar-animation-slide-cells",
    prop: "topbarAnimationSlideCells",
    min: 0,
    max: 32,
    step: 1,
    def: 8,
    doc: "how far the top bar slides in, 0..32 cells (0 = fade in place)",
    label: "top bar slide",
    blurb: "How far the top bar slides in from",
    group: "animations",
    subsection: "top bar",
  },
  {
    kind: "enum",
    section: "ui",
    tomlKey: "topbar-animation-slide-dir",
    prop: "topbarAnimationSlideDir",
    values: ["left", "right", "up", "down"],
    def: "down",
    doc: '"down"/"up" = slides in vertically from the edge; "left"/"right" = slides horizontally',
    label: "top bar direction",
    blurb: "Which edge the top bar enters from",
    group: "animations",
    subsection: "top bar",
  },
  {
    kind: "int",
    section: "ui",
    tomlKey: "topbar-animation-stagger-pct",
    prop: "topbarAnimationStaggerPct",
    min: 0,
    max: 300,
    step: 5,
    def: 40,
    doc: "how spread the item cascade is, 0..300% (0 = all items at once)",
    label: "top bar stagger",
    blurb: "How spread out the top bar cascade is",
    group: "animations",
    subsection: "top bar",
  },
  {
    kind: "enum",
    section: "ui",
    tomlKey: "topbar-animation-ease",
    prop: "topbarAnimationEase",
    values: ["linear", "ease-out", "ease-in-out"],
    def: "ease-out",
    doc: '"linear" = constant velocity; "ease-out" = fast start, soft landing; "ease-in-out" = soft both ends',
    label: "top bar easing",
    blurb: "How the top bar intro speeds and settles",
    group: "animations",
    subsection: "top bar",
  },
  {
    kind: "bool",
    section: "ui",
    tomlKey: "directory-bar-animation",
    prop: "directoryBarAnimation",
    def: false,
    doc: "true = rebuilt crumbs cascade in on every directory change (not just boot)",
    label: "directory bar animation",
    blurb: "Animate crumbs when changing folders",
    group: "animations",
    subsection: "directory bar",
  },
  {
    kind: "enum",
    section: "ui",
    tomlKey: "directory-bar-style",
    prop: "directoryBarStyle",
    values: ["fade", "slide", "stagger", "stagger-slide"],
    def: "stagger",
    doc: '"stagger" = crumbs cascade in left-to-right; "fade"/"slide" = one wave; "stagger-slide" = each crumb slides+fades in, files-style',
    label: "directory bar style",
    blurb: "How folder crumbs arrive",
    group: "animations",
    subsection: "directory bar",
  },
  {
    kind: "int",
    section: "ui",
    tomlKey: "directory-bar-ms",
    prop: "directoryBarMs",
    min: 0,
    max: 800,
    step: 20,
    def: 180,
    doc: "directory bar animation duration, 0..800 ms (0 = instant)",
    label: "directory bar ms",
    blurb: "How long the crumb animation plays",
    group: "animations",
    subsection: "directory bar",
  },
  {
    kind: "int",
    section: "ui",
    tomlKey: "directory-bar-slide-cells",
    prop: "directoryBarSlideCells",
    min: 0,
    max: 32,
    step: 1,
    def: 8,
    doc: "how far crumbs slide in, 0..32 cells (0 = fade in place)",
    label: "directory bar slide",
    blurb: "How far crumbs slide in from",
    group: "animations",
    subsection: "directory bar",
  },
  {
    kind: "enum",
    section: "ui",
    tomlKey: "directory-bar-dir",
    prop: "directoryBarDir",
    values: ["left", "right", "up", "down"],
    def: "right",
    doc: '"right"/"left" = crumbs slide in horizontally; "down"/"up" = slides vertically',
    label: "directory bar direction",
    blurb: "Which way crumbs slide in from",
    group: "animations",
    subsection: "directory bar",
  },
  {
    kind: "int",
    section: "ui",
    tomlKey: "directory-bar-stagger-pct",
    prop: "directoryBarStaggerPct",
    min: 0,
    max: 300,
    step: 5,
    def: 40,
    doc: "how spread the crumb cascade is, 0..300% (0 = all crumbs at once)",
    label: "directory bar stagger",
    blurb: "How spread out the crumb cascade is",
    group: "animations",
    subsection: "directory bar",
  },
  {
    kind: "enum",
    section: "ui",
    tomlKey: "directory-bar-ease",
    prop: "directoryBarEase",
    values: ["linear", "ease-out", "ease-in-out"],
    def: "ease-out",
    doc: '"linear" = constant velocity; "ease-out" = fast start, soft landing; "ease-in-out" = soft both ends',
    label: "directory bar easing",
    blurb: "How the crumb animation speeds and settles",
    group: "animations",
    subsection: "directory bar",
  },
  {
    kind: "bool",
    section: "ui",
    tomlKey: "show-hidden",
    prop: "showHidden",
    def: false,
    doc: "start with dotfiles visible (ctrl+h toggles at runtime)",
    label: "hidden files",
    blurb: "Show hidden files",
    group: "files",
  },
  {
    kind: "bool",
    section: "ui",
    tomlKey: "recursive-search",
    prop: "recursiveSearch",
    def: false,
    doc: "true = type-to-search also looks inside subfolders (fd when installed, built-in walk otherwise)",
    label: "recursive search",
    blurb: "Search inside subfolders too",
    group: "files",
    subsection: "listing",
  },
  {
    kind: "bool",
    section: "ui",
    tomlKey: "restore-session",
    prop: "restoreSession",
    def: false,
    doc: "true = reopen the folder from the last quit instead of the launch cwd",
    label: "restore session",
    blurb: "Reopen the last folder on startup",
    group: "files",
    subsection: "session",
  },
  {
    kind: "bool",
    section: "ui",
    tomlKey: "persist-undo",
    prop: "persistUndo",
    def: false,
    doc: "true = undo history survives restarts (journal under $XDG_STATE_HOME/tfm/, entries expire after 7 days)",
    label: "persistent undo",
    blurb: "Undo still works after a restart",
    group: "files",
    subsection: "session",
  },
  {
    kind: "bool",
    section: "ui",
    tomlKey: "show-launch-time",
    prop: "showLaunchTime",
    def: false,
    doc: "true = show a notification with the app launch time in ms (debug aid); also enabled by --debug",
    label: "show launch time",
    blurb: "Report how fast the app started",
    group: "advanced",
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

// [keys] — one row per remappable action. Directional nav included: the same
// move*/openSelected binds drive the grid, sidebar focus, file menu, esc menu
// and search commit. Still structural (not remappable): esc-close, tab inside
// menus, and the type-to-search catch-all. The 4th tuple element groups binds
// under a settings-GUI divider (same subsection mechanism as ui rows).
const KEY_ROWS: KeyRow[] = (
  [
    ["quit", "quit tfm", ["ctrl+q"], "app"],
    ["restart", "restart tfm", ["ctrl+alt+r"], "app"],
    ["openMenu", "open the esc menu", ["escape"], "app"],
    ["newTab", "new tab", ["ctrl+t"], "tabs"],
    ["closeTab", "close tab", ["ctrl+w"], "tabs"],
    ["nextTab", "next tab (cycle)", ["ctrl+tab"], "tabs"],
    ["prevTab", "previous tab (cycle)", ["ctrl+shift+tab"], "tabs"],
    ["selectAll", "select all", ["ctrl+a"], "files"],
    ["trash", "trash selection (delete forever in trash)", ["delete"], "files"],
    ["renameOrRestore", "rename / bulk rename on multi-selection (restore in trash)", ["f2"], "files"],
    ["copy", "copy selection", ["ctrl+c"], "files"],
    ["cut", "cut selection", ["ctrl+x"], "files"],
    ["duplicate", "duplicate selection (copy in place)", ["ctrl+d"], "files"],
    ["paste", "paste clipboard", ["ctrl+v"], "files"],
    ["undo", "undo last file op", ["ctrl+z"], "files"],
    ["redo", "redo (ctrl+shift+z works too)", ["ctrl+y", "ctrl+shift+z"], "files"],
    ["showProps", "properties for selection", ["alt+enter"], "files"],
    ["newFolder", "new folder", ["ctrl+shift+n"], "files"],
    ["newFile", "new file", ["ctrl+alt+n"], "files"],
    ["parentDir", "go to parent directory", ["backspace"], "navigation"],
    ["histBack", "back in history", ["alt+left"], "navigation"],
    ["histForward", "forward in history", ["alt+right"], "navigation"],
    ["goHome", "go home", [], "navigation"],
    ["pathEdit", "edit the path bar", ["ctrl+l"], "navigation"],
    ["connectServer", "connect to a network server (gvfs)", ["ctrl+shift+s"], "navigation"],
    ["moveUp", "move up (grid / menus)", ["up"], "navigation"],
    ["moveDown", "move down (grid / menus)", ["down"], "navigation"],
    ["moveLeft", "move left (grid / menus)", ["left"], "navigation"],
    ["moveRight", "move right (grid / menus)", ["right"], "navigation"],
    ["openSelected", "open / activate (grid / menus / search)", ["return"], "navigation"],
    ["pageUp", "page up", ["pageup"], "navigation"],
    ["pageDown", "page down", ["pagedown"], "navigation"],
    ["firstItem", "first item", ["home"], "navigation"],
    ["lastItem", "last item", ["end"], "navigation"],
    ["startSearch", "re-arm type-to-search filter", [], "navigation"],
    ["extendUp", "extend selection up", ["shift+up"], "selection"],
    ["extendDown", "extend selection down", ["shift+down"], "selection"],
    ["extendLeft", "extend selection left", ["shift+left"], "selection"],
    ["extendRight", "extend selection right", ["shift+right"], "selection"],
    ["toggleFocused", "toggle focused file", ["space"], "selection"],
    // unbound by default: ctrl+r reloads sidebar places (yazi preset flips
    // the pair — reload goes unbound there instead)
    ["invertSelection", "invert selection", [], "selection"],
    ["toggleHidden", "toggle hidden files", ["ctrl+h"], "view"],
    ["reloadPlaces", "reload sidebar places", ["ctrl+r"], "view"],
    ["togglePreview", "toggle preview pane", ["f9"], "view"],
    ["toggleView", "toggle grid/list view", ["ctrl+g"], "view"],
    ["cycleSort", "cycle sort mode (name → size → mtime → type)", [], "view"],
    ["zoomIn", "bigger tiles", ["ctrl+="], "view"],
    ["zoomOut", "smaller tiles", ["ctrl+-"], "view"],
    ["toggleDualPane", "toggle dual pane", ["ctrl+shift+d"], "panes"],
    ["switchPane", "switch active pane (dual pane)", ["tab"], "panes"],
    ["copyToOtherPane", "copy selection to the other pane", ["f5"], "panes"],
    ["moveToOtherPane", "move selection to the other pane", ["f6"], "panes"],
    ["openTerminal", "open terminal here", ["f4"], "panes"],
  ] as const
).map(([action, label, def, subsection]) => ({
  kind: "key",
  section: "keys",
  tomlKey: action.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`),
  prop: action,
  action: action as KeyAction,
  doc: `default: ${def.join(" or ")}`,
  label,
  group: "keys" as GuiGroup,
  subsection,
  def: [...def],
}));

export const SCHEMA: SchemaRow[] = [...UI_ROWS, ...THEME_ROWS, ...KEY_ROWS];

export const UI_SCHEMA = UI_ROWS;
export const KEY_SCHEMA = KEY_ROWS;

export const defaultConfig: Config = {
  ui: Object.fromEntries(UI_ROWS.map((r) => [r.prop, r.def])),
  theme: Object.fromEntries(THEME_ROWS.map((r) => [r.prop, r.def])),
  keys: Object.fromEntries(KEY_ROWS.map((r) => [r.prop, [...r.def]])),
} as Config;

// first OTHER action that already owns this spec, for conflict checks
export const keybindConflict = (cfg: Config, action: KeyAction, specStr: string): KeyAction | null => {
  if (!parseKeySpec(specStr)) return null;
  for (const row of KEY_ROWS) {
    if (row.action === action) continue;
    for (const s of cfg.keys[row.action] ?? []) {
      if (keySpecEqual(s, specStr)) return row.action;
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
      // legacy boolean form: `icons = true` meant the old `transparent`
      if (row.prop === "icons" && typeof raw === "boolean") return { ok: true, value: raw ? "transparent" : "opaque" };
      return typeof raw === "string" && (row.values as readonly string[]).includes(raw)
        ? { ok: true, value: raw }
        : { ok: false, value: row.def };
    case "hex":
      return typeof raw === "string" && HEX_RE.test(raw) ? { ok: true, value: raw } : { ok: false, value: row.def };
    case "key": {
      if (!Array.isArray(raw)) return { ok: false, value: row.def };
      // parse-only: bare letters/symbols are loadable from file/presets (the
      // yazi preset binds j/k/h/l…). Dispatch order (bound keys before the
      // type-to-search catch-all) + the [ui] type-to-search knob decide what
      // typing does. The settings capture UI still validates strictly.
      const specs = raw
        .filter((s): s is string => typeof s === "string" && parseKeySpec(s) !== null)
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
  "# loadable here and in presets (bound bare keys navigate before the\n" +
  "# type-to-search catch-all); [ui] type-to-search=off stops unbound ones\n" +
  "# from filtering. The settings capture UI still reserves them.\n";

export function exampleToml(): string {
  return EXAMPLE_HEADER + serializeBody(defaultConfig);
}
