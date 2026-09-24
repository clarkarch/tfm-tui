// --- Icon slots / thumbnails / modal scrim ---
// Widget-extraction seam (see ui-dialogs.ts for the template): build time
// queues a small glyph box via makeIconSlot; the async drain swaps in
// theme-tinted kitty rasters at exact cell pixels (resvg/rsvg-convert via
// ./icons). Thumbnail jobs share the same drain model. Kitty placements
// float above all cells, so while a modal is up every background slot falls
// back to a pre-darkened glyph (setScrim); rasters come back on close.
// Renderer/theme arrive via ctx getters — never capture geometry or colors.

import { Box, type CliRenderer, type ColorInput, ImageRenderable, type MouseEvent, Text } from "@opentui/core";
import { iconPng, thumbPng } from "./icons";
import { swallow } from "../app/log";
import type { IconMode, Theme } from "../config/config";
import { applySurface, btnSurface, iconTransparent, slotBg, type UiStyle } from "./style";
import type { MaybeNode } from "../lib/node-like";

export type IconState = { fg: string; bg: string };

// Icon raster indices shared by every slot. Three slot families share one
// index space:
// - select slots (tiles, sidebar rows): Rest/Hover/Selected (+ Cut for tiles)
// - toggle slots (star, crumbs, hover buttons): Off/On + HoverOffset
// - nav slots (back/fwd): Enabled/Disabled + HoverOffset (note: Enabled=0,
//   Disabled=1 — the inverse sense of a toggle, hence the separate helper)
export const IconStateIdx = { Rest: 0, Active: 1, Selected: 2, Cut: 3, HoverOffset: 2 } as const;

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

// Whatever the widgets nest inside their Box()/Text() calls — which is exactly
// the row/slot builders' return type. Derived from Box()'s own children param
// instead of a hand-written union of the VNode instantiations in use, so a new
// construct (or a bare string child) keeps typechecking.
export type SlotElement = Parameters<typeof Box>[1];

// makeIconSlot's contract: the mountable element, the id the theme/scrim paths
// look it up by, and the spec setIconState later mutates.
export type IconSlotHandle = { el: SlotElement; slotId: string; spec: IconSpec };

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
  // foreground jobs (preview/props) jump ahead of the folder's grid-thumbnail
  // backlog instead of waiting FIFO behind it
  priority?: boolean;
  // inside the viewport at build time — non-visible jobs drain LAST (nautilus
  // moves visible files to the head of its IO queues for the same reason)
  visible?: boolean;
};

// drain order: priority > visible > off-screen backlog. Stable sort keeps push
// (display-row) order within each class, so the first screenful rasterizes
// top-to-bottom before anything further down the folder is even spawned.
export const thumbJobRank = (j: ThumbJob): number => (j.priority ? 0 : j.visible === false ? 2 : 1);

// How the mounted raster is fitted into its cell box. Raster/video rasters are
// either aspect-preserving (Bun.Image `fit:"inside"`) or exact-box (ffmpeg
// cover-crop; magick `^`+extent), so cover-crop them to fill the tile. SVG
// thumbs via resvg are ALSO aspect-preserving but must be CONTAINED (contain
// letterboxes; cover would crop the drawing's edges) — that was the old
// `fit:"fit"` behavior, restored here for vectors only.
export const thumbImageFit = (vector: boolean): "fit" | "cover" => (vector ? "fit" : "cover");

