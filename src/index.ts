import { ASCIIFont, Box, CliRenderEvents, RGBA, Renderable, ScrollBoxRenderable, Text, createCliRenderer } from "@opentui/core";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync } from "node:fs";
import { readFile, lstat, readlink, symlink, cp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadConfig, configPath, type Config, type Theme } from "./config";
import { applySurface, btnSurface, chromeSurface, rowSurface, slotBg, tileSurface } from "./style";
import { bumpHex } from "./color";
import { clearIconCaches, warmEmbeddedIcons } from "./icons";
import { FILE_ICON_BY_EXT, loadGlobs2 } from "./filetype";
// --- Directory listing/sort/virtual-place entries live in ./listing ---
import { listDir, type Entry } from "./listing";
import { isVirtualUri } from "./uri";
import {
  upsertRecentXbel,
} from "./recent";
import { trashDir } from "./fsutil";
import { loadSystemPlaces } from "./places";
import { registerSyntaxParsers } from "./syntax";
import { makeDnd72 } from "./dnd72";
import { makeSettingModel } from "./settings-model";
import { makeRename } from "./ui-rename";
import { makeNav, makeSessionSync, type AppState } from "./nav";
import { makeCwdWatcher } from "./watcher";
import { makeHitTargetAt } from "./hit-target";
import { makeRecentOpen } from "./recent-open";
import { makeLookup, waitForResolution } from "./ui-lookup";
import { makeSelection } from "./selection";
import { makeGridRenderer } from "./ui-grid";
import { makeKeyRouter } from "./keymap";
import { makeRetheme } from "./ui-retheme";
import { makeTrashOps } from "./trashops";
import { makeFileOps } from "./fileops";
import { makeUndo } from "./undo";
import { makeTabs } from "./tabs";
import { appForFile } from "./apps";
import { clearChildren as uiutilClearChildren, debounced as uiutilDebounced, safeRenderStep as uiutilSafeRenderStep } from "./uiutil";
import { animateLeft, makeNotify } from "./notify";
import { makeChrome } from "./ui-chrome";
import { makeDialogs, makeConflict, makeYesNo } from "./ui-dialogs";
import { makeMenu } from "./ui-menu";
import type { ListEntry } from "./ui-menu";
import { makePreview } from "./ui-preview";
import { makeProps } from "./ui-props";
import { makeProgress } from "./ui-progress";
import { makeTerminal, xtShiftEscapeFrame } from "./ui-term";
import { makeSlots, type IconState, type IconSpec } from "./ui-slots";
import { makeEscMenu } from "./ui-settings";
import {
  cancelBand,
  finishDragState,
  makeEntryMouseHandlers,
  type BandCtx,
  type ClipItem,
  type GridMenuEntry,
} from "./grid-input";
import { appendLog, debugLog, dlog, isDebug, DEBUG_LOG } from "./log";
import { startMemHygiene } from "./mem-hygiene";
import { makeSearch } from "./search";
import { buildBootLayout } from "./ui-boot-layout";
import { makeMenuEntries } from "./menu-entries";
import { makeToolbar } from "./ui-toolbar";
import { glyph, glyphFor } from "./glyphs";

// clear-and-rebuild / debounce / render-step guards live in ./uiutil
const clearChildren = uiutilClearChildren;
const debounced = uiutilDebounced;
const safeRenderStep = (name: string, fn: () => void | Promise<void>): void =>
  uiutilSafeRenderStep(name, fn, appendLog);

if (isDebug) appendLog(`tfm starting pid=${process.pid} argv=[${process.argv.slice(1).join(" ")}]`);

// --- Config (TOML at ~/.config/tfm/config.toml, TFM_CONFIG overrides path) ---
const config = loadConfig();

// --- Color palette (theme from config; Tokyo Night defaults) ---

// Terminals with background_opacity (kitty etc.) composite only their DEFAULT
// background; OpenTUI leaves unpainted cells on SGR 49, so those go
// see-through. transparentBg=false forces an opaque UI: renderer clear color =
// bg, and bg itself nudged one step so it can never byte-equal the terminal's
// default color. true keeps the theme faithful and gaps on terminal default.
const colors: Theme & Record<string, string> = { ...config.theme };
if (!config.ui.transparentBg) colors.bg = bumpHex(colors.bg);

