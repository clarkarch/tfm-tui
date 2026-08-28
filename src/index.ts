import { ASCIIFont, Box, CliRenderEvents, Input, InputRenderable, RGBA, Renderable, ScrollBoxRenderable, Text, createCliRenderer } from "@opentui/core";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, createWriteStream, existsSync, statSync, watch } from "node:fs";
import { readdir, readFile, stat, lstat, readlink, symlink, rename as fsRename, mkdir, writeFile, cp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadConfig, configPath, saveConfig, defaultConfig, type Config, type Theme } from "./config";
import { THEME_PRESETS, type ThemePreset } from "./themes";
import { applySurface, btnSurface, chromeSurface, rowSurface, slotBg, tileSurface } from "./style";
import { bumpHex } from "./color";
import { clearIconCaches, warmEmbeddedIcons } from "./icons";
import { FILE_ICON_BY_EXT, fileIconFor, fileIsImage, loadGlobs2, mimeCategory } from "./filetype";
import { RECENT_URI, STARRED_URI, isVirtualUri } from "./uri";
import {
  readRecentXbel,
  readStarredList,
  upsertRecentXbel,
  writeStarredList,
} from "./recent";
import { trashDir, fsErrText, fsMove, safeRestoreMove, uniqueTarget, xdgTrashMove } from "./fsutil";
import { copyFileProgress as transferCopyFileProgress, copyTreeProgress as transferCopyTreeProgress, scanTree as transferScanTree, type TransferSink } from "./transfer";
import { loadSystemPlaces, setBookmarked, type Place } from "./places";
import { fmtBytes } from "./propsinfo";
import { readRestoredSession, saveSession } from "./session";
import { registerSyntaxParsers } from "./syntax";
import { applyAdjust, flattenRows, themePresetIdx as settingsThemePresetIdx, type SettingGroup, type SettingRow } from "./settings";
import {
  agreeDragFrame,
  agreeDropFrame,
  dragIconFrame,
  dragOutEnableFrame,
  dropDisableFrame,
  dropInEnableFrame,
  dropPayloadToPaths,
  finishDropFrame,
  parseOsc72Meta,
  presentDragFrames,
  selfDropRejectFrame,
  startDragFrame,
  startDropFrame,
  uriListPayload,
} from "./osc72";
import { makeTrashOps } from "./trashops";
import { makeUndo, type UndoUnit } from "./undo";
import { makeTabs } from "./tabs";
import { appForFile } from "./apps";
import { publishPathsToSystemClipboard, readCopiedFilesFromSystemClipboard } from "./clipboard";
import { clearChildren as uiutilClearChildren, debounced as uiutilDebounced, safeRenderStep as uiutilSafeRenderStep } from "./uiutil";
import { animateLeft, makeNotify } from "./notify";
import { makeChrome } from "./ui-chrome";
import { makeDialogs, makeConflict } from "./ui-dialogs";
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
  gridDrag,
  makeEntryMouseHandlers,
  updateBandRect,
  type BandCtx,
  type ClipItem,
  type GridMenuEntry,
} from "./grid-input";
import { appendLog, debugLog, isDebug, DEBUG_LOG } from "./log";
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
  pathEditMode = false;
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
  kbActive: () => sidebarActive,
  kbIdx: () => placeIdx,
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

// --- Toolbar ---

const navSpecs: Record<"tfm-nav-back" | "tfm-nav-fwd", IconSpec | undefined> = {
  "tfm-nav-back": undefined,
  "tfm-nav-fwd": undefined,
};

// nav icons carry 4 rasters: enabled/disabled × normal/hover (bg baked into
// the png, so the wrapper box bg must swap in lockstep)
let navHover: Record<string, boolean> = {};
const navBtnBg = (id: string) => {
  try {
    const n: any = byId(id);
    if (n) applySurface(n, btnSurface(config.ui.uiStyle, colors, !!navHover[id]));
  } catch {}
};

const makeNavButton = (id: "tfm-nav-back" | "tfm-nav-fwd", iconName: string, onActivate: () => void) => {
  const states = (): IconState[] => [
    { fg: colors.sidebarFg, bg: colors.bg },
    { fg: colors.sidebarFgMuted, bg: colors.bg },
    { fg: colors.sidebarFg, bg: colors.hoverBg },
    { fg: colors.sidebarFgMuted, bg: colors.hoverBg },
  ];
  const slot = makeIconSlot(iconName, states(), 1, 0, undefined, states);
  navSpecs[id] = slot.spec;
  return Box(
    {
      id,
      height: 1,
      width: 3,
      justifyContent: "center",
      ...btnSurface(config.ui.uiStyle, colors, false),
      onMouseDown: () => { closeFileMenu(); onActivate(); },
      onMouseOver: () => { navHover[id] = true; refreshNav(); },
      onMouseOut: () => { navHover[id] = false; refreshNav(); },
    },
    slot.el,
  );
};

const refreshNav = () => {
  const setBtn = (id: string, spec: IconSpec | undefined, on: boolean) => {
    if (!spec) return;
    setIconState(spec, (on ? 0 : 1) + (navHover[id] ? 2 : 0));
    navBtnBg(id);
  };
  setBtn("tfm-nav-back", navSpecs["tfm-nav-back"], canBack());
  setBtn("tfm-nav-fwd", navSpecs["tfm-nav-fwd"], canFwd());
};

const crumbSep = () => Text({ content: " › ", fg: colors.sidebarFgMuted });

let pathEditMode = false;
let crumbClickAt = 0;

const exitPathEdit = () => {
  if (!pathEditMode) return;
  pathEditMode = false;
  renderCrumbs();
};

const enterPathEdit = () => {
  if (pathEditMode) return;
  blurTerminal();
  pathEditMode = true;
  renderCrumbs();
};

const renderCrumbs = () => {
  const box: any = byId("tfm-crumbs");
  if (!box) return;

  const toolbarRow: any = byId("tfm-toolbar");

  if (pathEditMode) {
    clearChildren(box);
    let input: any = byId("tfm-path-input");
    if (!input) {
      // real class instance: proxied composition nodes don't mount under an
      // already-mounted parent
      input = new InputRenderable(renderer, {
        id: "tfm-path-input",
        flexGrow: 1,
        value: isVirtualCwd() ? state.cwd : path.resolve(state.cwd),
        backgroundColor: colors.accentBg,
        focusedBackgroundColor: colors.accentBg,
        textColor: colors.white,
      });
      box.add(input);
      input.on?.("enter", () => {
        const target = String((input as any).value ?? "").replace(/^~(?=\/|$)/, home);
        pathEditMode = false;
        renderCrumbs();
        navigate(target);
      });
      // focused editors can consume keys before the global handler; intercept
      // escape at the source so it always cancels
      const prevHandler = input.handleKeyPress?.bind(input);
      input.handleKeyPress = (key: any) => {
        if (key?.name === "escape") {
          exitPathEdit();
          return true;
        }
        return prevHandler ? prevHandler(key) : false;
      };
    } else {
      try { input.value = isVirtualCwd() ? state.cwd : path.resolve(state.cwd); } catch {}
    }
    try { input.visible = true; } catch {}
    setTimeout(() => { try { input.focus(); } catch {} }, 20);
    stripSelectable();
    return;
  }

  // rebuild crumbs from scratch — appending would duplicate them every nav
  clearChildren(box);

  const cwdAbs = path.resolve(state.cwd);
  const virtCrumb = state.cwd === RECENT_URI
    ? { label: "Recent", icon: "clock" }
    : state.cwd === STARRED_URI
    ? { label: "Starred", icon: "star" }
    : null;
  const inHome = !virtCrumb && (cwdAbs === home || cwdAbs.startsWith(home + path.sep));
  const baseLabel = virtCrumb ? virtCrumb.label : inHome ? "Home" : os.hostname();
  const baseIcon = virtCrumb ? virtCrumb.icon! : inHome ? "home" : "desktop-tower";
  const basePath = virtCrumb ? state.cwd : inHome ? home : "/";
  const rest = virtCrumb ? [] : path.relative(inHome ? home : "/", cwdAbs).split(path.sep).filter(Boolean);

  const crumbs: { label: string; icon?: string; target: string }[] = [
    { label: baseLabel, icon: baseIcon, target: basePath },
    ...rest.map((seg, i) => ({ label: seg, target: path.join(basePath, ...rest.slice(0, i + 1)) })),
  ];

  crumbs.forEach((c, i) => {
    const current = i === crumbs.length - 1;
    const fg = current ? colors.white : colors.sidebarFgMuted;
    // clickable crumbs get hover feedback: baked raster swap + box bg swap
    const iconStates = current
      ? [{ fg, bg: colors.bg }]
      : [
          { fg, bg: colors.bg },
          { fg: colors.white, bg: colors.hoverBg },
        ];
    const iconSlot = c.icon ? makeIconSlot(c.icon, iconStates, 1) : null;
    const paintHover = (on: boolean) => {
      if (iconSlot && !current) setIconState(iconSlot.spec, on ? 1 : 0);
      try {
        const n: any = byId(`tfm-crumb-${i}`);
        if (n) applySurface(n, btnSurface(config.ui.uiStyle, colors, on && !current));
      } catch {}
    };
    const crumb = Box(
      {
        id: `tfm-crumb-${i}`,
        height: 1,
        flexDirection: "row",
        alignItems: "center",
        columnGap: 1,
        ...btnSurface(config.ui.uiStyle, colors, false),
        ...(current
          ? {}
          : {
              onMouseDown: () => navigate(c.target),
              onMouseOver: () => paintHover(true),
              onMouseOut: () => paintHover(false),
            }),
      },
      ...(iconSlot ? [iconSlot.el] : []),
      Text({ content: c.label, fg }),
    );
    box.add(crumb);
    if (i < crumbs.length - 1) box.add(crumbSep());
  });
};

// toolbar buttons swap between two baked rasters (normal/hover bg) and match
// the wrapper box bg so the padding cells track the raster
const hoverBtnStates = (): IconState[] => [
  { fg: colors.sidebarFg, bg: colors.bg },
  { fg: colors.sidebarFg, bg: colors.hoverBg },
];
const hoverBtn = (
  id: string,
  iconName: string,
  onMouseDown: (ev: any) => void,
): ReturnType<typeof Box> => {
  const states = hoverBtnStates;
  const slot = makeIconSlot(iconName, states(), 1, 0, undefined, states);
  const paint = (on: boolean) => {
    setIconState(slot.spec, on ? 1 : 0);
    try {
      const n: any = byId(id);
      if (n) applySurface(n, btnSurface(config.ui.uiStyle, colors, on));
    } catch {}
  };
  return Box(
    {
      id,
      height: 1,
      width: 3,
      justifyContent: "center",
      ...btnSurface(config.ui.uiStyle, colors, false),
      onMouseDown,
      onMouseOver: () => paint(true),
      onMouseOut: () => paint(false),
    },
    slot.el,
  );
};

const makeSearch = () => {
  const wrap = Box({ id: "tfm-search-wrap", height: 1, flexDirection: "row" });

  const input = Input({
    id: "tfm-search",
    width: 16,
    visible: false,
    placeholder: "Search",
    backgroundColor: colors.accentBg,
    focusedBackgroundColor: colors.accentBg,
    textColor: colors.white,
  });

  wrap.add(
    hoverBtn("tfm-search-btn", "search", () => {
      closeFileMenu();
      blurTerminal();
      const el: any = byId("tfm-search");
      if (!el) return;
      el.visible = !el.visible;
      if (el.visible) el.focus();
    }),
  );
  wrap.add(input);
  return wrap;
};

