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

import { Box, type CliRenderer, type MouseEvent, Text } from "@opentui/core";
import { advanceCursor, cursorAt, cursorIndex, errMessage, invokeIsolated } from "../lib/uiutil";
import type { UiStyle } from "../config/config-schema";
import { makeModalScrim } from "./ui-dialogs";
import { applyAdjust, type SettingGroup, type SettingRow } from "./settings";
import type { MakeIconSlot, SlotElement } from "./ui-slots";
import { IconStateIdx } from "../lib/icon-state";
import type { Theme } from "../config/config";
import { type KeyEventLike, keySpecFromEvent, validateKeybindSpec } from "../config/keyspec";
import type { NodeLike } from "../lib/node-like";
import { FLOAT_Z, type Floats } from "./floats";
import { pokeGc, type NativeStatsReach } from "../lib/mem-hygiene";
import {
  clampToVisible,
  descText,
  fitDescText,
  fitValueText,
  flatVisible,
  renderSettingsPanel,
  scrollFor,
  sectionKey,
  settingsPanelWidth,
  settingsVisRows,
  SET_TOGGLE_W,
  SET_VAL_W,
  visiblePos,
  type Capture,
  type MenuFocus,
  type SettingsPanelView,
} from "./ui-settings-panel";
import { helpPanelWidth, renderHelpPanel } from "./ui-help";
import { aboutPanelWidth, renderAboutPanel, type AboutDetail } from "./ui-about";
import type { KeyAction, KeybindSetResult } from "../config/config-schema";
import type { MaybeNode } from "../lib/node-like";
import type { PointerStyle } from "../lib/pointer";
import type { IconSpec } from "../lib/icon-state";

type EscMenuCtx = {
  renderer(): CliRenderer;
  byId(id: string): MaybeNode;
  destroyChildren(node: unknown): void;
  stripSelectable(): void;
  escHintBtn(id: string, onClose: () => void): SlotElement;
  makeIconSlot: MakeIconSlot;
  setIconState(spec: IconSpec, stateIdx: number): void;
  drainIconQueue(): void | Promise<void>;
  // a modal must kill any in-flight rubber-band (grid-input owns the gesture)
  cancelBand(): void;
  colors(): Theme;
  uiStyle(): UiStyle;
  // root-view width — same value the context menu uses (MENU_W in ./ui-menu)
  menuW(): number;
  // live keybind lookup for the help view (same getter keymap uses).
  // Optional so older fakes read as defaults; wiring always sets it.
  keybinds?(action: KeyAction): string[];
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
  // external URL opener for About link rows (wired to xdg-open). Optional
  // so older fakes keep working; absent = link clicks no-op.
  openUrl?(url: string): void;
  // About's update row: a live value plus the check it triggers. Optional so
  // older fakes keep the static idle copy.
  updateValue?(): string;
  updateActionable?(): boolean;
  onCheckUpdates?(): void;
  // mouse pointer shape (OSC 22 via the wiring's tty-guarded setter).
  // Absent = no pointer changes (old fakes keep working).
  setPointer?(style: PointerStyle): void;
};

