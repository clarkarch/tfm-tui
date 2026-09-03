// --- ESC menu shell: the menu state machine (open/view/cursor/capture),
// every keystroke-nav op the keyboard router calls, the root view, the
// open/close + floats policy, and the guarded rebuild. The settings VIEW
// rendering (two panes, windowing, chevrons, hover paints) lives in
// ./ui-settings-panel and renders through this shell's state + hooks.
// Widget-extraction seam (see ui-dialogs.ts for the template): config-wiring
// closures for the setting rows live in settings-model and arrive via
// ctx.settingGroups() — this factory only renders and adjusts them.
// ctx fields for symbols defined after the call site must be arrow wrappers.
// MOUSE-FIRST: every control is clickable, rows hover-select, click-away
// cancels capture.

import { Box, RGBA, Text } from "@opentui/core";
import { chromeSurface, type UiStyle } from "./style";
import { applyAdjust, type SettingGroup, type SettingRow } from "./settings";
import type { IconState, IconSpec } from "./ui-slots";
import type { Theme } from "../config/config";
import { keySpecFromEvent, validateKeybindSpec } from "../config/config-schema";
import { FLOAT_Z, type Floats } from "./floats";
import {
  ensureVisible,
  panelPadTop,
  renderSettingsPanel,
  settingsVisRows,
  SETTINGS_W,
  type SettingsPanelState,
} from "./ui-settings-panel";

export type EscMenuCtx = {
  renderer(): any;
  byId(id: string): any;
  clearChildren(node: any): void;
  stripSelectable(): void;
  escHintBtn(id: string, onClose: () => void): any;
  makeIconSlot(
    name: string,
    states: IconState[],
    heightCells?: number,
    initialState?: number,
    onMouseDown?: (ev: any) => void,
    statesFactory?: () => IconState[],
  ): { el: any; slotId: string; spec: IconSpec };
  drainIconQueue(): void | Promise<void>;
  setScrim(on: boolean): void;
  // a modal must kill any in-flight rubber-band (grid-input owns the gesture)
  cancelBand(): void;
  colors(): Theme;
  uiStyle(): string;
  // root-view width — same value the context menu uses (MENU_W in ./ui-menu)
  menuW(): number;
  settingGroups(): SettingGroup[];
  // conflict/rejection toasts for the keybind capture flow (wired to notify)
  warn(message: string, title?: string): void;
  // open/close orchestration + the dismiss-others policy live in ./floats
  floats: Floats;
  // debug sink (dlog) — rebuild failures MUST surface somewhere
  log?(message: string): void;
  quit(): void;
};

