import { CliRenderEvents, Renderable, type ScrollBoxRenderable, createCliRenderer } from "@opentui/core";
import { spawn } from "node:child_process";
import os from "node:os";
import { loadConfig, configPath, type Theme } from "./config";
import { sideInnerWidth } from "./style";
import { deriveColors } from "./color";
import { clearIconCaches, warmEmbeddedIcons } from "./icons";
import { FILE_ICON_BY_EXT, loadGlobs2 } from "./filetype";
import { isVirtualUri } from "./uri";
import { upsertRecentXbel } from "./recent";
import { isTrashFilesDir } from "./fsutil";
import { loadSystemPlaces } from "./places";
import { registerSyntaxParsers } from "./syntax";
import { makeDnd72 } from "./dnd72";
import { makeSettingModel } from "./settings-model";
import { makeRename } from "./ui-rename";
import { initialAppState, makeNav, makeSessionSync, type AppState } from "./nav";
import { makeCwdWatcher } from "./watcher";
import { makeHitTargetAt } from "./hit-target";
import { makeRecentOpen } from "./recent-open";
import { makeLookup, waitForResolution } from "./ui-lookup";
import { makeSelection } from "./selection";
import { makeGridRenderer } from "./ui-grid";
import { makeKeyRouter } from "./keymap";
import { makeRetheme } from "./ui-retheme";
import { makeTrashOps, makeTrashConfirms } from "./trashops";
import { makeFileOps } from "./fileops";
import { makeUndo } from "./undo";
import { makeTabs } from "./tabs";
import { appForFile } from "./apps";
import { isCutKeyFor } from "./clipboard";
import { clearChildren as uiutilClearChildren } from "./uiutil";
import { makeNotify } from "./notify";
import { makeChrome } from "./ui-chrome";
import { makeDialogs, makeConflict, makeYesNo } from "./ui-dialogs";
import { makeMenu } from "./ui-menu";
import { makeFloats } from "./floats";
import type { ListEntry } from "./ui-menu";
import { makePreview } from "./ui-preview";
import { makeProps } from "./ui-props";
import { makeProgress } from "./ui-progress";
import { makeTerminal, xtShiftEscapeFrame } from "./ui-term";
import { makeSlots } from "./ui-slots";
import { makeEscMenu } from "./ui-settings";
import { cancelBand, finishDragState, makeEntryMouseHandlers, type BandCtx, type GridMenuEntry } from "./grid-input";
import { appendLog, debugLog, dlog, isDebug, DEBUG_LOG } from "./log";
import { startMemHygiene } from "./mem-hygiene";
import { makeSearch } from "./search";
import { buildAppContainer, buildBootLayout, buildTitle } from "./ui-boot-layout";
import { makeMenuEntries } from "./menu-entries";
import { makeToolbar } from "./ui-toolbar";
import { glyph, glyphFor, ensureGlyphFallbacks } from "./glyphs";
import { makeRenderAll } from "./render-all";
import { makeQuit } from "./quit";
import { makeStatus } from "./ui-status";
import { makeResizeWatcher } from "./resize";
import { runBoot } from "./boot";

// clear-and-rebuild idiom (the widgets' ctx fields take it as a callback)
const clearChildren = uiutilClearChildren;

if (isDebug) appendLog(`tfm starting pid=${process.pid} argv=[${process.argv.slice(1).join(" ")}]`);
const bootStart = performance.now();

// --- Config (TOML at ~/.config/tfm/config.toml, TFM_CONFIG overrides path) ---
const config = loadConfig();

// --- Color palette (theme from config; transparent-bg nudge lives in ./color) ---
const colors: Theme & Record<string, string> = deriveColors(config.theme, config.ui.transparentBg) as Theme &
  Record<string, string>;

// inner width available to children of the sidebar panel (outline border math
// lives in ./style)
const sideInnerW = (): number => sideInnerWidth(config.ui.uiStyle, sw);

// --- Nerd Font glyphs live in ./glyphs (FALLBACK ONLY); every category the
// ./filetype classifier can emit gets a file-glyph fallback ---
ensureGlyphFallbacks(new Set(Object.values(FILE_ICON_BY_EXT)));

// --- Post-mount node lookup seam — lives in ./ui-lookup (tested). Created
// before the widget factories that capture byId/stripSelectable in ctx; the
// renderer boots further down, so root arrives as an arrow (TDZ seam rule).
// Every lookup must tolerate a miss (nodes die on every rebuild). ---
const { byId, setTextOnId, setOnId, stripSelectable } = makeLookup({ root: () => renderer.root });

