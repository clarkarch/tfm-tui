import { describe, expect, test } from "bun:test";
import path from "node:path";
import { makeMenuEntries, pasteLabel, type MenuEntriesCtx, type SortMode } from "./menu-entries";
import { trashDir } from "./fsutil";
import type { ClipItem, GridTileRef } from "./grid-input";
import type { Place } from "./places";

const TRASH_FILES = path.join(trashDir(), "files");

const baseCtx = (): MenuEntriesCtx & {
  calls: string[];
  clip: { mode: "copy" | "cut"; items: ClipItem[] } | null;
  sort: { sortBy: SortMode; sortAsc: boolean };
} => {
  const calls: string[] = [];
  const clip = { mode: "copy" as const, items: [{ path: "/a", isDir: false }] };
  const sort = { sortBy: "name" as SortMode, sortAsc: true };
  const tileRefs = new Map<string, GridTileRef>([["/a", { selected: false, isDir: false }]]);
  return {
    calls,
    clip,
    sort,
    tileRefs,
    sortState: sort,
    closeFileMenu: () => calls.push("close"),
    navigate: (d) => calls.push(`navigate:${d}`),
    renderAll: () => calls.push("renderAll"),
    renderGrid: () => { calls.push("renderGrid"); },
    openTerminalHere: (d) => calls.push(`term:${d ?? ""}`),
    clipboard: () => clip,
    pasteSmart: (d) => calls.push(`paste:${d}`),
    confirmEmptyTrash: () => calls.push("emptyTrash"),
    confirmDeleteForever: (ps) => calls.push(`delForever:${ps.join(",")}`),
    ejectDevice: (dev) => calls.push(`eject:${dev}`),
    mountDevice: (dev) => calls.push(`mount:${dev}`),
    inTrashView: () => false,
    selPaths: () => [{ path: "/a", isDir: false }],
    openFileDefault: (p) => calls.push(`open:${p}`),
    setClipboard: (m, items) => calls.push(`clip:${m}:${items.length}`),
    startInlineRename: (k) => calls.push(`rename:${k}`),
    startInlineCreate: (k) => calls.push(`create:${k}`),
    trashPaths: (ps) => calls.push(`trash:${ps.join(",")}`),
    restoreFromTrash: (ps) => calls.push(`restore:${ps.join(",")}`),
    openProperties: (p) => calls.push(`props:${p}`),
    selectAll: () => calls.push("selectAll"),
    cwd: () => "/home/u",
  };
};

const place = (p: Partial<Place>): Place => ({
  icon: p.icon ?? "folder",
  label: p.label ?? "Home",
  path: p.path ?? null,
  ejectable: p.ejectable ?? false,
  device: p.device,
  mountDevice: p.mountDevice,
  scheme: p.scheme,
  bookmarked: p.bookmarked,
});

describe("pasteLabel", () => {
  test("counts items and appends suffix", () => {
    expect(pasteLabel(0)).toBe("Paste");
    expect(pasteLabel(1)).toBe("Paste 1 item");
    expect(pasteLabel(3)).toBe("Paste 3 items");
    expect(pasteLabel(2, " into folder")).toBe("Paste 2 items into folder");
  });
});

describe("fileEntriesFor", () => {
  test("file menu opens files, dirs get paste-into + navigate", () => {
    const ctx = baseCtx();
    const m = makeMenuEntries(ctx);
    const file = m.fileEntriesFor("/a", false, 0, 0);
    expect(file[0]!.label).toBe("Open");
    file[0]!.action();
    expect(ctx.calls).toContain("open:/a");

    const dir = m.fileEntriesFor("/d", true, 0, 0);
    expect(dir[0]!.label).toBe("Open");
    dir[0]!.action();
    expect(ctx.calls).toContain("navigate:/d");
    const paste = dir.find((e) => e.label.includes("into folder"));
    expect(paste?.label).toBe("Paste 1 item into folder");
    paste!.action();
    expect(ctx.calls).toContain("paste:/d");
  });

  test("copy/cut/trash target the whole selection", () => {
    const ctx = baseCtx();
    ctx.tileRefs = new Map<string, GridTileRef>([["/a", { selected: true, isDir: false }]]);
    ctx.selPaths = () => [{ path: "/a", isDir: false }, { path: "/b", isDir: false }];
    const m = makeMenuEntries(ctx);
    const entries = m.fileEntriesFor("/a", false, 0, 0);
    const copy = entries.find((e) => e.label.startsWith("Copy"));
    const cut = entries.find((e) => e.label.startsWith("Cut"));
    const trash = entries.find((e) => e.label.startsWith("Trash"));
    expect(copy!.label).toBe("Copy 2 items");
    cut!.action();
    expect(ctx.calls).toContain("clip:cut:2");
    trash!.action();
    expect(ctx.calls).toContain("trash:/a,/b");
  });

  test("properties target the whole selection, single when outside it", () => {
    const ctx = baseCtx();
    ctx.tileRefs = new Map<string, GridTileRef>([["/a", { selected: true, isDir: false }]]);
    ctx.selPaths = () => [{ path: "/a", isDir: false }, { path: "/b", isDir: false }];
    const m = makeMenuEntries(ctx);
    const props = m.fileEntriesFor("/a", false, 0, 0).find((e) => e.label === "Properties…")!;
    props.action();
    expect(ctx.calls).toContain("props:/a,/b");
    // the menu must close before the dialog opens — it floats above every
    // modal, so leaving it open leaves it stuck on the properties UI
    expect(ctx.calls.indexOf("close")).toBeGreaterThanOrEqual(0);
    expect(ctx.calls.indexOf("close")).toBeLessThan(ctx.calls.indexOf("props:/a,/b"));

    const solo = m.fileEntriesFor("/z", false, 0, 0).find((e) => e.label === "Properties…")!;
    solo.action();
    expect(ctx.calls).toContain("props:/z");
  });

  test("trash view offers restore / delete-permanently only", () => {
    const ctx = baseCtx();
    ctx.inTrashView = () => true;
    const m = makeMenuEntries(ctx);
    const entries = m.fileEntriesFor("/trash/f", false, 0, 0);
    expect(entries.map((e) => e.label).sort()).toEqual(["Delete permanently", "Open", "Restore"]);
    entries.find((e) => e.label === "Restore")!.action();
    expect(ctx.calls).toContain("restore:/trash/f");
  });
});