export const makeEscMenu = (ctx: EscMenuCtx) => {
  let menuOpen = false;
  let menuView: "root" | "settings" | "plugins" | "help" | "about" = "root";
  // the menu's ONE state record — the shell owns it. The panel renderer gets
  // a READ-ONLY live view of it and routes every change back through the
  // actions below (the old code passed the record BY REFERENCE and the
  // renderer mutated fields the shell also owned).
  const st: {
    focus: MenuFocus;
    // the hovered category's IDENTITY (its header) — never its index: the
    // category list is rebuilt on every render and a plugin rescan can
    // change it, so an index would name a DIFFERENT category afterwards
    hoverCat: string | null;
    scrollOff: number;
    collapsed: Set<string>;
    // the keybind capture's phase — ONE tagged record (idle / recording /
    // conflict offer). The old code kept the recorded row and the pending
    // offer as TWO nullable fields whose pairing was a convention.
    capture: Capture;
  } = {
    focus: { kind: "none" },
    hoverCat: null,
    scrollOff: 0,
    collapsed: new Set<string>(),
    capture: { kind: "idle" },
  };
  // restart-toast dedupe: one "needs restart" toast per row per menu open —
  // holding ←/→ on a stepper otherwise floods the toast stack
  const restartWarned = new Set<string>();

  // settings and plugins views share the panel renderer; the plugins view
  // only sees plugin groups (a plugin can never inject rows into settings)
  const groups = (): SettingGroup[] => (menuView === "plugins" ? ctx.pluginGroups() : ctx.settingGroups());
  const rowsOf = (gi: number): SettingRow[] => groups()[gi]?.rows ?? [];
  const headerOf = (gi: number): string => groups()[gi]?.header ?? "";
  // visible-row projection for a category (collapsible sections; full indices)
  const visOf = (gi: number): number[] => flatVisible(rowsOf(gi), headerOf(gi), st.collapsed);
  // every keyboard/panel op below branches root vs panel — never on a single view
  const inPanelView = (): boolean => menuView !== "root";

  // --- the focus record's readers (one meaning per index) ---
  // the focused category (the right pane always shows it)
  const activeCat = (): number => (st.focus.kind === "cat" || st.focus.kind === "row" ? st.focus.cat : 0);
  // the focused row (null = none) — only the rows pane owns a row cursor
  const activeRow = (): number | null => (st.focus.kind === "row" ? st.focus.row : null);
  // the root menu's item cursor (-1 = none)
  const activeItem = (): number => (st.focus.kind === "root" ? st.focus.item : -1);

  // --- the capture's phase ---
  // a capture names ONE row of ONE category: a category change (the ←/→
  // switch, a plugin rescan clamping the cursor) or a vanished row (a
  // plugin removed mid-capture) leaves the capture pointing at something
  // else, so it is dropped. ONE check, so no writer can leave a stale
  // capture behind. Returns true when it dropped one.
  const dropStaleCapture = (): boolean => {
    if (st.capture.kind === "idle") return false;
    const cat = st.focus.kind === "row" || st.focus.kind === "cat" ? st.focus.cat : -1;
    // the target must still be a keybind row of the focused category —
    // otherwise the prompt would paint on whatever row took its place
    if (st.capture.cat !== cat || rowsOf(cat)[st.capture.row]?.kind !== "keybind") {
      st.capture = { kind: "idle" };
      return true;
    }
    return false;
  };

  // ONE reset for the menu's view state: the focus, the mouse hover and the
  // window offset. Every entry point that shows a FRESH view calls it (open,
  // close, view change) — the old code reset some fields in one place and
  // not others, so a stale category hover survived into the next open (the
  // category painted as hovered with the mouse elsewhere).
  const resetViewState = (): void => {
    st.focus = { kind: "none" };
    st.hoverCat = null;
    st.scrollOff = 0;
    st.capture = { kind: "idle" };
  };

  // the help/about views are cursorless (static panels) — cursor ops no-op there
  const isHelpView = (): boolean => menuView === "help";
  const isAboutView = (): boolean => menuView === "about";
  const isStaticView = (): boolean => menuView === "help" || menuView === "about";
  // about detail drill (credits row → full list, ← Back returns). Reset on
  // every fresh about entry and menu close — never carried across opens.
  let aboutDetail: AboutDetail = null;
  // root <-> panel-view transitions reset the shared cursor state (same reset
  // Settings always did — the panel is rebuilt fresh for either view)
  const enterView = (view: "settings" | "plugins" | "help" | "about"): void => {
    menuView = view;
    // a fresh about entry always lands on main (detail never carries over)
    if (view === "about") aboutDetail = null;
    // ONE reset: the focus, the mouse hover, the window offset + the capture
    resetViewState();
    // the panel opens on its FIRST category with NO row selected (the
    // category highlight stays until the first arrow/hover)
    if (view === "settings" || view === "plugins") st.focus = { kind: "row", cat: 0, row: null };
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
    // the help view sits below Plugins: everything above quits the app,
    // this one just explains it
    { icon: "help", label: "Help", keepOpen: true, action: () => enterView("help") },
    // the about view sits below Help: brand + version + links, no controls
    { icon: "information", label: "About", keepOpen: true, action: () => enterView("about") },
    {
      icon: "power",
      label: "Quit",
      hint: "ctrl+q",
      action: ctx.quit,
    },
  ];

  const switchCategory = (gi: number): void => {
    const n = groups().length;
    // no groups at all (every plugin removed while the view was open): the
    // focus parks on an empty first category instead of a NaN index
    if (n === 0) {
      st.focus = { kind: "row", cat: 0, row: null };
      st.scrollOff = 0;
      renderMenuContent();
      return;
    }
    const cat = ((gi % n) + n) % n;
    // land on the first VISIBLE row — headers take the cursor now (they
    // collapse/expand), hidden children are never landed on
    st.focus = { kind: "row", cat, row: visOf(cat)[0] ?? null };
    st.scrollOff = 0;
    renderMenuContent();
  };

  // collapse/expand one section; collapsing under the cursor parks it on the
  // section's header (the nearest visible row at or above the old cursor)
  const toggleSection = (key: string): void => {
    if (st.collapsed.has(key)) st.collapsed.delete(key);
    else st.collapsed.add(key);
    const flat = visOf(activeCat());
    const at = activeRow();
    if (at !== null && !flat.includes(at)) {
      const parked = clampToVisible(flat, at);
      st.focus = { kind: "row", cat: activeCat(), row: parked < 0 ? null : parked };
    }
    renderMenuContent();
  };

  const visibleRows = (): number => settingsVisRows(ctx.renderer().terminalHeight);

  const adjustSelectedSetting = (dir: number): void => {
    if (!inPanelView()) return;
    // the static views are cursorless — ←/→ do nothing there
    if (isStaticView()) return;
    if (st.focus.kind === "cat") {
      switchCategory(activeCat() + dir);
      return;
    }
    const at = activeRow();
    if (at === null) return;
    const row = rowsOf(activeCat())[at];
    if (!row) return;
    // headers collapse/expand: → opens, ← closes (enter toggles via rowActivate)
    if (row.kind === "header") {
      const key = sectionKey(headerOf(activeCat()), row.label);
      const shut = st.collapsed.has(key);
      if ((dir > 0 && shut) || (dir < 0 && !shut)) toggleSection(key);
      return;
    }
    // keybind/action rows have no left/right value — the arrows switch category
    if (row.kind === "keybind" || row.kind === "action") {
      switchCategory(activeCat() + dir);
      return;
    }
    // a throwing plugin row set()/get()/getIdx() must not throw out of the
    // keypress handler — afterAdjust re-reads the row, so it sits in the SAME
    // try, not after it
    try {
      if (applyAdjust(row, dir)) afterAdjust(at, row);
    } catch {}
  };

  const cancelCapture = (): boolean => {
    if (st.capture.kind === "idle") return false;
    st.capture = { kind: "idle" };
    renderMenuContent();
    return true;
  };

  const startCapture = (rowIdx: number): void => {
    const cat = activeCat();
    const row = rowsOf(cat)[rowIdx];
    if (row?.kind !== "keybind") return;
    st.capture = { kind: "recording", cat, row: rowIdx };
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
    const row = rowsOf(activeCat())[idx];
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

  // root-row icon specs, by index — the hover AND keyboard repaints flip them
  // in lockstep with the row bg. A baked raster carries its own bg, so
  // highlighting only the row left the icon showing a stale sidebarBg square.
  // Lives at factory scope (not inside buildMenuContent) so the keyboard
  // cursor can repaint a root row without rebuilding the panel.
  const rootSpecs: (IconSpec | undefined)[] = [];
  const paintRootAt = (index: number, on: boolean): void => {
    const c = menuC;
    setOnId(`tfm-root-row-${index}`, (n) => {
      n.backgroundColor = on ? c.accentBg : undefined;
    });
    setOnId(`tfm-root-rowl-${index}`, (n) => {
      n.fg = c.white;
    });
    const spec = rootSpecs[index];
    if (spec) ctx.setIconState(spec, on ? IconStateIdx.Active : IconStateIdx.Rest);
  };

  // repaint ONE category's hover/active highlight by id — no rebuild, and it
  // never switches the active category (hover is visual feedback only)
  const paintCatAt = (gi: number, on: boolean): void => {
    const c = menuC;
    const isActive = gi === activeCat();
    setOnId(`tfm-set-cat-${gi}`, (n) => {
      n.backgroundColor = on || isActive ? c.accentBg : undefined;
    });
  };

  // category icon specs, by index — the shell owns the category hover paint
  // (bg + the icon's pre-rastered state), so it needs the spec the panel
  // built. Lives at factory scope (like rootSpecs) so a hover can flip the
  // raster without rebuilding the panel.
  const catSpecs: (IconSpec | undefined)[] = [];

  // --- the panel's actions (the renderer never mutates the state) ---
  // focus a row (mouse hover / click) — the shell owns the focus record AND
  // the row paint, so the state and the paint can never disagree. Returns
  // true when the focus MOVED.
  const focusRow = (index: number): boolean => {
    const cat = activeCat();
    const prev = activeRow();
    const already = st.focus.kind === "row" && prev === index;
    st.focus = { kind: "row", cat, row: index };
    if (already) return false;
    if (prev !== null && prev !== index) paintRowAt(prev, false);
    paintRowAt(index, true);
    return true;
  };

  // the category under the mouse (paint only — hovering never switches
  // categories). The shell paints BOTH halves (the row bg + the icon's
  // pre-rastered state), so they cannot drift apart. The hover is keyed by
  // the category's IDENTITY (its header): the category list is rebuilt on
  // every render and a plugin rescan can change it, so an index would name
  // a DIFFERENT category after the rebuild.
  const catIndexOf = (key: string): number => groups().findIndex((g) => (g.header ?? "") === key);
  const hoverCatAt = (key: string | null): void => {
    const prev = st.hoverCat;
    if (prev === key) return;
    st.hoverCat = key;
    if (prev !== null) {
      const gi = catIndexOf(prev);
      if (gi >= 0) {
        paintCatAt(gi, false);
        const spec = catSpecs[gi];
        if (spec) ctx.setIconState(spec, gi === activeCat() ? IconStateIdx.Active : IconStateIdx.Rest);
      }
    }
    if (key !== null) {
      const gi = catIndexOf(key);
      if (gi >= 0) {
        paintCatAt(gi, true);
        const spec = catSpecs[gi];
        if (spec) ctx.setIconState(spec, IconStateIdx.Active);
      }
    }
  };

  // scroll the rows pane (the wheel) — the shell owns the offset: it clamps
  // it against the CURRENT rows and rebuilds only when it moved.
  const scrollRows = (delta: number): void => {
    const flat = visOf(activeCat());
    const vis = visibleRows();
    const max = Math.max(0, flat.length - vis);
    const next = Math.min(max, Math.max(0, st.scrollOff + delta));
    if (next === st.scrollOff) return;
    st.scrollOff = next;
    renderMenuContent();
  };

  // clamp the panel's state against the CURRENT group list — a plugin rescan
  // can shrink the categories (the old cursor pointed past the end and the
  // right pane rendered EMPTY), and the hovered category can name a row that
  // no longer exists.
  const clampPanelState = (): void => {
    const gs = groups();
    const n = gs.length;
    if (st.focus.kind !== "cat" && st.focus.kind !== "row") {
      // not in a panel view: a category index means nothing here
      if (st.hoverCat !== null) st.hoverCat = null;
    } else if (n === 0) {
      st.focus = { kind: "row", cat: 0, row: null };
      st.hoverCat = null;
      st.scrollOff = 0;
    } else {
      const cat = Math.min(Math.max(0, st.focus.cat), n - 1);
      const flat = visOf(cat);
      // the focused row must still be VISIBLE (a plugin row can vanish, a
      // section can collapse) — park it on the nearest visible row at or above
      let row = st.focus.row;
      if (row !== null && !flat.includes(row)) {
        const parked = clampToVisible(flat, row);
        row = parked < 0 ? null : parked;
      }
      st.focus = { kind: st.focus.kind, cat, row };
      // the hovered category must still exist (a plugin group can vanish)
      if (st.hoverCat !== null && catIndexOf(st.hoverCat) < 0) st.hoverCat = null;
      // the window offset must fit the current rows and keep the focused row
      // visible
      const vis = visibleRows();
      st.scrollOff = scrollFor(vis, flat.length, row === null ? -1 : visiblePos(flat, row), st.scrollOff);
    }
    // the capture belongs to the FOCUSED category: a category change (the
    // ←/→ switch, a rescan clamping the cursor above) leaves its row index
    // pointing at a DIFFERENT row — the capture is dropped there. ONE check,
    // every path.
    dropStaleCapture();
  };

  // after applyAdjust on a value row: refresh JUST the value text by id.
  // Rows flagged `repaint` (theme / ui-style / transparent-bg) change the
  // panel's own colors and need the full rebuild.
  const afterAdjust = (index: number, row: SettingRow): void => {
    if (row.kind === "action" || row.kind === "keybind" || row.kind === "header") return;
    // cold-boot-only rows (schema restart flag): say so once per row per menu
    // open — the footer already badges them persistently, this confirms the
    // just-committed change specifically
    if ("restart" in row && row.restart && !restartWarned.has(row.label)) {
      restartWarned.add(row.label);
      try {
        ctx.warn(`${row.label} takes effect after restart`, "restart");
      } catch {}
    }
    if (row.repaint) {
      // a gating master may have hidden rows at/below the cursor (its own
      // children): park on the nearest still-visible row BEFORE the rebuild
      // paints highlights, or the cursor strands on a vanished row
      const at = activeRow();
      if (at !== null) {
        const parked = clampToVisible(visOf(activeCat()), at);
        st.focus = { kind: "row", cat: activeCat(), row: parked < 0 ? null : parked };
      }
      renderMenuContent();
      return;
    }
    const value =
      row.kind === "toggle"
        ? fitValueText(row.get() ? "on" : "off", SET_TOGGLE_W)
        : row.kind === "stepper"
          ? fitValueText(row.fmt(row.get()), SET_VAL_W - 1)
          : (() => {
              const sel = row.get();
              const name = sel.kind === "index" ? (row.names[sel.index] ?? "?") : sel.label;
              return fitValueText(name, SET_VAL_W - 1);
            })();
    setOnId(`tfm-set-rowv-${index}`, (n) => {
      n.content = value;
      // selected rows keep white values; unselected toggles keep the on/accent cue
      if (activeRow() === index) n.fg = menuC.white;
      else if (row.kind === "toggle") n.fg = row.get() ? menuC.accent : menuC.sidebarFgMuted;
    });
  };

  // keybind set outcomes (config-schema): legacy void rows (and throwing
  // ones) fall through to the old clear-capture path; only real outcomes
  // steer the capture. An array return (older test fakes assigned the binds)
  // is not an outcome — "status" in [] is false.
  const isSwapOffer = (r: unknown): r is Extract<KeybindSetResult, { status: "conflict" }> =>
    typeof r === "object" && r !== null && (r as { status?: unknown }).status === "conflict";
  const isSetRejection = (r: unknown): r is Extract<KeybindSetResult, { status: "rejected" }> =>
    typeof r === "object" && r !== null && (r as { status?: unknown }).status === "rejected";

  // called from the keyboard router BEFORE the esc-menu nav branch: while
  // recording, every key is swallowed. enter/click-away also cancel. A
  // conflicting key opens an inline swap offer instead of rejecting: enter
  // steals the bind, esc returns to capture, any other key re-proposes.
  const captureKey = (e: KeyEventLike): boolean => {
    if (st.capture.kind === "idle") return false;
    // a capture whose target vanished (a category change, a rescan, a live
    // reload that reshuffled the rows) is STALE — it is dropped here and
    // repainted: a dead capture must not swallow the key, and its prompt
    // must not stay on screen
    if (dropStaleCapture()) {
      renderMenuContent();
      return false;
    }
    const cap = st.capture;
    // only an UNMODIFIED escape/return/tab cancels: ctrl+tab / ctrl+shift+tab
    // are next/prev-tab binds and must be recordable (they were unbindable
    // through the GUI — every tab chord cancelled capture)
    const unmodified = !e.ctrl && !e.shift && !e.meta && !e.option;
    // whether the key below drops an open offer: the unrecordable/invalid
    // early returns must repaint then, or a stale offer stays on screen
    let droppedOffer = false;
    if (cap.kind === "offer") {
      if (unmodified && e.name === "tab") {
        st.capture = { kind: "idle" };
        renderMenuContent();
        return true;
      }
      if (unmodified && e.name === "escape") {
        st.capture = { kind: "recording", cat: cap.cat, row: cap.row };
        renderMenuContent();
        return true;
      }
      // OpenTUI reports Enter as "return" (see the capture comment below) —
      // the same spelling the cancel branch matches, so both agree
      if (unmodified && e.name === "return") {
        const row = rowsOf(cap.cat)[cap.row];
        if (row?.kind === "keybind" && row.swap) {
          st.capture = { kind: "idle" };
          try {
            row.swap(cap.spec);
          } catch {}
          renderMenuContent();
          return true;
        }
        // swap-less row (only rows whose set reports conflicts define swap,
        // so this is unreachable in prod): keep the offer up rather than a
        // silent no-commit clear
        renderMenuContent();
        return true;
      }
      droppedOffer = true;
      // re-propose with the key below (the offer's phase ends, the capture
      // stays armed on the same row)
      st.capture = { kind: "recording", cat: cap.cat, row: cap.row };
    }
    if (unmodified && (e.name === "escape" || e.name === "return" || e.name === "tab")) {
      st.capture = { kind: "idle" };
      renderMenuContent();
      return true;
    }
    const spec = keySpecFromEvent(e);
    if (!spec) {
      // an unrecordable keypress dropped the offer above — repaint so no
      // stale "swap?" offer stays on screen (capture stays armed for retry)
      if (droppedOffer) renderMenuContent();
      return true;
    }
    const problem = validateKeybindSpec(spec);
    if (problem) {
      ctx.warn(problem, "invalid keybind");
      if (droppedOffer) renderMenuContent();
      return true; // stay in capture so the user can retry
    }
    const row = rowsOf(cap.cat)[cap.row];
    let outcome: unknown;
    try {
      if (row?.kind === "keybind") outcome = row.set([spec]);
    } catch {
      outcome = undefined;
    }
    if (isSwapOffer(outcome)) {
      st.capture = {
        kind: "offer",
        cat: cap.cat,
        row: cap.row,
        spec: outcome.spec,
        ownerLabel: outcome.ownerLabel,
      };
      renderMenuContent();
      return true;
    }
    if (isSetRejection(outcome)) {
      renderMenuContent();
      return true; // already warned — stay in capture so the user can retry
    }
    st.capture = { kind: "idle" };
    renderMenuContent();
    return true;
  };

  const rowActivate = (rowIdx: number): void => {
    if (st.capture.kind !== "idle") {
      // activating another row cancels the capture (the same row keeps it)
      if (st.capture.cat !== activeCat() || st.capture.row !== rowIdx) cancelCapture();
      return;
    }
    const row = rowsOf(activeCat())[rowIdx];
    if (!row) return;
    // headers collapse/expand in place (enter toggles; ←/→ handled in adjust)
    if (row.kind === "header") {
      toggleSection(sectionKey(headerOf(activeCat()), row.label));
      return;
    }
    if (row.kind === "toggle") {
      try {
        applyAdjust(row, 1);
        afterAdjust(rowIdx, row);
      } catch (err) {
        ctx.log?.(`plugin row "${row.label}" threw: ${errMessage(err)}`);
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
      // invokeIsolated also catches async run() rejections a bare
      // try/catch misses.
      if (row.keepOpen) {
        invokeIsolated(
          () => row.run(),
          (err) => ctx.log?.(`plugin row "${row.label}" threw: ${errMessage(err)}`),
        );
        renderMenuContent();
      } else {
        closeMenu();
        invokeIsolated(
          () => row.run(),
          (err) => ctx.log?.(`plugin row "${row.label}" threw: ${errMessage(err)}`),
        );
      }
      return;
    }
    try {
      applyAdjust(row, 1);
    } catch (err) {
      ctx.log?.(`plugin row "${row.label}" threw: ${errMessage(err)}`);
      return;
    }
    afterAdjust(rowIdx, row);
  };

  // toggles the help view: F1 from anywhere (grid, or inside the menu),
  // esc on the root row, or the Help row itself
  const toggleHelp = (): void => {
    if (menuView === "help") closeMenu();
    else {
      if (!menuOpen) openMenu();
      enterView("help");
    }
  };

  const menuActivate = () => {
    // the static views are cursorless — enter is a no-op
    if (isStaticView()) return;
    if (inPanelView()) {
      if (st.focus.kind === "cat") {
        switchCategory(activeCat());
        return;
      }
      rowActivate(activeRow() ?? -1);
      return;
    }
    const items = rootMenuItems();
    const it = items[activeItem()];
    if (!it) return;
    if (it.keepOpen) {
      it.action();
      return;
    }
    closeMenu();
    it.action();
  };

  const menuTab = (): void => {
    if (!inPanelView() || st.capture.kind !== "idle") return;
    // the pane that owns the focus IS the focus's kind — the row the rows
    // pane had is remembered, so Tab back restores it
    if (st.focus.kind === "row") st.focus = { kind: "cat", cat: st.focus.cat, row: st.focus.row };
    else if (st.focus.kind === "cat") st.focus = { kind: "row", cat: st.focus.cat, row: st.focus.row };
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

  // A mid-rebuild throw after destroyChildren leaves the panel EMPTY — to the
  // user the floating UI just "vanishes". Guard the rebuild: log the failure
  // and retry once (deferred, so a transient native alloc hiccup recovers).
  // A failed retry does NOT reschedule — under sustained memory pressure
  // (see the OOM note in AGENTS.md) infinite retries just amplify it.
  let retryArmed = true;
  let warnedThisBurst = false;
  const renderMenuContent = () => {
    const c = ctx.colors();
    const panel = ctx.byId("tfm-menu-panel");
    if (!panel) return;
    try {
      ctx.destroyChildren(panel);
      buildMenuContent(c, panel, menuView);
      retryArmed = true; // a successful build re-arms the one-shot retry
      warnedThisBurst = false;
    } catch (err) {
      logRenderFailure(err);
      if (retryArmed) {
        retryArmed = false;
        setTimeout(() => renderMenuContent(), 120);
      } else if (!warnedThisBurst) {
        // retry exhausted: the panel sits empty — say so once instead of a
        // silent blank menu (neutral wording: only the debug log names OOM)
        warnedThisBurst = true;
        try {
          ctx.warn("Menu render failed · try again", "menu");
        } catch {}
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

  const buildMenuContent = (c: Theme, panel: NodeLike, view: "root" | "settings" | "plugins" | "help" | "about") => {
    menuC = c;
    const panelView = view !== "root";
    // the root rows are rebuilt from scratch here: drop the previous build's
    // icon specs so a stale one can never be flipped by a later repaint
    rootSpecs.length = 0;
    // the help view uses its own wide poster width, about its narrow brand
    // width; settings/plugins fill the terminal the same way
    // (settingsPanelWidth clamps small terminals)
    const panelW =
      view === "help"
        ? helpPanelWidth(ctx.renderer().terminalWidth)
        : view === "about"
          ? aboutPanelWidth(ctx.renderer().terminalWidth)
          : panelView
            ? settingsPanelWidth(ctx.renderer().terminalWidth)
            : ctx.menuW();
    try {
      panel.width = panelW;
    } catch {}

    panel.add(
      Box(
        { width: "100%", height: 1, flexDirection: "row", alignItems: "center", paddingLeft: 2, paddingRight: 1 },
        Text({
          content:
            view === "plugins"
              ? "Menu · plugins"
              : view === "settings"
                ? "Menu · settings"
                : view === "help"
                  ? "Menu · help"
                  : view === "about"
                    ? "Menu · about"
                    : "Menu",
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
      const hoverSelect = (index: number) => () => {
        // position truth (pointer) before change truth (highlight): the
        // keyboard cursor may already sit here, in which case no repaint
        // runs but the shape must still set
        ctx.setPointer?.("pointer");
        if (activeItem() === index) return;
        const prev = activeItem();
        st.focus = { kind: "root", item: index };
        if (prev >= 0) paintRootAt(prev, false);
        paintRootAt(index, true);
      };
      const activateRow = (index: number) => (ev?: MouseEvent) => {
        try {
          ev?.stopPropagation?.();
        } catch {}
        st.focus = { kind: "root", item: index };
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
            // leaving the row always drops back to default; the next row's
            // move re-sets (rows have no paired guard on the way out)
            onMouseOut: () => ctx.setPointer?.("default"),
          },
          ...(icon
            ? [
                (() => {
                  const slot = ctx.makeIconSlot(
                    icon,
                    [
                      { fg: c.white, bg: active ? c.accentBg : c.sidebarBg },
                      { fg: c.white, bg: c.accentBg },
                    ],
                    1,
                    active ? IconStateIdx.Active : IconStateIdx.Rest,
                  );
                  rootSpecs[index] = slot.spec;
                  return slot.el;
                })(),
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
        panel.add(rootRow(it.icon, it.label, it.hint, i === activeItem(), i, activateRow(i)));
      });
    } else if (view === "help") {
      // static cheat sheet (no cursor, no settings rows) in a bounded
      // scroller — wheel scrolls natively, arrows drive it from moveMenu
      renderHelpPanel(c, panel, {
        keybinds: (a) => ctx.keybinds?.(a) ?? [],
        renderer: ctx.renderer,
        termH: () => ctx.renderer().terminalHeight,
      });
    } else if (view === "about") {
      // drillable brand block (no cursor — rows drive via mouse only)
      renderAboutPanel(c, panel, {
        renderer: ctx.renderer,
        makeIconSlot: ctx.makeIconSlot,
        onOpenUrl: (url) => ctx.openUrl?.(url),
        updateValue: () => ctx.updateValue?.() ?? "check for updates",
        updateActionable: () => ctx.updateActionable?.() ?? false,
        onCheckUpdates: () => ctx.onCheckUpdates?.(),
        detail: aboutDetail,
        onOpenDetail: () => {
          aboutDetail = "credits";
          renderMenuContent();
        },
        onBack: () => {
          aboutDetail = null;
          renderMenuContent();
        },
        setPointer: ctx.setPointer,
      });
    } else {
      // clamp the state against the CURRENT group list BEFORE the render (a
      // plugin rescan can shrink the categories — the old cursor pointed past
      // the end and the right pane rendered empty)
      clampPanelState();
      // the panel's read-only LIVE view of the shell's state: the getters
      // read the CURRENT values, so a handler that runs after a rebuild sees
      // the truth, not a stale snapshot
      const view: SettingsPanelView = {
        get focus() {
          return st.focus;
        },
        get hoverCat() {
          return st.hoverCat;
        },
        get scrollOff() {
          return st.scrollOff;
        },
        get collapsed() {
          return st.collapsed;
        },
        get capture() {
          return st.capture;
        },
      };
      // the category specs are rebuilt with the panel — drop the old ones
      catSpecs.length = 0;
      renderSettingsPanel(
        c,
        panel,
        view,
        {
          groups,
          visRows: visibleRows,
          setOnId,
          makeIconSlot: ctx.makeIconSlot,
          setIconState: ctx.setIconState,
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
          focusRow,
          hoverCat: hoverCatAt,
          scrollRows,
          registerCatSpec: (gi, spec) => {
            catSpecs[gi] = spec;
          },
          log: (message) => ctx.log?.(message),
          setPointer: ctx.setPointer,
        },
        panelW,
      );
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
    // reset the view or toggleHelp's `menuView === "help"` check sticks after
    // close and the next F1 takes the close branch (a no-op) instead of
    // reopening
    menuView = "root";
    // ONE reset: the focus, the mouse hover, the window offset + the capture
    // (a closed panel's hover must not survive into the next open — the
    // mouse is somewhere else now)
    resetViewState();
    aboutDetail = null;
    ctx.log?.("esc-menu close");
    // hovered rows have no out (their nodes are gone) — restore here or the
    // pointer sticks (same stale-until-move rule as the highlight paint)
    ctx.setPointer?.("default");
    nativeMemTrace("esc-menu close");
    const scrim = ctx.byId("tfm-menu");
    scrim?.parent?.remove(scrim);
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
    // ONE reset: the focus (the root opens with NO cursor), the mouse hover,
    // the window offset + the capture
    resetViewState();
    aboutDetail = null;
    restartWarned.clear();
    ctx.log?.("esc-menu open");
    nativeMemTrace("esc-menu open");
    ctx.cancelBand();
    const scrim = makeModalScrim(
      { uiStyle: ctx.uiStyle, colors: ctx.colors },
      {
        id: "tfm-menu",
        zIndex: FLOAT_Z.escmenu,
        panelWidth: ctx.menuW(),
        // mouse-first: first outside click cancels an in-flight capture, the
        // next one dismisses the menu
        onClose: () => {
          if (!cancelCapture()) closeMenu();
        },
        // empty-panel click (not a row, not the scrim): cancel an in-flight
        // capture — the scrim handler never sees inside clicks (the panel
        // stops propagation), so this is the only path for it
        panelMouseDown: () => {
          if (st.capture.kind !== "idle") cancelCapture();
        },
      },
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

  // the help view is cursorless but scrollable: arrows move the viewport
  // (the cursor stays empty, there is still no cursor), the wheel scrolls natively
  const scrollHelp = (delta: number): void => {
    const scroller = ctx.byId("tfm-help-scroll");
    if (!scroller || scroller.isDestroyed) return;
    try {
      scroller.scrollTop = Math.max(0, (scroller.scrollTop ?? 0) + delta);
    } catch {}
  };

  const moveMenu = (delta: number) => {
    // the help view is cursorless — ↑/↓ scroll the body instead of a cursor;
    // the about view fits its panel, so arrows are a plain no-op there
    if (isHelpView()) {
      scrollHelp(delta * 3);
      return;
    }
    if (isAboutView()) return;
    if (!inPanelView()) {
      const count = rootMenuItems().length;
      if (count === 0) return;
      const prev = activeItem();
      // no cursor yet: down fills the first row, up the last
      const now = cursorIndex(advanceCursor(cursorAt(prev), delta, count));
      st.focus = { kind: "root", item: now };
      // the root rows are already on screen: repaint the two rows in place.
      // A rebuild per keypress churned ~20 native nodes for nothing.
      if (prev >= 0 && prev !== now) paintRootAt(prev, false);
      paintRootAt(now, true);
      return;
    }
    if (st.focus.kind === "cat") {
      switchCategory(activeCat() + delta);
      return;
    }
    const flat = visOf(activeCat());
    if (!flat.length) return;
    // NO cursor yet: down fills the first VISIBLE row, up the last.
    // Headers take the cursor (they collapse/expand); hidden children are
    // stepped over because the walk stays inside the visible projection.
    // flat is non-empty (checked above); bind head/tail once so the walk needs
    // no assertions, and an impossible empty projection simply no-ops
    const first = flat[0];
    const last = flat[flat.length - 1];
    if (first === undefined || last === undefined) return;
    const prev = activeRow();
    const now =
      prev === null || !flat.includes(prev)
        ? delta >= 0
          ? first
          : last
        : (flat[(visiblePos(flat, prev) + delta + flat.length) % flat.length] ?? first);
    st.focus = { kind: "row", cat: activeCat(), row: now };
    const prevScroll = st.scrollOff;
    st.scrollOff = scrollFor(visibleRows(), flat.length, visiblePos(flat, now), st.scrollOff);
    paintDesc(fitDescText(descText(rowsOf(activeCat())[now]), settingsPanelWidth(ctx.renderer().terminalWidth)));
    // Moving the cursor is a REPAINT, not a rebuild: the rows are already on
    // screen. Rebuilding them per keypress churned ~60 native nodes (one
    // TextBuffer each) — at 30 key repeats/s that is ~1800 allocations/s,
    // which piles up until the allocator fails ("the menu vanishes") and
    // burns a core (the "very slow and laggy" report in issue #6). Only a
    // SCROLL needs new rows: the visible window moved, so rebuild then.
    if (st.scrollOff !== prevScroll) {
      renderMenuContent();
      return;
    }
    if (prev !== null && prev !== now) paintRowAt(prev, false);
    paintRowAt(now, true);
  };

  return {
    openMenu,
    closeMenu,
    toggleHelp,
    isOpen: (): boolean => menuOpen,
    moveMenu,
    menuActivate,
    menuTab,
    adjustSelectedSetting,
    captureKey,
    renderMenuContent,
  };
};
