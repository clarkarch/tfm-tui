import { describe, expect, test } from "bun:test";
import { makeKeyRouter, type KeyRouterCtx } from "./keymap";
import { makeSelection, type SelectionCtx } from "./selection";
import { defaultConfig } from "../config/config-schema";

const COLORS: any = {
  bg: "#111111",
  hoverBg: "#222222",
  accent: "#7aa2f7",
  accentBg: "#333333",
  sidebarFg: "#aaaaaa",
  sidebarFgMuted: "#666666",
};

const settleUntil = async (cond: () => boolean): Promise<void> => {
  const deadline = Date.now() + 2000;
  while (!cond() && Date.now() < deadline) await Bun.sleep(10);
};

const makeSelectionForTest = () => {
  const ctx: SelectionCtx = {
    colors: () => COLORS,
    uiStyle: () => "solid",
    byId: () => undefined,
    setText: () => {},
    setIconState: () => {},
    isCutKey: () => false,
    scroller: () => null,
    viewH: () => 4,
    rowHInit: () => 3,
    renderPreview: () => {},
  };
  return makeSelection(ctx);
};

type Harness = ReturnType<typeof makeHarness>;

const makeHarness = (over: Partial<KeyRouterCtx> = {}) => {
  const calls: string[] = [];
  const rec = (name: string) => () => {
    calls.push(name);
  };
  const selection = makeSelectionForTest();
  const seedTiles = (keys: string[]) => {
    selection.setFocusKeys(keys);
    keys.forEach((k, i) => {
      if (!selection.tileRefs.has(k)) {
        selection.tileRefs.set(k, {
          selected: false,
          baseFg: COLORS.sidebarFg,
          tileId: `t${i}`,
          labelId: `l${i}`,
          isDir: k.endsWith("/"),
        });
      }
    });
  };
  seedTiles(["a.txt", "b.txt", "c.txt", "d.txt"]);

  const state = { cwd: "/tmp/tfm-kb/sub", showHidden: false };
  const escMenuState = { open: false, capturing: false };
  let typeToSearchOn = true;
  const places = [
    { selected: false, place: { path: "/home" } as any },
    { selected: false, place: { path: "/media/usb", mountDevice: "sdb1" } as any },
  ];
  const binds: Record<string, string[]> = structuredClone(defaultConfig.keys);
  const pickState = { open: false };
  const bulkState = { open: false };

  const ctx: KeyRouterCtx = {
    byId: () => undefined,
    state,
    keybinds: (action) => binds[action] ?? [],
    quit: rec("quit"),
    restart: rec("restart"),
    conflict: { isOpen: () => false, closeConflict: (p) => calls.push(`conflict:close:${p}`) },
    yesNo: {
      isOpen: () => false,
      close: rec("yesno:close"),
      moveFocus: (d) => calls.push(`yesno:move:${d}`),
      submit: rec("yesno:submit"),
    },
    typeToSearchEnabled: () => typeToSearchOn,
    enableTypeToSearch: () => {
      typeToSearchOn = true;
      calls.push("search:enable");
    },
    cycleSort: rec("sort:cycle"),
    isRenaming: () => false,
    propsIsOpen: () => false,
    closeProps: rec("props:close"),
    escMenu: {
      isOpen: () => escMenuState.open,
      closeMenu: () => {
        escMenuState.open = false;
        calls.push("escmenu:close");
      },
      moveMenu: (d) => calls.push(`escmenu:move:${d}`),
      adjustSelectedSetting: (d) => calls.push(`escmenu:adjust:${d}`),
      menuActivate: rec("escmenu:activate"),
      menuTab: () => calls.push("escmenu:tab"),
      openMenu: () => {
        escMenuState.open = true;
        calls.push("escmenu:open");
      },
      captureKey: (e) => {
        if (!escMenuState.capturing) return false;
        if (e.name === "escape") escMenuState.capturing = false;
        calls.push(`capture:${e.name}`);
        return true;
      },
    },
    termOwnsKeyboard: () => false,
    pathEditMode: () => false,
    pathInputVisible: () => false,
    searchVisible: () => false,
    searchQuery: () => "",
    clearSearch: rec("search:clear"),
    exitPathEdit: rec("pathedit:exit"),
    beginTypeToSearch: (ch) => calls.push(`search:begin:${ch}`),
    renderGrid: rec("renderGrid"),
    renderPreview: rec("renderPreview"),
    renderAll: rec("renderAll"),
    selection,
    placesHost: places,
    normalizePlaces: rec("places:normalize"),
    mountDevice: (d) => calls.push(`mount:${d}`),
    navigate: (dir) => calls.push(`navigate:${dir}`),
    goBack: rec("back"),
    goFwd: rec("fwd"),
    openFileDefault: (p) => calls.push(`open:${p}`),
    home: "/home/u",
    getFileMenuState: () => null,
    closeFileMenu: rec("fmenu:close"),
    renderFileMenu: rec("fmenu:render"),
    openFileSubmenu: rec("fmenu:sub-open"),
    closeFileSubmenu: rec("fmenu:sub-close"),
    moveFileSubmenu: rec("fmenu:sub-move"),
    activateFileSubmenu: rec("fmenu:sub-activate"),
    nextTab: rec("tab:next"),
    prevTab: rec("tab:prev"),
    newTab: rec("tab:new"),
    closeTab: rec("tab:close"),
    switchTab: (i) => {
      calls.push(`tab:switch:${i}`);
    },
    inTrashView: () => false,
    confirmDeleteForever: (ps) => calls.push(`deleteForever:${ps.join(",")}`),
    trashPaths: (ps) => {
      calls.push(`trash:${ps.join(",")}`);
      return Promise.resolve();
    },
    restoreFromTrash: (ps) => {
      calls.push(`restore:${ps.join(",")}`);
      return Promise.resolve();
    },
    startInlineRename: (p) => calls.push(`rename:${p}`),
    startInlineCreate: (k) => calls.push(`create:${k}`),
    startBulkRename: (ps) => calls.push(`bulkopen:${ps.join(",")}`),
    bulkRename: {
      isOpen: () => bulkState.open,
      handleKey: (e) => calls.push(`bulk:${e.name}`),
    },
    openProperties: (ps) => calls.push(`props:${ps.join(",")}`),
    enterPathEdit: rec("pathedit:enter"),
    openTerminal: rec("term:open"),
    connectServer: rec("connect:server"),
    togglePreview: rec("preview:toggle"),
    toggleViewMode: rec("view:toggle"),
    zoomTiles: (d) => calls.push(`zoom:${d}`),
    toggleDualPane: rec("pane:toggle-dual"),
    switchPane: rec("pane:switch"),
    copyToOtherPane: rec("pane:copy"),
    moveToOtherPane: rec("pane:move"),
    setClipboard: (mode, items) => calls.push(`clip:${mode}:${items.length}`),
    duplicate: (paths) => calls.push(`duplicate:${paths.join(",")}`),
    isVirtualCwd: () => false,
    pasteSmart: (d) => calls.push(`paste:${d}`),
    notify: (m, t, l) => calls.push(`notify:${t}:${l}:${m}`),
    undoLast: rec("undo"),
    redoLast: rec("redo"),
    pick: {
      isOpen: () => pickState.open,
      handleKey: (e) => {
        calls.push(`pick:${e.name}`);
      },
    },
    ...over,
  };
  const router = makeKeyRouter(ctx);
  const key = (
    name: string,
    opts: { ctrl?: boolean; shift?: boolean; meta?: boolean; repeated?: boolean } = {},
  ): void =>
    router.handleKey({
      name,
      ctrl: !!opts.ctrl,
      shift: !!opts.shift,
      meta: !!opts.meta,
      repeated: !!opts.repeated,
    });
  return {
    router,
    ctx,
    calls,
    selection,
    places,
    state,
    escMenuState,
    seedTiles,
    key,
    binds,
    pickState,
    bulkState,
    setTypeToSearch: (v: boolean) => {
      typeToSearchOn = v;
    },
  };
};