// inner width available to children of the sidebar panel: outline mode's
// border ring reserves one cell per side (yoga setBorder)
const sideInnerW = (): number => (config.ui.uiStyle === "outline" ? sw - 2 : sw);

// --- Nerd Font glyphs live in ./glyphs (FALLBACK ONLY) ---
// File type categories: icon NAMES live in ./filetype; this fills the
// glyph fallbacks for every category the classifier can emit
for (const cat of new Set(Object.values(FILE_ICON_BY_EXT))) {
  if (!(cat in glyph)) glyph[cat] = glyph.file!;
}

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
  modalOpen: () => escMenu.isOpen(),
  glyphFor,
});

// --- App state & history (type lives in ./nav with the navigation logic) ---
const home = os.homedir();

const state: AppState = {
  cwd: process.cwd(),
  history: [process.cwd()],
  histIdx: 0,
  showHidden: config.ui.showHidden,
  sortBy: "name",
  sortAsc: true,
};

// renderAll is a hoisted function declaration (defined further down) so
// factories constructed before it can hold the stable binding directly —
// no per-ctx TDZ arrow wrappers needed.

// --- History navigation — pure state machine lives in ./nav (tested);
// hooks close over later-defined bindings (TDZ seam rule) ---
const { canBack, canFwd, goBack, goFwd, navigate } = makeNav(state, {
  renderAll,
  clearSearch: () => clearSearch(),
  exitPathEdit: () => exitPathEdit(),
  closeFileMenuIfOpen: () => { if (fileMenuIsOpen()) closeFileMenu(); },
});

// --- Tabs: `state` is always the ACTIVE tab's view; switching copies the
// live history refs into the outgoing tab slot and adopts the incoming one.
// Model lives in ./tabs (pure, tested) — rendering/session I/O stay here. ---
const tabModel = makeTabs(state, {
  onChanged: renderAll,
  status: setStatusMsg,
  quit: quitApp,
});
const { switchTab, newTab, closeTab, syncTabFromState, adoptTab } = tabModel;

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


// --- File context menu (right-click a tile) — widget lives in ./ui-menu.
// Hoisted above nav/chrome/toolbar/conflict/grid-ctx, which all consume
// closeFileMenu/openContextMenu/fileMenuIsOpen. Safe pre-boot: every ctx
// field defers renderer access (same seam rule as makeSlots) ---
const MENU_W = 36;
const { closeFileMenu, renderFileMenu, openContextMenu, isFileMenuOpen: fileMenuIsOpen, fileMenuState: getFileMenuState } = makeMenu({
  byId,
  rootAdd: (node) => renderer.root.add(node),
  termW: () => renderer.terminalWidth,
  termH: () => renderer.terminalHeight,
  stripSelectable,
  drainIconQueue: () => drainIconQueue(),
  uiStyle: () => config.ui.uiStyle,
  colors: () => colors as Theme & Record<string, any>,
  menuW: MENU_W,
  makeIconSlot,
});

// --- Places sidebar + tab strip — widget lives in ./ui-chrome ---
// mutable: applyConfig() rewrites these when settings change
let sw = config.ui.sidebarWidth;