// --- Icon slots / thumbs / modal scrim — widget lives in ./ui-slots ---
// Called before the renderer boots: every ctx field the drain path needs is
// an arrow wrapper (post-boot evaluation), per the widget-seam rules.
const {
  cellMetrics,
  makeIconSlot,
  setIconState,
  escHintBtn,
  drainThumbs,
  drainIconQueue,
  setScrim,
  nextIconId,
  resetIconQueue,
  pushThumbJob,
} = makeSlots({
  renderer: () => renderer,
  byId,
  clearChildren: (node: any) => clearChildren(node),
  colors: () => colors as Theme & Record<string, any>,
  uiStyle: () => config.ui.uiStyle,
  iconCells: () => ICON_CELLS_H,
  modalOpen: () => floats.isOpen("escmenu"),
  glyphFor,
});

// --- App state & history (type + boot-state factory live in ./nav with the
// navigation logic) ---
const home = os.homedir();

const state: AppState = initialAppState(config);

// --- renderAll orchestration lives in ./render-all (tested): tab-sync +
// cwd-sync, then the named steps in insertion order, each guarded. Every
// step closes over a later-defined widget through an arrow (TDZ seam rule),
// so the const can sit at the TOP of the wiring and all consumers below
// reference it directly. ---
const renderAll = makeRenderAll({
  state,
  syncTabFromState: () => syncTabFromState(),
  scheduleSaveSession: () => scheduleSaveSession(),
  log: (msg) => appendLog(msg),
  steps: {
    cwdWatcher: () => syncCwdWatcher(),
    tabbar: () => renderTabbar(),
    nav: () => refreshNav(),
    crumbs: () => renderCrumbs(),
    sidebar: () => renderSidebar(),
    iconQueue: () => {
      void drainIconQueue();
    },
    grid: () => {
      void renderGrid();
    },
    preview: () => {
      void renderPreview();
    },
    stripSelectable: () => stripSelectable(),
  },
});

// --- Quit: the single teardown path lives in ./quit (tested). disableDrops
// and the renderer arrive as arrows (defined near the bottom of the wiring). ---
const quitApp = makeQuit({
  disableDrops: () => disableDrops(),
  releaseShiftCapture: () => process.stdout.write(xtShiftEscapeFrame(false)),
  destroy: () => renderer.destroy(),
  exit: (code) => process.exit(code),
});

// --- Status bar writes live in ./ui-status (tested): transient messages +
// the debounced reclaim by the selection summary. The refresh target is
// selection's, created further down — arrow defers it. ---
const { setStatusMsg } = makeStatus({
  byId,
  refresh: () => updateSelectionStatusReal(),
});

// --- History navigation — pure state machine lives in ./nav (tested);
// hooks close over later-defined bindings (TDZ seam rule) ---
const { canBack, canFwd, goBack, goFwd, navigate } = makeNav(state, {
  renderAll,
  clearSearch: () => clearSearch(),
  exitPathEdit: () => exitPathEdit(),
  closeFileMenuIfOpen: () => {
    if (fileMenuIsOpen()) closeFileMenu();
  },
});

// --- Tabs: `state` is always the ACTIVE tab's view; switching copies the
// live history refs into the outgoing tab slot and adopts the incoming one.
// Model lives in ./tabs (pure, tested) — rendering/session I/O stay here. ---
const tabModel = makeTabs(state, {
  onChanged: renderAll,
  status: setStatusMsg,
  quit: quitApp,
});
const { switchTab, newTab, closeTab, syncTabFromState } = tabModel;

// --- Session save/restore scheduling — logic lives in ./nav (tested) ---
const { scheduleSaveSession, restoreSession } = makeSessionSync({
  state,
  tabModel,
  config,
  isVirtualCwd,
});

// --- Type-to-search: query state + begin/clear/input-wiring live in ./search;
// the keymap drives begin/clear, the grid reads the query via getQuery(). ---
const search = makeSearch({
  byId,
  // arrow wrappers: termHasFocus/renderGrid are defined below (TDZ seam rule)
  termHasFocus: () => termHasFocus(),
  renderGrid: () => renderGrid(),
});
const { clearSearch, beginTypeToSearch, wireSearchInput } = search;

// --- Floating layers: THE single source of truth for which modal/cursor
// layer is open + the dismiss-others policy. Every widget factory below
// routes its open/close through it. Pure module, created before any widget. ---
const floats = makeFloats();