// --- the modal precedence chain is load-bearing: quit > conflict > yes/no >
// rename > props > esc-menu > terminal > path-edit > file menu > search > ---

describe("precedence chain", () => {
  test("ctrl+q quits above everything, even an open conflict", () => {
    const h = makeHarness({
      conflict: { isOpen: () => true, closeConflict: (p) => h.calls.push(`conflict:close:${p}`) },
    });
    h.key("q", { ctrl: true });
    expect(h.calls).toEqual(["quit"]);
  });

  test("ctrl+alt+r restarts above everything, even an open conflict", () => {
    const h = makeHarness({
      conflict: { isOpen: () => true, closeConflict: (p) => h.calls.push(`conflict:close:${p}`) },
    });
    h.key("r", { ctrl: true, meta: true });
    expect(h.calls).toEqual(["restart"]);
  });

  test("held restart never queues overlapping teardown/spawn pairs", () => {
    const h = makeHarness();
    h.key("r", { ctrl: true, meta: true, repeated: true });
    expect(h.calls).toEqual([]);
  });

  test("a remap moves restart off ctrl+alt+r", () => {
    const h = makeHarness();
    h.binds.restart = ["ctrl+alt+t"];
    h.key("r", { ctrl: true, meta: true });
    expect(h.calls).toEqual([]);
    h.key("t", { ctrl: true, meta: true });
    expect(h.calls).toEqual(["restart"]);
  });

  test("conflict modal: esc = skip, everything else swallowed", () => {
    const h = makeHarness({
      conflict: { isOpen: () => true, closeConflict: (p) => h.calls.push(`conflict:close:${p}`) },
    });
    h.key("down");
    expect(h.calls).toEqual([]);
    h.key("escape");
    expect(h.calls).toEqual(["conflict:close:skip"]);
  });

  test("yes/no modal: esc = No, everything else swallowed", () => {
    const h = makeHarness({
      yesNo: {
        isOpen: () => true,
        close: () => h.calls.push("yesno:close"),
        moveFocus: (d) => h.calls.push(`yesno:move:${d}`),
        submit: () => h.calls.push("yesno:submit"),
      },
    });
    h.key("x");
    expect(h.calls).toEqual([]);
    h.key("escape");
    expect(h.calls).toEqual(["yesno:close"]);
  });

  test("prompt overlay delegates keys above pick (esc/typing reach it)", () => {
    // the plugin git-URL prompt owns typing while open — grid keys (incl.
    // type-to-search) must not fire underneath it, even over an open pick
    const h = makeHarness({
      prompt: {
        isOpen: () => true,
        handleKey: (e) => h.calls.push(`prompt:${e.name}`),
      },
    });
    h.pickState.open = true;
    h.key("g");
    h.key("escape");
    expect(h.calls).toEqual(["prompt:g", "prompt:escape"]);
  });

  test("bulk-rename modal swallows every key (the textarea owns typing)", () => {
    const h = makeHarness();
    h.bulkState.open = true;
    h.key("escape");
    h.key("down");
    h.key("g");
    h.key("a", { ctrl: true });
    expect(h.calls).toEqual(["bulk:escape", "bulk:down", "bulk:g", "bulk:a"]);
  });

  test("inline rename swallows every key (esc/enter handled at the source)", () => {
    const h = makeHarness({ isRenaming: () => true });
    h.key("escape");
    h.key("down");
    h.key("a", { ctrl: true });
    expect(h.calls).toEqual([]);
  });

  test("props dialog: esc/return close, everything else swallowed", () => {
    const h = makeHarness({ propsIsOpen: () => true });
    h.key("down");
    expect(h.calls).toEqual([]);
    h.key("escape");
    h.key("return");
    expect(h.calls).toEqual(["props:close", "props:close"]);
  });

  test("esc menu: arrows adjust, return activates, escape closes", () => {
    const h = makeHarness();
    h.escMenuState.open = true;
    h.key("up");
    h.key("down");
    h.key("left");
    h.key("right");
    h.key("return");
    h.key("escape");
    expect(h.calls).toEqual([
      "escmenu:move:-1",
      "escmenu:move:1",
      "escmenu:adjust:-1",
      "escmenu:adjust:1",
      "escmenu:activate",
      "escmenu:close",
    ]);
    expect(h.escMenuState.open).toBe(false);
  });

  test("embedded terminal owns the keyboard — hint once, then nothing below it fires", () => {
    const h = makeHarness({ termOwnsKeyboard: () => true });
    h.key("escape");
    h.key("down");
    h.key("x");
    expect(h.calls).toEqual(["notify:terminal:info:Terminal owns keyboard — click the grid to leave"]);
  });

  test("path edit: esc exits, everything else swallowed", () => {
    const h = makeHarness({ pathInputVisible: () => true });
    h.key("a");
    expect(h.calls).toEqual([]);
    h.key("escape");
    expect(h.calls).toEqual(["pathedit:exit"]);
  });

  test("pathEditMode (not just the visible input) also swallows", () => {
    const h = makeHarness({ pathEditMode: () => true });
    h.key("down");
    h.key("escape");
    expect(h.calls).toEqual(["pathedit:exit"]);
  });
});

