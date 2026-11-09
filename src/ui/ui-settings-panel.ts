// --- Settings panel rendering: the two-pane settings VIEW (categories left,
// rows right) of the esc menu — windowed row list, chevrons, hover-by-id
// paints, wheel scroll, the keybind-capture row presentation. Split from
// ./ui-settings (which keeps the menu state machine, keyboard ops, capture
// flow and open/close): the shell owns the state, this module only renders it.
// MOUSE-FIRST: every control is clickable, rows hover-select via byId paints —
// hover must NEVER rebuild the panel (native alloc churn; see the OOM note in
// AGENTS.md). ---

import { Box, type MouseEvent, Text } from "@opentui/core";
import { errMessage } from "../lib/uiutil";
import { applyAdjust, type SettingGroup, type SettingRow } from "./settings";
import type { MakeIconSlot, SlotElement } from "./ui-slots";
import { IconStateIdx } from "../lib/icon-state";
import type { Theme } from "../config/config";
import type { NodeLike } from "../lib/node-like";
import type { PointerStyle } from "../lib/pointer";
import type { IconSpec } from "../lib/icon-state";

// WHERE the menu's focus is — ONE record, owned by the shell. Every index
// inside it has ONE meaning, named by its field:
//   `item` — a ROOT-menu row
//   `cat`  — a category of the settings/plugins panel
//   `row`  — a row WITHIN the focused category (never a bare index)
// The kind says which list the other fields index. The old code kept ONE
// `cursor` field that meant three different things (a root item, a row of
// the active category, and "unused" in the categories pane) and told them
// apart only by the view + pane — so a stale index silently changed meaning.
export type MenuFocus =
  // no cursor at all (the root menu before its first move, the static views)
  | { kind: "none" }
  // the root menu's item cursor
  | { kind: "root"; item: number }
  // the CATEGORIES pane owns the focus: `row` is the row the rows pane
  // remembers (restored when Tab returns to it), not a focused row
  | { kind: "cat"; cat: number; row: number | null }
  // the ROWS pane owns the focus: `row` is the focused row (null = none yet)
  | { kind: "row"; cat: number; row: number | null };

// the panel's READ-ONLY view of the shell's state. The renderer never
// mutates it — every change goes back through the shell's actions, so the
// shell stays the ONE owner of the panel's state.
export type SettingsPanelView = {
  readonly focus: MenuFocus;
  // the category under the mouse (paint only — hovering never switches),
  // keyed by the category's IDENTITY (its header), never by its index: the
  // category list is rebuilt on every render and a plugin rescan can change
  // it, so an index would name a DIFFERENT category after the rebuild
  readonly hoverCat: string | null;
  // the rows pane's window offset (into the visible-row projection)
  readonly scrollOff: number;
  // collapsed subsections, keyed by sectionKey(category header, subsection)
  readonly collapsed: ReadonlySet<string>;
  // keybind capture: the row being recorded + the pending swap offer
  readonly capturing: number | null;
  readonly swapOffer: { spec: string; ownerLabel: string } | null;
};

// the keybind-conflict swap offer, painted in the footer AND the capturing
// row's value cell (same string both places, so one helper, not two literals)
export const swapOfferText = (spec: string, ownerLabel: string): string => `"${spec}" is ${ownerLabel}, swap?`;

