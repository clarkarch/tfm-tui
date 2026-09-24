// --- Settings wiring: the settings model (rows -> config), the esc menu
// panel, and — as a separate wire call so the boot sequence can run between
// them, matching the original wiring order — the retheme/config-apply path
// (live theme switch, geometry rewrites, config persistence). ---

import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { Text } from "@opentui/core";
import { truncateToastText, wrapToastText } from "../ui/notify";
import { THEME_PRESETS } from "../config/themes";
import { themePresetIdx } from "../ui/settings";
import { makeSettingModel } from "../ui/settings-model";
import { makeSystemTheme } from "../ui/ui-system-theme";
import { MENU_W } from "../ui/ui-menu";
import { makeEscMenu } from "../ui/ui-settings";
import { makeRetheme } from "../ui/ui-retheme";
import { sharedPluginEvents } from "../lib/plugin-events";
import { clearIconCaches } from "../ui/icons";
import { cancelBand } from "../input/grid-input";
import { clearChildren } from "../lib/uiutil";
import { dlog } from "../app/log";
import { pointPaneAt } from "../app/panes";
import {
  AmbiguousPluginError,
  derivePluginName,
  installPlugin,
  parseGitUrl,
  removePluginDir,
  updatePlugin,
} from "../plugins/plugin-install";
import { pluginsDir } from "../plugins/plugins";
import type { CoreWiring } from "./core";
import type { ChromeWiring, FileopsWiring, GridWiring, NavWiring, SettingsWiring } from "./types";
import type { PluginsWiring } from "./plugins";

export type RethemeWiring = ReturnType<typeof wireRetheme>;