// --- File context menu (right-click a tile) — widget lives in ./ui-menu.
// Hoisted above nav/chrome/toolbar/conflict/grid-ctx, which all consume
// closeFileMenu/openContextMenu/fileMenuIsOpen. Safe pre-boot: every ctx
// field defers renderer access (same seam rule as makeSlots) ---
const MENU_W = 36;
const {
  closeFileMenu,
  renderFileMenu,
  openContextMenu,
  isFileMenuOpen: fileMenuIsOpen,
  fileMenuState: getFileMenuState,
} = makeMenu({
  byId,
  rootAdd: (node) => renderer.root.add(node),
  termW: () => renderer.terminalWidth,
  termH: () => renderer.terminalHeight,
  stripSelectable,
  drainIconQueue: () => drainIconQueue(),
  uiStyle: () => config.ui.uiStyle,
  colors: () => colors as Theme & Record<string, any>,
  menuW: MENU_W,
  floats,
  makeIconSlot,
});

// --- Places sidebar + tab strip — widget lives in ./ui-chrome ---
// mutable: applyConfig() rewrites these when settings change
let sw = config.ui.sidebarWidth;

const {
  renderSidebar,
  renderTabbar,
  normalizePlaces,
  placesHost,
  mountDevice,
  ejectDevice,
  setMousePlace,
  clearMousePlace,
} = makeChrome({
  byId,
  uiStyle: () => config.ui.uiStyle,
  colors: () => colors as Theme & Record<string, any>,
  sw: () => sw,
  sideInnerW,
  tabBar: () => config.ui.tabBar,
  renderAll,
  navigate: (target) => navigate(target),
  blurTerminal: () => blurTerminal(),
  closeFileMenu,
  openContextMenu,
  sidebarEntriesFor: (place, x, y) => sidebarEntriesFor(place, x, y),
  finishDrag: finishDragCtx,
  dlog: (msg) => dlog(msg),
  trashPaths: (paths) => trashPaths(paths),
  moveInto: (dest, items) => moveInto(dest, items),
  kbActive: () => keyRouter.sidebarActive(),
  kbIdx: () => keyRouter.placeIdx(),
  tabs: () => tabModel,
  closeTab: (i) => closeTab(i),
  switchTab: (i) => switchTab(i),
  newTab: () => newTab(),
  hoverBtn: (id, icon, onMouseDown) => hoverBtn(id, icon, onMouseDown),
  stripSelectable,
  drainIconQueue: () => drainIconQueue(),
  makeIconSlot: (name, states, heightCells, initialState, onMouseDown, statesFactory) =>
    makeIconSlot(name, states, heightCells, initialState, onMouseDown, statesFactory),
  setIconState: (spec, stateIdx) => setIconState(spec, stateIdx),
  home,
  stateCwd: () => state.cwd,
});

// --- Toolbar — widget lives in ./ui-toolbar (nav buttons, crumbs, inline path
// edit, sort/search buttons). The search QUERY state + type-to-search stay
// with the keyboard router; ctx fields for later-defined symbols are
// arrow wrappers (TDZ seam rule). ---
const { makeToolbarShell, renderCrumbs, refreshNav, repaintButtons, hoverBtn, exitPathEdit, pathEditMode } =
  makeToolbar({
    renderer: () => renderer,
    byId,
    clearChildren: (node: any) => clearChildren(node),
    stripSelectable,
    uiStyle: () => config.ui.uiStyle,
    colors: () => colors as Theme & Record<string, any>,
    makeIconSlot,
    setIconState,
    closeFileMenu,
    blurTerminal: () => blurTerminal(),
    navigate,
    canBack,
    canFwd,
    goBack,
    goFwd,
    openContextMenu,
    sortEntries: () => sortEntries(),
    cwd: () => state.cwd,
    home,
  });

// --- Virtual places: Recent (freedesktop recently-used.xbel) & Starred ---
// URI/XDG primitives live in ./uri, the registries in ./recent, the listings
// themselves in ./listing; this wrapper keeps the historic call-signature
// (defaults to the current cwd). Hoisted: consumed by factories constructed
// above this point (sessionSync, terminal, watcher, rename, dnd72).
function isVirtualCwd(p: string = state.cwd): boolean {
  return isVirtualUri(p);
}

// --- Layout: the pre-mount skeleton (title + three panels) lives in
// ./ui-boot-layout; ids are repainted by rethemeChrome, so they must stay
// byte-identical there. ---
const container = buildAppContainer({
  sw,
  sideInnerW: sideInnerW(),
  colors: colors as Record<string, any>,
  uiStyle: config.ui.uiStyle,
  tabBarVisible: config.ui.tabBar,
  previewWidth: config.ui.previewWidth,
  previewEnabled: config.ui.previewEnabled,
  title: buildTitle({ width: sideInnerW(), colors: colors as Record<string, any> }),
  toolbarShell: makeToolbarShell(),
});

