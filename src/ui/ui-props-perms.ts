import { Box, type MouseEvent, Text } from "@opentui/core";
import { statSync, openSync, readSync, closeSync } from "node:fs";
import { chmod } from "node:fs/promises";
import path from "node:path";
import { isRunnableHead } from "../fs/executable";
import { applySurface, rowSurface, slotBg, type UiStyle } from "./style";
import type { Theme } from "../config/config";
import { idName, permWords } from "../fs/propsinfo";
import { PlainIdx } from "../lib/icon-state";
import { fsErrText } from "../fs/fsutil";
import type { ListEntry } from "../lib/menu-entry";
import type { NotifyLevel } from "../lib/notify-level";
import type { MaybeNode, NodeLike } from "../lib/node-like";
import type { PointerStyle } from "../lib/pointer";
import { hoverEvents, type MakeIconSlot, type SlotElement } from "./ui-slots";
import type { FloatOpenOpts } from "./floats";

// --- Nautilus-style permissions editor for the properties dialog: click a
// class row to pick access (cursor popup via openContextMenu), the checkbox
// toggles the execute bit, chmods hit the REAL file and the perm words
// repaint in place (setTextOnId on the -words ids — the row Boxes share the
// base id and byId hits the Box first, mutating it no-ops). Split from
// ./ui-props (the dialog shell): this owns the mode-bit state machine. ---

type PermsCtx = {
  byId(id: string): MaybeNode;
  setTextOnId(nodeId: string, s: string): void;
  setOnId(id: string, fn: (n: NodeLike) => void): void;
  // the perm-class popup is a NESTED popup: it lives inside the properties
  // dialog, so the dialog stays open underneath it (keepModalBelow)
  openContextMenu(x: number, y: number, title: string, entries: ListEntry[], opts?: FloatOpenOpts): void;
  closeFileMenu(): void;
  notify(msg: string, title?: string, level?: NotifyLevel): void;
  uiStyle(): UiStyle;
  colors(): Theme;
  makeIconSlot: MakeIconSlot;
  // mouse pointer shape (OSC 22 via the wiring's tty-guarded setter).
  // Absent = no pointer changes (old fakes keep working).
  setPointer?(style: PointerStyle): void;
};

type PermsDeps = {
  // rows are appended here, in dialog order
  panel: NodeLike;
  targetPath: string;
  // the file's permission bits AT MOUNT — the editor takes a COPY and owns
  // it from there (the caller's stat object is never written to)
  mode: number;
  uid: number;
  gid: number;
  isDirTarget: boolean;
  // the dialog's shared one-row builder (label/value/id), for the owner row
  row(label: string, value: string, id?: string): SlotElement;
};

