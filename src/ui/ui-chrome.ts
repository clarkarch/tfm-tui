import { Box, Text } from "@opentui/core";
import { spawn } from "node:child_process";
import path from "node:path";
import { clearChildren } from "./uiutil";
import { applySurface, rowSurface, slotBg, tileSurface } from "./style";
import { buildSections, loadSystemPlaces, type Place } from "../fs/places";
import { trashDir } from "../fs/fsutil";
import { RECENT_URI, STARRED_URI } from "../fs/uri";
import { tabTitle, type Tab } from "../app/tabs";
import { gridDrag, type ClipItem } from "../input/grid-input";
import { IconStateIdx, selectIconState } from "./ui-slots";
import type { Theme } from "../config/config";
import type { ListEntry } from "./ui-menu";

// --- Places sidebar rows + tab strip + divider — rebuilt from scratch each
// render; ctx-seamed like ui-term. tfm-* ids (tfm-place-N / tfm-place-N-label
// / tfm-tab-N / tfm-tab-new) stay byte-identical — rethemeChrome (./ui-retheme)
// and the OSC-72 self-hover path share placesHost via the returned ref. ---

// structural mirrors of ./ui-slots's icon-slot types (they are module-private
// there; the functions arrive via ctx, like ui-props does)
type IconState = { fg: string; bg: string };
type IconSpec = {
  slotId: string;
  name: string;
  heightCells: number;
  states: IconState[];
  statesFactory?: () => IconState[];
  initialState: number;
  done?: boolean;
};

export type ChromeCtx = {
  byId(id: string): any;
  uiStyle(): "solid" | "outline";
  colors(): Theme & Record<string, any>;
  sw(): number; // live sidebar-width geometry let — applyConfig rewrites it; NEVER capture
  sideInnerW(): number; // index keeps this helper (outline insets by 2)
  tabBar(): boolean; // config.ui.tabBar
  renderAll(): void;
  navigate(target: string): void;
  blurTerminal(): void;
  closeFileMenu(): void;
  openContextMenu(x: number, y: number, title: string, entries: ListEntry[]): void;
  sidebarEntriesFor(place: Place, x: number, y: number): ListEntry[];
  finishDrag(): void; // was finishDragCtx()
  dlog(msg: string): void;
  trashPaths(paths: string[]): void;
  moveInto(destDir: string, items: ClipItem[]): Promise<void>;
  kbActive(): boolean; // sidebarActive
  kbIdx(): number; // placeIdx
  tabs(): { list: Tab[]; active: number }; // live tabModel read
  closeTab(i: number): void;
  switchTab(i: number): void;
  newTab(): void;
  hoverBtn(id: string, iconName: string, onMouseDown: (ev: any) => void): any;
  stripSelectable(): void;
  drainIconQueue(): void;
  makeIconSlot(
    name: string,
    states: IconState[],
    heightCells?: number,
    initialState?: number,
    onMouseDown?: (ev: any) => void,
    statesFactory?: () => IconState[],
  ): { el: any; slotId: string; spec: IconSpec };
  setIconState(spec: any, stateIdx: number): boolean;
  home: string;
  stateCwd(): string; // live state.cwd
};

