import { Box, CodeRenderable, Text, TextRenderable, type SyntaxStyle } from "@opentui/core";
import { existsSync, readdirSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { clearChildren, debounced, type Scheduler } from "../lib/uiutil";
import { slotBg, type UiStyle } from "./style";
import { fileIconFor, fileIsImage, fileIsVideo } from "../fs/filetype";
import { isPrivilegeError } from "../fs/elevate";
import { canThumbVideo } from "./icons";
import type { ThumbJob } from "./ui-slots";
import { buildSyntaxStyle, isTextLike, PREVIEW_FT_BY_EXT, syntaxStyleSig } from "./syntax";
import type { Theme } from "../config/config";
import type { MaybeNode } from "../lib/node-like";

// --- Preview pane (right sidebar): image thumbs go through the shared
// thumb-job sink, text files render via CodeRenderable + tree-sitter
// (machinery in ./syntax.ts), directories get a header + entry count (full
// stats live in Properties…). ctx-seamed like ui-props/ui-term; the
// gen-counter guards stale async file reads so a slow preview can't paint
// over a newer one. tfm-preview-* ids stay byte-identical. ---

type ThumbJobLike = ThumbJob;

type PreviewCtx = {
  renderer: any;
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
  tileRefs: Map<string, { selected: boolean; [k: string]: any }>; // tileRefsByKey — shared by ref; only .forEach read here
  pushThumbJob(job: ThumbJobLike): void; // thumbJobs is SWAPPED (reassigned) by drainThumbs — never capture the array
  drainThumbs(): void;
  drainIconQueue(): void;
  nextIconId(): string; // `tfm-icon-${iconSeq++}`
  fallbackGlyphFor(name: string): string; // glyph[name] ?? glyph.file!
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
      try {
        previewCodeCache?.node.destroy();
      } catch {}
      previewCodeCache = null;
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
  let previewCodeCache: { key: string; mtimeMs: number; size: number; node: any } | null = null;

  const renderPreviewNow = async () => {
    if (!ctx.previewEnabled()) return;
    if (ctx.visible && !ctx.visible()) return;
    const colors = ctx.colors();
    const gen = ++previewGen;
    const pane: any = ctx.byId("tfm-preview");
    if (!pane) return;
    clearChildren(pane);

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
        pane.add(Text({ content: `${selCount} items selected`, fg: colors.sidebarFg }));
        return;
      }
    }

    if (!key || !existsSync(key)) {
      pane.add(Box({ height: 1 }));
      pane.add(Text({ content: "no selection", fg: colors.sidebarFgMuted }));
      return;
    }

    let st: any = null;
    try {
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
            pane.add(Text({ content: ` ${line}`.slice(0, Math.max(0, ctx.previewWidth() - 1)), fg: colors.sidebarFg }));
          }
          return;
        }
      } catch {}
      if (gen !== previewGen) return;
    }

    // pictures and videos (ffmpeg present): render the actual content instead
    // of nothing
    const isVideo = fileIsVideo(key);
    if ((fileIsImage(key) || (isVideo && canThumbVideo())) && st.size > 0 && st.size <= 26214400) {
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
      const syntaxStyle = getPreviewSyntaxStyle()!;
      const mtimeMs = st.mtimeMs ?? 0;
      const size = st.size ?? 0;
      if (
        previewCodeCache &&
        previewCodeCache.key === key &&
        previewCodeCache.mtimeMs === mtimeMs &&
        previewCodeCache.size === size
      ) {
        pane.add(previewCodeCache.node);
        return;
      }
      const filetype = PREVIEW_FT_BY_EXT[path.extname(key).slice(1).toLowerCase()];
      if (!filetype) {
        // No tree-sitter filetype → CodeRenderable paints everything with the
        // terminal default fg (it never consults syntaxStyle without a
        // grammar). A real TextRenderable honours the theme instead — and is
        // cached so re-previewing the same .txt doesn't realloc a TextBuffer
        // every time (theme flips evict it, since the sig carries sidebarFg).
        const textNode: any = new TextRenderable(ctx.renderer, {
          id: `tfm-preview-code-${previewCodeSeq++}`,
          content: text,
          fg: colors.sidebarFg,
          width: Math.max(8, ctx.previewWidth() - 2),
          height: Math.max(1, ctx.termH() - 6),
          selectable: false,
        });
        previewCodeCache = { key, mtimeMs, size, node: textNode };
        pane.add(textNode);
        void ctx.drainIconQueue();
        return;
      }
      // real class instance (not a proxied helper) so it mounts into the live pane
      const codeNode: any = new CodeRenderable(ctx.renderer, {
        id: `tfm-preview-code-${previewCodeSeq++}`,
        content: text,
        filetype,
        syntaxStyle,
        baseHighlight: "default",
        width: Math.max(8, ctx.previewWidth() - 2),
        height: Math.max(1, ctx.termH() - 6),
        selectable: false,
      });
      previewCodeCache = { key, mtimeMs, size, node: codeNode };
      pane.add(codeNode);
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
