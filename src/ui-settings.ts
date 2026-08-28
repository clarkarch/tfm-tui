// --- ESC menu + settings panel ---
// Widget-extraction seam (see ui-dialogs.ts for the template): this owns the
// menu state (open/view/cursor) and every keystroke-nav op the keyboard
// router calls. Config-wiring closures for the setting rows (what get/set
// actually mutate) stay in index.ts and arrive via ctx.settingGroups() —
// the factory only renders and adjusts them.
// ctx fields for symbols defined after the call site must be arrow wrappers.

import { Box, RGBA, Text } from "@opentui/core";
import { chromeSurface, type UiStyle } from "./style";
import { applyAdjust, flattenRows, type SettingGroup, type SettingRow } from "./settings";
import type { IconState, IconSpec } from "./ui-slots";
import type { Theme } from "./config";

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
  colors(): Record<string, any>;
  uiStyle(): string;
  // root-view width — same value the context menu uses (MENU_W in index)
  menuW(): number;
  settingGroups(): SettingGroup[];
  quit(): void;
};

// settings panel is wider than the root menu (value column + steppers)
export const SETTINGS_W = 44;
const SET_LABEL_W = 17;

export const makeEscMenu = (ctx: EscMenuCtx) => {
  let menuOpen = false;
  let menuView: "root" | "settings" = "root";
  let menuIdx = 0;

  const settingsFlatRows = (): SettingRow[] => flattenRows(ctx.settingGroups());

  const rootMenuItems = (): { icon: string; label: string; hint?: string; keepOpen?: boolean; action: () => void }[] => [
    {
      icon: "cog",
      label: "Settings",
      // stays open: the action switches the menu to the settings view; closing
      // first would destroy the scrim/panel the view renders into
      keepOpen: true,
      action: () => { menuView = "settings"; menuIdx = 0; renderMenuContent(); },
    },
    {
      icon: "power",
      label: "Quit",
      hint: "ctrl+q",
      action: ctx.quit,
    },
  ];

  const adjustSelectedSetting = (dir: number): void => {
    if (menuView !== "settings") return;
    const row = settingsFlatRows()[menuIdx];
    if (!row || !applyAdjust(row, dir)) return;
    renderMenuContent();
  };

  const menuActivate = () => {
    if (menuView === "settings") {
      const row = settingsFlatRows()[menuIdx];
      if (!row) return;
      if (row.kind === "toggle") { applyAdjust(row, 1); renderMenuContent(); return; }
      if (row.kind === "action") {
        if (row.keepOpen) { row.run(); renderMenuContent(); }
        else { closeMenu(); row.run(); }
        return;
      }
      applyAdjust(row, 1);
      renderMenuContent();
      return;
    }
    const items = rootMenuItems();
    const it = items[menuIdx] ?? items[0];
    if (!it) return;
    if (it.keepOpen) { it.action(); return; }
    closeMenu();
    it.action();
  };

  const setOnId = (id: string, fn: (n: any) => void): void => {
    const n: any = ctx.byId(id);
    if (n) { try { fn(n); } catch {} }
  };

  const renderMenuContent = () => {
    const c = ctx.colors();
    const panel: any = ctx.byId("tfm-menu-panel");
    if (!panel) return;
    ctx.clearChildren(panel);

    const isSettings = menuView === "settings";
    const panelW = isSettings ? SETTINGS_W : ctx.menuW();
    try { panel.width = panelW; } catch {}

    panel.add(Box(
      { width: "100%", height: 1, flexDirection: "row", alignItems: "center", paddingLeft: 2, paddingRight: 1 },
      Text({ content: isSettings ? "Menu — settings" : "Menu", fg: c.accent }),
      Box({ flexGrow: 1 }),
      ctx.escHintBtn("tfm-esc-menu", closeMenu),
    ));
    panel.add(Box(
      { width: "100%", height: 1, paddingLeft: 1, paddingRight: 1 },
      Text({ content: " " + "~".repeat(panelW - 2), fg: c.divider }),
    ));

    const hoverSelect = (index: number) => () => {
      if (menuIdx !== index) { menuIdx = index; renderMenuContent(); }
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
          ? [ctx.makeIconSlot(
              icon,
              [
                { fg: c.sidebarFg, bg: active ? c.accentBg : c.sidebarBg },
                { fg: c.white, bg: c.accentBg },
              ],
              1,
              active ? 1 : 0,
            ).el]
          : []),
        Text({ content: icon ? label : ` ${label}`, fg: active ? c.white : c.sidebarFg }),
        Box({ flexGrow: 1 }),
        ...(hint ? [Text({ content: hint + " ", fg: c.sidebarFgMuted })] : []),
      );

    const activateRow = (index: number) => (ev: any) => {
      try { ev.stopPropagation?.(); } catch {}
      menuIdx = index;
      menuActivate();
    };

    // value column shared by stepper/cycle rows: ‹ value ›
    const chevron = (dirText: "‹" | "›", active: boolean, index: number, rowSpec: SettingRow, dir: number) => {
      const tId = `tfm-chev-${index}-${dir}`;
      return Box(
        {
          width: 2,
          justifyContent: "center",
          onMouseDown: (ev: any) => {
            try { ev.stopPropagation?.(); } catch {}
            const changed = applyAdjust(rowSpec, dir);
            if (menuIdx !== index || changed) {
              menuIdx = index;
              renderMenuContent();
            }
          },
          onMouseOver: () => setOnId(tId, (n) => { n.fg = c.white; }),
          onMouseOut: () => setOnId(tId, (n) => { n.fg = active ? c.white : c.sidebarFgMuted; }),
        },
        Text({ id: tId, content: dirText, fg: active ? c.white : c.sidebarFgMuted }),
      );
    };

    const settingsRow = (rowSpec: SettingRow, index: number) => {
      const active = menuIdx === index;
      const labelFg = active ? c.white : c.sidebarFg;
      let control: any;
      let rowActivate: (ev?: any) => void = activateRow(index);

      if (rowSpec.kind === "toggle") {
        const on = rowSpec.get();
        control = Box(
          { width: 6, justifyContent: "flex-end" },
          Text({ content: on ? "on" : "off", fg: on ? c.accent : c.sidebarFgMuted }),
        );
      } else if (rowSpec.kind === "stepper" || rowSpec.kind === "cycle") {
        const value = rowSpec.kind === "stepper"
          ? rowSpec.fmt(rowSpec.get())
          : (() => { const i = rowSpec.getIdx(); return i >= 0 ? rowSpec.names[i] ?? "?" : "custom"; })();
        control = Box(
          { flexDirection: "row", alignItems: "center", onMouseDown: (ev: any) => { try { ev.stopPropagation?.(); } catch {} } },
          chevron("‹", active, index, rowSpec, -1),
          Box(
            { width: 13, justifyContent: "flex-end", paddingRight: 1 },
            Text({
              content: value.length > 12 ? value.slice(0, 12) : value,
              fg: active ? c.white : c.sidebarFgMuted,
            }),
          ),
          chevron("›", active, index, rowSpec, 1),
        );
        rowActivate = (ev?: any) => {
          try { ev?.stopPropagation?.(); } catch {}
          menuIdx = index;
          applyAdjust(rowSpec, 1);
          renderMenuContent();
        };
      } else {
        control = Box({ width: 6 });
      }

      return Box(
        {
          width: "100%",
          height: 1,
          flexDirection: "row",
          paddingLeft: 1,
          paddingRight: 1,
          backgroundColor: active ? c.accentBg : undefined,
          onMouseDown: rowActivate,
          onMouseOver: hoverSelect(index),
        },
        Text({ content: ` ${rowSpec.label.slice(0, SET_LABEL_W).padEnd(SET_LABEL_W)}`, fg: labelFg }),
        Box({ flexGrow: 1 }),
        control,
      );
    };

    if (!isSettings) {
      const items = rootMenuItems();
      items.forEach((it, i) => panel.add(rootRow(it.icon, it.label, it.hint, i === menuIdx, i, activateRow(i))));
    } else {
      let flatIdx = 0;
      ctx.settingGroups().forEach((group, gi) => {
        if (gi > 0) panel.add(Box({ width: "100%", height: 1 }));
        if (group.header) {
          panel.add(Box(
            { width: "100%", height: 1, paddingLeft: 1 },
            Text({ content: group.header.toUpperCase(), fg: c.sidebarFgMuted }),
          ));
        }
        for (const rowSpec of group.rows) {
          panel.add(settingsRow(rowSpec, flatIdx));
          flatIdx++;
        }
      });
      panel.add(Box({ width: "100%", height: 1 }));
      panel.add(Box(
        { width: "100%", height: 1, paddingLeft: 1, paddingRight: 1 },
        Text({ content: "←→ adjust · enter select", fg: c.sidebarFgMuted }),
      ));
    }

    // center the panel vertically based on its actual content height so tall
    // views never overflow small terminals
    const scrim: any = ctx.byId("tfm-menu");
    if (scrim) {
      const rows = [...panel.getChildren()].length;
      try { scrim.paddingTop = Math.max(1, Math.floor((ctx.renderer().terminalHeight - rows - 2) / 2)); } catch {}
    }

    ctx.stripSelectable();
    void ctx.drainIconQueue();
  };

  const openMenu = () => {
    if (menuOpen) return;
    menuOpen = true;
    menuView = "root";
    menuIdx = 0;
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
        zIndex: 3000,
        backgroundColor: RGBA.fromInts(0, 0, 0, 150),
        onMouseDown: () => closeMenu(),
      },
      Box(
        {
          id: "tfm-menu-panel",
          width: ctx.menuW(),
          ...chromeSurface(ctx.uiStyle() as UiStyle, ctx.colors() as Theme, ctx.colors().sidebarBg),
          paddingTop: 1,
          paddingBottom: 1,
          onMouseDown: (ev: any) => {
            try { ev.stopPropagation?.(); } catch {}
          },
        },
      ),
    );
    ctx.renderer().root.add(scrim);
    renderMenuContent();
  };

  const closeMenu = () => {
    if (!menuOpen) return;
    menuOpen = false;
    const scrim: any = ctx.byId("tfm-menu");
    scrim?.parent?.remove(scrim);
    ctx.setScrim(false);
  };

  const moveMenu = (delta: number) => {
    const count = menuView === "settings" ? settingsFlatRows().length : rootMenuItems().length;
    menuIdx = (menuIdx + delta + count) % count;
    renderMenuContent();
  };

  // the "back" action row (index-owned settingGroups) returns to the root view
  const showRoot = (): void => { menuView = "root"; menuIdx = 0; };

  return {
    openMenu,
    closeMenu,
    isOpen: (): boolean => menuOpen,
    moveMenu,
    menuActivate,
    adjustSelectedSetting,
    renderMenuContent,
    showRoot,
  };
};
