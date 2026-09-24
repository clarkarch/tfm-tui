// --- Settings model: the row data wiring settings rows to config/state.
// Row TYPES + pure semantics live in ./settings, the panel widget in
// ./ui-settings. Rows for schema-defined keys (config-schema.ts) are built
// generically here; hand-written rows are only the ones with special
// presentations: theme presets, tab-bar adaptive/on, show-hidden state sync.
// No renderer imports — ctx carries the sinks. ---
import { spawnSafe } from "../fs/spawn-safe";
import { THEME_PRESETS } from "../config/themes";
import type { LoadedPlugin } from "../plugins/plugin-api";
import {
  themeNearestIdx as settingsThemeNearestIdx,
  themePresetIdx as settingsThemePresetIdx,
  type SettingGroup,
  type SettingRow,
} from "./settings";
import { configPath, defaultConfig, type Config, type UiConfig } from "../config/config";
import { KEY_SCHEMA, UI_SCHEMA, keybindConflict, type KeyAction, type UiSchemaRow } from "../config/config-schema";
import { keySpecEqual, validateKeybindSpec } from "../config/keyspec";
import { isDark } from "./tty";
import { getPluginCommandBinds, setPluginCommandBinds } from "../plugins/plugin-api";
import {
  KEYMAP_PRESET_NAMES,
  PRESET_TYPE_TO_SEARCH,
  PRESET_VIEW_MODE,
  keymapPresetIdx,
  presetKeys,
} from "../config/keymap-presets";

export type SettingsModelCtx = {
  // live object refs — getters/setters read through them on every call
  config: Config;
  state: { showHidden: boolean };
  applyConfig(fresh: Config): void;
  scheduleSaveConfig(): void;
  // conflict toasts for remapping (wired to notify in the settings wiring)
  warn(message: string, title?: string): void;
  // installed plugins (loader aggregates them; absent = no plugins). The
  // model renders one category PER PLUGIN (never inside core groups), each
  // led by a core-built on/off toggle over the plugin's own store.
  plugins?: () => LoadedPlugin[];
  // fired after the on/off toggle writes the store: the wiring re-registers or
  // drops the plugin's UI slots and repaints (the store flag alone only feeds
  // the action-surface filters, which read it lazily). Optional for tests.
  onPluginEnabledChanged?(name: string, enabled: boolean): void;
  // system-theme resolve (terminal query → applyConfig): fired when the user
  // picks the System theme entry. Optional so row SHAPE stays testable
  // without it; absent = flag commits, derived colors land on next boot.
  resolveSystemTheme?(): void;
  // console-mode read: when active the theme row is display-only (one static
  // console palette paints regardless of presets). Optional so tests stay light.
  isTtyMode?(): boolean;
  // git installer orchestration (wired in wiring/settings — prompt, danger
  // confirm, clone/pull/rm, rescan). Optional so row SHAPE stays testable
  // without it; rows no-op when absent. Never throws (fire-and-forget).
  pluginInstall?: {
    addFromUrl(): void;
    openFolder(): void;
    update(name: string): void;
    remove(name: string): void;
  };
};

