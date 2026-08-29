import { Box, Text } from "@opentui/core";
import { execFile } from "node:child_process";
import { statSync, openSync, readSync, closeSync } from "node:fs";
import { chmod } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { applySurface, btnSurface, rowSurface, slotBg } from "./style";
import type { Theme } from "./config";
import { fileIconFor, fileIsImage, fileIsVideo } from "./filetype";
import { canThumbVideo } from "./icons";
import { dirWalkStats, fmtBytes, fmtDate, idName, mimeLabelFor, permWords } from "./propsinfo";
import { readStarredList, starredRegistryAdd, starredRegistryRemove } from "./recent";
import { isBookmarked, setBookmarked, loadSystemPlaces } from "./places";
import type { ListEntry } from "./ui-menu";

// --- Properties dialog (floating, right-click -> Properties…): star/bookmark
// toggles, hero icon/thumbnail, nautilus-style permissions editor. Theme +
// renderer arrive via ctx (same seam as ui-dialogs); every tfm-props-* id
// must stay byte-identical for rethemeChrome. ---

export type PropsIconState = { fg: string; bg: string };

export type PropsThumbJob = { slotId: string; path: string; mtimeMs: number; size: number; wCells: number; hCells?: number; bg?: string; vector: boolean; video?: boolean; fallbackGlyph: string; priority?: boolean };

export type PropsCtx = {
  byId(id: string): any;
  openDialog(opts: { id: string; zIndex: number; width: number; paddingDiv?: number; rows: () => any[]; onClose: () => void }): void;
  closeDialog(id: string): void;
  setTextOnId(nodeId: string, s: string): void;
  setOnId(id: string, fn: (n: any) => void): void;
  stripSelectable(): void;
  drainIconQueue(): void;
  drainThumbs(): void;
  pushThumbJob(job: PropsThumbJob): void;
  nextIconId(): string;
  escHintBtn(id: string, onClose: () => void): any;
  closeFileMenu(): void;
  openContextMenu(x: number, y: number, title: string, entries: ListEntry[]): void;
  renderAll(): void;
  setStatusMsg(msg: string): void;
  uiStyle(): "solid" | "outline";
  colors(): Theme & Record<string, any>;
  home: string;
  makeIconSlot(name: string, states: PropsIconState[], heightCells?: number, initialState?: number, onMouseDown?: (ev: any) => void, statesFactory?: () => PropsIconState[]): { el: any; slotId: string; spec: any };
  setIconState(spec: any, stateIdx: number): boolean;
  fallbackGlyphFor(name: string): string;
  cellMetrics(): { aspect: number };
};

const execFileP = promisify(execFile);