describe("file menu keys", () => {
  test("down skips separators and wraps; return activates the live entry", () => {
    const calls: string[] = [];
    const fmenu = {
      idx: 0,
      subIdx: null as number | null,
      entries: [
        { action: () => calls.push("act:A") },
        { sep: true, action: () => {} },
        { action: () => calls.push("act:B") },
      ],
    };
    const h = makeHarness({ getFileMenuState: () => fmenu });
    h.key("down"); // 0 -> skips sep -> 2
    expect(fmenu.idx).toBe(2);
    h.key("down"); // wraps to 0
    expect(fmenu.idx).toBe(0);
    h.key("up"); // wraps backwards to 2
    expect(fmenu.idx).toBe(2);
    h.key("return");
    expect(calls).toEqual(["act:B"]);
    expect(h.calls).toContain("fmenu:render");
  });

  test("escape closes the menu", () => {
    const h = makeHarness({ getFileMenuState: () => ({ idx: 0, subIdx: null, entries: [{ action: () => {} }] }) });
    h.key("escape");
    expect(h.calls).toEqual(["fmenu:close"]);
  });

  test("right opens the submenu only on a parent row", () => {
    const parent = {
      idx: 0,
      subIdx: null as number | null,
      entries: [{ action: () => {}, submenu: [{ action: () => {} }] }],
    };
    const leaf = { idx: 0, subIdx: null as number | null, entries: [{ action: () => {} }] };
    const h1 = makeHarness({ getFileMenuState: () => parent });
    h1.key("right");
    expect(h1.calls).toContain("fmenu:sub-open");
    const h2 = makeHarness({ getFileMenuState: () => leaf });
    h2.key("right");
    expect(h2.calls).not.toContain("fmenu:sub-open");
  });

  test("with the flyout open, keys act on the submenu; left/esc close it", () => {
    const open = { idx: 0, subIdx: 1 as number | null, entries: [{ action: () => {}, submenu: [{}] }] };
    const h = makeHarness({ getFileMenuState: () => open });
    h.key("down");
    expect(h.calls).toContain("fmenu:sub-move");
    expect(h.calls).not.toContain("fmenu:render"); // parent didn't move
    h.key("return");
    expect(h.calls).toContain("fmenu:sub-activate");
    h.key("left");
    expect(h.calls).toContain("fmenu:sub-close");
    h.key("escape");
    expect(h.calls).toContain("fmenu:sub-close");
    expect(h.calls).not.toContain("fmenu:close");
  });

  test("enter opens a parent row's submenu instead of activating it", () => {
    const calls: string[] = [];
    const fmenu = {
      idx: 0,
      subIdx: null as number | null,
      entries: [{ action: () => calls.push("parent"), submenu: [{ action: () => {} }] }],
    };
    const h = makeHarness({ getFileMenuState: () => fmenu });
    h.key("return");
    expect(calls).toEqual([]);
    expect(h.calls).toContain("fmenu:sub-open");
  });
});

describe("search keys", () => {
  const searchOn = (_h: Harness, query: string): Partial<KeyRouterCtx> => ({
    searchVisible: () => true,
    searchQuery: () => query,
  });

  test("escape with an empty query clears but does not re-render", () => {
    const h = makeHarness(searchOn({} as Harness, ""));
    h.key("escape");
    expect(h.calls).toEqual(["search:clear"]);
  });

  test("escape with a query clears and re-renders the grid", () => {
    const h = makeHarness(searchOn({} as Harness, "ab"));
    h.key("escape");
    expect(h.calls).toEqual(["search:clear", "renderGrid"]);
  });

  test("return opens the first dir match (dirs sort first)", () => {
    const h = makeHarness(searchOn({} as Harness, "s"));
    h.seedTiles(["sub/", "a.txt"]);
    h.key("return");
    expect(h.calls).toEqual(["navigate:sub/"]);
  });

  test("return with only file matches opens the first file and clears", () => {
    const h = makeHarness(searchOn({} as Harness, "a"));
    h.key("return");
    expect(h.calls).toEqual(["open:a.txt", "search:clear", "renderGrid"]);
  });

  test("return with no matches just clears", () => {
    const h = makeHarness(searchOn({} as Harness, "zz"));
    h.selection.setFocusKeys([]);
    h.key("return");
    expect(h.calls).toEqual(["search:clear", "renderGrid"]);
  });

  test("return ignores a stale pre-debounce listing (query outran the grid)", () => {
    // the render is debounced 150ms after the first char — fast 2nd+ char +
    // Enter must not open a tile that satisfies the OLD listing only
    const h = makeHarness(searchOn({} as Harness, "ab"));
    h.seedTiles(["a.txt", "b.txt"]);
    h.key("return");
    expect(h.calls).toEqual(["search:clear", "renderGrid"]);
  });
});