// --- Renderer boot ---
const renderer = await createCliRenderer({
  exitOnCtrlC: false,
  targetFps: 60,
  maxFps: 120,
  ...(config.ui.transparentBg ? {} : { backgroundColor: colors.bg }),
});
renderer.root.add(container);
warmEmbeddedIcons(); // index the embedded svg blobs while the renderer boots
renderer.setBackgroundColor(colors.bg); // opencode-style: global bg lives on the renderer, not per-box

// --- Notifications — hoisted above its consumers (recent-open, undo, fileops,
// terminal, trashops, settings, dnd72) so they take `notify` directly instead
// of TDZ arrow wrappers; its ctx deps are all early (renderer/byId/colors) ---
const { notify, toastCount } = makeNotify({
  rootAdd: (node) => renderer.root.add(node),
  remove: (node) => {
    const p: any = node.parent ?? renderer.root;
    p.remove(node);
  },
  byId,
  termW: () => renderer.terminalWidth,
  accentBg: () => colors.accentBg,
  white: () => colors.white,
  sidebarFgMuted: () => colors.sidebarFgMuted,
  durationMs: () => config.ui.toastDurationMs,
});

// --- Recent-files recording + default open: batching/toast logic lives in
// ./recent-open (tested); xbel write, xdg-open spawn and the app probe are
// injected here (hoisted below the renderer boot so `notify` exists) ---
const { openFileDefault } = makeRecentOpen({
  inTrashView,
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
  uiStyle: () => config.ui.uiStyle,
  colors: () => colors,
  closeFileMenu,
});
const { openDialog, closeDialog } = dialogs;

// --- Grid (scrollable, culled, interactive) ---
// mutable: applyConfig() rewrites these when settings change
let TILE_W = config.ui.tileWidth;
let TILE_H = config.ui.tileHeight;
let ICON_CELLS_H = config.ui.iconCells;

let scroller: ScrollBoxRenderable | null = null;

// --- Selection + focus state lives in ./selection (single source of truth
// shared by the grid build, mouse pipeline, OSC 72 and the keyboard router) ---
const selection = makeSelection({
  colors: () => colors as Theme & Record<string, any>,
  uiStyle: () => config.ui.uiStyle,
  byId,
  setIconState,
  // hoisted wrapper: clipboardRef is defined below (TDZ)
  isCutKey,
  scroller: () => scroller,
  viewH: () => renderer.terminalHeight - 3,
  rowHInit: () => TILE_H,
  renderPreview: () => renderPreview(),
});
const {
  setTileVisual,
  selPaths,
  updateSelectionStatusReal,
  clearTileSelection,
  selectRange,
  selectTileAt,
  selectAll,
  refreshCutVisuals,
} = selection;
const tileRefsByKey = selection.tileRefs;

// --- inline rename/create: widget + state live in ./ui-rename ---
const { isRenaming, renameEditKey, clearRenameEdit, finishInlineRename, startInlineRename, startInlineCreate } =
  makeRename({
    renderer: () => renderer,
    byId,
    colors: () => colors as Record<string, any>,
    tileW: () => TILE_W,
    tileRefs: tileRefsByKey,
    stripSelectable,
    renderAll,
    renderGrid: () => renderGrid(),
    // arrow wrappers: pushUndoBatch/performRename are defined below (TDZ)
    performRename: (p, name) => performRename(p, name),
    pushUndoBatch: (label, undos, redos) => pushUndoBatch(label, undos, redos),
    setStatusMsg,
    isVirtualCwd,
    inTrashView,
    cwd: () => state.cwd,
    focusKeys: () => selection.focusKeys(),
    selectTileAt,
  });

// --- File operations ---
// runTransfer/performRename/paste/clipboard orchestration lives in ./fileops;
// the copy engine is ./transfer (pure, sink-injected), the progress toast
// is ./ui-progress, and cut-tile dimming lives in ./selection (setTileVisual).
// The cut check itself is pure (./clipboard); this wrapper reads the live
// internal clipboard. Hoisted: selection's ctx above takes the stable binding.
function isCutKey(key: string): boolean {
  return isCutKeyFor(clipboardRef(), key);
}

// --- Undo stack — state machine lives in ./undo (pure, tested) — results
// surface via sink; the override (conflict) prompt dialog lives in ./ui-dialogs ---
const { pushUndoBatch, undoLast, redoLast } = makeUndo({
  status: setStatusMsg,
  notify,
  refresh: renderAll,
});

