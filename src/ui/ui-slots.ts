// --- Icon slots / thumbnails / modal scrim ---
// Widget-extraction seam (see ui-dialogs.ts for the template): build time
// queues a small glyph box via makeIconSlot; the async drain swaps in
// theme-tinted kitty rasters at exact cell pixels (rsvg-convert via
// ./icons). Thumbnail jobs share the same drain model. Kitty placements
// float above all cells, so while a modal is up every background slot falls
// back to a pre-darkened glyph (setScrim); rasters come back on close.
// Renderer/theme arrive via ctx getters — never capture geometry or colors.

import { Box, ImageRenderable, Text } from "@opentui/core";
import { iconPng, thumbPng } from "./icons";
import type { Theme } from "../config/config";
import { applySurface, btnSurface, slotBg, type UiStyle } from "./style";

export type IconState = { fg: string; bg: string };

// Icon raster indices shared by every slot. Three slot families share one
// index space:
// - select slots (tiles, sidebar rows): Rest/Hover/Selected (+ Cut for tiles)
// - toggle slots (star, crumbs, hover buttons): Off/On + HoverOffset
// - nav slots (back/fwd): Enabled/Disabled + HoverOffset (note: Enabled=0,
//   Disabled=1 — the inverse sense of a toggle, hence the separate helper)
export const IconStateIdx = { Rest: 0, Active: 1, Selected: 2, Cut: 3, HoverOffset: 2 } as const;
export type IconStateIndex = (typeof IconStateIdx)[keyof typeof IconStateIdx];

/** Toggle slot (off/on × normal/hover): star, crumbs, hover buttons, esc hint. */
export const toggleIconState = (on: boolean, hover: boolean): number =>
  (on ? IconStateIdx.Active : IconStateIdx.Rest) + (hover ? IconStateIdx.HoverOffset : 0);

/** Nav slot (enabled/disabled × normal/hover): back/fwd buttons. */
export const navIconState = (enabled: boolean, hover: boolean): number =>
  (enabled ? IconStateIdx.Rest : IconStateIdx.Active) + (hover ? IconStateIdx.HoverOffset : 0);

/** Select slot (rest/hover/selected): tiles, sidebar rows. */
export const selectIconState = (selected: boolean, hover: boolean): number =>
  selected ? IconStateIdx.Selected : hover ? IconStateIdx.Active : IconStateIdx.Rest;

export type IconSpec = {
  slotId: string;
  name: string;
  heightCells: number;
  states: IconState[];
  // slots that survive renderAll rebuilds (nav/search/sort) must derive fresh
  // state colors on every re-raster, or a runtime theme swap leaves them stale
  statesFactory?: () => IconState[];
  initialState: number;
  done?: boolean;
};

export type ThumbJob = {
  slotId: string;
  path: string;
  mtimeMs: number;
  size: number;
  wCells: number;
  hCells?: number;
  bg?: string;
  vector: boolean;
  video?: boolean;
  fallbackGlyph: string;
  // foreground jobs (preview pane, properties hero) jump ahead of the folder's
  // grid-thumbnail backlog instead of waiting FIFO behind it
  priority?: boolean;
};

export type SlotsCtx = {
  renderer(): any;
  byId(id: string): any;
  clearChildren(node: any): void;
  // live theme — always read through the getter, never captured
  colors(): Record<string, any>;
  uiStyle(): string;
  // default thumb height in cells (the ICON_CELLS_H geometry let)
  iconCells(): number;
  // true while a modal menu/scrim owns the screen (drain re-applies scrim)
  modalOpen(): boolean;
  glyphFor(name: string): string;
};