describe("shift+arrows extend from anchor", () => {
  test("first shift+down anchors at 0 and selects down the column", () => {
    const h = makeHarness();
    h.key("down", { shift: true }); // focus -1 -> anchor 0, extend to 0
    expect(h.selection.selPaths().map((p) => p.path)).toEqual(["a.txt"]);
    h.key("down", { shift: true }); // extend to 1
    expect(
      h.selection
        .selPaths()
        .map((p) => p.path)
        .sort(),
    ).toEqual(["a.txt", "b.txt"]);
  });

  test("shift+left with no focus is a no-op", () => {
    const h = makeHarness();
    h.key("left", { shift: true });
    expect(h.calls).toEqual([]);
    expect(h.selection.selPaths()).toEqual([]);
  });
});

describe("sidebar keyboard focus", () => {
  test("left at the grid's left edge hands focus to the sidebar", () => {
    const h = makeHarness();
    h.key("left");
    expect(h.router.sidebarActive()).toBe(true);
    expect(h.router.placeIdx()).toBe(0);
    expect(h.calls).toContain("places:normalize");
  });

  test("up/down move within bounds and stop at the ends", () => {
    const h = makeHarness();
    h.key("left");
    h.key("down");
    expect(h.router.placeIdx()).toBe(1);
    h.key("down"); // past the end
    expect(h.router.placeIdx()).toBe(1);
    h.key("up");
    expect(h.router.placeIdx()).toBe(0);
  });

  test("return navigates to the highlighted place", () => {
    const h = makeHarness();
    h.key("left");
    h.key("down"); // /media/usb (has path AND mountDevice — path wins)
    h.key("return");
    expect(h.calls).toContain("navigate:/media/usb");
    expect(h.router.sidebarActive()).toBe(false);
  });

  test("return on a mount-only entry mounts the device", () => {
    const h = makeHarness();
    h.places[0] = { selected: false, place: { mountDevice: "sda9" } as any };
    h.key("left");
    h.key("return");
    expect(h.calls).toContain("mount:sda9");
  });

  test("left/right inside the sidebar return to the grid", () => {
    const h = makeHarness();
    h.key("left");
    h.key("right");
    expect(h.router.sidebarActive()).toBe(false);
    expect(h.selection.focusIdx()).toBe(0);
  });

  test("shift+arrows while the sidebar is focused stay in the sidebar (no grid extend)", () => {
    // the sidebar swallows all keys while it has kb focus; shift+extend ran
    // FIRST in the chain and extended the grid selection instead
    const h = makeHarness();
    h.key("down"); // grid focus on a.txt (focus-follows-select)
    h.key("left"); // hand focus to the sidebar
    h.key("down", { shift: true });
    expect(h.router.sidebarActive()).toBe(true); // sidebar still focused
    expect(h.router.placeIdx()).toBe(1); // sidebar focus moved
    // NO extension: still just the original focus selection, not a.txt+b.txt
    expect(h.selection.selPaths().map((p) => p.path)).toEqual(["a.txt"]);
  });

  test("shift+arrows with the GRID focused still extend (reorder control)", () => {
    const h = makeHarness();
    h.key("down", { shift: true }); // grid: anchor + extend
    expect(h.selection.selPaths().map((p) => p.path)).toEqual(["a.txt"]);
    expect(h.router.sidebarActive()).toBe(false);
  });
});

describe("grid keys", () => {
  test("arrows move focus; left at the edge goes to the sidebar", () => {
    const h = makeHarness();
    h.key("down");
    expect(h.selection.focusIdx()).toBe(0);
    h.key("right");
    expect(h.selection.focusIdx()).toBe(1);
    h.key("down");
    expect(h.selection.focusIdx()).toBe(2);
    h.key("up");
    expect(h.selection.focusIdx()).toBe(1);
  });

  test("return opens the focused file", () => {
    const h = makeHarness();
    h.key("down");
    h.key("return");
    expect(h.calls).toEqual(["open:a.txt"]);
  });

  test("return on a focused dir navigates into it", () => {
    const h = makeHarness();
    h.seedTiles(["sub/", "b.txt"]);
    h.key("down");
    h.key("return");
    expect(h.calls).toEqual(["navigate:sub/"]);
  });

  test("backspace goes to the parent dir; no-op at /", () => {
    const h = makeHarness();
    h.key("backspace");
    expect(h.calls).toEqual(["navigate:/tmp/tfm-kb"]);
    const root = makeHarness({ state: { cwd: "/", showHidden: false } as any });
    root.key("backspace");
    expect(root.calls).toEqual([]);
  });

  test("backspace in a virtual cwd goes home (URIs have no fs parent)", () => {
    const h = makeHarness({ isVirtualCwd: () => true, state: { cwd: "recent://", showHidden: false } as any });
    h.key("backspace");
    expect(h.calls).toEqual(["navigate:/home/u"]);
  });

  test("plain typing starts type-to-search; shifted/ctrl keys do not", () => {
    const h = makeHarness();
    h.key("x");
    expect(h.calls).toEqual(["search:begin:x"]);
    const h2 = makeHarness();
    h2.key("X", { shift: true });
    h2.key("x", { ctrl: true });
    expect(h2.calls).toEqual([]);
  });

  test("escape with nothing open opens the esc menu", () => {
    const h = makeHarness();
    h.key("escape");
    expect(h.calls).toEqual(["escmenu:open"]);
    expect(h.escMenuState.open).toBe(true);
  });

  test("ctrl+h toggles hidden files and re-renders", () => {
    const h = makeHarness();
    h.key("h", { ctrl: true });
    expect(h.state.showHidden).toBe(true);
    expect(h.calls).toEqual(["renderGrid"]);
    h.key("h", { ctrl: true });
    expect(h.state.showHidden).toBe(false);
  });

  test("ctrl+r reloads places then re-renders", async () => {
    const h = makeHarness();
    h.key("r", { ctrl: true });
    await settleUntil(() => h.calls.includes("renderAll"));
    expect(h.calls).toContain("renderAll");
  });
});

