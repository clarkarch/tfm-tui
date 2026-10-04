import {
  Box,
  type CliRenderer,
  CodeRenderable,
  detectLinks,
  LineNumberRenderable,
  MarkdownRenderable,
  ScrollBoxRenderable,
  Text,
  TextRenderable,
  TextTableRenderable,
  type SyntaxStyle,
} from "@opentui/core";
import { existsSync, readdirSync, statSync, type Stats } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { destroyChildren, debounced, type Scheduler } from "../lib/uiutil";
import { slotBg, type UiStyle } from "./style";
import { fileIconFor, fileIsImage, fileIsVideo } from "../fs/filetype";
import { isPrivilegeError } from "../fs/elevate";
import { canThumbVideo } from "./icons";
import type { ThumbJob } from "./ui-slots";
import { buildSyntaxStyle, isTextLike, PREVIEW_FT_BY_EXT, syntaxStyleSig } from "./syntax";
import type { Theme } from "../config/config";
import type { WrapMode } from "../config/config-schema";
import { scrollbarTrackColors } from "./ui-boot-layout";
import type { MaybeNode } from "../lib/node-like";

// --- Preview pane (right sidebar): image thumbs go through the shared
// thumb-job sink, text files render via CodeRenderable + tree-sitter
// (machinery in ./syntax.ts), directories get a header + entry count (full
// stats live in Properties…). ctx-seamed like ui-props/ui-term; the
// gen-counter guards stale async file reads so a slow preview can't paint
// over a newer one. tfm-preview-* ids stay byte-identical. ---

type PreviewCtx = {
  renderer: CliRenderer;
  byId(id: string): MaybeNode;
  colors(): Theme;
  uiStyle(): UiStyle;
  previewEnabled(): boolean; // config.ui.previewEnabled
  previewWidth(): number; // config.ui.previewWidth
  // Is the preview ACTUALLY on screen? With auto-hide on it is collapsed most
  // of the time, yet every selection move would still rebuild the pane (and
  // allocate its native Text/Code buffers) — pure wasted churn that OOMs this
  // app. Skip the rebuild entirely while hidden/collapsed. Absent = visible.
  visible?(): boolean;
  // coalesce rapid selection-driven rebuilds (arrow keys, rubber band) instead
  // of clearing + re-allocating the pane per step; injectable for tests
  sched?: Scheduler;
  termH(): number; // renderer.terminalHeight — LIVE read
  cellMetrics(): { cellW: number; cellH: number; aspect: number };
  focusKey(): string | null; // focused tile's key, else null
  tileRefs: Map<string, { selected: boolean }>; // tileRefsByKey — shared by ref; only .forEach read here
  pushThumbJob(job: ThumbJob): void; // thumbJobs is SWAPPED (reassigned) by drainThumbs — never capture the array
  drainThumbs(): void;
  drainIconQueue(): void;
  nextIconId(): string; // `tfm-icon-${iconSeq++}`
  fallbackGlyphFor(name: string): string; // glyph[name] ?? glyph.file!
  // tty mode (linux console): skip the image raster branch, no graphics
  // protocol, so the slot would sit empty. force-glyph does the same for
  // buggy kitty impls. Optional so test fakes keep working.
  isTtyMode?(): boolean;
  forceGlyph?(): boolean;
  // global wrap mode ([ui] wrap-mode): code bodies and markdown fences
  // render in this mode; prose (.txt bodies, markdown paragraphs) always
  // word-wraps. Optional so test fakes keep working; absent = none (clip).
  wrapMode?(): WrapMode;
  // plugin preview text (first matching ext wins in load order). Null/empty =
  // fall through to core. Throwing never breaks the pane. Stale guarded by
  // the same gen-counter as core file reads.
  pluginPreview?: (path: string) => Promise<string | null>;
  // root preview: non-interactive `sudo -n cat` only (cached timestamp) — a
  // preview must never pop a password prompt on every focus move. Null =
  // keep the blank pane, same as an unreadable file today. Files only:
  // unreadable directories still show "can't list this folder".
  sudoCat?: (path: string) => Promise<string | null>;
};

