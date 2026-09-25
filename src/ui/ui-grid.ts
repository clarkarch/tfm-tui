// --- Grid renderer: the async clear-and-rebuild of the file area plus the
// windowed slide. The tile/list-row builders live in ./ui-grid-rows and the
// pure window math in ./ui-grid-window; this module owns the REBUILD STATE
// MACHINE that drives them (gen counter, paint signatures, animation storm
// gate, deferred-reveal queue). Selection lives in ./selection and is
// preserved by path across rebuilds (vanished files drop, surviving keys keep
// their state). No module-level renderer imports — everything arrives via ctx
// (live getters for geometry). ---
import path from "node:path";
import { compareEntries, fillStatsInto, listDir, type Entry } from "../fs/listing";
import { searchTree } from "../fs/search";
import { fsErrText, isTrashFilesDir } from "../fs/fsutil";
import type { Renderable } from "@opentui/core";
import { RECENT_URI, STARRED_URI } from "../fs/uri";
import { fmtBytes } from "../fs/propsinfo";
import { clearChildren } from "../lib/uiutil";
import type { Scheduler } from "../lib/uiutil";
import { TileVisual } from "../input/grid-input";
import type { FileAnimMode } from "./ui-grid-anim";
import { fmtDateShort, loadingNodeId, makeGridBuilders, thumbStatsChanged } from "./ui-grid-rows";
import type { ScrollerLike } from "../lib/node-like";
import type { GridRendererCtx } from "./ui-grid-types";
import { visibleBottomRow, visibleTileCap, windowRange } from "./ui-grid-window";

// Re-exported façade: the split moved these out, but they are part of this
// module's public surface (wiring + the grid test import them from here).
export type { GridState } from "./ui-grid-types";
export { thumbStatsChanged } from "./ui-grid-rows";
export { hookScrollerScroll, visibleBottomRow, visibleTileCap } from "./ui-grid-window";

// minimum gap between two entry-animation waves in the SAME listing context;
// a faster rebuild still repaints, it just doesn't restart the wave (see
// lastPlayAt). Keyed on cwd/query/sort/view — navigating to a different folder
// is a new intro, not a storm, and must animate immediately.
export const PLAY_COOLDOWN_MS = 500;

// [ui] loading-delay-ms: how long a listing may take before the pane swaps its
// stale tiles for the spinner placeholder. The pane deliberately does NOT blank
// on a rebuild (clearing before the paint stranded it — the pane-claim
// invariant below), which left a slow folder showing the PREVIOUS folder's
// files with no feedback: it reads as a frozen app. 0 = clear immediately.
// A navigation that costs more than this logs one line to the debug log with
// its three real components (list / park / build). The console's old 2s park
// was invisible in a report until a raw asciinema cast was measured by hand.
export const SLOW_NAV_MS = 80;

export const SPIN_MS = 110;
// braille on a graphics terminal; the VT console font has no braille block, so
// tty mode gets the same 4-frame ASCII idiom install.sh uses
export const SPIN_FRAMES_BRAILLE = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
export const SPIN_FRAMES_ASCII = ["|", "/", "-", "\\"];

// the placeholder's caption: WHICH folder is being opened (or that a recursive
// search is walking, which has no listing to show until it finishes)
export const loadingLabel = (cwd: string, q: string, recursive: boolean): string => {
  if (q.length > 0 && recursive) return "searching…";
  const name =
    cwd === RECENT_URI
      ? "recent files"
      : cwd === STARRED_URI
        ? "starred"
        : isTrashFilesDir(cwd)
          ? "trash"
          : path.basename(cwd) || cwd;
  return `loading ${name}…`;
};

// pure: the painted spinner line, clamped to the pane so a long folder name
// can't overflow into the neighbouring pane
export const loadingLine = (frame: string, msg: string, width: number): string => {
  const max = Math.max(8, width);
  const text = msg.length > max - 2 ? `${msg.slice(0, Math.max(1, max - 3))}…` : msg;
  return `${frame} ${text}`;
};