export const dimHex = (hex: string, f: number): string => {
  if (f === 1) return hex;
  const m = hex.match(/^#([0-9a-fA-F]{6})$/);
  if (!m?.[1]) return hex;
  const n = parseInt(m[1], 16);
  const r = Math.round(((n >> 16) & 255) * f);
  const g = Math.round(((n >> 8) & 255) * f);
  const b = Math.round((n & 255) * f);
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, "0")}`;
};

export const makeSlots = (ctx: SlotsCtx) => {
  const iconQueue: IconSpec[] = [];
  let iconSeq = 0;
  let thumbJobs: ThumbJob[] = [];

  const cellMetrics = () => {
    const r = ctx.renderer();
    const res = r.resolution;
    const cellW = res ? res.width / r.terminalWidth : 10;
    const cellH = res ? res.height / r.terminalHeight : 20;
    return { cellW, cellH, aspect: cellH > 0 ? cellH / cellW : 2 };
  };

  const makeIconSlot = (
    name: string,
    states: IconState[],
    heightCells = 1,
    initialState = 0,
    onMouseDown?: (ev: any) => void,
    statesFactory?: () => IconState[],
  ): { el: ReturnType<typeof Box>; slotId: string; spec: IconSpec } => {
    const slotId = `tfm-icon-${iconSeq++}`;
    const g = ctx.glyphFor(name);
    const spec: IconSpec = {
      slotId,
      name,
      heightCells,
      states,
      initialState,
      ...(statesFactory ? { statesFactory } : {}),
    };
    iconQueue.push(spec);
    return {
      el: Box(
        {
          id: slotId,
          width: Math.round(heightCells * 2),
          height: heightCells,
          ...(onMouseDown ? { onMouseDown } : {}),
        },
        Text({ id: `${slotId}-g`, content: g, fg: states[initialState]?.fg ?? states[0]?.fg }),
      ),
      slotId,
      spec,
    };
  };

  const setIconState = (spec: IconSpec | undefined, stateIdx: number): boolean => {
    if (!spec) return false;
    spec.initialState = stateIdx;
    const slot: any = ctx.byId(spec.slotId);
    if (!slot) return false;
    const kids = slot.getChildren?.() ?? [];
    const stateImgs = kids.filter(
      (k: any) => typeof k.id === "string" && k.id.startsWith(`${spec.slotId}-s`) && k.id !== `${spec.slotId}-g`,
    );
    if (stateImgs.length === 0) {
      const glyphNode: any = kids.find((k: any) => k.id === `${spec.slotId}-g`);
      if (glyphNode) {
        try {
          glyphNode.fg = spec.states[stateIdx]?.fg;
        } catch {}
      }
      return false;
    }
    stateImgs.forEach((k: any, i: number) => {
      try {
        k.visible = i === stateIdx;
      } catch {}
    });
    return true;
  };

  // magick/rsvg spawns are the bottleneck (~100ms each, SVGs worse); 3 workers
  // made big folders drip in one-by-one — match the icon raster cap's spirit
  // and keep the UI thread yielding between jobs
  const THUMB_WORKERS = 8;

  const drainThumbs = async () => {
    const jobs = thumbJobs;
    thumbJobs = [];
    if (!ctx.renderer().resolution || jobs.length === 0) return;
    // priority jobs (preview/props) first — Array#sort is stable, so each
    // class keeps its push order
    jobs.sort((a, b) => (a.priority ? 0 : 1) - (b.priority ? 0 : 1));
    const { cellW, cellH } = cellMetrics();
    let idx = 0;
    const worker = async () => {
      while (idx < jobs.length) {
        const j = jobs[idx++]!;
        const slot: any = ctx.byId(j.slotId);
        if (!slot) continue;
        const hCells = j.hCells ?? ctx.iconCells();
        const jobBg = j.bg ?? ctx.colors().bg;
        // 2px inset so kitty's cell->pixel rounding never bleeds onto neighbors
        const pxW = Math.max(1, Math.round(j.wCells * cellW) - 2);
        const pxH = Math.max(1, Math.round(hCells * cellH) - 2);
        try {
          const bytes = await thumbPng(j.path, j.mtimeMs, j.size, pxW, pxH, jobBg, j.vector, j.video);
          const img = new ImageRenderable(ctx.renderer(), {
            id: `${j.slotId}-t`,
            source: bytes,
            width: j.wCells,
            height: hCells,
            fit: "fit",
            protocol: "auto",
          });
          await img.loadPromise!;
          ctx.clearChildren(slot);
          slot.add(img);
        } catch {
          if (slot.getChildren().length === 0) {
            try {
              slot.add(Text({ content: j.fallbackGlyph, fg: ctx.colors().sidebarFgMuted }));
            } catch {}
          }
        }
        await new Promise((r) => setTimeout(r, 0));
      }
    };
    await Promise.all(Array.from({ length: Math.min(THUMB_WORKERS, jobs.length) }, () => worker()));
  };

  const rasterStatesInto = async (
    slotId: string,
    name: string,
    states: IconState[],
    heightCells: number,
    wCells: number,
    initial: number,
    dimFactor = 1,
    idPrefix = "s",
  ) => {
    const { cellW, cellH } = cellMetrics();
    const imgs: any[] = [];
    for (let si = 0; si < states.length; si++) {
      try {
        const st = states[si]!;
        const bytes = await iconPng(
          name,
          dimHex(st.fg, dimFactor),
          dimHex(st.bg, dimFactor),
          Math.max(1, Math.round(wCells * cellW)),
          Math.max(1, Math.round(heightCells * cellH)),
        );
        const img = new ImageRenderable(ctx.renderer(), {
          id: `${slotId}-${idPrefix}${si}`,
          source: bytes,
          width: wCells,
          height: heightCells,
          fit: "fit",
          protocol: "auto",
        });
        await img.loadPromise!;
        img.visible = si === initial;
        imgs.push(img);
      } catch {}
    }
    return imgs;
  };

  const drainIconQueue = async () => {
    if (!ctx.renderer().resolution) return;
    const aspect = cellMetrics().aspect;
    const pending = iconQueue.filter((s) => !s.done);
    await Promise.all(
      pending.map(async (spec) => {
        spec.done = true;
        const slot: any = ctx.byId(spec.slotId);
        if (!slot) return;
        if (spec.statesFactory) {
          try {
            spec.states = spec.statesFactory();
          } catch {}
        }
        const wCells = Math.max(1, Math.round(spec.heightCells * aspect));
        const imgs = await rasterStatesInto(
          spec.slotId,
          spec.name,
          spec.states,
          spec.heightCells,
          wCells,
          spec.initialState,
        );
        if (imgs.length === 0) return;
        slot.width = wCells;
        const kids = slot.getChildren?.() ?? [];
        // drop previous rasters (e.g. after a resize re-raster at new cell pixels)
        kids
          .filter((k: any) => typeof k.id === "string" && k.id.startsWith(`${spec.slotId}-s`))
          .forEach((k: any) => {
            try {
              slot.remove(k);
            } catch {}
          });
        const glyphNode: any = kids.find((k: any) => typeof k.id === "string" && k.id.endsWith("-g"));
        // glyph stays in the slot (hidden) so the scrim can fall back to it
        if (glyphNode) {
          try {
            glyphNode.visible = false;
          } catch {}
        }
        imgs.forEach((im) => {
          slot.add(im);
        });
      }),
    );
    // done specs are dead weight: their slots are destroyed on the next rebuild
    // and live tile refs keep the spec objects alive independently of the queue
    iconQueue.splice(0, iconQueue.length, ...iconQueue.filter((s) => !s.done));
    // re-rasters made fresh images visible; while a modal scrim is up the icons
    // must fall back to dimmed glyphs or they float over the menu
    if (ctx.modalOpen()) setScrim(true);
  };

  // Slots INSIDE a modal (menu rows, context menus, prompts) sit above the
  // scrim and keep their crisp rasters.
  const MODAL_ROOT_IDS = new Set(["tfm-menu", "tfm-filemenu", "tfm-prompt"]);

  const isModalChild = (slot: any): boolean => {
    let cur: any = slot?.parent;
    while (cur) {
      if (typeof cur?.id === "string" && MODAL_ROOT_IDS.has(cur.id)) return true;
      cur = cur.parent;
    }
    return false;
  };

  const setScrim = (on: boolean) => {
    for (const spec of iconQueue) {
      const slot: any = ctx.byId(spec.slotId);
      if (!slot) continue;
      if (on && isModalChild(slot)) continue;
      const kids = (slot.getChildren?.() ?? []) as any[];
      const glyphNode: any = kids.find((k) => k.id === `${spec.slotId}-g`);
      if (!glyphNode) continue;
      const stateImgs = kids.filter((k) => typeof k.id === "string" && k.id.startsWith(`${spec.slotId}-s`));
      if (stateImgs.length === 0 && !spec.done) continue;
      if (on) {
        stateImgs.forEach((k) => {
          try {
            k.visible = false;
          } catch {}
        });
        try {
          glyphNode.fg = dimHex(spec.states[spec.initialState]?.fg ?? ctx.colors().sidebarFg, 0.41);
          glyphNode.visible = true;
        } catch {}
      } else {
        if (stateImgs.length === 0) {
          try {
            glyphNode.visible = true;
          } catch {}
        } else {
          try {
            glyphNode.visible = false;
          } catch {}
          stateImgs.forEach((k, i) => {
            try {
              k.visible = i === spec.initialState;
            } catch {}
          });
        }
      }
    }
  };

  // clickable "esc"/close hint shared by floating UIs (prompt/props/menu) —
  // an icon-slot widget, so it lives with the slot machinery
  const escHintBtn = (id: string, onClose: () => void): any => {
    const states = (): IconState[] => [
      {
        fg: ctx.colors().sidebarFgMuted,
        bg: slotBg(ctx.uiStyle() as UiStyle, ctx.colors() as Theme, ctx.colors().sidebarBg),
      },
      { fg: ctx.colors().white, bg: ctx.colors().hoverBg },
    ];
    const slot = makeIconSlot("close", states(), 1, IconStateIdx.Rest, undefined, states);
    const paint = (on: boolean) => {
      setIconState(slot.spec, toggleIconState(on, false));
      try {
        const n: any = ctx.byId(id);
        if (n) applySurface(n, btnSurface(ctx.uiStyle() as UiStyle, ctx.colors() as Theme, on, ctx.colors().sidebarBg));
      } catch {}
    };
    return Box(
      {
        id,
        // extra cell keeps the X off the panel edge
        width: 3,
        height: 1,
        justifyContent: "center",
        ...btnSurface(ctx.uiStyle() as UiStyle, ctx.colors() as Theme, false, ctx.colors().sidebarBg),
        onMouseDown: () => onClose(),
        onMouseOver: () => paint(true),
        onMouseOut: () => paint(false),
      },
      slot.el,
    );
  };

  return {
    cellMetrics,
    escHintBtn,
    makeIconSlot,
    setIconState,
    drainThumbs,
    drainIconQueue,
    setScrim,
    nextIconId: (): string => `tfm-icon-${iconSeq++}`,
    resetIconQueue: (): void => {
      for (const s of iconQueue) s.done = false;
    },
    pushThumbJob: (job: ThumbJob): void => {
      thumbJobs.push(job);
    },
  };
};
