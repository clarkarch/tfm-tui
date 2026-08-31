// --- ESC menu + settings panel (two-pane: categories left, rows right) ---
// Widget-extraction seam (see ui-dialogs.ts for the template): this owns the
// menu state (open/view/pane/cursor/scroll/capture) and every keystroke-nav
// op the keyboard router calls. Config-wiring closures for the setting rows
// (what get/set actually mutate) live in settings-model and arrive via
// ctx.settingGroups() — the factory only renders and adjusts them.
// ctx fields for symbols defined after the call site must be arrow wrappers.
// MOUSE-FIRST: every control is clickable (categories, rows, chevrons), rows
// hover-select, the right pane wheel-scrolls, and click-away cancels capture.

import { Box, RGBA, Text } from "@opentui/core";
import { chromeSurface, type UiStyle } from "./style";
import { applyAdjust, type SettingGroup, type SettingRow } from "./settings";
import type { IconState, IconSpec } from "./ui-slots";
import type { Theme } from "./config";
import { keySpecFromEvent, validateKeybindSpec } from "./config-schema";
import { FLOAT_Z, type Floats } from "./floats";

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
  // conflict/rejection toasts for the keybind capture flow (wired to notify)
  warn(message: string, title?: string): void;
  // open/close orchestration + the dismiss-others policy live in ./floats
  floats: Floats;
  // debug sink (dlog) — rebuild failures MUST surface somewhere
  log?(message: string): void;
  quit(): void;
};

// settings panel is wider than the root menu (categories + value columns)
export const SETTINGS_W = 62;
const CAT_W = 18;
const SET_LABEL_W = 17;

// scrim paddingTop that vertically centers a panel of `contentH` rows
// (the -2 covers the panel's own top/bottom padding); clamps to 1 when the
// panel is taller than the terminal
export const panelPadTop = (termH: number, contentH: number): number =>
  Math.max(1, Math.floor((termH - contentH - 2) / 2));

// right-pane window size: a COMPACT dialog, not a full-screen sheet — capped
// at 14 rows (panel ≈ 21 rows total with chrome); shrinks on tiny terminals.
// Categories with more rows wheel-scroll/arrow-scroll.
export const settingsVisRows = (termH: number): number => Math.min(14, Math.max(5, termH - 12));

const CAT_ICONS: Record<string, string> = {
  general: "cog",
  layout: "select-all",
  behavior: "clock",
  keybindings: "pencil",
  config: "file-document",
};

