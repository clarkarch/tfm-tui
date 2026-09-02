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
  const places = [
    { selected: false, place: { path: "/home" } as any },
    { selected: false, place: { path: "/media/usb", mountDevice: "sdb1" } as any },
  ];
  const tabModel = { active: 1, list: [0, 1, 2] };
  const binds: Record<string, string[]> = structuredClone(defaultConfig.keys);

  const ctx: KeyRouterCtx = {
    byId: () => undefined,
    state,
    keybinds: (action) => binds[action] ?? [],
    quit: rec("quit"),
    conflict: { isOpen: () => false, closeConflict: (p) => calls.push(`conflict:close:${p}`) },
    yesNo: { isOpen: () => false, close: rec("yesno:close") },
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
    openFileDefault: (p) => calls.push(`open:${p}`),
    getFileMenuState: () => null,
    closeFileMenu: rec("fmenu:close"),
    renderFileMenu: rec("fmenu:render"),
    tabModel,
    newTab: rec("tab:new"),
    closeTab: rec("tab:close"),
    switchTab: (i) => {
      tabModel.active = i;
      calls.push(`tab:switch:${i}`);
    },
    inTrashView: () => false,
    confirmDeleteForever: (ps) => calls.push(`deleteForever:${ps.join(",")}`),
    trashPaths: (ps) => calls.push(`trash:${ps.join(",")}`),
    restoreFromTrash: (ps) => calls.push(`restore:${ps.join(",")}`),
    startInlineRename: (p) => calls.push(`rename:${p}`),
    setClipboard: (mode, items) => calls.push(`clip:${mode}:${items.length}`),
    isVirtualCwd: () => false,
    pasteSmart: (d) => calls.push(`paste:${d}`),
    undoLast: rec("undo"),
    redoLast: rec("redo"),
    ...over,
  };
  const router = makeKeyRouter(ctx);
  const key = (name: string, opts: { ctrl?: boolean; shift?: boolean; meta?: boolean } = {}): void =>
    router.handleKey({ name, ctrl: !!opts.ctrl, shift: !!opts.shift, meta: !!opts.meta });
  return { router, ctx, calls, selection, places, tabModel, state, escMenuState, seedTiles, key, binds };
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
    const h = makeHarness({ yesNo: { isOpen: () => true, close: () => h.calls.push("yesno:close") } });
    h.key("x");
    expect(h.calls).toEqual([]);
    h.key("escape");
    expect(h.calls).toEqual(["yesno:close"]);
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

  test("embedded terminal owns the keyboard — nothing below it fires", () => {
    const h = makeHarness({ termOwnsKeyboard: () => true });
    h.key("escape");
    h.key("down");
    h.key("x");
    expect(h.calls).toEqual([]);
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
    const h = makeHarness({ getFileMenuState: () => ({ idx: 0, entries: [{ action: () => {} }] }) });
    h.key("escape");
    expect(h.calls).toEqual(["fmenu:close"]);
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
    h.key("tab", { ctrl: true }); // active 1 -> 2
    h.key("tab", { ctrl: true, shift: true }); // 2 -> 1
    expect(h.calls).toEqual(["tab:new", "tab:close", "tab:switch:2", "tab:switch:1"]);
  });

  test("ctrl+tab wraps at the end; ctrl+shift+tab wraps at the start", () => {
    const h = makeHarness({ tabModel: { active: 2, list: [0, 1, 2] } });
    h.key("tab", { ctrl: true });
    expect(h.calls).toEqual(["tab:switch:0"]);
    const h2 = makeHarness({ tabModel: { active: 0, list: [0, 1, 2] } });
    h2.key("tab", { ctrl: true, shift: true });
    expect(h2.calls).toEqual(["tab:switch:2"]);
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

  test("ctrl+c / ctrl+x put items on the clipboard; ctrl+v pastes", () => {
    const h = makeHarness();
    h.key("a", { ctrl: true });
    h.key("c", { ctrl: true });
    h.key("x", { ctrl: true });
    h.key("v", { ctrl: true });
    expect(h.calls).toEqual(["clip:copy:4", "clip:cut:4", "paste:/tmp/tfm-kb/sub"]);
  });

  test("ctrl+v in a virtual cwd is swallowed", () => {
    const h = makeHarness({ isVirtualCwd: () => true });
    h.key("a", { ctrl: true });
    h.key("v", { ctrl: true });
    expect(h.calls).toEqual([]);
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
