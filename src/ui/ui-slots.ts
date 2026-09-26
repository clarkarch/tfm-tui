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
import { destroyChildren } from "../lib/uiutil";

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

// --- THE hover wiring for every mouse-driven button/row in the UI ---
// One implementation, because drift here is invisible until a user reports it:
// pages of widgets each hand-rolled their own pair and they disagreed.
//
// * Light up on `move`, clear on `out` — never `over`. OpenTUI fires
//   over/out only when the DEEPEST hit node changes, so (a) moving between a
//   button's own icon and its padding fires out→over, and (b) a rebuild under a
//   stationary cursor re-fires a synthetic "over" on the new node. Wiring the
//   highlight to "over" therefore desyncs from the real pointer; `move` bails
//   only on an actual pointer move and is the source of truth. The callbacks
//   still fire in the same event turn, so the out→move pair nets out to a
//   correctly-lit button before the frame renders — no flicker.
// * Guarded: the first move paints, the rest are no-ops. A bare
//   `onMouseMove: () => paint(true)` repaints every row in a list on every
//   pointer cell (an O(rows) full repaint per pixel).
// * Paint MUST cover both halves of a button: the baked raster state AND the
//   wrapper box surface. Opaque rasters bake their bg into the png, so a wrapper
//   that swaps only the raster leaves a stale square around it, while a wrapper
//   that swaps only the bg leaves the raster's own square on top; in glyph mode
//   the raster doesn't exist at all and only the wrapper bg can highlight.
//   See escHintBtn (ui-slots) for the reference implementation.
export const hoverEvents = (paint: (hover: boolean) => void) => {
  let on = false;
  return {
    onMouseMove: (): void => {
      if (on) return;
      on = true;
      paint(true);
    },
    onMouseOut: (): void => {
      if (!on) return;
      on = false;
      paint(false);
    },
  };
};

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

// Identity of the file a thumb job represents for a slot. pushThumbJob stores
// this per slot; a drain re-checks it after the raster to reject a job whose
// slot was rebuilt for a different file (the stale-thumbnail guard). Replaces
// the old generation bail, which dropped live jobs on the floor.
export const thumbJobKey = (j: ThumbJob): string =>
  [j.path, j.mtimeMs, j.size, j.wCells, j.hCells ?? "", j.vector ? 1 : 0, j.video ? 1 : 0].join("|");

// How the mounted raster is fitted into its cell box. Raster/video rasters are
// either aspect-preserving (Bun.Image `fit:"inside"`) or exact-box (ffmpeg
// cover-crop; magick `^`+extent), so cover-crop them to fill the tile. SVG
// thumbs via resvg are ALSO aspect-preserving but must be CONTAINED (contain
// letterboxes; cover would crop the drawing's edges) — that was the old
// `fit:"fit"` behavior, restored here for vectors only.
export const thumbImageFit = (vector: boolean): "fit" | "cover" => (vector ? "fit" : "cover");