export const makeSettingModel = (ctx: SettingsModelCtx) => {
  const themePresetIdx = (): number => settingsThemePresetIdx(THEME_PRESETS, ctx.config.theme);
  // plugin rows are boot-loaded once (restart-to-reload); absent without plugins
  const loadedPlugins = (): LoadedPlugin[] => ctx.plugins?.() ?? [];

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
          kind: "stepper",
          label: row.label,
          blurb: row.blurb,
          min: row.min,
          max: row.max,
          step: row.step,
          fmt: (v) => `${v}`,
          get: () => (ui[row.prop] as number) ?? row.def,
          set: (v) => commitUi({ [row.prop]: v } as Partial<UiConfig>),
        };
      case "bool":
        return {
          kind: "toggle",
          label: row.label,
          blurb: row.blurb,
          get: () => !!ui[row.prop],
          set: (v) => commitUi({ [row.prop]: v } as Partial<UiConfig>),
        };
      case "enum":
        return {
          kind: "cycle",
          label: row.label,
          blurb: row.blurb,
          names: [...row.values],
          getIdx: () => row.values.indexOf(String(ui[row.prop] ?? row.def)),
          setIdx: (i) => commitUi({ [row.prop]: row.values[i] } as Partial<UiConfig>),
        };
    }
  };

  const keybindRow = (action: KeyAction, label: string): SettingRow => ({
    kind: "keybind",
    label,
    blurb: "Press enter, then a new key",
    get: () => ctx.config.keys[action] ?? [],
    set: (v) => {
      // conflict check: reject a bind another core action already owns — and
      // (P1-2) one a plugin command owns, so core remaps can't silently
      // shadow plugin binds either direction.
      for (const spec of v) {
        const clash = keybindConflict(ctx.config, action, spec);
        if (clash) {
          const labelOf = KEY_SCHEMA.find((r) => r.action === clash)?.label ?? clash;
          ctx.warn(`"${spec}" is already used by: ${labelOf}`, "keybind conflict");
          return;
        }
        const pluginOwner = pluginBindOwner(spec);
        if (pluginOwner) {
          ctx.warn(`"${spec}" is already used by: ${pluginOwner}`, "keybind conflict");
          return;
        }
      }
      commitKeys(action, v);
    },
  });

  const uiRowsIn = (group: NonNullable<UiSchemaRow["group"]>): UiSchemaRow[] =>
    UI_SCHEMA.filter((r): r is UiSchemaRow => r.section === "ui" && r.group === group);

  // rows with a presentation a generic schema row can't express (theme presets
  // (+ the System terminal-following entry), adaptive/on tab bar, live
  // show-hidden state sync) are built by hand and spliced into their category;
  // the schema row still exists for parsing
  const SPECIAL_UI_PROPS = new Set(["showHidden", "tabBar", "followTerminal"]);

  const themeRow = (): SettingRow => {
    // "System" leads: it owns the [ui] follow-terminal knob (the schema row
    // is skipped in genericUiRows via SPECIAL_UI_PROPS) and builds the theme
    // from the terminal's own colors on select; presets sit behind it at +1.
    // On the console the row is display-only: one static palette paints no
    // matter the preset, so adjusting warns instead of committing (config is
    // still stored, and applies back on a graphical terminal).
    const names = ["System", ...THEME_PRESETS.map((p) => p.name)];
    return {
      kind: "cycle",
      label: "theme",
      blurb: "Pick a look, or follow your terminal",
      repaint: true,
      names,
      getIdx: () => {
        if (ctx.isTtyMode?.()) return -1;
        if (ctx.config.ui.followTerminal) return 0;
        const i = themePresetIdx();
        return i < 0 ? -1 : i + 1;
      },
      setIdx: (i) => {
        if (ctx.isTtyMode?.()) {
          ctx.warn("theme is fixed on the console — presets apply back on a graphical terminal", "theme");
          return;
        }
        if (i === 0) {
          commit({
            ui: { ...ctx.config.ui, followTerminal: true },
            theme: { ...ctx.config.theme },
            keys: { ...ctx.config.keys },
          });
          // fire-and-forget by contract: the wiring wraps the promise with
          // .catch (a try/catch here could never see an async rejection)
          ctx.resolveSystemTheme?.();
          return;
        }
        // i - 1 indexes the preset list; a stale index leaves the theme alone
        const preset = THEME_PRESETS[i - 1];
        if (!preset) return;
        commit({
          ui: { ...ctx.config.ui, followTerminal: false },
          theme: { ...preset.theme },
          keys: { ...ctx.config.keys },
        });
      },
      // hand-edited themes match no preset: name the nearest one with a ~
      // prefix (picking any preset returns to an exact match). On the console
      // the static palette is named instead.
      customLabel: () => {
        if (ctx.isTtyMode?.()) return isDark(ctx.config.theme.bg) ? "Console" : "Console Light";
        const n = settingsThemeNearestIdx(THEME_PRESETS, ctx.config.theme);
        const near = n >= 0 ? THEME_PRESETS[n] : undefined;
        return near ? `~${near.name}` : "custom";
      },
    };
  };

  const hiddenFilesRow = (): SettingRow => ({
    kind: "toggle",
    label: "hidden files",
    blurb: "Show hidden files",
    // state.showHidden is the effective runtime flag (the remap bind writes
    // it without persisting); config is only updated when the GUI commits
    get: () => ctx.state.showHidden,
    set: (v) => {
      ctx.state.showHidden = v;
      commitUi({ showHidden: v });
    },
  });

  // cycle, not toggle: false = adaptive (strip only with 2+ tabs), true = always
  const tabBarRow = (): SettingRow => ({
    kind: "cycle",
    label: "tab bar",
    blurb: "Always show the tab strip",
    names: ["adaptive", "on"],
    getIdx: () => (ctx.config.ui.tabBar ? 1 : 0),
    setIdx: (i) => commitUi({ tabBar: i === 1 }),
  });

  // keymap preset switch (tfm/yazi): one batch commit over the whole [keys]
  // table + the type-to-search/view flips, like manual remaps (nothing
  // stashed). Leads the keys category like the theme row leads appearance.
  const keymapPresetRow = (): SettingRow => ({
    kind: "cycle",
    label: "keymap preset",
    blurb: "tfm or yazi style shortcuts",
    // repaint: one batch rewrites EVERY keybind row's value, so the panel
    // must rebuild (afterAdjust only repaints the adjusted row itself —
    // without this the new binds appear only as rows scroll into view)
    repaint: true,
    names: [...KEYMAP_PRESET_NAMES],
    getIdx: () => keymapPresetIdx(ctx.config.keys),
    setIdx: (i) => {
      const name = KEYMAP_PRESET_NAMES[i];
      if (name === undefined) return;
      commit({
        ui: { ...ctx.config.ui, typeToSearch: PRESET_TYPE_TO_SEARCH[name], viewMode: PRESET_VIEW_MODE[name] },
        theme: { ...ctx.config.theme },
        keys: presetKeys(name),
      });
      ctx.warn(
        name === "yazi"
          ? "yazi keymap on · list view, hjkl move, space toggles, q quits, / searches"
          : "tfm keymap on · grid view, type-to-search restored",
        "keymap preset",
      );
    },
    customLabel: () => "custom",
  });

  // keys category: same subsection-divider mechanism as genericUiRows —
  // one header row where the schema subsection changes (first section leads
  // with one too, so every binds group is labeled)
  const keyRowsWithHeaders = (): SettingRow[] => {
    const rows: SettingRow[] = [keymapPresetRow()];
    let subsection = "";
    for (const r of KEY_SCHEMA) {
      if (r.subsection && r.subsection !== subsection) {
        subsection = r.subsection;
        rows.push({ kind: "header", label: r.subsection });
      }
      rows.push(keybindRow(r.action, r.label));
    }
    return rows;
  };

  const genericUiRows = (group: NonNullable<UiSchemaRow["group"]>): SettingRow[] => {
    const rows: SettingRow[] = [];
    // subsection dividers: one header row where the schema's subsection name
    // changes — including the first section, so every group with dividers is
    // uniformly labeled (groups without subsections render no headers at all)
    let subsection = "";
    for (const row of uiRowsIn(group)) {
      if (SPECIAL_UI_PROPS.has(row.prop)) continue;
      if (row.subsection && row.subsection !== subsection) {
        subsection = row.subsection;
        rows.push({ kind: "header", label: row.subsection });
      }
      const built = schemaRow(row);
      // these change the PANEL's own colors (or its icons) — their adjust must re-render it
      if (
        row.prop === "uiStyle" ||
        row.prop === "transparentBg" ||
        row.prop === "icons" ||
        row.prop === "ttyMode" ||
        row.prop === "forceGlyph"
      ) {
        if (built.kind === "toggle" || built.kind === "cycle") built.repaint = true;
      }
      rows.push(built);
    }
    return rows;
  };

  // ordered categories: schema `group` id -> GUI label + category icon. Icons
  // are existing assets/icons SVGs; a wrong name silently falls back to the
  // generic cog (AGENTS.md), so keep these byte-identical to filenames.
  // Order is everyday priority: look first, tuning last.
  const CATEGORIES: { id: NonNullable<UiSchemaRow["group"]>; label: string; icon: string }[] = [
    { id: "appearance", label: "appearance", icon: "pencil" },
    { id: "layout", label: "layout", icon: "select-all" },
    { id: "files", label: "files & session", icon: "folder" },
    { id: "behavior", label: "behavior", icon: "clock" },
    { id: "panes", label: "panes", icon: "desktop-tower" },
    { id: "keys", label: "keys", icon: "sort" },
    { id: "animations", label: "animations", icon: "play" },
    { id: "optimization", label: "optimization", icon: "power" },
    { id: "advanced", label: "advanced", icon: "cog" },
  ];

  const advancedRows = (): SettingRow[] => [
    ...genericUiRows("advanced"),
    {
      kind: "action",
      label: "reset to defaults",
      blurb: "Put every setting back",
      keepOpen: true,
      run: resetToDefaults,
    },
    {
      kind: "action",
      label: "edit config.toml…",
      blurb: "Open the settings file",
      run: () => {
        spawnSafe("xdg-open", [configPath()], { stdio: "ignore", detached: true }, (err) =>
          ctx.warn(err.message, "config"),
        ).unref?.();
      },
    },
  ];

  const settingGroups = (): SettingGroup[] =>
    CATEGORIES.map((cat) => {
      let rows: SettingRow[];
      switch (cat.id) {
        case "keys":
          rows = keyRowsWithHeaders();
          break;
        case "appearance": {
          // tab bar is chrome-visibility but its row is hand-built and appended
          // after the generic rows, so splice it ahead of the trailing
          // terminal section so it keeps trailing its own ##chrome
          // header instead of the terminal pair
          const uiRows = [themeRow(), ...genericUiRows("appearance")];
          const terminalIdx = uiRows.findIndex((r) => r.kind === "header" && r.label === "terminal");
          const tabRow = tabBarRow();
          if (terminalIdx >= 0) uiRows.splice(terminalIdx, 0, tabRow);
          else uiRows.push(tabRow);
          rows = uiRows;
          break;
        }
        case "files":
          rows = [hiddenFilesRow(), ...genericUiRows("files")];
          break;
        case "advanced":
          rows = advancedRows();
          break;
        default:
          rows = genericUiRows(cat.id);
      }
      return { header: cat.label, icon: cat.icon, rows };
    });

  // one category per installed plugin, each led by its on/off toggle. The
  // toggle is `repaint` so flipping it rebuilds the panel live (rows vanish
  // or appear without a restart); the toggle itself always stays so a
  // disabled plugin can be re-enabled. Reads the store on every build, so
  // the rows always reflect the persisted flag. A throwing store/row never
  // breaks the other plugins' categories — that plugin degrades to its
  // toggle alone (or enabled=true when even the flag read fails).
  const safeEnabled = (p: LoadedPlugin): boolean => {
    try {
      return p.store.get("enabled", true);
    } catch (err) {
      try {
        ctx.warn(`plugin ${p.name} store failed: ${err instanceof Error ? err.message : err}`, "plugins");
      } catch {}
      return true;
    }
  };
  // owner lookup across plugin commands (core coverage lives in
  // keybindConflict, which only knows KeyAction).
  const pluginBindOwner = (spec: string, except?: { plugin: LoadedPlugin; id: string }): string | null => {
    for (const q of loadedPlugins()) {
      for (const qc of q.commands) {
        if (except && q === except.plugin && qc.id === except.id) continue;
        for (const owned of getPluginCommandBinds(q, qc.id)) {
          if (keySpecEqual(owned, spec)) return qc.title;
        }
      }
    }
    return null;
  };

  // installer category — ALWAYS first so the Plugins view exists (and the
  // install flow is discoverable) before anything is installed. Rows dispatch
  // to the wiring-provided orchestration; they no-op when it is absent.
  const installGroup = (): SettingGroup => ({
    header: "add plugins",
    rows: [
      {
        kind: "action",
        label: "Add from git URL…",
        blurb: "Install a plugin from a link",
        keepOpen: true,
        run: () => {
          try {
            ctx.pluginInstall?.addFromUrl();
          } catch (err) {
            try {
              ctx.warn(`add plugin failed: ${err instanceof Error ? err.message : err}`, "plugins");
            } catch {}
          }
        },
      },
      {
        kind: "action",
        label: "Open plugins folder…",
        blurb: "Browse installed plugins",
        // not keepOpen: navigating with the menu up strands the user over a
        // changed cwd — close first (rowActivate closes, then runs), landing
        // in the folder
        run: () => {
          try {
            ctx.pluginInstall?.openFolder();
          } catch (err) {
            try {
              ctx.warn(`open plugins folder failed: ${err instanceof Error ? err.message : err}`, "plugins");
            } catch {}
          }
        },
      },
    ],
  });

  // per-plugin lifecycle rows (git update + remove with danger confirm —
  // the orchestration rescans + rebuilds the panel afterwards)
  const lifecycleRows = (p: LoadedPlugin): SettingRow[] => [
    {
      kind: "action",
      label: "Update from git",
      blurb: "Pull the newest version",
      keepOpen: true,
      run: () => {
        try {
          ctx.pluginInstall?.update(p.name);
        } catch (err) {
          try {
            ctx.warn(`update ${p.name} failed: ${err instanceof Error ? err.message : err}`, "plugins");
          } catch {}
        }
      },
    },
    {
      kind: "action",
      label: "Remove…",
      blurb: "Delete this plugin",
      keepOpen: true,
      run: () => {
        try {
          ctx.pluginInstall?.remove(p.name);
        } catch (err) {
          try {
            ctx.warn(`remove ${p.name} failed: ${err instanceof Error ? err.message : err}`, "plugins");
          } catch {}
        }
      },
    },
  ];

  const pluginGroups = (): SettingGroup[] => [
    installGroup(),
    ...loadedPlugins().map((p) => {
      const enabledRow: SettingRow = {
        kind: "toggle",
        label: "enabled",
        repaint: true,
        get: () => safeEnabled(p),
        set: (v) => {
          try {
            p.store.set("enabled", v);
            ctx.onPluginEnabledChanged?.(p.name, v);
          } catch (err) {
            try {
              ctx.warn(`plugin ${p.name} store failed: ${err instanceof Error ? err.message : err}`, "plugins");
            } catch {}
          }
        },
      };
      let rows: SettingRow[];
      try {
        rows = safeEnabled(p) ? p.rows : [];
      } catch {
        rows = [];
      }
      // one remappable keybind row per plugin command (persisted in the
      // plugin's own store under keys:<id>, never in config.toml).
      let keyRows: SettingRow[] = [];
      try {
        if (safeEnabled(p) && p.commands.length) {
          keyRows = p.commands.map(
            (c): SettingRow => ({
              kind: "keybind",
              label: `${c.title} (key)`,
              get: () => getPluginCommandBinds(p, c.id),
              set: (v) => {
                // every rejection warns through the guarded helper (a
                // throwing warn must never escape a row setter)
                const reject = (message: string): void => {
                  try {
                    ctx.warn(message, "keybind conflict");
                  } catch {}
                };
                for (const spec of v) {
                  const problem = validateKeybindSpec(spec);
                  if (problem) {
                    reject(`"${spec}" invalid: ${problem}`);
                    return;
                  }
                  // core owns its binds — plugins remap around them
                  for (const row of KEY_SCHEMA) {
                    for (const owned of ctx.config.keys[row.action] ?? []) {
                      if (keySpecEqual(owned, spec)) {
                        reject(`"${spec}" is already used by: ${row.label}`);
                        return;
                      }
                    }
                  }
                  // other plugins (and sibling commands) own theirs too
                  const siblingOwner = pluginBindOwner(spec, { plugin: p, id: c.id });
                  if (siblingOwner) {
                    reject(`"${spec}" is already used by: ${siblingOwner}`);
                    return;
                  }
                }
                try {
                  setPluginCommandBinds(p, c.id, v);
                } catch (err) {
                  try {
                    ctx.warn(`plugin ${p.name} store failed: ${err instanceof Error ? err.message : err}`, "plugins");
                  } catch {}
                }
              },
            }),
          );
        }
      } catch {
        keyRows = [];
      }
      // manifest metadata in the category header: name · version · author · description
      const meta = [p.version, p.author, p.description.slice(0, 40)].filter(Boolean).join(" · ");
      return {
        header: meta ? `${p.name} · ${meta}` : p.name,
        rows: [enabledRow, ...rows, ...keyRows, ...lifecycleRows(p)],
      };
    }),
  ];

  return { settingGroups, pluginGroups, resetToDefaults };
};
