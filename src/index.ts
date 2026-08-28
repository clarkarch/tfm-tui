import { ASCIIFont, Box, CliRenderEvents, RGBA, Renderable, ScrollBoxRenderable, Text, createCliRenderer } from "@opentui/core";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, createWriteStream, statSync, watch } from "node:fs";
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
import { RECENT_URI, STARRED_URI, isVirtualUri } from "./uri";
import {
  upsertRecentXbel,
} from "./recent";
import { trashDir } from "./fsutil";
import { loadSystemPlaces } from "./places";
import { readRestoredSession, saveSession } from "./session";
import { registerSyntaxParsers } from "./syntax";
import { makeDnd72, type DropTarget } from "./dnd72";
import { makeSettingModel } from "./settings-model";
import { makeRename } from "./ui-rename";
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
import { makeTerminal } from "./ui-term";
import { makeSlots, type IconState, type IconSpec } from "./ui-slots";
import { makeEscMenu } from "./ui-settings";
import {
  BAND_ID,
  DRAG_GHOST_ID,
  bandActive,
  beginBand,
  cancelBand,
  finalizeBand,
  finishDragState,
  makeEntryMouseHandlers,
  updateBandRect,
  type BandCtx,
  type ClipItem,
  type GridMenuEntry,
} from "./grid-input";
import { appendLog, debugLog, isDebug, DEBUG_LOG } from "./log";
import { makeMenuEntries, type SortMode } from "./menu-entries";
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
  byId: (id: string) => byId(id),
  clearChildren: (node: any) => clearChildren(node),
  colors: () => colors as Theme & Record<string, any>,
  uiStyle: () => config.ui.uiStyle,
  iconCells: () => ICON_CELLS_H,
  modalOpen: () => escMenu.isOpen(),
  glyphFor,
});

// --- App state & history ---
const home = os.homedir();

type AppState = {
  cwd: string;
  history: string[];
  histIdx: number;
  showHidden: boolean;
  sortBy: SortMode;
  sortAsc: boolean;
};

const state: AppState = {
  cwd: process.cwd(),
  history: [process.cwd()],
  histIdx: 0,
  showHidden: config.ui.showHidden,
  sortBy: "name",
  sortAsc: true,
};

let renderAll: () => void = () => {};

// --- Tabs: `state` is always the ACTIVE tab's view; switching copies the
// live history refs into the outgoing tab slot and adopts the incoming one.
// Model lives in ./tabs (pure, tested) — rendering/session I/O stay here. ---
const tabModel = makeTabs(state, {
  onChanged: () => renderAll(),
  status: (msg) => setStatusMsg(msg),
  quit: () => quitApp(),
});
const { switchTab, newTab, closeTab, syncTabFromState, adoptTab } = tabModel;

const scheduleSaveSession = debounced(400, () => {
  syncTabFromState();
  if (isVirtualCwd()) return;
  void saveSession(state.cwd, tabModel.list, tabModel.active).catch(() => {});
});

const restoreSession = (): void => {
  // off by default: launching tfm from a shell should open where you are;
  // opt in via [ui] restore-session = true
  if (!config.ui.restoreSession) return;
  const restored = readRestoredSession();
  if (restored) {
    tabModel.adoptTabs(restored.tabs, restored.activeTab);
  } else {
    adoptTab();
  }
};

const canBack = () => state.histIdx > 0;
const canFwd = () => state.histIdx < state.history.length - 1;

const goBack = () => { if (canBack()) { state.histIdx--; renderAll(); } };
const goFwd = () => { if (canFwd()) { state.histIdx++; renderAll(); } };

const navigate = (dir: string) => {
  debugLog(`navigate -> ${dir}`);
  exitPathEdit();
  if (fileMenuIsOpen()) closeFileMenu();
  if (dir === RECENT_URI || dir === STARRED_URI) {
    if (dir === state.cwd) { renderAll(); return; }
    state.history = state.history.slice(0, state.histIdx + 1);
    state.history.push(dir);
    state.histIdx++;
    clearSearch();
    renderAll();
    return;
  }
  let target: string;
  try {
    target = path.resolve(dir);
    if (!statSync(target).isDirectory()) return;
  } catch {
    return;
  }
  if (target === path.resolve(state.cwd)) { renderAll(); return; }
  state.history = state.history.slice(0, state.histIdx + 1);
  state.history.push(target);
  state.histIdx++;
  clearSearch();
  renderAll();
};

