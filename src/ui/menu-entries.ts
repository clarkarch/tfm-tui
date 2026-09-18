// --- Menu entry builders: what the file / sidebar / empty-area context
// menus contain, as a factory with injected action callbacks (same seam as
// grid-input.ts). The floating menu widget itself lives in ./ui-menu. ---

import path from "node:path";
import { trashDir } from "../fs/fsutil";
import { setBookmarked, loadSystemPlaces, type Place } from "../fs/places";
import { RECENT_URI, STARRED_URI, isVirtualUri } from "../fs/uri";
import type { CompressionFormat } from "../fs/archive";
import type { ListEntry } from "./ui-menu";
import type { ClipItem, GridTileRef } from "../input/grid-input";
import type { LoadedPlugin, PluginFileMenuEntry } from "../plugins/plugin-api";
import { invokeIsolated } from "../lib/uiutil";
import type { SortMode } from "../lib/sort";

export type MenuEntriesCtx = {
  closeFileMenu(): void;
  navigate(dir: string): void;
  newTab(dir: string): void;
  // open a file with a chosen application (the pick overlay lists handlers)
  openWith(path: string): void;
  renderAll(): void;
  renderGrid(): void | Promise<void>;
  openTerminalHere(dir?: string): void;
  // network locations (gvfs): no-arg opens the "Connect to Server…" prompt,
  // a URI arg connects straight to a saved connection; disconnect takes the
  // active mount's local path
  connectServer(raw?: string): void;
  disconnectServer(path: string): void;
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
  duplicate(paths: string[]): void;
  startInlineRename(key: string): void;
  startInlineCreate(kind: "file" | "folder"): void;
  startBulkRename(paths: string[]): void;
  trashPaths(paths: string[]): Promise<void>;
  restoreFromTrash(paths: string[]): Promise<void>;
  openProperties(p: string | string[]): void;
  selectAll(): void;
  cwd(): string;
  // archive ops + host-gated availability (src/fs/archive via the wiring).
  // canExtract decides the per-target entry; compressTo opens the floating
  // format picker; compressionFormats only gates whether the row shows at all.
  canExtract(p: string): boolean;
  extractArchive(files: string[], destDir: string): void;
  compressionFormats(): CompressionFormat[];
  compressTo(paths: string[]): void;
  // state is a stable object ref — mutated in place by pick()
  sortState: { sortBy: SortMode; sortAsc: boolean };
  // installed plugins (loader aggregates them; absent = no plugin section).
  // fileMenu builders run with the selection-aware paths at menu-build time.
  plugins?: () => LoadedPlugin[];
  // runtime isolation: a throwing plugin run() must never break the menu's
  // close path — reported once per invocation, menu stays intact.
  onPluginError?: (pluginName: string, err: unknown) => void;
};

// "Paste" / "Paste 3 items" — shared by sidebar, file menu and empty-area menu
export const pasteLabel = (n: number, into = ""): string =>
  n > 0 ? `Paste ${n} item${n === 1 ? "" : "s"}${into}` : `Paste${into}`;

