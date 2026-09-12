// --- Inline rename/create: edit the tile label in place instead of a modal.
// Factory with injected ctx (renderer/colors/refs are live getters); the
// renameEdit state lives HERE behind getters so the keyboard router and
// renderGrid read it without a module-level import from index. ---
import { InputRenderable, Text } from "@opentui/core";
import { existsSync } from "node:fs";
import { mkdir, rename as fsRename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { stepToUnit, type UndoJournalData, type UndoStep, type UndoUnit } from "../app/undo";
import { fsErrText, splitStemExt, uniqueTarget } from "../fs/fsutil";
import type { NotifyLevel } from "../lib/notify-level";
import type { Theme } from "../config/config";

type RenameEdit = { key: string; inputId: string; createKind?: "file" | "folder"; labelIdx?: number };

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
  pushUndoBatch(label: string, units: UndoUnit[], redos: UndoUnit[], data?: UndoJournalData): void;
  notify(msg: string, title?: string, level?: NotifyLevel): void;
  isVirtualCwd(): boolean;
  inTrashView(): boolean;
  cwd(): string;
  focusKeys(): string[];
  selectTileAt(idx: number): boolean;
};

// nautilus naming for an unused "Untitled …" base: "Untitled 2.txt", "Untitled 3.txt" …
export const uniqueUntitledName = (dir: string, base: string): string => {
  const { stem, ext } = splitStemExt(base);
  let n = base;
  let i = 2;
  while (existsSync(path.join(dir, n))) n = `${stem} ${i++}${ext}`;
  return n;
};

export const tileLabelFor = (name: string, maxW: number): string =>
  name.length > maxW - 2 ? `${name.slice(0, maxW - 5)}…` : name;

export const makeRename = (ctx: RenameCtx) => {
  let renameEdit: RenameEdit | null = null;

  // undo pair for an inline create: undo removes the entry, redo recreates it
  // empty. Redo reuses the journal interpreter so the live closure and the
  // persisted step can't drift apart. Labels carry the entry name (like the
  // rename label carries old → new) so multi-create undos stay clear.
  const pushCreateBatch = (kind: "file" | "folder", key: string): void => {
    const redoStep: UndoStep =
      kind === "folder" ? { op: "mkdir-if-missing", path: key } : { op: "write-empty-if-missing", path: key };
    ctx.pushUndoBatch(
      `new ${kind} ${path.basename(key)}`,
      [() => rm(key, { recursive: true })],
      [stepToUnit(redoStep)],
      { units: [{ op: "rm", path: key }], redos: [redoStep] },
    );
  };

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
      // restore at the label's ORIGINAL index, not via add(): in list rows
      // (icon | name | … | size | date) an append drops the name after the
      // date — the same-name create path never rebuilds, so it stayed there
      const kids: any[] = typeof tile.getChildren === "function" ? [...tile.getChildren()] : [];
      const at = edit.labelIdx !== undefined && edit.labelIdx <= kids.length ? edit.labelIdx : kids.length;
      const before = kids[at];
      if (before) {
        try {
          tile.insertBefore(labelText, before);
        } catch {
          tile.add(labelText);
        }
      } else {
        tile.add(labelText);
      }
    }
    ctx.stripSelectable();
    if (!commit || !value) {
      if (edit.createKind) {
        void rm(edit.key, { recursive: true })
          .then(() => ctx.renderAll())
          .catch(() => {
            // surface it: a silent rejection left the half-created entry on
            // disk AND on screen with no error and no repaint
            ctx.notify("Delete failed", "create failed", "error");
            void ctx.renderAll();
          });
      }
      return;
    }
    if (edit.createKind) {
      // the whole create is ONE user action: land the final name right here
      // (no performRename detour — that would push a second "rename" undo
      // batch and report "Renamed to …" for a file the user just made) and
      // push a single undo batch for the final path: undo deletes it, redo
      // recreates it
      const k = edit.key;
      const dir = path.dirname(k);
      if (value !== path.basename(k)) {
        let target = path.join(dir, value);
        // create never replaces: a typed name that exists gets the same
        // "name 2" dedupe the initial Untitled naming used. existsSync guard
        // right before the rename — Linux rename would silently overwrite.
        if (existsSync(target)) target = uniqueTarget(dir, value);
        void fsRename(k, target)
          .then(() => {
            pushCreateBatch(edit.createKind!, target);
            const msg = `Created ${path.basename(target)} · ctrl+z to undo`;
            ctx.notify(msg, "create", "success");
            void ctx.renderAll();
          })
          .catch((err: unknown) => {
            // the placeholder still exists under the old name — repaint it
            ctx.notify(`Create failed (${fsErrText(err)})`, "create failed", "error");
            void ctx.renderAll();
          });
        return;
      }
      pushCreateBatch(edit.createKind, k);
      const msg = `Created ${value} · ctrl+z to undo`;
      ctx.notify(msg, "create", "success");
      return;
    }
    // plain F2 rename: goes through performRename, which owns conflict
    // handling, undo units and the "Renamed a → b" reporting
    void ctx.performRename(edit.key, value);
  };

  const startInlineRename = (key: string, createKind?: "file" | "folder"): void => {
    if (renameEdit) finishInlineRename(false);
    const refs = ctx.tileRefs.get(key);
    // stale selection (tile rebuilt under us, or the file vanished mid-press):
    // say so instead of dead-ending — keyboard rename gives no other signal
    if (!refs) {
      ctx.notify("Can't rename here", "rename", "error");
      return;
    }
    const tile: any = ctx.byId(refs.tileId);
    const label: any = ctx.byId(refs.labelId);
    if (!tile || !label || !existsSync(key)) {
      ctx.notify("Can't rename here (source gone)", "rename", "error");
      return;
    }
    // remember where the label sits so finishInlineRename can restore it in
    // place (grid tile: below the icon; list row: right after it — an append
    // would drop the name after the size/date columns)
    let labelIdx: number | undefined;
    try {
      labelIdx = [...tile.getChildren()].indexOf(label);
    } catch {}
    if (labelIdx === -1) labelIdx = undefined;
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
    renameEdit = { key, inputId, labelIdx, ...(createKind ? { createKind } : {}) };
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
  // its label edits in place; esc/empty name deletes it again. createKind MUST
  // ride along — without it the commit looked like a plain rename (a
  // "Renamed to …" toast and a second undo batch for a file just created).
  const startInlineCreate = (kind: "file" | "folder"): void => {
    if (renameEdit) finishInlineRename(false);
    // trash and virtual views are read-only workspaces, not creation targets
    if (ctx.isVirtualCwd() || ctx.inTrashView()) {
      ctx.notify("Can't create here", "create", "error");
      return;
    }
    const name = uniqueUntitledName(ctx.cwd(), kind === "folder" ? "Untitled folder" : "Untitled.txt");
    const target = path.join(ctx.cwd(), name);
    const made = kind === "folder" ? mkdir(target, { recursive: true }) : writeFile(target, "");
    void made
      .then(() => ctx.renderGrid())
      .then(() => {
        const idx = ctx.focusKeys().indexOf(target);
        if (idx >= 0) ctx.selectTileAt(idx);
        startInlineRename(target, kind);
      })
      .catch((err) => {
        const summary = `Create failed (${fsErrText(err)})`;
        ctx.notify(summary, "create failed", "error");
      });
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