describe("tabs", () => {
  test("ctrl+t / ctrl+w / ctrl+tab / ctrl+shift+tab", () => {
    const h = makeHarness();
    h.key("t", { ctrl: true });
    h.key("w", { ctrl: true });
    h.key("tab", { ctrl: true });
    h.key("tab", { ctrl: true, shift: true });
    expect(h.calls).toEqual(["tab:new", "tab:close", "tab:next", "tab:prev"]);
  });
});

describe("file operation keys", () => {
  test("ctrl+a selects all", () => {
    const h = makeHarness();
    h.key("a", { ctrl: true });
    expect(h.selection.selPaths().length).toBe(4);
  });

  test("delete trashes the selection; in the trash view it deletes forever", () => {
    const h = makeHarness();
    h.key("a", { ctrl: true });
    h.key("delete");
    expect(h.calls).toEqual(["trash:a.txt,b.txt,c.txt,d.txt"]);
    const h2 = makeHarness({ inTrashView: () => true });
    h2.key("a", { ctrl: true });
    h2.key("delete");
    expect(h2.calls).toEqual(["deleteForever:a.txt,b.txt,c.txt,d.txt"]);
  });

  test("delete with nothing selected is a no-op", () => {
    const h = makeHarness();
    h.key("delete");
    expect(h.calls).toEqual([]);
  });

  test("f2 renames a single selection; in the trash view it restores", () => {
    const h = makeHarness();
    h.key("down");
    h.key("f2");
    expect(h.calls).toEqual(["rename:a.txt"]);
    const h2 = makeHarness({ inTrashView: () => true });
    h2.key("down");
    h2.key("f2");
    expect(h2.calls).toEqual(["restore:a.txt"]);
  });

  test("f2 on a multi-selection opens bulk rename with every selected path", () => {
    const h = makeHarness();
    h.key("a", { ctrl: true });
    h.key("f2");
    expect(h.calls).toEqual(["bulkopen:a.txt,b.txt,c.txt,d.txt"]);
  });

  test("multi-selection f2 in the trash view is a no-op (restore stays single)", () => {
    const h = makeHarness({ inTrashView: () => true });
    h.key("a", { ctrl: true });
    h.key("f2");
    expect(h.calls).toEqual([]);
  });

  test("ctrl+c / ctrl+x put items on the clipboard; ctrl+v pastes", () => {
    const h = makeHarness();
    h.key("a", { ctrl: true });
    h.key("c", { ctrl: true });
    h.key("x", { ctrl: true });
    h.key("v", { ctrl: true });
    expect(h.calls).toEqual(["clip:copy:4", "clip:cut:4", "paste:/tmp/tfm-kb/sub"]);
  });

  test("ctrl+d duplicates the selection; empty selection is a no-op", () => {
    const h = makeHarness();
    h.key("d", { ctrl: true });
    expect(h.calls).toEqual([]);
    h.key("a", { ctrl: true });
    h.key("d", { ctrl: true });
    expect(h.calls).toEqual(["duplicate:a.txt,b.txt,c.txt,d.txt"]);
  });

  test("autorepeat never enqueues file ops (ctrl+d spam crashed the renderer)", () => {
    const h = makeHarness();
    h.key("a", { ctrl: true });
    h.key("d", { ctrl: true, repeated: true });
    h.key("d", { ctrl: true, repeated: true });
    h.key("delete", { repeated: true });
    h.key("v", { ctrl: true, repeated: true });
    expect(h.calls).toEqual([]);
    // a real (non-repeat) press still dispatches
    h.key("d", { ctrl: true });
    expect(h.calls).toEqual(["duplicate:a.txt,b.txt,c.txt,d.txt"]);
  });

  test("ctrl+d in a virtual cwd or trash reports it can't duplicate", () => {
    const h = makeHarness({ isVirtualCwd: () => true });
    h.key("a", { ctrl: true });
    h.key("d", { ctrl: true });
    expect(h.calls).toEqual(["notify:duplicate:error:Can't duplicate here"]);
    h.calls.length = 0;
    const h2 = makeHarness({ inTrashView: () => true });
    h2.key("a", { ctrl: true });
    h2.key("d", { ctrl: true });
    expect(h2.calls).toEqual(["notify:duplicate:error:Can't duplicate here"]);
  });

  test("ctrl+v in a virtual cwd reports it can't paste there", () => {
    const h = makeHarness({ isVirtualCwd: () => true });
    h.key("a", { ctrl: true });
    h.key("v", { ctrl: true });
    expect(h.calls).toEqual(["notify:paste:error:Can't paste here"]);
  });

  test("ctrl+v in trash view reports it can't paste there (no trashinfo on paste)", () => {
    const h = makeHarness({ inTrashView: () => true });
    h.key("a", { ctrl: true });
    h.key("v", { ctrl: true });
    expect(h.calls).toEqual(["notify:paste:error:Can't paste here"]);
  });

  test("ctrl+z undoes; ctrl+y and ctrl+shift+z redo", () => {
    const h = makeHarness();
    h.key("z", { ctrl: true });
    h.key("y", { ctrl: true });
    h.key("z", { ctrl: true, shift: true });
    expect(h.calls).toEqual(["undo", "redo", "redo"]);
  });
});

