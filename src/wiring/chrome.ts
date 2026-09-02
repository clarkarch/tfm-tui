// --- Chrome wiring: file context menu, places sidebar + tab strip, toolbar,
// the renderer boot itself, notifications, recent-open and dialogs. The three
// widget factories are created BEFORE the renderer (their ctx fields defer
// renderer access through arrows — the renderer const further down this same
// function is the TDZ seam). Async: index awaits it, everything downstream
// gets a booted renderer. ---

import { spawn } from "node:child_process";
import { createCliRenderer } from "@opentui/core";
import { makeMenu } from "../ui-menu";
import { makeChrome } from "../ui-chrome";
import { makeToolbar } from "../ui-toolbar";
import { buildAppContainer, buildTitle } from "../ui-boot-layout";
import { warmEmbeddedIcons } from "../icons";
import { makeNotify } from "../notify";
import { makeRecentOpen } from "../recent-open";
import { upsertRecentXbel } from "../recent";
import { appForFile } from "../apps";
import { makeDialogs } from "../ui-dialogs";
import { clearChildren } from "../uiutil";
import { dlog } from "../log";
import type { CoreWiring } from "./core";
import type { NavWiring } from "./nav";
import type { FileopsWiring } from "./fileops";
import type { GridWiring } from "./grid";

// Hand-written from the factory returns (NOT Awaited<ReturnType<typeof
// wireChrome>>) — see nav.ts for why the wiring types must stay acyclic.
export type ChromeWiring = {
  renderer: Awaited<ReturnType<typeof createCliRenderer>>;
  menu: ReturnType<typeof makeMenu>;
  chrome: ReturnType<typeof makeChrome>;
  toolbar: ReturnType<typeof makeToolbar>;
  notify: ReturnType<typeof makeNotify>["notify"];
  toastCount: ReturnType<typeof makeNotify>["toastCount"];
  openFileDefault: ReturnType<typeof makeRecentOpen>["openFileDefault"];
  dialogs: ReturnType<typeof makeDialogs>;
};

export const MENU_W = 36;