const conflict = makeConflict(dialogs, {
  colors: () => colors as Theme & Record<string, any>,
  drainIconQueue: () => drainIconQueue(),
  floats,
});

// --- live copy progress: floating toast (top-right) with pause/cancel ---
// state + paint/toast machinery live in ./ui-progress; renderer, theme and the
// icon-slot machinery arrive via ctx (same seam as ui-dialogs/notify)
const { prog, paintProgress, showProgressToast, finishProgressToast, pauseGate } = makeProgress({
  byId,
  rootAdd: (node) => renderer.root.add(node),
  remove: (node) => {
    try {
      (node.parent ?? renderer.root).remove(node);
    } catch {}
  },
  stripSelectable,
  termW: () => renderer.terminalWidth,
  toastCount,
  colors: () => colors,
  makeIconSlot,
  setIconState,
  drainIconQueue,
});

const {
  runTransfer,
  performRename,
  setClipboard,
  pasteSmart,
  moveInto,
  clipboard: clipboardRef,
} = makeFileOps({
  conflict,
  prog,
  paintProgress,
  showProgressToast,
  finishProgressToast,
  pauseGate,
  pushUndoBatch,
  renderAll,
  setStatusMsg,
  notify,
  home,
  refreshCutVisuals,
  log: (msg) => dlog(msg),
});

// --- Embedded terminal pane — widget lives in ./ui-term ---
const {
  openTerminalHere,
  syncTerminalTheme,
  termHasFocus,
  blurTerminal,
  ownsKeyboard: termOwnsKeyboard,
} = makeTerminal({
  renderer,
  byId,
  uiStyle: () => config.ui.uiStyle,
  colors: () => colors as Theme & Record<string, any>,
  sw: () => sw,
  escHintBtn: (id, onClose) => escHintBtn(id, onClose),
  stripSelectable,
  drainIconQueue: () => drainIconQueue(),
  notify,
  renderAll,
  cwd: () => state.cwd,
  virtualCwd: isVirtualCwd,
  home,
  finishDrag: finishDragCtx,
  dlog: (msg) => dlog(msg),
});

const trashOps = makeTrashOps({
  pushUndoBatch,
  status: setStatusMsg,
  notify,
  refresh: renderAll,
  log: (msg) => appendLog(`trashops: ${msg}`),
});
const { trashPaths, restoreFromTrash, deleteForever, emptyTrash } = trashOps;

// --- Trash view detection: the path comparison is pure (./fsutil, honors
// $XDG_DATA_HOME); this wrapper reads the live cwd. Hoisted: recent-open's
// ctx above takes the stable binding. ---
function inTrashView(): boolean {
  return isTrashFilesDir(state.cwd);
}

// floating Yes/No confirmation — widget lives in ./ui-dialogs
const yesNo = makeYesNo(dialogs, {
  colors: () => colors as Theme & Record<string, any>,
  canOpen: () => !!renderer.resolution,
  floats,
});
const confirmYesNo = yesNo.confirm;

// --- Trash-bound confirm dialogs: label+verb bindings live in ./trashops ---
const { confirmEmptyTrash, confirmDeleteForever } = makeTrashConfirms({
  confirm: confirmYesNo,
  emptyTrash,
  deleteForever,
});

// --- Preview pane — widget lives in ./ui-preview ---
registerSyntaxParsers();
const { renderPreview } = makePreview({
  renderer,
  byId,
  colors: () => colors as Theme & Record<string, any>,
  uiStyle: () => config.ui.uiStyle,
  previewEnabled: () => config.ui.previewEnabled,
  previewWidth: () => config.ui.previewWidth,
  termH: () => renderer.terminalHeight,
  cellMetrics,
  focusKey: () =>
    selection.focusIdx() >= 0 && selection.focusKeys()[selection.focusIdx()]
      ? selection.focusKeys()[selection.focusIdx()]!
      : null,
  tileRefs: tileRefsByKey,
  pushThumbJob,
  drainThumbs: () => drainThumbs(),
  drainIconQueue: () => drainIconQueue(),
  nextIconId,
  fallbackGlyphFor: (name) => glyph[name] ?? glyph.file!,
});

// Rubber-band gesture state + commit logic live in ./grid-input; this is the
// ctx object it renders through (built here because it closes over the live
// selection/preview state below).
const bandCtx: BandCtx = {
  byId,
  tileRefs: tileRefsByKey,
  clearTileSelection,
  setTileVisual,
  updateSelectionStatusReal,
  renderPreview,
  setSelAnchor: (v: number | null) => {
    selection.setSelAnchor(v);
  },
};