export const makeEscMenu = (ctx: EscMenuCtx) => {
  let menuOpen = false;
  let menuView: "root" | "settings" = "root";
  // panel cursor state — rendered by ./ui-settings-panel, mutated by the ops here
  const st: SettingsPanelState = {
    catIdx: 0,
    menuIdx: 0,
    pane: "rows",
    scrollOff: 0,
    hoverCat: -1,
    capturing: null,
  };

  const groups = (): SettingGroup[] => ctx.settingGroups();
  const rowsOf = (gi: number): SettingRow[] => groups()[gi]?.rows ?? [];

  const rootMenuItems = (): {
    icon: string;
    label: string;
    hint?: string;
    keepOpen?: boolean;
    action: () => void;
  }[] => [
    {
      icon: "cog",
      label: "Settings",
      // stays open: the action switches the menu to the settings view; closing
      // first would destroy the scrim/panel the view renders into
      keepOpen: true,
      action: () => {
        menuView = "settings";
        st.catIdx = 0;
        st.menuIdx = 0;
        st.pane = "rows";
        st.scrollOff = 0;
        renderMenuContent();
      },
    },
    {
      icon: "power",
      label: "Quit",
      hint: "ctrl+q",
      action: ctx.quit,
    },
  ];

  const switchCategory = (gi: number): void => {
    const n = groups().length;
    st.catIdx = ((gi % n) + n) % n;
    st.menuIdx = 0;
    st.pane = "rows";
    st.scrollOff = 0;
    renderMenuContent();
  };

  const visibleRows = (): number => settingsVisRows(ctx.renderer().terminalHeight);

  const adjustSelectedSetting = (dir: number): void => {
    if (menuView !== "settings") return;
    if (st.pane === "cats") {
      switchCategory(st.catIdx + dir);
      return;
    }
    const row = rowsOf(st.catIdx)[st.menuIdx];
    if (!row) return;
    // keybind/action rows have no left/right value — the arrows switch category
    if (row.kind === "keybind" || row.kind === "action") {
      switchCategory(st.catIdx + dir);
      return;
    }
    if (!applyAdjust(row, dir)) return;
    afterAdjust(st.menuIdx, row);
  };

  const cancelCapture = (): boolean => {
    if (st.capturing === null) return false;
    st.capturing = null;
    renderMenuContent();
    return true;
  };

  const startCapture = (rowIdx: number): void => {
    const row = rowsOf(st.catIdx)[rowIdx];
    if (row?.kind !== "keybind") return;
    st.capturing = rowIdx;
    renderMenuContent();
  };

  // colors of the current build — targeted updates below paint with them
  // (menu colors can't change while the panel is up without a rebuild)
  let menuC: Theme = ctx.colors();

  // repaint one row's highlight via byId — NO rebuild (rebuild churn under
  // memory pressure trips native allocation failures; see AGENTS.md OOM note)
  const paintRowAt = (idx: number, on: boolean): void => {
    const c = menuC;
    setOnId(`tfm-set-row-${idx}`, (n) => {
      n.backgroundColor = on ? c.accentBg : undefined;
    });
    setOnId(`tfm-set-rowl-${idx}`, (n) => {
      n.fg = on ? c.white : c.sidebarFg;
    });
    setOnId(`tfm-set-rowv-${idx}`, (n) => {
      n.fg = on ? c.white : c.sidebarFgMuted;
    });
  };

  // after applyAdjust on a value row: refresh JUST the value text by id.
  // Rows flagged `repaint` (theme / ui-style / transparent-bg) change the
  // panel's own colors and need the full rebuild.
  const afterAdjust = (index: number, row: SettingRow): void => {
    if (row.kind === "action" || row.kind === "keybind") return;
    if (row.repaint) {
      renderMenuContent();
      return;
    }
    const value =
      row.kind === "toggle"
        ? row.get()
          ? "on"
          : "off"
        : row.kind === "stepper"
          ? row.fmt(row.get())
          : (() => {
              const i = row.getIdx();
              return i >= 0 ? (row.names[i] ?? "?") : "custom";
            })();
    setOnId(`tfm-set-rowv-${index}`, (n) => {
      n.content = value.length > 12 ? value.slice(0, 12) : value;
      if (row.kind === "toggle") n.fg = row.get() ? menuC.accent : menuC.sidebarFgMuted;
    });
  };

  // called from the keyboard router BEFORE the esc-menu nav branch: while
  // recording, every key is swallowed. enter/click-away also cancel.
  const captureKey = (e: any): boolean => {
    if (st.capturing === null) return false;
    if (e.name === "escape" || e.name === "return" || e.name === "tab") {
      st.capturing = null;
      renderMenuContent();
      return true;
    }
    const spec = keySpecFromEvent(e);
    if (!spec) return true;
    const problem = validateKeybindSpec(spec);
    if (problem) {
      ctx.warn(problem, "keybind");
      return true; // stay in capture so the user can retry
    }
    const row = rowsOf(st.catIdx)[st.capturing];
    st.capturing = null;
    if (row?.kind === "keybind") row.set([spec]);
    renderMenuContent();
    return true;
  };

  const rowActivate = (rowIdx: number): void => {
    if (st.capturing !== null) {
      if (st.capturing !== rowIdx) cancelCapture();
      return;
    }
    const row = rowsOf(st.catIdx)[rowIdx];
    if (!row) return;
    if (row.kind === "toggle") {
      applyAdjust(row, 1);
      afterAdjust(rowIdx, row);
      return;
    }
    if (row.kind === "keybind") {
      startCapture(rowIdx);
      return;
    }
    if (row.kind === "action") {
      if (row.keepOpen) {
        row.run();
        renderMenuContent();
      } else {
        closeMenu();
        row.run();
      }
      return;
    }
    applyAdjust(row, 1);
    afterAdjust(rowIdx, row);
  };

  const menuActivate = () => {
    if (menuView === "settings") {
      if (st.pane === "cats") {
        switchCategory(st.catIdx);
        return;
      }
      rowActivate(st.menuIdx);
      return;
    }
    const items = rootMenuItems();
    const it = items[st.menuIdx] ?? items[0];
    if (!it) return;
    if (it.keepOpen) {
      it.action();
      return;
    }
    closeMenu();
    it.action();
  };

  const menuTab = (): void => {
    if (menuView !== "settings" || st.capturing !== null) return;
    st.pane = st.pane === "cats" ? "rows" : "cats";
    renderMenuContent();
  };

  const setOnId = (id: string, fn: (n: any) => void): void => {
    const n: any = ctx.byId(id);
    if (n) {
      try {
        fn(n);
      } catch {}
    }
  };

  // A mid-rebuild throw after clearChildren leaves the panel EMPTY — to the
  // user the floating UI just "vanishes". Guard the rebuild: log the failure
  // and retry once (deferred, so a transient native alloc hiccup recovers).
  // A failed retry does NOT reschedule — under sustained memory pressure
  // (see the OOM note in AGENTS.md) infinite retries just amplify it.
  let retryArmed = false;
  const renderMenuContent = () => {
    const c = ctx.colors();
    const panel: any = ctx.byId("tfm-menu-panel");
    if (!panel) return;
    ctx.clearChildren(panel);
    try {
      buildMenuContent(c, panel, isSettingsView());
      retryArmed = true; // a successful build re-arms the one-shot retry
    } catch (err) {
      logRenderFailure(err);
      if (retryArmed) {
        retryArmed = false;
        setTimeout(() => renderMenuContent(), 120);
      }
    }
  };

  const logRenderFailure = (err: unknown): void => {
    // best-effort native allocator stats (renderer.lib is private — this is
    // diagnostics only); tells a tfm-side leak apart from system OOM
    try {
      const lib = ctx.renderer().lib;
      const s = lib?.getAllocatorStats?.();
      if (s) {
        ctx.log?.(
          `esc-menu render failed: ${err} | native mem=${(s.totalRequestedBytes / 1048576).toFixed(1)}MB active=${s.activeAllocations}`,
        );
        return;
      }
    } catch {}
    ctx.log?.(`esc-menu render failed: ${err}`);
  };

  const isSettingsView = (): boolean => menuView === "settings";

  const buildMenuContent = (c: Theme, panel: any, isSettings: boolean) => {
    menuC = c;
    const panelW = isSettings ? SETTINGS_W : ctx.menuW();
    try {
      panel.width = panelW;
    } catch {}

    panel.add(
      Box(
        { width: "100%", height: 1, flexDirection: "row", alignItems: "center", paddingLeft: 2, paddingRight: 1 },
        Text({ content: isSettings ? "Menu — settings" : "Menu", fg: c.accent }),
        Box({ flexGrow: 1 }),
        ctx.escHintBtn("tfm-esc-menu", closeMenu),
      ),
    );
    panel.add(
      Box(
        { width: "100%", height: 1, paddingLeft: 1, paddingRight: 1 },
        Text({ content: ` ${"~".repeat(panelW - 2)}`, fg: c.divider }),
      ),
    );

    if (!isSettings) {
      const hoverSelect = (index: number) => () => {
        if (st.menuIdx !== index) {
          st.menuIdx = index;
          renderMenuContent();
        }
      };
      const activateRow = (index: number) => (ev: any) => {
        try {
          ev.stopPropagation?.();
        } catch {}
        st.menuIdx = index;
        menuActivate();
      };
      const rootRow = (
        icon: string | undefined,
        label: string,
        hint: string | undefined,
        active: boolean,
        index: number,
        onClick: (ev?: any) => void,
      ) =>
        Box(
          {
            width: "100%",
            height: 1,
            flexDirection: "row",
            columnGap: 1,
            paddingLeft: 1,
            paddingRight: 1,
            backgroundColor: active ? c.accentBg : undefined,
            onMouseDown: onClick,
            onMouseOver: hoverSelect(index),
          },
          ...(icon
            ? [
                ctx.makeIconSlot(
                  icon,
                  [
                    { fg: c.sidebarFg, bg: active ? c.accentBg : c.sidebarBg },
                    { fg: c.white, bg: c.accentBg },
                  ],
                  1,
                  active ? 1 : 0,
                ).el,
              ]
            : []),
          Text({ content: icon ? label : ` ${label}`, fg: active ? c.white : c.sidebarFg }),
          Box({ flexGrow: 1 }),
          ...(hint ? [Text({ content: `${hint} `, fg: c.sidebarFgMuted })] : []),
        );
      const items = rootMenuItems();
      items.forEach((it, i) => {
        panel.add(rootRow(it.icon, it.label, it.hint, i === st.menuIdx, i, activateRow(i)));
      });
    } else {
      renderSettingsPanel(c, panel, st, {
        groups,
        visRows: visibleRows,
        setOnId,
        makeIconSlot: ctx.makeIconSlot,
        switchCategory,
        cancelCapture,
        rowActivate,
        afterAdjust,
        paintRowAt,
        rebuild: renderMenuContent,
      });
    }

    // center the panel vertically based on its actual CONTENT HEIGHT — child
    // count is wrong for the settings view, whose two-pane container is
    // many rows tall but counts as ONE child (that mismatch made the panel
    // start far down the screen and bleed past the bottom edge)
    const scrim: any = ctx.byId("tfm-menu");
    if (scrim) {
      const childH = (n: any): number => {
        try {
          if (typeof n.height === "number") return n.height;
        } catch {}
        return 1;
      };
      let contentH = 0;
      for (const ch of panel.getChildren()) contentH += childH(ch);
      try {
        scrim.paddingTop = panelPadTop(ctx.renderer().terminalHeight, contentH);
      } catch {}
    }

    ctx.stripSelectable();
    void ctx.drainIconQueue();
  };

  // best-effort native allocator stats (renderer.lib is private — this is
  // diagnostics only); lets a tfm-side leak be told apart from system OOM
  // by comparing the numbers across a session's open/close traces
  const nativeMemTrace = (tag: string): void => {
    if (!ctx.log) return;
    try {
      const s = ctx.renderer().lib?.getAllocatorStats?.();
      if (s)
        ctx.log?.(`${tag} native mem=${(s.totalRequestedBytes / 1048576).toFixed(1)}MB active=${s.activeAllocations}`);
    } catch {}
  };

  // raw teardown — registered with floats at open time; public closeMenu is
  // floats.close("escmenu")
  const rawCloseMenu = () => {
    menuOpen = false;
    st.capturing = null;
    ctx.log?.("esc-menu close");
    nativeMemTrace("esc-menu close");
    const scrim: any = ctx.byId("tfm-menu");
    scrim?.parent?.remove(scrim);
    ctx.setScrim(false);
  };

  const openMenu = () => {
    if (menuOpen) return;
    ctx.floats.open("escmenu", rawCloseMenu);
    menuOpen = true;
    menuView = "root";
    st.menuIdx = 0;
    st.catIdx = 0;
    st.pane = "rows";
    st.scrollOff = 0;
    st.capturing = null;
    ctx.log?.("esc-menu open");
    nativeMemTrace("esc-menu open");
    ctx.cancelBand();
    ctx.setScrim(true);
    const scrim = Box(
      {
        id: "tfm-menu",
        position: "absolute",
        left: 0,
        top: 0,
        width: "100%",
        height: "100%",
        alignItems: "center",
        paddingTop: Math.max(2, Math.round(ctx.renderer().terminalHeight / 3)),
        zIndex: FLOAT_Z.escmenu,
        backgroundColor: RGBA.fromInts(0, 0, 0, 150),
        // mouse-first: first outside click cancels an in-flight capture,
        // the next one dismisses the menu
        onMouseDown: () => {
          if (!cancelCapture()) closeMenu();
        },
      },
      Box({
        id: "tfm-menu-panel",
        width: ctx.menuW(),
        ...chromeSurface(ctx.uiStyle() as UiStyle, ctx.colors() as Theme, ctx.colors().sidebarBg),
        paddingTop: 1,
        paddingBottom: 1,
        onMouseDown: (ev: any) => {
          try {
            ev.stopPropagation?.();
          } catch {}
          if (st.capturing !== null) cancelCapture();
        },
      }),
    );
    ctx.renderer().root.add(scrim);
    renderMenuContent();
  };

  const closeMenu = () => {
    ctx.floats.close("escmenu");
  };

  const moveMenu = (delta: number) => {
    if (menuView !== "settings") {
      const count = rootMenuItems().length;
      st.menuIdx = (st.menuIdx + delta + count) % count;
      renderMenuContent();
      return;
    }
    if (st.pane === "cats") {
      switchCategory(st.catIdx + delta);
      return;
    }
    const count = rowsOf(st.catIdx).length;
    if (!count) return;
    st.menuIdx = (st.menuIdx + delta + count) % count;
    ensureVisible(st, visibleRows());
    renderMenuContent();
  };

  // the "back" action row returns to the root view
  const showRoot = (): void => {
    menuView = "root";
    st.menuIdx = 0;
    st.pane = "rows";
    st.capturing = null;
  };

  return {
    openMenu,
    closeMenu,
    isOpen: (): boolean => menuOpen,
    moveMenu,
    menuActivate,
    menuTab,
    adjustSelectedSetting,
    captureKey,
    renderMenuContent,
    showRoot,
  };
};