export const makeProps = (ctx: PropsCtx) => {
  // --- Properties dialog (floating, right-click -> Properties…) ---
  const PROPS_W = 46;
  let propsOpen = false;

  const closeProps = (): void => {
    ctx.closeDialog("tfm-props");
    propsOpen = false;
  };

  const openSingle = (targetPath: string): void => {
    const colors = ctx.colors();
    ctx.closeFileMenu();
    let st: any = null;
    try { st = statSync(targetPath); } catch { return; }
    if (propsOpen) closeProps();
    const isDirTarget = st.isDirectory();
    propsOpen = true;

    ctx.openDialog({
      id: "tfm-props",
      zIndex: 3300,
      width: PROPS_W,
      paddingDiv: 4,
      rows: () => [],
      onClose: () => closeProps(),
    });

    const panel: any = ctx.byId("tfm-props-panel");
    if (!panel) return;

    // star & bookmark are on/off toggles AND hovers — 4 baked rasters each
    // (idx = on*1 + hover*2), plus matching wrapper-box bg swaps
    const propsToggleStates = (): PropsIconState[] => [
      { fg: colors.sidebarFgMuted, bg: slotBg(ctx.uiStyle(), colors, colors.sidebarBg) },
      { fg: colors.accent, bg: slotBg(ctx.uiStyle(), colors, colors.sidebarBg) },
      { fg: colors.sidebarFgMuted, bg: colors.hoverBg },
      { fg: colors.accent, bg: colors.hoverBg },
    ];
    const propsTogglePaint = (btnId: string, spec: any, on: boolean, hover: boolean) => {
      ctx.setIconState(spec, (on ? 1 : 0) + (hover ? 2 : 0));
      try {
        const n: any = ctx.byId(btnId);
        if (n) applySurface(n, btnSurface(ctx.uiStyle(), colors, hover, colors.sidebarBg));
      } catch {}
    };

    const starSlot = ctx.makeIconSlot("star", propsToggleStates(), 1, 0, () => {
      starred = !starred;
      propsTogglePaint("tfm-props-star", starSlot.spec, starred, starHover);
      if (starred) starredRegistryAdd(targetPath);
      else starredRegistryRemove(targetPath);
      void execFileP("gio", ["set", "-t", "string", targetPath, "metadata::starred", starred ? "true" : ""]).catch(() => {});
    });
    let starHover = false;
    let starred = readStarredList().includes(targetPath);
    if (starred) ctx.setIconState(starSlot.spec, 1);
    void execFileP("gio", ["info", "-a", "metadata::starred", targetPath]).then(
      ({ stdout }) => {
        const m = stdout.match(/metadata::starred:\s*(\S+)/);
        const gioStarred = !!m && m[1] !== "";
        if (gioStarred && !starred) {
          starred = true;
          starredRegistryAdd(targetPath); // adopt stars made outside tfm
        }
        ctx.setIconState(starSlot.spec, (starred ? 1 : 0) + (starHover ? 2 : 0));
      },
    ).catch(() => {});
    // folders can be bookmarked (gtk bookmarks → sidebar); files can't.
    // created unconditionally like starSlot — just not rendered for files
    let bmHover = false;
    let bookmarked = isBookmarked(targetPath);
    const bmSlot = ctx.makeIconSlot("bookmark", propsToggleStates(), 1, bookmarked ? 1 : 0, () => {
      bookmarked = !bookmarked;
      propsTogglePaint("tfm-props-bm", bmSlot.spec, bookmarked, bmHover);
      void setBookmarked(targetPath, bookmarked)
        .then(() => loadSystemPlaces())
        .then(() => ctx.renderAll());
    });
    panel.add(Box(
      { width: "100%", height: 1, flexDirection: "row", alignItems: "center" },
      (() => {
        const b = Box(
          {
            id: "tfm-props-star",
            paddingLeft: 1,
            ...btnSurface(ctx.uiStyle(), colors, false, colors.sidebarBg),
            onMouseOver: () => { starHover = true; propsTogglePaint("tfm-props-star", starSlot.spec, starred, true); },
            onMouseOut: () => { starHover = false; propsTogglePaint("tfm-props-star", starSlot.spec, starred, false); },
          },
          starSlot.el,
        );
        return b;
      })(),
      ...(isDirTarget
        ? [
            Box(
              {
                id: "tfm-props-bm",
                paddingLeft: 1,
                ...btnSurface(ctx.uiStyle(), colors, false, colors.sidebarBg),
                onMouseOver: () => { bmHover = true; propsTogglePaint("tfm-props-bm", bmSlot.spec, bookmarked, true); },
                onMouseOut: () => { bmHover = false; propsTogglePaint("tfm-props-bm", bmSlot.spec, bookmarked, false); },
              },
              bmSlot.el,
            ),
          ]
        : []),
      Box({ flexGrow: 1 }),
      ctx.escHintBtn("tfm-esc-props", closeProps),
    ));

    // hero: big category icon below the title, or the actual picture for images
    const iconName = isDirTarget ? "folder" : fileIconFor(targetPath);
    const ICON_H = 6;
    const { aspect } = ctx.cellMetrics();
    const heroW = Math.max(1, Math.round(aspect * ICON_H));
    const isVideo = !isDirTarget && fileIsVideo(targetPath);
    const wantsThumb = !isDirTarget && (fileIsImage(targetPath) || (isVideo && canThumbVideo())) && st.size > 0 && st.size <= 26214400;
    let heroEl: ReturnType<typeof Box>;
    if (wantsThumb) {
      const slotId = ctx.nextIconId();
      heroEl = Box({ id: slotId, width: heroW, height: ICON_H });
      ctx.pushThumbJob({
        slotId,
        path: targetPath,
        mtimeMs: st.mtimeMs ?? 0,
        size: st.size,
        wCells: heroW,
        hCells: ICON_H,
        bg: slotBg(ctx.uiStyle(), colors, colors.sidebarBg),
        vector: targetPath.toLowerCase().endsWith(".svg"),
        video: isVideo,
        fallbackGlyph: ctx.fallbackGlyphFor(iconName),
        priority: true,
      });
    } else {
      heroEl = ctx.makeIconSlot(iconName, [{ fg: colors.sidebarFg, bg: slotBg(ctx.uiStyle(), colors, colors.sidebarBg) }], ICON_H).el;
    }
    panel.add(Box(
      { width: "100%", height: ICON_H + 1, flexDirection: "row", justifyContent: "center", alignItems: "center" },
      heroEl,
    ));
    panel.add(Box(
      { width: "100%", height: 1, flexDirection: "row", justifyContent: "center", paddingLeft: 1, paddingRight: 1 },
      Text({ content: path.basename(targetPath).slice(0, PROPS_W - 4), fg: colors.white }),
    ));
    panel.add(Box(
      { width: "100%", height: 1, flexDirection: "row", justifyContent: "center", paddingLeft: 1, paddingRight: 1 },
      Text({
        id: "tfm-props-size",
        content: isDirTarget ? "calculating…" : `${fmtBytes(st.size ?? 0)} (${st.size ?? 0} bytes)`,
        fg: colors.accent,
      }),
    ));
    panel.add(Box(
      { width: "100%", height: 1, paddingLeft: 1, paddingRight: 1 },
      Text({ content: " " + "~".repeat(PROPS_W - 2), fg: colors.divider }),
    ));

    const row = (label: string, value: string, id?: string) =>
      Box({ width: "100%", height: 1, flexDirection: "row", paddingLeft: 1 },
        Text({ content: ` ${label}`.padEnd(12), fg: colors.sidebarFgMuted }),
        Text({ ...(id ? { id } : {}), content: String(value).slice(0, PROPS_W - 14), fg: colors.sidebarFg }));

    if (isDirTarget) {
      void dirWalkStats(targetPath).then((s) => {
        if (!propsOpen || !s) {
          if (propsOpen) {
            const n: any = ctx.byId("tfm-props-size");
            if (n) { try { n.content = "huge"; } catch {} }
          }
          return;
        }
        const n: any = ctx.byId("tfm-props-size");
        if (n) { try { n.content = `${fmtBytes(s.bytes)} · ${s.files} files · ${s.folders} folders`; } catch {} }
      });
    }
    panel.add(row("type", isDirTarget ? "inode/directory" : mimeLabelFor(targetPath)));
    panel.add(row("location", path.dirname(targetPath).replace(ctx.home, "~").slice(0, PROPS_W - 14)));
    panel.add(row("modified", fmtDate(st.mtimeMs)));
    panel.add(row("accessed", fmtDate(st.atimeMs)));

    // --- nautilus-style permissions editor: click a class to pick access,
    // checkbox toggles the execute bit ---
    const permRowId = (cls: string): string => `tfm-props-perm-${cls}`;
    // assigned only when the exec checkbox exists (exec-capable files)
    let syncExecCheckbox: () => void = () => {};
    const refreshPermRows = (): void => {
      ctx.setTextOnId(permRowId("owner"), permWords(st.mode, 6, isDirTarget));
      ctx.setTextOnId(permRowId("group"), permWords(st.mode, 3, isDirTarget));
      ctx.setTextOnId(permRowId("others"), permWords(st.mode, 0, isDirTarget));
      syncExecCheckbox();
    };
    const applyMode = async (nm: number): Promise<void> => {
      try { await chmod(targetPath, nm); } catch { ctx.setStatusMsg("chmod failed"); return; }
      try { st.mode = statSync(targetPath).mode; } catch { return; }
      refreshPermRows();
    };
    const permClassMenu = (shift: number): ListEntry[] => {
      const cur = (st.mode >> shift) & 7;
      const mk = (bits: number, label: string): ListEntry => ({
        label: `${cur === bits ? "●" : "○"} ${label}`,
        action: () => {
          ctx.closeFileMenu();
          void applyMode((st.mode & ~(7 << shift)) | (bits << shift));
        },
      });
      return [mk(6, "read & write"), mk(4, "read-only"), mk(0, "none")];
    };
    const permRow = (label: string, cls: string, shift: number) => {
      const rowId = `tfm-props-perm-${cls}`;
      return Box(
        {
          id: rowId,
          width: "100%", height: 1, flexDirection: "row", paddingLeft: 1,
          ...rowSurface(ctx.uiStyle(), colors, "rest"),
          onMouseDown: (ev: any) => ctx.openContextMenu(ev.x, ev.y, "", permClassMenu(shift)),
          onMouseOver: () => ctx.setOnId(rowId, (n) => applySurface(n, { backgroundColor: colors.hoverBg })),
          onMouseOut: () => ctx.setOnId(rowId, (n) => applySurface(n, rowSurface(ctx.uiStyle(), colors, "rest"))),
        },
        Text({ content: ` ${label}`.padEnd(12), fg: colors.sidebarFgMuted }),
        Text({ id: permRowId(cls), content: permWords(st.mode, shift, isDirTarget), fg: colors.sidebarFg }),
      );
    };
    panel.add(permRow("you", "owner", 6));
    panel.add(permRow("group", "group", 3));
    panel.add(permRow("others", "others", 0));
    panel.add(row("owner", `${idName(st.uid)}:${idName(st.gid)}`));

    // "execute as program" only makes sense for things that can actually run:
    // already-executable files, ELF binaries, shebang scripts, known script exts
    const execCapable = ((): boolean => {
      if (isDirTarget) return false;
      if (st.mode & 0o111) return true;
      const ext = path.extname(targetPath).slice(1).toLowerCase();
      if (["sh", "bash", "zsh", "py", "pl", "rb", "run"].includes(ext)) return true;
      try {
        const head = Buffer.alloc(4);
        const fd = openSync(targetPath, "r");
        try { readSync(fd, head, 0, 4, 0); } finally { closeSync(fd); }
        return (head[0] === 0x7f && head[1] === 0x45 && head[2] === 0x4c && head[3] === 0x46)
          || (head[0] === 0x23 && head[1] === 0x21);
      } catch { return false; }
    })();
    if (execCapable) {
      // raster checkbox: two slots (marked/blank) stacked in one hit area,
      // visibility flips with the exec bit
      const cbOnSpec = ctx.makeIconSlot("checkbox-marked", [{ fg: colors.accent, bg: slotBg(ctx.uiStyle(), colors, colors.sidebarBg) }], 1, 0);
      const cbOffSpec = ctx.makeIconSlot("checkbox-blank", [{ fg: colors.sidebarFgMuted, bg: slotBg(ctx.uiStyle(), colors, colors.sidebarBg) }], 1, 0);
      syncExecCheckbox = (): void => {
        const on = !!(st.mode & 0o100);
        const a: any = ctx.byId(cbOnSpec.slotId);
        const b: any = ctx.byId(cbOffSpec.slotId);
        try { if (a) a.visible = on; } catch {}
        try { if (b) b.visible = !on; } catch {}
      };
      panel.add(Box({ height: 1 }));
      const execRowId = "tfm-props-exec";
      const execRow = Box(
        {
          id: execRowId,
          width: "100%", height: 1, flexDirection: "row", columnGap: 1, paddingLeft: 1,
          ...rowSurface(ctx.uiStyle(), colors, "rest"),
          onMouseDown: () => {
            let nm: number;
            if (st.mode & 0o100) nm = st.mode & ~0o111;
            else {
              nm = st.mode;
              for (const sh of [6, 3, 0]) { if ((st.mode >> sh) & 4) nm |= 1 << sh; }
            }
            void applyMode(nm);
          },
          onMouseOver: () => ctx.setOnId(execRowId, (n) => applySurface(n, { backgroundColor: colors.hoverBg })),
          onMouseOut: () => ctx.setOnId(execRowId, (n) => applySurface(n, rowSurface(ctx.uiStyle(), colors, "rest"))),
        },
        Box({ width: 2, height: 1, flexDirection: "row" }, cbOffSpec.el, cbOnSpec.el),
        Text({ content: "execute as program", fg: colors.sidebarFg }),
      );
      panel.add(execRow);
      syncExecCheckbox();
    }
    ctx.stripSelectable();
    void ctx.drainIconQueue();
    void ctx.drainThumbs();
  };

  // --- multi-selection properties: count + aggregate size + capped name
  // list; no star/bookmark/perms (those are per-file semantics) ---
  const PROPS_LIST_MAX = 6;

  const openMulti = (items: { path: string; st: any }[]): void => {
    const colors = ctx.colors();
    if (propsOpen) closeProps();
    propsOpen = true;

    ctx.openDialog({
      id: "tfm-props",
      zIndex: 3300,
      width: PROPS_W,
      paddingDiv: 4,
      rows: () => [],
      onClose: () => closeProps(),
    });

    const panel: any = ctx.byId("tfm-props-panel");
    if (!panel) return;

    panel.add(Box(
      { width: "100%", height: 1, flexDirection: "row" },
      Box({ flexGrow: 1 }),
      ctx.escHintBtn("tfm-esc-props", closeProps),
    ));

    const ICON_H = 6;
    const heroEl = ctx.makeIconSlot("select-all", [{ fg: colors.sidebarFg, bg: slotBg(ctx.uiStyle(), colors, colors.sidebarBg) }], ICON_H).el;
    panel.add(Box(
      { width: "100%", height: ICON_H + 1, flexDirection: "row", justifyContent: "center", alignItems: "center" },
      heroEl,
    ));
    panel.add(Box(
      { width: "100%", height: 1, flexDirection: "row", justifyContent: "center", paddingLeft: 1, paddingRight: 1 },
      Text({ content: `${items.length} items selected`, fg: colors.white }),
    ));
    panel.add(Box(
      { width: "100%", height: 1, flexDirection: "row", justifyContent: "center", paddingLeft: 1, paddingRight: 1 },
      Text({ id: "tfm-props-size", content: "calculating…", fg: colors.accent }),
    ));
    panel.add(Box(
      { width: "100%", height: 1, paddingLeft: 1, paddingRight: 1 },
      Text({ content: " " + "~".repeat(PROPS_W - 2), fg: colors.divider }),
    ));

    // aggregate size: files are already stat'd, folders walk async (same
    // settle-guarded byId update as the single-dir flow)
    let totalBytes = 0;
    let nFiles = 0;
    let nFolders = 0;
    const dirPaths: string[] = [];
    for (const it of items) {
      if (it.st.isDirectory()) dirPaths.push(it.path);
      else { totalBytes += it.st.size ?? 0; nFiles++; }
    }
    const settle = (): void => {
      if (!propsOpen) return;
      const n: any = ctx.byId("tfm-props-size");
      if (n) {
        const counts = dirPaths.length ? ` · ${nFiles} files · ${nFolders} folders` : ` · ${nFiles} files`;
        try { n.content = `${fmtBytes(totalBytes)}${counts}`; } catch {}
      }
    };
    if (dirPaths.length) {
      void Promise.all(dirPaths.map((d) => dirWalkStats(d))).then((walks) => {
        for (const s of walks) {
          if (s) { totalBytes += s.bytes; nFiles += s.files; nFolders += s.folders; }
        }
        settle();
      });
    } else {
      settle();
    }

    const shown = items.slice(0, PROPS_LIST_MAX);
    for (const it of shown) {
      panel.add(Box(
        { width: "100%", height: 1, paddingLeft: 1, paddingRight: 1 },
        Text({ content: ` ${path.basename(it.path)}`.slice(0, PROPS_W - 1), fg: colors.sidebarFg }),
      ));
    }
    if (items.length > PROPS_LIST_MAX) {
      panel.add(Box(
        { width: "100%", height: 1, paddingLeft: 1, paddingRight: 1 },
        Text({ content: ` …and ${items.length - PROPS_LIST_MAX} more`, fg: colors.sidebarFgMuted }),
      ));
    }
    ctx.stripSelectable();
    void ctx.drainIconQueue();
  };

  const openProperties = (target: string | string[]): void => {
    if (!Array.isArray(target)) { openSingle(target); return; }
    const stats: { path: string; st: any }[] = [];
    for (const p of target) {
      try { stats.push({ path: p, st: statSync(p) }); } catch {}
    }
    if (stats.length === 1) { openSingle(stats[0]!.path); return; }
    if (stats.length > 1) openMulti(stats);
  };

  return { openProperties, closeProps, isOpen: () => propsOpen };
};