export const makeEscMenu = (ctx: EscMenuCtx) => {
  let menuOpen = false;
  let menuView: "root" | "settings" = "root";
  let menuIdx = 0; // row cursor within the ACTIVE category
  let catIdx = 0;
  let pane: "cats" | "rows" = "rows";
  let scrollOff = 0;
  let hoverCat = -1;
  // keybind capture: flat row index within the active category being recorded
  let capturing: number | null = null;

  const groups = (): SettingGroup[] => ctx.settingGroups();
  const rowsOf = (gi: number): SettingRow[] => groups()[gi]?.rows ?? [];

  const rootMenuItems = (): { icon: string; label: string; hint?: string; keepOpen?: boolean; action: () => void }[] => [
    {
      icon: "cog",
      label: "Settings",
      // stays open: the action switches the menu to the settings view; closing
      // first would destroy the scrim/panel the view renders into
      keepOpen: true,
      action: () => { menuView = "settings"; catIdx = 0; menuIdx = 0; pane = "rows"; scrollOff = 0; renderMenuContent(); },
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
    catIdx = ((gi % n) + n) % n;
    menuIdx = 0;
    pane = "rows";
    scrollOff = 0;
    renderMenuContent();
  };

  // visible row count for the right pane (panel chrome takes ~6 rows)
  const visibleRows = (): number => settingsVisRows(ctx.renderer().terminalHeight);

  const ensureVisible = (): void => {
    const vis = visibleRows();
    if (menuIdx < scrollOff) scrollOff = menuIdx;
    if (menuIdx >= scrollOff + vis) scrollOff = menuIdx - vis + 1;
    if (scrollOff < 0) scrollOff = 0;
  };

  const adjustSelectedSetting = (dir: number): void => {
    if (menuView !== "settings") return;
    if (pane === "cats") { switchCategory(catIdx + dir); return; }
    const row = rowsOf(catIdx)[menuIdx];
    if (!row) return;
    // keybind/action rows have no left/right value — the arrows switch category
    if (row.kind === "keybind" || row.kind === "action") { switchCategory(catIdx + dir); return; }
    if (!applyAdjust(row, dir)) return;
    afterAdjust(menuIdx, row);
  };

  const cancelCapture = (): boolean => {
    if (capturing === null) return false;
    capturing = null;
    renderMenuContent();
    return true;
  };

  const startCapture = (rowIdx: number): void => {
    const row = rowsOf(catIdx)[rowIdx];
    if (row?.kind !== "keybind") return;
    capturing = rowIdx;
    renderMenuContent();
  };

  // colors of the current build — targeted updates below paint with them
  // (menu colors can't change while the panel is up without a rebuild)
  let menuC: Record<string, any> = {};

  // repaint one row's highlight via byId — NO rebuild (rebuild churn under
  // memory pressure trips native allocation failures; see AGENTS.md OOM note)
  const paintRowAt = (idx: number, on: boolean): void => {
    const c = menuC;
    setOnId(`tfm-set-row-${idx}`, (n) => { n.backgroundColor = on ? c.accentBg : undefined; });
    setOnId(`tfm-set-rowl-${idx}`, (n) => { n.fg = on ? c.white : c.sidebarFg; });
    setOnId(`tfm-set-rowv-${idx}`, (n) => { n.fg = on ? c.white : c.sidebarFgMuted; });
  };

  // after applyAdjust on a value row: refresh JUST the value text by id.
  // Rows flagged `repaint` (theme / ui-style / transparent-bg) change the
  // panel's own colors and need the full rebuild.
  const afterAdjust = (index: number, row: SettingRow): void => {
    if (row.kind === "action" || row.kind === "keybind") return;
    if (row.repaint) { renderMenuContent(); return; }
    const value = row.kind === "toggle"
      ? (row.get() ? "on" : "off")
      : row.kind === "stepper"
        ? row.fmt(row.get())
        : (() => { const i = row.getIdx(); return i >= 0 ? row.names[i] ?? "?" : "custom"; })();
    setOnId(`tfm-set-rowv-${index}`, (n) => {
      n.content = value.length > 12 ? value.slice(0, 12) : value;
      if (row.kind === "toggle") n.fg = row.get() ? menuC.accent : menuC.sidebarFgMuted;
    });
  };

  // called from the keyboard router BEFORE the esc-menu nav branch: while
  // recording, every key is swallowed. enter/click-away also cancel.
  const captureKey = (e: any): boolean => {
    if (capturing === null) return false;
    if (e.name === "escape" || e.name === "return" || e.name === "tab") {
      capturing = null;
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
    const row = rowsOf(catIdx)[capturing];
    capturing = null;
    if (row?.kind === "keybind") row.set([spec]);
    renderMenuContent();
    return true;
  };

  const rowActivate = (rowIdx: number): void => {
    if (capturing !== null) { if (capturing !== rowIdx) cancelCapture(); return; }
    const row = rowsOf(catIdx)[rowIdx];
    if (!row) return;
    if (row.kind === "toggle") { applyAdjust(row, 1); afterAdjust(rowIdx, row); return; }
    if (row.kind === "keybind") { startCapture(rowIdx); return; }
    if (row.kind === "action") {
      if (row.keepOpen) { row.run(); renderMenuContent(); }
      else { closeMenu(); row.run(); }
      return;
    }
    applyAdjust(row, 1);
    afterAdjust(rowIdx, row);
  };

  const menuActivate = () => {
    if (menuView === "settings") {
      if (pane === "cats") { switchCategory(catIdx); return; }
      rowActivate(menuIdx);
      return;
    }
    const items = rootMenuItems();
    const it = items[menuIdx] ?? items[0];
    if (!it) return;
    if (it.keepOpen) { it.action(); return; }
    closeMenu();
    it.action();
  };

  const menuTab = (): void => {
    if (menuView !== "settings" || capturing !== null) return;
    pane = pane === "cats" ? "rows" : "cats";
    renderMenuContent();
  };

  const setOnId = (id: string, fn: (n: any) => void): void => {
    const n: any = ctx.byId(id);
    if (n) { try { fn(n); } catch {} }
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
      const lib = (ctx.renderer() as any).lib;
      const s = lib?.getAllocatorStats?.();
      if (s) {
        ctx.log?.(`esc-menu render failed: ${err} | native mem=${(s.totalRequestedBytes / 1048576).toFixed(1)}MB active=${s.activeAllocations}`);
        return;
      }
    } catch {}
    ctx.log?.(`esc-menu render failed: ${err}`);
  };

  const isSettingsView = (): boolean => menuView === "settings";

  const buildMenuContent = (c: Record<string, any>, panel: any, isSettings: boolean) => {
    menuC = c;
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
      Text({ content: ` ${"~".repeat(panelW - 2)}`, fg: c.divider }),
    ));

    if (!isSettings) {
      const hoverSelect = (index: number) => () => {
        if (menuIdx !== index) { menuIdx = index; renderMenuContent(); }
      };
      const activateRow = (index: number) => (ev: any) => {
        try { ev.stopPropagation?.(); } catch {}
        menuIdx = index;
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
          ...(hint ? [Text({ content: `${hint} `, fg: c.sidebarFgMuted })] : []),
        );
      const items = rootMenuItems();
      items.forEach((it, i) => { panel.add(rootRow(it.icon, it.label, it.hint, i === menuIdx, i, activateRow(i))); });
    } else {
      renderSettings(c, panel);
    }

    // center the panel vertically based on its actual CONTENT HEIGHT — child
    // count is wrong for the settings view, whose two-pane container is
    // many rows tall but counts as ONE child (that mismatch made the panel
    // start far down the screen and bleed past the bottom edge)
    const scrim: any = ctx.byId("tfm-menu");
    if (scrim) {
      const childH = (n: any): number => {
        try { if (typeof n.height === "number") return n.height; } catch {}
        return 1;
      };
      let contentH = 0;
      for (const ch of panel.getChildren()) contentH += childH(ch);
      try { scrim.paddingTop = panelPadTop(ctx.renderer().terminalHeight, contentH); } catch {}
    }

    ctx.stripSelectable();
    void ctx.drainIconQueue();
  };

  const renderSettings = (c: Record<string, any>, panel: any) => {
    const cats = groups();
    ensureVisible();
    const vis = visibleRows();
    const rows = rowsOf(catIdx);
    const canScroll = rows.length > vis;
    const wheelScroll = (ev: any) => {
      if (!canScroll) return;
      try { ev.stopPropagation?.(); } catch {}
      const d = ev.scroll?.direction === "up" ? -3 : 3;
      const max = Math.max(0, rows.length - vis);
      const next = Math.min(max, Math.max(0, scrollOff + d));
      if (next !== scrollOff) { scrollOff = next; renderMenuContent(); }
    };

    // --- left pane: categories ---
    // hover does NOT rebuild the panel — it paints the category via byId
    // (full rebuilds on every mouseover churned native Text/icon buffers
    // hard enough that the panel could fail mid-rebuild and vanish)
    const catPane = Box({ width: CAT_W, flexDirection: "column" });
    cats.forEach((g, gi) => {
      const active = gi === catIdx;
      const icon = CAT_ICONS[g.header ?? ""] ?? "cog";
      const paintCat = (hover: boolean) => {
        setOnId(`tfm-set-cat-${gi}`, (n) => { n.backgroundColor = active ? c.accentBg : hover ? c.hoverBg : undefined; });
        setOnId(`tfm-set-catl-${gi}`, (n) => { n.fg = active || hover ? c.white : c.sidebarFg; });
      };
      catPane.add(Box(
        {
          id: `tfm-set-cat-${gi}`,
          width: "100%",
          height: 1,
          flexDirection: "row",
          columnGap: 1,
          paddingLeft: 1,
          backgroundColor: active ? c.accentBg : undefined,
          onMouseDown: (ev: any) => {
            try { ev.stopPropagation?.(); } catch {}
            if (capturing !== null) { cancelCapture(); return; }
            if (catIdx !== gi) switchCategory(gi);
            else renderMenuContent();
          },
          onMouseOver: () => { if (hoverCat !== gi) { hoverCat = gi; paintCat(true); } },
          onMouseOut: () => { if (hoverCat === gi) { hoverCat = -1; paintCat(false); } },
        },
        ctx.makeIconSlot(
          icon,
          [
            { fg: c.sidebarFg, bg: active ? c.accentBg : c.sidebarBg },
            { fg: c.white, bg: c.accentBg },
          ],
          1,
          active ? 1 : 0,
        ).el,
        Text({ id: `tfm-set-catl-${gi}`, content: (g.header ?? "general").slice(0, CAT_W - 3), fg: active ? c.white : c.sidebarFg }),
      ));
    });
    panel.add(Box(
      {
        width: "100%",
        flexDirection: "row",
        height: Math.max(vis + 1, cats.length + 1),
        // wheel anywhere over the panel scrolls the rows pane (mouse-first)
        onMouseScroll: wheelScroll,
      },
      catPane,
      // --- right pane: rows (windowed) ---
      Box({ width: 1, flexDirection: "column" }),
      renderRowPane(c, rows, vis),
    ));

    // footer hints — pane- and state-aware
    const hint = capturing !== null
      ? "press a key…  esc/enter/click = cancel"
      : pane === "cats"
        ? "click or enter selects · ←→ · tab = rows"
        : `↑↓ move · ←→ adjust${canScroll ? " · wheel scrolls" : ""} · tab = categories`;
    panel.add(Box({ width: "100%", height: 1 }));
    panel.add(Box(
      { width: "100%", height: 1, paddingLeft: 1, paddingRight: 1 },
      Text({ content: hint.slice(0, SETTINGS_W - 2), fg: c.sidebarFgMuted }),
    ));
  };

  const renderRowPane = (c: Record<string, any>, rows: SettingRow[], vis: number) => {
    ensureVisible();
    const canScroll = rows.length > vis;
    const end = Math.min(rows.length, scrollOff + vis);
    const pane2 = Box({ flexGrow: 1, flexDirection: "column" });

    const chevron = (dirText: "‹" | "›", active: boolean, index: number, rowSpec: SettingRow, dir: number) => {
      const tId = `tfm-chev-${index}-${dir}`;
      return Box(
        {
          width: 2,
          justifyContent: "center",
          onMouseDown: (ev: any) => {
            try { ev.stopPropagation?.(); } catch {}
            if (capturing !== null) { cancelCapture(); return; }
            const changed = applyAdjust(rowSpec, dir);
            if (!changed && menuIdx === index) return;
            if (menuIdx !== index) {
              if (pane === "rows") paintRowAt(menuIdx, false);
              menuIdx = index;
              pane = "rows";
              paintRowAt(index, true);
            }
            afterAdjust(index, rowSpec);
          },
          onMouseOver: () => setOnId(tId, (n) => { n.fg = menuC.white; }),
          onMouseOut: () => setOnId(tId, (n) => { n.fg = active ? menuC.white : menuC.sidebarFgMuted; }),
        },
        Text({ id: tId, content: dirText, fg: active ? menuC.white : menuC.sidebarFgMuted }),
      );
    };

    const rowNode = (rowSpec: SettingRow, index: number) => {
      const active = pane === "rows" && menuIdx === index;
      const capturingThis = capturing === index;
      const labelFg = active ? c.white : c.sidebarFg;
      const _paintRow = (on: boolean) => paintRowAt(index, on);
      let control: any;
      let onClick: (ev?: any) => void = (ev?: any) => {
        try { ev?.stopPropagation?.(); } catch {}
        menuIdx = index;
        rowActivate(index);
      };

      if (capturingThis) {
        control = Box(
          { flexGrow: 1 },
          Text({ content: "press a key…", fg: c.accent }),
        );
      } else if (rowSpec.kind === "toggle") {
        const on = rowSpec.get();
        control = Box(
          { width: 6, justifyContent: "flex-end" },
          Text({ id: `tfm-set-rowv-${index}`, content: on ? "on" : "off", fg: on ? c.accent : c.sidebarFgMuted }),
        );
      } else if (rowSpec.kind === "stepper" || rowSpec.kind === "cycle") {
        const value = rowSpec.kind === "stepper"
          ? rowSpec.fmt(rowSpec.get())
          : (() => { const i = rowSpec.getIdx(); return i >= 0 ? rowSpec.names[i] ?? "?" : "custom"; })();
        control = Box(
          { flexDirection: "row", alignItems: "center" },
          chevron("‹", active, index, rowSpec, -1),
          Box(
            { width: 13, justifyContent: "flex-end", paddingRight: 1 },
            Text({
              id: `tfm-set-rowv-${index}`,
              content: value.length > 12 ? value.slice(0, 12) : value,
              fg: active ? c.white : c.sidebarFgMuted,
            }),
          ),
          chevron("›", active, index, rowSpec, 1),
        );
        onClick = (ev?: any) => {
          try { ev?.stopPropagation?.(); } catch {}
          if (capturing !== null) { cancelCapture(); return; }
          menuIdx = index;
          pane = "rows";
          applyAdjust(rowSpec, 1);
          afterAdjust(index, rowSpec);
        };
      } else if (rowSpec.kind === "keybind") {
        const binds = rowSpec.get();
        const shown = binds.length ? binds.join(" / ") : "unset";
        control = Box(
          { width: 18, justifyContent: "flex-end", paddingRight: 1 },
          Text({
            id: `tfm-set-rowv-${index}`,
            content: shown.length > 17 ? shown.slice(0, 17) : shown,
            fg: active ? c.white : c.sidebarFgMuted,
          }),
        );
      } else {
        control = Box({ width: 6 });
      }

      return Box(
        {
          id: `tfm-set-row-${index}`,
          width: "100%",
          height: 1,
          flexDirection: "row",
          paddingLeft: 1,
          paddingRight: 1,
          backgroundColor: capturingThis ? c.hoverBg : active ? c.accentBg : undefined,
          onMouseDown: onClick,
          onMouseOver: () => {
            if (capturing !== null || (pane === "rows" && menuIdx === index)) return;
            const prev = pane === "rows" ? menuIdx : -1;
            menuIdx = index;
            pane = "rows";
            if (prev >= 0 && prev !== index) paintRowAt(prev, false);
            paintRowAt(index, true);
          },
        },
        Text({ id: `tfm-set-rowl-${index}`, content: ` ${rowSpec.label.slice(0, SET_LABEL_W).padEnd(SET_LABEL_W)}`, fg: labelFg }),
        Box({ flexGrow: 1 }),
        control,
      );
    };

    for (let i = scrollOff; i < end; i++) {
      const rowSpec = rows[i];
      if (rowSpec) pane2.add(rowNode(rowSpec, i));
    }
    if (canScroll) {
      pane2.add(Box(
        { width: "100%", height: 1, paddingLeft: 1 },
        Text({
          content: `${scrollOff + 1}-${end} of ${rows.length}`,
          fg: c.sidebarFgMuted,
        }),
      ));
    }
    return pane2;
  };

  // best-effort native allocator stats (renderer.lib is private — this is
  // diagnostics only); lets a tfm-side leak be told apart from system OOM
  // by comparing the numbers across a session's open/close traces
  const nativeMemTrace = (tag: string): void => {
    if (!ctx.log) return;
    try {
      const s = (ctx.renderer() as any).lib?.getAllocatorStats?.();
      if (s) ctx.log?.(`${tag} native mem=${(s.totalRequestedBytes / 1048576).toFixed(1)}MB active=${s.activeAllocations}`);
    } catch {}
  };

  // raw teardown — registered with floats at open time; public closeMenu is
  // floats.close("escmenu")
  const rawCloseMenu = () => {
    menuOpen = false;
    capturing = null;
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
    menuIdx = 0;
    catIdx = 0;
    pane = "rows";
    scrollOff = 0;
    capturing = null;
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
        onMouseDown: () => { if (!cancelCapture()) closeMenu(); },
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
            if (capturing !== null) cancelCapture();
          },
        },
      ),
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
      menuIdx = (menuIdx + delta + count) % count;
      renderMenuContent();
      return;
    }
    if (pane === "cats") {
      switchCategory(catIdx + delta);
      return;
    }
    const count = rowsOf(catIdx).length;
    if (!count) return;
    menuIdx = (menuIdx + delta + count) % count;
    ensureVisible();
    renderMenuContent();
  };

  // the "back" action row returns to the root view
  const showRoot = (): void => { menuView = "root"; menuIdx = 0; pane = "rows"; capturing = null; };

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