describe("remappable keybinds", () => {
  test("remapped action fires on the new key and not the old one", () => {
    const h = makeHarness();
    h.binds.toggleHidden = ["ctrl+j"];
    h.key("h", { ctrl: true }); // old bind is gone
    expect(h.calls).toEqual([]);
    h.key("j", { ctrl: true });
    expect(h.calls).toEqual(["renderGrid"]);
    expect(h.state.showHidden).toBe(true);
  });

  test("multi-bind actions fire on every configured bind", () => {
    const h = makeHarness();
    h.binds.quit = ["ctrl+q", "alt+f4"];
    h.key("q", { ctrl: true });
    h.key("f4", { meta: true });
    expect(h.calls).toEqual(["quit", "quit"]);
  });

  test("rebinding quit keeps it first in the chain (pre-empts an open conflict)", () => {
    const h = makeHarness({
      conflict: { isOpen: () => true, closeConflict: (p) => h.calls.push(`conflict:close:${p}`) },
    });
    h.binds.quit = ["ctrl+x"];
    h.key("x", { ctrl: true });
    expect(h.calls).toEqual(["quit"]);
  });

  test("empty binds list disables the action", () => {
    const h = makeHarness();
    h.binds.newTab = [];
    h.key("t", { ctrl: true });
    expect(h.calls).toEqual([]);
  });

  test("remapped trash/delete still respects the trash-view split", () => {
    const h = makeHarness({ inTrashView: () => true });
    h.binds.trash = ["ctrl+d"];
    h.key("a", { ctrl: true });
    h.key("d", { ctrl: true });
    expect(h.calls).toEqual(["deleteForever:a.txt,b.txt,c.txt,d.txt"]);
  });
});

describe("keybind capture precedence", () => {
  test("capture consumes every key, even modals' keys, until it ends", () => {
    const h = makeHarness({
      conflict: { isOpen: () => true, closeConflict: (p) => h.calls.push(`conflict:close:${p}`) },
    });
    h.escMenuState.capturing = true;
    h.key("q", { ctrl: true }); // would quit without capture — swallowed
    h.key("x");
    expect(h.calls).toEqual(["capture:q", "capture:x"]);
    h.key("escape"); // ends capture (fake logs the swallowed key before ending)
    expect(h.escMenuState.capturing).toBe(false);
    expect(h.calls).toEqual(["capture:q", "capture:x", "capture:escape"]);
    // next key reaches the (open) conflict modal
    h.key("escape");
    expect(h.calls).toEqual(["capture:q", "capture:x", "capture:escape", "conflict:close:skip"]);
  });

  test("no capture -> router behaves normally (fake returns false)", () => {
    const h = makeHarness();
    h.key("escape");
    expect(h.calls).toEqual(["escmenu:open"]);
  });

  test("esc menu swallows tab via menuTab (pane switching)", () => {
    const h = makeHarness();
    h.escMenuState.open = true;
    h.key("tab");
    expect(h.calls).toEqual(["escmenu:tab"]);
  });
});

describe("remappable action keys", () => {
  test("alt+left/right walk history (dispatched before grid nav swallows arrows)", () => {
    const h = makeHarness();
    h.key("left", { meta: true });
    h.key("right", { meta: true });
    expect(h.calls).toEqual(["back", "fwd"]);
  });

  test("plain arrows still move grid focus (no modifier, no bind hit)", () => {
    const h = makeHarness();
    h.key("left");
    expect(h.calls).not.toContain("back");
  });

  test("alt+enter opens props for the selection (return/enter spelling alias)", () => {
    const h = makeHarness();
    h.selection.selectTileAt(0);
    h.calls.length = 0;
    // OpenTUI reports Enter as "return" — the alt+enter bind must still hit
    h.key("return", { meta: true });
    expect(h.calls).toEqual(["props:a.txt"]);
  });

  test("alt+enter with empty selection opens props for cwd, skipped in virtual views", () => {
    const h = makeHarness();
    h.key("return", { meta: true });
    expect(h.calls).toEqual(["props:/tmp/tfm-kb/sub"]);
    const hv = makeHarness({ isVirtualCwd: () => true });
    hv.key("return", { meta: true });
    expect(hv.calls).toEqual([]);
  });

  test("ctrl+shift+n / ctrl+alt+n start folder/file creation", () => {
    const h = makeHarness();
    h.key("n", { ctrl: true, shift: true });
    h.key("n", { ctrl: true, meta: true });
    expect(h.calls).toEqual(["create:folder", "create:file"]);
  });

  test("ctrl+l enters path edit, f9 toggles preview, f4 opens the terminal", () => {
    const h = makeHarness();
    h.key("l", { ctrl: true });
    h.key("f9");
    h.key("f4");
    expect(h.calls).toEqual(["pathedit:enter", "preview:toggle", "term:open"]);
  });

  test("ctrl+shift+s opens the network connect prompt", () => {
    const h = makeHarness();
    h.key("s", { ctrl: true, shift: true });
    expect(h.calls).toEqual(["connect:server"]);
  });

  test("ctrl+g toggles grid/list, ctrl+= / ctrl+- zoom tile size", () => {
    const h = makeHarness();
    h.key("g", { ctrl: true });
    h.key("=", { ctrl: true });
    h.key("-", { ctrl: true });
    expect(h.calls).toEqual(["view:toggle", "zoom:1", "zoom:-1"]);
  });

  test("remapped binds apply live (binds read per keypress)", () => {
    const h = makeHarness();
    h.binds.histBack = ["ctrl+b"];
    h.key("left", { meta: true });
    expect(h.calls).not.toContain("back");
    h.calls.length = 0;
    h.key("b", { ctrl: true });
    expect(h.calls).toEqual(["back"]);
  });
});

