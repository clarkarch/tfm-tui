// --- Inline rename/create: edit the tile label in place instead of a modal.
// Factory with injected ctx (renderer/colors/refs are live getters); the
// renameEdit state lives HERE behind getters so the keyboard router and
// renderGrid read it without a module-level import from index. ---
import { type CliRenderer, InputRenderable, type KeyEvent } from "@opentui/core";
import { existsSync } from "node:fs";
import { link, mkdir, rm, rmdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { stepToUnit, type UndoJournalData, type UndoStep, type UndoUnit } from "../fs/undo-steps";
import { errCode, fsErrText, invalidFileName, splitStemExt, uniqueTarget } from "../fs/fsutil";
import { isArchiveUri } from "../fs/uri";
import type { NotifyLevel } from "../lib/notify-level";
import type { Theme } from "../config/config";
import type { MaybeNode } from "../lib/node-like";
import { stripControlChars } from "../lib/uiutil";
import type { PointerStyle } from "../lib/pointer";

// The edit's MODE is a TAG, not an optional field's presence: "rename" and
// "create" are different things (a create owns a placeholder file that must
// be dropped when the edit is cancelled), and a record with a field MISSING
// silently took the rename path.
type RenameEdit =
  | { kind: "rename"; key: string; inputId: string }
  | { kind: "create"; key: string; inputId: string; createKind: "file" | "folder" };

// what the caller asks for: the mode carries the destructive branch (create)
// explicitly, so no entry point can leave it out.
type RenameMode = { kind: "rename" } | { kind: "create"; createKind: "file" | "folder" };

export type RenameCtx = {
  renderer(): CliRenderer;
  byId(id: string): MaybeNode;
  colors(): Theme;
  tileW(): number;
  tileRefs: Map<string, { tileId: string; labelId: string; baseFg: string; renameWidth?: number }>;
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
  // mouse pointer shape (OSC 22 via the wiring's tty-guarded setter).
  // Absent = no pointer changes (old fakes keep working).
  setPointer?(style: PointerStyle): void;
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

  // the placeholder an inline create made: dropping it aborts the create.
  // The file is empty and ours, so nothing of the user's is lost.
  const dropPlaceholder = (key: string): void => {
    void rm(key, { recursive: true })
      .then(() => ctx.renderAll())
      .catch(() => {
        // surface it: a silent rejection left the half-created entry on
        // disk AND on screen with no error and no repaint
        ctx.notify("Delete failed", "create failed", "error");
        void ctx.renderAll();
      });
  };

  // restores the plain label node; commit=true runs performRename afterwards
  const finishInlineRename = (commit: boolean): void => {
    const edit = renameEdit;
    if (!edit) return;
    renameEdit = null;
    // the editor is gone — the cursor sits over its tile, but the tile's
    // over won't re-fire under a stationary mouse, so default (stale-
    // until-move, same rule as the highlight paint)
    ctx.setPointer?.("default");
    const input = ctx.byId(edit.inputId);
    const value = String(input?.value ?? "").trim();
    if (input) {
      try {
        input.parent?.remove(input);
      } catch {}
    }
    const refs = ctx.tileRefs.get(edit.key);
    const label = refs ? ctx.byId(refs.labelId) : null;
    if (label) {
      // The original label stays mounted (display:none while the editor is
      // open). Restoring THAT node preserves its exact content and layout:
      // rebuilding it from the basename used the grid tile width in list
      // view, leaving a cancelled rename visibly truncated.
      try {
        label.visible = true;
      } catch {}
    }
    ctx.stripSelectable();
    if (!commit || !value) {
      // an aborted CREATE owns a placeholder file: dropping it is the abort
      if (edit.kind === "create") dropPlaceholder(edit.key);
      return;
    }
    if (edit.kind === "create") {
      // a create target is a NAME, not a path: path.join(dir, "../x") would
      // land the file in the PARENT of the folder it was created in — the
      // same rule the rename path enforces (fsutil.invalidFileName), so
      // both rename entry points agree on what a legal name is.
      const badName = invalidFileName(value);
      if (badName) {
        // same outcome as an empty name: the create never lands
        ctx.notify(badName, "create", "error");
        dropPlaceholder(edit.key);
        return;
      }
      // the whole create is ONE user action: land the final name right here
      // (no performRename detour — that would push a second "rename" undo
      // batch and report "Renamed to …" for a file the user just made) and
      // push a single undo batch for the final path: undo deletes it, redo
      // recreates it
      const k = edit.key;
      const dir = path.dirname(k);
      const createKind = edit.createKind;
      if (value !== path.basename(k)) {
        // atomic landing: Linux rename would silently overwrite a raced
        // occupant, so the name is claimed with EEXIST-failing link(2)/mkdir(2)
        // instead of check-then-rename, retrying past collisions with the same
        // "name 2" dedupe the Untitled naming uses
        const landCreate = async (): Promise<string> => {
          let target = path.join(dir, value);
          for (let i = 0; i < 10; i++) {
            try {
              if (createKind === "folder") {
                await mkdir(target);
                try {
                  await rmdir(k); // placeholder is empty and ours
                } catch (err) {
                  await rmdir(target).catch(() => {}); // ours, just made, empty
                  throw err;
                }
              } else {
                await link(k, target); // same inode, placeholder consumed
                await rm(k);
              }
              return target;
            } catch (err) {
              if (errCode(err) !== "EEXIST") throw err;
              target = uniqueTarget(dir, path.basename(target));
            }
          }
          throw new Error(`already exists: ${value}`);
        };
        void landCreate()
          .then((target) => {
            pushCreateBatch(createKind, target);
            const msg = `Created ${path.basename(target)}`;
            ctx.notify(msg, "create", "success");
            void ctx.renderAll();
          })
          .catch((err: unknown) => {
            // the placeholder still exists under the old name — repaint it
            ctx.notify(`Create failed · ${fsErrText(err)}`, "create failed", "error");
            void ctx.renderAll();
          });
        return;
      }
      pushCreateBatch(createKind, k);
      const msg = `Created ${value}`;
      ctx.notify(msg, "create", "success");
      return;
    }
    // plain F2 rename: goes through performRename, which owns conflict
    // handling, undo units and the "Renamed a → b" reporting. The seeded
    // input shows the STRIPPED name (control chars can't render), so an
    // untouched Enter must be a no-op — committing the display form would
    // rename the file to a name the user never typed.
    if (value === stripControlChars(path.basename(edit.key))) return;
    void ctx.performRename(edit.key, value);
  };

  const startEdit = (key: string, mode: RenameMode): void => {
    if (renameEdit) finishInlineRename(false);
    // archive members are URIs, not fs paths (existsSync would refuse anyway,
    // with a misleading "source gone")
    if (isArchiveUri(key)) {
      ctx.notify("Archive contents are read-only", "rename", "error");
      return;
    }
    const refs = ctx.tileRefs.get(key);
    // stale selection (tile rebuilt under us, or the file vanished mid-press):
    // say so instead of dead-ending — keyboard rename gives no other signal
    if (!refs) {
      ctx.notify("Can't rename here", "rename", "error");
      return;
    }
    const tile = ctx.byId(refs.tileId);
    const label = ctx.byId(refs.labelId);
    if (!tile || !label || !existsSync(key)) {
      ctx.notify("Can't rename · source gone", "rename", "error");
      return;
    }
    // real class instance — mounts into the already-mounted tile
    const inputId = `tfm-rename-input`;
    const stale = ctx.byId(inputId);
    if (stale) {
      try {
        stale.parent?.remove?.(stale);
      } catch {}
    }
    const input = new InputRenderable(ctx.renderer(), {
      id: inputId,
      // Grid tiles publish their label width; list rows publish the name
      // column's width. The grid tile-width setting must not constrain an
      // editor that lives in a list row.
      width: Math.max(1, refs.renameWidth ?? ctx.tileW() - 2),
      // filenames may carry C0 controls (legal on Linux except / and NUL) —
      // 0.6.0 Input throws NativeError on them at construction
      value: stripControlChars(path.basename(key)),
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
      // Keep the label mounted but take it out of layout. Restoring this
      // exact node keeps the original text, truncation and centering intact.
      label.visible = false;
    } catch {}
    renameEdit =
      mode.kind === "create"
        ? { kind: "create", key, inputId, createKind: mode.createKind }
        : { kind: "rename", key, inputId };
    // the editor owns the keyboard now — text pointer until it lands
    ctx.setPointer?.("text");
    input.on?.("enter", () => finishInlineRename(true));
    const prevHandler = input.handleKeyPress?.bind(input);
    input.handleKeyPress = (k: KeyEvent) => {
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
  // its label edits in place; esc/empty name deletes it again. The CREATE
  // mode MUST ride along — without it the commit looked like a plain rename
  // (a "Renamed to …" toast and a second undo batch for a file just created).
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
        startEdit(target, { kind: "create", createKind: kind });
      })
      .catch((err) => {
        const summary = `Create failed · ${fsErrText(err)}`;
        ctx.notify(summary, "create failed", "error");
      });
  };

  // F2 on a tile: the plain rename mode.
  const startInlineRename = (key: string): void => startEdit(key, { kind: "rename" });

  return {
    isRenaming: (): boolean => renameEdit !== null,
    renameEditKey: (): string | null => renameEdit?.key ?? null,
    clearRenameEdit: (): void => {
      // the grid rebuild's seam: it must run the REAL cancel path — the
      // editor removed, the hidden label restored, the pointer reset — and a
      // cancelled CREATE must drop its placeholder (the create is only named
      // and only undoable at COMMIT time, so a state-drop left an unnamed
      // "Untitled.txt" on disk that no undo batch could remove).
      finishInlineRename(false);
    },
    finishInlineRename,
    startInlineRename,
    startInlineCreate,
  };
};
