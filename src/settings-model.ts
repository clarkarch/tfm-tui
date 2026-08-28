// --- Settings model: the row data wiring settings rows to config/state.
// Row TYPES + pure semantics live in ./settings, the panel widget in
// ./ui-settings. Rows for schema-defined keys (config-schema.ts) are built
// generically here; hand-written rows are only the ones with special
// presentations: theme presets, tab-bar adaptive/on, show-hidden state sync.
// No renderer imports — ctx carries the sinks. ---
import { spawn } from "node:child_process";
import { THEME_PRESETS } from "./themes";
import { themePresetIdx as settingsThemePresetIdx, type SettingGroup, type SettingRow } from "./settings";
import { configPath, defaultConfig, type Config, type UiConfig } from "./config";
import {
  KEY_SCHEMA,
  UI_SCHEMA,
  keybindConflict,
  type KeyAction,
  type UiSchemaRow,
} from "./config-schema";

export type SettingsModelCtx = {
  // live object refs — getters/setters read through them on every call
  config: Config;
  state: { showHidden: boolean };
  applyConfig(fresh: Config): void;
  scheduleSaveConfig(): void;
  showRoot(): void;
  // conflict toasts for remapping (wired to notify in index)
  warn(message: string, title?: string): void;
};

export const makeSettingModel = (ctx: SettingsModelCtx) => {
  const themePresetIdx = (): number =>
    settingsThemePresetIdx(THEME_PRESETS, ctx.config.theme);

  // fresh-object commit: applyConfig diffs vs its LAST-APPLIED state, but
  // building a fresh Config keeps renderer-flipping rows correct regardless
  const commit = (fresh: Config): void => {
    ctx.applyConfig(fresh);
    ctx.scheduleSaveConfig();
  };

  const commitUi = (patch: Partial<UiConfig>): void => {
    commit({ ui: { ...ctx.config.ui, ...patch }, theme: { ...ctx.config.theme }, keys: { ...ctx.config.keys } });
  };

  const commitKeys = (action: KeyAction, binds: string[]): void => {
    commit({ ui: { ...ctx.config.ui }, theme: { ...ctx.config.theme }, keys: { ...ctx.config.keys, [action]: binds } });
  };

  const resetToDefaults = (): void => {
    const fresh = structuredClone(defaultConfig);
    ctx.state.showHidden = fresh.ui.showHidden;
    commit(fresh);
  };

  // generic row builders — one per schema kind
  const schemaRow = (row: UiSchemaRow): SettingRow => {
    const ui = ctx.config.ui as unknown as Record<string, unknown>;
    switch (row.kind) {
      case "int":
        return {
          kind: "stepper", label: row.label, min: row.min, max: row.max, step: row.step,
          fmt: (v) => `${v}`,
          get: () => (ui[row.prop] as number) ?? row.def,
          set: (v) => commitUi({ [row.prop]: v } as Partial<UiConfig>),
        };
      case "bool":
        return {
          kind: "toggle", label: row.label,
          get: () => !!ui[row.prop],
          set: (v) => commitUi({ [row.prop]: v } as Partial<UiConfig>),
        };
      case "enum":
        return {
          kind: "cycle", label: row.label, names: [...row.values],
          getIdx: () => row.values.indexOf(String(ui[row.prop] ?? row.def)),
          setIdx: (i) => commitUi({ [row.prop]: row.values[i] } as Partial<UiConfig>),
        };
    }
  };

  const keybindRow = (action: KeyAction, label: string): SettingRow => ({
    kind: "keybind", label,
    get: () => ctx.config.keys[action] ?? [],
    set: (v) => {
      // conflict check: reject a bind another action already owns
      for (const spec of v) {
        const clash = keybindConflict(ctx.config, action, spec);
        if (clash) {
          const labelOf = KEY_SCHEMA.find((r) => r.action === clash)?.label ?? clash;
          ctx.warn(`"${spec}" is already used by: ${labelOf}`, "keybind conflict");
          return;
        }
      }
      commitKeys(action, v);
    },
  });

  const uiRowsIn = (group: UiSchemaRow["group"]): UiSchemaRow[] =>
    UI_SCHEMA.filter((r): r is UiSchemaRow => r.section === "ui" && r.group === group);

  // general: hand-rolled rows first (theme / hidden-files state sync), then
  // schema rows minus the two with special presentations (show-hidden, tab-bar)
  const generalRows = (): SettingRow[] => {
    const rows: SettingRow[] = [
      { kind: "cycle", label: "theme", repaint: true, names: THEME_PRESETS.map((p) => p.name), getIdx: themePresetIdx,
        setIdx: (i) => { commit({ ui: { ...ctx.config.ui }, theme: { ...THEME_PRESETS[i]!.theme }, keys: { ...ctx.config.keys } }); } },
      { kind: "toggle", label: "hidden files",
        // state.showHidden is the effective runtime flag (the remap bind writes
        // it without persisting); config is only updated when the GUI commits
        get: () => ctx.state.showHidden,
        set: (v) => { ctx.state.showHidden = v; commitUi({ showHidden: v }); } },
      // cycle, not toggle: false = adaptive (strip only with 2+ tabs), true = always
      { kind: "cycle", label: "tab bar", names: ["adaptive", "on"], getIdx: () => (ctx.config.ui.tabBar ? 1 : 0),
        setIdx: (i) => commitUi({ tabBar: i === 1 }) },
    ];
    for (const row of uiRowsIn("general")) {
      if (row.prop === "showHidden" || row.prop === "tabBar") continue;
      const built = schemaRow(row);
      // these change the PANEL's own colors — their adjust must re-render it
      if (row.prop === "uiStyle" || row.prop === "transparentBg") {
        if (built.kind === "toggle" || built.kind === "cycle") built.repaint = true;
      }
      rows.push(built);
    }
    return rows;
  };

  const settingGroups = (): SettingGroup[] => [
    { header: "general", rows: generalRows() },
    { header: "layout", rows: uiRowsIn("layout").map(schemaRow) },
    { header: "behavior", rows: uiRowsIn("behavior").map(schemaRow) },
    { header: "keybindings", rows: KEY_SCHEMA.map((r) => keybindRow(r.action, r.label)) },
    {
      header: "config",
      rows: [
        { kind: "action", label: "reset to defaults", keepOpen: true, run: resetToDefaults },
        { kind: "action", label: "edit config.toml…", run: () => { spawn("xdg-open", [configPath()], { stdio: "ignore", detached: true }).unref?.(); } },
        { kind: "action", label: "back", keepOpen: true, run: () => ctx.showRoot() },
      ],
    },
  ];

  return { settingGroups, resetToDefaults };
};