type SettingsPanelHooks = {
  groups(): SettingGroup[];
  // visible row count for the right pane (panel chrome takes ~6 rows)
  visRows(): number;
  setOnId(id: string, fn: (n: NodeLike) => void): void;
  makeIconSlot: MakeIconSlot;
  // flip a slot's pre-rastered state (visibility only, no rebuild) — used by
  // the category hover highlight
  setIconState(spec: IconSpec, stateIdx: number): void;
  // repaint ONE category's highlight by id (bg only) — never a rebuild
  paintCatAt(gi: number, on: boolean): void;
  // shell ops — the panel's handlers route back through the state machine
  switchCategory(gi: number): void;
  cancelCapture(): boolean;
  rowActivate(rowIdx: number): void;
  afterAdjust(index: number, row: SettingRow): void;
  paintRowAt(idx: number, on: boolean): void;
  // full panel rebuild (wheel scroll, category click) — shell's guarded one
  rebuild(): void;
  // collapsible sections (shell owns the collapsed set on panel state)
  isCollapsed(key: string): boolean;
  toggleSection(key: string): void;
  // live description-footer repaint (by id, never a rebuild)
  paintDesc(text: string): void;
  // --- the shell's actions (the panel NEVER mutates the state) ---
  // focus a row (mouse hover / click) — returns true when the focus MOVED
  focusRow(index: number): boolean;
  // the category under the mouse (paint only) — null clears it. The key is
  // the category's IDENTITY (its header), never its index.
  hoverCat(key: string | null): void;
  // scroll the rows pane (the wheel) — the shell owns the offset
  scrollRows(delta: number): void;
  // register a category's icon spec so the shell can flip its raster state
  // (the category hover paints bg + icon together — one owner)
  registerCatSpec(gi: number, spec: IconSpec): void;
  // mouse pointer shape (OSC 22 via the wiring's tty-guarded setter).
  // Absent = no pointer changes. Repeat-safe: the setter dedupes.
  setPointer?(style: PointerStyle): void;
  // debug sink for a throwing plugin row reached from a panel handler (the
  // shell wires dlog); optional so panel tests stay sink-free
  log?(message: string): void;
};

// settings panel is wider than the root menu (categories + value columns +
// the one-line description footer) and adapts to the terminal like the help
// view (HELP_W in ./ui-help). Capped at 80: every real label + value fits in
// that (the old 100 pooled ~20 dead cells in the middle spacer).
export const SETTINGS_MAX_W = 80;
const SETTINGS_MIN_W = 64;
export const settingsPanelWidth = (termW: number): number =>
  Math.min(SETTINGS_MAX_W, Math.max(SETTINGS_MIN_W, termW - 4));

const CAT_W = 20;
// value-box widths (text room = box - 1 for the paddingRight); the shell's
// afterAdjust re-slices to the same text widths, so they live here exported
export const SET_VAL_W = 16;
export const SET_KEY_W = 24;

// column widths derived from the live panel width so extra room widens the
// label column instead of pooling in the middle spacer (the old fixed 22
// sliced real labels like "include filename in lift")
export const settingsWidths = (panelW: number): { rightW: number; labelW: number; valW: number; keyW: number } => {
  const rightW = panelW - CAT_W - 1; // minus the divider column
  return {
    rightW,
    labelW: Math.min(30, Math.max(22, panelW - 53)),
    valW: SET_VAL_W,
    keyW: SET_KEY_W,
  };
};

// right-pane window size: capped at 20 rows on roomy terminals (panel ≈ 25
// rows total with chrome + description footer); shrinks on tiny terminals.
// Categories with more rows wheel-scroll/arrow-scroll.
export const settingsVisRows = (termH: number): number => Math.min(20, Math.max(8, termH - 12));

const CAT_ICONS: Record<string, string> = {
  // fallback for groups that don't carry an explicit icon (plugins/installs
  // and older fakes); core categories set `icon` in settings-model
  "add plugins": "plus",
};

// the window offset that keeps `pos` visible (PURE — the shell owns the
// offset, the panel only reads it). A no cursor (pos < 0) keeps the current
// offset: there is nothing to scroll to.
export const scrollFor = (vis: number, total: number, pos: number, current: number): number => {
  if (pos < 0) return current;
  let off = current;
  if (pos < off) off = pos;
  if (pos >= off + vis) off = pos - vis + 1;
  return Math.min(Math.max(0, total - vis), Math.max(0, off));
};

// --- collapsible subsections (pure projection over one category's rows) ---
// A section = a header row + the rows after it up to the next header (or the
// end). Collapsing hides the section's children; the header itself (and any
// headerless leading rows) always stays visible. Returned indices are FULL-row
// indices so node ids (tfm-set-row-<i>) and shell cursor state keep working.

export const sectionKey = (categoryHeader: string, subsection: string): string => `${categoryHeader}::${subsection}`;

