import { describe, expect, test } from "bun:test";
import path from "node:path";
import { makeMenuEntries, pasteLabel, type MenuEntriesCtx } from "./menu-entries";
import type { SortMode } from "../lib/sort";
import { trashDir } from "../fs/fsutil";
import type { ClipItem, GridTileRef } from "../input/grid-input";
import type { Place } from "../fs/places";
import type { LoadedPlugin } from "../plugins/plugin-api";

// full-shape fakes (absent builders are null, never undefined — matches what
// the loader hands out, so the guards are exercised exactly as in prod)
const fakePlugin = (over: Partial<LoadedPlugin> & { name: string }): LoadedPlugin => ({
  version: "",
  author: "",
  description: "",
  rows: [],
  fileMenu: null,
  sidebarMenu: null,
  emptyAreaMenu: null,
  commands: [],
  preview: [],
  store: {
    get: (_k: string, fb: unknown) => fb as never,
    set: () => {},
  },
  deactivate: null,
  file: `/fake/${over.name}.ts`,
  ...over,
});

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
    connectServer: (raw) => calls.push(`connect:${raw ?? ""}`),
    disconnectServer: (p) => calls.push(`disconnect:${p}`),
    navigate: (d) => calls.push(`navigate:${d}`),
    newTab: (d) => calls.push(`newTab:${d}`),
    openWith: (p) => calls.push(`openWith:${p}`),
    renderAll: () => calls.push("renderAll"),
    renderGrid: () => {
      calls.push("renderGrid");
    },
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
    duplicate: (ps) => calls.push(`duplicate:${ps.join(",")}`),
    startInlineRename: (k) => calls.push(`rename:${k}`),
    startInlineCreate: (k) => calls.push(`create:${k}`),
    startBulkRename: (ps) => calls.push(`bulkrename:${ps.join(",")}`),
    trashPaths: (ps) => {
      calls.push(`trash:${ps.join(",")}`);
      return Promise.resolve();
    },
    restoreFromTrash: (ps) => {
      calls.push(`restore:${ps.join(",")}`);
      return Promise.resolve();
    },
    openProperties: (p) => calls.push(`props:${p}`),
    selectAll: () => calls.push("selectAll"),
    cwd: () => "/home/u",
    canExtract: () => true,
    extractArchive: (files, dest) => calls.push(`extract:${files.join(",")}:${dest}`),
    compressionFormats: () => ["tar.gz", "zip"],
    compressTo: (paths) => calls.push(`compressTo:${paths.join(",")}`),
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
  network: p.network,
  networkUri: p.networkUri,
  action: p.action,
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
    expect(file[0]!.submenu!.map((e) => e.label)).toEqual(["Open", "Open With…"]);
    file[0]!.submenu![0]!.action();
    expect(ctx.calls).toContain("open:/a");
    file[0]!.submenu![1]!.action();
    expect(ctx.calls).toContain("openWith:/a");

    const dir = m.fileEntriesFor("/d", true, 0, 0);
    expect(dir[0]!.label).toBe("Open");
    expect(dir[0]!.submenu!.map((e) => e.label)).toEqual(["Open", "Open in New Tab", "Open Terminal Here"]);
    dir[0]!.submenu![0]!.action();
    expect(ctx.calls).toContain("navigate:/d");
    dir[0]!.submenu![1]!.action();
    expect(ctx.calls).toContain("newTab:/d");
    dir[0]!.submenu![2]!.action();
    expect(ctx.calls).toContain("term:/d");
    const paste = dir.find((e) => e.label.includes("into folder"));
    expect(paste?.label).toBe("Paste 1 item into folder");
    paste!.action();
    expect(ctx.calls).toContain("paste:/d");
  });

  test("copy/cut/trash target the whole selection", () => {
    const ctx = baseCtx();
    ctx.tileRefs = new Map<string, GridTileRef>([["/a", { selected: true, isDir: false }]]);
    ctx.selPaths = () => [
      { path: "/a", isDir: false },
      { path: "/b", isDir: false },
    ];
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

  test("rename opens bulk rename for a multi-selection, inline for one", () => {
    const ctx = baseCtx();
    ctx.tileRefs = new Map<string, GridTileRef>([["/a", { selected: true, isDir: false }]]);
    ctx.selPaths = () => [
      { path: "/a", isDir: false },
      { path: "/b", isDir: false },
    ];
    const m = makeMenuEntries(ctx);
    const bulk = m.fileEntriesFor("/a", false, 0, 0).find((e) => e.label.startsWith("Rename"))!;
    expect(bulk.label).toBe("Rename 2 items…");
    bulk.action();
    expect(ctx.calls).toContain("bulkrename:/a,/b");

    const solo = m.fileEntriesFor("/z", false, 0, 0).find((e) => e.label.startsWith("Rename"))!;
    solo.action();
    expect(ctx.calls).toContain("rename:/z");
  });

  test("duplicate targets the whole selection", () => {
    const ctx = baseCtx();
    ctx.tileRefs = new Map<string, GridTileRef>([["/a", { selected: true, isDir: false }]]);
    ctx.selPaths = () => [
      { path: "/a", isDir: false },
      { path: "/b", isDir: false },
    ];
    const m = makeMenuEntries(ctx);
    const dup = m.fileEntriesFor("/a", false, 0, 0).find((e) => e.label.startsWith("Duplicate"))!;
    expect(dup.label).toBe("Duplicate 2 items");
    dup.action();
    expect(ctx.calls).toContain("duplicate:/a,/b");
  });

  test("properties target the whole selection, single when outside it", () => {
    const ctx = baseCtx();
    ctx.tileRefs = new Map<string, GridTileRef>([["/a", { selected: true, isDir: false }]]);
    ctx.selPaths = () => [
      { path: "/a", isDir: false },
      { path: "/b", isDir: false },
    ];
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
    const homeOpen = home.find((e) => e.label === "Open")!;
    expect(homeOpen.submenu!.map((e) => e.label)).toEqual(["Open", "Open in New Tab", "Open Terminal Here"]);
    homeOpen.submenu![2]!.action();
    expect(ctx.calls).toContain("term:/home/u");

    const trash = m.sidebarEntriesFor(place({ path: TRASH_FILES }), 0, 0);
    expect(trash.some((e) => e.label.startsWith("Paste"))).toBe(false);
    expect(trash.some((e) => e.label === "Empty Trash")).toBe(true);

    const recent = m.sidebarEntriesFor(place({ scheme: "recent" }), 0, 0);
    recent.find((e) => e.label === "Open")!.submenu![0]!.action();
    expect(ctx.calls).toContain("navigate:recent://");
  });

  test("network places: mounted share disconnects, saved connection connects", () => {
    const ctx = baseCtx();
    const m = makeMenuEntries(ctx);
    const mountPath = "/run/user/4242/gvfs/sftp:host=example.com,user=bob";
    const mounted = m.sidebarEntriesFor(
      place({ path: mountPath, network: true, networkUri: "sftp://bob@example.com/" }),
      0,
      0,
    );
    mounted.find((e) => e.label === "Disconnect")!.action();
    expect(ctx.calls).toContain(`disconnect:${mountPath}`);

    const saved = m.sidebarEntriesFor(
      place({ path: null, network: true, networkUri: "sftp://bob@example.com/" }),
      0,
      0,
    );
    saved.find((e) => e.label === "Connect")!.action();
    expect(ctx.calls).toContain("connect:sftp://bob@example.com/");

    const connectRow = m.sidebarEntriesFor(place({ path: null, action: "connect" }), 0, 0);
    connectRow.find((e) => e.label === "Connect to Server…")!.action();
    expect(ctx.calls).toContain("connect:");
  });

  test("no terminal / paste on virtual places (URIs are not shell cwds)", () => {
    // openTerminalHere falls back to home only on its no-arg path — an
    // explicit recent:// target would spawn the PTY in a bogus cwd.
    const ctx = baseCtx();
    const m = makeMenuEntries(ctx);
    const recent = m.sidebarEntriesFor(place({ scheme: "recent" }), 0, 0);
    expect(recent.some((e) => e.label === "Open Terminal Here")).toBe(false);
    expect(recent.find((e) => e.label === "Open")!.submenu!.some((e) => e.label === "Open Terminal Here")).toBe(false);
    expect(recent.some((e) => e.label.startsWith("Paste"))).toBe(false);
  });

  test("eject / mount / bookmark removal", () => {
    const ctx = baseCtx();
    const m = makeMenuEntries(ctx);
    m.sidebarEntriesFor(place({ path: "/media/usb", ejectable: true, device: "sdb1" }), 0, 0)
      .find((e) => e.label === "Eject")!
      .action();
    expect(ctx.calls).toContain("eject:sdb1");

    m.sidebarEntriesFor(place({ mountDevice: "sdc" }), 0, 0)
      .find((e) => e.label === "Mount")!
      .action();
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

  test("trash view empty-area is Empty Trash + select only (no create/paste/terminal)", () => {
    // Trash is not a workspace: New File/Folder silently no-op there
    // (startInlineCreate guards trash) and pasting lands files with no
    // .trashinfo — so the menu must not offer them. Nautilus parity.
    const ctx = baseCtx();
    ctx.inTrashView = () => true;
    const m = makeMenuEntries(ctx);
    const entries = m.emptyAreaEntries(0, 0);
    expect(entries.map((e) => e.label)).toEqual(["Empty Trash", "Select all"]);
  });
});

describe("plugin fileMenu entries", () => {
  test("plugin entries append after core rows with the selection paths", () => {
    const ctx = baseCtx();
    (ctx as any).plugins = () => [
      fakePlugin({
        name: "insp",
        fileMenu: (sel: { paths: string[] }) => [
          {
            label: `Inspect ${sel.paths.length}`,
            run: (paths: string[]) => ctx.calls.push(`inspect:${paths.join(",")}`),
          },
        ],
      }),
    ];
    const m = makeMenuEntries(ctx);
    const entries = m.fileEntriesFor("/a", false, 0, 0);
    expect(entries.at(-1)!.label).toBe("Inspect 1");
    entries.at(-1)!.action();
    // menu closes before the plugin runs (same rule as Properties…)
    expect(ctx.calls.indexOf("close")).toBeLessThan(ctx.calls.indexOf("inspect:/a"));
  });

  test("a throwing fileMenu never breaks the menu; malformed entries drop", () => {
    const ctx = baseCtx();
    (ctx as any).plugins = () => [
      fakePlugin({
        name: "bad",
        fileMenu: () => {
          throw new Error("boom");
        },
      }),
      fakePlugin({
        name: "messy",
        fileMenu: () => [{ label: "Good" } as any, { label: 42, run: () => {} } as any, null as any],
      }),
    ];
    const m = makeMenuEntries(ctx);
    const entries = m.fileEntriesFor("/a", false, 0, 0);
    expect(entries.some((e) => e.label.startsWith("Inspect"))).toBe(false);
    expect(entries.some((e) => e.label === "Good")).toBe(false); // missing run
    expect(entries.some((e) => e.label === "Open")).toBe(true); // core intact
  });

  test("no plugins field means no plugin section (existing menus frozen)", () => {
    const ctx = baseCtx();
    const m = makeMenuEntries(ctx);
    expect(m.fileEntriesFor("/a", false, 0, 0).some((e) => e.sep)).toBe(false);
  });

  test("sidebar plugins append after core rows with the place target", () => {
    const ctx = baseCtx();
    (ctx as any).plugins = () => [
      fakePlugin({
        name: "side",
        sidebarMenu: (place: { path?: string | null }) => [
          { label: `Side ${place.path}`, run: (paths: string[]) => ctx.calls.push(`side:${paths.join(",")}`) },
        ],
      }),
    ];
    const m = makeMenuEntries(ctx);
    const entries = m.sidebarEntriesFor({ path: "/media/usb" } as any, 0, 0);
    expect(entries.at(-1)!.label).toBe("Side /media/usb");
    entries.at(-1)!.action();
    expect(ctx.calls.indexOf("close")).toBeLessThan(ctx.calls.indexOf("side:/media/usb"));
  });

  test("empty-area plugins append with cwd; throwing builder drops section only", () => {
    const ctx = baseCtx();
    (ctx as any).plugins = () => [
      fakePlugin({
        name: "bad",
        emptyAreaMenu: () => {
          throw new Error("boom");
        },
      }),
      fakePlugin({
        name: "good",
        emptyAreaMenu: (area: { cwd: string }) => [{ label: `Here ${area.cwd}`, run: () => {} }],
      }),
    ];
    const m = makeMenuEntries(ctx);
    const entries = m.emptyAreaEntries(0, 0);
    expect(entries.some((e) => e.label === "Here /home/u")).toBe(true);
    expect(entries.some((e) => e.label === "New File")).toBe(true);
  });

  test("an async-rejecting plugin run still closes the menu and reports (no unhandled rejection)", async () => {
    const ctx = baseCtx();
    const errs: Array<{ name: string; err: unknown }> = [];
    (ctx as any).onPluginError = (name: string, err: unknown) => errs.push({ name, err });
    (ctx as any).plugins = () => [
      fakePlugin({
        name: "slow-boom",
        fileMenu: () => [
          {
            label: "SlowBoom",
            run: async () => {
              throw new Error("async-run-boom");
            },
          },
        ],
      }),
    ];
    const m = makeMenuEntries(ctx);
    const boom = m.fileEntriesFor("/a", false, 0, 0).find((e) => e.label === "SlowBoom")!;
    expect(() => boom.action()).not.toThrow();
    expect(ctx.calls).toContain("close");
    await Bun.sleep(10);
    expect(errs.length).toBe(1);
    expect(errs[0]!.name).toBe("slow-boom");
  });

  test("a throwing plugin run still closes the menu and reports via onPluginError", () => {
    const ctx = baseCtx();
    const errs: Array<{ name: string; err: unknown }> = [];
    (ctx as any).onPluginError = (name: string, err: unknown) => errs.push({ name, err });
    (ctx as any).plugins = () => [
      fakePlugin({
        name: "boom",
        fileMenu: () => [
          {
            label: "Boom",
            run: () => {
              throw new Error("run-boom");
            },
          },
        ],
      }),
    ];
    const m = makeMenuEntries(ctx);
    const entries = m.fileEntriesFor("/a", false, 0, 0);
    const boom = entries.find((e) => e.label === "Boom")!;
    expect(() => boom.action()).not.toThrow();
    // close runs first even when the plugin throws (same ordering rule)
    expect(ctx.calls).toContain("close");
    expect(errs.length).toBe(1);
    expect(errs[0]!.name).toBe("boom");
  });
});

describe("archive entries", () => {
  test("an archive target gets Extract Here plus one Compress to… row", () => {
    const ctx = baseCtx();
    const m = makeMenuEntries(ctx);
    const entries = m.fileEntriesFor("/a.tar.gz", false, 0, 0);
    expect(entries.find((e) => e.label === "Extract Here")!.icon).toBe("zip-box");
    expect(entries.find((e) => e.label === "Compress to…")).toBeTruthy();
    expect(entries.filter((e) => e.label.startsWith("Compress")).length).toBe(1);

    entries.find((e) => e.label === "Extract Here")!.action();
    expect(ctx.calls).toContain("extract:/a.tar.gz:/home/u");
    entries.find((e) => e.label === "Compress to…")!.action();
    expect(ctx.calls).toContain("compressTo:/a.tar.gz");
    // menu closes before the op starts (same rule as Properties…)
    expect(ctx.calls.indexOf("close")).toBeLessThan(ctx.calls.indexOf("extract:/a.tar.gz:/home/u"));
  });

  test("non-archives hide extract but keep compress", () => {
    const ctx = baseCtx();
    ctx.canExtract = () => false;
    const m = makeMenuEntries(ctx);
    const entries = m.fileEntriesFor("/a.txt", false, 0, 0);
    expect(entries.some((e) => e.label === "Extract Here")).toBe(false);
    expect(entries.some((e) => e.label === "Compress to…")).toBe(true);
  });

  test("multi-selection of archives labels the count and extracts only archives", () => {
    const ctx = baseCtx();
    ctx.tileRefs = new Map<string, GridTileRef>([
      ["/a.tar.gz", { selected: true, isDir: false }],
      ["/b.zip", { selected: true, isDir: false }],
      ["/c.txt", { selected: true, isDir: false }],
    ]);
    ctx.selPaths = () => [
      { path: "/a.tar.gz", isDir: false },
      { path: "/b.zip", isDir: false },
      { path: "/c.txt", isDir: false },
    ];
    ctx.canExtract = (p) => p.endsWith(".tar.gz") || p.endsWith(".zip");
    const m = makeMenuEntries(ctx);
    const extract = m.fileEntriesFor("/a.tar.gz", false, 0, 0).find((e) => e.label === "Extract 2 Archives Here")!;
    extract.action();
    expect(ctx.calls).toContain("extract:/a.tar.gz,/b.zip:/home/u");
  });

  test("virtual cwd hides archive entries", () => {
    const ctx = baseCtx();
    ctx.cwd = () => "recent://";
    const m = makeMenuEntries(ctx);
    const entries = m.fileEntriesFor("/a.tar.gz", false, 0, 0);
    expect(entries.some((e) => e.label === "Extract Here")).toBe(false);
    expect(entries.some((e) => e.label.startsWith("Compress to"))).toBe(false);
  });

  test("directories compress but never extract", () => {
    const ctx = baseCtx();
    const m = makeMenuEntries(ctx);
    const entries = m.fileEntriesFor("/some-dir", true, 0, 0);
    expect(entries.some((e) => e.label === "Extract Here")).toBe(false);
    expect(entries.some((e) => e.label === "Compress to…")).toBe(true);
  });
});

describe("open as root", () => {
  test("file submenu gains Open as Root only when the seam exists", () => {
    const plain = makeMenuEntries(baseCtx());
    expect(plain.fileEntriesFor("/a", false, 0, 0)[0]!.submenu!.map((e) => e.label)).toEqual(["Open", "Open With…"]);
    const ctx = baseCtx() as ReturnType<typeof baseCtx> & { openAsRoot: (p: string) => void };
    ctx.openAsRoot = async (p: string) => {
      ctx.calls.push(`root:${p}`);
    };
    const m = makeMenuEntries(ctx);
    const sub = m.fileEntriesFor("/a", false, 0, 0)[0]!.submenu!;
    expect(sub.map((e) => e.label)).toEqual(["Open", "Open With…", "Open as Root"]);
    sub[2]!.action();
    expect(ctx.calls).toEqual(["close", "root:/a"]);
  });
});
