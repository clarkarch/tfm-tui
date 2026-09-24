// --- Settings panel rendering: the two-pane settings VIEW (categories left,
// rows right) of the esc menu — windowed row list, chevrons, hover-by-id
// paints, wheel scroll, the keybind-capture row presentation. Split from
// ./ui-settings (which keeps the menu state machine, keyboard ops, capture
// flow and open/close): the shell owns the state, this module only renders it.
// MOUSE-FIRST: every control is clickable, rows hover-select via byId paints —
// hover must NEVER rebuild the panel (native alloc churn; see the OOM note in
// AGENTS.md). ---

import { Box, type MouseEvent, Text } from "@opentui/core";
import { applyAdjust, type SettingGroup, type SettingRow } from "./settings";
import { IconStateIdx, type IconSlotHandle, type IconState, type IconSpec, type SlotElement } from "./ui-slots";
import type { Theme } from "../config/config";
import type { NodeLike } from "../lib/node-like";

export type SettingsPanelState = {
  catIdx: number;
  menuIdx: number; // row cursor within the ACTIVE category (full-row index, never a hidden one)
  pane: "cats" | "rows";
  scrollOff: number; // offset into the VISIBLE-row projection (see flatVisible), not the full rows array
  // category currently under the mouse (highlight only — hovering never
  // switches categories, that auto-nav was removed); -1 = none
  hoverCat: number;
  // keybind capture: flat row index within the active category being recorded
  capturing: number | null;
  // collapsed subsections, keyed by sectionKey(category header, subsection)
  // — session-only, never persisted to config.toml
  collapsed: Set<string>;
};

type SettingsPanelHooks = {
  groups(): SettingGroup[];
  // visible row count for the right pane (panel chrome takes ~6 rows)
  visRows(): number;
  setOnId(id: string, fn: (n: NodeLike) => void): void;
  makeIconSlot(
    name: string,
    states: IconState[],
    heightCells?: number,
    initialState?: number,
  ): IconSlotHandle;
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
  // debug sink for a throwing plugin row reached from a panel handler (the
  // shell wires dlog); optional so panel tests stay sink-free
  log?(message: string): void;
};

// settings panel is wider than the root menu (categories + value columns +
// the one-line description footer)
export const SETTINGS_W = 78;
const CAT_W = 20;
const SET_LABEL_W = 22;

// right-pane window size: capped at 18 rows on roomy terminals (panel ≈ 25
// rows total with chrome + description footer); shrinks on tiny terminals.
// Categories with more rows wheel-scroll/arrow-scroll.
export const settingsVisRows = (termH: number): number => Math.min(18, Math.max(8, termH - 14));

const CAT_ICONS: Record<string, string> = {
  // fallback for groups that don't carry an explicit icon (plugins/installs
  // and older fakes); core categories set `icon` in settings-model
  "add plugins": "plus",
};

export const ensureVisible = (st: SettingsPanelState, vis: number, total: number, pos: number): void => {
  // no cursor yet (freshly opened) or cursor on a now-hidden row — nothing to scroll to
  if (pos < 0) return;
  if (pos < st.scrollOff) st.scrollOff = pos;
  if (pos >= st.scrollOff + vis) st.scrollOff = pos - vis + 1;
  st.scrollOff = Math.min(Math.max(0, total - vis), Math.max(0, st.scrollOff));
};

// --- collapsible subsections (pure projection over one category's rows) ---
// A section = a header row + the rows after it up to the next header (or the
// end). Collapsing hides the section's children; the header itself (and any
// headerless leading rows) always stays visible. Returned indices are FULL-row
// indices so node ids (tfm-set-row-<i>) and shell cursor state keep working.

export const sectionKey = (categoryHeader: string, subsection: string): string => `${categoryHeader}::${subsection}`;

