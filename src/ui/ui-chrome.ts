import { Box, type MouseEvent, Text } from "@opentui/core";
import { spawnSafe } from "../fs/spawn-safe";
import path from "node:path";
import { destroyChildren } from "../lib/uiutil";
import { applySurface, btnSurface, rowSurface, slotBg, tileSurface, type UiStyle } from "./style";
import { buildSections, loadSystemPlaces, type Place } from "../fs/places";
import { trashDir } from "../fs/fsutil";
import { RECENT_URI, STARRED_URI } from "../fs/uri";
import { tabTitle, type Tab } from "../app/tabs";
import { gridDrag, type ClipItem } from "../input/grid-input";
import { hoverEvents, selectIconState, toggleIconState } from "./ui-slots";
import type { Theme } from "../config/config";
import type { ListEntry } from "./ui-menu";

// --- Places sidebar rows + tab strip + divider — rebuilt from scratch each
// render; ctx-seamed like ui-term. tfm-* ids (tfm-place-N / tfm-place-N-label
// / tfm-tab-N / tfm-tab-new) stay byte-identical — rethemeChrome (./ui-retheme)
// and the OSC-72 self-hover path share placesHost via the returned ref. ---

// shared icon-slot types come from ./ui-slots (their queue) — the old
// byte-identical structural mirrors drifted when ui-slots gained a field
import type { IconSlotHandle, IconState, IconSpec, SlotElement } from "./ui-slots";
import type { MaybeNode } from "../lib/node-like";
import type { PointerStyle } from "../lib/pointer";

export const TAB_CHIP_MAX_W = 24; // roomy width, kept whenever the strip fits
export const TAB_CHIP_MIN_W = 6; // pad + 1-2 title cells + close; below this the tail clips
export const TAB_NEW_BTN_W = 3; // the plus button (toolbar hoverBtn width)

// --- Tab chip shrink: N chips + the plus button share one availW row with a
// 1-cell gap between items (N+1 items = N gaps). Each chip is capped so the
// whole strip fits; titles clip inside the shrunken chip (bar and chip both
// carry overflow:hidden). Past the minimum the tail clips instead of
// bleeding — same tradeoff as the toolbar crumbs. ---
export const tabChipMaxWidth = (availW: number, nTabs: number): number => {
  if (nTabs <= 0) return TAB_CHIP_MAX_W;
  const per = Math.floor((availW - TAB_NEW_BTN_W - nTabs) / nTabs);
  return Math.max(TAB_CHIP_MIN_W, Math.min(TAB_CHIP_MAX_W, per));
};

type ChromeCtx = {
  byId(id: string): MaybeNode;
  uiStyle(): UiStyle;
  colors(): Theme;
  sw(): number; // live sidebar-width geometry let — applyConfig rewrites it; NEVER capture
  sideInnerW(): number; // index keeps this helper (outline insets by 2)
  tabBar(): boolean; // config.ui.tabBar
  // live pane width for chip shrink (100% of the pane column). Optional so old
  // fakes keep working — absent/<=0 keeps the roomy 24-wide chips.
  availW?(pane: 0 | 1): number;
  // raster-affecting state ([ui] icons + tty mode + force-glyph): rows paint a
  // raster or a bare glyph without the places changing, so without this the
  // sidebar fast path keeps stale rasters across a graphics-mode toggle.
  // Optional so test fakes keep working.
  rasterSig?(): string;
  // transparent-bg force: chrome rest fills clear so the terminal shows
  // through. Optional so test fakes keep working; the render sig carries it
  // (rasterSig), so a flip rebuilds instead of repainting silently.
  transparentForce?(): boolean;
  renderAll(): void;
  navigate(target: string): void;
  blurTerminal(): void;
  closeFileMenu(): void;
  openContextMenu(x: number, y: number, title: string, entries: ListEntry[]): void;
  sidebarEntriesFor(place: Place, x: number, y: number): ListEntry[];
  finishDrag(): void; // was finishDragCtx()
  dlog(msg: string): void;
  trashPaths(paths: string[]): Promise<void>;
  moveInto(destDir: string, items: ClipItem[]): Promise<void>;
  // per-row hover nudge (icon lift, see ui-sidebar-hover) — built in the
  // chrome wiring; paint stays owned by normalizePlaces below
  hoverRow(key: string, hovered: boolean): void;
  // network: with no arg opens the "Connect to Server…" prompt; with a URI
  // connects straight to a saved connection
  connectServer(raw?: string): void;
  kbActive(): boolean; // sidebarActive
  kbIdx(): number; // placeIdx
  tabs(pane: 0 | 1): { list: Tab[]; active: number }; // live per-pane tab model
  // focus a pane (tab strip / chip press) before acting on it
  focusPane(pane: 0 | 1): void;
  closeTab(pane: 0 | 1, i: number): void;
  switchTab(pane: 0 | 1, i: number): void;
  newTab(pane: 0 | 1, dir?: string): void;
  hoverBtn(pane: 0 | 1, id: string, iconName: string, onMouseDown: (ev: MouseEvent) => void): SlotElement;
  stripSelectable(): void;
  drainIconQueue(): void;
  makeIconSlot(
    name: string,
    states: IconState[],
    heightCells?: number,
    initialState?: number,
    onMouseDown?: (ev: MouseEvent) => void,
    statesFactory?: () => IconState[],
  ): IconSlotHandle;
  setIconState(spec: IconSpec | undefined, stateIdx: number): boolean;
  stateCwd(): string; // live state.cwd
  // mouse pointer shape (OSC 22 via the wiring's tty-guarded setter).
  // Absent = no pointer changes (old fakes keep working).
  setPointer?(style: PointerStyle): void;
};