let searchQuery = "";

const clearSearch = () => {
  searchQuery = "";
  try {
    const el: any = byId("tfm-search");
    if (el) { el.value = ""; el.visible = false; }
  } catch {}
};

// nautilus-style type-to-search: a printable char with the grid focused opens
// the search box seeded with that char instead of doing legacy jump-ahead
const beginTypeToSearch = (ch: string): void => {
  if (termHasFocus()) return; // shell owns the keyboard — never hijack into search
  const el: any = byId("tfm-search");
  if (!el) return;
  el.visible = true;
  el.value = ch;
  searchQuery = ch;
  void renderGrid();
  setTimeout(() => { try { el.focus(); } catch {} }, 10);
};


// --- Places sidebar + tab strip — widget lives in ./ui-chrome ---
// mutable: applyConfig() rewrites these when settings change
let sw = config.ui.sidebarWidth;

const { renderSidebar, renderTabbar, normalizePlaces, makeDivider, placesHost, mountDevice, ejectDevice, setMousePlace, clearMousePlace } = makeChrome({
  byId: (id) => byId(id),
  uiStyle: () => config.ui.uiStyle,
  colors: () => colors as Theme & Record<string, any>,
  sw: () => sw,
  sideInnerW,
  tabBar: () => config.ui.tabBar,
  renderAll: () => renderAll(),
  navigate: (target) => navigate(target),
  blurTerminal: () => blurTerminal(),
  closeFileMenu: () => closeFileMenu(),
  openContextMenu: (x, y, t, e) => openContextMenu(x, y, t, e),
  sidebarEntriesFor: (place, x, y) => sidebarEntriesFor(place, x, y),
  finishDrag: () => finishDragCtx(),
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
  stripSelectable: () => stripSelectable(),
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
  byId: (id: string) => byId(id),
  clearChildren: (node: any) => clearChildren(node),
  stripSelectable: () => stripSelectable(),
  uiStyle: () => config.ui.uiStyle,
  colors: () => colors as Theme & Record<string, any>,
  makeIconSlot,
  setIconState,
  closeFileMenu: () => closeFileMenu(),
  blurTerminal: () => blurTerminal(),
  navigate,
  canBack,
  canFwd,
  goBack,
  goFwd,
  openContextMenu: (x, y, t, entries) => openContextMenu(x, y, t, entries),
  sortEntries: () => sortEntries(),
  cwd: () => state.cwd,
  home,
});

// --- Directory listing ---
// --- Virtual places: Recent (freedesktop recently-used.xbel) & Starred ---
// URI/XDG primitives live in ./uri, the registries in ./recent, the listings
// themselves in ./listing; this wrapper keeps the historic call-signature
// (defaults to the current cwd)
const isVirtualCwd = (p: string = state.cwd): boolean => isVirtualUri(p);

let recordOpenPaths: string[] = [];

// batch opens into one xbel rewrite (opening a selection of N files fires N times)
const flushRecordOpen = debounced(150, () => {
  const paths = [...new Set(recordOpenPaths)];
  recordOpenPaths = [];
  void upsertRecentXbel(paths);
});
const recordOpen = (p: string): void => {
  if (inTrashView()) return;
  recordOpenPaths.push(p);
  flushRecordOpen();
};

const openFileDefault = (p: string): void => {
  recordOpen(p);
  spawn("xdg-open", [p], { stdio: "ignore", detached: true }).unref?.();
  void notifyOpenedWith(p);
};

// resolve what xdg-open will pick so the toast can say what launched —
// probing lives in ./apps (pure, tested)
const notifyOpenedWith = async (p: string): Promise<void> => {
  const base = path.basename(p);
  const app = await appForFile(p);
  notify(`Opening ${base}${app ? ` · ${app}` : ""}`, "open");
};

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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// single seam for the "post-mount only" node lookup: everything here must
// never call this before the renderer mounts, and must tolerate a miss
// (nodes die on every rebuild)
const byId = (id: string): any => {
  try { return renderer.root.findDescendantById(id); } catch { return null; }
};