export const mountPermsEditor = (ctx: PermsCtx, deps: PermsDeps): void => {
  const { panel, targetPath, uid, gid, isDirTarget, row } = deps;
  const colors = ctx.colors();
  // --- nautilus-style permissions editor: click a class to pick access,
  // checkbox toggles the execute bit ---
  const permRowId = (cls: string): string => `tfm-props-perm-${cls}`;
  // THE editor's own copy of the permission bits — the single source of
  // truth for the perm words, the access menu's markers and the execute
  // checkbox. It is re-read from disk (the file can change under us) and
  // never written back into the caller's stat object.
  let mode: number = deps.mode;
  const readMode = (): number | null => {
    try {
      return statSync(targetPath).mode;
    } catch {
      return null;
    }
  };
  // assigned only when the execute row exists (regular files)
  let syncExecCheckbox: () => void = () => {};
  const refreshPermRows = (): void => {
    // the words Text carries the `-words` id: the row Box shares the base id
    // (hit target), and byId hits the outer Box first — mutating it no-ops
    ctx.setTextOnId(`${permRowId("owner")}-words`, permWords(mode, 6, isDirTarget));
    ctx.setTextOnId(`${permRowId("group")}-words`, permWords(mode, 3, isDirTarget));
    ctx.setTextOnId(`${permRowId("others")}-words`, permWords(mode, 0, isDirTarget));
    syncExecCheckbox();
  };
  // pick up an external chmod: the CURRENT mode is read from disk whenever
  // the user touches the editor (the file may have changed since it opened)
  const syncFromDisk = (): void => {
    const fresh = readMode();
    if (fresh === null || fresh === mode) return;
    mode = fresh;
    refreshPermRows();
  };
  const applyMode = async (nm: number): Promise<void> => {
    try {
      await chmod(targetPath, nm);
    } catch (err) {
      // one toast, not a status write: toasts are non-modal chrome above the
      // dialog (same stack as the progress toast), so nothing fights
      ctx.notify(`Chmod failed · ${fsErrText(err)}`, "permissions", "error");
      return;
    }
    // the truth lives on disk: read it back instead of assuming the chmod
    // landed exactly as asked (and never write into the caller's stat)
    const fresh = readMode();
    if (fresh !== null) mode = fresh;
    refreshPermRows();
  };
  const permClassMenu = (shift: number): ListEntry[] => {
    const cur = (mode >> shift) & 7;
    const mk = (bits: number, label: string): ListEntry => ({
      kind: "item",
      label: `${cur === bits ? "●" : "○"} ${label}`,
      action: () => {
        ctx.closeFileMenu();
        void applyMode((mode & ~(7 << shift)) | (bits << shift));
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
        // nested popup: the dialog stays open underneath it
        onMouseDown: (ev: MouseEvent) => {
          syncFromDisk(); // the file may have changed since the dialog opened
          ctx.openContextMenu(ev.x, ev.y, "", permClassMenu(shift), { keepModalBelow: true });
        },
        ...hoverEvents(
          (on) =>
            ctx.setOnId(rowId, (n) =>
              applySurface(n, on ? { backgroundColor: colors.hoverBg } : rowSurface(ctx.uiStyle(), colors, "rest")),
            ),
          ctx.setPointer,
        ),
      },
      Text({ content: ` ${label}`.padEnd(12), fg: colors.sidebarFgMuted }),
      Text({ id: `${permRowId(cls)}-words`, content: permWords(mode, shift, isDirTarget), fg: colors.white }),
    );
  };
  panel.add(permRow("you", "owner", 6));
  panel.add(permRow("group", "group", 3));
  panel.add(permRow("others", "others", 0));
  panel.add(row("owner", `${idName(uid)}:${idName(gid)}`));

  // "execute as program" only makes sense for things that can actually run:
  // ELF binaries, shebang scripts, known script exts (content sniff shared
  // with the open-path leaf in fs/executable). The CONTENT half is a
  // property of the file; the MODE half is LIVE — the row follows the
  // current mode, so a chmod that lands while the dialog is open can make
  // the control appear (and be unset again).
  const contentRunnable = ((): boolean => {
    if (isDirTarget) return false;
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
      return isRunnableHead(head);
    } catch {
      return false;
    }
  })();
  const execCapable = (): boolean => !isDirTarget && (contentRunnable || (mode & 0o111) !== 0);
  if (!isDirTarget) {
    // raster checkbox: two slots (marked/blank) stacked in one hit area,
    // visibility flips with the exec bit
    // role "float": the checkboxes sit on the properties dialog's fill (see
    // style.slotBg) — the chrome role would bake a canvas-colored square
    const cbOnSpec = ctx.makeIconSlot(
      "checkbox-marked",
      [{ fg: colors.accent, bg: slotBg(ctx.uiStyle(), colors, colors.sidebarBg, "float") }],
      1,
      PlainIdx.Rest,
    );
    const cbOffSpec = ctx.makeIconSlot(
      "checkbox-blank",
      [{ fg: colors.sidebarFgMuted, bg: slotBg(ctx.uiStyle(), colors, colors.sidebarBg, "float") }],
      1,
      PlainIdx.Rest,
    );
    const execRowId = "tfm-props-exec";
    const execGapId = "tfm-props-exec-gap";
    syncExecCheckbox = (): void => {
      // the checkbox claims what the file REALLY has: ANY exec bit (the
      // click grants/clears all of them) — not just the owner's
      const on = (mode & 0o111) !== 0;
      const a = ctx.byId(cbOnSpec.slotId);
      const b = ctx.byId(cbOffSpec.slotId);
      try {
        if (a) a.visible = on;
      } catch {}
      try {
        if (b) b.visible = !on;
      } catch {}
      // the row (and its gap) follow the CURRENT mode: a file that became
      // executable — or stopped being one — shows/hides the control
      const shown = execCapable();
      const r = ctx.byId(execRowId);
      try {
        if (r) r.visible = shown;
      } catch {}
      const gap = ctx.byId(execGapId);
      try {
        if (gap) gap.visible = shown;
      } catch {}
    };
    panel.add(Box({ id: execGapId, height: 1 }));
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
          syncFromDisk(); // the mode may have changed since the last read
          let nm: number;
          if (mode & 0o111) {
            // clear EVERY exec bit — the checkbox claims "not executable"
            nm = mode & ~0o111;
          } else {
            // grant exec where the class can read, plus the owner always:
            // "execute as program" must actually make the file runnable
            nm = mode;
            for (const sh of [6, 3, 0]) {
              if ((mode >> sh) & 4) nm |= 1 << sh;
            }
            nm |= 0o100;
          }
          void applyMode(nm);
        },
        ...hoverEvents(
          (on) =>
            ctx.setOnId(execRowId, (n) =>
              applySurface(n, on ? { backgroundColor: colors.hoverBg } : rowSurface(ctx.uiStyle(), colors, "rest")),
            ),
          ctx.setPointer,
        ),
      },
      Box({ width: 2, height: 1, flexDirection: "row" }, cbOffSpec.el, cbOnSpec.el),
      Text({ content: "execute as program", fg: colors.white }),
    );
    panel.add(execRow);
    syncExecCheckbox();
  }
};
