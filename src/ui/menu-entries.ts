// --- Menu entry builders: what the file / sidebar / empty-area context
// menus contain, as a factory with injected action callbacks (same seam as
// grid-input.ts). The floating menu widget itself lives in ./ui-menu. ---

import path from "node:path";
import { trashDir } from "../fs/fsutil";
import { setBookmarked, loadSystemPlaces, type Place } from "../fs/places";
import { RECENT_URI, STARRED_URI, isVirtualUri } from "../fs/uri";
import type { ListEntry } from "./ui-menu";
import type { ClipItem, GridTileRef } from "../input/grid-input";

export type SortMode = "name" | "size" | "mtime" | "type";

export type MenuEntriesCtx = {
  closeFileMenu(): void;
  navigate(dir: string): void;
  renderAll(): void;
  renderGrid(): void | Promise<void>;
  openTerminalHere(dir?: string): void;
  // clipboard is a mutable let in ./fileops — read live, never captured
  clipboard(): { mode: "copy" | "cut"; items: ClipItem[] } | null;
  pasteSmart(dest: string): void;
  confirmEmptyTrash(): void;
  confirmDeleteForever(paths: string[]): void;
  ejectDevice(device: string): void;
  mountDevice(device: string): void;
  inTrashView(): boolean;
  // structural view of the tile refs — full TileRefs satisfies it
  tileRefs: Map<string, GridTileRef>;
  selPaths(): ClipItem[];
  openFileDefault(p: string): void;
  setClipboard(mode: "copy" | "cut", items: ClipItem[]): void;
  startInlineRename(key: string): void;
  startInlineCreate(kind: "file" | "folder"): void;
  trashPaths(paths: string[]): void;
  restoreFromTrash(paths: string[]): void;
  openProperties(p: string | string[]): void;
  selectAll(): void;
  cwd(): string;
  // state is a stable object ref — mutated in place by pick()
  sortState: { sortBy: SortMode; sortAsc: boolean };
};

// "Paste" / "Paste 3 items" — shared by sidebar, file menu and empty-area menu
export const pasteLabel = (n: number, into = ""): string =>
  n > 0 ? `Paste ${n} item${n === 1 ? "" : "s"}${into}` : `Paste${into}`;