export const makeMenuEntries = (ctx: MenuEntriesCtx) => {
  const trashFiles = (): string => path.join(trashDir(), "files");

  // plugin menu sections: one entry list per installed plugin. A throwing
  // builder or a malformed entry drops that plugin's section — never the menu
  // (a throw after the panel started building would leave it half-rendered).
  // A throwing run() still closes the menu first, then reports via
  // onPluginError — the menu's close path never breaks.
  const toListEntries = (
    pluginName: string,
    items: PluginFileMenuEntry[] | null | undefined,
    paths: string[],
  ): ListEntry[] => {
    const out: ListEntry[] = [];
    for (const e of items ?? []) {
      if (!e || typeof e.label !== "string" || typeof e.run !== "function") continue;
      const run = e.run;
      const hint = typeof e.hint === "string" ? e.hint : undefined;
      out.push({
        label: e.label,
        ...(hint ? { hint } : {}),
        action: () => {
          ctx.closeFileMenu();
          // invokeIsolated: plugin run() may be async (typed sync) — sync
          // try/catch alone would leave rejections unhandled and unreported.
          invokeIsolated(
            () => run(paths),
            (err) => ctx.onPluginError?.(pluginName, err),
          );
        },
      });
    }
    return out;
  };

  const pluginEntriesFor = (targets: ClipItem[]): ListEntry[] => {
    const paths = targets.map((t) => t.path);
    const out: ListEntry[] = [];
    for (const p of ctx.plugins?.() ?? []) {
      if (!p.fileMenu) continue;
      try {
        out.push(...toListEntries(p.name, p.fileMenu({ paths }), paths));
      } catch {}
    }
    return out;
  };

  const pluginSidebarFor = (place: { path?: string | null; scheme?: string }): ListEntry[] => {
    const paths = place.path ? [place.path] : [];
    const out: ListEntry[] = [];
    for (const p of ctx.plugins?.() ?? []) {
      if (!p.sidebarMenu) continue;
      try {
        out.push(...toListEntries(p.name, p.sidebarMenu({ path: place.path, scheme: place.scheme }), paths));
      } catch {}
    }
    return out;
  };

  const pluginEmptyFor = (cwd: string): ListEntry[] => {
    const out: ListEntry[] = [];
    for (const p of ctx.plugins?.() ?? []) {
      if (!p.emptyAreaMenu) continue;
      try {
        out.push(...toListEntries(p.name, p.emptyAreaMenu({ cwd }), [cwd]));
      } catch {}
    }
    return out;
  };

  const withPluginSection = (entries: ListEntry[], targets: ClipItem[]): ListEntry[] => {
    const extra = pluginEntriesFor(targets);
    if (!extra.length) return entries;
    entries.push({ sep: true, label: "", action: () => {} }, ...extra);
    return entries;
  };

  const withSidebarPluginSection = (
    entries: ListEntry[],
    place: { path?: string | null; scheme?: string },
  ): ListEntry[] => {
    const extra = pluginSidebarFor(place);
    if (!extra.length) return entries;
    entries.push({ sep: true, label: "", action: () => {} }, ...extra);
    return entries;
  };

  const withEmptyPluginSection = (entries: ListEntry[], cwd: string): ListEntry[] => {
    const extra = pluginEmptyFor(cwd);
    if (!extra.length) return entries;
    entries.push({ sep: true, label: "", action: () => {} }, ...extra);
    return entries;
  };

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
      const openSub: ListEntry[] = [
        {
          icon: "folder",
          label: "Open",
          action: () => {
            ctx.closeFileMenu();
            ctx.navigate(target);
          },
        },
        {
          icon: "plus",
          label: "Open in New Tab",
          action: () => {
            ctx.closeFileMenu();
            ctx.newTab(target);
          },
        },
      ];
      // terminal needs a real fs dir: virtual URIs are not shell cwds
      // (openTerminalHere only falls back to home on its no-arg path)
      if (!place.scheme) {
        openSub.push({
          icon: "terminal",
          label: "Open Terminal Here",
          action: () => {
            ctx.closeFileMenu();
            ctx.openTerminalHere(target);
          },
        });
      }
      entries.push({ icon: "folder", label: "Open", action: () => {}, submenu: openSub });
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
    // network locations: active mounts can disconnect, unmounted saved
    // connections connect, and the pseudo-row opens the prompt
    if (place.action === "connect") {
      entries.push({
        icon: "network",
        label: "Connect to Server…",
        action: () => {
          ctx.closeFileMenu();
          ctx.connectServer();
        },
      });
    } else if (place.network && place.path) {
      entries.push({
        icon: "network",
        label: "Disconnect",
        action: () => {
          ctx.closeFileMenu();
          ctx.disconnectServer(place.path!);
        },
      });
    } else if (place.network && place.networkUri) {
      entries.push({
        icon: "network",
        label: "Connect",
        action: () => {
          ctx.closeFileMenu();
          ctx.connectServer(place.networkUri!);
        },
      });
    }
    return withSidebarPluginSection(entries, { path: place.path, scheme: place.scheme });
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
      return withPluginSection(entries, targets);
    }
    // nested Open: dirs can open in a new tab / terminal, files offer the
    // default app or an "Open With…" chooser. A parent row is a flyout, not
    // directly actionable.
    if (isDir) {
      entries.push({
        icon: "folder",
        label: "Open",
        action: () => {},
        submenu: [
          {
            icon: "folder",
            label: "Open",
            action: () => {
              ctx.closeFileMenu();
              ctx.navigate(targetPath);
            },
          },
          {
            icon: "plus",
            label: "Open in New Tab",
            action: () => {
              ctx.closeFileMenu();
              ctx.newTab(targetPath);
            },
          },
          {
            icon: "terminal",
            label: "Open Terminal Here",
            action: () => {
              ctx.closeFileMenu();
              ctx.openTerminalHere(targetPath);
            },
          },
        ],
      });
    } else {
      entries.push({
        icon: "eye",
        label: "Open",
        action: () => {},
        submenu: [
          {
            icon: "eye",
            label: "Open",
            action: () => {
              ctx.closeFileMenu();
              ctx.openFileDefault(targetPath);
            },
          },
          {
            icon: "cog",
            label: "Open With…",
            action: () => {
              ctx.closeFileMenu();
              ctx.openWith(targetPath);
            },
          },
        ],
      });
    }
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
      {
        icon: "content-copy",
        label: `Duplicate${nSuffix}`,
        action: () => {
          ctx.closeFileMenu();
          ctx.duplicate(targets.map((t) => t.path));
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
        label: targets.length > 1 ? `Rename ${targets.length} items…` : "Rename…",
        action: () => {
          ctx.closeFileMenu();
          if (targets.length > 1) ctx.startBulkRename(targets.map((t) => t.path));
          else ctx.startInlineRename(targetPath);
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
    // archive ops: real paths only (a recent:// target is not compressible and
    // a virtual cwd has no place to extract into)
    if (!isVirtualUri(ctx.cwd())) {
      const archives = targets.map((t) => t.path).filter((p) => ctx.canExtract(p));
      if (!isDir && archives.length) {
        entries.push({
          icon: "zip-box",
          label: archives.length > 1 ? `Extract ${archives.length} Archives Here` : "Extract Here",
          action: () => {
            ctx.closeFileMenu();
            ctx.extractArchive(archives, ctx.cwd());
          },
        });
      }
      const formats = ctx.compressionFormats();
      if (formats.length) {
        entries.push({
          icon: "package",
          label: "Compress to…",
          action: () => {
            ctx.closeFileMenu();
            ctx.compressTo(targets.map((t) => t.path));
          },
        });
      }
    }
    entries.push({
      icon: "information",
      label: "Properties…",
      action: () => {
        ctx.closeFileMenu();
        ctx.openProperties(inSel && targets.length > 1 ? targets.map((t) => t.path) : targetPath);
      },
    });
    return withPluginSection(entries, targets);
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
      return withEmptyPluginSection(entries, ctx.cwd());
    }
    if (isVirtualUri(ctx.cwd())) {
      // read-only virtual views: nothing to paste or create here
      entries.push(selectAllEntry());
      return withEmptyPluginSection(entries, ctx.cwd());
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
    return withEmptyPluginSection(entries, ctx.cwd());
  };

  return { sidebarEntriesFor, fileEntriesFor, sortEntries, emptyAreaEntries };
};
