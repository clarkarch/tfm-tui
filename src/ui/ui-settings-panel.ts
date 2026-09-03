// --- Settings panel rendering: the two-pane settings VIEW (categories left,
// rows right) of the esc menu — windowed row list, chevrons, hover-by-id
// paints, wheel scroll, the keybind-capture row presentation. Split from
// ./ui-settings (which keeps the menu state machine, keyboard ops, capture
// flow and open/close): the shell owns the state, this module only renders it.
// MOUSE-FIRST: every control is clickable, rows hover-select via byId paints —
// hover must NEVER rebuild the panel (native alloc churn; see the OOM note in
// AGENTS.md). ---

import { Box, Text } from "@opentui/core";
import { applyAdjust, type SettingGroup, type SettingRow } from "./settings";
import type { IconState, IconSpec } from "./ui-slots";
import type { Theme } from "../config/config";

export type SettingsPanelState = {
  catIdx: number;
  menuIdx: number; // row cursor within the ACTIVE category
  pane: "cats" | "rows";
  scrollOff: number;
  hoverCat: number;
  // keybind capture: flat row index within the active category being recorded
  capturing: number | null;
};

export type SettingsPanelHooks = {
  groups(): SettingGroup[];
  // visible row count for the right pane (panel chrome takes ~6 rows)
  visRows(): number;
  setOnId(id: string, fn: (n: any) => void): void;
  makeIconSlot(
    name: string,
    states: IconState[],
    heightCells?: number,
    initialState?: number,
  ): { el: any; slotId: string; spec: IconSpec };
  // shell ops — the panel's handlers route back through the state machine
  switchCategory(gi: number): void;
  cancelCapture(): boolean;
  rowActivate(rowIdx: number): void;
  afterAdjust(index: number, row: SettingRow): void;
  paintRowAt(idx: number, on: boolean): void;
  // full panel rebuild (wheel scroll, category click) — shell's guarded one
  rebuild(): void;
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

export const ensureVisible = (st: SettingsPanelState, vis: number): void => {
  if (st.menuIdx < st.scrollOff) st.scrollOff = st.menuIdx;
  if (st.menuIdx >= st.scrollOff + vis) st.scrollOff = st.menuIdx - vis + 1;
  if (st.scrollOff < 0) st.scrollOff = 0;
};

export const renderSettingsPanel = (c: Theme, panel: any, st: SettingsPanelState, h: SettingsPanelHooks) => {
  const cats = h.groups();
  ensureVisible(st, h.visRows());
  const vis = h.visRows();
  const rows = cats[st.catIdx]?.rows ?? [];
  const canScroll = rows.length > vis;
  const wheelScroll = (ev: any) => {
    if (!canScroll) return;
    try {
      ev.stopPropagation?.();
    } catch {}
    const d = ev.scroll?.direction === "up" ? -3 : 3;
    const max = Math.max(0, rows.length - vis);
    const next = Math.min(max, Math.max(0, st.scrollOff + d));
    if (next !== st.scrollOff) {
      st.scrollOff = next;
      h.rebuild();
    }
  };

  // --- left pane: categories ---
  // hover does NOT rebuild the panel — it paints the category via byId
  // (full rebuilds on every mouseover churned native Text/icon buffers
  // hard enough that the panel could fail mid-rebuild and vanish)
  const catPane = Box({ width: CAT_W, flexDirection: "column" });
  cats.forEach((g, gi) => {
    const active = gi === st.catIdx;
    const icon = CAT_ICONS[g.header ?? ""] ?? "cog";
    const paintCat = (hover: boolean) => {
      h.setOnId(`tfm-set-cat-${gi}`, (n) => {
        n.backgroundColor = active ? c.accentBg : hover ? c.hoverBg : undefined;
      });
      h.setOnId(`tfm-set-catl-${gi}`, (n) => {
        n.fg = active || hover ? c.white : c.sidebarFg;
      });
    };
    catPane.add(
      Box(
        {
          id: `tfm-set-cat-${gi}`,
          width: "100%",
          height: 1,
          flexDirection: "row",
          columnGap: 1,
          paddingLeft: 1,
          backgroundColor: active ? c.accentBg : undefined,
          onMouseDown: (ev: any) => {
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
          onMouseOver: () => {
            if (st.hoverCat !== gi) {
              st.hoverCat = gi;
              paintCat(true);
            }
          },
          onMouseOut: () => {
            if (st.hoverCat === gi) {
              st.hoverCat = -1;
              paintCat(false);
            }
          },
        },
        h.makeIconSlot(
          icon,
          [
            { fg: c.sidebarFg, bg: active ? c.accentBg : c.sidebarBg },
            { fg: c.white, bg: c.accentBg },
          ],
          1,
          active ? 1 : 0,
        ).el,
        Text({
          id: `tfm-set-catl-${gi}`,
          content: (g.header ?? "general").slice(0, CAT_W - 3),
          fg: active ? c.white : c.sidebarFg,
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
      // --- right pane: rows (windowed) ---
      Box({ width: 1, flexDirection: "column" }),
      renderRowPane(c, rows, vis, st, h),
    ),
  );

  // footer hints — pane- and state-aware
  const hint =
    st.capturing !== null
      ? "press a key…  esc/enter/click = cancel"
      : st.pane === "cats"
        ? "click or enter selects · ←→ · tab = rows"
        : `↑↓ move · ←→ adjust${canScroll ? " · wheel scrolls" : ""} · tab = categories`;
  panel.add(Box({ width: "100%", height: 1 }));
  panel.add(
    Box(
      { width: "100%", height: 1, paddingLeft: 1, paddingRight: 1 },
      Text({ content: hint.slice(0, SETTINGS_W - 2), fg: c.sidebarFgMuted }),
    ),
  );
};

const renderRowPane = (c: Theme, rows: SettingRow[], vis: number, st: SettingsPanelState, h: SettingsPanelHooks) => {
  ensureVisible(st, vis);
  const canScroll = rows.length > vis;
  const end = Math.min(rows.length, st.scrollOff + vis);
  const pane2 = Box({ flexGrow: 1, flexDirection: "column" });

  const chevron = (dirText: "‹" | "›", active: boolean, index: number, rowSpec: SettingRow, dir: number) => {
    const tId = `tfm-chev-${index}-${dir}`;
    return Box(
      {
        width: 2,
        justifyContent: "center",
        onMouseDown: (ev: any) => {
          try {
            ev.stopPropagation?.();
          } catch {}
          if (st.capturing !== null) {
            h.cancelCapture();
            return;
          }
          const changed = applyAdjust(rowSpec, dir);
          if (!changed && st.menuIdx === index) return;
          if (st.menuIdx !== index) {
            if (st.pane === "rows") h.paintRowAt(st.menuIdx, false);
            st.menuIdx = index;
            st.pane = "rows";
            h.paintRowAt(index, true);
          }
          h.afterAdjust(index, rowSpec);
        },
        onMouseOver: () =>
          h.setOnId(tId, (n) => {
            n.fg = c.white;
          }),
        onMouseOut: () =>
          h.setOnId(tId, (n) => {
            n.fg = active ? c.white : c.sidebarFgMuted;
          }),
      },
      Text({ id: tId, content: dirText, fg: active ? c.white : c.sidebarFgMuted }),
    );
  };

  const rowNode = (rowSpec: SettingRow, index: number) => {
    const active = st.pane === "rows" && st.menuIdx === index;
    const capturingThis = st.capturing === index;
    const labelFg = active ? c.white : c.sidebarFg;
    let control: any;
    let onClick: (ev?: any) => void = (ev?: any) => {
      try {
        ev?.stopPropagation?.();
      } catch {}
      st.menuIdx = index;
      h.rowActivate(index);
    };

    if (capturingThis) {
      control = Box({ flexGrow: 1 }, Text({ content: "press a key…", fg: c.accent }));
    } else if (rowSpec.kind === "toggle") {
      const on = rowSpec.get();
      control = Box(
        { width: 6, justifyContent: "flex-end" },
        Text({ id: `tfm-set-rowv-${index}`, content: on ? "on" : "off", fg: on ? c.accent : c.sidebarFgMuted }),
      );
    } else if (rowSpec.kind === "stepper" || rowSpec.kind === "cycle") {
      const value =
        rowSpec.kind === "stepper"
          ? rowSpec.fmt(rowSpec.get())
          : (() => {
              const i = rowSpec.getIdx();
              return i >= 0 ? (rowSpec.names[i] ?? "?") : "custom";
            })();
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
        try {
          ev?.stopPropagation?.();
        } catch {}
        if (st.capturing !== null) {
          h.cancelCapture();
          return;
        }
        st.menuIdx = index;
        st.pane = "rows";
        applyAdjust(rowSpec, 1);
        h.afterAdjust(index, rowSpec);
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
          if (st.capturing !== null || (st.pane === "rows" && st.menuIdx === index)) return;
          const prev = st.pane === "rows" ? st.menuIdx : -1;
          st.menuIdx = index;
          st.pane = "rows";
          if (prev >= 0 && prev !== index) h.paintRowAt(prev, false);
          h.paintRowAt(index, true);
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

  for (let i = st.scrollOff; i < end; i++) {
    const rowSpec = rows[i];
    if (rowSpec) pane2.add(rowNode(rowSpec, i));
  }
  if (canScroll) {
    pane2.add(
      Box(
        { width: "100%", height: 1, paddingLeft: 1 },
        Text({
          content: `${st.scrollOff + 1}-${end} of ${rows.length}`,
          fg: c.sidebarFgMuted,
        }),
      ),
    );
  }
  return pane2;
};