const { renderSidebar, renderTabbar, normalizePlaces, makeDivider, placesHost, mountDevice, ejectDevice, setMousePlace, clearMousePlace } = makeChrome({
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

const makeTitle = () =>
  Box(
    { id: "tfm-title-box", width: sideInnerW(), height: 5, flexDirection: "column", justifyContent: "center", paddingLeft: 1 },
    ASCIIFont({ id: "tfm-title-font", text: "tfm", font: "tiny", color: colors.accent }),
    Text({ id: "tfm-title-sub", content: " terminal file manager", fg: colors.sidebarFgMuted }),
  );

// --- Toolbar — widget lives in ./ui-toolbar (nav buttons, crumbs, inline path
// edit, sort/search buttons). The search QUERY state + type-to-search stay
// here with the keyboard router; ctx fields for later-defined symbols are
// arrow wrappers (TDZ seam rule). ---
const {
  makeToolbarShell,
  renderCrumbs,
  refreshNav,
  repaintButtons,
  hoverBtn,
  exitPathEdit,
  pathEditMode,
} = makeToolbar({
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

// --- Directory listing ---
// --- Virtual places: Recent (freedesktop recently-used.xbel) & Starred ---
// URI/XDG primitives live in ./uri, the registries in ./recent, the listings
// themselves in ./listing; this wrapper keeps the historic call-signature
// (defaults to the current cwd)
function isVirtualCwd(p: string = state.cwd): boolean {
  return isVirtualUri(p);
}

// --- Layout ---
const container = Box(
  { width: "100%", height: "100%", flexDirection: "row" },
  Box(
    { id: "tfm-sidebar-root", width: sw, height: "100%", ...chromeSurface(config.ui.uiStyle, colors, colors.sidebarBg), flexDirection: "column" },
    makeTitle(),
    Box({ id: "tfm-places", width: sideInnerW(), flexDirection: "column" }),
  ),
  Box(
    { id: "tfm-main", flexGrow: 1, height: "100%", ...chromeSurface(config.ui.uiStyle, colors, colors.bg), flexDirection: "column" },
    makeToolbarShell(),
    Box({ id: "tfm-tabbar", width: "100%", height: 1, flexDirection: "row", columnGap: 1, paddingLeft: 1, visible: config.ui.tabBar }),
    Box({ id: "tfm-grid-host", flexGrow: 1, width: "100%", flexDirection: "column" }),
    // status bar sits above the embedded terminal pane (zero-height until opened),
    // so with a terminal open the bar hugs its top edge instead of sinking below it
    Box(
      { id: "tfm-status", width: "100%", height: 1, flexDirection: "row", justifyContent: "flex-end", paddingRight: 1 },
      Text({ id: "tfm-status-label", content: "", fg: colors.sidebarFgMuted }),
    ),
    Box({ id: "tfm-term-host", width: "100%", height: 0, flexDirection: "column" }),
  ),
  Box(
    {
      id: "tfm-preview",
      width: config.ui.previewWidth,
      height: "100%",
      visible: config.ui.previewEnabled, // display:none in yoga: takes no layout space when hidden
      ...chromeSurface(config.ui.uiStyle, colors, colors.sidebarBg),
      flexDirection: "column",
      paddingLeft: 1,
      paddingRight: 1,
    },
  ),
);

// --- Renderer boot ---
const renderer = await createCliRenderer({ exitOnCtrlC: false, targetFps: 60, maxFps: 120, ...(config.ui.transparentBg ? {} : { backgroundColor: colors.bg }) });
renderer.root.add(container);
warmEmbeddedIcons(); // index the embedded svg blobs while the renderer boots
renderer.setBackgroundColor(colors.bg); // opencode-style: global bg lives on the renderer, not per-box

// --- Notifications — hoisted above its consumers (recent-open, undo, fileops,
// terminal, trashops, settings, dnd72) so they take `notify` directly instead
// of TDZ arrow wrappers; its ctx deps are all early (renderer/byId/colors) ---
const { notify, toastCount } = makeNotify({
  rootAdd: (node) => renderer.root.add(node),
  remove: (node) => { const p: any = node.parent ?? renderer.root; p.remove(node); },
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
  spawnOpen: (p) => { spawn("xdg-open", [p], { stdio: "ignore", detached: true }).unref?.(); },
  appForFile,
});

const dialogs = makeDialogs({
  byId,
  rootAdd: (node) => renderer.root.add(node),
  stripSelectable,
  termH: () => renderer.terminalHeight,
  uiStyle: () => config.ui.uiStyle,
  colors: () => colors,
});
const { openDialog, closeDialog, dialogBtn } = dialogs;


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
  // arrow wrappers: isCutKey/renderPreview are defined below (TDZ)
  isCutKey,
  scroller: () => scroller,
  viewH: () => renderer.terminalHeight - 3,
  rowHInit: () => TILE_H,
  renderPreview: () => renderPreview(),
});
const {
  setTileVisual,
  tileStates,
  selPaths,
  updateSelectionStatusReal,
  clearTileSelection,
  selectRange,
  selectTileAt,
  moveFocus,
  selectAll,
  refreshCutVisuals,
} = selection;
const tileRefsByKey = selection.tileRefs;

// --- inline rename/create: widget + state live in ./ui-rename ---
const {
  isRenaming,
  renameEditKey,
  clearRenameEdit,
  finishInlineRename,
  startInlineRename,
  startInlineCreate,
} = makeRename({
  renderer: () => renderer,
  byId,
  colors: () => colors as Record<string, any>,
  tileW: () => TILE_W,
  tileRefs: tileRefsByKey,
  stripSelectable,
  renderAll,
  renderGrid: () => renderGrid(),
  // arrow wrappers: pushUndoBatch/performRename/setStatusMsg/inTrashView are defined below (TDZ)
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
function isCutKey(key: string): boolean {
  const c = clipboardRef();
  return c?.mode === "cut" && c.items.some((i) => i.path === key);
};

// the reset fires 2500ms after the LAST status message, like a debounce
const clearStatusMsg = debounced(2500, () => updateSelectionStatusReal());
// hoisted declaration: consumed by factories constructed above this point
function setStatusMsg(text: string) {
  const status: any = byId("tfm-status-label");
  if (status) { try { status.content = text; } catch {} }
  clearStatusMsg();
};

// --- Undo stack + override (conflict) prompt — dialog lives in ./ui-dialogs ---
// undo/redo state machine lives in ./undo (pure, tested) — results surface via sink
const { pushUndoBatch, undoLast, redoLast } = makeUndo({
  status: setStatusMsg,
  notify,
  refresh: renderAll,
});


const conflict = makeConflict(dialogs, {
  colors: () => colors as Theme & Record<string, any>,
  drainIconQueue: () => drainIconQueue(),
  closeTransients: () => {
    closeFileMenu();
    if (propsIsOpen()) closeProps();
  },
});

// --- live copy progress: floating toast (top-right) with pause/cancel ---
// state + paint/toast machinery live in ./ui-progress; renderer, theme and the
// icon-slot machinery arrive via ctx (same seam as ui-dialogs/notify)
const { prog, paintProgress, showProgressToast, finishProgressToast, pauseGate } = makeProgress({
  byId,
  rootAdd: (node) => renderer.root.add(node),
  remove: (node) => { try { (node.parent ?? renderer.root).remove(node); } catch {} },
  stripSelectable,
  termW: () => renderer.terminalWidth,
  toastCount,
  colors: () => colors,
  makeIconSlot,
  setIconState,
  drainIconQueue,
});

const { runTransfer, performRename, setClipboard, pasteSmart, moveInto, clipboard: clipboardRef } = makeFileOps({
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
const { openTerminalHere, closeTerminalPane, syncTerminalTheme, termHasFocus, blurTerminal, ownsKeyboard: termOwnsKeyboard } = makeTerminal({
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

// --- Trash management: restore / delete-permanently / empty ---
function inTrashView(): boolean {
  return path.resolve(state.cwd) === path.join(trashDir(), "files");
}

// floating Yes/No confirmation — widget lives in ./ui-dialogs
const yesNo = makeYesNo(dialogs, {
  colors: () => colors as Theme & Record<string, any>,
  canOpen: () => !!renderer.resolution,
});
const confirmYesNo = yesNo.confirm;

const confirmEmptyTrash = (): void => {
  confirmYesNo("Empty Trash?", "Empty", () => emptyTrash(), true);
};

const confirmDeleteForever = (paths: string[]): void => {
  confirmYesNo(`Permanently delete ${paths.length} item${paths.length === 1 ? "" : "s"}?`, "Delete", () => deleteForever(paths), true);
};

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
  focusKey: () => (selection.focusIdx() >= 0 && selection.focusKeys()[selection.focusIdx()] ? selection.focusKeys()[selection.focusIdx()]! : null),
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
  setSelAnchor: (v: number | null) => { selection.setSelAnchor(v); },
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
  setSelAnchor: (v: number | null) => { selection.setSelAnchor(v); },
  getFocusIdx: () => selection.focusIdx(),
  selPaths,
  dblClickMs: () => config.ui.doubleClickMs,
  dragThresholdCells: () => config.ui.dragThresholdCells,
  navigate,
  openFileDefault,
  openContextMenu: (x: number, y: number, title: string, entries: GridMenuEntry[]) => openContextMenu(x, y, title, entries as ListEntry[]),
  fileEntriesFor: (key: string, isDir: boolean, x: number, y: number): GridMenuEntry[] => fileEntriesFor(key, isDir, x, y) as GridMenuEntry[],
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


const { openProperties, closeProps, isOpen: propsIsOpen } = makeProps({
  byId,
  openDialog,
  closeDialog,
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

// --- ESC menu + settings panel — widget lives in ./ui-settings ---
// hoisted declaration: tabs/settings/esc-menu are constructed before this
// point but only ever CALL it (post-boot), so the stable binding suffices
function quitApp() {
  disableDrops();
  // release the shift-capture request made at boot (frame in ./ui-term)
  try { process.stdout.write(xtShiftEscapeFrame(false)); } catch {}
  try { renderer.destroy(); } catch {}
  process.exit(0);
};

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

// --- Orchestration ---
function renderAll() {
  // navigate/back/forward mutate state.history directly — fold it into the
  // active tab slot BEFORE anything renders, or chip titles lag one switch
  syncTabFromState();
  state.cwd = state.history[state.histIdx] ?? state.cwd;
  safeRenderStep("cwdWatcher", () => syncCwdWatcher());
  safeRenderStep("tabbar", () => renderTabbar());
  safeRenderStep("nav", () => refreshNav());
  safeRenderStep("crumbs", () => renderCrumbs());
  safeRenderStep("sidebar", () => renderSidebar());
  safeRenderStep("iconQueue", () => void drainIconQueue());
  safeRenderStep("grid", () => void renderGrid());
  safeRenderStep("preview", () => void renderPreview());
  safeRenderStep("stripSelectable", () => stripSelectable());
  scheduleSaveSession();
};


const boot = async () => {
  await waitForResolution(renderer);
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

  await loadGlobs2();
  restoreSession();
  await loadSystemPlaces();
  renderAll();

  if (isDebug) {
    debugLog(`terminal ${renderer.terminalWidth}x${renderer.terminalHeight} cwd=${process.cwd()} config=${configPath()}`);
    setStatusMsg(`debug: ${DEBUG_LOG}`);
  }

  // --- Native memory hygiene (module: ./mem-hygiene) — the private allocator
  // stats reach is the only renderer-coupled part, so it's injected here ---
  startMemHygiene({
    allocatorStats: () => {
      try {
        return (renderer as any).lib?.getAllocatorStats?.() ?? null;
      } catch { return null; }
    },
    debugLog: isDebug ? (msg) => debugLog(msg) : undefined,
  });

  wireSearchInput();
};
boot();

// --- Config application & persistence: lives in ./ui-retheme (rethemeChrome,
// applyConfig, scheduleSaveConfig, live reload). Geometry lets stay here and
// are rewritten through the ctx setters — never bake them into consts. ---

const { rethemeChrome, applyConfig, scheduleSaveConfig } = makeRetheme({
  config,
  colors: colors as Theme & Record<string, any>,
  setOnId,
  byId,
  renderer: () => renderer,
  getSw: () => sw,
  setSw: (v) => { sw = v; },
  setTileW: (v) => { TILE_W = v; },
  setTileH: (v) => { TILE_H = v; },
  setIconCells: (v) => { ICON_CELLS_H = v; },
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
  writeFrame: (s) => { try { process.stdout.write(s); } catch {} },
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
  escMenuOpen: () => escMenu.isOpen(),
  fileMenuOpen: () => fileMenuIsOpen(),
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
// XTSHIFTESCAPE (frame builder in ./ui-term): ask the terminal to forward
// shift+click instead of using it for native text selection; released on quit.
try { dlog("tx xtshiftescape on"); process.stdout.write(xtShiftEscapeFrame(true)); } catch {}

// --- resize: repave rasters and rebuild layout ---
let resizeTimer: any = null;
renderer.on(CliRenderEvents.RESIZE, () => {
  if (resizeTimer) clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    resetIconQueue();
    renderAll();
  }, 150);
});


// --- Keyboard router lives in ./keymap: modal precedence chain (quit >
// conflict > yes/no > rename > props > esc-menu > terminal > path-edit >
// file menu > search > sidebar > grid > chords) + sidebar kb-focus state ---
const keyRouter = makeKeyRouter({
  byId,
  state,
  keybinds: (action) => config.keys[action] ?? [],
  quit: quitApp,
  conflict,
  yesNo,
  isRenaming,
  propsIsOpen,
  closeProps,
  escMenu,
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