export const makeMenuEntries = (ctx: MenuEntriesCtx) => {
  const trashFiles = (): string => path.join(trashDir(), "files");

  const selectAllEntry = (): ListEntry => ({
    icon: "select-all",
    label: "Select all",
    action: () => {
      ctx.closeFileMenu();
      ctx.selectAll();
    },
  });

  const sidebarEntriesFor = (place: Place, _x: number, _y: number): ListEntry[] => {
    const target = place.scheme === "recent" ? RECENT_URI : place.scheme === "starred" ? STARRED_URI : place.path;
    const entries: ListEntry[] = [];
    if (target) {
      entries.push({
        icon: "folder",
        label: "Open",
        action: () => {
          ctx.closeFileMenu();
          ctx.navigate(target);
        },
      });
      // terminal + paste need a real fs dir: virtual URIs are not shell cwds
      // (openTerminalHere only falls back to home on its no-arg path)
      if (!place.scheme) {
        entries.push({
          icon: "terminal",
          label: "Open Terminal Here",
          action: () => {
            ctx.closeFileMenu();
            ctx.openTerminalHere(target);
          },
        });
      }
      // paste into real places (not virtual views, not the trash)
      if (!place.scheme && target !== trashFiles()) {
        entries.push({
          icon: "content-paste",
          label: pasteLabel(ctx.clipboard()?.items.length ?? 0),
          action: () => {
            ctx.closeFileMenu();
            ctx.pasteSmart(target);
          },
        });
      }
      if (target === trashFiles()) {
        entries.push({
          icon: "trash-can",
          label: "Empty Trash",
          action: () => {
            ctx.closeFileMenu();
            ctx.confirmEmptyTrash();
          },
        });
      } else if (place.bookmarked) {
        entries.push({
          icon: "bookmark",
          label: "Remove bookmark",
          action: () => {
            ctx.closeFileMenu();
            void setBookmarked(target, false)
              .then(() => loadSystemPlaces())
              .then(() => ctx.renderAll());
          },
        });
      }
    }
    if (place.ejectable && place.device) {
      entries.push({
        icon: "eject",
        label: "Eject",
        action: () => {
          ctx.closeFileMenu();
          ctx.ejectDevice(place.device!);
        },
      });
    }
    if (!target && place.mountDevice) {
      entries.push({
        icon: "usb",
        label: "Mount",
        action: () => {
          ctx.closeFileMenu();
          ctx.mountDevice(place.mountDevice!);
        },
      });
    }
    return entries;
  };

  const fileEntriesFor = (targetPath: string, isDir: boolean, _x: number, _y: number): ListEntry[] => {
    const entries: ListEntry[] = [];
    // Nautilus trash semantics: Restore / Open / delete-for-real; no rename,
    // clipboard ops or trashing inside the trash
    if (ctx.inTrashView()) {
      const inSel = !!ctx.tileRefs.get(targetPath)?.selected;
      const targets: ClipItem[] = inSel && ctx.selPaths().length > 1 ? ctx.selPaths() : [{ path: targetPath, isDir }];
      entries.push(
        {
          icon: "folder",
          label: `Restore${inSel && targets.length > 1 ? ` ${targets.length} items` : ""}`,
          action: () => {
            ctx.closeFileMenu();
            ctx.restoreFromTrash(targets.map((t) => t.path));
          },
        },
        {
          icon: "eye",
          label: "Open",
          action: () => {
            ctx.closeFileMenu();
            ctx.openFileDefault(targetPath);
          },
        },
        {
          icon: "trash-can",
          label: `Delete permanently`,
          action: () => {
            ctx.closeFileMenu();
            ctx.confirmDeleteForever(targets.map((t) => t.path));
          },
        },
      );
      return entries;
    }
    if (isDir)
      entries.push({
        icon: "folder",
        label: "Open",
        action: () => {
          ctx.closeFileMenu();
          ctx.navigate(targetPath);
        },
      });
    else
      entries.push({
        icon: "eye",
        label: "Open",
        action: () => {
          ctx.closeFileMenu();
          ctx.openFileDefault(targetPath);
        },
      });
    // actions apply to the whole live selection when the right-clicked tile is
    // part of it (Nautilus behavior), otherwise just this tile
    const inSel = !!ctx.tileRefs.get(targetPath)?.selected;
    const targets: ClipItem[] = inSel && ctx.selPaths().length > 1 ? ctx.selPaths() : [{ path: targetPath, isDir }];
    const nSuffix = inSel && targets.length > 1 ? ` ${targets.length} items` : "";
    entries.push(
      {
        icon: "content-copy",
        label: `Copy${nSuffix}`,
        action: () => {
          ctx.closeFileMenu();
          ctx.setClipboard("copy", targets);
        },
      },
      {
        icon: "content-cut",
        label: `Cut${nSuffix}`,
        action: () => {
          ctx.closeFileMenu();
          ctx.setClipboard("cut", targets);
        },
      },
      ...(isDir
        ? [
            {
              icon: "content-paste",
              label: pasteLabel(ctx.clipboard()?.items.length ?? 0, " into folder"),
              action: () => {
                ctx.closeFileMenu();
                ctx.pasteSmart(targetPath);
              },
            } satisfies ListEntry,
          ]
        : []),
      {
        icon: "pencil",
        label: "Rename…",
        action: () => {
          ctx.closeFileMenu();
          ctx.startInlineRename(targetPath);
        },
      },
      {
        icon: "trash-can",
        label: `Trash${nSuffix}`,
        action: () => {
          ctx.closeFileMenu();
          ctx.trashPaths(targets.map((t) => t.path));
        },
      },
    );
    entries.push({
      icon: "information",
      label: "Properties…",
      action: () => {
        ctx.closeFileMenu();
        ctx.openProperties(inSel && targets.length > 1 ? targets.map((t) => t.path) : targetPath);
      },
    });
    return entries;
  };

  const sortEntries = (): ListEntry[] => {
    // nautilus convention: picking a different key sorts it in its natural
    // direction; clicking the active key flips ascending/descending.
    // Direction arrow sits at the row's right edge via hint.
    const pick = (key: SortMode, naturalAsc: boolean): void => {
      ctx.closeFileMenu();
      if (ctx.sortState.sortBy === key) ctx.sortState.sortAsc = !ctx.sortState.sortAsc;
      else {
        ctx.sortState.sortBy = key;
        ctx.sortState.sortAsc = naturalAsc;
      }
      void ctx.renderGrid();
    };
    const entry = (key: SortMode, label: string, naturalAsc: boolean): ListEntry => ({
      label,
      ...(ctx.sortState.sortBy === key ? { hintIcon: ctx.sortState.sortAsc ? "arrow-up" : "arrow-down" } : {}),
      action: () => pick(key, naturalAsc),
    });
    return [
      entry("name", "Name", true),
      entry("size", "Size", false),
      entry("mtime", "Modified", true),
      entry("type", "Type", true),
    ];
  };

  const emptyAreaEntries = (_x: number, _y: number): ListEntry[] => {
    const entries: ListEntry[] = [];
    if (ctx.inTrashView()) {
      // Trash is not a workspace: New File/Folder silently no-op here
      // (startInlineCreate guards trash) and pasting would land files with
      // no .trashinfo — so unlike normal dirs it gets Empty Trash + select
      // only, not the create/paste/terminal set.
      entries.push({
        icon: "trash-can",
        label: "Empty Trash",
        action: () => {
          ctx.closeFileMenu();
          ctx.confirmEmptyTrash();
        },
      });
      entries.push(selectAllEntry());
      return entries;
    }
    if (isVirtualUri(ctx.cwd())) {
      // read-only virtual views: nothing to paste or create here
      entries.push(selectAllEntry());
      return entries;
    }
    entries.push(
      {
        icon: "file",
        label: "New File",
        action: () => {
          ctx.closeFileMenu();
          ctx.startInlineCreate("file");
        },
      },
      {
        icon: "folder-plus",
        label: "New Folder",
        action: () => {
          ctx.closeFileMenu();
          ctx.startInlineCreate("folder");
        },
      },
      selectAllEntry(),
      {
        icon: "content-paste",
        label: pasteLabel(ctx.clipboard()?.items.length ?? 0),
        action: () => {
          ctx.closeFileMenu();
          ctx.pasteSmart(ctx.cwd());
        },
      },
      {
        icon: "information",
        label: "Properties…",
        action: () => {
          ctx.closeFileMenu();
          ctx.openProperties(ctx.cwd());
        },
      },
      // nautilus puts shell access in its own group at the bottom
      { sep: true, label: "", action: () => {} },
      {
        icon: "terminal",
        label: "Open Terminal Here",
        action: () => {
          ctx.closeFileMenu();
          ctx.openTerminalHere();
        },
      },
    );
    return entries;
  };

  return { sidebarEntriesFor, fileEntriesFor, sortEntries, emptyAreaEntries };
};