// --- Floating-layer roots ---
// A slot inside one of these is a FLOAT child. Two decisions hang off it: the
// raster keeps its alpha only OUTSIDE floats in `transparent-partial` (an opaque
// island must never blend the desktop through), and its flatten bg is the
// float's own fill rather than the canvas (see style.slotBg's role arg). The
// toast shell is per-instance (`tfm-toast-<n>`) — every other root id is a
// singleton, so those are exact matches and the toast is a prefix.
export const FLOAT_ROOT_IDS: ReadonlySet<string> = new Set([
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
export const FLOAT_TOAST_PREFIX = "tfm-toast-";

/** is `id` (or a toast's `tfm-toast-<n>`) a floating-layer root? */
export const isFloatRootId = (id: unknown): boolean =>
  typeof id === "string" && (FLOAT_ROOT_IDS.has(id) || id.startsWith(FLOAT_TOAST_PREFIX));

export type SlotsCtx = {
  renderer(): CliRenderer;
  byId(id: string): MaybeNode;
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
  // tty mode (linux console): skip every raster/thumb spawn, glyphs only.
  // force-glyph does the same on modern terminals with buggy kitty graphics
  // (view/anims/transparency untouched). Optional so test fakes keep working.
  isTtyMode?(): boolean;
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
  // per-slot ownership: pushThumbJob records the key of the job it queued for a
  // slot, so a drain that resolves the slot later can tell whether ITS job still
  // owns it. A rebuilt tile (new file, same `tfm-tile-N-thumb` id) re-pushes a
  // job and overwrites the key, which is how a stale in-flight raster is
  // rejected. This replaces the old "newer drain wins" generation bail, which
  // DROPPED the losing drain's jobs outright: a grid folder's thumbnails stayed
  // blank until the cwd changed, because renderGrid early-outs on an unchanged
  // listing and never re-pushed them.
  const thumbOwners = new Map<string, string>();
  // icon drains are SERIALIZED instead of superseded: several renderAll steps
  // each fire drainIconQueue (sidebar, the iconQueue step, the grid), and a
  // supersession token stranded every spec a losing drain had already marked
  // done — its rasters were destroyed on the way out and the winner's pending
  // snapshot (taken at its own start) never revisited them, so the whole top
  // bar stuck on fallback glyphs until a resize/theme reset. One run at a time
  // with a rerun flag can't lose a spec.
  let iconDrain: Promise<void> | null = null;
  let iconDrainAgain = false;
  // resetIconQueue (theme flip / resize / icon-mode change) marks every spec
  // for a re-raster even if an in-flight pass already claimed it
  let iconForceRedrain = false;

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
  // icon rasters are the same class of job as thumbs (one spawned renderer each)
  // — bound them too, so a full re-raster cannot launch hundreds of concurrent
  // jobs all at once (the process gate in icons.ts caps spawns, not native churn)
  const ICON_WORKERS = 8;

  const drainThumbs = async () => {
    const jobs = thumbJobs;
    thumbJobs = [];
    // drop the backlog (a rebuild re-queues what it needs if tty mode flips off)
    if (ctx.isTtyMode?.() || ctx.forceGlyph?.()) return;
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
          // stale guard: if the slot was rebuilt for another file, its re-pushed
          // job overwrote our ownership key — drop this raster instead of
          // painting the wrong thumbnail (or, worse, the old file's)
          if (!slot || thumbOwners.get(j.slotId) !== thumbJobKey(j)) {
            try {
              img.destroy?.();
            } catch {}
            continue;
          }
          // destroy, not detach: the replaced node (fallback glyph or a stale
          // raster) owns native memory that would otherwise wait for the GC poke
          destroyChildren(slot);
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

  // ONE pass over the specs pending at its start (or every spec after a reset).
  // Never runs concurrently with itself — drainIconQueue serializes it — so a
  // spec marked done here always gets its rasters attached (or genuinely fails).
  const runIconDrain = async (): Promise<void> => {
    const aspect = cellMetrics().aspect;
    const specs = [...allSpecs.values()];
    const pending = iconForceRedrain ? specs : specs.filter((s) => !s.done);
    iconForceRedrain = false;
    // bounded pool (like drainThumbs): a resize/theme flip re-rasters EVERY
    // registered slot, and an unbounded Promise.all launched one job per slot
    let idx = 0;
    const worker = async (): Promise<void> => {
      while (idx < pending.length) {
        const spec = pending[idx++];
        if (!spec) continue;
        spec.done = true;
        const slot = ctx.byId(spec.slotId);
        if (!slot) continue;
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
        if (imgs.length === 0) continue;
        slot.width = wCells;
        const kids = slot.getChildren();
        // drop previous rasters (e.g. after a resize re-raster at new cell
        // pixels) — DESTROY them, or each re-raster leaks their native buffers
        kids
          .filter((k) => typeof k.id === "string" && k.id.startsWith(`${spec.slotId}-s`))
          .forEach((k) => {
            try {
              slot.remove(k);
            } catch {}
            try {
              k.destroy();
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
      }
    };
    await Promise.all(Array.from({ length: Math.min(ICON_WORKERS, pending.length) }, () => worker()));
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

  // Serialized entry point: concurrent calls coalesce into the running pass
  // plus at most one rerun, so a spec is never left done-but-unrastered (the
  // old per-drain supersession token stranded exactly those).
  const drainIconQueue = (): Promise<void> => {
    if (ctx.isTtyMode?.() || ctx.forceGlyph?.()) return Promise.resolve();
    if (!ctx.renderer().resolution) return Promise.resolve();
    iconDrainAgain = true;
    if (!iconDrain) {
      iconDrain = (async () => {
        try {
          while (iconDrainAgain) {
            iconDrainAgain = false;
            await runIconDrain();
          }
        } finally {
          iconDrain = null;
        }
      })();
    }
    return iconDrain;
  };
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

  // walk up to the nearest floating-layer root (see isFloatRootId)
  const isFloatChild = (slot: SlotNode | null | undefined): boolean => {
    let cur: SlotNode | null | undefined = slot?.parent;
    while (cur) {
      if (isFloatRootId(cur.id)) return true;
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
  // an icon-slot widget, so it lives with the slot machinery. It is a FLOAT
  // child by default: its rest raster flattens onto the floating layer's fill
  // (style.slotBg role "float"), never onto the canvas, which would punch a
  // canvas-colored square into the panel. `chrome` opts out for the one caller
  // that is NOT a float (the terminal pane header).
  const escHintBtn = (id: string, onClose: () => void, opts?: { chrome?: boolean }): SlotElement => {
    const states = (): IconState[] => [
      {
        fg: ctx.colors().sidebarFgMuted,
        bg: slotBg(
          ctx.uiStyle() as UiStyle,
          ctx.colors() as Theme,
          ctx.colors().sidebarBg,
          opts?.chrome ? "chrome" : "float",
        ),
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
        ...hoverEvents(paint),
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
      // old second queue grew unbounded; allSpecs prunes by node-liveness).
      // iconForceRedrain also covers a pass that is mid-flight right now: the
      // rerun revisits EVERY spec even one the in-flight pass already claimed.
      for (const s of allSpecs.values()) s.done = false;
      iconForceRedrain = true;
      if (iconDrain) iconDrainAgain = true;
    },
    pushThumbJob: (job: ThumbJob): void => {
      if (ctx.isTtyMode?.() || ctx.forceGlyph?.()) return;
      thumbOwners.set(job.slotId, thumbJobKey(job));
      thumbJobs.push(job);
    },
  };
};