describe("command table (everything is a command)", () => {
  test("commands() covers every KeyAction (palette parity with keybinds)", async () => {
    const h = makeHarness();
    const { KEY_SCHEMA } = await import("../config/config-schema");
    const ids = h.router.commands().map((c) => c.id);
    for (const row of KEY_SCHEMA) {
      expect(ids, `missing command for ${row.action}`).toContain(row.action);
    }
  });

  test("command run() dispatches exactly like its keypress", () => {
    const h = makeHarness();
    const byId = (id: string) => h.router.commands().find((c) => c.id === id)!;
    byId("quit").run();
    byId("newTab").run();
    byId("undo").run();
    expect(h.calls).toEqual(["quit", "tab:new", "undo"]);
  });

  test("command hints reflect the live binds", () => {
    const h = makeHarness();
    const quit = h.router.commands().find((c) => c.id === "quit")!;
    expect(quit.hint).toContain("ctrl+q");
    h.binds.quit = ["ctrl+x", "ctrl+q"];
    expect(h.router.commands().find((c) => c.id === "quit")!.hint).toBe("ctrl+x ctrl+q");
  });

  test("a true modal above pick keeps its keys (esc reaches the conflict)", () => {
    // floats policy normally prevents coexistence, but a confirm opened over
    // pick — or any open race — must not leave esc dead
    const h = makeHarness({
      conflict: { isOpen: () => true, closeConflict: (p) => h.calls.push(`conflict:close:${p}`) },
    });
    h.pickState.open = true;
    h.key("escape");
    expect(h.calls).toEqual(["conflict:close:skip"]);
    h.calls.length = 0;
    h.key("g");
    expect(h.calls).toEqual([]);
  });

  test("open pick overlay swallows grid keys; esc delegates to it", () => {
    const h = makeHarness();
    h.key("g");
    expect(h.calls).toContain("search:begin:g");
    h.calls.length = 0;
    h.pickState.open = true;
    h.key("g");
    h.key("escape");
    expect(h.calls).toEqual(["pick:g", "pick:escape"]);
  });
});

describe("plugin commands (keybinds)", () => {
  test("plugin bind dispatches before type-to-search", () => {
    const h = makeHarness({
      pluginCommands: () => [{ id: "demo:hi", binds: ["ctrl+j"], run: () => h.calls.push("plugin:hi") }],
    } as any);
    h.calls.length = 0;
    h.key("j", { ctrl: true });
    expect(h.calls).toEqual(["plugin:hi"]);
  });

  test("async-rejecting plugin run is swallowed (no unhandled rejection)", async () => {
    const h = makeHarness({
      pluginCommands: () => [
        {
          id: "demo:slow",
          binds: ["ctrl+j"],
          run: async () => {
            throw new Error("async-boom");
          },
        },
      ],
    } as any);
    h.calls.length = 0;
    expect(() => h.key("j", { ctrl: true })).not.toThrow();
    await Bun.sleep(10);
    expect(h.calls).toEqual([]);
  });

  test("core wins ties; throwing plugin run is swallowed", () => {
    const h = makeHarness({
      pluginCommands: () => [
        { id: "demo:quit", binds: ["ctrl+q"], run: () => h.calls.push("plugin:quit") },
        {
          id: "demo:boom",
          binds: ["ctrl+j"],
          run: () => {
            throw new Error("boom");
          },
        },
      ],
    } as any);
    h.calls.length = 0;
    h.key("q", { ctrl: true });
    expect(h.calls).toEqual(["quit"]);
    h.calls.length = 0;
    expect(() => h.key("j", { ctrl: true })).not.toThrow();
    expect(h.calls).toEqual([]);
  });

  test("core wins over plugin binds for the LATE action group too (ctrl+t newTab)", () => {
    // the plugin block used to dispatch BEFORE the late core-actions group
    // (openMenu/newTab/trash/copy/undo), so a plugin defaultBind of ctrl+t
    // silently swallowed newTab while the load-time log claimed the opposite
    const h = makeHarness({
      pluginCommands: () => [{ id: "demo:tab", binds: ["ctrl+t"], run: () => h.calls.push("plugin:tab") }],
    } as any);
    h.calls.length = 0;
    h.key("t", { ctrl: true });
    expect(h.calls).toEqual(["tab:new"]);
  });
});

describe("file menu with no initial cursor", () => {
  test("down/up from idx -1 fill first/last actionable; enter is a no-op", () => {
    const calls: string[] = [];
    const fmenu = {
      idx: -1,
      subIdx: null as number | null,
      entries: [{ action: () => calls.push("a") }, { sep: true, action: () => {} }, { action: () => calls.push("b") }],
    };
    const h = makeHarness({ getFileMenuState: () => fmenu });
    h.key("return"); // no cursor -> nothing runs
    expect(calls).toEqual([]);
    h.key("down"); // first non-sep
    expect(fmenu.idx).toBe(0);
    fmenu.idx = -1;
    h.key("up"); // last non-sep
    expect(fmenu.idx).toBe(2);
  });
});