// set a TEXT node's content by id — ids must live on the Text, not its
// wrapper Box (boxes have no .content, mutating them no-ops)
const setTextOnId = (nodeId: string, s: string): void => {
  const n: any = byId(nodeId);
  if (n) { try { n.content = s; } catch {} }
};

const stripSelectable = (node: any = renderer.root): void => {
  if (!node || node.isDestroyed) return;
  try { if (node.selectable) node.selectable = false; } catch {}
  node.getChildren?.().forEach((c: any) => stripSelectable(c));
};

const waitForResolution = async () => {
  for (let i = 0; i < 40 && !renderer.resolution; i++) await sleep(50);
};

const dialogs = makeDialogs({
  byId,
  rootAdd: (node) => renderer.root.add(node),
  stripSelectable: () => stripSelectable(),
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
  isCutKey: (key) => isCutKey(key),
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
  stripSelectable: () => stripSelectable(),
  renderAll: () => renderAll(),
  renderGrid: () => renderGrid(),
  // arrow wrappers: pushUndoBatch/performRename/setStatusMsg/inTrashView are defined below (TDZ)
  performRename: (p, name) => performRename(p, name),
  pushUndoBatch: (label, undos, redos) => pushUndoBatch(label, undos, redos),
  setStatusMsg: (msg) => setStatusMsg(msg),
  isVirtualCwd: () => isVirtualCwd(),
  inTrashView: () => inTrashView(),
  cwd: () => state.cwd,
  focusKeys: () => selection.focusKeys(),
  selectTileAt,
});

// --- File operations ---
// runTransfer/performRename/paste/clipboard orchestration lives in ./fileops;
// the copy engine is ./transfer (pure, sink-injected), the progress toast
// is ./ui-progress, and cut-tile dimming lives in ./selection (setTileVisual).
const isCutKey = (key: string): boolean => {
  const c = clipboardRef();
  return c?.mode === "cut" && c.items.some((i) => i.path === key);
};

// the reset fires 2500ms after the LAST status message, like a debounce
const clearStatusMsg = debounced(2500, () => updateSelectionStatusReal());
const setStatusMsg = (text: string) => {
  const status: any = byId("tfm-status-label");
  if (status) { try { status.content = text; } catch {} }
  clearStatusMsg();
};

// --- Undo stack + override (conflict) prompt — dialog lives in ./ui-dialogs ---
// undo/redo state machine lives in ./undo (pure, tested) — results surface via sink
const { pushUndoBatch, undoLast, redoLast } = makeUndo({
  status: (msg) => setStatusMsg(msg),
  notify: (message, title) => notify(message, title),
  refresh: () => renderAll(),
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
  stripSelectable: () => stripSelectable(),
  termW: () => renderer.terminalWidth,
  toastCount: () => toastCount(),
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
  renderAll: () => renderAll(),
  setStatusMsg,
  notify: (msg, title) => notify(msg, title),
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
  stripSelectable: () => stripSelectable(),
  drainIconQueue: () => drainIconQueue(),
  notify: (message, title) => notify(message, title),
  renderAll: () => renderAll(),
  cwd: () => state.cwd,
  virtualCwd: () => isVirtualCwd(),
  home,
});

const trashOps = makeTrashOps({
  pushUndoBatch,
  status: (msg) => setStatusMsg(msg),
  notify: (msg, title) => notify(msg, title),
  refresh: () => renderAll(),
  log: (msg) => appendLog(`trashops: ${msg}`),
});
const { trashPaths, restoreFromTrash, deleteForever, emptyTrash } = trashOps;

// --- Trash management: restore / delete-permanently / empty ---
const inTrashView = (): boolean => path.resolve(state.cwd) === path.join(trashDir(), "files");

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

const { notify, toastCount } = makeNotify({
  rootAdd: (node) => renderer.root.add(node),
  remove: (node) => { const p: any = node.parent ?? renderer.root; p.remove(node); },
  byId,
  termW: () => renderer.terminalWidth,
  accentBg: () => colors.accentBg,
  white: () => colors.white,
  sidebarFgMuted: () => colors.sidebarFgMuted,
});

