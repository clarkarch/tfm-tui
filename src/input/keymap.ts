// --- Keyboard router: ONE keypress entry point with a strict precedence
// chain — capture > quit/restart > overlay-modals (prompt/bulk-rename/conflict/yes-no/rename/
// props, which keep their keys even above an open pick) > pick > esc-menu >
// terminal > path-edit > file menu > search > specifics (histBack/showProps/…)
// > sidebar > extend > grid > parentDir > type-to-search > actions.
// ALL dispatchable keys are remappable via config [keys] (see config-schema.ts):
// the move*/openSelected/extend*/page*/first/last binds drive the grid AND
// every menu/sidebar/search context (one row moves everywhere). Still
// structural: esc-close, tab inside menus, and the type-to-search catch-all
// (gated on the [ui] type-to-search knob — the yazi preset flips it off).
// The order IS load-bearing — do not reorder; handleKey below is the canonical
// sequence, this header mirrors it.
// Every remappable action ALSO lives in the commands() table (same closures)
// so the pick overlay runs exactly what the keypress would. ---
import path from "node:path";
import { RECENT_URI, STARRED_URI } from "../fs/uri";
import { loadSystemPlaces } from "../fs/places";
import type { KeyAction } from "../config/config-schema";
import { KEY_SCHEMA } from "../config/config-schema";
import { keyMatch, parseKeySpec } from "../config/keyspec";
import type { Command } from "../lib/command";
import { invokeIsolated } from "../lib/uiutil";
import type { NotifyLevel } from "../lib/notify-level";
import type { Selection } from "./selection";
import { TileVisual } from "./grid-input";
import type { MaybeNode } from "../lib/node-like";

// Keypress shape the router actually reads. The renderer hands a richer
// object (scan codes, text, meta); dispatch only touches name + modifiers.
type KeyPressEvent = {
  name?: string;
  shift?: boolean;
  ctrl?: boolean;
  control?: boolean;
  [extra: string]: unknown;
};

// structural subset of index's AppState — the router only touches these
type KeyState = {
  cwd: string;
  showHidden: boolean;
};

export type KeyRouterCtx = {
  byId(id: string): MaybeNode;
  state: KeyState;
  // live keybind lookup — reads config.keys so remaps apply without rebuilds
  keybinds(action: KeyAction): string[];
  quit(): void;
  restart(): void;
  // --- modal layers (precedence order) ---
  conflict: { isOpen(): boolean; closeConflict(policy: "skip"): void };
  yesNo: { isOpen(): boolean; close(): void; moveFocus(delta: number): void; submit(): void };
  // [ui] type-to-search knob (live read): false = bare keys never filter.
  // The yazi preset flips it off (it binds bare j/k/h/l…); startSearch
  // re-arms it on demand via enableTypeToSearch().
  typeToSearchEnabled(): boolean;
  enableTypeToSearch(): void;
  // active pane's sort cycle (single-key sort for the palette + presets;
  // yazi's `,` chords have no engine, so this is the refugee path)
  cycleSort(): void;
  isRenaming(): boolean;
  propsIsOpen(): boolean;
  closeProps(): void;
  // pick overlay (command palette): open instance swallows everything below
  // (typing reaches its focused Input natively, like type-to-search)
  pick: { isOpen(): boolean; handleKey(ev: KeyPressEvent): void };
  // single-line prompt overlay (plugin git-URL entry): same Input-native
  // typing rule. Optional so older fakes read as closed; wiring always sets it.
  prompt?: { isOpen(): boolean; handleKey(ev: KeyPressEvent): void };
  // bulk-rename modal (F2 on a multi-selection): the focused Textarea owns
  // typing; esc cancels, alt+enter submits natively
  bulkRename: { isOpen(): boolean; handleKey(ev: KeyPressEvent): void };
  escMenu: {
    isOpen(): boolean;
    closeMenu(): void;
    moveMenu(d: number): void;
    adjustSelectedSetting(d: number): void;
    menuActivate(): void;
    menuTab(): void;
    openMenu(): void;
    // keybind capture (settings panel): consume the event while recording
    captureKey(e: any): boolean;
  };
  termOwnsKeyboard(): boolean;
  pathEditMode(): boolean;
  pathInputVisible(): boolean;
  // --- search ---
  searchVisible(): boolean;
  searchQuery(): string;
  clearSearch(): void;
  exitPathEdit(): void;
  beginTypeToSearch(ch: string): void;
  // --- rendering + selection ---
  renderGrid(): void | Promise<void>;
  renderPreview(): void | Promise<void>;
  renderAll(): void;
  selection: Selection;
  // --- sidebar kb-focus state (read by makeChrome for the highlight) ---
  placesHost: Array<{ selected: boolean; place: { scheme?: string; path?: string | null; mountDevice?: string } }>;
  normalizePlaces(): void;
  mountDevice(dev: string): void;
  // --- navigation / open ---
  navigate(dir: string): void;
  goBack(): void;
  goFwd(): void;
  openFileDefault(p: string): void;
  // home dir — backspace target inside virtual views (URIs have no fs parent)
  home: string;
  // --- file menu ---
  getFileMenuState(): {
    idx: number;
    subIdx: number | null;
    entries: Array<{ sep?: boolean; submenu?: unknown[]; action(): void }>;
  } | null;
  closeFileMenu(): void;
  renderFileMenu(): void;
  openFileSubmenu(): void;
  closeFileSubmenu(): void;
  moveFileSubmenu(delta: number): void;
  activateFileSubmenu(): void;
  // --- tabs ---
  nextTab(): void;
  prevTab(): void;
  newTab(): void;
  closeTab(): void;
  // --- file ops ---
  inTrashView(): boolean;
  confirmDeleteForever(paths: string[]): void;
  trashPaths(paths: string[]): Promise<void>;
  restoreFromTrash(paths: string[]): Promise<void>;
  startInlineRename(p: string): void;
  startInlineCreate(kind: "file" | "folder"): void;
  startBulkRename(paths: string[]): void;
  openProperties(paths: string[]): void;
  enterPathEdit(): void;
  openTerminal(): void;
  connectServer(raw?: string): void;
  togglePreview(): void;
  toggleViewMode(): void;
  zoomTiles(dir: number): void;
  toggleDualPane(): void;
  switchPane(): void;
  copyToOtherPane(): void;
  moveToOtherPane(): void;
  setClipboard(mode: "copy" | "cut", items: Array<{ path: string; isDir: boolean }>): void;
  duplicate(paths: string[]): void;
  isVirtualCwd(): boolean;
  pasteSmart(dir: string): void;
  notify(msg: string, title?: string, level?: NotifyLevel): void;
  undoLast(): void;
  redoLast(): void;
  // plugin commands with effective binds (live read: remaps apply instantly).
  // Absent = no plugins. Dispatched after core actions, before grid nav and
  // type-to-search — same priority as core togglePreview etc. Core wins ties
  // (checked first), so a conflicting plugin bind is shadowed until remapped.
  pluginCommands?: () => Array<{ id: string; binds: string[]; run: () => void }>;
};