describe("sidebarEntriesFor", () => {
  test("paste offered for real dirs, not trash or virtual", () => {
    const ctx = baseCtx();
    const m = makeMenuEntries(ctx);
    const home = m.sidebarEntriesFor(place({ path: "/home/u" }), 0, 0);
    expect(home.some((e) => e.label.startsWith("Paste"))).toBe(true);

    const trash = m.sidebarEntriesFor(place({ path: TRASH_FILES }), 0, 0);
    expect(trash.some((e) => e.label.startsWith("Paste"))).toBe(false);
    expect(trash.some((e) => e.label === "Empty Trash")).toBe(true);

    const recent = m.sidebarEntriesFor(place({ scheme: "recent" }), 0, 0);
    recent.find((e) => e.label === "Open")!.action();
    expect(ctx.calls).toContain("navigate:recent://");
  });

  test("eject / mount / bookmark removal", () => {
    const ctx = baseCtx();
    const m = makeMenuEntries(ctx);
    m.sidebarEntriesFor(place({ path: "/media/usb", ejectable: true, device: "sdb1" }), 0, 0)
      .find((e) => e.label === "Eject")!.action();
    expect(ctx.calls).toContain("eject:sdb1");

    m.sidebarEntriesFor(place({ mountDevice: "sdc" }), 0, 0)
      .find((e) => e.label === "Mount")!.action();
    expect(ctx.calls).toContain("mount:sdc");

    const bm = m.sidebarEntriesFor(place({ path: "/home/u/Docs", bookmarked: true }), 0, 0);
    expect(bm.some((e) => e.label === "Remove bookmark")).toBe(true);
  });
});

describe("sortEntries / emptyAreaEntries", () => {
  test("picking active key flips direction, new key sets natural asc", () => {
    const ctx = baseCtx();
    ctx.sortState = { sortBy: "name", sortAsc: true };
    const m = makeMenuEntries(ctx);
    const entries = m.sortEntries();
    expect(entries.find((e) => e.label === "Name")!.hintIcon).toBe("arrow-up");
    entries.find((e) => e.label === "Name")!.action();
    expect(ctx.sortState).toEqual({ sortBy: "name", sortAsc: false });
    entries.find((e) => e.label === "Size")!.action();
    expect(ctx.sortState).toEqual({ sortBy: "size", sortAsc: false });
    expect(ctx.calls).toContain("close");
  });

  test("virtual cwd offers only select-all", () => {
    const ctx = baseCtx();
    ctx.cwd = () => "recent://";
    const m = makeMenuEntries(ctx);
    const entries = m.emptyAreaEntries(0, 0);
    expect(entries.map((e) => e.label)).toEqual(["Select all"]);
    entries[0]!.action();
    expect(ctx.calls).toContain("selectAll");
  });

  test("normal cwd: new file/folder, paste, terminal group", () => {
    const ctx = baseCtx();
    const m = makeMenuEntries(ctx);
    const entries = m.emptyAreaEntries(0, 0);
    expect(entries.find((e) => e.label === "New File")!.icon).toBe("file");
    expect(entries.find((e) => e.label === "New Folder")!.icon).toBe("folder-plus");
    expect(entries.some((e) => e.sep)).toBe(true);
    expect(entries.at(-1)!.label).toBe("Open Terminal Here");
    entries.find((e) => e.label.startsWith("Paste"))!.action();
    expect(ctx.calls).toContain("paste:/home/u");
  });

  test("trash view empty-area adds Empty Trash on top of the normal set", () => {
    const ctx = baseCtx();
    ctx.inTrashView = () => true;
    const m = makeMenuEntries(ctx);
    const entries = m.emptyAreaEntries(0, 0);
    expect(entries.some((e) => e.label === "Empty Trash")).toBe(true);
    expect(entries[0]!.label).toBe("Empty Trash");
  });
});