export const wireSettings = (deps: {
  core: CoreWiring;
  nav: NavWiring;
  chrome: ChromeWiring;
  grid: GridWiring;
  plugins: PluginsWiring;
  // retheme wiring runs after the boot sequence — deferred arrows (TDZ)
  getRetheme: () => RethemeWiring;
  // prompt overlay wires LAST (keymap) — only called from post-boot row
  // actions, never during construction (same TDZ seam as wirePlugins)
  getPrompt: () => {
    open(opts: { title: string; placeholder?: string; okLabel?: string; initial?: string }): Promise<string | null>;
  };
}) => {
  const { core, nav, chrome, grid, plugins, getRetheme, getPrompt } = deps;

  // --- Plugin git installer orchestration: prompt -> validate -> danger
  // confirm -> clone/pull/rm -> rescan + live panel rebuild. Fire-and-forget
  // rows (never throws — every failure is a toast + dlog). Serialized with
  // an in-flight guard so double-activation can't double-clone. ---
  let installBusy = false;
  // progress lives in the toast stack (sticky, closed on settle) — never on
  // the status bar, which the selection summary reclaims mid-operation.
  // Same shape as notify(): theme fg (bare Text inherits the wrong color on
  // the accent bg) with the message wrapped to fit the box — a single long
  // Text overflows the fixed width and clips.
  const stickyProgress = (title: string, message: string): (() => void) => {
    const c = core.themeGet();
    const lines = wrapToastText(message, 36, 2);
    try {
      const handle = chrome.notifySticky(
        [
          Text({ content: truncateToastText(title, 36), fg: c.white }),
          ...lines.map((line) => Text({ content: line, fg: c.sidebarFgMuted })),
        ],
        { width: 40, height: 1 + lines.length },
      );
      if (!handle) return () => {};
      let closed = false;
      return () => {
        if (closed) return;
        closed = true;
        try {
          handle.close();
        } catch {}
      };
    } catch {
      return () => {};
    }
  };
  const refreshPluginsView = (): void => {
    // openMenu rescans on every open anyway; this is the live path for the
    // already-open panel (registry array is live-mutated, then repainted)
    void plugins
      .reloadPlugins()
      .then(() => {
        try {
          escMenu.renderMenuContent();
        } catch {}
      })
      .catch((err) => {
        dlog(`plugin rescan failed: ${err instanceof Error ? err.message : err}`);
      });
  };

  const addFromUrl = (): void => {
    if (installBusy) return;
    installBusy = true;
    void (async () => {
      try {
        if (!Bun.which("git")) {
          chrome.notify("git not found — install git to add plugins", "plugins");
          return;
        }
        // getPrompt closes over the last-wired cluster (TDZ): post-boot only
        // in practice, but a pre-boot call throws ReferenceError — toast it
        // instead of swallowing it in the fire-and-forget catch below
        let prompt: { open(o: { title: string; placeholder?: string; okLabel?: string }): Promise<string | null> };
        try {
          prompt = getPrompt();
        } catch {
          chrome.notify("prompt unavailable (still booting?)", "plugins");
          return;
        }
        const raw = await prompt.open({
          title: "Add plugin — runs code as you",
          placeholder: "https://github.com/owner/repo[#ref] [subdir]",
          okLabel: "Clone",
        });
        if (raw === null) return;
        let name: string;
        try {
          name = derivePluginName(parseGitUrl(raw));
        } catch (err) {
          chrome.notify(err instanceof Error ? err.message : String(err), "add plugin");
          return;
        }
        // early collision hint on the derived name (the install may still
        // normalize to a different final name — that error surfaces below)
        try {
          if (existsSync(path.join(pluginsDir(), name))) {
            chrome.notify(`"${name}" is already installed (remove it first)`, "add plugin");
            return;
          }
        } catch {}
        dlog(`plugin install requested: ${raw} -> ${name}`);
        // title-only: the Yes/No dialog slices its message to one 34-char
        // row, so any body is cut mid-sentence (the trust warning already
        // leads the URL prompt's title, and the outcome toast reports back)
        const ok = await plugins.confirm({
          title: `Install "${name}"?`,
          danger: true,
        });
        if (!ok) return;
        const doneCloning = stickyProgress("plugins", `Cloning ${name}…`);
        try {
          const res = await installPlugin({ dir: pluginsDir(), raw });
          dlog(`plugin installed: ${res.name} from ${raw}`);
          chrome.notify(`Installed ${res.name}`, "plugins");
        } catch (err) {
          if (err instanceof AmbiguousPluginError) {
            const sample = err.candidates.slice(0, 3).join(", ");
            chrome.notify(
              `Repo holds ${err.candidates.length} plugins (${sample}) — retry as: URL subdir`,
              "add plugin",
            );
          } else {
            chrome.notify(err instanceof Error ? err.message : String(err), "add plugin");
          }
          dlog(`plugin install failed: ${err instanceof Error ? err.message : err}`);
          return;
        } finally {
          doneCloning();
        }
        refreshPluginsView();
      } finally {
        installBusy = false;
      }
    })().catch(() => {});
  };

  const updateOne = (name: string): void => {
    void (async () => {
      const doneUpdating = stickyProgress("plugins", `Updating ${name}…`);
      try {
        const out = await updatePlugin({ dir: pluginsDir(), name });
        dlog(`plugin updated: ${name}: ${out}`);
        chrome.notify(`${name}: ${out}`, "plugins");
      } catch (err) {
        chrome.notify(err instanceof Error ? err.message : String(err), "plugins");
        return;
      } finally {
        doneUpdating();
      }
      refreshPluginsView();
    })().catch(() => {});
  };

  const removeOne = (name: string): void => {
    void (async () => {
      // title-only (see above — bodies are sliced mid-sentence by the dialog)
      const ok = await plugins.confirm({
        title: `Remove "${name}"?`,
        danger: true,
      });
      if (!ok) return;
      try {
        removePluginDir(pluginsDir(), name);
      } catch (err) {
        chrome.notify(err instanceof Error ? err.message : String(err), "plugins");
        return;
      }
      dlog(`plugin removed: ${name}`);
      chrome.notify(`Removed ${name}`, "plugins");
      refreshPluginsView();
    })().catch(() => {});
  };

  // opens inside tfm (navigate), not the OS file manager — the user stays
  // in the app and gets the grid, previews and file ops over the folder.
  // navigate() silently no-ops on missing dirs, so the folder is created
  // first (first run has no plugins dir yet).
  const openFolder = (): void => {
    try {
      mkdirSync(pluginsDir(), { recursive: true });
      nav.navigate(pluginsDir());
    } catch (err) {
      chrome.notify(err instanceof Error ? err.message : String(err), "plugins");
    }
  };

  // --- System (terminal-adaptive) theme: queries the terminal's own colors
  // through the booted renderer. applyConfig arrives via the retheme TDZ
  // arrow (same seam as the model below); the settings theme row's System
  // entry and the boot sequence both drive it from here. ---
  const systemTheme = makeSystemTheme({
    renderer: () => chrome.renderer,
    config: core.config,
    colors: core.colors,
    applyConfig: (fresh) => getRetheme().applyConfig(fresh),
    scheduleSaveConfig: () => getRetheme().scheduleSaveConfig(),
    log: (message) => dlog(message),
    compatActive: core.compatActive,
    // the boot resolve bypasses applyConfig (nothing mounted yet), so its
    // plugin `theme` event is emitted here instead of onConfigApplied
    onBootDerived: (theme) => {
      try {
        sharedPluginEvents().emit("theme", { preset: "System", theme });
      } catch {}
    },
  });

  // --- Settings model: row type + pure semantics live in ./settings.ts, the
  // row->config wiring in ./settings-model, the panel in ./ui-settings ---
  const { settingGroups, pluginGroups } = makeSettingModel({
    config: core.config,
    state: core.state,
    // arrow wrappers: applyConfig/scheduleSaveConfig belong to the retheme wiring (TDZ)
    applyConfig: (fresh) => getRetheme().applyConfig(fresh),
    scheduleSaveConfig: () => getRetheme().scheduleSaveConfig(),
    warn: (message, title) => chrome.notify(message, title ?? "tfm"),
    // console mode: the theme row is display-only (static palette paints)
    compatActive: core.compatActive,
    plugins: () => plugins.plugins,
    // on/off toggle: register or drop the plugin's slots right away, then
    // repaint so the change is visible without a navigation
    onPluginEnabledChanged: (name, enabled) => {
      plugins.setSlotEnabled(name, enabled);
      nav.renderAll();
    },
    pluginInstall: { addFromUrl, openFolder, update: updateOne, remove: removeOne },
    // picking the System theme entry resolves the terminal colors now
    // (fire-and-forget — failures keep the committed flag + current theme)
    resolveSystemTheme: () => {
      void systemTheme.resolveSystemTheme().catch(() => {});
    },
  });

  const escMenu = makeEscMenu({
    renderer: () => chrome.renderer,
    byId: core.lookup.byId,
    floats: core.floats,
    clearChildren,
    stripSelectable: core.lookup.stripSelectable,
    escHintBtn: core.slots.escHintBtn,
    makeIconSlot: core.slots.makeIconSlot,
    setIconState: core.slots.setIconState,
    drainIconQueue: () => core.slots.drainIconQueue(),
    setScrim: core.slots.setScrim,
    cancelBand: () => cancelBand(grid.bandCtx),
    colors: core.themeGet,
    uiStyle: () => core.config.ui.uiStyle,
    menuW: () => MENU_W,
    settingGroups: () => settingGroups(),
    pluginGroups: () => pluginGroups(),
    reloadPlugins: () => plugins.reloadPlugins(),
    warn: (message, title) => chrome.notify(message, title ?? "tfm"),
    log: (message) => dlog(message),
    quit: nav.quitApp,
  });

  return { escMenu, systemTheme };
};