export const makeChrome = (ctx: ChromeCtx) => {
  // --- Places sidebar (rebuilt from scratch on every render, selection = cwd) ---
  const placesHost: {
    row: ReturnType<typeof Box>;
    rowId: string;
    labelId: string;
    specs: IconSpec[];
    selected: boolean;
    place: Place;
  }[] = [];
  let mousePlaceIdx = -1;

  const mountDevice = (device: string) => {
    spawn("udisksctl", ["mount", "-b", device], { stdio: "ignore" });
    setTimeout(() => {
      void loadSystemPlaces().then(() => ctx.renderAll());
    }, 1200);
  };

  const makeRow = (place: Place): ReturnType<typeof Box> => {
    const idx = placesHost.length;
    const placeTarget = (): string | null =>
      place.scheme === "recent" ? RECENT_URI : place.scheme === "starred" ? STARRED_URI : place.path;
    const selected = place.path
      ? path.resolve(place.path) === path.resolve(ctx.stateCwd())
      : !!place.scheme && ctx.stateCwd() === placeTarget();
    const colors = ctx.colors();
    const st = ctx.uiStyle();
    const normFg = colors.sidebarFg;
    const selFg = colors.accent;
    const rowBg = slotBg(st, colors, colors.sidebarBg);
    const iconStates: IconState[] = [
      { fg: normFg, bg: rowBg },
      { fg: normFg, bg: colors.hoverBg },
      { fg: selFg, bg: colors.accentBg },
    ];
    const maxLabel = ctx.sideInnerW() - 4 - (place.ejectable ? 3 : 0);
    const paddedLabel = place.label.padEnd(Math.max(0, maxLabel)).slice(0, maxLabel);

    const iconSlot = ctx.makeIconSlot(place.icon, iconStates, 1, selectIconState(selected, false));
    let ejectSlot: ReturnType<typeof ctx.makeIconSlot> | undefined;
    if (place.ejectable && place.device) {
      ejectSlot = ctx.makeIconSlot("eject", iconStates, 1, selectIconState(selected, false), () =>
        ejectDevice(place.device!),
      );
    }
    const _specs = ejectSlot ? [iconSlot.spec, ejectSlot.spec] : [iconSlot.spec];

    const rowNode = Box(
      {
        id: `tfm-place-${idx}`,
        width: ctx.sideInnerW(),
        height: 1,
        flexDirection: "row",
        columnGap: 1,
        paddingLeft: 1,
        ...(selected ? { backgroundColor: colors.accentBg } : rowSurface(st, colors, "rest")),
        onMouseDown: (ev: any) => {
          if (ev.button === 2) {
            ctx.closeFileMenu();
            ctx.openContextMenu(ev.x, ev.y, place.label, ctx.sidebarEntriesFor(place, ev.x, ev.y));
            return;
          }
          ctx.blurTerminal();
          ctx.closeFileMenu();
          const target = placeTarget();
          if (target) ctx.navigate(target);
          else if (place.mountDevice) mountDevice(place.mountDevice);
        },
        onMouseDrop: () => {
          const keys = gridDrag.keys;
          ctx.finishDrag();
          const target = placeTarget();
          ctx.dlog(
            `place drop ${place.label} keys=${keys?.length ?? -1} scheme=${place.scheme ?? "-"} target=${target}`,
          );
          if (!keys || !target || place.scheme) return;
          const rest = keys.filter((k) => k.path !== target);
          if (!rest.length) return;
          // trashDir() honors $XDG_DATA_HOME (like places.ts's Trash row) — a
          // hardcoded ~/.local/share path diverges under a relocated trash
          // root and the drop would plain-move without a .trashinfo
          if (target === path.join(trashDir(), "files")) {
            // dropping onto the trash place must gio-trash, not plain-move —
            // otherwise no .trashinfo is written and items can't be restored
            void ctx.trashPaths(rest.map((k) => k.path));
          } else {
            void ctx.moveInto(target, rest);
          }
        },
        onMouseOver: () => {
          mousePlaceIdx = idx;
          normalizePlaces();
        },
        onMouseOut: () => {
          if (mousePlaceIdx === idx) {
            mousePlaceIdx = -1;
            normalizePlaces();
          }
        },
      },
      iconSlot.el,
    );
    const labelText: any = Text({
      id: `tfm-place-${idx}-label`,
      content: paddedLabel,
      fg: selected ? selFg : normFg,
    });
    rowNode.add(labelText);
    if (ejectSlot) rowNode.add(ejectSlot.el);
    placesHost.push({
      row: rowNode,
      rowId: `tfm-place-${idx}`,
      labelId: `tfm-place-${idx}-label`,
      specs: ejectSlot ? [iconSlot.spec, ejectSlot.spec] : [iconSlot.spec],
      selected,
      place,
    });
    return rowNode;
  };

  const ejectDevice = (device: string) => {
    spawn("udisksctl", ["unmount", "-b", device], { stdio: "ignore" });
    setTimeout(() => {
      void loadSystemPlaces().then(() => ctx.renderAll());
    }, 1500);
  };

  const renderSidebar = () => {
    const hostBox: any = ctx.byId("tfm-places");
    if (!hostBox) return;
    clearChildren(hostBox);
    placesHost.length = 0;

    const groups = buildSections();
    groups.forEach((group, gi) => {
      for (const place of group) hostBox.add(makeRow(place));
      if (gi < groups.length - 1) hostBox.add(makeDivider());
    });
    if (ctx.kbActive() && ctx.kbIdx() >= 0) {
      normalizePlaces();
    }
  };

  // --- Tab strip: one clickable chip per open tab + a new-tab button ---
  const renderTabbar = (): void => {
    const colors = ctx.colors();
    const bar: any = ctx.byId("tfm-tabbar");
    if (!bar) return;
    // a chip is a valid drop target only for a single dragged folder — dropping
    // navigates THAT tab to it (browser-style)
    const dragTabDir = (): string | null => {
      if (!gridDrag.active) return null;
      const keys = gridDrag.keys;
      const first = keys?.length === 1 ? keys[0] : undefined;
      return first?.isDir ? first.path : null;
    };
    // visibility rule: setting ON = strip always visible (even with one tab, so
    // the ＋ button stays reachable); setting OFF = adaptive — the strip only
    // earns a row once there's something to switch to (visible=false is
    // display:none in yoga — no empty row left)
    try {
      bar.visible = ctx.tabBar() || ctx.tabs().list.length > 1;
    } catch {}
    clearChildren(bar);
    ctx.tabs().list.forEach((t, i) => {
      const tabId = `tfm-tab-${i}`;
      const paint = () => {
        const n: any = ctx.byId(tabId);
        if (n) applySurface(n, tileSurface(ctx.uiStyle(), colors, i === ctx.tabs().active ? "selected" : "rest"));
      };
      // ✕ flatten target must match the chip's own fill, or the raster shows as
      // a square patch on the active tab (accentBg) vs the canvas (rest states)
      const closeStates = (): IconState[] => [
        {
          fg: colors.sidebarFgMuted,
          bg: i === ctx.tabs().active ? colors.accentBg : slotBg(ctx.uiStyle(), colors, colors.bg),
        },
        { fg: colors.white, bg: colors.hoverBg },
      ];
      const closeSlot = ctx.makeIconSlot(
        "close",
        closeStates(),
        1,
        0,
        (ev: any) => {
          try {
            ev.stopPropagation?.();
          } catch {} // ✕ must not also activate the chip
          ctx.closeTab(i);
        },
        closeStates,
      );
      // makeIconSlot only takes onMouseDown — hover swap goes on a wrapper
      const closeWrap = Box(
        {
          onMouseOver: () => {
            ctx.setIconState(closeSlot.spec, IconStateIdx.Active);
          },
          onMouseOut: () => {
            ctx.setIconState(closeSlot.spec, IconStateIdx.Rest);
          },
        },
        closeSlot.el,
      );
      bar.add(
        Box(
          {
            id: tabId,
            height: 1,
            maxWidth: 24,
            flexDirection: "row",
            columnGap: 1,
            paddingLeft: 1,
            paddingRight: 1,
            ...tileSurface(ctx.uiStyle(), colors, i === ctx.tabs().active ? "selected" : "rest"),
            onMouseDown: (ev: any) => {
              try {
                ev.stopPropagation?.();
              } catch {}
              ctx.closeFileMenu();
              if (ev.button === 1)
                ctx.closeTab(i); // middle-click also closes
              else ctx.switchTab(i);
            },
            onMouseDrop: () => {
              const keys = gridDrag.keys;
              ctx.finishDrag();
              const first = keys?.length === 1 ? keys[0] : undefined;
              ctx.dlog(`tab drop chip=${i} keys=${keys?.length ?? -1} dir=${first?.isDir ?? "-"}`);
              if (!first?.isDir) return;
              ctx.switchTab(i);
              ctx.navigate(first.path);
            },
            onMouseOver: () => {
              // drop-target cue: light the chip like the selected tab while a
              // single-folder drag hovers it
              if (dragTabDir() !== null) {
                const n: any = ctx.byId(tabId);
                if (n) applySurface(n, tileSurface(ctx.uiStyle(), colors, "selected"));
                return;
              }
              if (i !== ctx.tabs().active) {
                const n: any = ctx.byId(tabId);
                if (n) applySurface(n, tileSurface(ctx.uiStyle(), colors, "hover"));
              }
            },
            onMouseOut: paint,
          },
          Text({ content: tabTitle(t), fg: i === ctx.tabs().active ? colors.white : colors.sidebarFg }),
          closeWrap,
        ),
      );
    });
    bar.add(ctx.hoverBtn("tfm-tab-new", "plus", () => ctx.newTab()));
    ctx.stripSelectable();
    void ctx.drainIconQueue();
  };

  const makeDivider = () => {
    const colors = ctx.colors();
    return Box(
      { width: ctx.sideInnerW(), height: 1 },
      Text({ content: ` ${"~".repeat(ctx.sw() - 2)}`, fg: colors.divider }),
    );
  };

  // single source of truth: exactly one accent (cwd-selected) and optionally
  // one keyboard-hover highlight; wipes any stray styles deterministically
  const normalizePlaces = () => {
    const colors = ctx.colors();
    placesHost.forEach((rec, i) => {
      const isSel = rec.selected;
      const isHover = !isSel && (ctx.kbActive() ? i === ctx.kbIdx() : i === mousePlaceIdx);
      const row: any = ctx.byId(rec.rowId);
      const label: any = ctx.byId(rec.labelId);
      if (row)
        applySurface(
          row,
          isSel
            ? { backgroundColor: colors.accentBg }
            : isHover
              ? { backgroundColor: colors.hoverBg }
              : rowSurface(ctx.uiStyle(), colors, "rest"),
        );
      rec.specs.forEach((s) => {
        ctx.setIconState(s, selectIconState(isSel, isHover));
      });
      try {
        if (label) label.fg = isSel ? colors.accent : colors.sidebarFg;
      } catch {}
    });
  };

  return {
    renderSidebar,
    renderTabbar,
    normalizePlaces,
    makeDivider,
    placesHost,
    mountDevice,
    ejectDevice,
    setMousePlace: (idx: number) => {
      mousePlaceIdx = idx;
      normalizePlaces();
    },
    clearMousePlace: () => {
      mousePlaceIdx = -1;
      normalizePlaces();
    },
  };
};