const makeSortButton = (): ReturnType<typeof Box> =>
  hoverBtn("tfm-sort-btn", "sort", (ev: any) => {
    closeFileMenu();
    openContextMenu(ev.x, ev.y, "", sortEntries());
  });

const makeToolbarShell = (): ReturnType<typeof Box> =>
  Box(
    { id: "tfm-toolbar", width: "100%", height: 1, flexDirection: "row", paddingLeft: 1, paddingRight: 1, columnGap: 1 },
    Box(
      { height: 1, flexGrow: 1, flexBasis: 0, overflow: "hidden", flexDirection: "row", columnGap: 1 },
      makeNavButton("tfm-nav-back", "chevron-left", goBack),
      makeNavButton("tfm-nav-fwd", "chevron-right", goFwd),
      Box({
        id: "tfm-crumbs",
        flexGrow: 1,
        flexBasis: 0,
        height: 1,
        flexDirection: "row",
        columnGap: 1,
        overflow: "hidden",
        onMouseDown: () => {
          const now = Date.now();
          if (pathEditMode) return;
          closeFileMenu();
          if (now - crumbClickAt < 350) {
            crumbClickAt = 0;
            enterPathEdit();
          } else {
            crumbClickAt = now;
          }
        },
      }),
    ),
    makeSortButton(),
    makeSearch(),
  );

// --- Directory listing ---
type SortMode = "name" | "size" | "mtime" | "type";
type Entry = { name: string; isDir: boolean; size?: number; mtimeMs?: number; abs?: string };

// --- Virtual places: Recent (freedesktop recently-used.xbel) & Starred ---
// URI/XDG primitives live in ./uri, the registries in ./recent; this wrapper
// keeps the historic call-signature (defaults to the current cwd)
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

const recentEntries = async (): Promise<Entry[]> => {
  const out: Entry[] = [];
  for (const it of readRecentXbel()) {
    let st: any = null;
    try { st = statSync(it.path); } catch { continue; } // drop vanished files
    out.push({ name: path.basename(it.path), isDir: st.isDirectory(), abs: it.path, size: st.size, mtimeMs: it.modified });
  }
  return out;
};

const starredEntries = async (): Promise<Entry[]> => {
  const out: Entry[] = [];
  for (const p of readStarredList()) {
    let st: any = null;
    try { st = statSync(p); } catch { continue; }
    out.push({ name: path.basename(p), isDir: st.isDirectory(), abs: p, size: st.size, mtimeMs: st.mtimeMs ?? 0 });
  }
  return out;
};