// Rubber-band gesture state + commit logic live in ./grid-input; this is the
// ctx object it renders through (built here because it closes over the live
// selection/preview state below).
const bandCtx: BandCtx = {
  byId: (id: string) => byId(id),
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
  navigate,
  openFileDefault,
  openContextMenu: (x: number, y: number, title: string, entries: GridMenuEntry[]) => openContextMenu(x, y, title, entries as ListEntry[]),
  fileEntriesFor: (key: string, isDir: boolean, x: number, y: number): GridMenuEntry[] => fileEntriesFor(key, isDir, x, y) as GridMenuEntry[],
  closeFileMenu: () => closeFileMenu(),
  renameEditKey,
  finishInlineRename,
  setStatusMsg,
  log: (msg: string) => dlog(msg),
  moveInto,
};
const finishDragCtx = () => finishDragState(gridCtx);

const entryMouseHandlers = makeEntryMouseHandlers(gridCtx);

// --- Grid renderer lives in ./ui-grid (tile/list-row builders, empty and
// restricted states, thumbnail handoff, gen-counter stale guards) ---
const { renderGrid } = makeGridRenderer({
  termW: () => renderer.terminalWidth,
  termH: () => renderer.terminalHeight,
  scroller: () => scroller,
  state,
  searchQuery: () => searchQuery,
  pathEditMode: () => pathEditMode(),
  sw: () => sw,
  tileW: () => TILE_W,
  tileH: () => TILE_H,
  iconCells: () => ICON_CELLS_H,
  uiStyle: () => config.ui.uiStyle,
  colors: () => colors as Theme & Record<string, any>,
  previewEnabled: () => config.ui.previewEnabled,
  previewWidth: () => config.ui.previewWidth,
  viewMode: () => config.ui.viewMode,
  reservedRight: () => (config.ui.previewEnabled ? config.ui.previewWidth : 0),
  cellMetrics,
  makeIconSlot,
  pushThumbJob,
  nextIconId: () => nextIconId(),
  drainIconQueue: () => drainIconQueue(),
  drainThumbs: () => drainThumbs(),
  stripSelectable: () => stripSelectable(),
  selection,
  entryMouseHandlers,
  isCutKey: (key) => isCutKey(key),
  waitForResolution: () => waitForResolution(),
  clearRenameEdit,
});


const { openProperties, closeProps, isOpen: propsIsOpen } = makeProps({
  byId,
  openDialog,
  closeDialog,
  setTextOnId,
  // setOnId is defined further down — defer through a wrapper (TDZ)
  setOnId: (id, fn) => setOnId(id, fn),
  stripSelectable: () => stripSelectable(),
  drainIconQueue: () => drainIconQueue(),
  drainThumbs: () => drainThumbs(),
  pushThumbJob,
  nextIconId,
  escHintBtn,
  closeFileMenu: () => closeFileMenu(),
  openContextMenu: (x, y, title, entries) => openContextMenu(x, y, title, entries),
  renderAll: () => renderAll(),
  setStatusMsg: (msg) => setStatusMsg(msg),
  uiStyle: () => config.ui.uiStyle,
  colors: () => colors as Theme & Record<string, any>,
  home,
  makeIconSlot,
  setIconState,
  fallbackGlyphFor: (name) => glyph[name] ?? glyph.file!,
  cellMetrics,
});
const MENU_W = 36;
// --- File context menu (right-click a tile) — widget lives in ./ui-menu ---
const { closeFileMenu, renderFileMenu, openContextMenu, isFileMenuOpen: fileMenuIsOpen, fileMenuState: getFileMenuState } = makeMenu({
  byId,
  rootAdd: (node) => renderer.root.add(node),
  termW: () => renderer.terminalWidth,
  termH: () => renderer.terminalHeight,
  stripSelectable: () => stripSelectable(),
  drainIconQueue: () => drainIconQueue(),
  uiStyle: () => config.ui.uiStyle,
  colors: () => colors as Theme & Record<string, any>,
  menuW: MENU_W,
  makeIconSlot,
});