export const makeChrome = (ctx: ChromeCtx) => {
  // transparent-bg force as a surface-seam value (absent = today's behavior)
  const tForce = () => (ctx.transparentForce?.() ? "force" : undefined);
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
  // signature of the last rendered places list (labels/paths/theme/geometry).
  // renderSidebar rebuilds only when it changes — otherwise a pane-focus or
  // navigation would clear and recreate every icon slot, flashing the fallback
  // glyph before the raster drains (the dual-pane sidebar flicker).
  let lastPlacesSig = "";

  // is this place the one matching the CURRENT (focused pane's) cwd?
  const isPlaceSelected = (place: Place): boolean => {
    if (place.path) return path.resolve(place.path) === path.resolve(ctx.stateCwd());
    const target = place.scheme === "recent" ? RECENT_URI : place.scheme === "starred" ? STARRED_URI : null;
    return !!place.scheme && !!target && ctx.stateCwd() === target;
  };

  // mount/eject reload: one pending reload at a time — rapid clicks used to
  // stack redundant 1200/1500ms loadSystemPlaces+renderAll passes
  let reloadTimer: ReturnType<typeof setTimeout> | null = null;
  const scheduleDeviceReload = (ms: number): void => {
    if (reloadTimer !== null) clearTimeout(reloadTimer);
    reloadTimer = setTimeout(() => {
      reloadTimer = null;
      void loadSystemPlaces().then(() => ctx.renderAll());
    }, ms);
  };

  const mountDevice = (device: string) => {
    const child = spawnSafe("udisksctl", ["mount", "-b", device], { stdio: "ignore" }, (err) =>
      ctx.dlog(`mount ${device}: ${err.message}`),
    );
    // a failing mount (bad device, policy) used to be silent — the reload
    // below fires either way, so log the exit for the --debug trail
    child.on("close", (code) => {
      if (code !== 0) ctx.dlog(`mount ${device} exit ${code}`);
    });
    scheduleDeviceReload(1200);
  };

  const makeRow = (place: Place): ReturnType<typeof Box> => {
    const idx = placesHost.length;
    const placeTarget = (): string | null =>
      place.scheme === "recent" ? RECENT_URI : place.scheme === "starred" ? STARRED_URI : place.path;
    const selected = isPlaceSelected(place);
    const colors = ctx.colors();
    const st = ctx.uiStyle();
    const normFg = colors.white;
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
    const device = place.device;
    if (place.ejectable && device) {
      ejectSlot = ctx.makeIconSlot("eject", iconStates, 1, selectIconState(selected, false), () => ejectDevice(device));
    }
    const rowNode = Box(
      {
        id: `tfm-place-${idx}`,
        width: ctx.sideInnerW(),
        height: 1,
        flexDirection: "row",
        columnGap: 1,
        paddingLeft: 1,
        ...rowSurface(st, colors, selected ? "selected" : "rest", tForce()),
        onMouseDown: (ev: MouseEvent) => {
          if (ev.button === 2) {
            ctx.closeFileMenu();
            ctx.openContextMenu(ev.x, ev.y, place.label, ctx.sidebarEntriesFor(place, ev.x, ev.y));
            return;
          }
          ctx.blurTerminal();
          ctx.closeFileMenu();
          if (place.action === "connect") {
            ctx.connectServer();
            return;
          }
          const target = placeTarget();
          if (target) ctx.navigate(target);
          else if (place.networkUri) ctx.connectServer(place.networkUri);
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
            // dropping onto the trash place must go through trashPaths (own
            // .trashinfo writer), not plain-move — otherwise no .trashinfo is
            // written and items can't be restored
            void ctx.trashPaths(rest.map((k) => k.path));
          } else {
            void ctx.moveInto(target, rest);
          }
        },
        // hover paint + icon lift for THIS row; normalizePlaces is the single
        // paint truth (it recomputes every row), and the shared wiring keeps a
        // per-pixel move from re-running it — that would be O(rows) per cell
        ...hoverEvents((on) => {
          ctx.hoverRow(`tfm-place-${idx}`, on);
          if (on) mousePlaceIdx = idx;
          else if (mousePlaceIdx === idx) mousePlaceIdx = -1;
          normalizePlaces();
          // a drag owns the pointer (tiles show grabbing/not-allowed) — a
          // sidebar sweep mid-drag must not clobber it back to pointer
          if (!gridDrag.active) ctx.setPointer?.(on ? "pointer" : "default");
        }),
      },
      iconSlot.el,
    );
    const labelText = Text({
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
    const child = spawnSafe("udisksctl", ["unmount", "-b", device], { stdio: "ignore" }, (err) =>
      ctx.dlog(`eject ${device}: ${err.message}`),
    );
    child.on("close", (code) => {
      if (code !== 0) ctx.dlog(`eject ${device} exit ${code}`);
    });
    scheduleDeviceReload(1500);
  };

  const renderSidebar = () => {
    const hostBox = ctx.byId("tfm-places");
    if (!hostBox) return;
    const groups = buildSections();
    const sig = JSON.stringify([
      ctx.uiStyle(),
      ctx.sideInnerW(),
      ctx.colors(),
      ctx.rasterSig?.() ?? "",
      groups.map((g) =>
        g.map((p) => [
          p.label,
          p.path ?? "",
          p.scheme ?? "",
          p.icon,
          p.ejectable ?? false,
          p.device ?? "",
          p.networkUri ?? "",
          p.action ?? "",
          p.mountDevice ?? "",
        ]),
      ),
    ]);
    if (sig === lastPlacesSig && placesHost.length) {
      // same places — just move the cwd highlight, no slot re-creation
      normalizePlaces();
      return;
    }
    lastPlacesSig = sig;
    destroyChildren(hostBox);
    placesHost.length = 0;

    groups.forEach((group, gi) => {
      for (const place of group) hostBox.add(makeRow(place));
      if (gi < groups.length - 1) hostBox.add(makeDivider());
    });
    if (ctx.kbActive() && ctx.kbIdx() >= 0) {
      normalizePlaces();
    }
  };

  // --- Tab strip: one clickable chip per open tab + a new-tab button. One
  // strip PER PANE (ids `tfm-p0-tabbar` / `tfm-p1-tabbar`). ---
  const renderTabbar = (pane: 0 | 1): void => {
    const colors = ctx.colors();
    const prefix = `tfm-p${pane}-`;
    const bar = ctx.byId(`${prefix}tabbar`);
    if (!bar) return;
    const tabs = ctx.tabs(pane);
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
      bar.visible = ctx.tabBar() || tabs.list.length > 1;
    } catch {}
    destroyChildren(bar);
    // shrink the chips to the live pane width so adding tabs never pushes the
    // strip (or the plus button) past the pane edge
    const avail = ctx.availW?.(pane) ?? 0;
    const chipMaxW = avail > 0 ? tabChipMaxWidth(avail, tabs.list.length) : TAB_CHIP_MAX_W;
    tabs.list.forEach((t, i) => {
      const tabId = `${prefix}tab-${i}`;
      const active = i === tabs.active;
      // ✕ flatten target must match the chip's own fill, or the raster shows as
      // a square patch on the active tab (accentBg) vs the canvas (rest states)
      const closeStates = (): IconState[] => [
        {
          fg: colors.sidebarFgMuted,
          bg: active ? colors.accentBg : slotBg(ctx.uiStyle(), colors, colors.bg),
        },
        { fg: colors.white, bg: colors.hoverBg },
      ];
      const closeSlot = ctx.makeIconSlot(
        "close",
        closeStates(),
        1,
        0,
        (ev: MouseEvent) => {
          try {
            ev.stopPropagation?.();
          } catch {} // ✕ must not also activate the chip
          ctx.closeTab(pane, i);
        },
        closeStates,
      );
      // makeIconSlot only takes onMouseDown — the hover swap goes on a wrapper.
      // Both halves must flip together (raster state AND the wrapper surface):
      // opaque rasters bake their bg, so a wrapper that only swaps the raster
      // shows a stale/flat square, and in glyph mode the raster is absent and
      // the wrapper surface is the ONLY thing that can highlight.
      const closeWrapId = `${prefix}tab-${i}-close`;
      const closeRestBg = active ? colors.accentBg : slotBg(ctx.uiStyle(), colors, colors.bg);
      const paintClose = (on: boolean) => {
        ctx.setIconState(closeSlot.spec, toggleIconState(on, false));
        const n = ctx.byId(closeWrapId);
        if (n) applySurface(n, btnSurface(ctx.uiStyle(), colors, on, closeRestBg));
      };
      const closeWrap = Box(
        {
          id: closeWrapId,
          ...btnSurface(ctx.uiStyle(), colors, false, closeRestBg),
          ...hoverEvents(paintClose, ctx.setPointer),
        },
        closeSlot.el,
      );
      bar.add(
        Box(
          {
            id: tabId,
            height: 1,
            maxWidth: chipMaxW,
            flexShrink: 1,
            overflow: "hidden",
            flexDirection: "row",
            columnGap: 1,
            paddingLeft: 1,
            paddingRight: 1,
            ...tileSurface(ctx.uiStyle(), colors, active ? "selected" : "rest", tForce()),
            onMouseDown: (ev: MouseEvent) => {
              try {
                ev.stopPropagation?.();
              } catch {}
              ctx.focusPane(pane);
              ctx.closeFileMenu();
              if (ev.button === 1)
                ctx.closeTab(pane, i); // middle-click also closes
              else ctx.switchTab(pane, i);
            },
            onMouseDrop: () => {
              const keys = gridDrag.keys;
              ctx.finishDrag();
              const first = keys?.length === 1 ? keys[0] : undefined;
              ctx.dlog(`tab drop pane=${pane} chip=${i} keys=${keys?.length ?? -1} dir=${first?.isDir ?? "-"}`);
              if (!first?.isDir) return;
              ctx.switchTab(pane, i);
              ctx.navigate(first.path);
            },
            // drop-target cue: light the chip like the selected tab while a
            // single-folder drag hovers it, else the usual hover fill
            ...hoverEvents((on) => {
              const n = ctx.byId(tabId);
              if (!n) return;
              if (on && dragTabDir() !== null) {
                applySurface(n, tileSurface(ctx.uiStyle(), colors, "selected", tForce()));
                return;
              }
              if (!active) applySurface(n, tileSurface(ctx.uiStyle(), colors, on ? "hover" : "rest", tForce()));
              // a drag owns the pointer — same rule as the sidebar rows
              if (!gridDrag.active) ctx.setPointer?.(on ? "pointer" : "default");
            }),
          },
          Text({ content: tabTitle(t), fg: active ? colors.white : colors.sidebarFg }),
          closeWrap,
        ),
      );
    });
    bar.add(
      ctx.hoverBtn(pane, `${prefix}tab-new`, "plus", () => {
        ctx.focusPane(pane);
        ctx.newTab(pane);
      }),
    );
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
      // recompute from the live cwd: the focused pane can change between
      // renders without the places list changing (rebuild is skipped then)
      rec.selected = isPlaceSelected(rec.place);
      const isSel = rec.selected;
      // a row that just became (still is) selected must never carry a hover
      // lift: playHover only releases on a mouse out/over sweep, so a cwd change
      // with the mouse resting on a lifted row (click, keyboard nav, grid/pane
      // navigate) would strand its icon nudged. Release it here — the single
      // repaint every selection change funnels through. hoverRow(key,false) is a
      // safe no-op unless the animator actually owns this exact row.
      if (isSel) ctx.hoverRow(rec.rowId, false);
      const isHover = !isSel && (ctx.kbActive() ? i === ctx.kbIdx() : i === mousePlaceIdx);
      const row = ctx.byId(rec.rowId);
      const label = ctx.byId(rec.labelId);
      if (row)
        applySurface(row, rowSurface(ctx.uiStyle(), colors, isSel ? "selected" : isHover ? "hover" : "rest", tForce()));
      rec.specs.forEach((s) => {
        ctx.setIconState(s, selectIconState(isSel, isHover));
      });
      try {
        if (label) label.fg = isSel ? colors.accent : colors.white;
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
