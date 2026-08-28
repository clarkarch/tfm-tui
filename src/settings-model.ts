// --- Settings model: the row data wiring settings rows to config/state.
// Pure row semantics live in ./settings (applyAdjust/flattenRows), the panel
// widget in ./ui-settings; this module only builds the row list with live
// get/set closures. No renderer imports — ctx carries the sinks. ---
import { spawn } from "node:child_process";
import { THEME_PRESETS } from "./themes";
import { themePresetIdx as settingsThemePresetIdx, type SettingGroup } from "./settings";
import { configPath, defaultConfig, type Config } from "./config";

export type SettingsModelCtx = {
  // live object refs — getters/setters read through them on every call
  config: Config;
  state: { showHidden: boolean };
  applyConfig(fresh: Config): void;
  scheduleSaveConfig(): void;
  showRoot(): void;
};

export const makeSettingModel = (ctx: SettingsModelCtx) => {
  const themePresetIdx = (): number =>
    settingsThemePresetIdx(THEME_PRESETS, ctx.config.theme);

  const commitSetting = (): void => {
    ctx.applyConfig(ctx.config);
    ctx.scheduleSaveConfig();
  };

  const resetToDefaults = (): void => {
    const fresh = structuredClone(defaultConfig);
    ctx.state.showHidden = fresh.ui.showHidden;
    ctx.applyConfig(fresh);
    ctx.scheduleSaveConfig();
  };

  const settingGroups = (): SettingGroup[] => [
    {
      rows: [
        { kind: "cycle", label: "theme", names: THEME_PRESETS.map((p) => p.name), getIdx: themePresetIdx,
          setIdx: (i) => { ctx.applyConfig({ ui: { ...ctx.config.ui }, theme: { ...THEME_PRESETS[i]!.theme } }); ctx.scheduleSaveConfig(); } },
        { kind: "toggle", label: "hidden files",
          // state.showHidden is the effective runtime flag (ctrl+h writes it
          // without persisting); config is only updated when the GUI commits
          get: () => ctx.state.showHidden,
          set: (v) => { ctx.config.ui.showHidden = v; ctx.state.showHidden = v; commitSetting(); } },
        { kind: "toggle", label: "preview pane", get: () => ctx.config.ui.previewEnabled,
          set: (v) => { ctx.config.ui.previewEnabled = v; commitSetting(); } },
        // fresh-object setters (see transparent-bg below): toggles that flip
        // renderer/layout state must not mutate `config` before applyConfig
        // cycle, not toggle: false = adaptive (strip only with 2+ tabs), true = always
        { kind: "cycle", label: "tab bar", names: ["adaptive", "on"], getIdx: () => (ctx.config.ui.tabBar ? 1 : 0),
          setIdx: (i) => { ctx.applyConfig({ ui: { ...ctx.config.ui, tabBar: i === 1 }, theme: { ...ctx.config.theme } }); ctx.scheduleSaveConfig(); } },
        { kind: "toggle", label: "list view", get: () => ctx.config.ui.viewMode === "list",
          set: (v) => { ctx.applyConfig({ ui: { ...ctx.config.ui, viewMode: v ? "list" : "grid" }, theme: { ...ctx.config.theme } }); ctx.scheduleSaveConfig(); } },
        // fresh-object setter on purpose: applyConfig diffs config vs fresh, so
        // mutating config first (like the rows above) would self-compare equal
        // and skip the cache-invalidation/clear-color swap
        { kind: "toggle", label: "transparent bg", get: () => ctx.config.ui.transparentBg,
          set: (v) => { ctx.applyConfig({ ui: { ...ctx.config.ui, transparentBg: v }, theme: { ...ctx.config.theme } }); ctx.scheduleSaveConfig(); } },
        { kind: "cycle", label: "ui style", names: ["solid", "outline"], getIdx: () => (ctx.config.ui.uiStyle === "outline" ? 1 : 0),
          setIdx: (i) => { ctx.applyConfig({ ui: { ...ctx.config.ui, uiStyle: i === 1 ? "outline" : "solid" }, theme: { ...ctx.config.theme } }); ctx.scheduleSaveConfig(); } },
      ],
    },
    {
      header: "layout",
      rows: [
        { kind: "stepper", label: "sidebar width", min: 16, max: 60, step: 1, fmt: (v) => `${v}`, get: () => ctx.config.ui.sidebarWidth, set: (v) => { ctx.config.ui.sidebarWidth = v; commitSetting(); } },
        { kind: "stepper", label: "tile width", min: 10, max: 40, step: 1, fmt: (v) => `${v}`, get: () => ctx.config.ui.tileWidth, set: (v) => { ctx.config.ui.tileWidth = v; commitSetting(); } },
        { kind: "stepper", label: "tile height", min: 3, max: 10, step: 1, fmt: (v) => `${v}`, get: () => ctx.config.ui.tileHeight, set: (v) => { ctx.config.ui.tileHeight = v; commitSetting(); } },
        { kind: "stepper", label: "icon size", min: 1, max: 5, step: 1, fmt: (v) => `${v}`, get: () => ctx.config.ui.iconCells, set: (v) => { ctx.config.ui.iconCells = v; commitSetting(); } },
        { kind: "stepper", label: "preview width", min: 20, max: 80, step: 2, fmt: (v) => `${v}`, get: () => ctx.config.ui.previewWidth, set: (v) => { ctx.config.ui.previewWidth = v; commitSetting(); } },
      ],
    },
    {
      header: "behavior",
      rows: [
        { kind: "stepper", label: "double-click ms", min: 100, max: 2000, step: 50, fmt: (v) => `${v}`, get: () => ctx.config.ui.doubleClickMs, set: (v) => { ctx.config.ui.doubleClickMs = v; commitSetting(); } },
      ],
    },
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
