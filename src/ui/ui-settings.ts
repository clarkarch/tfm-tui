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

import { Box, type CliRenderer, type MouseEvent, RGBA, Text } from "@opentui/core";
import { floatSurface, type UiStyle } from "./style";
import { applyAdjust, type SettingGroup, type SettingRow } from "./settings";
import type { IconSlotHandle, IconState, IconSpec, SlotElement } from "./ui-slots";
import type { Theme } from "../config/config";
import { type KeyEventLike, keySpecFromEvent, validateKeybindSpec } from "../config/keyspec";
import type { NodeLike } from "../lib/node-like";
import { FLOAT_Z, type Floats } from "./floats";
import { pokeGc, type NativeStatsReach } from "../app/mem-hygiene";
import {
  descText,
  ensureVisible,
  fitDescText,
  flatVisible,
  renderSettingsPanel,
  sectionKey,
  settingsVisRows,
  SETTINGS_W,
  visiblePos,
  type SettingsPanelState,
} from "./ui-settings-panel";
import type { MaybeNode } from "../lib/node-like";

type EscMenuCtx = {
  renderer(): CliRenderer;
  byId(id: string): MaybeNode;
  clearChildren(node: unknown): void;
  stripSelectable(): void;
  escHintBtn(id: string, onClose: () => void): SlotElement;
  makeIconSlot(
    name: string,
    states: IconState[],
    heightCells?: number,
    initialState?: number,
    onMouseDown?: (ev: MouseEvent) => void,
    statesFactory?: () => IconState[],
  ): IconSlotHandle;
  setIconState(spec: IconSpec, stateIdx: number): void;
  drainIconQueue(): void | Promise<void>;
  setScrim(on: boolean): void;
  // a modal must kill any in-flight rubber-band (grid-input owns the gesture)
  cancelBand(): void;
  colors(): Theme;
  uiStyle(): string;
  // root-view width — same value the context menu uses (MENU_W in ./ui-menu)
  menuW(): number;
  settingGroups(): SettingGroup[];
  // plugin-contributed groups for the DEDICATED Plugins view (separate from
  // settings — plugins add, never modify core rows). Empty without plugins.
  pluginGroups(): SettingGroup[];
  // rescan the plugins dir (adds/removes/edits without restart — edits
  // hot-reload via hashed staging). Never rejects — the loader isolates per
  // plugin.
  reloadPlugins(): Promise<unknown>;
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
  let menuView: "root" | "settings" | "plugins" = "root";
  // panel cursor state — rendered by ./ui-settings-panel, mutated by the ops here
  const st: SettingsPanelState = {
    catIdx: 0,
    menuIdx: 0,
    pane: "rows",
    scrollOff: 0,
    hoverCat: -1,
    capturing: null,
    collapsed: new Set<string>(),
  };

  // settings and plugins views share the panel renderer; the plugins view
  // only sees plugin groups (a plugin can never inject rows into settings)
  const groups = (): SettingGroup[] => (menuView === "plugins" ? ctx.pluginGroups() : ctx.settingGroups());
  const rowsOf = (gi: number): SettingRow[] => groups()[gi]?.rows ?? [];
  const headerOf = (gi: number): string => groups()[gi]?.header ?? "";
  // visible-row projection for a category (collapsible sections; full indices)
  const visOf = (gi: number): number[] => flatVisible(rowsOf(gi), headerOf(gi), st.collapsed);
  // every keyboard/panel op below branches root vs panel — never on a single view
  const inPanelView = (): boolean => menuView !== "root";

  // root <-> panel-view transitions reset the shared cursor state (same reset
  // Settings always did — the panel is rebuilt fresh for either view)
  const enterView = (view: "settings" | "plugins"): void => {
    menuView = view;
    st.catIdx = 0;
    // no row cursor until the first arrow/hover (category highlight stays)
    st.menuIdx = -1;
    st.pane = "rows";
    st.scrollOff = 0;
    renderMenuContent();
  };

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
      action: () => enterView("settings"),
    },
    // plugins get their OWN view (same panel UI, separate entry) — and only
    // when at least one plugin contributes rows
    ...(ctx.pluginGroups().length
      ? [
          {
            icon: "power-plug",
            label: "Plugins",
            keepOpen: true,
            action: () => enterView("plugins"),
          },
        ]
      : []),
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
    // land on the first VISIBLE row — headers take the cursor now (they
    // collapse/expand), hidden children are never landed on
    st.menuIdx = visOf(st.catIdx)[0] ?? -1;
    st.pane = "rows";
    st.scrollOff = 0;
    renderMenuContent();
  };

  // collapse/expand one section; collapsing under the cursor parks it on the
  // section's header (the nearest visible row at or above the old cursor)
  const toggleSection = (key: string): void => {
    if (st.collapsed.has(key)) st.collapsed.delete(key);
    else st.collapsed.add(key);
    const flat = visOf(st.catIdx);
    if (st.menuIdx >= 0 && !flat.includes(st.menuIdx)) {
      st.menuIdx = [...flat].reverse().find((i) => i <= st.menuIdx) ?? flat[0] ?? -1;
    }
    renderMenuContent();
  };

  const visibleRows = (): number => settingsVisRows(ctx.renderer().terminalHeight);

  const adjustSelectedSetting = (dir: number): void => {
    if (!inPanelView()) return;
    if (st.pane === "cats") {
      switchCategory(st.catIdx + dir);
      return;
    }
    const row = rowsOf(st.catIdx)[st.menuIdx];
    if (!row) return;
    // headers collapse/expand: → opens, ← closes (enter toggles via rowActivate)
    if (row.kind === "header") {
      const key = sectionKey(headerOf(st.catIdx), row.label);
      const shut = st.collapsed.has(key);
      if ((dir > 0 && shut) || (dir < 0 && !shut)) toggleSection(key);
      return;
    }
    // keybind/action rows have no left/right value — the arrows switch category
    if (row.kind === "keybind" || row.kind === "action") {
      switchCategory(st.catIdx + dir);
      return;
    }
    // a throwing plugin row set()/get()/getIdx() must not throw out of the
    // keypress handler — afterAdjust re-reads the row, so it sits in the SAME
    // try, not after it
    try {
      if (applyAdjust(row, dir)) afterAdjust(st.menuIdx, row);
    } catch {}
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

  // live description-footer repaint via byId — NO rebuild (same OOM rule as paintRowAt)
  const paintDesc = (text: string): void => {
    setOnId("tfm-set-desc", (n) => {
      n.content = text;
    });
  };

  // repaint one row's highlight via byId — NO rebuild (rebuild churn under
  // memory pressure trips native allocation failures; see AGENTS.md OOM note)
  // Single paint truth: bg + label + value + BOTH chevrons, so hover and
  // keyboard land on identical colors (the old split left chevrons muted on
  // a highlighted row and headers the wrong gray on hover-off).
  const paintRowAt = (idx: number, on: boolean): void => {
    const c = menuC;
    const row = rowsOf(st.catIdx)[idx];
    const isHeader = row?.kind === "header";
    setOnId(`tfm-set-row-${idx}`, (n) => {
      n.backgroundColor = on ? c.accentBg : undefined;
    });
    setOnId(`tfm-set-rowl-${idx}`, (n) => {
      n.fg = !on && isHeader ? c.sidebarFgMuted : c.white;
    });
    setOnId(`tfm-set-rowv-${idx}`, (n) => {
      if (on) {
        n.fg = c.white;
        return;
      }
      // off: toggle keeps its on/accent cue, everything else mutes
      if (row?.kind === "toggle") {
        let isOn = false;
        try {
          isOn = row.get();
        } catch {}
        n.fg = isOn ? c.accent : c.sidebarFgMuted;
        return;
      }
      n.fg = c.sidebarFgMuted;
    });
    for (const dir of [-1, 1]) {
      setOnId(`tfm-chev-${idx}-${dir}`, (n) => {
        n.fg = on ? c.white : c.sidebarFgMuted;
      });
    }
  };

  // repaint ONE category's hover/active highlight by id — no rebuild, and it
  // never switches the active category (hover is visual feedback only)
  const paintCatAt = (gi: number, on: boolean): void => {
    const c = menuC;
    const isActive = gi === st.catIdx;
    setOnId(`tfm-set-cat-${gi}`, (n) => {
      n.backgroundColor = on || isActive ? c.accentBg : undefined;
    });
  };

  // after applyAdjust on a value row: refresh JUST the value text by id.
  // Rows flagged `repaint` (theme / ui-style / transparent-bg) change the
  // panel's own colors and need the full rebuild.
  const afterAdjust = (index: number, row: SettingRow): void => {
    if (row.kind === "action" || row.kind === "keybind" || row.kind === "header") return;
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
              return i >= 0 ? (row.names[i] ?? "?") : (row.customLabel?.() ?? "custom");
            })();
    setOnId(`tfm-set-rowv-${index}`, (n) => {
      n.content = value.length > 12 ? value.slice(0, 12) : value;
      // selected rows keep white values; unselected toggles keep the on/accent cue
      if (st.pane === "rows" && st.menuIdx === index) n.fg = menuC.white;
      else if (row.kind === "toggle") n.fg = row.get() ? menuC.accent : menuC.sidebarFgMuted;
    });
  };

  // called from the keyboard router BEFORE the esc-menu nav branch: while
  // recording, every key is swallowed. enter/click-away also cancel.
  const captureKey = (e: KeyEventLike): boolean => {
    if (st.capturing === null) return false;
    // only an UNMODIFIED escape/return/tab cancels: ctrl+tab / ctrl+shift+tab
    // are next/prev-tab binds and must be recordable (they were unbindable
    // through the GUI — every tab chord cancelled capture)
    const unmodified = !e.ctrl && !e.shift && !e.meta && !e.option;
    if (unmodified && (e.name === "escape" || e.name === "return" || e.name === "tab")) {
      st.capturing = null;
      renderMenuContent();
      return true;
    }
    const spec = keySpecFromEvent(e);
    if (!spec) return true;
    const problem = validateKeybindSpec(spec);
    if (problem) {
      ctx.warn(problem, "invalid keybind");
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
    // headers collapse/expand in place (enter toggles; ←/→ handled in adjust)
    if (row.kind === "header") {
      toggleSection(sectionKey(headerOf(st.catIdx), row.label));
      return;
    }
    if (row.kind === "toggle") {
      try {
        applyAdjust(row, 1);
        afterAdjust(rowIdx, row);
      } catch (err) {
        ctx.log?.(`plugin row "${row.label}" threw: ${err instanceof Error ? err.message : err}`);
      }
      return;
    }
    if (row.kind === "keybind") {
      startCapture(rowIdx);
      return;
    }
    if (row.kind === "action") {
      // runtime isolation: a throwing plugin row must never break the
      // menu's close path — the menu still closes, the error is logged.
      if (row.keepOpen) {
        try {
          row.run();
        } catch (err) {
          ctx.log?.(`plugin row "${row.label}" threw: ${err instanceof Error ? err.message : err}`);
        }
        renderMenuContent();
      } else {
        closeMenu();
        try {
          row.run();
        } catch (err) {
          ctx.log?.(`plugin row "${row.label}" threw: ${err instanceof Error ? err.message : err}`);
        }
      }
      return;
    }
    try {
      applyAdjust(row, 1);
    } catch (err) {
      ctx.log?.(`plugin row "${row.label}" threw: ${err instanceof Error ? err.message : err}`);
      return;
    }
    afterAdjust(rowIdx, row);
  };

  const menuActivate = () => {
    if (inPanelView()) {
      if (st.pane === "cats") {
        switchCategory(st.catIdx);
        return;
      }
      rowActivate(st.menuIdx);
      return;
    }
    const items = rootMenuItems();
    const it = items[st.menuIdx];
    if (!it) return;
    if (it.keepOpen) {
      it.action();
      return;
    }
    closeMenu();
    it.action();
  };

  const menuTab = (): void => {
    if (!inPanelView() || st.capturing !== null) return;
    st.pane = st.pane === "cats" ? "rows" : "cats";
    renderMenuContent();
  };

  const setOnId = (id: string, fn: (n: NodeLike) => void): void => {
    const n = ctx.byId(id);
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
    const panel = ctx.byId("tfm-menu-panel");
    if (!panel) return;
    ctx.clearChildren(panel);
    try {
      buildMenuContent(c, panel, menuView);
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
      const s = (ctx.renderer() as unknown as NativeStatsReach).lib?.getAllocatorStats?.();
      if (s) {
        ctx.log?.(
          `esc-menu render failed: ${err} | native mem=${(s.totalRequestedBytes / 1048576).toFixed(1)}MB active=${s.activeAllocations}`,
        );
        return;
      }
    } catch {}
    ctx.log?.(`esc-menu render failed: ${err}`);
  };

  const buildMenuContent = (c: Theme, panel: NodeLike, view: "root" | "settings" | "plugins") => {
    menuC = c;
    const panelView = view !== "root";
    const panelW = panelView ? SETTINGS_W : ctx.menuW();
    try {
      panel.width = panelW;
    } catch {}

    panel.add(
      Box(
        { width: "100%", height: 1, flexDirection: "row", alignItems: "center", paddingLeft: 2, paddingRight: 1 },
        Text({
          content: view === "plugins" ? "Menu — plugins" : view === "settings" ? "Menu — settings" : "Menu",
          fg: c.accent,
        }),
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

    if (!panelView) {
      const paintRootAt = (index: number, on: boolean): void => {
        setOnId(`tfm-root-row-${index}`, (n) => {
          n.backgroundColor = on ? c.accentBg : undefined;
        });
        setOnId(`tfm-root-rowl-${index}`, (n) => {
          n.fg = c.white;
        });
      };
      const hoverSelect = (index: number) => () => {
        if (st.menuIdx === index) return;
        const prev = st.menuIdx;
        st.menuIdx = index;
        if (prev >= 0) paintRootAt(prev, false);
        paintRootAt(index, true);
      };
      const activateRow = (index: number) => (ev?: MouseEvent) => {
        try {
          ev?.stopPropagation?.();
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
        onClick: (ev?: MouseEvent) => void,
      ) =>
        Box(
          {
            id: `tfm-root-row-${index}`,
            width: "100%",
            height: 1,
            flexDirection: "row",
            columnGap: 1,
            paddingLeft: 1,
            paddingRight: 1,
            backgroundColor: active ? c.accentBg : undefined,
            onMouseDown: onClick,
            onMouseMove: hoverSelect(index),
          },
          ...(icon
            ? [
                ctx.makeIconSlot(
                  icon,
                  [
                    { fg: c.white, bg: active ? c.accentBg : c.sidebarBg },
                    { fg: c.white, bg: c.accentBg },
                  ],
                  1,
                  active ? 1 : 0,
                ).el,
              ]
            : []),
          Text({
            id: `tfm-root-rowl-${index}`,
            content: icon ? label : ` ${label}`,
            fg: c.white,
          }),
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
        setIconState: (spec, stateIdx) => ctx.setIconState(spec, stateIdx),
        paintCatAt,
        switchCategory,
        cancelCapture,
        rowActivate,
        afterAdjust,
        paintRowAt,
        rebuild: renderMenuContent,
        isCollapsed: (key) => st.collapsed.has(key),
        toggleSection,
        paintDesc,
        log: (message) => ctx.log?.(message),
      });
    }

    // vertical centering is structural (scrim justifyContent:center) — no
    // manual padding math: content-height heuristics broke on the settings
    // view, whose two-pane container counts as ONE child while spanning many
    // rows (that mismatch pushed the panel off the bottom edge)
    ctx.stripSelectable();
    void ctx.drainIconQueue();
  };

  // best-effort native allocator stats (renderer.lib is private — this is
  // diagnostics only); lets a tfm-side leak be told apart from system OOM
  // by comparing the numbers across a session's open/close traces
  const nativeMemTrace = (tag: string): void => {
    if (!ctx.log) return;
    try {
      const s = (ctx.renderer() as unknown as NativeStatsReach).lib?.getAllocatorStats?.();
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
    const scrim = ctx.byId("tfm-menu");
    scrim?.parent?.remove(scrim);
    ctx.setScrim(false);
    // esc-menu open/close churns native allocations (documented leak vector);
    // a rapid cycle can exhaust the allocator before the 10s hygiene tick, so
    // drain finalizers immediately on close.
    pokeGc();
  };

  const openMenu = () => {
    if (menuOpen) return;
    ctx.floats.open("escmenu", rawCloseMenu);
    menuOpen = true;
    menuView = "root";
    st.menuIdx = -1;
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
        justifyContent: "center",
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
        ...floatSurface(ctx.uiStyle() as UiStyle, ctx.colors() as Theme, ctx.colors().sidebarBg),
        paddingTop: 1,
        paddingBottom: 1,
        onMouseDown: (ev: MouseEvent) => {
          try {
            ev.stopPropagation?.();
          } catch {}
          if (st.capturing !== null) cancelCapture();
        },
      }),
    );
    ctx.renderer().root.add(scrim);
    // rescan the plugins dir on every open (the scan itself never rejects —
    // the loader isolates per plugin): added/removed plugins render once it
    // settles if the menu is still up; edited code still needs a restart
    void ctx.reloadPlugins().then(() => {
      if (menuOpen) renderMenuContent();
    });
    renderMenuContent();
  };

  const closeMenu = () => {
    ctx.floats.close("escmenu");
  };

  const moveMenu = (delta: number) => {
    if (!inPanelView()) {
      const count = rootMenuItems().length;
      if (!count) return;
      st.menuIdx = st.menuIdx < 0 ? (delta >= 0 ? 0 : count - 1) : (st.menuIdx + delta + count) % count;
      renderMenuContent();
      return;
    }
    if (st.pane === "cats") {
      switchCategory(st.catIdx + delta);
      return;
    }
    const flat = visOf(st.catIdx);
    if (!flat.length) return;
    // idx -1 = no cursor yet: down fills the first VISIBLE row, up the last.
    // Headers take the cursor (they collapse/expand); hidden children are
    // stepped over because the walk stays inside the visible projection.
    // flat is non-empty (checked above); bind head/tail once so the walk needs
    // no assertions, and an impossible empty projection simply no-ops
    const first = flat[0];
    const last = flat[flat.length - 1];
    if (first === undefined || last === undefined) return;
    if (st.menuIdx < 0 || !flat.includes(st.menuIdx)) {
      st.menuIdx = delta >= 0 ? first : last;
    } else {
      const pos = visiblePos(flat, st.menuIdx);
      st.menuIdx = flat[(pos + delta + flat.length) % flat.length] ?? first;
    }
    ensureVisible(st, visibleRows(), flat.length, visiblePos(flat, st.menuIdx));
    paintDesc(fitDescText(descText(rowsOf(st.catIdx)[st.menuIdx])));
    renderMenuContent();
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
  };
};