// Mouse behavior shared by grid tiles AND list rows: selection (plain/ctrl/
// shift), double-click open, drag payload prep, drop-into-folder, hover. Both
// view modes register the exact same logic on differently-shaped containers;
// all state lives in tileRefsByKey + the drag module vars, keyed by path.
const gridCtx = {
  byId,
  termW: () => renderer.terminalWidth,
  termH: () => renderer.terminalHeight,
  tileRefs: tileRefsByKey,
  setTileVisual,
  updateSelectionStatusReal,
  renderPreview,
  clearTileSelection,
  selectRange,
  getSelAnchor: () => selection.selAnchor(),
  setSelAnchor: (v: number | null) => {
    selection.setSelAnchor(v);
  },
  getFocusIdx: () => selection.focusIdx(),
  selPaths,
  dblClickMs: () => config.ui.doubleClickMs,
  dragThresholdCells: () => config.ui.dragThresholdCells,
  navigate,
  openFileDefault,
  openContextMenu: (x: number, y: number, title: string, entries: GridMenuEntry[]) =>
    openContextMenu(x, y, title, entries as ListEntry[]),
  fileEntriesFor: (key: string, isDir: boolean, x: number, y: number): GridMenuEntry[] =>
    fileEntriesFor(key, isDir, x, y) as GridMenuEntry[],
  closeFileMenu,
  renameEditKey,
  finishInlineRename,
  setStatusMsg,
  log: (msg: string) => dlog(msg),
  moveInto,
};
function finishDragCtx() {
  return finishDragState(gridCtx);
}

const entryMouseHandlers = makeEntryMouseHandlers(gridCtx);

// --- Grid renderer lives in ./ui-grid (tile/list-row builders, empty and
// restricted states, thumbnail handoff, gen-counter stale guards) ---
const { renderGrid } = makeGridRenderer({
  termW: () => renderer.terminalWidth,
  termH: () => renderer.terminalHeight,
  scroller: () => scroller,
  state,
  searchQuery: () => search.getQuery(),
  pathEditMode: () => pathEditMode(),
  sw: () => sw,
  tileW: () => TILE_W,
  tileH: () => TILE_H,
  iconCells: () => ICON_CELLS_H,
  listRowH: () => config.ui.listRowHeight,
  uiStyle: () => config.ui.uiStyle,
  colors: () => colors as Theme & Record<string, any>,
  previewEnabled: () => config.ui.previewEnabled,
  previewWidth: () => config.ui.previewWidth,
  viewMode: () => config.ui.viewMode,
  wordWrap: () => config.ui.wordWrap,
  reservedRight: () => (config.ui.previewEnabled ? config.ui.previewWidth : 0),
  cellMetrics,
  makeIconSlot,
  pushThumbJob,
  nextIconId: () => nextIconId(),
  drainIconQueue: () => drainIconQueue(),
  drainThumbs: () => drainThumbs(),
  stripSelectable,
  selection,
  entryMouseHandlers,
  isCutKey,
  waitForResolution: () => waitForResolution(renderer),
  clearRenameEdit,
});

const { openProperties, closeProps } = makeProps({
  byId,
  openDialog,
  closeDialog,
  floats,
  setTextOnId,
  // setOnId is defined further down — defer through a wrapper (TDZ)
  setOnId: (id, fn) => setOnId(id, fn),
  stripSelectable,
  drainIconQueue: () => drainIconQueue(),
  drainThumbs: () => drainThumbs(),
  pushThumbJob,
  nextIconId,
  escHintBtn,
  closeFileMenu,
  openContextMenu: (x, y, title, entries) => openContextMenu(x, y, title, entries),
  renderAll,
  setStatusMsg,
  uiStyle: () => config.ui.uiStyle,
  colors: () => colors as Theme & Record<string, any>,
  home,
  makeIconSlot,
  setIconState,
  fallbackGlyphFor: (name) => glyph[name] ?? glyph.file!,
  cellMetrics,
});

// --- Menu entry builders (what the menus contain) live in ./menu-entries;
// the floating menu widget itself lives in ./ui-menu ---
const { sidebarEntriesFor, fileEntriesFor, sortEntries, emptyAreaEntries } = makeMenuEntries({
  closeFileMenu,
  navigate,
  renderAll,
  renderGrid,
  openTerminalHere,
  clipboard: () => clipboardRef(),
  pasteSmart,
  confirmEmptyTrash,
  confirmDeleteForever,
  ejectDevice,
  mountDevice,
  inTrashView,
  tileRefs: tileRefsByKey,
  selPaths,
  openFileDefault,
  setClipboard,
  startInlineRename,
  startInlineCreate,
  trashPaths,
  restoreFromTrash,
  openProperties,
  selectAll,
  cwd: () => state.cwd,
  sortState: state,
});