// --- Menu entry builders (what the menus contain) live in ./menu-entries;
// the floating menu widget itself lives in ./ui-menu ---
const { sidebarEntriesFor, fileEntriesFor, sortEntries, emptyAreaEntries } = makeMenuEntries({
  closeFileMenu,
  navigate,
  renderAll: () => renderAll(),
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
const quitApp = () => {
  disableDrops();
  // release the shift-capture request made at boot
  try { process.stdout.write("\x1b[>0s"); } catch {}
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
});


const escMenu = makeEscMenu({
  renderer: () => renderer,
  byId,
  clearChildren: (node: any) => clearChildren(node),
  stripSelectable: () => stripSelectable(),
  escHintBtn,
  makeIconSlot,
  drainIconQueue: () => drainIconQueue(),
  setScrim,
  cancelBand: () => cancelBand(bandCtx),
  colors: () => colors as Theme & Record<string, any>,
  uiStyle: () => config.ui.uiStyle,
  menuW: () => MENU_W,
  settingGroups: () => settingGroups(),
  quit: () => quitApp(),
});

// --- Live directory watching: external changes refresh the grid ---
let cwdWatcher: ReturnType<typeof watch> | null = null;
let watchedDir: string | null = null;
// fs events burst in clusters; coalesce them into one grid rebuild
const onCwdChanged = debounced(200, () => {
  // our own create+inline-edit would wipe the editor mid-keystroke
  if (isRenaming()) return;
  if (path.resolve(state.cwd) === watchedDir) void renderGrid();
});

const syncCwdWatcher = (): void => {
  if (isVirtualCwd()) {
    if (cwdWatcher) { try { cwdWatcher.close(); } catch {} cwdWatcher = null; }
    watchedDir = null;
    return;
  }
  const dir = path.resolve(state.cwd);
  if (watchedDir === dir) return;
  watchedDir = dir;
  if (cwdWatcher) { try { cwdWatcher.close(); } catch {} cwdWatcher = null; }
  try {
    cwdWatcher = watch(dir, onCwdChanged);
    cwdWatcher.on("error", () => {});
  } catch {}
};

// --- Orchestration ---
renderAll = () => {
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
  await waitForResolution();
  scroller = new ScrollBoxRenderable(renderer, {
    id: "tfm-scroll",
    flexGrow: 1,
    width: "100%",
    scrollY: true,
    viewportCulling: true,
    contentOptions: { flexDirection: "column" },
    onMouseDown: (ev: any) => {
      closeFileMenu();
      clearSearch();
      blurTerminal();
      if (pathEditMode()) { exitPathEdit(); return; }
      if (isRenaming()) finishInlineRename(false);
      clearTileSelection();
      // band shows only once a drag actually moves the pointer
      beginBand(ev);
      if (ev.button === 2) openContextMenu(ev.x, ev.y, "", emptyAreaEntries(ev.x, ev.y));
    },
    onMouseDrag: (ev: any) => updateBandRect(bandCtx, ev),
    onMouseDragEnd: (ev: any) => finalizeBand(bandCtx, ev),
    onMouseUp: (ev: any) => { if (bandActive()) finalizeBand(bandCtx, ev); },
  });
  const host: any = byId("tfm-grid-host");
  host.add(scroller);
  renderer.root.add(Box({
    id: BAND_ID,
    visible: false,
    position: "absolute",
    zIndex: 2500,
    border: true,
    borderStyle: "rounded",
    borderColor: colors.accent,
  }));
  renderer.root.add(Box({
    id: DRAG_GHOST_ID,
    visible: false,
    position: "absolute",
    left: 0,
    top: 0,
    width: 12,
    height: 1,
    zIndex: 4000,
    backgroundColor: colors.accent,
    flexDirection: "row",
    paddingLeft: 1,
  }, Text({ id: `${DRAG_GHOST_ID}-label`, content: "moving 0 items", fg: colors.bg })));

  await loadGlobs2();
  restoreSession();
  await loadSystemPlaces();
  renderAll();

  if (isDebug) {
    debugLog(`terminal ${renderer.terminalWidth}x${renderer.terminalHeight} cwd=${process.cwd()} config=${configPath()}`);
    setStatusMsg(`debug: ${DEBUG_LOG}`);
  }

  const inputEl: any = byId("tfm-search");
  if (inputEl?.on) {
    const renderSearchResults = debounced(150, () => void renderGrid());
    inputEl.on("input", () => {
      try { searchQuery = String(inputEl.value ?? ""); } catch {}
      renderSearchResults();
    });
    // enter/escape semantics live in the global key handler (enter commits
    // into the first match; escape cancels) — no listener here by design
  }
};
boot();

// --- Config application & persistence: lives in ./ui-retheme (rethemeChrome,
// applyConfig, scheduleSaveConfig, live reload). Geometry lets stay here and
// are rewritten through the ctx setters — never bake them into consts. ---
const setOnId = (id: string, fn: (n: any) => void): void => {
  const n: any = byId(id);
  if (!n) return;
  try { fn(n); } catch {}
};

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
  renderAll: () => renderAll(),
  clearIconCaches,
  resetIconQueue: () => resetIconQueue(),
  syncTerminalTheme,
  repaintButtons,
  renderCrumbs,
  refreshNav,
  escMenu,
  fileMenuIsOpen: () => fileMenuIsOpen(),
  renderFileMenu,
  setStatusMsg,
});