async function listDir(dir: string, showHidden: boolean): Promise<Entry[]> {
  let out: Entry[];
  if (dir === RECENT_URI) {
    out = await recentEntries();
    // recency order wins over the global sort mode, like nautilus
    return out.sort((a, b) => (b.mtimeMs ?? 0) - (a.mtimeMs ?? 0));
  }
  if (dir === STARRED_URI) out = await starredEntries();
  else {
  const dirents = await readdir(dir, { withFileTypes: true });
  out = [];
  for (const d of dirents) {
    if (!showHidden && d.name.startsWith(".")) continue;
    let isDir = d.isDirectory();
    // a symlink is a folder only if its target is one — never follow it further
    if (d.isSymbolicLink()) {
      try { isDir = (await stat(path.join(dir, d.name))).isDirectory(); } catch { isDir = false; }
    }
    out.push({ name: d.name, isDir });
  }
  }
  if (state.sortBy === "size" || state.sortBy === "mtime") {
    for (const e of out) {
      try { const st = statSync(e.abs ?? path.join(dir, e.name)); e.size = st.size; e.mtimeMs = st.mtimeMs ?? 0; } catch {}
    }
  }
  const extOf = (n: string): string => {
    const b = n.startsWith(".") ? n.slice(1) : n;
    const i = b.lastIndexOf(".");
    return i > 0 ? b.slice(i + 1).toLowerCase() : "";
  };
  const cmp = (a: Entry, b: Entry): number => {
    switch (state.sortBy) {
      case "size": return (a.size ?? 0) - (b.size ?? 0);
      case "mtime": return (a.mtimeMs ?? 0) - (b.mtimeMs ?? 0);
      case "type": return extOf(a.name).localeCompare(extOf(b.name)) || a.name.localeCompare(b.name);
      default: return a.name.localeCompare(b.name);
    }
  };
  return out.sort((a, b) => Number(b.isDir) - Number(a.isDir) || (state.sortAsc ? cmp(a, b) : -cmp(a, b)));
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
let gridGen = 0;
let tileSeq = 0;

// keyboard focus over tiles
let focusKeys: string[] = [];
let focusIdx = -1;
let colsAtBuild = 1;
// per-row height of the last build (TILE_H for grid, 1 for list) — keyboard
// scrolling uses it to page by the right amount in either view mode
let rowHAtBuild = config.ui.tileHeight;
// anchor tile for shift+click range selection (index into focusKeys)
let selAnchor: number | null = null;

const selectRange = (from: number, to: number): void => {
  clearTileSelection();
  if (focusKeys.length === 0) return;
  const lo = Math.max(0, Math.min(from, to));
  const hi = Math.min(focusKeys.length - 1, Math.max(from, to));
  for (let i = lo; i <= hi; i++) {
    const k = focusKeys[i]!;
    const r = tileRefsByKey.get(k);
    if (r) { r.selected = true; setTileVisual(k, 2); }
  }
};

// sidebar keyboard focus
let sidebarActive = false;
let placeIdx = -1;

const setSidebarFocus = (idx: number): boolean => {
  if (idx < 0 || idx >= placesHost.length) return false;
  placeIdx = idx;
  normalizePlaces();
  return true;
};

const leaveSidebarToGrid = () => {
  sidebarActive = false;
  normalizePlaces();
};

// arrows and clicks drive the SAME single selection; there is no separate
// focus highlight
const selectTileAt = (idx: number): boolean => {
  if (idx < 0 || idx >= focusKeys.length) return false;
  clearTileSelection();
  const key = focusKeys[idx]!;
  const refs = tileRefsByKey.get(key);
  if (refs) { refs.selected = true; setTileVisual(key, 2); }
  focusIdx = idx;
  void renderPreview();
  if (scroller) {
    try {
      const row = Math.floor(idx / colsAtBuild);
      const vh = renderer.terminalHeight - 3;
      const top = scroller.scrollTop;
      if (row * rowHAtBuild < top) scroller.scrollTo({ x: 0, y: row * rowHAtBuild });
      else if ((row + 1) * rowHAtBuild > top + vh) scroller.scrollTo({ x: 0, y: (row + 1) * rowHAtBuild - vh });
    } catch {}
  }
  return true;
};
const moveFocus = (dx: number, dy: number): boolean => {
  if (focusKeys.length === 0) return false;
  let next = focusIdx === -1 ? 0 : focusIdx + dx + dy * colsAtBuild;
  next = Math.max(0, Math.min(focusKeys.length - 1, next));
  if (next === focusIdx) return false;
  return selectTileAt(next);
};

type TileRefs = { iconSpec?: IconSpec; iconSlotId?: string; selected: boolean; baseFg: string; tileId: string; labelId: string; isDir: boolean };
const tileRefsByKey = new Map<string, TileRefs>();

const tileStates = (dim: boolean): IconState[] => {
  const norm = dim ? colors.sidebarFgMuted : colors.sidebarFg;
  return [
    { fg: norm, bg: colors.bg },
    { fg: norm, bg: colors.hoverBg },
    { fg: colors.accent, bg: colors.accentBg },
    { fg: colors.sidebarFgMuted, bg: colors.bg }, // 3 = cut (pending move)
  ];
};

const setTileVisual = (key: string, mode: 0 | 1 | 2) => {
  const refs = tileRefsByKey.get(key);
  if (!refs) return;
  const cut = mode === 0 && !refs.selected && isCutKey(key);
  setIconState(refs.iconSpec, cut ? 3 : mode);
  if (!refs.iconSpec) {
    // thumbnail slots have no state rasters — fade the whole slot instead
    try {
      const slot: any = byId(refs.iconSlotId ?? "");
      if (slot) slot.opacity = cut ? 0.45 : 1;
    } catch {}
  }
  const labelReal: any = byId(refs.labelId);
  if (labelReal) {
    try { labelReal.fg = mode === 2 ? colors.accent : cut ? colors.sidebarFgMuted : refs.baseFg; } catch {}
  }
  const tileReal: any = byId(refs.tileId);
  if (tileReal) {
    const state = mode === 2 ? "selected" : mode === 1 ? "hover" : cut ? "cut" : "rest";
    applySurface(tileReal, tileSurface(config.ui.uiStyle, colors, state));
  }
};

// --- inline rename: edit the tile label in place instead of a modal ---
let renameEdit: { key: string; inputId: string; createKind?: "file" | "folder" } | null = null;

const tileLabelFor = (name: string): string =>
  name.length > TILE_W - 2 ? name.slice(0, TILE_W - 5) + "…" : name;

// restores the plain label node; commit=true runs performRename afterwards
const finishInlineRename = (commit: boolean): void => {
  const edit = renameEdit;
  if (!edit) return;
  renameEdit = null;
  const input: any = byId(edit.inputId);
  const value = String(input?.value ?? "").trim();
  if (input) { try { input.parent?.remove(input); } catch {} }
  const refs = tileRefsByKey.get(edit.key);
  const tile: any = refs ? byId(refs.tileId) : null;
  if (refs && tile && !byId(refs.labelId)) {
    const labelText: any = Text({ id: refs.labelId, content: tileLabelFor(path.basename(edit.key)), fg: refs.baseFg });
    tile.add(labelText);
  }
  stripSelectable();
  if (!commit || !value) {
    if (edit.createKind) void rm(edit.key, { recursive: true }).then(() => renderAll());
    return;
  }
  if (value !== path.basename(edit.key)) {
    // create-unit is pushed BEFORE performRename so undo pops rename-back
    // first, then removes the entry entirely
    if (edit.createKind) {
      const k = edit.key;
      const redoCreate: UndoUnit = edit.createKind === "folder"
        ? async () => { try { if (!existsSync(k)) await mkdir(k, { recursive: true }); } catch {} }
        : async () => { try { if (!existsSync(k)) await writeFile(k, ""); } catch {} };
      pushUndoBatch(edit.createKind === "folder" ? "new folder" : "new file", [() => rm(k, { recursive: true })], [redoCreate]);
    }
    void performRename(edit.key, value);
    return;
  }
  if (edit.createKind) {
    const k = edit.key;
    const redoCreate: UndoUnit = edit.createKind === "folder"
      ? async () => { try { if (!existsSync(k)) await mkdir(k, { recursive: true }); } catch {} }
      : async () => { try { if (!existsSync(k)) await writeFile(k, ""); } catch {} };
    pushUndoBatch(edit.createKind === "folder" ? "new folder" : "new file", [() => rm(k, { recursive: true })], [redoCreate]);
    setStatusMsg(`Created ${value} · ctrl+z to undo`);
  }
};

const startInlineRename = (key: string): void => {
  if (renameEdit) finishInlineRename(false);
  const refs = tileRefsByKey.get(key);
  if (!refs) return;
  const tile: any = byId(refs.tileId);
  const label: any = byId(refs.labelId);
  if (!tile || !label || !existsSync(key)) return;
  // real class instance — mounts into the already-mounted tile
  const inputId = `tfm-rename-input`;
  const stale = byId(inputId);
  if (stale) { try { (stale as any).parent?.remove(stale); } catch {} }
  const input: any = new InputRenderable(renderer, {
    id: inputId,
    width: TILE_W - 2,
    value: path.basename(key),
    backgroundColor: colors.hoverBg,
    focusedBackgroundColor: colors.accentBg,
    textColor: colors.white,
  });
  try { tile.insertBefore(input, label); } catch { tile.add(input); }
  try { tile.remove(label); } catch {}
  renameEdit = { key, inputId };
  input.on?.("enter", () => finishInlineRename(true));
  const prevHandler = input.handleKeyPress?.bind(input);
  input.handleKeyPress = (k: any) => {
    if (k?.name === "escape") { finishInlineRename(false); return true; }
    return prevHandler ? prevHandler(k) : false;
  };
  setTimeout(() => { try { input.focus(); } catch {} }, 20);
  stripSelectable();
};

const uniqueUntitledName = (dir: string, base: string): string => {
  const dot = base.lastIndexOf(".");
  const stem = dot > 0 ? base.slice(0, dot) : base;
  const ext = dot > 0 ? base.slice(dot) : "";
  let n = base;
  let i = 2;
  while (existsSync(path.join(dir, n))) n = `${stem} ${i++}${ext}`;
  return n;
};

// nautilus-style: the entry is created immediately with a default name, then
// its label edits in place; esc/empty name deletes it again
const startInlineCreate = (kind: "file" | "folder"): void => {
  if (renameEdit) finishInlineRename(false);
  if (isVirtualCwd() || inTrashView()) return;
  const name = uniqueUntitledName(state.cwd, kind === "folder" ? "Untitled folder" : "Untitled.txt");
  const target = path.join(state.cwd, name);
  const made = kind === "folder"
    ? mkdir(target, { recursive: true })
    : writeFile(target, "");
  void made
    .then(() => renderGrid())
    .then(() => {
      const idx = focusKeys.indexOf(target);
      if (idx >= 0) selectTileAt(idx);
      startInlineRename(target);
    })
    .catch(() => setStatusMsg("Create failed"));
};

let selStatusGen = 0;
const updateSelectionStatusReal = () => {  const gen = ++selStatusGen;
  const sel: { key: string; isDir: boolean }[] = [];
  tileRefsByKey.forEach((r, k) => { if (r.selected) sel.push({ key: k, isDir: r.isDir }); });
  const setStatus = (s: string) => {
    if (gen !== selStatusGen) return;
    const status: any = byId("tfm-status-label");
    if (status) { try { status.content = s; } catch {} }
  };
  if (sel.length === 0) return setStatus("");
  // total size of the selected files (dirs contribute their item count instead)
  let bytes = 0;
  for (const s of sel) {
    if (!s.isDir) { try { bytes += statSync(s.key).size; } catch {} }
  }
  const dirs = sel.filter((s) => s.isDir);
  if (dirs.length === 0) {
    return setStatus(`${sel.length} selected${bytes > 0 ? ` · ${fmtBytes(bytes)}` : ""}`);
  }
  void (async () => {
    let contained = 0;
    await Promise.all(dirs.map(async (d) => {
      try { contained += (await readdir(d.key)).length; } catch {}
    }));
    const bits = [`${sel.length} selected`];
    if (bytes > 0) bits.push(fmtBytes(bytes));
    if (dirs.length === 1 && sel.length === 1) bits.push(`${contained} items`);
    setStatus(bits.join(" · "));
  })();
};

const clearTileSelection = () => {
  tileRefsByKey.forEach((refs, k) => {
    if (refs.selected) { refs.selected = false; setTileVisual(k, 0); }
  });
  updateSelectionStatus();
};

const updateSelectionStatus: () => void = () => updateSelectionStatusReal();

// --- File operations ---
let clipboard: { mode: "copy" | "cut"; items: ClipItem[] } | null = null;

// cut (pending-move) tiles render dimmed, nautilus-style
const isCutKey = (key: string): boolean =>
  clipboard?.mode === "cut" && clipboard.items.some((i) => i.path === key);

// re-apply resting visuals after a cut/copy/paste so dimming tracks the clipboard
const refreshCutVisuals = (): void => {
  tileRefsByKey.forEach((refs, key) => { if (!refs.selected) setTileVisual(key, 0); });
};

// the reset fires 2500ms after the LAST status message, like a debounce
const clearStatusMsg = debounced(2500, () => updateSelectionStatusReal());
const setStatusMsg = (text: string) => {
  const status: any = byId("tfm-status-label");
  if (status) { try { status.content = text; } catch {} }
  clearStatusMsg();
};

const selPaths = (): ClipItem[] => {
  const out: ClipItem[] = [];
  tileRefsByKey.forEach((r, k) => { if (r.selected) out.push({ path: k, isDir: r.isDir }); });
  return out;
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

// wire the copy engine (./transfer) to the live progress state
const transferSink: TransferSink = {
  checkpoint: async () => {
    await pauseGate();
    if (prog.cancelled) throw new Error("cancelled");
  },
  paused: () => prog.paused,
  cancelled: () => prog.cancelled,
  addBytes: (n) => { prog.bytes += n; },
  fileDone: () => { prog.doneFiles++; },
  setStream: (rs) => { prog.currentRs = rs; },
  clearStream: (rs) => { if (prog.currentRs === rs) prog.currentRs = null; },
  repaint: (full) => paintProgress(full),
};

const scanTree = (root: string): Promise<{ files: number; bytes: number }> => transferScanTree(root);
const copyFileProgress = (src: string, dest: string): Promise<void> => transferCopyFileProgress(src, dest, transferSink);
const copyTreeProgress = (src: string, dest: string): Promise<void> => transferCopyTreeProgress(src, dest, transferSink);

// every destructive-but-reversible file op funnels through here so overrides
// are asked once and undo covers the whole batch
async function runTransfer(op: "copy" | "move", destDir: string, srcs: string[], label: string): Promise<void> {
  conflict.resetPolicy();
  const units: UndoUnit[] = [];
  const redos: UndoUnit[] = [];
  let ok = 0, skipped = 0, replaced = 0, failed = 0, gone = 0;
  const failWhy = new Set<string>();
  const total = srcs.length;
  if (op === "copy") {
    // pre-scan so the progress toast has real totals from byte one
    prog.paused = false;
    prog.cancelled = false;
    prog.doneFiles = 0;
    prog.bytes = 0;
    let files = 0, bytes = 0;
    for (const s of srcs) {
      try { const r = await scanTree(s); files += r.files; bytes += r.bytes; } catch {}
    }
    prog.totalFiles = files || Math.max(1, total);
    prog.totalBytes = bytes;
    // tiny transfers don't need a toast
    if (prog.totalBytes > 4 * 1024 * 1024 || prog.totalFiles > 4) {
      prog.active = true;
      showProgressToast();
      paintProgress(true);
    }
  }
  let cancelled = false;
  try {
  for (const src of srcs) {
    if (cancelled || prog.cancelled) { cancelled = true; break; }
    await pauseGate();
    // source vanished since it was copied/cut — report clearly instead of a
    // cryptic mid-transfer ENOENT
    if (!existsSync(src)) { gone++; skipped++; continue; }
    const base = path.basename(src);
    let target = path.join(destDir, base);
    // nautilus semantics: paste-in-place never asks, it just makes "name (copy)"
    if (target === src && op === "copy") { target = uniqueTarget(destDir, base); }
    else if (target === src) { skipped++; continue; }
    else if (existsSync(target)) {
      const done = ok + skipped;
      const choice = conflict.policy() ?? await conflict.promptConflict(target, Math.max(0, total - done - 1));
      if (choice === "skip") { skipped++; continue; }
      if (choice === "keepBoth") target = uniqueTarget(destDir, base);
      else {
        // stash the victim in the trash so ctrl+z can bring it back;
        // re-check first — the target may have vanished while the prompt was up
        try {
          if (existsSync(target)) {
            const victimDest = target;
            const trashLoc = await xdgTrashMove(victimDest);
            units.push(async () => {
              await safeRestoreMove(trashLoc, victimDest);
              try { await rm(path.join(trashDir(), "info", `${path.basename(trashLoc)}.trashinfo`)); } catch {}
            });
            replaced++;
          }
        } catch (err) { failWhy.add(fsErrText(err)); }
      }
    }
    try {
      if (op === "copy") await copyTreeProgress(src, target);
      else await fsMove(src, target);
      const t = target, s = src;
      if (op === "copy") {
        units.push(() => xdgTrashMove(t).then(() => undefined));
        redos.push(async () => { try { if (!existsSync(t)) await copyTreeProgress(src, t); } catch {} });
      } else {
        units.push(() => safeRestoreMove(t, s));
        redos.push(async () => { try { if (existsSync(s) && !existsSync(t)) await fsMove(s, t); } catch {} });
      }
      ok++;
    } catch (err) {
      // don't leave half-copied files behind
      if (op === "copy") { try { await rm(target, { recursive: true }); } catch {} }
      if (prog.cancelled) { cancelled = true; break; }
      failed++;
      failWhy.add(fsErrText(err));
    }
  }
  } finally {
    prog.active = false;
  }
  pushUndoBatch(label, units, redos);
  renderAll();
  const verb = op === "copy" ? "Copied" : "Moved";
  const bits = [`${verb} ${ok} item${ok === 1 ? "" : "s"}`];
  if (replaced) bits.push(`${replaced} replaced`);
  if (skipped) bits.push(`${skipped} skipped`);
  if (gone) bits.push(`${gone} source gone`);
  const why = [...failWhy][0];
  if (failed) bits.push(`${failed} FAILED${why ? ` (${why})` : ""}`);
  if (ok || replaced) bits.push("ctrl+z to undo");
  const summary = bits.join(" · ");
  setStatusMsg(summary);
  // always surface the outcome — success, failure, or cancel
  if (prog.toastUp) {
    finishProgressToast(cancelled ? `✗ ${verb} cancelled` : failed ? `✗ ${op} failed` : `✓ ${verb} ${ok}`);
  }
  const destLabel = `to ~/${path.relative(home, destDir) || "/"}`;
  const msg = `${summary}${!cancelled && !failed && ok + replaced > 0 ? ` ${destLabel}` : ""}`;
  if (cancelled) notify(msg, `${op} cancelled`);
  else if (failed > 0 && ok === 0) notify(msg, `${op} failed`);
  else notify(msg, op);
}

// rename with nautilus-style collision handling: rename() would otherwise
// silently overwrite the existing file
const performRename = async (p: string, v: string): Promise<void> => {
  const dest = path.join(path.dirname(p), v);
  if (path.resolve(dest) === path.resolve(p)) { renderAll(); return; }
  let finalDest = dest;
  const units: UndoUnit[] = [];
  const redos: UndoUnit[] = [];
  if (existsSync(finalDest)) {
    conflict.resetPolicy();
    const choice = await conflict.promptConflict(finalDest, 0);
    if (choice === "skip") return;
    if (choice === "keepBoth") {
      finalDest = uniqueTarget(path.dirname(finalDest), path.basename(finalDest));
    } else {
      try {
        const victim = finalDest;
        const trashLoc = await xdgTrashMove(victim);
        units.push(async () => {
          await safeRestoreMove(trashLoc, victim);
          try { await rm(path.join(trashDir(), "info", `${path.basename(trashLoc)}.trashinfo`)); } catch {}
        });
      } catch {}
    }
  }
  try {
    await fsRename(p, finalDest);
    units.push(() => fsRename(finalDest, p));
    redos.push(async () => { try { if (existsSync(p) && !existsSync(finalDest)) await fsRename(p, finalDest); } catch {} });
    pushUndoBatch("rename", units, redos);
    renderAll();
    setStatusMsg(`Renamed to ${path.basename(finalDest)} · ctrl+z to undo`);
    notify(`Renamed to ${path.basename(finalDest)}`, "rename");
  } catch (err) {
    const summary = `Rename failed (${fsErrText(err)})`;
    setStatusMsg(summary);
    notify(`${path.basename(p)}: ${summary}`, "rename failed");
  }
};

const setClipboard = (mode: "copy" | "cut", items: ClipItem[]) => {
  clipboard = items.length ? { mode, items } : null;
  if (clipboard) toSystemClipboard(mode, items);
  setStatusMsg(clipboard ? `${mode === "cut" ? "Cut" : "Copied"} ${items.length} item${items.length === 1 ? "" : "s"}` : "");
  refreshCutVisuals();
};

// --- system clipboard bridge — lives in ./clipboard (pure, tested). tfm
// publishes plain-text paths so paste-anywhere works; reading accepts
// gnome-copied-files from other apps. ---
const toSystemClipboard = (mode: "copy" | "cut", items: ClipItem[]): void => {
  publishPathsToSystemClipboard(mode, items, dlog);
};

const pasteSmart = (dest: string): void => {
  if (clipboard?.items.length) {
    dlog(`paste: internal clipboard (${clipboard.items.length} items)`);
    void doPaste(dest);
    return;
  }
  void readCopiedFilesFromSystemClipboard(dlog).then((res) => {
    if (res) void runTransfer(res.op === "move" ? "move" : "copy", dest, res.paths, "system-clipboard paste");
  });
};

const doPaste = async (dest: string): Promise<void> => {
  if (!clipboard || clipboard.items.length === 0) return;
  const mode = clipboard.mode === "copy" ? "copy" : "move";
  const srcs = clipboard.items.map((i) => i.path);
  clipboard = null;
  refreshCutVisuals();
  await runTransfer(mode, dest, srcs, mode === "copy" ? "paste" : "paste (move)");
};

const moveInto = async (destDir: string, items: ClipItem[]): Promise<void> => {
  const srcs = items
    .filter((it) => !(it.isDir && (destDir === it.path || destDir.startsWith(it.path + path.sep))))
    .map((it) => it.path);
  dlog(`moveInto dest=${destDir} in=${items.length} out=${srcs.length} dropped=[${items.filter((it) => it.isDir && (destDir === it.path || destDir.startsWith(it.path + path.sep))).map((it) => it.path.split("/").pop()).join(",")}]`);
  await runTransfer("move", destDir, srcs, `move to ${path.basename(destDir) || "/"}`);
};

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
});
const { trashPaths, restoreFromTrash, deleteForever, emptyTrash } = trashOps;

