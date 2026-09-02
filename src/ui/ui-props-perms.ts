import { Box, Text } from "@opentui/core";
import { statSync, openSync, readSync, closeSync } from "node:fs";
import { chmod } from "node:fs/promises";
import path from "node:path";
import { applySurface, rowSurface, slotBg } from "./style";
import type { Theme } from "../config/config";
import { idName, permWords } from "../fs/propsinfo";
import type { ListEntry } from "./ui-menu";

// --- Nautilus-style permissions editor for the properties dialog: click a
// class row to pick access (cursor popup via openContextMenu), the checkbox
// toggles the execute bit, chmods hit the REAL file and the perm words
// repaint in place (setTextOnId on the -words ids — the row Boxes share the
// base id and byId hits the Box first, mutating it no-ops). Split from
// ./ui-props (the dialog shell): this owns the mode-bit state machine. ---

export type PermsCtx = {
  byId(id: string): any;
  setTextOnId(nodeId: string, s: string): void;
  setOnId(id: string, fn: (n: any) => void): void;
  openContextMenu(x: number, y: number, title: string, entries: ListEntry[]): void;
  closeFileMenu(): void;
  setStatusMsg(msg: string): void;
  uiStyle(): "solid" | "outline";
  colors(): Theme & Record<string, any>;
  makeIconSlot(
    name: string,
    states: { fg: string; bg: string }[],
    heightCells?: number,
    initialState?: number,
  ): { el: any; slotId: string; spec: any };
};

export type PermsDeps = {
  // rows are appended here, in dialog order
  panel: any;
  targetPath: string;
  // live stat object — mode is refreshed in place after every chmod
  st: any;
  isDirTarget: boolean;
  // the dialog's shared one-row builder (label/value/id), for the owner row
  row(label: string, value: string, id?: string): any;
};

export const mountPermsEditor = (ctx: PermsCtx, deps: PermsDeps): void => {
  const { panel, targetPath, st, isDirTarget, row } = deps;
  const colors = ctx.colors();
  // --- nautilus-style permissions editor: click a class to pick access,
  // checkbox toggles the execute bit ---
  const permRowId = (cls: string): string => `tfm-props-perm-${cls}`;
  // assigned only when the exec checkbox exists (exec-capable files)
  let syncExecCheckbox: () => void = () => {};
  const refreshPermRows = (): void => {
    // the words Text carries the `-words` id: the row Box shares the base id
    // (hit target), and byId hits the outer Box first — mutating it no-ops
    ctx.setTextOnId(`${permRowId("owner")}-words`, permWords(st.mode, 6, isDirTarget));
    ctx.setTextOnId(`${permRowId("group")}-words`, permWords(st.mode, 3, isDirTarget));
    ctx.setTextOnId(`${permRowId("others")}-words`, permWords(st.mode, 0, isDirTarget));
    syncExecCheckbox();
  };
  const applyMode = async (nm: number): Promise<void> => {
    try {
      await chmod(targetPath, nm);
    } catch {
      ctx.setStatusMsg("chmod failed");
      return;
    }
    try {
      st.mode = statSync(targetPath).mode;
    } catch {
      return;
    }
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
        width: "100%",
        height: 1,
        flexDirection: "row",
        paddingLeft: 1,
        ...rowSurface(ctx.uiStyle(), colors, "rest"),
        onMouseDown: (ev: any) => ctx.openContextMenu(ev.x, ev.y, "", permClassMenu(shift)),
        onMouseOver: () => ctx.setOnId(rowId, (n) => applySurface(n, { backgroundColor: colors.hoverBg })),
        onMouseOut: () => ctx.setOnId(rowId, (n) => applySurface(n, rowSurface(ctx.uiStyle(), colors, "rest"))),
      },
      Text({ content: ` ${label}`.padEnd(12), fg: colors.sidebarFgMuted }),
      Text({ id: `${permRowId(cls)}-words`, content: permWords(st.mode, shift, isDirTarget), fg: colors.sidebarFg }),
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
      try {
        readSync(fd, head, 0, 4, 0);
      } finally {
        closeSync(fd);
      }
      return (
        (head[0] === 0x7f && head[1] === 0x45 && head[2] === 0x4c && head[3] === 0x46) ||
        (head[0] === 0x23 && head[1] === 0x21)
      );
    } catch {
      return false;
    }
  })();
  if (execCapable) {
    // raster checkbox: two slots (marked/blank) stacked in one hit area,
    // visibility flips with the exec bit
    const cbOnSpec = ctx.makeIconSlot(
      "checkbox-marked",
      [{ fg: colors.accent, bg: slotBg(ctx.uiStyle(), colors, colors.sidebarBg) }],
      1,
      0,
    );
    const cbOffSpec = ctx.makeIconSlot(
      "checkbox-blank",
      [{ fg: colors.sidebarFgMuted, bg: slotBg(ctx.uiStyle(), colors, colors.sidebarBg) }],
      1,
      0,
    );
    syncExecCheckbox = (): void => {
      const on = !!(st.mode & 0o100);
      const a: any = ctx.byId(cbOnSpec.slotId);
      const b: any = ctx.byId(cbOffSpec.slotId);
      try {
        if (a) a.visible = on;
      } catch {}
      try {
        if (b) b.visible = !on;
      } catch {}
    };
    panel.add(Box({ height: 1 }));
    const execRowId = "tfm-props-exec";
    const execRow = Box(
      {
        id: execRowId,
        width: "100%",
        height: 1,
        flexDirection: "row",
        columnGap: 1,
        paddingLeft: 1,
        ...rowSurface(ctx.uiStyle(), colors, "rest"),
        onMouseDown: () => {
          let nm: number;
          if (st.mode & 0o100) nm = st.mode & ~0o111;
          else {
            nm = st.mode;
            for (const sh of [6, 3, 0]) {
              if ((st.mode >> sh) & 4) nm |= 1 << sh;
            }
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
};
