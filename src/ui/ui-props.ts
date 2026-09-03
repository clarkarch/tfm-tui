import { Box, Text } from "@opentui/core";
import { execFile } from "node:child_process";
import { statSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { applySurface, btnSurface, slotBg } from "./style";
import type { Theme } from "../config/config";
import { fileIconFor, fileIsImage, fileIsVideo } from "../fs/filetype";
import { canThumbVideo } from "./icons";
import { dirWalkStats, fmtBytes, fmtDate, mimeLabelFor } from "../fs/propsinfo";
import { readStarredList, starredRegistryAdd, starredRegistryRemove } from "../fs/recent";
import { isBookmarked, setBookmarked, loadSystemPlaces } from "../fs/places";
import type { ListEntry } from "./ui-menu";
import { FLOAT_Z, type Floats } from "./floats";
import { IconStateIdx, toggleIconState } from "./ui-slots";
import { mountPermsEditor } from "./ui-props-perms";

// --- Properties dialog (floating, right-click -> Properties…): star/bookmark
// toggles, hero icon/thumbnail, nautilus-style permissions editor. Theme +
// renderer arrive via ctx (same seam as ui-dialogs); every tfm-props-* id
// must stay byte-identical for rethemeChrome. ---

export type PropsIconState = { fg: string; bg: string };

export type PropsThumbJob = {
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

export type PropsCtx = {
  byId(id: string): any;
  openDialog(opts: {
    id: string;
    zIndex: number;
    width: number;
    paddingDiv?: number;
    rows: () => any[];
    onClose: () => void;
  }): void;
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
  floats: Floats;
  renderAll(): void;
  setStatusMsg(msg: string): void;
  uiStyle(): "solid" | "outline";
  colors(): Theme;
  home: string;
  makeIconSlot(
    name: string,
    states: PropsIconState[],
    heightCells?: number,
    initialState?: number,
    onMouseDown?: (ev: any) => void,
    statesFactory?: () => PropsIconState[],
  ): { el: any; slotId: string; spec: any };
  setIconState(spec: any, stateIdx: number): boolean;
  fallbackGlyphFor(name: string): string;
  cellMetrics(): { aspect: number };
};

const execFileP = promisify(execFile);

export const makeProps = (ctx: PropsCtx) => {
  // --- Properties dialog (floating, right-click -> Properties…) ---
  const PROPS_W = 46;
  let propsOpen = false;

  // raw teardown — registered with floats at open time; the public closeProps
  // is floats.close("props"), which also takes any popup spawned on top of
  // the dialog (the permission menu) with it
  const rawCloseProps = (): void => {
    ctx.closeDialog("tfm-props");
    propsOpen = false;
  };
  const closeProps = (): void => {
    ctx.floats.close("props");
  };

  const openSingle = (targetPath: string): void => {
    const colors = ctx.colors();
    let st: any = null;
    try {
      st = statSync(targetPath);
    } catch {
      return;
    }
    ctx.floats.open("props", rawCloseProps);
    propsOpen = true;
    const isDirTarget = st.isDirectory();

    ctx.openDialog({
      id: "tfm-props",
      zIndex: FLOAT_Z.props,
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
      ctx.setIconState(spec, toggleIconState(on, hover));
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
      void execFileP("gio", ["set", "-t", "string", targetPath, "metadata::starred", starred ? "true" : ""]).catch(
        () => {},
      );
    });
    let starHover = false;
    let starred = readStarredList().includes(targetPath);
    if (starred) ctx.setIconState(starSlot.spec, IconStateIdx.Active);
    void execFileP("gio", ["info", "-a", "metadata::starred", targetPath])
      .then(({ stdout }) => {
        const m = stdout.match(/metadata::starred:\s*(\S+)/);
        const gioStarred = !!m && m[1] !== "";
        if (gioStarred && !starred) {
          starred = true;
          starredRegistryAdd(targetPath); // adopt stars made outside tfm
        }
        ctx.setIconState(starSlot.spec, toggleIconState(starred, starHover));
      })
      .catch(() => {});
    // folders can be bookmarked (gtk bookmarks → sidebar); files can't.
    // created unconditionally like starSlot — just not rendered for files
    let bmHover = false;
    let bookmarked = isBookmarked(targetPath);
    const bmSlot = ctx.makeIconSlot("bookmark", propsToggleStates(), 1, toggleIconState(bookmarked, false), () => {
      bookmarked = !bookmarked;
      propsTogglePaint("tfm-props-bm", bmSlot.spec, bookmarked, bmHover);
      void setBookmarked(targetPath, bookmarked)
        .then(() => loadSystemPlaces())
        .then(() => ctx.renderAll());
    });
    panel.add(
      Box(
        { width: "100%", height: 1, flexDirection: "row", alignItems: "center" },
        (() => {
          const b = Box(
            {
              id: "tfm-props-star",
              paddingLeft: 1,
              ...btnSurface(ctx.uiStyle(), colors, false, colors.sidebarBg),
              onMouseOver: () => {
                starHover = true;
                propsTogglePaint("tfm-props-star", starSlot.spec, starred, true);
              },
              onMouseOut: () => {
                starHover = false;
                propsTogglePaint("tfm-props-star", starSlot.spec, starred, false);
              },
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
                  onMouseOver: () => {
                    bmHover = true;
                    propsTogglePaint("tfm-props-bm", bmSlot.spec, bookmarked, true);
                  },
                  onMouseOut: () => {
                    bmHover = false;
                    propsTogglePaint("tfm-props-bm", bmSlot.spec, bookmarked, false);
                  },
                },
                bmSlot.el,
              ),
            ]
          : []),
        Box({ flexGrow: 1 }),
        ctx.escHintBtn("tfm-esc-props", closeProps),
      ),
    );

    // hero: big category icon below the title, or the actual picture for images
    const iconName = isDirTarget ? "folder" : fileIconFor(targetPath);
    const ICON_H = 6;
    const { aspect } = ctx.cellMetrics();
    const heroW = Math.max(1, Math.round(aspect * ICON_H));
    const isVideo = !isDirTarget && fileIsVideo(targetPath);
    const wantsThumb =
      !isDirTarget && (fileIsImage(targetPath) || (isVideo && canThumbVideo())) && st.size > 0 && st.size <= 26214400;
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
      heroEl = ctx.makeIconSlot(
        iconName,
        [{ fg: colors.sidebarFg, bg: slotBg(ctx.uiStyle(), colors, colors.sidebarBg) }],
        ICON_H,
      ).el;
    }
    panel.add(
      Box(
        { width: "100%", height: ICON_H + 1, flexDirection: "row", justifyContent: "center", alignItems: "center" },
        heroEl,
      ),
    );
    panel.add(
      Box(
        { width: "100%", height: 1, flexDirection: "row", justifyContent: "center", paddingLeft: 1, paddingRight: 1 },
        Text({ content: path.basename(targetPath).slice(0, PROPS_W - 4), fg: colors.white }),
      ),
    );
    panel.add(
      Box(
        { width: "100%", height: 1, flexDirection: "row", justifyContent: "center", paddingLeft: 1, paddingRight: 1 },
        Text({
          id: "tfm-props-size",
          content: isDirTarget ? "calculating…" : `${fmtBytes(st.size ?? 0)} (${st.size ?? 0} bytes)`,
          fg: colors.accent,
        }),
      ),
    );
    panel.add(
      Box(
        { width: "100%", height: 1, paddingLeft: 1, paddingRight: 1 },
        Text({ content: ` ${"~".repeat(PROPS_W - 2)}`, fg: colors.divider }),
      ),
    );

    const row = (label: string, value: string, id?: string) =>
      Box(
        { width: "100%", height: 1, flexDirection: "row", paddingLeft: 1 },
        Text({ content: ` ${label}`.padEnd(12), fg: colors.sidebarFgMuted }),
        Text({ ...(id ? { id } : {}), content: String(value).slice(0, PROPS_W - 14), fg: colors.sidebarFg }),
      );

    if (isDirTarget) {
      void dirWalkStats(targetPath).then((s) => {
        if (!propsOpen || !s) {
          if (propsOpen) {
            const n: any = ctx.byId("tfm-props-size");
            if (n) {
              try {
                n.content = "huge";
              } catch {}
            }
          }
          return;
        }
        const n: any = ctx.byId("tfm-props-size");
        if (n) {
          try {
            n.content = `${fmtBytes(s.bytes)} · ${s.files} files · ${s.folders} folders`;
          } catch {}
        }
      });
    }
    panel.add(row("type", isDirTarget ? "inode/directory" : mimeLabelFor(targetPath)));
    panel.add(
      row(
        "location",
        path
          .dirname(targetPath)
          .replace(ctx.home, "~")
          .slice(0, PROPS_W - 14),
      ),
    );
    panel.add(row("modified", fmtDate(st.mtimeMs)));
    panel.add(row("accessed", fmtDate(st.atimeMs)));

    // --- nautilus-style permissions editor: widget + state live in
    // ./ui-props-perms (perm-class menu, exec checkbox, chmod plumbing) ---
    mountPermsEditor(
      {
        byId: ctx.byId,
        setTextOnId: ctx.setTextOnId,
        setOnId: ctx.setOnId,
        openContextMenu: ctx.openContextMenu,
        closeFileMenu: ctx.closeFileMenu,
        setStatusMsg: ctx.setStatusMsg,
        uiStyle: ctx.uiStyle,
        colors: () => colors,
        makeIconSlot: ctx.makeIconSlot,
      },
      { panel, targetPath, st, isDirTarget, row },
    );
    ctx.stripSelectable();
    void ctx.drainIconQueue();
    void ctx.drainThumbs();
  };

  // --- multi-selection properties: count + aggregate size + capped name
  // list; no star/bookmark/perms (those are per-file semantics) ---
  const PROPS_LIST_MAX = 6;

  const openMulti = (items: { path: string; st: any }[]): void => {
    const colors = ctx.colors();
    ctx.floats.open("props", rawCloseProps);
    propsOpen = true;

    ctx.openDialog({
      id: "tfm-props",
      zIndex: FLOAT_Z.props,
      width: PROPS_W,
      paddingDiv: 4,
      rows: () => [],
      onClose: () => closeProps(),
    });

    const panel: any = ctx.byId("tfm-props-panel");
    if (!panel) return;

    panel.add(
      Box(
        { width: "100%", height: 1, flexDirection: "row" },
        Box({ flexGrow: 1 }),
        ctx.escHintBtn("tfm-esc-props", closeProps),
      ),
    );

    const ICON_H = 6;
    const heroEl = ctx.makeIconSlot(
      "select-all",
      [{ fg: colors.sidebarFg, bg: slotBg(ctx.uiStyle(), colors, colors.sidebarBg) }],
      ICON_H,
    ).el;
    panel.add(
      Box(
        { width: "100%", height: ICON_H + 1, flexDirection: "row", justifyContent: "center", alignItems: "center" },
        heroEl,
      ),
    );
    panel.add(
      Box(
        { width: "100%", height: 1, flexDirection: "row", justifyContent: "center", paddingLeft: 1, paddingRight: 1 },
        Text({ content: `${items.length} items selected`, fg: colors.white }),
      ),
    );
    panel.add(
      Box(
        { width: "100%", height: 1, flexDirection: "row", justifyContent: "center", paddingLeft: 1, paddingRight: 1 },
        Text({ id: "tfm-props-size", content: "calculating…", fg: colors.accent }),
      ),
    );
    panel.add(
      Box(
        { width: "100%", height: 1, paddingLeft: 1, paddingRight: 1 },
        Text({ content: ` ${"~".repeat(PROPS_W - 2)}`, fg: colors.divider }),
      ),
    );

    // aggregate size: files are already stat'd, folders walk async (same
    // settle-guarded byId update as the single-dir flow)
    let totalBytes = 0;
    let nFiles = 0;
    let nFolders = 0;
    const dirPaths: string[] = [];
    for (const it of items) {
      if (it.st.isDirectory()) dirPaths.push(it.path);
      else {
        totalBytes += it.st.size ?? 0;
        nFiles++;
      }
    }
    const settle = (): void => {
      if (!propsOpen) return;
      const n: any = ctx.byId("tfm-props-size");
      if (n) {
        const counts = dirPaths.length ? ` · ${nFiles} files · ${nFolders} folders` : ` · ${nFiles} files`;
        try {
          n.content = `${fmtBytes(totalBytes)}${counts}`;
        } catch {}
      }
    };
    if (dirPaths.length) {
      void Promise.all(dirPaths.map((d) => dirWalkStats(d))).then((walks) => {
        for (const s of walks) {
          if (s) {
            totalBytes += s.bytes;
            nFiles += s.files;
            nFolders += s.folders;
          }
        }
        settle();
      });
    } else {
      settle();
    }

    const shown = items.slice(0, PROPS_LIST_MAX);
    for (const it of shown) {
      panel.add(
        Box(
          { width: "100%", height: 1, paddingLeft: 1, paddingRight: 1 },
          Text({ content: ` ${path.basename(it.path)}`.slice(0, PROPS_W - 1), fg: colors.sidebarFg }),
        ),
      );
    }
    if (items.length > PROPS_LIST_MAX) {
      panel.add(
        Box(
          { width: "100%", height: 1, paddingLeft: 1, paddingRight: 1 },
          Text({ content: ` …and ${items.length - PROPS_LIST_MAX} more`, fg: colors.sidebarFgMuted }),
        ),
      );
    }
    ctx.stripSelectable();
    void ctx.drainIconQueue();
  };

  const openProperties = (target: string | string[]): void => {
    if (!Array.isArray(target)) {
      openSingle(target);
      return;
    }
    const stats: { path: string; st: any }[] = [];
    for (const p of target) {
      try {
        stats.push({ path: p, st: statSync(p) });
      } catch {}
    }
    if (stats.length === 1) {
      openSingle(stats[0]!.path);
      return;
    }
    if (stats.length > 1) openMulti(stats);
  };

  return { openProperties, closeProps, isOpen: () => propsOpen };
};