// --- Trash management: restore / delete-permanently / empty ---
const inTrashView = (): boolean => path.resolve(state.cwd) === path.join(trashDir(), "files");

let yesNoOpen = false;

const closeYesNo = (): void => {
  closeDialog("tfm-yesno");
  yesNoOpen = false;
};

// floating Yes/No confirmation dialog (replaces the old context-menu confirms)
const confirmYesNo = (message: string, yesLabel: string, onYes: () => void, danger = false): boolean => {
  if (yesNoOpen || !renderer.resolution) return false;
  yesNoOpen = true;
  const W = MENU_W;
  let bseq = 0;
  const mkBtn = (label: string, fg: string, onPick: () => void): ReturnType<typeof Box> =>
    dialogBtn(`tfm-yesno-b${bseq++}`, label, fg, onPick);
  const yesFg = danger ? colors.ansi1 : colors.accent;
  openDialog({
    id: "tfm-yesno",
    zIndex: 3450,
    width: W,
    rows: () => [
      Box(
        { width: "100%", height: 1, paddingLeft: 1, paddingRight: 1 },
        Text({ content: ` ${message}`.slice(0, W - 2), fg: yesFg }),
      ),
      Box(
        { width: "100%", height: 1, paddingLeft: 1, paddingRight: 1 },
        Text({ content: " " + "~".repeat(W - 2), fg: colors.divider }),
      ),
      Box({ height: 1 }),
      Box(
        { width: "100%", height: 1, flexDirection: "row", columnGap: 1, paddingLeft: 1, paddingRight: 1 },
        mkBtn("[ No ]", colors.sidebarFg, () => closeYesNo()),
        mkBtn(`[ ${yesLabel} ]`, yesFg, () => { closeYesNo(); onYes(); }),
      ),
    ],
    onClose: () => closeYesNo(),
  });
  return true;
};

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
  focusKey: () => (focusIdx >= 0 && focusKeys[focusIdx] ? focusKeys[focusIdx]! : null),
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
  setSelAnchor: (v: number | null) => { selAnchor = v; },
};

const clearGrid = () => {
  if (!scroller) return;
  const content: any = scroller.content;
  clearChildren(content);
  tileRefsByKey.clear();
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
  getSelAnchor: () => selAnchor,
  setSelAnchor: (v: number | null) => { selAnchor = v; },
  getFocusIdx: () => focusIdx,
  selPaths,
  dblClickMs: () => config.ui.doubleClickMs,
  navigate,
  openFileDefault,
  openContextMenu: (x: number, y: number, title: string, entries: GridMenuEntry[]) => openContextMenu(x, y, title, entries as ListEntry[]),
  fileEntriesFor: (key: string, isDir: boolean, x: number, y: number): GridMenuEntry[] => fileEntriesFor(key, isDir, x, y) as GridMenuEntry[],
  closeFileMenu: () => closeFileMenu(),
  renameEditKey: () => renameEdit?.key ?? null,
  finishInlineRename,
  setStatusMsg,
  log: (msg: string) => dlog(msg),
  moveInto,
};
const finishDragCtx = () => finishDragState(gridCtx);

const entryMouseHandlers = makeEntryMouseHandlers(gridCtx);