// --- Settings model: row type + pure semantics live in ./settings.ts, the
// row->config wiring in ./settings-model, the panel in ./ui-settings ---
const { settingGroups } = makeSettingModel({
  config,
  state,
  // arrow wrappers: applyConfig/scheduleSaveConfig/escMenu are defined below (TDZ)
  applyConfig: (fresh) => applyConfig(fresh),
  scheduleSaveConfig: () => scheduleSaveConfig(),
  showRoot: () => escMenu.showRoot(),
  warn: (message, title) => notify(message, title ?? "tfm"),
});

const escMenu = makeEscMenu({
  renderer: () => renderer,
  byId,
  floats,
  clearChildren: (node: any) => clearChildren(node),
  stripSelectable,
  escHintBtn,
  makeIconSlot,
  drainIconQueue: () => drainIconQueue(),
  setScrim,
  cancelBand: () => cancelBand(bandCtx),
  colors: () => colors as Theme & Record<string, any>,
  uiStyle: () => config.ui.uiStyle,
  menuW: () => MENU_W,
  settingGroups: () => settingGroups(),
  warn: (message, title) => notify(message, title ?? "tfm"),
  log: (message) => dlog(message),
  quit: quitApp,
});

// --- Live directory watching: external changes refresh the grid.
// Watch lifecycle lives in ./watcher (tested); index supplies the live
// cwd/renaming/renderGrid getters (TDZ seam rule). ---
const { syncCwdWatcher } = makeCwdWatcher({
  cwd: () => state.cwd,
  isVirtualCwd,
  isRenaming: () => isRenaming(),
  renderGrid: () => renderGrid(),
});

// --- Boot sequence (order + toast gating live in ./boot, tested): resolution
// wait, fixed nodes, globs2, session restore, places, first render, hygiene,
// search wiring. Everything renderer-coupled arrives as an injected step. ---
void runBoot({
  waitForResolution: () => waitForResolution(renderer),
  buildLayout: () => {
    // scroller/band rect/drag ghost — module: ./ui-boot-layout (ids stay
    // byte-identical; band gesture fns wired there straight from grid-input)
    scroller = buildBootLayout({
      renderer,
      byId,
      colors,
      bandCtx,
      closeFileMenu,
      clearSearch,
      blurTerminal,
      pathEditMode,
      exitPathEdit,
      isRenaming,
      finishInlineRename,
      clearTileSelection,
      openContextMenu: (x: number, y: number, t: string, e: any[]) => openContextMenu(x, y, t, e),
      emptyAreaEntries,
    });
  },
  loadGlobs2: () => loadGlobs2(),
  restoreSession: () => restoreSession(),
  loadSystemPlaces: () => loadSystemPlaces(),
  renderAll,
  debugTrace: () => {
    debugLog(
      `terminal ${renderer.terminalWidth}x${renderer.terminalHeight} cwd=${process.cwd()} config=${configPath()}`,
    );
    setStatusMsg(`debug: ${DEBUG_LOG}`);
  },
  launchToast: () => notify(`launched in ${Math.round(performance.now() - bootStart)} ms`),
  startHygiene: () =>
    startMemHygiene({
      // the private allocator stats reach is the only renderer-coupled part,
      // so it's injected here (module: ./mem-hygiene)
      allocatorStats: () => {
        try {
          return (renderer as any).lib?.getAllocatorStats?.() ?? null;
        } catch {
          return null;
        }
      },
      debugLog: isDebug ? (msg) => debugLog(msg) : undefined,
    }),
  wireSearchInput: () => wireSearchInput(),
  isDebug,
  showLaunchTime: () => config.ui.showLaunchTime,
});

// --- Config application & persistence: lives in ./ui-retheme (rethemeChrome,
// applyConfig, scheduleSaveConfig, live reload). Geometry lets stay here and
// are rewritten through the ctx setters — never bake them into consts. ---

const { applyConfig, scheduleSaveConfig } = makeRetheme({
  config,
  colors: colors as Theme & Record<string, any>,
  setOnId,
  byId,
  renderer: () => renderer,
  getSw: () => sw,
  setSw: (v) => {
    sw = v;
  },
  setTileW: (v) => {
    TILE_W = v;
  },
  setTileH: (v) => {
    TILE_H = v;
  },
  setIconCells: (v) => {
    ICON_CELLS_H = v;
  },
  sideInnerW,
  renderAll,
  clearIconCaches,
  resetIconQueue: () => resetIconQueue(),
  syncTerminalTheme,
  repaintButtons,
  renderCrumbs,
  refreshNav,
  escMenu,
  fileMenuIsOpen,
  renderFileMenu,
  setStatusMsg,
});