export const flatVisible = (rows: SettingRow[], categoryHeader: string, collapsed: Set<string>): number[] => {
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

// one-line description footer text for a row (plain language, never the TOML doc)
export const descText = (row: SettingRow | undefined): string => {
  if (!row) return "Choose a setting to see what it does";
  if (row.kind === "header") return "Expand or collapse this section";
  return row.blurb ?? row.label;
};

export const fitDescText = (text: string): string => `ⓘ ${text}`.slice(0, SETTINGS_W - 4);

export const renderSettingsPanel = (c: Theme, panel: NodeLike, st: SettingsPanelState, h: SettingsPanelHooks) => {
  const cats = h.groups();
  const vis = h.visRows();
  const header = cats[st.catIdx]?.header ?? "";
  const rows = cats[st.catIdx]?.rows ?? [];
  const flat = flatVisible(rows, header, st.collapsed);
  ensureVisible(st, vis, flat.length, st.menuIdx < 0 ? -1 : visiblePos(flat, st.menuIdx));
  const canScroll = flat.length > vis;
  const wheelScroll = (ev: MouseEvent) => {
    if (!canScroll) return;
    try {
      ev.stopPropagation?.();
    } catch {}
    const d = ev.scroll?.direction === "up" ? -3 : 3;
    const max = Math.max(0, flat.length - vis);
    const next = Math.min(max, Math.max(0, st.scrollOff + d));
    if (next !== st.scrollOff) {
      st.scrollOff = next;
      h.rebuild();
    }
  };

  // --- left pane: categories ---
  const catPane = Box({ width: CAT_W, flexDirection: "column" });
  const catSpecs: IconSpec[] = [];
  cats.forEach((g, gi) => {
    const active = gi === st.catIdx;
    // hover is a pure highlight: it paints by id and flips the icon's
    // pre-rastered state — it NEVER switches category (the old auto-nav was
    // removed on purpose) and never rebuilds the panel.
    const hot = active || st.hoverCat === gi;
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
    catSpecs.push(slot.spec);
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
            if (st.capturing !== null) {
              h.cancelCapture();
              return;
            }
            if (st.catIdx !== gi) h.switchCategory(gi);
            else h.rebuild();
          },
          // move, not over (a rebuild re-fires synthetic "over" on a
          // stationary cursor and would snap the highlight back)
          onMouseMove: () => {
            if (st.capturing !== null || st.hoverCat === gi) return;
            const prev = st.hoverCat;
            st.hoverCat = gi;
            if (prev >= 0) {
              h.paintCatAt(prev, false);
              const prevSpec = catSpecs[prev];
              if (prevSpec) h.setIconState(prevSpec, IconStateIdx.Rest);
            }
            h.paintCatAt(gi, true);
            h.setIconState(slot.spec, IconStateIdx.Active);
          },
          onMouseOut: () => {
            if (st.hoverCat !== gi) return;
            st.hoverCat = -1;
            h.paintCatAt(gi, false);
            h.setIconState(slot.spec, active ? IconStateIdx.Active : IconStateIdx.Rest);
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
      renderRowPane(c, rows, header, vis, st, h),
    ),
  );

  // one-line description footer — the selected row's blurb in plain language.
  // Painted live by id on cursor/hover moves (paintDesc), never a rebuild.
  panel.add(
    Box(
      { width: "100%", height: 1, paddingLeft: 1, paddingRight: 1 },
      Text({
        id: "tfm-set-desc",
        content: fitDescText(
          st.capturing !== null ? "press a key…" : descText(st.menuIdx < 0 ? undefined : rows[st.menuIdx]),
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
  st: SettingsPanelState,
  h: SettingsPanelHooks,
) => {
  const flat = flatVisible(rows, categoryHeader, st.collapsed);
  ensureVisible(st, vis, flat.length, st.menuIdx < 0 ? -1 : visiblePos(flat, st.menuIdx));
  const canScroll = flat.length > vis;
  const start = Math.min(st.scrollOff, Math.max(0, flat.length - vis));
  const end = Math.min(flat.length, start + vis);
  const collapsedHidden = rows.length - flat.length;
  const pane2 = Box({ flexGrow: 1, flexDirection: "column" });

  // section header: a collapsible divider. It TAKES the cursor (keyboard users
  // collapse without a mouse) and carries the standard row ids so paintRowAt
  // highlights it like any row.
  const headerNode = (rowSpec: Extract<SettingRow, { kind: "header" }>, index: number) => {
    const active = st.pane === "rows" && st.menuIdx === index;
    const key = sectionKey(categoryHeader, rowSpec.label);
    const shut = h.isCollapsed(key);
    const lead = ` ${shut ? "▶" : "▼"} ${rowSpec.label} `;
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
          if (st.capturing !== null) {
            h.cancelCapture();
            return;
          }
          st.menuIdx = index;
          st.pane = "rows";
          h.toggleSection(key);
        },
        // move, not over (same synthetic-over trap as value rows below)
        onMouseMove: () => {
          if (st.capturing !== null || (st.pane === "rows" && st.menuIdx === index)) return;
          const prev = st.pane === "rows" ? st.menuIdx : -1;
          st.menuIdx = index;
          st.pane = "rows";
          if (prev >= 0 && prev !== index) h.paintRowAt(prev, false);
          h.paintRowAt(index, true);
          h.paintDesc(fitDescText(descText(rowSpec)));
        },
      },
      Text({
        id: `tfm-set-rowl-${index}`,
        content: lead.slice(0, 44),
        fg: active ? c.white : c.sidebarFgMuted,
      }),
      Text({ content: "─".repeat(Math.max(0, 52 - Math.min(lead.length, 44))), fg: c.divider }),
    );
  };

  const chevron = (dirText: "‹" | "›", active: boolean, index: number, rowSpec: SettingRow, dir: number) => {
    const tId = `tfm-chev-${index}-${dir}`;
    const chevOn = (): boolean => st.pane === "rows" && st.menuIdx === index;
    return Box(
      {
        width: 2,
        justifyContent: "center",
        onMouseDown: (ev: MouseEvent) => {
          try {
            ev.stopPropagation?.();
          } catch {}
          if (st.capturing !== null) {
            h.cancelCapture();
            return;
          }
          // a throwing plugin row set()/getIdx() must not escape this mouse
          // handler (every other row path — keypress, click, stepper — guards)
          try {
            const changed = applyAdjust(rowSpec, dir);
            if (!changed && st.menuIdx === index) return;
            if (st.menuIdx !== index) {
              if (st.pane === "rows") h.paintRowAt(st.menuIdx, false);
              st.menuIdx = index;
              st.pane = "rows";
              h.paintRowAt(index, true);
            }
            h.paintDesc(fitDescText(descText(rowSpec)));
            h.afterAdjust(index, rowSpec);
          } catch (err) {
            h.log?.(`settings chevron: row threw: ${err instanceof Error ? err.message : err}`);
          }
        },
        // move, not over (same synthetic-over trap as rows — a rebuild under
        // a stationary cursor re-fires "over" and the stale `active` capture
        // would paint the wrong state)
        onMouseMove: () =>
          h.setOnId(tId, (n) => {
            n.fg = c.white;
          }),
        onMouseOut: () =>
          h.setOnId(tId, (n) => {
            n.fg = chevOn() ? c.white : c.sidebarFgMuted;
          }),
      },
      Text({ id: tId, content: dirText, fg: active ? c.white : c.sidebarFgMuted }),
    );
  };

  const rowNode = (rowSpec: SettingRow, index: number) => {
    const active = st.pane === "rows" && st.menuIdx === index;
    const capturingThis = st.capturing === index;
    const labelFg = c.white;
    let control: SlotElement;
    let onClick: (ev?: MouseEvent) => void = (ev?: MouseEvent) => {
      try {
        ev?.stopPropagation?.();
      } catch {}
      st.menuIdx = index;
      st.pane = "rows";
      h.paintDesc(fitDescText(descText(rowSpec)));
      h.rowActivate(index);
    };

    if (capturingThis) {
      control = Box({ flexGrow: 1 }, Text({ content: "press a key…", fg: c.accent }));
    } else if (rowSpec.kind === "toggle") {
      // plugin rows are validated at load, but a throwing get()/set() must not
      // brick the panel mid-render — treat a throwing row as off
      let on = false;
      try {
        on = rowSpec.get();
      } catch {}
      control = Box(
        { width: 6, justifyContent: "flex-end" },
        Text({
          id: `tfm-set-rowv-${index}`,
          content: on ? "on" : "off",
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
          { width: 13, justifyContent: "flex-end", paddingRight: 1 },
          Text({
            id: `tfm-set-rowv-${index}`,
            content: value.length > 12 ? value.slice(0, 12) : value,
            fg: active ? c.white : c.sidebarFgMuted,
          }),
        ),
        chevron("›", active, index, rowSpec, 1),
      );
      onClick = (ev?: MouseEvent) => {
        try {
          ev?.stopPropagation?.();
        } catch {}
        if (st.capturing !== null) {
          h.cancelCapture();
          return;
        }
        st.menuIdx = index;
        st.pane = "rows";
        try {
          applyAdjust(rowSpec, 1);
          h.afterAdjust(index, rowSpec);
        } catch {} // a throwing plugin row never breaks the click handler
        h.paintDesc(fitDescText(descText(rowSpec)));
      };
    } else if (rowSpec.kind === "keybind") {
      let binds: string[] = [];
      try {
        binds = rowSpec.get();
      } catch {}
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
        // move, not over: a rebuild (arrow-key nav) makes OpenTUI re-fire
        // synthetic "over" for the row under a stationary mouse, snapping the
        // cursor back. Real motion dispatches "move".
        onMouseMove: () => {
          if (st.capturing !== null || (st.pane === "rows" && st.menuIdx === index)) return;
          const prev = st.pane === "rows" ? st.menuIdx : -1;
          st.menuIdx = index;
          st.pane = "rows";
          if (prev >= 0 && prev !== index) h.paintRowAt(prev, false);
          h.paintRowAt(index, true);
          h.paintDesc(fitDescText(descText(rowSpec)));
        },
      },
      Text({
        id: `tfm-set-rowl-${index}`,
        content: ` ${rowSpec.label.slice(0, SET_LABEL_W).padEnd(SET_LABEL_W)}`,
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
  if (canScroll || collapsedHidden > 0) {
    pane2.add(
      Box(
        { width: "100%", height: 1, paddingLeft: 1 },
        Text({
          content: `${start + 1}-${end} of ${flat.length}${collapsedHidden > 0 ? ` · ${collapsedHidden} collapsed` : ""}`,
          fg: c.sidebarFgMuted,
        }),
      ),
    );
  }
  return pane2;
};