const DND_LOG = "/tmp/tfm-dnd.log";
const dlog = (msg: string): void => {
  try { appendFileSync(DND_LOG, `${new Date().toISOString()} ${msg}\n`); } catch {}
  if (isDebug) appendLog(`[dnd] ${msg}`);
};

// --- OSC 72 (kitty drag-and-drop): wire format per yazi's reference impl;
// the state machine (outgoing drags, incoming drops, self-drop routing) lives
// in ./dnd72, the byte-exact frames in ./osc72. Only the renderer-coupled
// hooks stay here: cell hit-testing, tile highlight and place hover. ---
const { enableDrops, disableDrops } = makeDnd72({
  log: (msg) => dlog(msg),
  writeFrame: (s) => { try { process.stdout.write(s); } catch {} },
  hitTargetAt: (x, y, dragPaths): DropTarget | null => {
    try {
      const num = renderer.hitTest(x, y);
      if (!num) return null;
      let cur: any = (Renderable as any).renderablesByNumber?.get(num);
      while (cur) {
        const id: unknown = cur.id;
        if (typeof id === "string") {
          if (id.startsWith("tfm-place-")) {
            const rec = placesHost[parseInt(id.slice(10), 10)];
            return rec?.place.path ? { kind: "place", path: rec.place.path } : null;
          }
          if (id.startsWith("tfm-tile-")) {
            for (const [k, r] of tileRefsByKey) {
              if (r.tileId === id) {
                if (!r.isDir) return null;
                if (dragPaths?.includes(k)) return null; // dropping onto itself
                return { kind: "folder", path: k };
              }
            }
          }
        }
        cur = cur.parent;
      }
    } catch {}
    return null;
  },
  tileRefs: tileRefsByKey,
  setTileVisual,
  hoverPlace: (p) => {
    const idx = placesHost.findIndex((pl) => pl.place.path === p);
    if (idx >= 0) setMousePlace(idx);
  },
  clearHoverPlace: () => clearMousePlace(),
  finishDrag: () => finishDragCtx(),
  escMenuOpen: () => escMenu.isOpen(),
  fileMenuOpen: () => fileMenuIsOpen(),
  trashPaths,
  moveInto,
  runTransfer,
  cwd: () => state.cwd,
  virtualCwd: () => isVirtualCwd(),
  home,
  setStatusMsg,
  notify: (msg, title) => notify(msg, title),
  subscribeOsc: (cb) => renderer.subscribeOsc(cb),
});
enableDrops();
// XTSHIFTESCAPE=1 (CSI > Ps s): ask the terminal (kitty, ghostty, xterm) to
// forward shift+click instead of using it for native text selection.
// Terminals that don't know the sequence ignore it; alt+click is the fallback.
try { dlog("tx xtshiftescape on"); process.stdout.write("\x1b[>1s"); } catch {}

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
  quit: () => quitApp(),
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
  searchQuery: () => searchQuery,
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
