import { Box, CodeRenderable, Text, type SyntaxStyle } from "@opentui/core";
import { existsSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { clearChildren } from "./uiutil";
import { slotBg } from "./style";
import { fileIconFor, fileIsImage, fileIsVideo } from "../fs/filetype";
import { canThumbVideo } from "./icons";
import { buildSyntaxStyle, isTextLike, PREVIEW_FT_BY_EXT, syntaxStyleSig } from "./syntax";
import type { Theme } from "../config/config";

// --- Preview pane (right sidebar): image thumbs go through the shared
// thumb-job sink, text files render via CodeRenderable + tree-sitter
// (machinery in ./syntax.ts), directories get a header only. ctx-seamed like
// ui-props/ui-term; the gen-counter guards stale async file reads so a slow
// preview can't paint over a newer one. tfm-preview-* ids stay byte-identical. ---

export type ThumbJobLike = {
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
  priority?: boolean;
};

export type PreviewCtx = {
  renderer: any;
  byId(id: string): any;
  colors(): Theme & Record<string, any>;
  uiStyle(): "solid" | "outline";
  previewEnabled(): boolean; // config.ui.previewEnabled
  previewWidth(): number; // config.ui.previewWidth
  termH(): number; // renderer.terminalHeight — LIVE read
  cellMetrics(): { cellW: number; cellH: number; aspect: number };
  focusKey(): string | null; // focused tile's key, else null
  tileRefs: Map<string, { selected: boolean; [k: string]: any }>; // tileRefsByKey — shared by ref; only .forEach read here
  pushThumbJob(job: ThumbJobLike): void; // thumbJobs is SWAPPED (reassigned) by drainThumbs — never capture the array
  drainThumbs(): void;
  drainIconQueue(): void;
  nextIconId(): string; // `tfm-icon-${iconSeq++}`
  fallbackGlyphFor(name: string): string; // glyph[name] ?? glyph.file!
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
      try {
        previewSyntaxStyle?.destroy();
      } catch {}
      // cached nodes hold a reference to the old style
      previewCodeCache = null;
      previewSyntaxStyle = buildSyntaxStyle(colors as Theme);
      previewSyntaxSig = sig;
    }
    return previewSyntaxStyle;
  };
  let previewCodeSeq = 0;
  // reuse the (already-parsed/highlighted) node when the same file is previewed again
  let previewCodeCache: { key: string; mtimeMs: number; size: number; node: any } | null = null;

  const renderPreview = async () => {
    if (!ctx.previewEnabled()) return;
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
      return;
    }
    if (gen !== previewGen) return;
    const isDirTarget = st.isDirectory();

    pane.add(Text({ content: ` ${path.basename(key)}${isDirTarget ? "/" : ""}`, fg: colors.white }));
    pane.add(Text({ content: "~".repeat(Math.max(0, ctx.previewWidth() - 2)), fg: colors.divider }));

    // metadata lives in right-click -> Properties…; the pane shows content only
    if (isDirTarget) {
      void ctx.drainIconQueue();
      return;
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

    try {
      const text = (await readFile(key, "utf8")).slice(0, 65536);
      if (gen !== previewGen) return;
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
      // real class instance (not a proxied helper) so it mounts into the live pane
      const codeNode: any = new CodeRenderable(ctx.renderer, {
        id: `tfm-preview-code-${previewCodeSeq++}`,
        content: text,
        filetype: PREVIEW_FT_BY_EXT[path.extname(key).slice(1).toLowerCase()],
        syntaxStyle: getPreviewSyntaxStyle()!,
        width: Math.max(8, ctx.previewWidth() - 2),
        height: Math.max(1, ctx.termH() - 6),
        selectable: false,
      });
      previewCodeCache = { key, mtimeMs, size, node: codeNode };
      pane.add(codeNode);
      void ctx.drainIconQueue();
    } catch {}
  };

  return { renderPreview };
};