export type SlotsCtx = {
  renderer(): CliRenderer;
  byId(id: string): MaybeNode;
  clearChildren(node: unknown): void;
  // live theme — always read through the getter, never captured
  colors(): Theme;
  uiStyle(): string;
  // [ui] icons — read live like uiStyle (mode flip re-rasters)
  iconsMode(): IconMode;
  // default thumb height in cells (the ICON_CELLS_H geometry let)
  iconCells(): number;
  // true while a modal menu/scrim owns the screen (drain re-applies scrim)
  modalOpen(): boolean;
  glyphFor(name: string): string;
  // compat mode (linux console): skip every raster/thumb spawn, glyphs only.
  // force-glyph does the same on modern terminals with buggy kitty graphics
  // (view/anims/transparency untouched). Optional so test fakes keep working.
  compatActive?(): boolean;
  forceGlyph?(): boolean;
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
  // registry of every queued slot, drained or not: setScrim must reach
  // rasters that finished BEFORE the modal opened (the old queue pruned
  // done specs at the end of each drain — scrim then iterated an almost
  // empty queue and kitty rasters floated over the menu), and
  // resetIconQueue must re-queue drained slots for theme/resize re-rasters.
  // Pruned lazily in drainIconQueue when the slot node is gone from the tree.
  // This is the ONLY registry — a second `iconQueue` (the old design) grew
  // unbounded and re-armed dead specs on every reset.
  const allSpecs = new Map<string, IconSpec>();
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
    onMouseDown?: (ev: MouseEvent) => void,
    statesFactory?: () => IconState[],
  ): IconSlotHandle => {
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
    allSpecs.set(slotId, spec);
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
    const slot = ctx.byId(spec.slotId);
    if (!slot) return false;
    const kids = slot.getChildren();
    const stateImgs = kids.filter(
      (k) => typeof k.id === "string" && k.id.startsWith(`${spec.slotId}-s`) && k.id !== `${spec.slotId}-g`,
    );
    if (stateImgs.length === 0) {
      const glyphNode = kids.find((k) => k.id === `${spec.slotId}-g`);
      if (glyphNode) {
        try {
          glyphNode.fg = spec.states[stateIdx]?.fg;
        } catch {}
      }
      return false;
    }
    stateImgs.forEach((k, i) => {
      try {
        k.visible = i === stateIdx;
      } catch {}
    });
    return true;
  };

  // magick/renderer spawns are the bottleneck (~100ms each, SVGs worse); 3 workers
  // made big folders drip in one-by-one — match the icon raster cap's spirit
  // and keep the UI thread yielding between jobs
  const THUMB_WORKERS = 8;

  const drainThumbs = async () => {
    const jobs = thumbJobs;
    thumbJobs = [];
    // drop the backlog (a rebuild re-queues what it needs if compat flips off)
    if (ctx.compatActive?.() || ctx.forceGlyph?.()) return;
    if (!ctx.renderer().resolution || jobs.length === 0) return;
    // priority first, then visible tiles, then the off-screen backlog —
    // Array#sort is stable, so each class keeps its push order
    jobs.sort((a, b) => thumbJobRank(a) - thumbJobRank(b));
    const { cellW, cellH } = cellMetrics();
    let idx = 0;
    const worker = async () => {
      while (idx < jobs.length) {
        const j = jobs[idx++];
        if (!j) continue;
        let slot = ctx.byId(j.slotId);
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
            // rasters/video cover-crop into the tile; SVG vectors contain (see
            // thumbImageFit) — icons keep fit:"fit" at their own site
            fit: thumbImageFit(j.vector),
            protocol: "auto",
          });
          if (img.loadPromise) await img.loadPromise;
          // RE-RESOLVE: a rebuild during the raster detached the captured node;
          // writing into it leaked a native image buffer and painted nowhere.
          // A same-id replacement is the live slot, so use the fresh lookup.
          slot = ctx.byId(j.slotId);
          if (!slot) {
            try {
              img.destroy?.();
            } catch {}
            continue;
          }
          ctx.clearChildren(slot);
          slot.add(img);
        } catch {
          // `slot` is re-assigned inside the try above, so the catch sees the
          // unnarrowed type again — the optional chain re-establishes it
          if (slot?.getChildren().length === 0) {
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
    // `transparent` = raster keeps alpha; strip it inside floating layers in
    // partial mode so an opaque island can't blend the desktop through.
    const transparent = iconTransparent(ctx.iconsMode(), isFloatChild(ctx.byId(slotId)));
    const imgs: ImageRenderable[] = [];
    for (let si = 0; si < states.length; si++) {
      const st = states[si];
      if (st === undefined) continue;
      try {
        const bytes = await iconPng(
          name,
          dimHex(st.fg, dimFactor),
          dimHex(st.bg, dimFactor),
          Math.max(1, Math.round(wCells * cellW)),
          Math.max(1, Math.round(heightCells * cellH)),
          // bg arrives ignored in transparent mode (the key drops it, so all
          // states share one raster) — kept in the signature for call-site compat
          { transparent },
        );
        const img = new ImageRenderable(ctx.renderer(), {
          id: `${slotId}-${idPrefix}${si}`,
          source: bytes,
          width: wCells,
          height: heightCells,
          fit: "fit",
          protocol: "auto",
        });
        if (img.loadPromise) await img.loadPromise;
        img.visible = si === initial;
        imgs.push(img);
      } catch (err) {
        // a raster that never lands leaves the small fallback glyph in place
        // forever (the documented wrong-slot-name failure mode) — this line is
        // where the actual cause shows up
        swallow(`icon slot raster ${name}`, err);
      }
    }
    return imgs;
  };

  const drainIconQueue = async () => {
    if (ctx.compatActive?.() || ctx.forceGlyph?.()) return;
    if (!ctx.renderer().resolution) return;
    const aspect = cellMetrics().aspect;
    const pending = [...allSpecs.values()].filter((s) => !s.done);
    await Promise.all(
      pending.map(async (spec) => {
        spec.done = true;
        const slot = ctx.byId(spec.slotId);
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
        const kids = slot.getChildren();
        // drop previous rasters (e.g. after a resize re-raster at new cell pixels)
        kids
          .filter((k) => typeof k.id === "string" && k.id.startsWith(`${spec.slotId}-s`))
          .forEach((k) => {
            try {
              slot.remove(k);
            } catch {}
          });
        const glyphNode = kids.find((k) => typeof k.id === "string" && k.id.endsWith("-g"));
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
    // drop specs whose slot node is gone from the tree (tiles/sidebars
    // rebuilt by renderAll): their spec objects are dead weight and the
    // tile refs that kept them alive are gone too. Everything still
    // mounted stays in the registry — the scrim and retheme re-rasters
    // need it (see allSpecs above).
    for (const [id, spec] of allSpecs) {
      if (spec.done && !ctx.byId(id)) allSpecs.delete(id);
    }
    // re-rasters made fresh images visible; while a modal scrim is up the icons
    // must fall back to dimmed glyphs or they float over the menu
    if (ctx.modalOpen()) setScrim(true);
  };

  // Slots INSIDE a floating layer (menu rows, dialogs, prompts) sit above the
  // scrim and keep their crisp rasters; `transparent-partial` also uses this to
  // keep their rasters opaque over the float's solid fill.
  const FLOAT_ROOT_IDS = new Set([
    "tfm-menu",
    "tfm-filemenu",
    "tfm-filemenu-sub",
    "tfm-prompt",
    "tfm-props",
    "tfm-conflict",
    "tfm-yesno",
    "tfm-pick",
    "tfm-bulkrename",
  ]);

  // narrowed view of the byId seam (see ../lib/node-like): only the members
  // the scrim touches. `fg` is a ColorInput because the seam hands back the
  // real renderable, whose fg IS a parsed RGBA once assigned a theme hex.
  type SlotNode = {
    id?: unknown;
    parent?: SlotNode | null;
    visible?: boolean;
    fg?: ColorInput;
    getChildren?: () => Iterable<SlotNode>;
  };

  const isFloatChild = (slot: SlotNode | null | undefined): boolean => {
    let cur: SlotNode | null | undefined = slot?.parent;
    while (cur) {
      if (typeof cur.id === "string" && FLOAT_ROOT_IDS.has(cur.id)) return true;
      cur = cur.parent;
    }
    return false;
  };

  const setScrim = (on: boolean) => {
    for (const spec of allSpecs.values()) {
      const slot: SlotNode | null | undefined = ctx.byId(spec.slotId);
      if (!slot) continue;
      if (on && isFloatChild(slot)) continue;
      const kids = [...(slot.getChildren?.() ?? [])];
      const glyphNode = kids.find((k) => k.id === `${spec.slotId}-g`);
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
  const escHintBtn = (id: string, onClose: () => void): SlotElement => {
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
        const n = ctx.byId(id);
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
        // move, not over: a rebuild under a stationary cursor re-fires
        // synthetic "over" (same trap as settings rows)
        onMouseMove: () => paint(true),
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
      // boot-baked slots may have already drained and left the pending set —
      // the registry keeps them reachable for theme/resize re-rasters (the
      // old second queue grew unbounded; allSpecs prunes by node-liveness)
      for (const s of allSpecs.values()) s.done = false;
    },
    pushThumbJob: (job: ThumbJob): void => {
      if (ctx.compatActive?.() || ctx.forceGlyph?.()) return;
      thumbJobs.push(job);
    },
  };
};