export const wireChrome = async (deps: {
  core: CoreWiring;
  nav: NavWiring;
  // late clusters — only read at runtime, post-boot
  getGrid: () => GridWiring;
  getFileops: () => FileopsWiring;
  getKeyRouter: () => { sidebarActive(): boolean; placeIdx(): number };
  // grid's finishDragCtx (internal drag commit) — grid wiring builds it later
  finishDrag(): void;
}) => {
  const { core, nav, getGrid, getFileops, getKeyRouter } = deps;
  const { byId, stripSelectable } = core.lookup;
  const { makeIconSlot, setIconState, drainIconQueue } = core.slots;
  const { themeGet, home, state } = core;
  const uiStyle = () => core.config.ui.uiStyle;

  // --- File context menu (right-click a tile) — widget lives in ./ui-menu.
  // Hoisted above chrome/toolbar/conflict/grid-ctx, which all consume
  // closeFileMenu/openContextMenu/fileMenuIsOpen. Safe pre-boot: every ctx
  // field defers renderer access (same seam rule as makeSlots) ---
  const menu = makeMenu({
    byId,
    rootAdd: (node) => renderer.root.add(node),
    termW: () => renderer.terminalWidth,
    termH: () => renderer.terminalHeight,
    stripSelectable,
    drainIconQueue: () => drainIconQueue(),
    uiStyle,
    colors: themeGet,
    menuW: MENU_W,
    floats: core.floats,
    makeIconSlot,
  });

  // --- Places sidebar + tab strip — widget lives in ./ui-chrome ---
  const chrome = makeChrome({
    byId,
    uiStyle,
    colors: themeGet,
    sw: () => core.geometry.sw,
    sideInnerW: core.sideInnerW,
    tabBar: () => core.config.ui.tabBar,
    renderAll: nav.renderAll,
    navigate: (target) => nav.navigate(target),
    blurTerminal: () => getFileops().terminal.blurTerminal(),
    closeFileMenu: menu.closeFileMenu,
    openContextMenu: menu.openContextMenu,
    sidebarEntriesFor: (place, x, y) => getGrid().menuEntries.sidebarEntriesFor(place, x, y),
    finishDrag: deps.finishDrag,
    dlog: (msg) => dlog(msg),
    trashPaths: (paths) => getFileops().trash.trashPaths(paths),
    moveInto: (dest, items) => getFileops().fileops.moveInto(dest, items),
    kbActive: () => getKeyRouter().sidebarActive(),
    kbIdx: () => getKeyRouter().placeIdx(),
    tabs: () => nav.tabModel,
    closeTab: (i) => nav.closeTab(i),
    switchTab: (i) => nav.switchTab(i),
    newTab: () => nav.newTab(),
    hoverBtn: (id, icon, onMouseDown) => toolbar.hoverBtn(id, icon, onMouseDown),
    stripSelectable,
    drainIconQueue: () => drainIconQueue(),
    makeIconSlot: (name, states, heightCells, initialState, onMouseDown, statesFactory) =>
      makeIconSlot(name, states, heightCells, initialState, onMouseDown, statesFactory),
    setIconState: (spec, stateIdx) => setIconState(spec, stateIdx),
    home,
    stateCwd: () => state.cwd,
  });

  // --- Toolbar — widget lives in ./ui-toolbar (nav buttons, crumbs, inline
  // path edit, sort/search buttons). ---
  const toolbar = makeToolbar({
    renderer: () => renderer,
    byId,
    clearChildren,
    stripSelectable,
    uiStyle,
    colors: themeGet,
    makeIconSlot,
    setIconState,
    closeFileMenu: menu.closeFileMenu,
    blurTerminal: () => getFileops().terminal.blurTerminal(),
    navigate: nav.navigate,
    canBack: nav.canBack,
    canFwd: nav.canFwd,
    goBack: nav.goBack,
    goFwd: nav.goFwd,
    openContextMenu: menu.openContextMenu,
    sortEntries: () => getGrid().menuEntries.sortEntries(),
    cwd: () => state.cwd,
    home,
  });

  // --- Layout: the pre-mount skeleton (title + three panels) lives in
  // ./ui-boot-layout; ids are repainted by rethemeChrome, so they must stay
  // byte-identical there. ---
  const container = buildAppContainer({
    sw: core.geometry.sw,
    sideInnerW: core.sideInnerW(),
    // eager object, not a getter — buildAppContainer/buildTitle read fields
    // directly (typed as Theme in ui-boot-layout so tsc enforces this)
    colors: core.colors,
    uiStyle: core.config.ui.uiStyle,
    tabBarVisible: core.config.ui.tabBar,
    previewWidth: core.config.ui.previewWidth,
    previewEnabled: core.config.ui.previewEnabled,
    title: buildTitle({ width: core.sideInnerW(), colors: core.colors }),
    toolbarShell: toolbar.makeToolbarShell(),
  });

  // --- Renderer boot ---
  const renderer = await createCliRenderer({
    exitOnCtrlC: false,
    targetFps: 60,
    maxFps: 120,
    ...(core.config.ui.transparentBg ? {} : { backgroundColor: core.colors.bg }),
  });
  renderer.root.add(container);
  warmEmbeddedIcons(); // index the embedded svg blobs while the renderer boots
  renderer.setBackgroundColor(core.colors.bg); // opencode-style: global bg lives on the renderer, not per-box

  // --- Notifications — its consumers (recent-open, undo, fileops, terminal,
  // trashops, settings, dnd72) take `notify` directly; its ctx deps are all
  // early (renderer/byId/colors) ---
  const { notify, toastCount } = makeNotify({
    rootAdd: (node) => renderer.root.add(node),
    remove: (node) => {
      const p: any = node.parent ?? renderer.root;
      p.remove(node);
    },
    byId,
    termW: () => renderer.terminalWidth,
    accentBg: () => core.colors.accentBg,
    white: () => core.colors.white,
    sidebarFgMuted: () => core.colors.sidebarFgMuted,
    durationMs: () => core.config.ui.toastDurationMs,
  });

  // --- Recent-files recording + default open: batching/toast logic lives in
  // ./recent-open (tested); xbel write, xdg-open spawn and the app probe are
  // injected here ---
  const { openFileDefault } = makeRecentOpen({
    inTrashView: core.inTrashView,
    notify,
    upsertRecent: (paths) => upsertRecentXbel(paths),
    spawnOpen: (p) => {
      spawn("xdg-open", [p], { stdio: "ignore", detached: true }).unref?.();
    },
    appForFile,
  });

  const dialogs = makeDialogs({
    byId,
    rootAdd: (node) => renderer.root.add(node),
    stripSelectable,
    termH: () => renderer.terminalHeight,
    uiStyle,
    colors: () => core.colors,
    closeFileMenu: menu.closeFileMenu,
  });

  return {
    renderer,
    menu,
    chrome,
    toolbar,
    notify,
    toastCount,
    openFileDefault,
    dialogs,
  };
};