describe("remappable grid + menu nav", () => {
  test("remapped moveDown fires on the new key, old arrow goes dead", () => {
    const h = makeHarness();
    h.binds.moveDown = ["ctrl+n"];
    h.key("down");
    expect(h.selection.focusIdx()).toBe(-1);
    h.key("n", { ctrl: true });
    expect(h.selection.focusIdx()).toBe(0);
  });

  test("empty moveDown disables grid down", () => {
    const h = makeHarness();
    h.binds.moveDown = [];
    h.key("down");
    expect(h.selection.focusIdx()).toBe(-1);
  });

  test("remapped extendDown extends on the new bind, old shift+down dead", () => {
    const h = makeHarness();
    h.binds.extendDown = ["ctrl+e"];
    h.key("down", { shift: true });
    expect(h.selection.selPaths()).toEqual([]);
    h.key("e", { ctrl: true });
    expect(h.selection.selPaths().map((p) => p.path)).toEqual(["a.txt"]);
  });

  test("file menu follows the remapped move binds", () => {
    const fmenu = { idx: 0, subIdx: null as number | null, entries: [{ action: () => {} }, { action: () => {} }] };
    const h = makeHarness({ getFileMenuState: () => fmenu });
    h.binds.moveDown = ["ctrl+n"];
    h.key("down");
    expect(fmenu.idx).toBe(0);
    h.key("n", { ctrl: true });
    expect(fmenu.idx).toBe(1);
  });

  test("esc menu follows the remapped move binds", () => {
    const h = makeHarness();
    h.escMenuState.open = true;
    h.binds.moveDown = ["ctrl+n"];
    h.key("down");
    expect(h.calls).toEqual([]);
    h.key("n", { ctrl: true });
    expect(h.calls).toEqual(["escmenu:move:1"]);
  });

  test("remapped openSelected opens the focused file", () => {
    const h = makeHarness();
    h.binds.openSelected = ["ctrl+o"];
    h.key("down");
    h.key("return");
    expect(h.calls).toEqual([]);
    h.key("o", { ctrl: true });
    expect(h.calls).toEqual(["open:a.txt"]);
  });

  test("pageDown pages by the viewport, home/end jump to the ends", () => {
    const h = makeHarness();
    h.selection.setCols(1);
    h.key("home");
    expect(h.selection.focusIdx()).toBe(0);
    h.key("end");
    expect(h.selection.focusIdx()).toBe(3);
    h.key("home");
    h.key("pagedown");
    expect(h.selection.focusIdx()).toBeGreaterThan(0);
    h.key("pageup");
    expect(h.selection.focusIdx()).toBe(0);
  });

  test("remapped pageDown fires on the new key", () => {
    const h = makeHarness();
    h.selection.setCols(1);
    h.binds.pageDown = ["ctrl+v"];
    // ctrl+v is paste by default — free it so the page bind owns the key
    h.binds.paste = ["ctrl+y"];
    h.key("pagedown");
    expect(h.selection.focusIdx()).toBe(-1);
    h.key("v", { ctrl: true });
    expect(h.selection.focusIdx()).toBeGreaterThanOrEqual(0);
  });
});

describe("type-to-search toggle + yazi-style bare binds", () => {
  test("bare j moves when bound to moveDown (preset-style multi-bind)", () => {
    const h = makeHarness();
    h.binds.moveDown = ["down", "j"];
    h.key("j");
    expect(h.selection.focusIdx()).toBe(0);
    expect(h.calls).not.toContain("search:begin:j");
  });

  test("type-to-search off swallows unbound bare keys", () => {
    const h = makeHarness();
    h.setTypeToSearch(false);
    h.key("x");
    expect(h.calls).toEqual([]);
  });

  test("space toggles the focused file; ctrl+r inverts", () => {
    const h = makeHarness();
    h.binds.reloadPlaces = [];
    h.binds.invertSelection = ["ctrl+r"];
    h.key("down");
    h.key("space");
    expect(h.selection.selPaths().map((p) => p.path)).toEqual([]);
    h.key("space");
    expect(h.selection.selPaths().map((p) => p.path)).toEqual(["a.txt"]);
    h.key("r", { ctrl: true });
    expect(
      h.selection
        .selPaths()
        .map((p) => p.path)
        .sort(),
    ).toEqual(["b.txt", "c.txt", "d.txt"]);
  });

  test("startSearch re-arms the filter and toasts", () => {
    const h = makeHarness();
    h.binds.startSearch = ["s", "/", "f"];
    h.setTypeToSearch(false);
    h.key("s");
    expect(h.calls).toContain("search:enable");
    expect(h.calls).toContain("notify:search:info:type-to-search on · type to filter, esc clears");
  });

  test("cycleSort + goHome dispatch through binds", () => {
    const h = makeHarness();
    h.binds.toggleHidden = [];
    h.binds.cycleSort = ["ctrl+s"];
    h.binds.goHome = ["ctrl+h"];
    h.key("s", { ctrl: true });
    h.key("h", { ctrl: true });
    expect(h.calls).toEqual(["sort:cycle", "navigate:/home/u"]);
  });

  test("cycleSort/goHome palette runs match their keypresses", () => {
    const h = makeHarness();
    const byId = (id: string) => h.router.commands().find((c) => c.id === id)!;
    byId("cycleSort").run();
    byId("goHome").run();
    expect(h.calls).toEqual(["sort:cycle", "navigate:/home/u"]);
  });

  test("yes/no: arrows move the cursor, return submits, esc closes", () => {
    const h = makeHarness({
      yesNo: {
        isOpen: () => true,
        close: () => h.calls.push("yesno:close"),
        moveFocus: (d) => h.calls.push(`yesno:move:${d}`),
        submit: () => h.calls.push("yesno:submit"),
      },
    });
    h.key("down");
    h.key("up");
    h.key("return");
    h.key("escape");
    expect(h.calls).toEqual(["yesno:move:1", "yesno:move:-1", "yesno:submit", "yesno:close"]);
  });
});

describe("dual-pane actions", () => {
  test("tab/f5/f6 dispatch switchPane/copyToOtherPane/moveToOtherPane", () => {
    const h = makeHarness();
    h.key("tab");
    h.key("f5");
    h.key("f6");
    expect(h.calls).toEqual(["pane:switch", "pane:copy", "pane:move"]);
  });

  test("ctrl+shift+d toggles dual pane (never on autorepeat)", () => {
    const h = makeHarness();
    h.key("d", { ctrl: true, shift: true });
    expect(h.calls).toEqual(["pane:toggle-dual"]);
    h.calls.length = 0;
    h.key("d", { ctrl: true, shift: true, repeated: true });
    expect(h.calls).toEqual([]);
  });

  test("autorepeat never starts cross-pane work (op-flood guard)", () => {
    const h = makeHarness();
    h.key("tab", { repeated: true });
    h.key("f5", { repeated: true });
    h.key("f6", { repeated: true });
    expect(h.calls).toEqual([]);
  });

  test("a remap moves the pane switch off tab", () => {
    const h = makeHarness();
    h.binds.switchPane = ["ctrl+u"];
    h.key("tab");
    expect(h.calls).toEqual([]);
    h.key("u", { ctrl: true });
    expect(h.calls).toEqual(["pane:switch"]);
  });
});