export const makePreview = (ctx: PreviewCtx) => {
  const TEXT_PREVIEW_MAX = 262144;

  let previewGen = 0;

  // --- syntax highlighting for the preview pane: tree-sitter machinery (extra
  // parser registration, filetype map, style builder) lives in ./syntax.ts ---
  let previewSyntaxStyle: InstanceType<typeof SyntaxStyle> | null = null;
  let previewSyntaxSig = "";
  const getPreviewSyntaxStyle = () => {
    const colors = ctx.colors();
    const sig = syntaxStyleSig(colors as Theme);
    if (!previewSyntaxStyle || previewSyntaxSig !== sig) {
      // Destroy the evicted node BEFORE the style: pane removal only detaches,
      // so an orphaned node with an in-flight highlight would otherwise call
      // getStyle() on the destroyed style (OpenTUI's catch degrades it to a
      // warn + plain repaint) and hold its native buffers until finalizers.
      // destroy() makes its continuations bail on isDestroyed.
      destroyCachedNode();
      try {
        previewSyntaxStyle?.destroy();
      } catch {}
      previewSyntaxStyle = buildSyntaxStyle(colors as Theme);
      previewSyntaxSig = sig;
    }
    return previewSyntaxStyle;
  };
  let previewCodeSeq = 0;
  // reuse the (already-parsed/highlighted) node when the same file is previewed again
  let previewCodeCache: {
    key: string;
    mtimeMs: number;
    size: number;
    // the wrap mode the node was built with — a toggle must not be served
    // the stale wrap from the cache (key/mtime/size don't change on toggle)
    wrap: string;
    // whichever renderable the last preview mounted. Text/code bodies and
    // markdown ride in a scrollbox — the cached node is the scroller, so
    // scroll position survives re-previews of one file.
    node: TextRenderable | CodeRenderable | LineNumberRenderable | MarkdownRenderable | ScrollBoxRenderable;
  } | null = null;
  // NOTE: the global mode reaches markdown FENCES only. Fence blocks
  // carry their info-string filetype (e.g. javascript) while prose blocks
  // stay filetype markdown, so the two are separable without token
  // internals. Prose always word-wraps (char-sliced prose is unreadable,
  // clipped prose breaks mid-word — both reported); tables keep word too
  // (measured cells). Content is set once at construction here and never
  // updated, so walk-once covers every node (no reconciliation can
  // introduce unwalked ones later).
  const restyleMarkdownWrap = (root: MaybeNode, mode: WrapMode): void => {
    const kids: unknown[] = (root as { getChildren?: () => unknown[] }).getChildren?.() ?? [];
    for (const k of kids) {
      try {
        if (k instanceof TextTableRenderable) continue;
        if (k instanceof CodeRenderable && (k as CodeRenderable).filetype !== "markdown") {
          (k as CodeRenderable).wrapMode = mode;
        }
        restyleMarkdownWrap(k as MaybeNode, mode);
      } catch {}
    }
  };
  // bodies ride in a scrollbox (fixed bodyH viewport over full-height
  // content): long files scroll under the cursor instead of clipping, and
  // the line-number gutter — which measures to the full logical line
  // count — scrolls in sync instead of running past short content. The bar
  // wears the theme via the shared boot-layout mapping; a theme flip
  // rebuilds the node anyway (style sig evicts the cache), so no retheme
  // hook is needed. Scrollers are built inline per branch: widths/colors
  // are render locals, not factory state.
  const destroyCachedNode = () => {
    // destroy() only DETACHES children — a gutter/markdown wrapper would
    // leak its inner nodes' native buffers (and an in-flight highlight
    // would keep touching the destroyed style). destroyRecursively is
    // identical for bare Text/Code nodes (they have no children), so one
    // helper covers all.
    try {
      previewCodeCache?.node.destroyRecursively();
    } catch {}
    previewCodeCache = null;
  };

  const renderPreviewNow = async () => {
    if (!ctx.previewEnabled()) return;
    if (ctx.visible && !ctx.visible()) return;
    const colors = ctx.colors();
    const gen = ++previewGen;
    const pane = ctx.byId("tfm-preview");
    if (!pane) return;
    // destroy the previous pane's nodes (each owns a native TextBuffer) — but
    // keep the cached code node, which the cache-hit path below re-adds;
    // destroying that here would be a use-after-destroy
    destroyChildren(pane, previewCodeCache?.node);

    // target = focused tile, else single selected, else folder summary
    let key: string | null = null;
    const fk = ctx.focusKey();
    if (fk) key = fk;
    else {
      let selCount = 0;
      let selKey: string | null = null;
      ctx.tileRefs.forEach((r, k) => {
        if (r.selected) {
          selCount++;
          selKey = k;
        }
      });
      if (selCount === 1 && selKey) key = selKey;
      else if (selCount > 1) {
        pane.add(Text({ content: `${selCount} items selected`, fg: colors.white }));
        return;
      }
    }

    if (!key || !existsSync(key)) {
      pane.add(Box({ height: 1 }));
      pane.add(Text({ content: "no selection", fg: colors.sidebarFgMuted }));
      return;
    }

    let st: Stats | null = null;
    try {
      // follow ON PURPOSE: the gates below read target CONTENT (thumb raster,
      // text body, cache key) and no size number ships from this st — the
      // on-disk invariant covers displayed sizes, not content decisions
      st = statSync(key);
    } catch {
      pane.add(Text({ content: "source gone", fg: colors.sidebarFgMuted }));
      return;
    }
    if (gen !== previewGen) return;
    const isDirTarget = st.isDirectory();

    pane.add(Text({ content: ` ${path.basename(key)}${isDirTarget ? "/" : ""}`, fg: colors.white }));
    pane.add(Text({ content: "~".repeat(Math.max(0, ctx.previewWidth() - 2)), fg: colors.divider }));

    // directories show a count + pointer instead of a blank pane under a
    // header (full stats live in right-click → Properties…)
    if (isDirTarget) {
      try {
        const n = readdirSync(key).length;
        pane.add(
          Text({ content: ` ${n} item${n === 1 ? "" : "s"} — Properties… for details`, fg: colors.sidebarFgMuted }),
        );
      } catch {
        pane.add(Text({ content: "can't list this folder", fg: colors.sidebarFgMuted }));
      }
      void ctx.drainIconQueue();
      return;
    }

    // plugin previews win over core (csv viewers, log colorizers…) — first
    // matching ext in load order. Empty/throwing falls through to core.
    if (ctx.pluginPreview) {
      try {
        const text = await ctx.pluginPreview(key);
        if (gen !== previewGen) return;
        if (typeof text === "string" && text.length) {
          const maxLines = Math.max(4, ctx.termH() - 8);
          for (const line of text.split("\n").slice(0, maxLines)) {
            pane.add(Text({ content: ` ${line}`.slice(0, Math.max(0, ctx.previewWidth() - 1)), fg: colors.white }));
          }
          return;
        }
      } catch {}
      if (gen !== previewGen) return;
    }

    // pictures and videos (ffmpeg present): render the actual content instead
    // of nothing (skipped in tty / force-glyph mode, no working graphics)
    const isVideo = fileIsVideo(key);
    if (
      !ctx.isTtyMode?.() &&
      !ctx.forceGlyph?.() &&
      (fileIsImage(key) || (isVideo && canThumbVideo())) &&
      st.size > 0 &&
      st.size <= 26214400
    ) {
      const w = Math.max(4, ctx.previewWidth() - 4);
      const maxH = Math.max(4, ctx.termH() - 8);
      const h = Math.min(maxH, Math.max(3, Math.round(w / ctx.cellMetrics().aspect)));
      const slotId = ctx.nextIconId();
      pane.add(
        Box(
          { width: "100%", flexDirection: "row", justifyContent: "center" },
          Box({ id: slotId, width: w, height: h }),
        ),
      );
      ctx.pushThumbJob({
        slotId,
        path: key,
        mtimeMs: st.mtimeMs ?? 0,
        size: st.size,
        wCells: w,
        hCells: h,
        bg: slotBg(ctx.uiStyle(), colors, colors.sidebarBg),
        vector: key.toLowerCase().endsWith(".svg"),
        video: isVideo,
        fallbackGlyph: ctx.fallbackGlyphFor(fileIconFor(key)),
        priority: true, // must not wait behind the grid's thumbnail backlog
      });
      void ctx.drainThumbs();
      return;
    }

    if (!isTextLike(key) || st.size > TEXT_PREVIEW_MAX) return;

    let text: string;
    try {
      text = (await readFile(key, "utf8")).slice(0, 65536);
    } catch (err) {
      // privileged file: one quiet non-interactive attempt (never prompts —
      // focus moves constantly, a password popup per move is unusable)
      if (!isPrivilegeError(err) || !ctx.sudoCat) return;
      const elevated = await ctx.sudoCat(key).catch(() => null);
      if (gen !== previewGen) return;
      if (!elevated) return;
      text = elevated.slice(0, 65536);
    }
    try {
      if (gen !== previewGen) return;
      // Called BEFORE the cache check on purpose: it nulls previewCodeCache
      // when the theme sig changed, so a stale styled node can't survive a
      // re-preview of the same unchanged file (the cache-hit return below
      // would otherwise keep painting the OLD theme until some OTHER file
      // was previewed).
      const syntaxStyle = getPreviewSyntaxStyle();
      if (!syntaxStyle) return;
      const mtimeMs = st.mtimeMs ?? 0;
      const size = st.size ?? 0;
      // global wrap mode: code bodies and markdown blocks render in it.
      // "none" clips instead of wrapping (word mode still hard-slices
      // spaceless code runs by character, so it can never mean "no wrap"
      // for code). Prose (.txt bodies, markdown paragraphs) always
      // word-wraps — the mode governs code, never typography.
      const wrap: WrapMode = ctx.wrapMode?.() ?? "none";
      if (
        previewCodeCache &&
        previewCodeCache.key === key &&
        previewCodeCache.mtimeMs === mtimeMs &&
        previewCodeCache.size === size &&
        previewCodeCache.wrap === wrap
      ) {
        pane.add(previewCodeCache.node);
        return;
      }
      // cache miss on a DIFFERENT file: the old cached node was detached above
      // (kept, not destroyed) and is about to be replaced — destroy it now so
      // its native buffer frees here, not at the next GC poke
      destroyCachedNode();
      const ext = path.extname(key).slice(1).toLowerCase();
      const bodyW = Math.max(8, ctx.previewWidth() - 2);
      const bodyH = Math.max(1, ctx.termH() - 6);
      // markdown gets the rich render (headings/lists/links, OSC-8
      // hyperlink chunks included) instead of a monochrome code dump.
      // The whole node — prose and fences — renders in the global mode;
      // tables keep their own word wrap (measured cells). Auto height: the
      // scroller below viewports it, so long docs scroll instead of clip.
      if (ext === "md" || ext === "markdown" || ext === "mdx") {
        const mdNode = new MarkdownRenderable(ctx.renderer, {
          id: `tfm-preview-code-${previewCodeSeq++}`,
          content: text,
          syntaxStyle,
          fg: colors.white,
          width: bodyW,
          height: "auto",
        });
        restyleMarkdownWrap(mdNode, wrap);
        const scroller = new ScrollBoxRenderable(ctx.renderer, {
          width: bodyW,
          height: bodyH,
          scrollY: true,
          scrollbarOptions: { trackOptions: scrollbarTrackColors(colors) },
        });
        scroller.add(mdNode);
        previewCodeCache = { key, mtimeMs, size, wrap, node: scroller };
        pane.add(scroller);
        void ctx.drainIconQueue();
        return;
      }
      // text + code bodies ride inside a line-number gutter (both are
      // TextBufferRenderables, i.e. LineInfoProviders). Gutter is ~4 cells
      // (minWidth 3 + padding 1), so the body narrows to stay inside the pane.
      const gutterW = 4;
      const filetype = PREVIEW_FT_BY_EXT[ext];
      const body: TextRenderable | CodeRenderable = !filetype
        ? // No tree-sitter filetype → CodeRenderable paints everything with the
          // terminal default fg (it never consults syntaxStyle without a
          // grammar). A real TextRenderable honours the theme instead — and is
          // cached so re-previewing the same .txt doesn't realloc a TextBuffer
          // every time (theme flips evict it, since the sig carries white).
          // Prose always word-wraps: the mode governs code, never typography.
          // Auto height: inside the scroller the body paints full-height and
          // the viewport scrolls it (a fixed height would pin a viewport
          // that never advances, freezing the body while the gutter moves).
          new TextRenderable(ctx.renderer, {
            content: text,
            fg: colors.white,
            width: Math.max(8, bodyW - gutterW),
            height: "auto",
            selectable: false,
            wrapMode: "word",
          })
        : // real class instance (not a proxied helper) so it mounts into the live pane
          new CodeRenderable(ctx.renderer, {
            content: text,
            filetype,
            syntaxStyle,
            baseHighlight: "default",
            // bare URLs become OSC-8 hyperlink chunks (the terminal opens
            // them natively, e.g. kitty ctrl+click) — same hook Markdown
            // uses internally for its own code blocks
            onChunks: detectLinks,
            width: Math.max(8, bodyW - gutterW),
            height: "auto",
            selectable: false,
            wrapMode: wrap,
          });
      const gutter = new LineNumberRenderable(ctx.renderer, {
        id: `tfm-preview-code-${previewCodeSeq++}`,
        target: body,
        fg: colors.sidebarFgMuted,
      });
      // The gutter measures to the FULL logical line count (not parent
      // constraints): in a scrollbox it scrolls in sync with the body
      // instead of running past short content — its designed use.
      const scroller = new ScrollBoxRenderable(ctx.renderer, {
        width: bodyW,
        height: bodyH,
        scrollY: true,
        scrollbarOptions: { trackOptions: scrollbarTrackColors(colors) },
      });
      scroller.add(gutter);
      previewCodeCache = { key, mtimeMs, size, wrap, node: scroller };
      pane.add(scroller);
      void ctx.drainIconQueue();
    } catch {}
  };

  // public entry: coalesce bursts. A holding arrow key / band drag fires
  // renderPreview per step; without this each rebuild clears the pane and
  // allocates a fresh native TextBuffer per preview line.
  const schedulePreview = debounced(
    60,
    () => {
      void renderPreviewNow();
    },
    ctx.sched ?? globalThis,
  );
  const renderPreview = (): void => {
    schedulePreview();
  };

  return { renderPreview };
};