export const wireRetheme = (deps: {
  core: CoreWiring;
  nav: NavWiring;
  chrome: ChromeWiring;
  fileops: FileopsWiring;
  settings: SettingsWiring;
  // hover drawer (wired just before this) — rethemeChrome rewrites the sidebar
  // width by id, so an auto-hidden panel must be resynced after applyConfig
  getHover: () => { refresh(): void };
  // late clusters owning persistent floats — deferred arrows (TDZ): keymap
  // wires last, grid/grid-foundation own props/bulk-rename. Only read at
  // repaint time, long after the wiring settled.
  getKeymap: () => { pick: { isOpen(): boolean; repaint(): void } };
  getGrid: () => { props: { isOpen(): boolean; repaint(): void } };
  getGridFoundation: () => { bulkRename: { isOpen(): boolean; repaint(): void } };
}) => {
  const { core, nav, chrome, fileops, settings, getHover, getKeymap, getGrid, getGridFoundation } = deps;

  // --- Config application & persistence: lives in ./ui-retheme (rethemeChrome,
  // applyConfig, scheduleSaveConfig, live reload). Geometry rewrites go
  // through the core cell's setters — never bake them into consts. ---
  // floats that persist while open (pick, conflict/yes-no, bulk-rename,
  // props, progress): rethemeChrome repaints each open one by id when a
  // theme switch lands underneath it — none of them rebuild on their own.
  // Getters (never captured handles): keymap wires last, same TDZ seam as
  // the settings model above.
  const floatRepaints: Array<{ isOpen(): boolean; repaint(): void }> = [
    { isOpen: () => getKeymap().pick.isOpen(), repaint: () => getKeymap().pick.repaint() },
    { isOpen: () => fileops.conflict.isOpen(), repaint: () => fileops.conflict.repaint() },
    { isOpen: () => fileops.yesNo.isOpen(), repaint: () => fileops.yesNo.repaint() },
    { isOpen: () => getGridFoundation().bulkRename.isOpen(), repaint: () => getGridFoundation().bulkRename.repaint() },
    { isOpen: () => getGrid().props.isOpen(), repaint: () => getGrid().props.repaint() },
    { isOpen: () => fileops.progress.isOpen(), repaint: () => fileops.progress.repaint() },
  ];

  let lastDual = core.config.ui.dualPane;
  const retheme = makeRetheme({
    config: core.config,
    colors: core.colors,
    setOnId: core.lookup.setOnId,
    byId: core.lookup.byId,
    renderer: () => chrome.renderer,
    getSw: () => core.geometry.sw,
    setSw: (v) => {
      core.geometry.sw = v;
    },
    setTileW: (v) => {
      core.geometry.tileW = v;
    },
    setTileH: (v) => {
      core.geometry.tileH = v;
    },
    setIconCells: (v) => {
      core.geometry.iconCells = v;
    },
    sideInnerW: core.sideInnerW,
    renderAll: nav.renderAll,
    clearIconCaches,
    resetIconQueue: () => core.slots.resetIconQueue(),
    syncTerminalTheme: fileops.terminal.syncTerminalTheme,
    syncTerminalHeight: () => fileops.terminal.syncTerminalHeight(),
    repaintButtons: () => {
      for (const t of chrome.toolbars) t.repaintButtons();
    },
    renderCrumbs: () => {
      for (const t of chrome.toolbars) t.renderCrumbs();
    },
    refreshNav: () => {
      for (const t of chrome.toolbars) t.refreshNav();
    },
    escMenu: settings.escMenu,
    fileMenuIsOpen: chrome.menu.isFileMenuOpen,
    renderFileMenu: chrome.menu.renderFileMenu,
    floatRepaints,
    notify: chrome.notify,
    compatActive: core.compatActive,
    // toggling [ui] persist-undo persists the live stack (or clears the
    // journal file) immediately — not on the next file op
    onConfigApplied: () => {
      fileops.syncUndoJournal();
      try {
        getHover().refresh();
      } catch {}
      try {
        const idx = themePresetIdx(THEME_PRESETS, core.config.theme);
        sharedPluginEvents().emit("theme", {
          preset: core.config.ui.followTerminal ? "System" : idx >= 0 ? THEME_PRESETS[idx]!.name : "custom",
          theme: core.config.theme,
        });
      } catch {}
    },
    normalizePanes: () => {
      const dual = core.config.ui.dualPane;
      if (!dual && core.panes.active !== 0) {
        core.setActivePane(0);
        core.refreshPaneFocus();
      }
      // dual pane just turned on: the hidden pane's cwd is stale from boot —
      // open it at the active pane's current directory (both the keybind and
      // the settings GUI row funnel through applyConfig, so one hook covers all)
      else if (dual && !lastDual) pointPaneAt(core.panes.states[1]!, core.state.cwd);
      lastDual = dual;
    },
  });

  return retheme;
};