export const makeKeyRouter = (ctx: KeyRouterCtx) => {
  const { selection } = ctx;

  // sidebar keyboard focus
  let sidebarActive = false;
  let placeIdx = -1;
  // terminal-hint throttle: the "click the grid to leave" status shows once
  // per terminal focus visit, not on every swallowed keypress
  let termHintShown = false;

  // does this event match any configured bind for the action?
  const enterAlias = (name: string): string | null =>
    name === "enter" ? "return" : name === "return" ? "enter" : null;

  const hit = (ev: KeyPressEvent, action: KeyAction): boolean => {
    const specs = ctx.keybinds(action);
    if (!specs?.length) return false;
    for (const specText of specs) {
      const spec = parseKeySpec(specText);
      if (spec && keyMatch(ev, spec)) return true;
      // OpenTUI reports Enter as "return" (kitty/legacy forms vary) — accept
      // both spellings in binds so alt+enter works whatever the parser emits
      const alias = spec && enterAlias(spec.name);
      if (alias && keyMatch(ev, { ...spec, name: alias })) return true;
    }
    return false;
  };

  // directional match for menu/sidebar contexts: plain and shift-extend binds
  // both steer the cursor there (shift+down while sidebar-focused moves sidebar
  // focus — it must not leak into a grid extend). Grid nav itself stays strict
  // (move* only; extend has its own branch).
  const hitDir = (ev: KeyPressEvent, plain: KeyAction, extend: KeyAction): boolean => hit(ev, plain) || hit(ev, extend);

  // does this event match any of the plugin's effective binds?
  const hitBinds = (ev: KeyPressEvent, binds: string[]): boolean => {
    for (const specText of binds) {
      const spec = parseKeySpec(specText);
      if (!spec) continue;
      if (keyMatch(ev, spec)) return true;
      const alias = enterAlias(spec.name);
      if (alias && keyMatch(ev, { ...spec, name: alias })) return true;
    }
    return false;
  };

  const setSidebarFocus = (idx: number): boolean => {
    if (idx < 0 || idx >= ctx.placesHost.length) return false;
    placeIdx = idx;
    ctx.normalizePlaces();
    return true;
  };

  const leaveSidebarToGrid = () => {
    sidebarActive = false;
    ctx.normalizePlaces();
  };

  const extendFromAnchor = (next: number): void => {
    if (selection.selAnchor() === null) {
      selection.setSelAnchor(selection.focusIdx() >= 0 ? selection.focusIdx() : 0);
    }
    if (next === selection.focusIdx() || next < 0 || next >= selection.focusKeys().length) return;
    selection.selectTileAt(next, true);
    selection.selectRange(selection.selAnchor()!, next);
    selection.updateSelectionStatusReal();
    void ctx.renderPreview();
  };

  // --- Precedence stages below: each returns true when it consumes the event.
  // Order is load-bearing (capture > quit/restart > prompt > bulk-rename > conflict >
  // yes/no > rename > props > esc-menu > terminal > path-edit > file menu >
  // search > sidebar > grid > actions) — do not reorder; mirrors the module
  // header. ---

  // Modal layers swallow everything while open (mostly mouse-driven dialogs).
  // true modals that keep their keys even above the pick overlay: floats
  // policy normally prevents modal+pick coexistence (opening one dismisses
  // the other), but a confirm opened over pick — or any open race — must not
  // leave esc dead. Called BEFORE the pick branch; handleModalKeys delegates.
  const handleOverlayModalKeys = (ev: KeyPressEvent): boolean => {
    // text prompt above everything (incl. pick): its Input owns typing, the
    // router just delegates keys and swallows the rest
    if (ctx.prompt?.isOpen()) {
      ctx.prompt.handleKey(ev);
      return true;
    }
    // bulk-rename modal: Textarea owns typing, esc closes (alt+enter reaches
    // the textarea's native submit binding through the same dispatch)
    if (ctx.bulkRename.isOpen()) {
      ctx.bulkRename.handleKey(ev);
      return true;
    }
    // override/conflict modal: esc = skip, everything else swallowed
    if (ctx.conflict.isOpen()) {
      if (ev.name === "escape") ctx.conflict.closeConflict("skip");
      return true;
    }
    // yes/no confirm: esc = No, arrows move the No/Yes cursor (focus starts
    // on No so a stray Enter is safe), openSelected activates it
    if (ctx.yesNo.isOpen()) {
      if (ev.name === "escape") ctx.yesNo.close();
      else if (hitDir(ev, "moveUp", "extendUp") || hitDir(ev, "moveLeft", "extendLeft")) ctx.yesNo.moveFocus(-1);
      else if (hitDir(ev, "moveDown", "extendDown") || hitDir(ev, "moveRight", "extendRight")) ctx.yesNo.moveFocus(1);
      else if (hit(ev, "openSelected")) ctx.yesNo.submit();
      return true;
    }
    // inline rename: the focused Input consumes typing; swallow everything
    // else so arrows/shortcuts don't move grid focus mid-edit (esc/enter
    // handled at the source via handleKeyPress / "enter")
    if (ctx.isRenaming()) return true;
    // floating properties dialog: esc/openSelected closes, else swallowed
    if (ctx.propsIsOpen()) {
      if (ev.name === "escape" || hit(ev, "openSelected")) ctx.closeProps();
      return true;
    }
    return false;
  };

  const handleModalKeys = (ev: KeyPressEvent): boolean => {
    if (handleOverlayModalKeys(ev)) return true;
    if (ctx.escMenu.isOpen()) {
      if (ev.name === "escape") ctx.escMenu.closeMenu();
      else if (hitDir(ev, "moveUp", "extendUp")) ctx.escMenu.moveMenu(-1);
      else if (hitDir(ev, "moveDown", "extendDown")) ctx.escMenu.moveMenu(1);
      else if (hitDir(ev, "moveLeft", "extendLeft")) ctx.escMenu.adjustSelectedSetting(-1);
      else if (hitDir(ev, "moveRight", "extendRight")) ctx.escMenu.adjustSelectedSetting(1);
      else if (ev.name === "tab") ctx.escMenu.menuTab();
      else if (hit(ev, "openSelected")) ctx.escMenu.menuActivate();
      return true;
    }
    // embedded terminal owns the keyboard while focused — everything below is
    // host UI. Toast once per focus visit, not per key, instead of
    // dead-ending silently: users otherwise think the app hung.
    if (ctx.termOwnsKeyboard()) {
      if (!termHintShown) {
        termHintShown = true;
        ctx.notify("Terminal owns keyboard — click the grid to leave", "terminal", "info");
      }
      return true;
    }
    termHintShown = false;
    if (ctx.pathInputVisible() || ctx.pathEditMode()) {
      if (ev.name === "escape") ctx.exitPathEdit();
      return true;
    }
    return false;
  };

  // File context menu: move*/openSelected navigate it (shared with the grid),
  // esc closes. A parent row's action fires on enter; its flyout opens on
  // right; while it is open, left/esc close it and up/down/enter act on it.
  // Returns true when the menu is open (it swallows all other keys while open).
  const stepFileMenu = (fmenu: NonNullable<ReturnType<KeyRouterCtx["getFileMenuState"]>>, delta: number): void => {
    const entries = fmenu.entries;
    const count = entries.length;
    if (count === 0) return;
    // idx -1 = no cursor yet: down fills the first row, up the last
    let i = fmenu.idx < 0 ? (delta >= 0 ? 0 : count - 1) : (fmenu.idx + delta + count) % count;
    // skip separators; bounded so an all-separator menu can't spin forever
    for (let n = 0; entries[i]?.sep && n < count; n++) i = (i + delta + count) % count;
    fmenu.idx = i;
    fmenu.subIdx = null; // moving to another parent closes the flyout
    ctx.renderFileMenu();
  };
  const activateFileMenu = (fmenu: NonNullable<ReturnType<KeyRouterCtx["getFileMenuState"]>>): void => {
    const entries = fmenu.entries;
    if (fmenu.subIdx !== null) {
      ctx.activateFileSubmenu();
      return;
    }
    if (fmenu.idx < 0) return; // no cursor yet: enter is a no-op
    // parent rows are directly clickable — enter fires the action, → opens
    // the flyout for the variants
    entries[fmenu.idx]?.action();
  };
  const handleFileMenuKeys = (ev: KeyPressEvent): boolean => {
    const fmenu = ctx.getFileMenuState();
    if (!fmenu) return false;
    const entries = fmenu.entries;
    const inSub = fmenu.subIdx !== null;
    if (ev.name === "escape") {
      if (inSub) ctx.closeFileSubmenu();
      else ctx.closeFileMenu();
    } else if (hitDir(ev, "moveUp", "extendUp")) {
      if (inSub) ctx.moveFileSubmenu(-1);
      else stepFileMenu(fmenu, -1);
    } else if (hitDir(ev, "moveDown", "extendDown")) {
      if (inSub) ctx.moveFileSubmenu(1);
      else stepFileMenu(fmenu, 1);
    } else if (hitDir(ev, "moveRight", "extendRight")) {
      if (!inSub && entries[fmenu.idx]?.submenu) ctx.openFileSubmenu();
    } else if (hitDir(ev, "moveLeft", "extendLeft")) {
      if (inSub) ctx.closeFileSubmenu();
    } else if (hit(ev, "openSelected")) {
      activateFileMenu(fmenu);
    }
    return true;
  };

  // Type-to-search commit/cancel. Returns true while the search box is open
  // (openSelected commits the first match, esc clears).
  const commitSearch = (): void => {
    // open the first folder match (dirs sort first in the filtered grid);
    // fall back to opening the first file match. The grid render is DEBOUNCED
    // 150ms after the first char, so a fast 2nd+ char + Enter can read a stale
    // pre-debounce listing — only open a match that still satisfies the query.
    const q = (ctx.searchQuery?.() ?? "").toLowerCase();
    const matchesQ = (k?: string): boolean => !q || !k || path.basename(k).toLowerCase().includes(q);
    const firstDir = selection.focusKeys().find((key) => selection.tileRefs.get(key)?.isDir && matchesQ(key));
    const fallback = selection.focusKeys().find((key) => matchesQ(key));
    const targetKey = firstDir ?? fallback;
    const refs = targetKey !== undefined ? selection.tileRefs.get(targetKey) : undefined;
    if (targetKey && refs) {
      if (refs.isDir) ctx.navigate(targetKey);
      else {
        ctx.openFileDefault(targetKey);
        ctx.clearSearch();
        void ctx.renderGrid();
      }
    } else {
      ctx.clearSearch();
      void ctx.renderGrid();
    }
  };
  const handleSearchKeys = (ev: KeyPressEvent): boolean => {
    if (!ctx.searchVisible()) return false;
    if (ev.name === "escape") {
      const had = !!ctx.searchQuery();
      ctx.clearSearch();
      if (had) void ctx.renderGrid();
      return true;
    }
    if (hit(ev, "openSelected")) commitSearch();
    return true;
  };

  // Extend binds grow the selection from the anchor instead of moving it
  // (defaults: shift+arrows). Returns true when the event matched an extend
  // bind (consumed either way, even on an empty listing).
  const extendBy = (next: number): void => {
    if (!selection.focusKeys().length) return;
    if (selection.selAnchor() === null) selection.setSelAnchor(selection.focusIdx() >= 0 ? selection.focusIdx() : 0);
    extendFromAnchor(next);
  };
  const handleShiftExtend = (ev: KeyPressEvent): boolean => {
    if (hit(ev, "extendUp")) {
      extendBy(selection.focusIdx() < 0 ? 0 : selection.focusIdx() - selection.colsAtBuild());
      return true;
    }
    if (hit(ev, "extendDown")) {
      extendBy(selection.focusIdx() < 0 ? 0 : selection.focusIdx() + selection.colsAtBuild());
      return true;
    }
    if (hit(ev, "extendLeft")) {
      if (selection.focusKeys().length && selection.focusIdx() > 0) extendFromAnchor(selection.focusIdx() - 1);
      return true;
    }
    if (hit(ev, "extendRight")) {
      if (selection.focusKeys().length && selection.focusIdx() < selection.focusKeys().length - 1)
        extendFromAnchor(selection.focusIdx() + 1);
      return true;
    }
    return false;
  };

  const activateSidebarPlace = (): void => {
    const rec = ctx.placesHost[placeIdx];
    if (!rec) return;
    ctx.closeFileMenu();
    sidebarActive = false;
    placeIdx = -1;
    const target =
      rec.place.scheme === "recent" ? RECENT_URI : rec.place.scheme === "starred" ? STARRED_URI : rec.place.path;
    if (target) ctx.navigate(target);
    else if (rec.place.mountDevice) ctx.mountDevice(rec.place.mountDevice);
  };

  // Sidebar keyboard focus (entered via moveLeft at the grid edge).
  // Returns true while sidebar focus is active (it swallows all keys).
  const handleSidebarKeys = (ev: KeyPressEvent): boolean => {
    if (!sidebarActive) return false;
    if (hitDir(ev, "moveUp", "extendUp")) setSidebarFocus(placeIdx - 1);
    else if (hitDir(ev, "moveDown", "extendDown")) setSidebarFocus(placeIdx + 1);
    else if (hitDir(ev, "moveLeft", "extendLeft") || hitDir(ev, "moveRight", "extendRight")) {
      leaveSidebarToGrid();
      selection.selectTileAt(selection.focusIdx() >= 0 ? selection.focusIdx() : 0);
    } else if (hit(ev, "openSelected")) activateSidebarPlace();
    return true;
  };

  const openFocusedTile = (): void => {
    if (selection.focusIdx() < 0) return;
    const key = selection.focusKeys()[selection.focusIdx()];
    const refs = key !== undefined ? selection.tileRefs.get(key) : undefined;
    if (key && refs) {
      if (refs.isDir) ctx.navigate(key);
      else ctx.openFileDefault(key);
    }
  };

  const enterSidebarFromGrid = (): void => {
    const selRec = ctx.placesHost.findIndex((place) => place.selected);
    const pressedKey = selection.focusIdx() >= 0 ? selection.focusKeys()[selection.focusIdx()] : undefined;
    if (pressedKey !== undefined) {
      const pressedRef = selection.tileRefs.get(pressedKey);
      if (pressedRef && !pressedRef.selected) selection.setTileVisual(pressedKey, TileVisual.Rest);
    }
    sidebarActive = true;
    setSidebarFocus(selRec >= 0 ? selRec : 0);
  };

  // Grid nav: move*/openSelected/page*/first/last binds. Returns true when the
  // key moved focus, opened a tile, or entered the sidebar.
  const handleGridNavKeys = (ev: KeyPressEvent): boolean => {
    if (hit(ev, "moveUp")) {
      selection.moveFocus(0, -1);
      return true;
    }
    if (hit(ev, "moveDown")) {
      selection.moveFocus(0, 1);
      return true;
    }
    if (hit(ev, "moveLeft")) {
      const atLeftEdge = selection.focusIdx() === -1 || selection.focusIdx() % selection.colsAtBuild() === 0;
      if (atLeftEdge || selection.focusKeys().length === 0) {
        enterSidebarFromGrid();
        return true;
      }
      selection.moveFocus(-1, 0);
      return true;
    }
    if (hit(ev, "moveRight")) {
      selection.moveFocus(1, 0);
      return true;
    }
    if (hit(ev, "openSelected")) {
      if (selection.focusIdx() >= 0) openFocusedTile();
      return true;
    }
    if (hit(ev, "pageUp")) {
      selection.pageBy(-1);
      return true;
    }
    if (hit(ev, "pageDown")) {
      selection.pageBy(1);
      return true;
    }
    if (hit(ev, "firstItem")) {
      selection.selectTileAt(0);
      return true;
    }
    if (hit(ev, "lastItem")) {
      selection.selectTileAt(selection.focusKeys().length - 1);
      return true;
    }
    return false;
  };

  // --- Action table: every remappable action as a callable closure. handleKey
  // below calls these (guards preserved at the call sites); the pick overlay
  // runs them through commands() — one table, two dispatchers, identical
  // behavior. Guarded actions (trash/copy/cut/rename) no-op on empty
  // selection instead of falling through: the chain pre-checks the guard so
  // keypress behavior is unchanged, while palette runs stay safe. ---
  const doQuit = (): void => {
    ctx.quit();
  };
  const doRestart = (): void => {
    ctx.restart();
  };
  const doHistBack = (): void => {
    ctx.goBack();
  };
  const doHistForward = (): void => {
    ctx.goFwd();
  };
  const doShowProps = (): void => {
    const sel = selection.selPaths();
    if (sel.length) ctx.openProperties(sel.map((s) => s.path));
    else if (!ctx.isVirtualCwd()) ctx.openProperties([ctx.state.cwd]);
  };
  const doNewFolder = (): void => {
    ctx.startInlineCreate("folder");
  };
  const doNewFile = (): void => {
    ctx.startInlineCreate("file");
  };
  const doPathEdit = (): void => {
    ctx.enterPathEdit();
  };
  const doTogglePreview = (): void => {
    ctx.togglePreview();
  };
  const doOpenTerminal = (): void => {
    ctx.openTerminal();
  };
  const doConnectServer = (): void => {
    ctx.connectServer();
  };
  const doToggleView = (): void => {
    ctx.toggleViewMode();
  };
  const doZoomIn = (): void => {
    ctx.zoomTiles(1);
  };
  const doZoomOut = (): void => {
    ctx.zoomTiles(-1);
  };
  const doToggleDualPane = (): void => {
    ctx.toggleDualPane();
  };
  const doSwitchPane = (): void => {
    ctx.switchPane();
  };
  const doCopyToOtherPane = (): void => {
    ctx.copyToOtherPane();
  };
  const doMoveToOtherPane = (): void => {
    ctx.moveToOtherPane();
  };
  const doParentDir = (): void => {
    // virtual views have no fs parent (path.resolve would shred the URI)
    if (ctx.isVirtualCwd()) {
      ctx.navigate(ctx.home);
      return;
    }
    const cwd = path.resolve(ctx.state.cwd);
    const parent = path.dirname(cwd);
    if (parent !== cwd) ctx.navigate(parent);
  };
  const doOpenMenu = (): void => {
    ctx.escMenu.openMenu();
  };
  const doToggleHidden = (): void => {
    ctx.state.showHidden = !ctx.state.showHidden;
    void ctx.renderGrid();
  };
  const doReloadPlaces = (): void => {
    void loadSystemPlaces().then(() => ctx.renderAll());
  };
  const doNewTab = (): void => {
    ctx.newTab();
  };
  const doCloseTab = (): void => {
    ctx.closeTab();
  };
  const doPrevTab = (): void => {
    ctx.prevTab();
  };
  const doNextTab = (): void => {
    ctx.nextTab();
  };
  const doSelectAll = (): void => {
    selection.selectAll();
  };
  const doTrash = (): void => {
    const selected = selection.selPaths();
    if (!selected.length) return;
    if (ctx.inTrashView()) {
      // no cursor coords in a keybind — the confirm dialog is a centered modal
      ctx.confirmDeleteForever(selected.map((item) => item.path));
    } else ctx.trashPaths(selected.map((item) => item.path));
  };
  const doRenameOrRestore = (): void => {
    const selected = selection.selPaths();
    if (!selected.length) return;
    // in the trash rename restores instead — single-only (bulk rename is an
    // fs rename, not a trashinfo restore)
    if (ctx.inTrashView()) {
      if (selected.length === 1) ctx.restoreFromTrash(selected.map((item) => item.path));
      return;
    }
    if (selected.length > 1) {
      ctx.startBulkRename(selected.map((item) => item.path));
      return;
    }
    const only = selected[0];
    if (only) ctx.startInlineRename(only.path);
  };
  const doCopy = (): void => {
    const selected = selection.selPaths();
    if (selected.length) ctx.setClipboard("copy", selected);
  };
  const doDuplicate = (): void => {
    const selected = selection.selPaths();
    if (!selected.length) return;
    // no fs destination in virtual views (cwd is a URI), no duplicate in trash
    if (ctx.isVirtualCwd() || ctx.inTrashView()) {
      ctx.notify("Can't duplicate here", "duplicate", "error");
      return;
    }
    ctx.duplicate(selected.map((s) => s.path));
  };
  const doCut = (): void => {
    const selected = selection.selPaths();
    if (selected.length) ctx.setClipboard("cut", selected);
  };
  const doPaste = (): void => {
    // virtual views and the trash aren't paste targets — say so instead of
    // swallowing the key (pasteSmart itself guards Trash/files too)
    if (ctx.isVirtualCwd() || ctx.inTrashView()) {
      ctx.notify("Can't paste here", "paste", "error");
      return;
    }
    ctx.pasteSmart(ctx.state.cwd);
  };
  const doRedo = (): void => {
    ctx.redoLast();
  };
  const doUndo = (): void => {
    ctx.undoLast();
  };
  // --- context-aware nav dispatchers for the commands() table: the palette
  // has no key event, so each run replicates the keypress precedence
  // (file menu > esc menu > sidebar/search > grid) for its direction ---
  const doMoveUp = (): void => {
    const fmenu = ctx.getFileMenuState();
    if (fmenu) {
      if (fmenu.subIdx !== null) ctx.moveFileSubmenu(-1);
      else stepFileMenu(fmenu, -1);
      return;
    }
    if (ctx.escMenu.isOpen()) {
      ctx.escMenu.moveMenu(-1);
      return;
    }
    if (sidebarActive) {
      setSidebarFocus(placeIdx - 1);
      return;
    }
    selection.moveFocus(0, -1);
  };
  const doMoveDown = (): void => {
    const fmenu = ctx.getFileMenuState();
    if (fmenu) {
      if (fmenu.subIdx !== null) ctx.moveFileSubmenu(1);
      else stepFileMenu(fmenu, 1);
      return;
    }
    if (ctx.escMenu.isOpen()) {
      ctx.escMenu.moveMenu(1);
      return;
    }
    if (sidebarActive) {
      setSidebarFocus(placeIdx + 1);
      return;
    }
    selection.moveFocus(0, 1);
  };
  const doMoveLeft = (): void => {
    const fmenu = ctx.getFileMenuState();
    if (fmenu) {
      if (fmenu.subIdx !== null) ctx.closeFileSubmenu();
      return;
    }
    if (ctx.escMenu.isOpen()) {
      ctx.escMenu.adjustSelectedSetting(-1);
      return;
    }
    if (sidebarActive) {
      leaveSidebarToGrid();
      selection.selectTileAt(selection.focusIdx() >= 0 ? selection.focusIdx() : 0);
      return;
    }
    const atLeftEdge = selection.focusIdx() === -1 || selection.focusIdx() % selection.colsAtBuild() === 0;
    if (atLeftEdge || selection.focusKeys().length === 0) enterSidebarFromGrid();
    else selection.moveFocus(-1, 0);
  };
  const doMoveRight = (): void => {
    const fmenu = ctx.getFileMenuState();
    if (fmenu) {
      if (fmenu.subIdx === null && fmenu.entries[fmenu.idx]?.submenu) ctx.openFileSubmenu();
      return;
    }
    if (ctx.escMenu.isOpen()) {
      ctx.escMenu.adjustSelectedSetting(1);
      return;
    }
    if (sidebarActive) {
      leaveSidebarToGrid();
      selection.selectTileAt(selection.focusIdx() >= 0 ? selection.focusIdx() : 0);
      return;
    }
    selection.moveFocus(1, 0);
  };
  const doOpenSelected = (): void => {
    const fmenu = ctx.getFileMenuState();
    if (fmenu) {
      activateFileMenu(fmenu);
      return;
    }
    if (ctx.escMenu.isOpen()) {
      ctx.escMenu.menuActivate();
      return;
    }
    if (ctx.searchVisible()) {
      commitSearch();
      return;
    }
    if (sidebarActive) {
      activateSidebarPlace();
      return;
    }
    openFocusedTile();
  };
  const doExtendUp = (): void => {
    extendBy(selection.focusIdx() < 0 ? 0 : selection.focusIdx() - selection.colsAtBuild());
  };
  const doExtendDown = (): void => {
    extendBy(selection.focusIdx() < 0 ? 0 : selection.focusIdx() + selection.colsAtBuild());
  };
  const doExtendLeft = (): void => {
    if (selection.focusKeys().length && selection.focusIdx() > 0) extendFromAnchor(selection.focusIdx() - 1);
  };
  const doExtendRight = (): void => {
    if (selection.focusKeys().length && selection.focusIdx() < selection.focusKeys().length - 1)
      extendFromAnchor(selection.focusIdx() + 1);
  };
  const doToggleFocused = (): void => {
    selection.toggleFocused();
  };
  const doInvertSelection = (): void => {
    selection.invertSelection();
  };
  const doStartSearch = (): void => {
    ctx.enableTypeToSearch();
    ctx.notify("type-to-search on · type to filter, esc clears", "search", "info");
  };
  const doCycleSort = (): void => {
    ctx.cycleSort();
  };
  const doGoHome = (): void => {
    ctx.navigate(ctx.home);
  };
  const doPageUp = (): void => {
    selection.pageBy(-1);
  };
  const doPageDown = (): void => {
    selection.pageBy(1);
  };
  const doFirstItem = (): void => {
    selection.selectTileAt(0);
  };
  const doLastItem = (): void => {
    selection.selectTileAt(selection.focusKeys().length - 1);
  };

  const labelOf = (action: KeyAction): string => KEY_SCHEMA.find((r) => r.action === action)?.label ?? action;

  // KEY_SCHEMA order (config order) doubles as the palette listing order
  const ACTION_TABLE: Array<{ action: KeyAction; run: () => void }> = [
    { action: "quit", run: doQuit },
    { action: "restart", run: doRestart },
    { action: "openMenu", run: doOpenMenu },
    { action: "toggleHidden", run: doToggleHidden },
    { action: "reloadPlaces", run: doReloadPlaces },
    { action: "newTab", run: doNewTab },
    { action: "closeTab", run: doCloseTab },
    { action: "nextTab", run: doNextTab },
    { action: "prevTab", run: doPrevTab },
    { action: "selectAll", run: doSelectAll },
    { action: "trash", run: doTrash },
    { action: "renameOrRestore", run: doRenameOrRestore },
    { action: "copy", run: doCopy },
    { action: "cut", run: doCut },
    { action: "duplicate", run: doDuplicate },
    { action: "paste", run: doPaste },
    { action: "undo", run: doUndo },
    { action: "redo", run: doRedo },
    { action: "parentDir", run: doParentDir },
    { action: "histBack", run: doHistBack },
    { action: "histForward", run: doHistForward },
    { action: "showProps", run: doShowProps },
    { action: "newFolder", run: doNewFolder },
    { action: "newFile", run: doNewFile },
    { action: "pathEdit", run: doPathEdit },
    { action: "togglePreview", run: doTogglePreview },
    { action: "openTerminal", run: doOpenTerminal },
    { action: "connectServer", run: doConnectServer },
    { action: "toggleView", run: doToggleView },
    { action: "zoomIn", run: doZoomIn },
    { action: "zoomOut", run: doZoomOut },
    { action: "toggleDualPane", run: doToggleDualPane },
    { action: "switchPane", run: doSwitchPane },
    { action: "copyToOtherPane", run: doCopyToOtherPane },
    { action: "moveToOtherPane", run: doMoveToOtherPane },
    { action: "moveUp", run: doMoveUp },
    { action: "moveDown", run: doMoveDown },
    { action: "moveLeft", run: doMoveLeft },
    { action: "moveRight", run: doMoveRight },
    { action: "openSelected", run: doOpenSelected },
    { action: "extendUp", run: doExtendUp },
    { action: "extendDown", run: doExtendDown },
    { action: "extendLeft", run: doExtendLeft },
    { action: "extendRight", run: doExtendRight },
    { action: "pageUp", run: doPageUp },
    { action: "pageDown", run: doPageDown },
    { action: "firstItem", run: doFirstItem },
    { action: "lastItem", run: doLastItem },
    { action: "toggleFocused", run: doToggleFocused },
    { action: "invertSelection", run: doInvertSelection },
    { action: "startSearch", run: doStartSearch },
    { action: "cycleSort", run: doCycleSort },
    { action: "goHome", run: doGoHome },
  ];

  // fresh titles/hints on every call so remaps apply without rebuilds
  const commands = (): Command[] =>
    ACTION_TABLE.map(({ action, run }) => ({
      id: action,
      title: labelOf(action),
      hint: ctx.keybinds(action).join(" "),
      run,
    }));

  const handleKey = (ev: KeyPressEvent): void => {
    const ctrl = !!ev.ctrl || !!ev.control;
    // keybind capture in the settings panel is the ONE state above quit:
    // recording ctrl+q must not quit the app mid-capture
    if (ctx.escMenu.captureKey(ev)) return;
    if (hit(ev, "quit")) {
      doQuit();
      return;
    }
    // held restart must not queue overlapping teardown/spawn pairs
    if (hit(ev, "restart") && ev.repeated !== true) {
      doRestart();
      return;
    }
    // a true modal open above the pick overlay keeps its keys (see
    // handleOverlayModalKeys) — esc must reach a confirm opened over pick.
    if (handleOverlayModalKeys(ev)) return;
    // pick overlay (command palette) open: it swallows everything below
    // (typing reaches its focused Input natively, like type-to-search)
    if (ctx.pick.isOpen()) {
      ctx.pick.handleKey(ev);
      return;
    }
    if (handleModalKeys(ev)) return;

    // file context menu open: arrows/enter navigate it, esc closes.
    // getFileMenuState() returns the LIVE state object — mutating fmenu.idx
    // below updates the menu module's state in place.
    if (handleFileMenuKeys(ev)) return;
    if (handleSearchKeys(ev)) return;

    // --- remappable action keys that grid nav would otherwise swallow:
    // handleGridNavKeys consumes bare arrows/return regardless of modifiers,
    // so alt+arrows and alt+enter must dispatch BEFORE it (plain arrows and
    // return are unaffected — they match no bind unless remapped onto one) ---
    if (hit(ev, "histBack") && ev.repeated !== true) {
      doHistBack();
      return;
    }
    if (hit(ev, "histForward") && ev.repeated !== true) {
      doHistForward();
      return;
    }
    if (hit(ev, "goHome")) {
      doGoHome();
      return;
    }
    if (hit(ev, "showProps")) {
      doShowProps();
      return;
    }
    if (hit(ev, "newFolder") && ev.repeated !== true) {
      doNewFolder();
      return;
    }
    if (hit(ev, "newFile") && ev.repeated !== true) {
      doNewFile();
      return;
    }
    if (hit(ev, "pathEdit")) {
      doPathEdit();
      return;
    }
    if (hit(ev, "togglePreview") && ev.repeated !== true) {
      doTogglePreview();
      return;
    }
    if (hit(ev, "openTerminal")) {
      doOpenTerminal();
      return;
    }
    if (hit(ev, "connectServer")) {
      doConnectServer();
      return;
    }
    if (hit(ev, "toggleView")) {
      doToggleView();
      return;
    }
    if (hit(ev, "cycleSort") && ev.repeated !== true) {
      doCycleSort();
      return;
    }
    if (hit(ev, "zoomIn")) {
      doZoomIn();
      return;
    }
    if (hit(ev, "zoomOut")) {
      doZoomOut();
      return;
    }
    if (hit(ev, "toggleDualPane") && ev.repeated !== true) {
      doToggleDualPane();
      return;
    }
    if (hit(ev, "switchPane") && ev.repeated !== true) {
      doSwitchPane();
      return;
    }
    if (hit(ev, "copyToOtherPane") && ev.repeated !== true) {
      doCopyToOtherPane();
      return;
    }
    if (hit(ev, "moveToOtherPane") && ev.repeated !== true) {
      doMoveToOtherPane();
      return;
    }
    if (hit(ev, "startSearch")) {
      doStartSearch();
      return;
    }

    // --- keyboard navigation: sidebar <-> grid ---
    // sidebar focus swallows ALL keys — it must precede shift-extend or
    // shift+arrows would mutate the grid selection while the sidebar is
    // focused (it returns false when inactive, so grid extend is unchanged)
    if (handleSidebarKeys(ev)) return;
    if (handleShiftExtend(ev)) return;
    if (handleGridNavKeys(ev)) return;
    if (hit(ev, "parentDir")) {
      doParentDir();
      return;
    }
    // type-to-search catch-all: gated on the [ui] knob (the yazi preset
    // flips it off — bound bare keys already dispatched above regardless)
    if (
      ctx.typeToSearchEnabled() &&
      !ctrl &&
      !ev.shift &&
      !ev.meta &&
      !ev.option &&
      typeof ev.name === "string" &&
      ev.name.length === 1 &&
      /[a-z0-9._-]/i.test(ev.name)
    ) {
      ctx.beginTypeToSearch(ev.name);
      return;
    }

    if (hit(ev, "openMenu")) {
      doOpenMenu();
      return;
    }
    if (hit(ev, "toggleHidden") && ev.repeated !== true) {
      doToggleHidden();
      return;
    }
    if (hit(ev, "reloadPlaces") && ev.repeated !== true) {
      doReloadPlaces();
      return;
    }

    // --- tabs (kitty needs map no_op for ctrl+tab / ctrl+shift+tab — its
    // default next_tab/previous_tab eat the keys before they reach us) ---
    if (hit(ev, "newTab")) {
      doNewTab();
      return;
    }
    if (hit(ev, "closeTab")) {
      doCloseTab();
      return;
    }
    if (hit(ev, "prevTab")) {
      doPrevTab();
      return;
    }
    if (hit(ev, "nextTab")) {
      doNextTab();
      return;
    }

    // --- file operations ---
    if (hit(ev, "selectAll")) {
      doSelectAll();
      return;
    }
    if (hit(ev, "toggleFocused")) {
      doToggleFocused();
      return;
    }
    if (hit(ev, "invertSelection")) {
      doInvertSelection();
      return;
    }
    const selected = selection.selPaths();
    // terminal autorepeat (ev.repeated) must never enqueue fs work: holding
    // ctrl+d used to start one real copy per keypress until the native
    // renderer OOM'd (crash log: "Failed to create SyntaxStyle"). copy/cut
    // stay reachable on repeat (idempotent clipboard writes); rename is
    // already guarded by the inline-edit modal swallowing keys.
    const repeated = ev.repeated === true;
    if (hit(ev, "trash") && selected.length && !repeated) {
      doTrash();
      return;
    }
    if (hit(ev, "renameOrRestore") && selected.length) {
      doRenameOrRestore();
      return;
    }
    if (hit(ev, "copy") && selected.length) {
      doCopy();
      return;
    }
    if (hit(ev, "cut") && selected.length) {
      doCut();
      return;
    }
    if (hit(ev, "duplicate") && selected.length && !repeated) {
      doDuplicate();
      return;
    }
    if (hit(ev, "paste") && !repeated) {
      doPaste();
      return;
    }
    if (hit(ev, "redo")) {
      doRedo();
      return;
    }
    if (hit(ev, "undo")) {
      doUndo();
      return;
    }

    // --- plugin commands: LAST, after every core action — "core wins ties"
    // means a plugin defaultBind colliding with ctrl+t/ctrl+c/ctrl+z must NOT
    // swallow the core op. Nav keys (move*/openSelected) and structural keys
    // (esc-close/tab/type-to-search) preempt above too: validateKeybindSpec
    // accepts key NAMES like enter/arrows, so a plugin registering one is
    // shadowed silently by the core bind — remap the core bind to free the key.
    if (ctx.pluginCommands) {
      try {
        for (const cmd of ctx.pluginCommands()) {
          if (cmd.binds.length && hitBinds(ev, cmd.binds)) {
            // invokeIsolated: async plugin runs must not reject unhandled
            invokeIsolated(
              () => cmd.run(),
              () => {},
            );
            return;
          }
        }
      } catch {}
    }
  };

  return {
    handleKey,
    commands,
    // kb-focus highlight read by makeChrome
    sidebarActive: (): boolean => sidebarActive,
    placeIdx: (): number => placeIdx,
    setSidebarFocus,
    leaveSidebarToGrid,
  };
};