// --- OSC 72 (kitty drag-and-drop): wire format per yazi's reference impl;
// the state machine (outgoing drags, incoming drops, self-drop routing) lives
// in ./dnd72, the byte-exact frames in ./osc72. Only the renderer-coupled
// hooks stay here: cell hit-testing, tile highlight and place hover. ---
const { enableDrops, disableDrops } = makeDnd72({
  log: (msg) => dlog(msg),
  writeFrame: (s) => {
    try {
      process.stdout.write(s);
    } catch {}
  },
  // cell -> drop target walk lives in ./hit-target (tested); index supplies
  // the renderer-coupled hitTest + registry and the live place/tile refs
  hitTargetAt: makeHitTargetAt({
    hitTest: (x, y) => renderer.hitTest(x, y),
    byNumber: (num) => (Renderable as any).renderablesByNumber?.get(num),
    placesHost: () => placesHost,
    tileRefs: tileRefsByKey,
  }),
  tileRefs: tileRefsByKey,
  setTileVisual,
  hoverPlace: (p) => {
    const idx = placesHost.findIndex((pl) => pl.place.path === p);
    if (idx >= 0) setMousePlace(idx);
  },
  clearHoverPlace: () => clearMousePlace(),
  finishDrag: finishDragCtx,
  escMenuOpen: () => floats.isOpen("escmenu"),
  fileMenuOpen: () => floats.isOpen("filemenu"),
  trashPaths,
  moveInto,
  runTransfer,
  cwd: () => state.cwd,
  virtualCwd: isVirtualCwd,
  home,
  setStatusMsg,
  notify,
  subscribeOsc: (cb) => renderer.subscribeOsc(cb),
});
enableDrops();
// XTSHIFTESCAPE=1 (CSI > Ps s): ask the terminal (kitty, ghostty, xterm) to
// forward shift+click instead of using it for native text selection.
// Terminals that don't know the sequence ignore it; alt+click is the fallback.
// (frame builder in ./ui-term; released on quit via makeQuit above)
try {
  dlog("tx xtshiftescape on");
  process.stdout.write(xtShiftEscapeFrame(true));
} catch {}

// --- resize: repave rasters and rebuild layout (debounce lives in ./resize) ---
const { onResize } = makeResizeWatcher({
  resetIconQueue: () => resetIconQueue(),
  renderAll,
});
renderer.on(CliRenderEvents.RESIZE, onResize);

// --- Keyboard router lives in ./keymap: modal precedence chain (quit >
// conflict > yes/no > rename > props > esc-menu > terminal > path-edit >
// file menu > search > sidebar > grid > chords) + sidebar kb-focus state ---
const keyRouter = makeKeyRouter({
  byId,
  state,
  keybinds: (action) => config.keys[action] ?? [],
  quit: quitApp,
  // layer-open reads go through floats — the single source of truth; the
  // close fns are the widgets' (they route back through floats themselves)
  conflict: { isOpen: () => floats.isOpen("conflict"), closeConflict: (p: "skip") => conflict.closeConflict(p) },
  yesNo: { isOpen: () => floats.isOpen("yesno"), close: () => yesNo.close() },
  isRenaming,
  propsIsOpen: () => floats.isOpen("props"),
  closeProps,
  escMenu: { ...escMenu, isOpen: () => floats.isOpen("escmenu") },
  termOwnsKeyboard,
  pathEditMode,
  pathInputVisible: () => !!(byId("tfm-path-input") as any)?.visible,
  searchVisible: () => !!(byId("tfm-search") as any)?.visible,
  searchQuery: () => search.getQuery(),
  clearSearch,
  exitPathEdit,
  beginTypeToSearch,
  renderGrid,
  renderPreview,
  renderAll,
  selection,
  placesHost,
  normalizePlaces,
  mountDevice,
  navigate,
  openFileDefault,
  getFileMenuState,
  closeFileMenu,
  renderFileMenu,
  tabModel,
  newTab,
  closeTab,
  switchTab,
  inTrashView,
  confirmDeleteForever,
  trashPaths,
  restoreFromTrash,
  startInlineRename,
  setClipboard,
  isVirtualCwd,
  pasteSmart,
  undoLast,
  redoLast,
});

renderer.keyInput.on("keypress", (e: any) => keyRouter.handleKey(e));