export const flatVisible = (rows: SettingRow[], categoryHeader: string, collapsed: ReadonlySet<string>): number[] => {
  const out: number[] = [];
  let hidden = false;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (row === undefined) continue;
    if (row.kind === "header") {
      hidden = collapsed.has(sectionKey(categoryHeader, row.label));
      out.push(i);
    } else if (!hidden) {
      out.push(i);
    }
  }
  return out;
};

// visible-space position of a full-row index (-1 when hidden/absent)
export const visiblePos = (vis: number[], fullIdx: number): number => vis.indexOf(fullIdx);

// park a cursor full-row index on the nearest visible row after a gated
// rebuild removed rows (a master toggle hides its children): keeps the
// cursor when still visible, else the nearest visible row at or above (same
// rule as section-collapse), else the first visible row, else -1 when empty
export const clampToVisible = (vis: number[], fullIdx: number): number => {
  if (vis.includes(fullIdx)) return fullIdx;
  return [...vis].reverse().find((i) => i <= fullIdx) ?? vis[0] ?? -1;
};

// one-line description footer text for a row (plain language, never the TOML doc)
export const descText = (row: SettingRow | undefined): string => {
  if (!row) return "Choose a setting to see what it does";
  if (row.kind === "header") return "Expand or collapse this section";
  const base = row.blurb ?? row.label;
  // cold-boot-only rows carry the schema's restart flag through settings-model:
  // the footer is the persistent at-a-glance cue (it follows cursor + hover)
  return "restart" in row && row.restart ? `${base} · needs restart` : base;
};

export const fitDescText = (text: string, panelW: number = SETTINGS_MAX_W): string => `ⓘ ${text}`.slice(0, panelW - 4);

// value-cell text for every row kind (toggle/stepper/cycle/keybind): sliced to
// the text room then CENTERED. Box-level justifyContent does NOT move Text
// children (probed: a flex-end Box still paints its Text flush left), so the
// alignment is in the string itself. afterAdjust in ./ui-settings repaints the
// same cells by id and must use this too, or an adjust snaps the value back
// left. (Right-aligned was tried first and read as off against the chevrons,
// so the column centers.)
export const fitValueText = (value: string, room: number): string => {
  if (value.length >= room) return value.slice(0, room);
  const total = room - value.length;
  const left = Math.floor(total / 2);
  return " ".repeat(left) + value + " ".repeat(total - left);
};

// toggle value-box width (no padding — the text room IS the box)
export const SET_TOGGLE_W = 6;