const renderGrid = async () => {
  if (!scroller) return;
  const gen = ++gridGen;
  // a rebuild destroys the edit input; drop the state with it
  if (renameEdit) renameEdit = null;
  clearGrid();
  const q = searchQuery.trim().toLowerCase();
  let allEntries: Entry[];
  try {
    allEntries = await listDir(state.cwd, state.showHidden || q.length > 0);
  } catch (err) {
    // restricted dir (/root, foreign 000 dirs): say why instead of a blank pane
    if (gen !== gridGen) return;
    await waitForResolution();
    if (gen !== gridGen) return;
    const { aspect } = cellMetrics();
    const iconCells = 8;
    const slotW = Math.max(1, Math.round(aspect * iconCells));
    const paneH = Math.max(8, renderer.terminalHeight - 3);
    scroller.add(Box(
      {
        width: "100%",
        height: paneH,
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: colors.bg,
      },
      makeIconSlot("close", [{ fg: colors.sidebarFgMuted, bg: colors.bg }], iconCells).el,
      Box({ height: 1 }),
      Text({ content: `can't open this folder (${fsErrText(err)})`, fg: colors.sidebarFgMuted }),
      Text({ content: pathEditMode ? "" : "edit the path above to go elsewhere", fg: colors.divider }),
      Box({ width: slotW, height: 0 }),
    ));
    stripSelectable();
    void drainIconQueue();
    return;
  }
  const entries = q ? allEntries.filter((e) => e.name.toLowerCase().includes(q)) : allEntries;
  if (gen !== gridGen) return;

  if (entries.length === 0) {
    await waitForResolution();
    if (gen !== gridGen) return;
    const { aspect } = cellMetrics();
    const iconCells = 8;
    const slotW = Math.max(1, Math.round(aspect * iconCells));
    const paneH = Math.max(8, renderer.terminalHeight - 3);
    const emptyState = Box(
      {
        width: "100%",
        height: paneH,
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: colors.bg,
      },
      makeIconSlot("folder", [{ fg: colors.sidebarFgMuted, bg: colors.bg }], iconCells).el,
      Box({ height: 1 }),
      Text({
        content: q ? "no matches"
          : state.cwd === RECENT_URI ? "no recent files"
          : state.cwd === STARRED_URI ? "nothing starred yet"
          : "this folder is empty",
        fg: colors.sidebarFgMuted,
      }),
    );
    scroller.content.add(emptyState);
    void drainIconQueue();
    return;
  }

  await waitForResolution();
  if (gen !== gridGen) return;
  const { aspect } = cellMetrics();
  const isList = config.ui.viewMode === "list";
  const reservedRight = config.ui.previewEnabled ? config.ui.previewWidth : 0;
  const cols = isList ? 1 : Math.max(1, Math.floor((renderer.terminalWidth - sw - reservedRight - 3) / TILE_W));

  // list view always shows size + modified columns, so fetch whatever stats
  // the active sort mode didn't already populate
  if (isList) {
    for (const en of entries) {
      if (en.size !== undefined && en.mtimeMs !== undefined) continue;
      try {
        const st = statSync(en.abs ?? path.join(state.cwd, en.name));
        en.size = st.size;
        en.mtimeMs = st.mtimeMs ?? 0;
      } catch {}
    }
  }

  const buildTile = (e: Entry, idx: number) => {
    const key = e.abs ?? path.join(state.cwd, e.name);
    const tileId = `tfm-tile-${tileSeq++}`;
    const labelId = `${tileId}-label`;
    const tile = Box({
      id: tileId,
      width: TILE_W,
      height: TILE_H,
      flexDirection: "column",
      alignItems: "center",
      justifyContent: "flex-start",
      ...entryMouseHandlers(e, key, idx),
    });

    const dim = e.name.startsWith(".");
    const baseFg = dim ? colors.sidebarFgMuted : colors.sidebarFg;
    const slotW = Math.max(1, Math.round(aspect * ICON_CELLS_H));

    // image tiles: empty slot until the thumbnail lands (no icon->photo swap);
    // everything else queues its category raster as usual
    const wantsThumb = !e.isDir && fileIsImage(e.name);
    let st: any = null;
    if (wantsThumb) { try { st = statSync(key); } catch {} }
    const useThumb = wantsThumb && st && typeof st.size === "number" && st.size > 0 && st.size <= 26214400;

    let slotId: string;
    let iconSpec: IconSpec | undefined;
    let iconSlotEl: ReturnType<typeof Box>;
    if (useThumb) {
      slotId = nextIconId();
      iconSlotEl = Box({ id: slotId, width: slotW, height: ICON_CELLS_H, flexDirection: "row", justifyContent: "center" });
    } else {
      const s = makeIconSlot(e.isDir ? "folder" : fileIconFor(e.name), tileStates(dim), ICON_CELLS_H, 0);
      slotId = s.slotId;
      iconSpec = s.spec;
      iconSlotEl = s.el;
    }
    const tileBox = Box({ width: slotW, height: ICON_CELLS_H, flexDirection: "row", justifyContent: "center" }, iconSlotEl);
    tile.add(tileBox);

    const label = e.name.length > TILE_W - 2 ? e.name.slice(0, TILE_W - 5) + "…" : e.name;
    const labelText: any = Text({ id: labelId, content: label, fg: baseFg });
    tile.add(labelText);

    tileRefsByKey.set(key, { iconSpec, iconSlotId: slotId, selected: false, baseFg, tileId, labelId, isDir: e.isDir });

    if (useThumb && st) {
        pushThumbJob({
          slotId,
          path: key,
          mtimeMs: st.mtimeMs ?? 0,
          size: st.size,
          wCells: slotW,
          vector: e.name.toLowerCase().endsWith(".svg"),
          fallbackGlyph: glyph[fileIconFor(e.name)] ?? glyph.file!,
        });
    }

    return tile;
  };

  // --- list view rows: icon | name | size | modified, all sharing tile mouse
  // behavior via entryMouseHandlers; ids reuse the tfm-tile- prefix so
  // setTileVisual / band select / rename-in-place work unchanged ---
  const fmtDateShort = (ms?: number): string => {
    if (!ms) return "-";
    const d = new Date(ms);
    const p2 = (n: number) => String(n).padStart(2, "0");
    return d.getFullYear() === new Date().getFullYear()
      ? `${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`
      : `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
  };
  // rough inner width of the file pane; only used to truncate names, rows
  // themselves are 100%-width and flex
  const listW = Math.max(40, renderer.terminalWidth - sw - reservedRight - (config.ui.uiStyle === "outline" ? 6 : 3));
  const buildListRow = (e: Entry, idx: number) => {
    const key = e.abs ?? path.join(state.cwd, e.name);
    const rowId = `tfm-tile-${tileSeq++}`;
    const labelId = `${rowId}-label`;
    const dim = e.name.startsWith(".");
    const baseFg = dim ? colors.sidebarFgMuted : colors.sidebarFg;
    const row = Box({
      id: rowId,
      width: "100%",
      height: 1,
      flexDirection: "row",
      alignItems: "center",
      columnGap: 1,
      paddingLeft: 1,
      paddingRight: 1,
      ...entryMouseHandlers(e, key, idx),
    });
    const iconSlot = makeIconSlot(e.isDir ? "folder" : fileIconFor(e.name), tileStates(dim), 1, 0);
    row.add(iconSlot.el);
    // 28 cells of fixed chrome: 2 padding + 1 icon + 4 gaps + 9 size + 11 date + 1 slack
    const nameMax = Math.max(12, listW - 28);
    const label = e.name.length > nameMax ? e.name.slice(0, nameMax - 1) + "…" : e.name;
    row.add(Text({ id: labelId, content: label, fg: baseFg }));
    row.add(Box({ flexGrow: 1 }));
    row.add(Text({ content: e.isDir ? "" : fmtBytes(e.size ?? 0).padStart(9), fg: colors.sidebarFgMuted }));
    row.add(Text({ content: fmtDateShort(e.mtimeMs), fg: colors.sidebarFgMuted }));
    tileRefsByKey.set(key, { iconSpec: iconSlot.spec, iconSlotId: iconSlot.slotId, selected: false, baseFg, tileId: rowId, labelId, isDir: e.isDir });
    return row;
  };

  let tileIdx = 0;
  if (isList) {
    for (const e of entries) scroller.content.add(buildListRow(e, tileIdx++));
  } else {
    for (let i = 0; i < entries.length; i += cols) {
      const row = Box({ height: TILE_H, flexDirection: "row" });
      for (const e of entries.slice(i, i + cols)) row.add(buildTile(e, tileIdx++));
      scroller.content.add(row);
    }
  }

  // cut (pending-move) tiles render dimmed; apply after mount so id lookups work
  tileRefsByKey.forEach((_, key) => { if (isCutKey(key)) setTileVisual(key, 0); });

  // fresh Text nodes default selectable=true; strip AFTER the async rebuild or
  // the renderer's text-selection drag hijacks file-drag events
  stripSelectable();
  void drainIconQueue();
  void drainThumbs();
  focusKeys = [...tileRefsByKey.keys()];
  focusIdx = -1;
  selAnchor = null;
  colsAtBuild = cols;
  rowHAtBuild = isList ? 1 : TILE_H;
  updateSelectionStatusReal();
};

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

const sidebarEntriesFor = (place: Place, x: number, y: number): ListEntry[] => {
  const target = place.scheme === "recent" ? RECENT_URI
    : place.scheme === "starred" ? STARRED_URI
    : place.path;
  const entries: ListEntry[] = [];
  if (target) {
    entries.push({ icon: "folder", label: "Open", action: () => { closeFileMenu(); navigate(target); } });
    entries.push({ icon: "terminal", label: "Open Terminal Here", action: () => { closeFileMenu(); openTerminalHere(target); } });
    // paste into real places (not virtual views, not the trash)
    if (!place.scheme && target !== path.join(trashDir(), "files")) {
      entries.push({
        icon: "content-paste",
        label: clipboard && clipboard.items.length ? `Paste ${clipboard.items.length} item${clipboard.items.length === 1 ? "" : "s"}` : "Paste",
        action: () => { closeFileMenu(); pasteSmart(target); },
      });
    }
    if (target === path.join(trashDir(), "files")) {
      entries.push({ icon: "trash-can", label: "Empty Trash", action: () => { closeFileMenu(); confirmEmptyTrash(); } });
    } else if (place.bookmarked) {
      entries.push({ icon: "bookmark", label: "Remove bookmark", action: () => {
        closeFileMenu();
        void setBookmarked(target, false).then(() => loadSystemPlaces()).then(() => renderAll());
      } });
    }
  }
  if (place.ejectable && place.device) {
    entries.push({ icon: "eject", label: "Eject", action: () => { closeFileMenu(); ejectDevice(place.device!); } });
  }
  if (!target && place.mountDevice) {
    entries.push({ icon: "usb", label: "Mount", action: () => { closeFileMenu(); mountDevice(place.mountDevice!); } });
  }
  return entries;
};

const fileEntriesFor = (targetPath: string, isDir: boolean, x: number, y: number): ListEntry[] => {
  const entries: ListEntry[] = [];
  // Nautilus trash semantics: Restore / Open / delete-for-real; no rename,
  // clipboard ops or trashing inside the trash
  if (inTrashView()) {
    const inSel = !!tileRefsByKey.get(targetPath)?.selected;
    const targets: ClipItem[] = inSel && selPaths().length > 1 ? selPaths() : [{ path: targetPath, isDir }];
    entries.push(
      { icon: "folder", label: `Restore${inSel && targets.length > 1 ? ` ${targets.length} items` : ""}`, action: () => { closeFileMenu(); restoreFromTrash(targets.map((t) => t.path)); } },
      { icon: "eye", label: "Open", action: () => { closeFileMenu(); openFileDefault(targetPath); } },
      { icon: "trash-can", label: `Delete permanently`, action: () => { closeFileMenu(); confirmDeleteForever(targets.map((t) => t.path)); } },
    );
    return entries;
  }
  if (isDir) entries.push({ icon: "folder", label: "Open", action: () => { closeFileMenu(); navigate(targetPath); } });
  else entries.push({ icon: "eye", label: "Open", action: () => { closeFileMenu(); openFileDefault(targetPath); } });
  // actions apply to the whole live selection when the right-clicked tile is
  // part of it (Nautilus behavior), otherwise just this tile
  const inSel = !!tileRefsByKey.get(targetPath)?.selected;
  const targets: ClipItem[] = inSel && selPaths().length > 1 ? selPaths() : [{ path: targetPath, isDir }];
  entries.push(
    { icon: "content-copy", label: `Copy${inSel && targets.length > 1 ? ` ${targets.length} items` : ""}`, action: () => { closeFileMenu(); setClipboard("copy", targets); } },
    { icon: "content-cut", label: `Cut${inSel && targets.length > 1 ? ` ${targets.length} items` : ""}`, action: () => { closeFileMenu(); setClipboard("cut", targets); } },
    ...(isDir
      ? [{
          icon: "content-paste",
          label: clipboard && clipboard.items.length ? `Paste ${clipboard.items.length} item${clipboard.items.length === 1 ? "" : "s"} into folder` : "Paste into folder",
          action: () => { closeFileMenu(); pasteSmart(targetPath); },
        } satisfies ListEntry]
      : []),
    { icon: "pencil", label: "Rename…", action: () => {
        closeFileMenu();
        startInlineRename(targetPath);
      } },
    { icon: "trash-can", label: `Trash${inSel && targets.length > 1 ? ` ${targets.length} items` : ""}`, action: () => { closeFileMenu(); trashPaths(targets.map((t) => t.path)); } },
  );
  entries.push({ icon: "information", label: "Properties…", action: () => openProperties(targetPath) });
  return entries;
};

const sortEntries = (): ListEntry[] => {
  // nautilus convention: picking a different key sorts it in its natural
  // direction; clicking the active key flips ascending/descending.
  // Direction arrow sits at the row's right edge via hint.
  const pick = (key: SortMode, naturalAsc: boolean): void => {
    closeFileMenu();
    if (state.sortBy === key) state.sortAsc = !state.sortAsc;
    else { state.sortBy = key; state.sortAsc = naturalAsc; }
    void renderGrid();
  };
  const entry = (key: SortMode, label: string, naturalAsc: boolean): ListEntry => ({
    label,
    ...(state.sortBy === key ? { hintIcon: state.sortAsc ? "arrow-up" : "arrow-down" } : {}),
    action: () => pick(key, naturalAsc),
  });
  return [
    entry("name", "Name", true),
    entry("size", "Size", false),
    entry("mtime", "Modified", true),
    entry("type", "Type", true),
  ];
};

const emptyAreaEntries = (x: number, y: number): ListEntry[] => {
  const entries: ListEntry[] = [];
  if (inTrashView()) {
    entries.push({ icon: "trash-can", label: "Empty Trash", action: () => { closeFileMenu(); confirmEmptyTrash(); } });
  }
  if (isVirtualCwd()) {
    // read-only virtual views: nothing to paste or create here
    entries.push(
      { icon: "select-all", label: "Select all", action: () => {
        closeFileMenu();
        tileRefsByKey.forEach((r, k) => { r.selected = true; setTileVisual(k, 2); });
        updateSelectionStatusReal();
      } },
    );
    return entries;
  }
  entries.push(
    { icon: "file", label: "New File", action: () => { closeFileMenu(); startInlineCreate("file"); } },
    { icon: "folder-plus", label: "New Folder", action: () => { closeFileMenu(); startInlineCreate("folder"); } },
    { icon: "select-all", label: "Select all", action: () => {
      closeFileMenu();
      tileRefsByKey.forEach((r, k) => { r.selected = true; setTileVisual(k, 2); });
      updateSelectionStatusReal();
    } },
    { icon: "content-paste", label: clipboard && clipboard.items.length ? `Paste ${clipboard.items.length} item${clipboard.items.length === 1 ? "" : "s"}` : "Paste", action: () => { closeFileMenu(); pasteSmart(state.cwd); } },
    { icon: "information", label: "Properties…", action: () => { closeFileMenu(); openProperties(state.cwd); } },
    // nautilus puts shell access in its own group at the bottom
    { sep: true, label: "", action: () => {} },
    { icon: "terminal", label: "Open Terminal Here", action: () => { closeFileMenu(); openTerminalHere(); } },
  );
  return entries;
};

// --- ESC menu + settings panel — widget lives in ./ui-settings ---
const quitApp = () => {
  disableDrops();
  // release the shift-capture request made at boot
  try { process.stdout.write("\x1b[>0s"); } catch {}
  try { renderer.destroy(); } catch {}
  process.exit(0);
};

// --- Settings model: row type + pure semantics live in ./settings.ts; the
// get/set closures wiring rows to config/state and the renderer stay here ---
const themePresetIdx = (): number =>
  settingsThemePresetIdx(THEME_PRESETS, config.theme);

const commitSetting = (): void => {
  applyConfig(config);
  scheduleSaveConfig();
};

const resetToDefaults = (): void => {
  const fresh = structuredClone(defaultConfig);
  state.showHidden = fresh.ui.showHidden;
  applyConfig(fresh);
  scheduleSaveConfig();
};

const settingGroups = (): SettingGroup[] => [
  {
    rows: [
      { kind: "cycle", label: "theme", names: THEME_PRESETS.map((p) => p.name), getIdx: themePresetIdx,
        setIdx: (i) => { applyConfig({ ui: { ...config.ui }, theme: { ...THEME_PRESETS[i]!.theme } }); scheduleSaveConfig(); } },
      { kind: "toggle", label: "hidden files",
        // state.showHidden is the effective runtime flag (ctrl+h writes it
        // without persisting); config is only updated when the GUI commits
        get: () => state.showHidden,
        set: (v) => { config.ui.showHidden = v; state.showHidden = v; commitSetting(); } },
      { kind: "toggle", label: "preview pane", get: () => config.ui.previewEnabled,
        set: (v) => { config.ui.previewEnabled = v; commitSetting(); } },
      // fresh-object setters (see transparent-bg below): toggles that flip
      // renderer/layout state must not mutate `config` before applyConfig
      // cycle, not toggle: false = adaptive (strip only with 2+ tabs), true = always
      { kind: "cycle", label: "tab bar", names: ["adaptive", "on"], getIdx: () => (config.ui.tabBar ? 1 : 0),
        setIdx: (i) => { applyConfig({ ui: { ...config.ui, tabBar: i === 1 }, theme: { ...config.theme } }); scheduleSaveConfig(); } },
      { kind: "toggle", label: "list view", get: () => config.ui.viewMode === "list",
        set: (v) => { applyConfig({ ui: { ...config.ui, viewMode: v ? "list" : "grid" }, theme: { ...config.theme } }); scheduleSaveConfig(); } },
      // fresh-object setter on purpose: applyConfig diffs config vs fresh, so
      // mutating config first (like the rows above) would self-compare equal
      // and skip the cache-invalidation/clear-color swap
      { kind: "toggle", label: "transparent bg", get: () => config.ui.transparentBg,
        set: (v) => { applyConfig({ ui: { ...config.ui, transparentBg: v }, theme: { ...config.theme } }); scheduleSaveConfig(); } },
      { kind: "cycle", label: "ui style", names: ["solid", "outline"], getIdx: () => (config.ui.uiStyle === "outline" ? 1 : 0),
        setIdx: (i) => { applyConfig({ ui: { ...config.ui, uiStyle: i === 1 ? "outline" : "solid" }, theme: { ...config.theme } }); scheduleSaveConfig(); } },
    ],
  },
  {
    header: "layout",
    rows: [
      { kind: "stepper", label: "sidebar width", min: 16, max: 60, step: 1, fmt: (v) => `${v}`, get: () => config.ui.sidebarWidth, set: (v) => { config.ui.sidebarWidth = v; commitSetting(); } },
      { kind: "stepper", label: "tile width", min: 10, max: 40, step: 1, fmt: (v) => `${v}`, get: () => config.ui.tileWidth, set: (v) => { config.ui.tileWidth = v; commitSetting(); } },
      { kind: "stepper", label: "tile height", min: 3, max: 10, step: 1, fmt: (v) => `${v}`, get: () => config.ui.tileHeight, set: (v) => { config.ui.tileHeight = v; commitSetting(); } },
      { kind: "stepper", label: "icon size", min: 1, max: 5, step: 1, fmt: (v) => `${v}`, get: () => config.ui.iconCells, set: (v) => { config.ui.iconCells = v; commitSetting(); } },
      { kind: "stepper", label: "preview width", min: 20, max: 80, step: 2, fmt: (v) => `${v}`, get: () => config.ui.previewWidth, set: (v) => { config.ui.previewWidth = v; commitSetting(); } },
    ],
  },
  {
    header: "behavior",
    rows: [
      { kind: "stepper", label: "double-click ms", min: 100, max: 2000, step: 50, fmt: (v) => `${v}`, get: () => config.ui.doubleClickMs, set: (v) => { config.ui.doubleClickMs = v; commitSetting(); } },
    ],
  },
  {
    header: "config",
    rows: [
      { kind: "action", label: "reset to defaults", keepOpen: true, run: resetToDefaults },
      { kind: "action", label: "edit config.toml…", run: () => { spawn("xdg-open", [configPath()], { stdio: "ignore", detached: true }).unref?.(); } },
      { kind: "action", label: "back", keepOpen: true, run: () => escMenu.showRoot() },
    ],
  },
];


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
  if (renameEdit) return;
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
      if (pathEditMode) { exitPathEdit(); return; }
      if (renameEdit) finishInlineRename(false);
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

// --- Config application & persistence ---
// Single path for every config change (file watcher, settings UI, reset):
// mutate -> applyConfig -> scheduleSaveConfig. Geometry values that used to be
// baked into consts are rewritten here, and raster caches are invalidated only
// when colors actually changed.

const setOnId = (id: string, fn: (n: any) => void): void => {
  const n: any = byId(id);
  if (!n) return;
  try { fn(n); } catch {}
};

// Repaints widgets whose colors were baked at boot and which renderAll's
// rebuilds never touch. Without this a runtime theme swap leaves the sidebar,
// title, inputs, band, ghost and status bar in the old palette.
const rethemeChrome = (): void => {
  const st = config.ui.uiStyle;
  setOnId("tfm-sidebar-root", (n) => { n.width = sw; applySurface(n, chromeSurface(st, colors, colors.sidebarBg)); });
  setOnId("tfm-main", (n) => applySurface(n, chromeSurface(st, colors, colors.bg)));
  setOnId("tfm-title-box", (n) => { n.width = sideInnerW(); });
  setOnId("tfm-places", (n) => { n.width = sideInnerW(); });
  setOnId("tfm-title-font", (n) => { n.color = colors.accent; });
  setOnId("tfm-title-sub", (n) => { n.fg = colors.sidebarFgMuted; });
  setOnId("tfm-preview", (n) => applySurface(n, chromeSurface(st, colors, colors.sidebarBg)));
  setOnId(BAND_ID, (n) => { n.borderColor = colors.accent; });
  setOnId(DRAG_GHOST_ID, (n) => { n.backgroundColor = colors.accent; });
  setOnId(`${DRAG_GHOST_ID}-label`, (n) => { n.fg = colors.bg; });
  setOnId("tfm-status-label", (n) => { n.fg = colors.sidebarFgMuted; });
  setOnId("tfm-prompt-panel", (n) => applySurface(n, chromeSurface(st, colors, colors.sidebarBg)));
  // 1-row header can't carry a border ring — just drop the fill in outline
  setOnId("tfm-term-header", (n) => applySurface(n, st === "outline" ? {} : { backgroundColor: colors.sidebarBg }));

  // toolbar hover buttons: box bg must track the new palette between raster swaps
  for (const id of ["tfm-nav-back", "tfm-nav-fwd", "tfm-search-btn", "tfm-sort-btn"]) {
    setOnId(id, (n) => {
      applySurface(n, btnSurface(st, colors, !!navHover[id]));
    });
  }
  renderCrumbs();
  refreshNav();
  for (const id of ["tfm-search", "tfm-path-input", "tfm-prompt-input"]) {
    setOnId(id, (n) => {
      n.backgroundColor = colors.accentBg;
      n.focusedBackgroundColor = colors.accentBg;
      n.textColor = colors.white;
    });
  }
  if (escMenu.isOpen()) {
    setOnId("tfm-menu-panel", (n) => applySurface(n, chromeSurface(st, colors, colors.sidebarBg)));
    escMenu.renderMenuContent();
  }
  if (fileMenuIsOpen()) {
    setOnId("tfm-filemenu", (n) => applySurface(n, chromeSurface(st, colors, colors.sidebarBg)));
    renderFileMenu();
  }
};

// theme-relevant signature of a config snapshot. Diffing against the LAST
// APPLIED state (not the caller's pre-call `config`) means a settings row can
// mutate config first and call applyConfig(config) and the flip is still seen
// — the old self-compare skipped raster invalidation silently.
const themeSig = (c: Config): string =>
  JSON.stringify([c.theme, c.ui.transparentBg, c.ui.uiStyle]);
let lastThemeSig = themeSig(config);

const applyConfig = (fresh: Config): void => {
  const themeChanged = lastThemeSig !== themeSig(fresh);
  Object.assign(config.ui, fresh.ui);
  Object.assign(config.theme, fresh.theme);
  Object.assign(colors, fresh.theme);
  if (!config.ui.transparentBg) colors.bg = bumpHex(colors.bg);
  lastThemeSig = themeSig(config);

  sw = config.ui.sidebarWidth;
  TILE_W = config.ui.tileWidth;
  TILE_H = config.ui.tileHeight;
  ICON_CELLS_H = config.ui.iconCells;
  for (const id of ["tfm-sidebar-root", "tfm-title-box", "tfm-places"]) {
    setOnId(id, (n) => { n.width = id === "tfm-sidebar-root" ? sw : sideInnerW(); });
  }
  const pane: any = byId("tfm-preview");
  if (pane) {
    try {
      pane.visible = config.ui.previewEnabled;
      pane.width = config.ui.previewWidth;
    } catch {}
  }

  if (themeChanged) {
    clearIconCaches();
    resetIconQueue();
    try { renderer.setBackgroundColor(config.ui.transparentBg ? "transparent" : colors.bg); } catch {}
    // grid/sidebar rebuild picks up the new palette; everything else needs this
    rethemeChrome();
    syncTerminalTheme();
  }
  renderAll();
};

// signature of the last file WE wrote; the watcher skips it so saving doesn't
// re-enter applyConfig and churn the rasters
let lastSavedSig = "";
let saveWarned = false;

const scheduleSaveConfig = debounced(500, () => {
  saveConfig(config)
    .then(async () => { try { lastSavedSig = JSON.stringify(loadConfig()); } catch {} })
    .catch(() => {
      if (!saveWarned) {
        saveWarned = true;
        console.error(`[tfm] could not write config to ${configPath()}`);
      }
    });
});

// --- live config reload ---
try {
  const cfgPath = configPath();
  const applyFreshConfig = debounced(250, () => {
    try {
      const fresh = loadConfig();
      if (JSON.stringify(fresh) === lastSavedSig) return;
      applyConfig(fresh);
      setStatusMsg("config reloaded");
    } catch {}
  });
  const watcher = watch(path.dirname(cfgPath), (_event, filename) => {
    if (!filename || filename !== path.basename(cfgPath)) return;
    applyFreshConfig();
  });
  watcher.on("error", () => {});
} catch {}

// --- OSC 72 drop-in (kitty drag-and-drop): accept OS file drags onto the terminal ---
// wire format per yazi's reference impl: enter(t=m)/ready(t=M) carry a plaintext
// space-separated MIME list; data arrives as unpadded base64 chunks (t=r) that we
// request with StartDrop and acknowledge with FinishDrop(copy).
// Sequences are received via renderer.subscribeOsc — OpenTUI's stdin parser hands
// every OSC it frames to subscribers, so no second reader races the renderer.
const DND_LOG = "/tmp/tfm-dnd.log";
const dlog = (msg: string): void => {
  try { appendFileSync(DND_LOG, `${new Date().toISOString()} ${msg}\n`); } catch {}
  if (isDebug) appendLog(`[dnd] ${msg}`);
};

const osc72Write = (s: string, label: string): void => {
  dlog(`tx ${label}`);
  try { process.stdout.write(s); } catch {}
};

const enableDrops = (): void => {
  osc72Write(dragOutEnableFrame(), "enable drag-out");
  osc72Write(dropInEnableFrame(), "enable drop-in");
};
const disableDrops = (): void => osc72Write(dropDisableFrame(), "disable drop");

let osc72DropIdx = -1;
const osc72Arrive: Record<number, string> = {};
// outgoing drag session state
let osc72DragPaths: string[] | null = null;
let osc72DragOp = 1; // 1 copy / 2 move
let osc72SelfHandled = false; // self-drop already moved/copied the files
let osc72SelfTargetKey: string | null = null; // folder tile currently highlighted
let osc72EndTimer: any = null;
// NOTE: an experiment to detect cursor-exit mid-drag by flipping SGR pixel
// mode (?1016) failed: OpenTUI's mouse parser drops negatives outright
// (parse.mouse.ts returns null) and interprets pixel coords as cells, corrupting
// dispatch/highlights app-wide. Kitty reports OOB motion only in that mode,
// so internal->external handoff within one gesture is not implementable here.
let osc72OfferSeen = false; // internal-first: we decline offers, remember the gesture happened
let osc72Engaged = false; // handed off to the OS mid-gesture

// resolve a terminal cell position to an internal drop target (folder tile or place)
const resolveDropTargetAt = (x: number, y: number): { kind: "folder" | "place"; path: string } | null => {
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
              if (osc72DragPaths?.includes(k)) return null; // dropping onto itself
              return { kind: "folder", path: k };
            }
          }
        }
      }
      cur = cur.parent;
    }
  } catch {}
  return null;
};

const clearSelfDropHighlight = (): void => {
  if (osc72SelfTargetKey) {
    const r = tileRefsByKey.get(osc72SelfTargetKey);
    if (r && !r.selected) setTileVisual(osc72SelfTargetKey, 0);
    osc72SelfTargetKey = null;
  }
};

// kitty renders this text badge next to the cursor for the whole drag session —
// the visual feedback we lose by handing the pointer to the OS
const sendDragIcon = (n: number): void => {
  osc72Write(dragIconFrame(n), "drag icon");
};

const beginOsc72Drag = (paths: string[]): void => {
  osc72DragPaths = paths;
  osc72DragOp = 1;
  osc72SelfHandled = false;
  finishDragCtx(); // pointer is about to be grabbed by the terminal
  osc72Write(agreeDragFrame(), "agree drag either");
  presentDragUriList(paths);
  sendDragIcon(paths.length);
  osc72Write(startDragFrame(), "start drag");
  setStatusMsg(`Dragging ${paths.length} item${paths.length === 1 ? "" : "s"} — drop into another app or a folder`);
};

// self-dropped back onto tfm: route to the folder/place under the cursor,
// otherwise cancel — this is what makes one plain drag serve both worlds
const handleSelfDropHover = (x: number, y: number): void => {
  clearSelfDropHighlight();
  const target = x >= 0 ? resolveDropTargetAt(x, y) : null;
  dlog(`self hover ${x},${y} -> ${target ? target.kind + ":" + target.path : "none"}`);
  if (!target) {
    clearMousePlace();
    return;
  }
  if (target.kind === "folder") {
    osc72SelfTargetKey = target.path;
    setTileVisual(target.path, 2);
  } else {
    const idx = placesHost.findIndex((p) => p.place.path === target.path);
    if (idx >= 0) setMousePlace(idx);
  }
};

const finishSelfDrop = async (x: number, y: number): Promise<void> => {
  dlog(`self drop at ${x},${y}`);
  if (osc72EndTimer) { clearTimeout(osc72EndTimer); osc72EndTimer = null; }
  const paths = osc72DragPaths;
  osc72SelfHandled = true;
  const target = resolveDropTargetAt(x, y);
  clearSelfDropHighlight();
  osc72DragPaths = null;
  osc72SelfHandled = false;
  if (!paths?.length || !target) {
    osc72Write(selfDropRejectFrame(), "self drop rejected");
    setStatusMsg("drag cancelled");
    return;
  }
  const destDir = target.path;
  // same routing as tile/place drops: conflict prompt, undo units, honest counts —
  // never silently skip collisions; the trash place must gio-trash, not raw-move
  if (destDir === path.join(home, ".local/share/Trash/files")) {
    void trashPaths(paths);
    return;
  }
  const items: ClipItem[] = paths.map((p) => ({
    path: p,
    isDir:
      tileRefsByKey.get(p)?.isDir ??
      (() => {
        try { return statSync(p).isDirectory(); } catch { return false; }
      })(),
  }));
  await moveInto(destDir, items);
};

const presentDragUriList = (paths: string[]): void => {
  const [dataFrame, endFrame] = presentDragFrames(paths);
  const b64Len = dropPayloadLength(paths);
  osc72Write(dataFrame, `present drag ${b64Len} b64 chars`);
  osc72Write(endFrame, "present drag end");
};

// length of the unpadded base64 payload, for the debug label only
const dropPayloadLength = (paths: string[]): number => uriListPayload(paths).length;

const finishOsc72Drop = async (idx: number): Promise<void> => {
  const b64 = osc72Arrive[idx];
  delete osc72Arrive[idx];
  osc72DropIdx = -1;
  osc72Write(finishDropFrame(), `finish drop idx=${idx}`);
  dlog(`drop complete, uri-list bytes=${b64 ? Buffer.from(b64, "base64").length : 0}`);
  if (!b64) return;
  if (isVirtualCwd()) {
    setStatusMsg("Drops land in a real folder");
    return;
  }
  const text = Buffer.from(b64, "base64").toString("utf8");
  let paths = dropPayloadToPaths(text);
  // some sources deliver bare paths (text/plain) instead of file:// URIs
  if (!paths.length) paths = text.split(/\r?\n/).filter((l) => l.startsWith("/"));
  dlog(`paths: ${paths.join(" | ") || "(none)"}`);
  if (paths.length) await runTransfer("copy", state.cwd, paths, "drop");
};

const handleOsc72 = (meta: string, payload: string): void => {
  const { t, x, y, m } = parseOsc72Meta(meta);

  // --- outgoing drag session ---
  // middle-button drags go external (OS session + icon badge); left drags are
  // declined so the internal move flow keeps the pointer and its UI feedback
  if (t === "o" && x >= 0) {
    const want = !gridDrag.ctrl && !!gridDrag.keys?.length && !escMenu.isOpen() && !fileMenuIsOpen();
    dlog(`drag offer x=${x} y=${y} ctrl=${gridDrag.ctrl} accept=${want} keys=${gridDrag.keys?.length ?? -1} menu=${escMenu.isOpen()} fmenu=${fileMenuIsOpen()}`);
    if (!want || !gridDrag.keys) return; // left-drag: kitty falls back to normal mouse events
    beginOsc72Drag(gridDrag.keys.map((k) => k.path));
    return;
  }
  if (t === "e") {
    if (x === 2) { osc72DragOp = y === 2 ? 2 : 1; dlog(`drag op=${osc72DragOp === 2 ? "move" : "copy"}`); }
    else if (x === 3) { dlog(`drag landed op=${osc72DragOp}`); }
    else if (x === 4) {
      const canceled = y !== 0;
      dlog(`drag end canceled=${canceled} op=${osc72DragOp} selfHandled=${osc72SelfHandled}`);
      const pathsAtEnd = osc72DragPaths;
      const finishExternal = (): void => {
        if (!canceled && pathsAtEnd && !osc72SelfHandled) {
          // released over another app: honor move semantics by trashing our copies
          if (osc72DragOp === 2) trashPaths(pathsAtEnd);
          else notify(`Sent ${pathsAtEnd.length} item${pathsAtEnd.length === 1 ? "" : "s"}`, "drag & drop");
        } else if (canceled) setStatusMsg("drag cancelled");
        osc72DragPaths = null;
        osc72SelfHandled = false;
        clearSelfDropHighlight();
      };
      if (osc72EndTimer) { clearTimeout(osc72EndTimer); osc72EndTimer = null; }
      // a self-drop M may still be in flight behind the end event — defer
      if (!canceled && pathsAtEnd && !osc72SelfHandled) osc72EndTimer = setTimeout(finishExternal, 700);
      else finishExternal();
    }
    else if (x === 5 && osc72DragPaths && !osc72SelfHandled) { dlog("drag send request"); presentDragUriList(osc72DragPaths); }
    return;
  }

  // --- self-drop: hover/drop events landing back on tfm during OUR session ---
  if ((t === "m" || t === "M") && osc72DragPaths) {
    if (x === -1 && y === -1) { clearSelfDropHighlight(); clearMousePlace(); return; }
    if (t === "m") { handleSelfDropHover(x, y); return; }
    void finishSelfDrop(x, y); // M — dropped on ourselves
    return;
  }

  // DropLeave
  if (t === "m" && x === -1 && y === -1) {
    dlog("leave");
    osc72DropIdx = -1;
    for (const k of Object.keys(osc72Arrive)) delete osc72Arrive[Number(k)];
    return;
  }

  if (t === "m" || t === "M") {
    const mimes = payload.split(/\s+/).filter(Boolean);
    const idx = mimes.indexOf("text/uri-list");
    dlog(`${t === "M" ? "ready" : "enter"} mimes=[${mimes}] uriIdx=${idx} busy=${osc72DropIdx >= 0}`);
    if (idx < 0 || osc72DropIdx >= 0) return;
    osc72Write(agreeDropFrame(), "agree copy");
    if (t === "M") {
      // kitty's mime indices are 1-based (yazi requests ipairs index)
      osc72DropIdx = idx + 1;
      osc72Arrive[osc72DropIdx] = "";
      osc72Write(startDropFrame(osc72DropIdx), `start drop uriIdx=${idx} wire=${osc72DropIdx}`);
    }
    return;
  }
  if (t === "r" && x === osc72DropIdx) {
    osc72Arrive[x] += payload;
    // presence of payload or m=1 means more chunks are coming
    if (!payload && !m) void finishOsc72Drop(x);
    return;
  }
  if (t === "R") { dlog(`drop error: ${payload}`); setStatusMsg("drop failed"); return; }
  if (t === "E") { dlog(`drag offer error: ${payload}`); setStatusMsg("drag failed"); return; }
  dlog(`unhandled osc72 type t=${JSON.stringify(t)} x=${x} y=${y} payloadLen=${payload.length}`);
};

renderer.subscribeOsc((seq: string) => {
  const start = seq.indexOf("]72;");
  if (start < 0) return;
  const body = seq.slice(start + 4).replace(/(\x1b\\|\x07|\x9c)$/, "");
  handleOsc72(body.slice(0, body.indexOf(";") < 0 ? body.length : body.indexOf(";")), body.indexOf(";") < 0 ? "" : body.slice(body.indexOf(";") + 1));
});
enableDrops();
// XTSHIFTESCAPE=1 (CSI > Ps s): ask the terminal (kitty, ghostty, xterm) to
// forward shift+click instead of using it for native text selection.
// Terminals that don't know the sequence ignore it; alt+click is the fallback.
osc72Write("\x1b[>1s", "xtshiftescape on");

// --- resize: repave rasters and rebuild layout ---
let resizeTimer: any = null;
renderer.on(CliRenderEvents.RESIZE, () => {
  if (resizeTimer) clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    resetIconQueue();
    renderAll();
  }, 150);
});

// --- Keyboard ---
renderer.keyInput.on("keypress", (e: any) => {
  const ctrl = !!e.ctrl || !!e.control;
  if (ctrl && (e.name === "q" || e.unicode === "q")) {
    quitApp();
    return;
  }
  // override/conflict modal: esc = skip, everything else swallowed (mouse-driven)
  if (conflict.isOpen()) {
    if (e.name === "escape") conflict.closeConflict("skip");
    return;
  }

  // yes/no confirm: esc = No, everything else swallowed (mouse-driven)
  if (yesNoOpen) {
    if (e.name === "escape") closeYesNo();
    return;
  }

  // inline rename: the focused Input consumes typing; swallow everything else
  // so arrows/shortcuts don't move grid focus mid-edit (esc/enter handled at
  // the source via handleKeyPress / "enter")
  if (renameEdit) return;

  // floating properties dialog: esc/enter closes, everything else swallowed
  if (propsIsOpen()) {
    if (e.name === "escape" || e.name === "return") closeProps();
    return;
  }

  // notification test: ctrl+g (ctrl+i is indistinguishable from tab)
  if (ctrl && e.name === "g") {
    notify(`hello at ${new Date().toLocaleTimeString()}`, "debug");
    return;
  }

  if (escMenu.isOpen()) {
    if (e.name === "escape") escMenu.closeMenu();
    else if (e.name === "up") escMenu.moveMenu(-1);
    else if (e.name === "down") escMenu.moveMenu(1);
    else if (e.name === "left") escMenu.adjustSelectedSetting(-1);
    else if (e.name === "right") escMenu.adjustSelectedSetting(1);
    else if (e.name === "return") escMenu.menuActivate();
    return;
  }

  // embedded terminal owns the keyboard while focused — everything below is
  // host UI. Click the grid/sidebar (or ✕) to leave the shell.
  if (termOwnsKeyboard()) return;

  const el: any = byId("tfm-search");
  const pathInput: any = byId("tfm-path-input");

  if (pathInput?.visible || pathEditMode) {
    if (e.name === "escape") {
      exitPathEdit();
      return;
    }
    return;
  }

  // file context menu open: arrows/enter navigate it, esc closes.
  // getFileMenuState() returns the LIVE state object — mutating fmenu.idx
  // below updates the menu module's state in place.
  const fmenu = getFileMenuState();
  if (fmenu) {
    const entries = fmenu.entries;
    const count = entries.length;
    const step = (d: number) => {
      let i = (fmenu.idx + d + count) % count;
      while (entries[i]?.sep) i = (i + d + count) % count;
      fmenu.idx = i;
      renderFileMenu();
    };
    if (e.name === "escape") closeFileMenu();
    else if (e.name === "up") step(-1);
    else if (e.name === "down") step(1);
    else if (e.name === "return") entries[fmenu.idx]?.action();
    return;
  }

  if (el?.visible) {
    if (e.name === "escape") {
      const had = !!searchQuery;
      clearSearch();
      if (had) void renderGrid();
      return;
    }
    // enter commits: open the first folder match (dirs sort first in the
    // filtered grid); fall back to opening the first file match
    if (e.name === "return") {
      const firstDir = focusKeys.find((k) => tileRefsByKey.get(k)?.isDir);
      const targetKey = firstDir ?? focusKeys[0];
      const refs = targetKey !== undefined ? tileRefsByKey.get(targetKey) : undefined;
      if (targetKey && refs) {
        if (refs.isDir) navigate(targetKey);
        else { openFileDefault(targetKey); clearSearch(); void renderGrid(); }
      } else {
        clearSearch();
        void renderGrid();
      }
      return;
    }
    return;
  }

  // --- keyboard navigation: sidebar <-> grid ---
  // shift+arrows extend the selection from the anchor instead of moving it
  const extendFromAnchor = (next: number): void => {
    if (selAnchor === null) {
      selAnchor = focusIdx >= 0 ? focusIdx : 0;
    }
    if (next === focusIdx || next < 0 || next >= focusKeys.length) return;
    selectTileAt(next);
    selectRange(selAnchor, next);
    updateSelectionStatusReal();
    void renderPreview();
  };
  if (e.shift && !ctrl && e.name === "up") { if (focusKeys.length) { selAnchor = selAnchor ?? (focusIdx >= 0 ? focusIdx : 0); extendFromAnchor(focusIdx < 0 ? 0 : focusIdx - colsAtBuild); } return; }
  if (e.shift && !ctrl && e.name === "down") { if (focusKeys.length) { selAnchor = selAnchor ?? (focusIdx >= 0 ? focusIdx : 0); extendFromAnchor(focusIdx < 0 ? 0 : focusIdx + colsAtBuild); } return; }
  if (e.shift && !ctrl && e.name === "left") { if (focusKeys.length && focusIdx > 0) extendFromAnchor(focusIdx - 1); return; }
  if (e.shift && !ctrl && e.name === "right") { if (focusKeys.length && focusIdx < focusKeys.length - 1) extendFromAnchor(focusIdx + 1); return; }

  if (sidebarActive) {
    if (e.name === "up") { setSidebarFocus(placeIdx - 1); return; }
    if (e.name === "down") { setSidebarFocus(placeIdx + 1); return; }
    if (e.name === "left" || e.name === "right") {
      leaveSidebarToGrid();
      selectTileAt(focusIdx >= 0 ? focusIdx : 0);
      return;
    }
    if (e.name === "return") {
      const rec = placesHost[placeIdx];
      if (rec) {
        closeFileMenu();
        sidebarActive = false;
        placeIdx = -1;
        const target = rec.place.scheme === "recent" ? RECENT_URI
          : rec.place.scheme === "starred" ? STARRED_URI
          : rec.place.path;
        if (target) navigate(target);
        else if (rec.place.mountDevice) mountDevice(rec.place.mountDevice);
      }
      return;
    }
    return;
  }

  if (e.name === "up") { moveFocus(0, -1); return; }
  if (e.name === "down") { moveFocus(0, 1); return; }
  if (e.name === "left") {
    const atLeftEdge = focusIdx === -1 || focusIdx % colsAtBuild === 0;
    if (atLeftEdge || focusKeys.length === 0) {
      const selRec = placesHost.findIndex((p) => p.selected);
      const pk = focusIdx >= 0 ? focusKeys[focusIdx] : undefined;
      if (pk !== undefined) {
        const pr = tileRefsByKey.get(pk);
        if (pr && !pr.selected) setTileVisual(pk, 0);
      }
      sidebarActive = true;
      setSidebarFocus(selRec >= 0 ? selRec : 0);
      return;
    }
    moveFocus(-1, 0);
    return;
  }
  if (e.name === "right") { moveFocus(1, 0); return; }
  if (e.name === "return" && focusIdx >= 0) {
    const key = focusKeys[focusIdx];
    const refs = key !== undefined ? tileRefsByKey.get(key) : undefined;
    if (key && refs) {
      if (refs.isDir) navigate(key);
      else openFileDefault(key);
    }
    return;
  }
  if (e.name === "backspace") {
    const parent = path.dirname(path.resolve(state.cwd));
    if (parent !== path.resolve(state.cwd)) navigate(parent);
    return;
  }
  if (!ctrl && !e.shift && typeof e.name === "string" && e.name.length === 1 && /[a-z0-9._-]/i.test(e.name)) {
    beginTypeToSearch(e.name);
    return;
  }

  if (e.name === "escape") {
    escMenu.openMenu();
    return;
  }
  if (ctrl && (e.name === "h" || e.unicode === "h")) {
    state.showHidden = !state.showHidden;
    renderGrid();
  }
  if (ctrl && (e.name === "r" || e.unicode === "r")) {
    void loadSystemPlaces().then(() => renderAll());
  }

  // --- tabs: ctrl+t new, ctrl+w close, ctrl+tab / ctrl+shift+tab cycle
  // (kitty needs map no_op for the latter two — its default next_tab /
  // previous_tab eat the keys before they reach us) ---
  if (ctrl && (e.name === "t" || e.unicode === "t")) { newTab(); return; }
  if (ctrl && (e.name === "w" || e.unicode === "w")) { closeTab(); return; }
  if (ctrl && e.name === "tab") {
    if (e.shift) switchTab(tabModel.active === 0 ? tabModel.list.length - 1 : tabModel.active - 1);
    else switchTab(tabModel.active === tabModel.list.length - 1 ? 0 : tabModel.active + 1);
    return;
  }

  // --- file operations ---
  if (ctrl && (e.name === "a" || e.unicode === "a")) {
    tileRefsByKey.forEach((r, k) => { r.selected = true; setTileVisual(k, 2); });
    updateSelectionStatusReal();
    return;
  }
  const selected = selPaths();
  if (e.name === "delete" && selected.length) {
    if (inTrashView()) {
      // no cursor coords in a keybind — the confirm dialog is a centered modal
      confirmDeleteForever(selected.map((s) => s.path));
    }
    else trashPaths(selected.map((s) => s.path));
    return;
  }
  if (e.name === "f2" && selected.length === 1 && selected[0]) {
    // in the trash F2 restores instead of renaming
    if (inTrashView()) {
      restoreFromTrash(selected.map((s) => s.path));
      return;
    }
    const p = selected[0].path;
    startInlineRename(p);
    return;
  }
  if (ctrl && (e.name === "c" || e.unicode === "c") && selected.length) {
    setClipboard("copy", selected);
    return;
  }
  if (ctrl && (e.name === "x" || e.unicode === "x") && selected.length) {
    setClipboard("cut", selected);
    return;
  }
  if (ctrl && (e.name === "v" || e.unicode === "v") && !isVirtualCwd()) {
    pasteSmart(state.cwd);
    return;
  }
  if ((ctrl && e.shift && (e.name === "z" || e.unicode === "z")) || (ctrl && (e.name === "y" || e.unicode === "y"))) {
    redoLast();
    return;
  }
  if (ctrl && (e.name === "z" || e.unicode === "z")) {
    undoLast();
    return;
  }
});
