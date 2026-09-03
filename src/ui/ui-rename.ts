// --- Inline rename/create: edit the tile label in place instead of a modal.
// Factory with injected ctx (renderer/colors/refs are live getters); the
// renameEdit state lives HERE behind getters so the keyboard router and
// renderGrid read it without a module-level import from index. ---
import { InputRenderable, Text } from "@opentui/core";
import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { UndoUnit } from "../app/undo";
import type { Theme } from "../config/config";

export type RenameEdit = { key: string; inputId: string; createKind?: "file" | "folder" };

export type RenameCtx = {
  renderer(): any;
  byId(id: string): any;
  colors(): Theme;
  tileW(): number;
  tileRefs: Map<string, { tileId: string; labelId: string; baseFg: string }>;
  stripSelectable(): void;
  renderAll(): void;
  renderGrid(): void | Promise<void>;
  performRename(p: string, name: string): void | Promise<void>;
  pushUndoBatch(label: string, undos: Array<() => Promise<void> | void>, redos: Array<UndoUnit>): void;
  setStatusMsg(msg: string): void;
  isVirtualCwd(): boolean;
  inTrashView(): boolean;
  cwd(): string;
  focusKeys(): string[];
  selectTileAt(idx: number): boolean;
};

// nautilus naming for an unused "Untitled …" base: "Untitled 2.txt", "Untitled 3.txt" …
export const uniqueUntitledName = (dir: string, base: string): string => {
  const dot = base.lastIndexOf(".");
  const stem = dot > 0 ? base.slice(0, dot) : base;
  const ext = dot > 0 ? base.slice(dot) : "";
  let n = base;
  let i = 2;
  while (existsSync(path.join(dir, n))) n = `${stem} ${i++}${ext}`;
  return n;
};

export const tileLabelFor = (name: string, maxW: number): string =>
  name.length > maxW - 2 ? `${name.slice(0, maxW - 5)}…` : name;

const redoCreateUnit = (k: string, kind: "file" | "folder"): UndoUnit =>
  kind === "folder"
    ? async () => {
        try {
          if (!existsSync(k)) await mkdir(k, { recursive: true });
        } catch {}
      }
    : async () => {
        try {
          if (!existsSync(k)) await writeFile(k, "");
        } catch {}
      };

export const makeRename = (ctx: RenameCtx) => {
  let renameEdit: RenameEdit | null = null;

  // restores the plain label node; commit=true runs performRename afterwards
  const finishInlineRename = (commit: boolean): void => {
    const edit = renameEdit;
    if (!edit) return;
    renameEdit = null;
    const input: any = ctx.byId(edit.inputId);
    const value = String(input?.value ?? "").trim();
    if (input) {
      try {
        input.parent?.remove(input);
      } catch {}
    }
    const refs = ctx.tileRefs.get(edit.key);
    const tile: any = refs ? ctx.byId(refs.tileId) : null;
    if (refs && tile && !ctx.byId(refs.labelId)) {
      const labelText: any = Text({
        id: refs.labelId,
        content: tileLabelFor(path.basename(edit.key), ctx.tileW()),
        fg: refs.baseFg,
      });
      tile.add(labelText);
    }
    ctx.stripSelectable();
    if (!commit || !value) {
      if (edit.createKind) void rm(edit.key, { recursive: true }).then(() => ctx.renderAll());
      return;
    }
    if (value !== path.basename(edit.key)) {
      // create-unit is pushed BEFORE performRename so undo pops rename-back
      // first, then removes the entry entirely
      if (edit.createKind) {
        const k = edit.key;
        ctx.pushUndoBatch(
          edit.createKind === "folder" ? "new folder" : "new file",
          [() => rm(k, { recursive: true })],
          [redoCreateUnit(k, edit.createKind)],
        );
      }
      void ctx.performRename(edit.key, value);
      return;
    }
    if (edit.createKind) {
      const k = edit.key;
      ctx.pushUndoBatch(
        edit.createKind === "folder" ? "new folder" : "new file",
        [() => rm(k, { recursive: true })],
        [redoCreateUnit(k, edit.createKind)],
      );
      ctx.setStatusMsg(`Created ${value} · ctrl+z to undo`);
    }
  };

  const startInlineRename = (key: string): void => {
    if (renameEdit) finishInlineRename(false);
    const refs = ctx.tileRefs.get(key);
    if (!refs) return;
    const tile: any = ctx.byId(refs.tileId);
    const label: any = ctx.byId(refs.labelId);
    if (!tile || !label || !existsSync(key)) return;
    // real class instance — mounts into the already-mounted tile
    const inputId = `tfm-rename-input`;
    const stale = ctx.byId(inputId);
    if (stale) {
      try {
        stale.parent?.remove(stale);
      } catch {}
    }
    const input: any = new InputRenderable(ctx.renderer(), {
      id: inputId,
      width: ctx.tileW() - 2,
      value: path.basename(key),
      backgroundColor: ctx.colors().hoverBg,
      focusedBackgroundColor: ctx.colors().accentBg,
      textColor: ctx.colors().white,
    });
    try {
      tile.insertBefore(input, label);
    } catch {
      tile.add(input);
    }
    try {
      tile.remove(label);
    } catch {}
    renameEdit = { key, inputId };
    input.on?.("enter", () => finishInlineRename(true));
    const prevHandler = input.handleKeyPress?.bind(input);
    input.handleKeyPress = (k: any) => {
      if (k?.name === "escape") {
        finishInlineRename(false);
        return true;
      }
      return prevHandler ? prevHandler(k) : false;
    };
    setTimeout(() => {
      try {
        input.focus();
      } catch {}
    }, 20);
    ctx.stripSelectable();
  };

  // nautilus-style: the entry is created immediately with a default name, then
  // its label edits in place; esc/empty name deletes it again
  const startInlineCreate = (kind: "file" | "folder"): void => {
    if (renameEdit) finishInlineRename(false);
    if (ctx.isVirtualCwd() || ctx.inTrashView()) return;
    const name = uniqueUntitledName(ctx.cwd(), kind === "folder" ? "Untitled folder" : "Untitled.txt");
    const target = path.join(ctx.cwd(), name);
    const made = kind === "folder" ? mkdir(target, { recursive: true }) : writeFile(target, "");
    void made
      .then(() => ctx.renderGrid())
      .then(() => {
        const idx = ctx.focusKeys().indexOf(target);
        if (idx >= 0) ctx.selectTileAt(idx);
        startInlineRename(target);
      })
      .catch(() => ctx.setStatusMsg("Create failed"));
  };

  return {
    isRenaming: (): boolean => renameEdit !== null,
    renameEditKey: (): string | null => renameEdit?.key ?? null,
    clearRenameEdit: (): void => {
      renameEdit = null;
    },
    finishInlineRename,
    startInlineRename,
    startInlineCreate,
  };
};