export const renderSettingsPanel = (
  c: Theme,
  panel: NodeLike,
  view: SettingsPanelView,
  h: SettingsPanelHooks,
  panelW: number = SETTINGS_MAX_W,
) => {
  const cats = h.groups();
  const vis = h.visRows();
  const w = settingsWidths(panelW);
  // the focus snapshot for THIS build (the handlers read the live view)
  const focus = view.focus;
  // the focused category (the right pane always shows it) — the shell always
  // enters a panel view with a panel focus, so the fallback is a safe default
  const catIdx = focus.kind === "cat" || focus.kind === "row" ? focus.cat : 0;
  const header = cats[catIdx]?.header ?? "";
  const rows = cats[catIdx]?.rows ?? [];
  const flat = flatVisible(rows, header, view.collapsed);
  const canScroll = flat.length > vis;
  const wheelScroll = (ev: MouseEvent) => {
    if (!canScroll) return;
    try {
      ev.stopPropagation?.();
    } catch {}
    const d = ev.scroll?.direction === "up" ? -3 : 3;
    // the shell owns the offset (it clamps it against the CURRENT rows)
    h.scrollRows(d);
  };

  // --- left pane: categories ---
  const catPane = Box({ width: CAT_W, flexDirection: "column" });
  cats.forEach((g, gi) => {
    const active = gi === catIdx;
    // the category's identity (the hover is keyed by it, not by the index)
    const key = g.header ?? "";
    // hover is a pure highlight: it paints by id and flips the icon's
    // pre-rastered state — it NEVER switches category (the old auto-nav was
    // removed on purpose) and never rebuilds the panel.
    const hot = active || view.hoverCat === key;
    const icon = g.icon ?? CAT_ICONS[g.header ?? ""] ?? "cog";
    const slot = h.makeIconSlot(
      icon,
      // state 0 is ALWAYS the resting palette (hovering must not bake
      // accentBg into it — an unhover would then have nothing to restore)
      [
        { fg: c.white, bg: c.sidebarBg },
        { fg: c.white, bg: c.accentBg },
      ],
      1,
      hot ? IconStateIdx.Active : IconStateIdx.Rest,
    );
    // the shell owns the category hover paint (bg + icon) — it needs the
    // spec to flip the raster state
    h.registerCatSpec(gi, slot.spec);
    catPane.add(
      Box(
        {
          id: `tfm-set-cat-${gi}`,
          width: "100%",
          height: 1,
          flexDirection: "row",
          columnGap: 1,
          paddingLeft: 1,
          backgroundColor: hot ? c.accentBg : undefined,
          onMouseDown: (ev: MouseEvent) => {
            try {
              ev.stopPropagation?.();
            } catch {}
            if (view.capturing !== null) {
              h.cancelCapture();
              return;
            }
            if (catIdx !== gi) h.switchCategory(gi);
            else h.rebuild();
          },
          // move, not over (a rebuild re-fires synthetic "over" on a
          // stationary cursor and would snap the highlight back)
          onMouseMove: () => {
            // position truth (pointer) before change truth (highlight): the
            // keyboard cursor may already sit here, in which case no repaint
            // runs but the shape must still set
            h.setPointer?.("pointer");
            if (view.capturing !== null) return;
            h.hoverCat(key);
          },
          onMouseOut: () => {
            h.setPointer?.("default");
            // a late out for a category that is no longer the hovered one
            // says nothing about the current hover (the mouse already moved
            // on) — only the hovered row's out clears it
            if (view.hoverCat !== key) return;
            h.hoverCat(null);
          },
        },
        slot.el,
        Text({
          id: `tfm-set-catl-${gi}`,
          content: (g.header ?? "general").slice(0, CAT_W - 3),
          fg: c.white,
        }),
      ),
    );
  });
  panel.add(
    Box(
      {
        width: "100%",
        flexDirection: "row",
        height: Math.max(vis + 1, cats.length + 1),
        // wheel anywhere over the panel scrolls the rows pane (mouse-first)
        onMouseScroll: wheelScroll,
      },
      catPane,
      // --- right pane: rows (windowed over the visible projection) ---
      Box({ width: 1, flexDirection: "column" }),
      renderRowPane(c, rows, header, vis, view, h, panelW, w),
    ),
  );

  // one-line description footer — the selected row's blurb in plain language.
  // Painted live by id on cursor/hover moves (paintDesc), never a rebuild.
  const curRow = focus.kind === "row" ? focus.row : null;
  panel.add(
    Box(
      { width: "100%", height: 1, paddingLeft: 1, paddingRight: 1 },
      Text({
        id: "tfm-set-desc",
        content: fitDescText(
          view.swapOffer
            ? swapOfferText(view.swapOffer.spec, view.swapOffer.ownerLabel)
            : view.capturing !== null
              ? "press a key…"
              : descText(curRow === null ? undefined : rows[curRow]),
          panelW,
        ),
        fg: c.sidebarFgMuted,
      }),
    ),
  );
};