export const makeGridRenderer = (ctx: GridRendererCtx) => {
  let gridGen = 0;
  // signature of the last painted tile set — an unchanged pane skips the
  // clear+rebuild (renderAll repaints both panes on any navigation)
  let lastSig = "";
  // Animation gate: rebuilds also fire for pure layout/geometry changes (hover
  // drawer collapse, dual-pane toggle, resize, theme flip) which must NOT replay
  // the entry animation — the tiles rebuilt for the same files, they didn't
  // appear. Only a content change (cwd/list/query/sort/view) animates.
  let lastContentSig: string | null = null;
  // Stats-only fast path (busy-log dirs): membership+order without size/mtime,
  // plus a stats snapshot for the thumb guard. A tick that moves only stats
  // repaints the list stat cells in place — no clear+rebuild, no anim replay.
  let lastStructuralSig: string | null = null;
  let lastEntries: Entry[] | null = null;
  // storm coalescing: a rebuild storm (rotation bursts on a slow VT) must not
  // restart the entry wave per rebuild — a wave that never completes reads as
  // invisible files. Plays inside the cooldown after the previous play are
  // skipped (the grid still rebuilds; only the animation is dropped). Keyed on
  // the listing CONTEXT (cwd/query/sort/view): navigating within the cooldown
  // is a new folder intro, not a storm, and must animate.
  let lastPlayAt: number | null = null;
  let lastPlayKey: string | null = null;
  // in-flight recursive search; a newer render aborts it so stale keystroke
  // walks don't keep eating disk while a fresh query runs
  let searchAbort: AbortController | null = null;
  // last windowed build (null = full build / nothing painted): the cached
  // entry list + row range syncWindow() slides against — a slide NEVER
  // re-lists, it rebuilds rows from this snapshot
  let win: {
    entries: Entry[];
    isList: boolean;
    cols: number;
    rowH: number;
    rows: number;
    r0: number;
    r1: number;
    // last synced VISIBLE row range (the build window leads it by the
    // overscan row) — the scroll-reveal fires on rows crossing THIS, not the
    // build edge, or every reveal would animate off-screen and arrive settled
    vis: { top: number; bottom: number };
  } | null = null;
  // [ui] file-animation-scroll-reveal-delay-ms: deferred reveal state. A fast
  // fling crosses a row per notch; playing every notch retriggers the wave
  // mid-flight (nothing completes visibly) and pays native pushes per frame.
  // Each slide MERGES its crossing into a pending set and re-arms a trailing
  // timer — one play per pause, over the union. The timer is DROPPED (never
  // flushed) on clearGrid/fallback, so a stale play can never stop() the new
  // folder's intro wave after a navigate or a fling landing.
  let revealTimer: unknown = null;
  let pendingReveal: {
    rows: string[];
    tiles: string[];
    from: "top" | "bottom";
    staged: Renderable[];
  } | null = null;
  const cancelPendingReveal = (): void => {
    const sched: Scheduler = ctx.sched ?? globalThis;
    if (revealTimer) {
      try {
        sched.clearTimeout(revealTimer);
      } catch {}
      revealTimer = null;
    }
    // staged rows sit at frame-0 opacity waiting for a wave that will now
    // never come — put them back to rest, or they stay invisible until the
    // next rebuild. On fallback/clearGrid the nodes are already dead or
    // dying; the try/catch makes that a harmless no-op.
    const staged = pendingReveal?.staged ?? [];
    pendingReveal = null;
    for (const n of staged) {
      try {
        n.opacity = 1;
      } catch {}
    }
  };
  const flushReveal = (): void => {
    revealTimer = null;
    const p = pendingReveal;
    pendingReveal = null;
    if (!p || (p.rows.length === 0 && p.tiles.length === 0)) return;
    let mode: FileAnimMode = null;
    try {
      mode = ctx.fileAnim({
        tiles: p.tiles,
        rows: p.rows,
        rowsTotal: p.rows.length,
        total: p.tiles.length,
        enterFrom: p.from,
      });
    } catch {}
    // Reconcile the mount-time ROW staging with the set the animator
    // actually drives: "rows" keeps the staged rows (the wave fades
    // exactly them in — releasing here would blink them to rest).
    // Anything else releases: "tiles" rides the row-granularity knob off
    // (a row at opacity 0 would hide per-file children — the tiles
    // self-stage via play's frame-0 pass, same as the delay-0 path),
    // null = no wave at all (master off / maxFiles skip — without this
    // the rows would strand invisible until the next rebuild).
    if (mode !== "rows") {
      for (const n of p.staged) {
        try {
          n.opacity = 1;
        } catch {}
      }
    }
  };
  const { selection } = ctx;
  // the builders own the tile/list-row/row constructors and the id + geometry
  // helpers derived from ctx; the state machine below drives them
  const { tilePrefix, availW, rowH, entryKey, registerRef, buildEmptyPane, buildLoadingPane, buildRow, buildInner } =
    makeGridBuilders(ctx);

  // The pane is NOT showing the listing the signatures describe (it was cleared
  // by a render whose build then threw, or that never got to build). Drop the
  // claim: the next render must rebuild instead of early-outing on a signature
  // that no longer matches the screen — otherwise the pane stays empty until
  // the cwd/geometry moves the signature (the console's blank-list bug).
  const dropPaintClaim = (): void => {
    lastSig = "";
    lastStructuralSig = null;
    lastEntries = null;
    lastContentSig = null;
    // the screen is NOT the claimed listing either — force the next render to
    // re-decide, placeholder included (a blank pane plus a slow listing must
    // arm the placeholder again)
    lastPaintedCtx = null;
    showingLoading = false;
    cancelLoadingTimers();
  };

  // --- [ui] loading-delay-ms placeholder ------------------------------------
  // `showingLoading` is the ONE piece of state that says the screen is not
  // what lastSig describes: every early-out must honour it or the placeholder
  // survives until the cwd moves (the blank-pane class, in a new shape).
  let showingLoading = false;
  // listing context of the pane the signatures describe (arm the placeholder
  // exactly when the on-screen context stops matching the requested one)
  let lastPaintedCtx: string | null = null;
  let loadingTimer: unknown = null;
  let spinTimer: unknown = null;

  // The armed timer and the spinner tick belong to the render that started
  // them: any real paint, any superseding render that ends without painting,
  // and clearGrid all drop them — a stranded tick would repaint "loading…"
  // over a fresh listing.
  function cancelLoadingTimers(): void {
    const sched: Scheduler = ctx.sched ?? globalThis;
    if (loadingTimer !== null) {
      try {
        sched.clearTimeout(loadingTimer);
      } catch {}
      loadingTimer = null;
    }
    if (spinTimer !== null) {
      try {
        sched.clearTimeout(spinTimer);
      } catch {}
      spinTimer = null;
    }
  }

  const clearGrid = (): void => {
    // a pending deferred reveal belongs to the OLD listing — drop it before
    // anything else, or its late fire stops the new folder's intro wave
    cancelPendingReveal();
    // same for the loading placeholder this pane may be showing: the screen is
    // about to be repainted for real
    cancelLoadingTimers();
    const scroller = ctx.scroller();
    if (!scroller) return;
    win = null;
    // stop any in-flight file animation BEFORE the nodes it targets are
    // destroyed — a frame callback writing opacity/translateY to a just-removed
    // renderable is the use-after-destroy path
    try {
      ctx.fileAnim({ tiles: [], inner: null });
    } catch {}
    clearChildren(scroller.content);
    selection.tileRefs.clear();
  };

  // Paint the placeholder. It writes NO claim (see claimPaint): the render that
  // eventually lands must still rebuild, and a render whose signature happens
  // to match the OLD listing must not early-out onto this screen.
  const paintLoading = (gen: number, msg: string): void => {
    if (gen !== gridGen || showingLoading) return;
    // never yank a live inline rename/create edit for a placeholder
    if (ctx.isRenaming?.()) return;
    ctx.clearRenameEdit();
    clearGrid();
    showingLoading = true;
    const frames = ctx.isTtyMode?.() ? SPIN_FRAMES_ASCII : SPIN_FRAMES_BRAILLE;
    const width = (ctx.availW ? ctx.availW() : ctx.termW() - ctx.sw()) - 4;
    const first = frames[0] ?? "";
    buildLoadingPane(loadingLine(first, msg, width));
    // no tiles to navigate: drop the old listing's nav geometry or arrows move
    // against phantom refs (same contract as the empty-pane path)
    selection.setFocusKeys([]);
    selection.setCols(1);
    selection.setRowH(ctx.viewMode() === "list" ? rowH() : ctx.tileH());
    // one text node rewritten in place per tick — no rebuild, no native churn
    const sched: Scheduler = ctx.sched ?? globalThis;
    const nodeId = loadingNodeId(tilePrefix());
    let i = 0;
    const tick = (): void => {
      spinTimer = null;
      if (!showingLoading || gen !== gridGen) return;
      i = (i + 1) % frames.length;
      ctx.setTextOnId?.(nodeId, loadingLine(frames[i] ?? first, msg, width));
      try {
        spinTimer = sched.setTimeout(tick, SPIN_MS);
      } catch {
        spinTimer = null;
      }
    };
    try {
      spinTimer = sched.setTimeout(tick, SPIN_MS);
    } catch {
      spinTimer = null;
    }
  };

  // Arm (or, at delay 0, paint) the placeholder for a render whose listing
  // context no longer matches the screen. Absent seam = feature off (test fakes
  // keep the old "old tiles stay put" behavior).
  const armLoading = (gen: number, cwd: string, q: string, recursive: boolean): void => {
    const delay = ctx.loadingDelayMs?.();
    if (delay === undefined || !Number.isFinite(delay) || delay > 60_000) return;
    const msg = loadingLabel(cwd, q, recursive);
    if (delay <= 0) {
      paintLoading(gen, msg);
      return;
    }
    cancelLoadingTimers();
    const sched: Scheduler = ctx.sched ?? globalThis;
    try {
      loadingTimer = sched.setTimeout(() => {
        loadingTimer = null;
        paintLoading(gen, msg);
      }, delay);
    } catch {
      loadingTimer = null;
    }
  };

  // the scroller's LIVE viewport in cell rows — NOT ctx.termH(): chrome
  // (toolbar/tabs/status) eats several terminal rows, so the full height
  // overstates how many grid rows are on screen (the bottom reveal fired a
  // row early, off-screen — the "only the top animates" bug). The ScrollBox
  // clamps scroll against this same number (updateStickyState).
  const visH = (scroller: ScrollerLike): number => {
    const vh = scroller?.viewport?.height;
    return typeof vh === "number" && vh > 0 ? vh : ctx.termH();
  };

  // empty-pane icon follows the place: virtual places and the trash show
  // their sidebar icon (clock/star/trash-can) instead of the generic folder,
  // and a fruitless search shows the search icon
  const emptyPaneIcon = (cwd: string, hasQuery: boolean): string =>
    hasQuery
      ? "search"
      : cwd === RECENT_URI
        ? "clock"
        : cwd === STARRED_URI
          ? "star"
          : isTrashFilesDir(cwd)
            ? "trash-can"
            : "folder";

  // --- grid rebuild: clear, list, lay out tiles/rows, repaint cut dims.
  // `force` skips the unchanged-signature fast path (out-of-band state changes
  // like the cut clipboard; navigation does not force). ---
  const renderGrid = async (force = false): Promise<void> => {
    const tStart = performance.now();
    const scroller = ctx.scroller();
    if (!scroller) return;
    const gen = ++gridGen;
    // cancel any in-flight recursive search: the previous query's fd walk must
    // not keep running behind this render (navigate/clear/retype all land here)
    searchAbort?.abort();
    searchAbort = null;
    const state = ctx.state;
    // selection must survive rebuilds by path — a busy cwd (and /tmp on this
    // box, which contains our own dnd log) re-renders constantly; wiping it
    // made selection vanish mid-interaction. Vanished files drop naturally:
    // restore only touches keys still present in the new tile set.
    const prevSel = new Set<string>();
    selection.tileRefs.forEach((r, k) => {
      if (r.selected) prevSel.add(k);
    });
    const prevFocusKey = selection.focusKeys()[selection.focusIdx()] ?? null;
    const anchorIdx = selection.selAnchor();
    const prevAnchorKey = anchorIdx === null ? null : (selection.focusKeys()[anchorIdx] ?? null);
    const isList = ctx.viewMode() === "list";
    // a rebuild destroys the edit input; dropped once we actually rebuild (a
    // skipped render leaves an in-progress rename/edit alone)
    const q = ctx.searchQuery().trim().toLowerCase();
    // recursive search replaces the listing with subtree matches; virtual
    // places have no fs root to walk, so they keep the in-dir filter
    const recursive = q.length > 0 && ctx.recursiveSearch() && state.cwd !== RECENT_URI && state.cwd !== STARRED_URI;
    // Signature of everything that affects the painted tiles. renderAll repaints
    // BOTH panes on any navigation, so without this a move in one pane visibly
    // rebuilds the other (and churns native buffers). Empty/error states sign
    // separately; theme/geometry/search changes move the signature too.
    const baseSigParts = (): unknown[] => [
      state.cwd,
      state.showHidden,
      state.sortBy,
      state.sortAsc,
      ctx.viewMode(),
      ctx.wordWrap(),
      ctx.tileW(),
      ctx.tileH(),
      ctx.iconCells(),
      (() => {
        const o = ctx.hoverLiftOpts?.();
        // includeLabel rides live in the animator — no rebuild needed
        return JSON.stringify([o?.enabled ?? false, o?.direction ?? "up"]);
      })(),
      ctx.termW(),
      ctx.termH(),
      ctx.availW?.() ?? 0,
      q,
      recursive,
      ctx.pathEditMode(),
      ctx.tileIdPrefix ?? "",
      state.pendingSelect ?? "",
      // a windowed-grid flip changes which nodes exist — must rebuild; so
      // does list-row-height (the list builders read rowH() live, and the
      // win cache/anim window math must not lag it)
      ctx.windowedGrid?.() ?? false,
      ctx.listRowH(),
      ctx.colors(),
      ctx.rasterSig?.() ?? "",
    ];
    // listing CONTEXT of this render, no entry list: the placeholder is armed
    // exactly when the screen stops describing this request (cwd/query/sort/
    // geometry/raster mode — anything that makes the painted tiles wrong)
    const ctxKey = JSON.stringify(baseSigParts());
    const sigOf = (list: Entry[] | string): string =>
      JSON.stringify([
        ...baseSigParts(),
        typeof list === "string" ? list : list.map((e) => `${e.name}\u0000${e.size ?? ""}\u0000${e.mtimeMs ?? ""}`),
      ]);
    // The pane is showing THIS listing now — claim it. NEVER call before the
    // paint (see dropPaintClaim) and never from the placeholder: a claim for a
    // screen the pane isn't showing strands it until the cwd moves. NOTE: the
    // main path must NOT write lastContentSig here — the intro-wave gate below
    // compares it against the previous build.
    const claimPaint = (s: string, structural: string, list: Entry[] | null): void => {
      lastSig = s;
      lastStructuralSig = structural;
      lastEntries = list ? list.map((e) => ({ ...e })) : null;
      lastPaintedCtx = ctxKey;
      showingLoading = false;
      cancelLoadingTimers();
    };
    // a render that ends without painting: its armed placeholder must not fire
    // over the screen that is already correct
    const abandonPaint = (): void => {
      cancelLoadingTimers();
    };
    // membership + order WITHOUT size/mtime — and WITH isDir, which the full
    // signature never carried (a symlink retarget dir↔file with identical
    // stats wrongly skipped the rebuild before). A tick that moves this
    // rebuilds; one that moves only stats takes the in-place fast path.
    const structOf = (list: Entry[] | string): string =>
      JSON.stringify([
        ...baseSigParts(),
        typeof list === "string" ? list : list.map((e) => `${e.name}\u0000${e.isDir ? 1 : 0}`),
      ]);
    // content-only signature: what the animation keys off (the listed files +
    // how they're shown), WITHOUT geometry/theme — layout-only rebuilds keep it
    const contentSigOf = (list: Entry[] | string): string =>
      JSON.stringify([
        state.cwd,
        state.showHidden,
        state.sortBy,
        state.sortAsc,
        ctx.viewMode(),
        ctx.wordWrap(),
        q,
        recursive,
        typeof list === "string" ? list : list.map((e) => `${e.name}\u0000${e.size ?? ""}\u0000${e.mtimeMs ?? ""}`),
      ]);
    // [ui] loading-delay-ms: the screen no longer matches this request. Give
    // the listing the delay to arrive, then swap the stale tiles for the
    // spinner placeholder. A same-context rebuild (watcher tick, hover-drawer
    // settle) needs none of this — the painted folder is already the right one.
    if (!showingLoading && ctxKey !== lastPaintedCtx) armLoading(gen, state.cwd, q, recursive);
    let allEntries: Entry[];
    try {
      if (recursive) {
        const ac = new AbortController();
        searchAbort = ac;
        // honor the show-hidden toggle: skipping hidden dirs keeps fd out of
        // .git/.cache, which dominate the walk on large trees
        allEntries = await (ctx.searchTree ?? searchTree)(state.cwd, q, {
          hidden: state.showHidden,
          signal: ac.signal,
        });
        // release the slot only if a newer render didn't already replace it
        if (searchAbort === ac) searchAbort = null;
        // stable display: name order, dirs first
        allEntries.sort(compareEntries("name", true));
      } else {
        allEntries = await listDir(state.cwd, state.showHidden, state.sortBy, state.sortAsc, {
          cache: ctx.listingsCache?.() ?? true,
          cacheStats: ctx.listingsCacheStats?.() ?? true,
          ttlMs: ctx.listingsCacheTtlMs?.(),
        });
      }
    } catch (err) {
      // restricted dir (/root, foreign 000 dirs): say why instead of a blank pane
      if (gen !== gridGen) return;
      const sig = sigOf(`err:${fsErrText(err)}`);
      // `showingLoading` gate: the pane is the PLACEHOLDER, not the claimed
      // listing, so a matching signature must still rebuild the screen
      if (!force && sig === lastSig && !showingLoading) {
        abandonPaint();
        return;
      }
      // park BEFORE destroying the pane (see the main path): a render that gets
      // superseded inside this wait must bail with the old screen intact
      await ctx.waitForResolution();
      if (gen !== gridGen) return;
      ctx.clearRenameEdit();
      clearGrid();
      try {
        buildEmptyPane("close", [
          `can't open this folder (${fsErrText(err)})`,
          ctx.pathEditMode() ? "" : "edit the path above to go elsewhere",
        ]);
        // the claim is written only now that the pane actually shows it
        claimPaint(sig, structOf(`err:${fsErrText(err)}`), null);
        lastContentSig = contentSigOf(`err:${fsErrText(err)}`);
        ctx.stripSelectable();
        // no tiles to navigate: clear the old listing's nav geometry or arrows
        // consume keys against a phantom list (focusKeys still holds the previous
        // folder's paths with emptied tileRefs)
        selection.setFocusKeys([]);
        selection.setCols(1);
        selection.setRowH(ctx.viewMode() === "list" ? rowH() : ctx.tileH());
      } catch (buildErr) {
        dropPaintClaim();
        ctx.log?.(`grid: rebuild failed: ${buildErr instanceof Error ? buildErr.message : buildErr}`);
      }
      void ctx.drainIconQueue();
      return;
    }
    const entries = q && !recursive ? allEntries.filter((e) => e.name.toLowerCase().includes(q)) : allEntries;
    const listMs = performance.now() - tStart;
    if (gen !== gridGen) return;

    if (entries.length === 0) {
      const sig = sigOf("empty");
      if (!force && sig === lastSig && !showingLoading) {
        abandonPaint();
        return;
      }
      // park BEFORE destroying the pane (see the main path)
      await ctx.waitForResolution();
      if (gen !== gridGen) return;
      ctx.clearRenameEdit();
      clearGrid();
      try {
        buildEmptyPane(emptyPaneIcon(state.cwd, q.length > 0), [
          q
            ? "no matches"
            : state.cwd === RECENT_URI
              ? "no recent files"
              : state.cwd === STARRED_URI
                ? "nothing starred yet"
                : "this folder is empty",
        ]);
        // the claim is written only now that the pane actually shows it
        claimPaint(sig, structOf("empty"), null);
        lastContentSig = contentSigOf("empty");
        // no tiles to navigate: drop the previous listing's focusKeys/cols/rowH
        selection.setFocusKeys([]);
        selection.setCols(1);
        selection.setRowH(isList ? rowH() : ctx.tileH());
      } catch (buildErr) {
        dropPaintClaim();
        ctx.log?.(`grid: rebuild failed: ${buildErr instanceof Error ? buildErr.message : buildErr}`);
      }
      void ctx.drainIconQueue();
      return;
    }

    // list view always shows size + modified columns, so fetch whatever stats
    // the active sort mode didn't already populate BEFORE signing (a size/mtime
    // change must move the signature). Batched + awaited (./listing
    // fillStatsInto): the old blocking statSync loop froze the frame loop, and
    // tty mode forces list view — the console felt dead on big folders.
    if (isList) await fillStatsInto(entries, state.cwd);
    // the fill is the one await between the listing and the signature: a newer
    // render inside it owns the refs and the pane (same rule as the entry
    // computation above and the park below)
    if (gen !== gridGen) return;

    const sig = sigOf(entries);
    if (!force && sig === lastSig && !showingLoading) {
      abandonPaint();
      return;
    }
    // stats-only tick (busy-log dirs): same membership + order, only size/mtime
    // moved — repaint the list stat cells in place instead of clear+rebuild
    // (the TTY full-flash loop). No animation: nothing appeared. Skipped when
    // the seam is absent (old fakes keep the rebuild), when a thumbnailed
    // image/video changed stats (its raster keys on them — rebuild re-queues),
    // and under force (cut-clipboard dimming needs the rebuild).
    // ... and never while the pane shows the placeholder: the stat cells it
    // would rewrite don't exist (no claim is written for a placeholder)
    if (!force && !showingLoading && ctx.setTextOnId && lastStructuralSig !== null) {
      const structural = structOf(entries);
      if (structural === lastStructuralSig && !thumbStatsChanged(lastEntries, entries)) {
        claimPaint(sig, structural, entries);
        lastContentSig = contentSigOf(entries);
        // later window slides build rows from this snapshot — carry the stats
        if (win) {
          for (let i = 0; i < win.entries.length && i < entries.length; i++) {
            const we = win.entries[i];
            const e = entries[i];
            if (!we || !e) continue;
            we.size = e.size;
            we.mtimeMs = e.mtimeMs;
          }
        }
        if (isList) {
          for (let i = 0; i < entries.length; i++) {
            const e = entries[i];
            if (!e) continue;
            ctx.setTextOnId(`${tilePrefix()}${i}-size`, e.isDir ? "" : fmtBytes(e.size ?? 0).padStart(9));
            ctx.setTextOnId(`${tilePrefix()}${i}-date`, fmtDateShort(e.mtimeMs));
          }
        }
        return;
      }
    }
    // Park for real cell pixels BEFORE destroying the pane: the console's null
    // renderer.resolution parks for seconds per poll, and a render superseded
    // inside this wait must bail with the PREVIOUS listing still on screen.
    // Clearing first while the paint claim was already written left the pane
    // blank until the cwd changed — every later render early-outed on a
    // signature describing a screen that no longer existed.
    const tPark = performance.now();
    await ctx.waitForResolution();
    const parkMs = performance.now() - tPark;
    if (gen !== gridGen) return;
    ctx.clearRenameEdit();
    clearGrid();
    const tBuild = performance.now();
    // Past this point the build is SYNCHRONOUS (the drains are fire-and-forget),
    // so no newer render can start between the clear and the paint: the pane can
    // never be left empty, and the claim written at the END describes exactly
    // what is on screen. The guard is for a THROWING build (native allocation
    // failures are real on a loaded box) — the pane is cleared and unbuilt then,
    // so the claim must be dropped or the next render early-outs for good.
    let painted = false;
    try {
      const TILE_H = ctx.tileH();
      const cols = isList ? 1 : Math.max(1, Math.floor((availW() - 3) / ctx.tileW()));
      const rowHgt = isList ? rowH() : TILE_H;
      const totalRows = isList ? entries.length : Math.ceil(entries.length / cols);

      // [ui] windowed-grid: build only the visible row window (+overscan); the
      // scroller scroll hook slides it. A windowed build costs O(screen) nodes
      // no matter the folder size; a plain build stays byte-identical to before.
      const windowed = ctx.windowedGrid?.() ?? false;
      const scrollTop = Math.max(0, scroller.scrollTop ?? 0);
      const { firstRow, r0: wr0, r1: wr1 } = windowRange(scrollTop, rowHgt, totalRows, ctx.termH());
      const r0 = windowed ? wr0 : 0;
      const r1 = windowed ? wr1 : totalRows - 1;
      // viewport window for thumb-job ranking: `visibleTileCap` tiles starting
      // wherever the scroller sits (a hover-drawer settle rebuilds mid-scroll;
      // a folder change always starts at 0) — visible thumbs raster FIRST,
      // off-screen backlog last, so the first screenful lands before the tail
      const visFirst = isList ? firstRow : firstRow * cols;
      // register EVERY entry first — the full tileRefs/focusKeys list is the
      // selection's contract; built rows overwrite their minimal ref in place.
      for (let i = 0; i < entries.length; i++) {
        const e = entries[i];
        if (e) registerRef(e, i);
      }

      // the container `slide` animates (and holds the row window + pads) — its
      // id is absolute so it resolves across slides
      const innerId = `${tilePrefix()}inner`;
      scroller.content.add(buildInner(entries, isList, cols, rowHgt, totalRows, r0, r1, visFirst, windowed));
      win = windowed
        ? {
            entries,
            isList,
            cols,
            rowH: rowHgt,
            rows: totalRows,
            r0,
            r1,
            vis: { top: firstRow, bottom: visibleBottomRow(scrollTop, visH(scroller), rowHgt, totalRows) },
          }
        : null;
      // grid-view ROW ids for the row-granularity cascade (see the handoff
      // below): the FULL absolute list — un-built windowed rows resolve to
      // nothing in the animator but keep the cascade timing aligned by index.
      const rowIds: string[] = isList ? [] : Array.from({ length: totalRows }, (_, r) => `${tilePrefix()}row-${r}`);

      // cut (pending-move) tiles render dimmed; apply after mount so id lookups work
      selection.tileRefs.forEach((_ref, key) => {
        if (ctx.isCutKey(key)) selection.setTileVisual(key, TileVisual.Rest);
      });

      // fresh Text nodes default selectable=true; strip AFTER the async rebuild or
      // the renderer's text-selection drag hijacks file-drag events
      ctx.stripSelectable();
      void ctx.drainIconQueue();
      void ctx.drainThumbs();
      selection.setFocusKeys([...selection.tileRefs.keys()]);
      // restore the pre-rebuild selection/focus by path (stale gen = newer
      // render owns the refs — never restore into it; unreachable while the block
      // above stays synchronous, but a claim for an unbuilt pane must not survive)
      if (gen !== gridGen) {
        dropPaintClaim();
        return;
      }
      selection.tileRefs.forEach((ref, key) => {
        if (prevSel.has(key)) {
          ref.selected = true;
          selection.setTileVisual(key, TileVisual.Selected);
        }
      });
      const focusKeyIdx = prevFocusKey ? selection.focusKeys().indexOf(prevFocusKey) : -1;
      selection.setFocusIdx(focusKeyIdx);
      const anchorNewIdx = prevAnchorKey === null ? -1 : selection.focusKeys().indexOf(prevAnchorKey);
      selection.setSelAnchor(anchorNewIdx < 0 ? null : anchorNewIdx);
      selection.setCols(cols);
      selection.setRowH(isList ? rowH() : TILE_H);
      // one-shot launch-file highlight (`tfm some/file.txt`): after the first
      // build, select the tile whose key is that path, then clear the request
      if (state.pendingSelect) {
        const pending = state.pendingSelect;
        state.pendingSelect = null;
        const idx = selection.focusKeys().indexOf(pending);
        if (idx >= 0) selection.selectTileAt(idx);
      }
      selection.updateSelectionStatusReal();
      // the pane now shows this listing — claim it (never before the paint)
      claimPaint(sig, structOf(entries), entries);
      painted = true;
      // slow-navigation breadcrumb (always on, one line, only when slow): a
      // report of "it feels stuck" names its own culprit without --debug
      const buildMs = performance.now() - tBuild;
      if (listMs + parkMs + buildMs > SLOW_NAV_MS) {
        ctx.log?.(
          `grid: ${isList ? "list" : "grid"} n=${entries.length} list=${Math.round(listMs)}ms park=${Math.round(parkMs)}ms build=${Math.round(buildMs)}ms`,
        );
      }
      // animate the new tiles in (tileRefs is in display order); the animator
      // reads [ui] file-animation live and snaps everything to rest when off.
      // Only a CONTENT change animates — a layout-only rebuild (hover drawer,
      // dual-pane toggle, resize, theme flip) rebuilt the same files and must
      // not replay it. The very first build (lastContentSig null) IS content
      // appearing, so it animates — that's the boot intro.
      if (gen === gridGen) {
        const contentSig = contentSigOf(entries);
        const contentChanged = lastContentSig === null || contentSig !== lastContentSig;
        lastContentSig = contentSig;
        if (contentChanged) {
          // storm gate: a rebuild inside the cooldown after the previous wave
          // repaints but doesn't restart it — overlapping waves on a slow VT
          // never complete and read as invisible files. The stop call in
          // clearGrid above already ran, so nothing in-flight is stranded.
          // A DIFFERENT listing context (navigation/query/sort/view) is a new
          // intro, not a storm: it plays regardless of the cooldown.
          const playKey = `${state.cwd}\u0000${q}\u0000${state.sortBy}\u0000${state.sortAsc}\u0000${state.showHidden ? 1 : 0}\u0000${ctx.viewMode()}\u0000${recursive ? 1 : 0}`;
          const t = ctx.now ? ctx.now() : Date.now();
          if (playKey === lastPlayKey && lastPlayAt !== null && t - lastPlayAt < PLAY_COOLDOWN_MS) return;
          lastPlayAt = t;
          lastPlayKey = playKey;
          try {
            const ids = [...selection.tileRefs.values()].map((r) => r.tileId);
            // visible-only: off-screen tiles are never seen animating but each
            // per-frame opacity change costs a native push — cap the list to the
            // viewport (same window math as the thumb ranking) and keep the full
            // count for the cascade timing (the animator normalizes by `total`).
            // The slice starts at the SCROLL position (visFirst), not 0 — the old
            // head-slice animated off-screen top tiles while the visible ones
            // (scrolled deep into a big folder) never animated at all. With the
            // knob off, everything animates (both tiles and rows) — a mid-scroll
            // content change then animates the whole grid.
            const visibleOnly = ctx.fileAnimVisibleOnly();
            const cap = visibleOnly ? visibleTileCap(ctx.termH(), isList ? rowH() : TILE_H, cols) : ids.length;
            // list view: rows ARE tiles, hand none (the animator uses tiles);
            // grid view: slice rows with the same scroll-aligned window
            const rows = isList
              ? []
              : visibleOnly
                ? rowIds.slice(Math.floor(visFirst / cols), Math.floor(visFirst / cols) + Math.ceil(cap / cols))
                : rowIds;
            ctx.fileAnim({
              tiles: ids.slice(visibleOnly ? visFirst : 0, (visibleOnly ? visFirst : 0) + cap),
              rows,
              rowsTotal: rowIds.length,
              inner: innerId,
              total: ids.length,
            });
          } catch {}
        }
      }
    } catch (err) {
      if (!painted) dropPaintClaim();
      ctx.log?.(`grid: rebuild failed${painted ? " after paint" : ""}: ${err instanceof Error ? err.message : err}`);
    }
  };

  // [ui] windowed-grid slide: the wiring's scroller hook calls this after
  // EVERY scrollTop write (wheel, drag auto-scroll, scrollbar thumb drag,
  // keyboard scrollTo). INCREMENTAL is the whole point: rows that merely left
  // or entered the window are removed/added and the pads absorb the shift, so
  // a visible row's node NEVER dies mid-scroll — a full clear+rebuild here
  // would re-queue every icon slot through its fallback glyph on each notch
  // (the flicker this replaced). Only a fling PAST the built window rebuilds
  // it whole. Refs/focus/keys are untouched either way — the selection's
  // full-list contract holds across slides. No-op while the last build was a
  // full one (nothing to slide).
  const syncWindow = (): void => {
    if (!win) return;
    if (ctx.isRenaming?.()) return;
    const scroller = ctx.scroller();
    if (!scroller) return;
    const { entries, isList, cols, rowH: rh, rows } = win;
    const old = { r0: win.r0, r1: win.r1 };
    const scrollTop = Math.max(0, scroller.scrollTop ?? 0);
    const { firstRow, r0, r1 } = windowRange(scrollTop, rh, rows, ctx.termH());
    const visFirst = isList ? firstRow : firstRow * cols;
    // operate on the MOUNTED nodes (VNode proxies no-op post-mount): content
    // holds exactly [inner], inner exactly [pad-top, old.r0..old.r1, pad-bottom]
    const mounted = scroller.content.getChildren()[0];
    const kids: Renderable[] | null = mounted && r0 <= old.r1 + 1 && r1 >= old.r0 - 1 ? mounted.getChildren() : null;
    const slideable = !!kids && kids.length === old.r1 - old.r0 + 3;
    const paint = (a: number, b: number): void => {
      if (a > b) return;
      const lo = isList ? a : a * cols;
      const hi = Math.min(entries.length - 1, isList ? b : (b + 1) * cols - 1);
      for (let i = lo; i <= hi; i++) {
        const e = entries[i];
        if (!e) continue;
        const key = entryKey(e);
        const ref = selection.tileRefs.get(key);
        if (ref?.selected) selection.setTileVisual(key, TileVisual.Selected);
        else if (ctx.isCutKey(key)) selection.setTileVisual(key, TileVisual.Rest);
      }
    };
    // a sub-row notch leaves the built window in place but can still push a
    // partially visible row's TOP cell into view — the reveal below must run
    // for those too, not just for slides (the range-equality repeats stay
    // free: identical vis ranges cross nothing, so the animator is untouched)
    const windowMoved = r0 !== old.r0 || r1 !== old.r1;
    if (!slideable) {
      if (windowMoved) {
        // the nodes a running animation targets ALL die here — stop it BEFORE
        // destroying them (same use-after-destroy path as clearGrid); a fling
        // shows its landing spot instantly, unrevealed — and any deferred
        // reveal for the jumped-over rows is dropped, never flushed late
        cancelPendingReveal();
        try {
          ctx.fileAnim({ tiles: [], inner: null });
        } catch {}
        clearChildren(scroller.content);
        scroller.content.add(buildInner(entries, isList, cols, rh, rows, r0, r1, visFirst, true));
        paint(r0, r1);
      }
    } else if (mounted && kids) {
      if (windowMoved) {
        const kidAt = (r: number): Renderable | undefined => kids[1 + r - old.r0];
        for (let r = old.r0; r < r0; r++) {
          const k = kidAt(r);
          if (k) mounted.remove(k);
        }
        for (let r = old.r1; r > r1; r--) {
          const k = kidAt(r);
          if (k) mounted.remove(k);
        }
        for (let r = r0; r < old.r0; r++) mounted.add(buildRow(entries, isList, cols, rh, visFirst, r), 1 + (r - r0));
        for (let r = Math.max(r0, old.r1 + 1); r <= r1; r++)
          mounted.add(buildRow(entries, isList, cols, rh, visFirst, r), mounted.getChildren().length - 1);
        // pads absorb the shift so the total content height never moves (the
        // offsets above come from the pre-mutation snapshot — node identity,
        // stable across the adds/removes)
        const topPad = kids[0];
        const botPad = kids[kids.length - 1];
        if (topPad) topPad.height = r0 * rh;
        if (botPad) botPad.height = (rows - 1 - r1) * rh;
        paint(r0, Math.min(old.r0 - 1, r1));
        paint(Math.max(old.r1 + 1, r0), r1);
      }
    }
    // scroll-reveal: keyed to the VIEWPORT edge, not the build — the window
    // leads visibility by the overscan row, so revealing at build time faded
    // rows off-screen that then arrived already settled (the "reveal doesn't
    // work" bug). Rows crossing into view THIS notch animate now; a fling
    // (fallback rebuild) lands instantly, unrevealed. Always on while the
    // grid is windowed (syncWindow only runs on windowed builds) and gated
    // by the file-animation master inside play().
    // NO stop call around the slide: the animator appends to a still-running
    // wave, and detached-but-alive rows leave it safely (remove() only
    // detaches; writes are try/catch'd until the GC finalizer reclaims them).
    const visTop = firstRow;
    const visBottom = visibleBottomRow(scrollTop, visH(scroller), rh, rows);
    const oldVis = win.vis;
    if (slideable && mounted) {
      const crossing: number[] = [];
      let from: "top" | "bottom" | null = null;
      if (visBottom > oldVis.bottom) {
        for (let r = Math.max(oldVis.bottom + 1, r0); r <= Math.min(visBottom, r1); r++) crossing.push(r);
        from = "bottom";
      } else if (visTop < oldVis.top) {
        for (let r = Math.max(visTop, r0); r < Math.min(oldVis.top, r1 + 1); r++) crossing.push(r);
        from = "top";
      }
      if (from && crossing.length > 0) {
        const rvRows: string[] = [];
        const rvTiles: string[] = [];
        for (const r of crossing) {
          if (isList) rvTiles.push(`${tilePrefix()}${r}`);
          else {
            rvRows.push(`${tilePrefix()}row-${r}`);
            for (let i = r * cols; i < Math.min((r + 1) * cols, entries.length); i++)
              rvTiles.push(`${tilePrefix()}${i}`);
          }
        }
        const delay = ctx.fileAnimScrollRevealDelayMs?.() ?? 0;
        if (delay <= 0) {
          try {
            ctx.fileAnim({
              tiles: rvTiles,
              rows: rvRows,
              rowsTotal: rvRows.length,
              total: rvTiles.length,
              enterFrom: from,
            });
          } catch {}
        } else {
          // defer: merge into the pending union (a row can cross, leave and
          // re-cross inside one settle window on zigzag) and re-arm the
          // trailing timer — latest edge wins
          if (!pendingReveal) pendingReveal = { rows: [], tiles: [], from, staged: [] };
          const rowSet = new Set(pendingReveal.rows);
          const tileSet = new Set(pendingReveal.tiles);
          for (const id of rvRows) {
            if (!rowSet.has(id)) {
              rowSet.add(id);
              pendingReveal.rows.push(id);
            }
          }
          for (const id of rvTiles) {
            if (!tileSet.has(id)) {
              tileSet.add(id);
              pendingReveal.tiles.push(id);
            }
          }
          pendingReveal.from = from;
          // pre-stage the crossing rows at frame-0 opacity NOW: the wave
          // plays ~delay ms after they mount, and sitting at rest until
          // then snaps 1→0 on the first tick (visible → invisible →
          // fading = the flicker). Children of inner are [pad-top, rows
          // r0..r1, pad-bottom], so row r lives at index 1+(r-r0) — same
          // contract the slide itself relies on. try/catch: a row missing
          // here simply joins the wave unstaged (one-frame pop, not stuck).
          try {
            const kidsNow = mounted.getChildren();
            for (const r of crossing) {
              const node = kidsNow[1 + (r - r0)];
              if (!node || pendingReveal.staged.includes(node)) continue;
              try {
                node.opacity = 0;
              } catch {
                continue;
              }
              pendingReveal.staged.push(node);
            }
          } catch {}
          const sched: Scheduler = ctx.sched ?? globalThis;
          if (revealTimer) {
            try {
              sched.clearTimeout(revealTimer);
            } catch {}
            revealTimer = null;
          }
          try {
            revealTimer = sched.setTimeout(flushReveal, delay);
          } catch {}
        }
      }
    }
    win = { ...win, r0, r1, vis: { top: visTop, bottom: visBottom } };
    ctx.stripSelectable();
    void ctx.drainIconQueue();
    void ctx.drainThumbs();
    // pads keep the content height exact, so the offset survives untouched —
    // restore only after a slide moved the window (matches the io
    // drawer-settle pattern; the nested hook call range-checks equal and
    // returns). An unconditional write would recurse: the hook re-fires
    // syncWindow, which no longer early-returns on equal windows.
    try {
      if (windowMoved) scroller.scrollTop = scrollTop;
    } catch {}
  };

  return { renderGrid, syncWindow };
};