const renderRowPane = (
  c: Theme,
  rows: SettingRow[],
  categoryHeader: string,
  vis: number,
  view: SettingsPanelView,
  h: SettingsPanelHooks,
  panelW: number,
  w: ReturnType<typeof settingsWidths>,
) => {
  const flat = flatVisible(rows, categoryHeader, view.collapsed);
  const focus = view.focus;
  const canScroll = flat.length > vis;
  const start = Math.min(view.scrollOff, Math.max(0, flat.length - vis));
  const end = Math.min(flat.length, start + vis);
  const pane2 = Box({ flexGrow: 1, flexDirection: "column" });

  // shared header/value-row hover pair (identical paint block, one factory —
  // the category rows' paint differs, it stays inline)
  const rowHover = (index: number, rowSpec: SettingRow) => ({
    onMouseMove: () => {
      // position truth before change truth (see the category rows)
      h.setPointer?.("pointer");
      // while a keybind is being recorded the mouse must not steal the focus
      if (view.capturing !== null) return;
      // the shell owns the focus + the row paint (one owner)
      if (h.focusRow(index)) h.paintDesc(fitDescText(descText(rowSpec), panelW));
    },
    onMouseOut: () => {
      h.setPointer?.("default");
    },
  });

  // section header: a collapsible divider. It TAKES the cursor (keyboard users
  // collapse without a mouse) and carries the standard row ids so paintRowAt
  // highlights it like any row. The rule fills the live row width (right pane
  // minus the row's own padding), so a wider panel draws a wider rule.
  const headerNode = (rowSpec: Extract<SettingRow, { kind: "header" }>, index: number) => {
    const active = focus.kind === "row" && focus.row === index;
    const key = sectionKey(categoryHeader, rowSpec.label);
    const shut = h.isCollapsed(key);
    const lead = ` ${shut ? "▶" : "▼"} ${rowSpec.label} `;
    const leadMax = Math.max(20, w.rightW - 14);
    const shown = lead.slice(0, leadMax);
    return Box(
      {
        id: `tfm-set-row-${index}`,
        width: "100%",
        height: 1,
        flexDirection: "row",
        paddingLeft: 1,
        paddingRight: 1,
        backgroundColor: active ? c.accentBg : undefined,
        onMouseDown: (ev: MouseEvent) => {
          try {
            ev.stopPropagation?.();
          } catch {}
          if (view.capturing !== null) {
            h.cancelCapture();
            return;
          }
          h.focusRow(index);
          h.toggleSection(key);
        },
        // move, not over (same synthetic-over trap as value rows below)
        ...rowHover(index, rowSpec),
      },
      Text({
        id: `tfm-set-rowl-${index}`,
        content: shown,
        fg: active ? c.white : c.sidebarFgMuted,
      }),
      Text({ content: "─".repeat(Math.max(0, w.rightW - 2 - shown.length)), fg: c.divider }),
    );
  };

  const chevron = (dirText: "‹" | "›", active: boolean, index: number, rowSpec: SettingRow, dir: number) => {
    const tId = `tfm-chev-${index}-${dir}`;
    // the chevron follows the LIVE focus (a mouse move can move it between
    // the build and the event)
    const chevOn = (): boolean => {
      const f = view.focus;
      return f.kind === "row" && f.row === index;
    };
    return Box(
      {
        width: 2,
        justifyContent: "center",
        onMouseDown: (ev: MouseEvent) => {
          try {
            ev.stopPropagation?.();
          } catch {}
          if (view.capturing !== null) {
            h.cancelCapture();
            return;
          }
          // a throwing plugin row set()/getIdx() must not escape this mouse
          // handler (every other row path — keypress, click, stepper — guards)
          try {
            const changed = applyAdjust(rowSpec, dir);
            // the shell owns the focus + the row paint (one owner)
            const moved = h.focusRow(index);
            if (!changed && !moved) return;
            h.paintDesc(fitDescText(descText(rowSpec), panelW));
            h.afterAdjust(index, rowSpec);
          } catch (err) {
            h.log?.(`settings chevron: row threw: ${errMessage(err)}`);
          }
        },
        // move, not over (same synthetic-over trap as rows — a rebuild under
        // a stationary cursor re-fires "over" and the stale `active` capture
        // would paint the wrong state)
        onMouseMove: () => {
          h.setPointer?.("pointer");
          h.setOnId(tId, (n) => {
            n.fg = c.white;
          });
        },
        onMouseOut: () => {
          h.setPointer?.("default");
          h.setOnId(tId, (n) => {
            n.fg = chevOn() ? c.white : c.sidebarFgMuted;
          });
        },
      },
      Text({ id: tId, content: dirText, fg: active ? c.white : c.sidebarFgMuted }),
    );
  };

  const rowNode = (rowSpec: SettingRow, index: number) => {
    const active = focus.kind === "row" && focus.row === index;
    const capturingThis = view.capturing === index;
    const labelFg = c.white;
    let control: SlotElement;
    let onClick: (ev?: MouseEvent) => void = (ev?: MouseEvent) => {
      try {
        ev?.stopPropagation?.();
      } catch {}
      // the shell owns the focus + the row paint (one owner)
      h.focusRow(index);
      h.paintDesc(fitDescText(descText(rowSpec), panelW));
      h.rowActivate(index);
    };

    if (capturingThis) {
      const offer = view.swapOffer;
      control = Box(
        { flexGrow: 1 },
        Text({
          content: offer ? swapOfferText(offer.spec, offer.ownerLabel) : "press a key…",
          fg: c.accent,
        }),
      );
    } else if (rowSpec.kind === "toggle") {
      // plugin rows are validated at load, but a throwing get()/set() must not
      // brick the panel mid-render — treat a throwing row as off
      let on = false;
      try {
        on = rowSpec.get();
      } catch {}
      control = Box(
        { width: SET_TOGGLE_W, justifyContent: "flex-end" },
        Text({
          id: `tfm-set-rowv-${index}`,
          content: fitValueText(on ? "on" : "off", SET_TOGGLE_W),
          fg: active ? c.white : on ? c.accent : c.sidebarFgMuted,
        }),
      );
    } else if (rowSpec.kind === "stepper" || rowSpec.kind === "cycle") {
      let value = "";
      try {
        value =
          rowSpec.kind === "stepper"
            ? rowSpec.fmt(rowSpec.get())
            : (() => {
                const i = rowSpec.getIdx();
                return i >= 0 ? (rowSpec.names[i] ?? "?") : (rowSpec.customLabel?.() ?? "custom");
              })();
      } catch {} // a throwing plugin row renders as empty, never bricks the panel
      control = Box(
        { flexDirection: "row", alignItems: "center" },
        chevron("‹", active, index, rowSpec, -1),
        Box(
          { width: w.valW, justifyContent: "flex-end", paddingRight: 1 },
          Text({
            id: `tfm-set-rowv-${index}`,
            content: fitValueText(value, w.valW - 1),
            fg: active ? c.white : c.sidebarFgMuted,
          }),
        ),
        chevron("›", active, index, rowSpec, 1),
      );
      onClick = (ev?: MouseEvent) => {
        try {
          ev?.stopPropagation?.();
        } catch {}
        if (view.capturing !== null) {
          h.cancelCapture();
          return;
        }
        h.focusRow(index);
        try {
          applyAdjust(rowSpec, 1);
          h.afterAdjust(index, rowSpec);
        } catch {} // a throwing plugin row never breaks the click handler
        h.paintDesc(fitDescText(descText(rowSpec), panelW));
      };
    } else if (rowSpec.kind === "keybind") {
      let binds: string[] = [];
      try {
        binds = rowSpec.get();
      } catch {}
      const shownBinds = binds.length ? binds.join(" / ") : "unset";
      control = Box(
        { width: w.keyW, justifyContent: "flex-end", paddingRight: 1 },
        Text({
          id: `tfm-set-rowv-${index}`,
          content: fitValueText(shownBinds, w.keyW - 1),
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
        // move, not over: a rebuild (arrow-key nav) makes OpenTUI re-fire
        // synthetic "over" for the row under a stationary mouse, snapping the
        // cursor back. Real motion dispatches "move".
        ...rowHover(index, rowSpec),
      },
      Text({
        id: `tfm-set-rowl-${index}`,
        content: ` ${rowSpec.label.slice(0, w.labelW).padEnd(w.labelW)}`,
        fg: labelFg,
      }),
      Box({ flexGrow: 1 }),
      control,
    );
  };

  for (let p = start; p < end; p++) {
    const i = flat[p];
    if (i === undefined) continue;
    const rowSpec = rows[i];
    if (rowSpec) pane2.add(rowSpec.kind === "header" ? headerNode(rowSpec, i) : rowNode(rowSpec, i));
  }
  // simple scroll hint (like the F1 help footer), shown only when the list
  // actually overflows the window — a short or fully-folded list stays clean
  if (canScroll) {
    pane2.add(
      Box(
        { width: "100%", height: 1, justifyContent: "center" },
        Text({ content: "↑/↓ or wheel to scroll", fg: c.sidebarFgMuted }),
      ),
    );
  }
  return pane2;
};
