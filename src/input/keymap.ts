// --- Keyboard router: ONE keypress entry point with a strict precedence
// chain — capture > quit > overlay-modals (prompt/bulk-rename/conflict/yes-no/rename/
// props, which keep their keys even above an open pick) > pick > esc-menu >
// terminal > path-edit > file menu > search > sidebar > grid > actions.
// Action keys are remappable via config [keys] (see config-schema.ts);
// modal-internal nav (arrows/enter/esc inside menus) and type-to-search stay
// structural. The order IS load-bearing — do not reorder; handleKey below is
// the canonical sequence, this header mirrors it.
// Every remappable action ALSO lives in the commands() table (same closures)
// so the pick overlay runs exactly what the keypress would. ---
import path from "node:path";
import { RECENT_URI, STARRED_URI } from "../fs/uri";
import { loadSystemPlaces } from "../fs/places";
import type { KeyAction } from "../config/config-schema";
import { KEY_SCHEMA, keyMatch, parseKeySpec } from "../config/config-schema";
import type { Command } from "../lib/command";
import { invokeIsolated } from "../lib/uiutil";
import type { Selection } from "./selection";
import { TileVisual } from "./grid-input";

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
  byId(id: string): any;
  state: KeyState;
  // live keybind lookup — reads config.keys so remaps apply without rebuilds
  keybinds(action: KeyAction): string[];
  quit(): void;
  // --- modal layers (precedence order) ---
  conflict: { isOpen(): boolean; closeConflict(policy: "skip"): void };
  yesNo: { isOpen(): boolean; close(): void };
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
  getFileMenuState(): { idx: number; entries: Array<{ sep?: boolean; action(): void }> } | null;
  closeFileMenu(): void;
  renderFileMenu(): void;
  // --- tabs ---
  tabModel: { active: number; list: unknown[] };
  newTab(): void;
  closeTab(): void;
  switchTab(i: number): void;
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
  togglePreview(): void;
  toggleViewMode(): void;
  zoomTiles(dir: number): void;
  setClipboard(mode: "copy" | "cut", items: Array<{ path: string; isDir: boolean }>): void;
  duplicate(paths: string[]): void;
  isVirtualCwd(): boolean;
  pasteSmart(dir: string): void;
  setStatusMsg(msg: string): void;
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
    selection.selectTileAt(next);
    selection.selectRange(selection.selAnchor()!, next);
    selection.updateSelectionStatusReal();
    void ctx.renderPreview();
  };

  // --- Precedence stages below: each returns true when it consumes the event.
  // Order is load-bearing (capture > quit > prompt > bulk-rename > conflict >
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
    // yes/no confirm: esc = No, everything else swallowed
    if (ctx.yesNo.isOpen()) {
      if (ev.name === "escape") ctx.yesNo.close();
      return true;
    }
    // inline rename: the focused Input consumes typing; swallow everything
    // else so arrows/shortcuts don't move grid focus mid-edit (esc/enter
    // handled at the source via handleKeyPress / "enter")
    if (ctx.isRenaming()) return true;
    // floating properties dialog: esc/enter closes, everything else swallowed
    if (ctx.propsIsOpen()) {
      if (ev.name === "escape" || ev.name === "return") ctx.closeProps();
      return true;
    }
    return false;
  };

  const handleModalKeys = (ev: KeyPressEvent): boolean => {
    if (handleOverlayModalKeys(ev)) return true;
    if (ctx.escMenu.isOpen()) {
      if (ev.name === "escape") ctx.escMenu.closeMenu();
      else if (ev.name === "up") ctx.escMenu.moveMenu(-1);
      else if (ev.name === "down") ctx.escMenu.moveMenu(1);
      else if (ev.name === "left") ctx.escMenu.adjustSelectedSetting(-1);
      else if (ev.name === "right") ctx.escMenu.adjustSelectedSetting(1);
      else if (ev.name === "tab") ctx.escMenu.menuTab();
      else if (ev.name === "return") ctx.escMenu.menuActivate();
      return true;
    }
    // embedded terminal owns the keyboard while focused — everything below is
    // host UI. Say so on the status bar (once per focus visit, not per key)
    // instead of dead-ending silently: users otherwise think the app hung.
    if (ctx.termOwnsKeyboard()) {
      if (!termHintShown) {
        termHintShown = true;
        ctx.setStatusMsg("Terminal owns keyboard — click the grid to leave");
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

  // File context menu: arrows move, enter activates, esc closes. Returns true
  // when the menu is open (it swallows all other keys while open).
  const handleFileMenuKeys = (ev: KeyPressEvent): boolean => {
    const fmenu = ctx.getFileMenuState();
    if (!fmenu) return false;
    const entries = fmenu.entries;
    const count = entries.length;
    const step = (delta: number) => {
      // skip separators; bounded so an all-separator menu can't spin forever
      let i = (fmenu.idx + delta + count) % count;
      for (let n = 0; entries[i]?.sep && n < count; n++) i = (i + delta + count) % count;
      fmenu.idx = i;
      ctx.renderFileMenu();
    };
    if (ev.name === "escape") ctx.closeFileMenu();
    else if (ev.name === "up") step(-1);
    else if (ev.name === "down") step(1);
    else if (ev.name === "return") entries[fmenu.idx]?.action();
    return true;
  };

  // Type-to-search commit/cancel. Returns true while the search box is open
  // (enter opens the first match, esc clears).
  const handleSearchKeys = (ev: KeyPressEvent): boolean => {
    if (!ctx.searchVisible()) return false;
    if (ev.name === "escape") {
      const had = !!ctx.searchQuery();
      ctx.clearSearch();
      if (had) void ctx.renderGrid();
      return true;
    }
    // enter commits: open the first folder match (dirs sort first in the
    // filtered grid); fall back to opening the first file match
    if (ev.name === "return") {
      const firstDir = selection.focusKeys().find((key) => selection.tileRefs.get(key)?.isDir);
      const targetKey = firstDir ?? selection.focusKeys()[0];
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
    }
    return true;
  };

  // Shift+arrows extend the selection from the anchor instead of moving it.
  // Returns true when the event was a shift+arrow (consumed either way).
  const handleShiftExtend = (ev: KeyPressEvent, ctrl: boolean): boolean => {
    if (!(ev.shift && !ctrl)) return false;
    if (ev.name === "up") {
      if (selection.focusKeys().length) {
        if (selection.selAnchor() === null)
          selection.setSelAnchor(selection.focusIdx() >= 0 ? selection.focusIdx() : 0);
        extendFromAnchor(selection.focusIdx() < 0 ? 0 : selection.focusIdx() - selection.colsAtBuild());
      }
      return true;
    }
    if (ev.name === "down") {
      if (selection.focusKeys().length) {
        if (selection.selAnchor() === null)
          selection.setSelAnchor(selection.focusIdx() >= 0 ? selection.focusIdx() : 0);
        extendFromAnchor(selection.focusIdx() < 0 ? 0 : selection.focusIdx() + selection.colsAtBuild());
      }
      return true;
    }
    if (ev.name === "left") {
      if (selection.focusKeys().length && selection.focusIdx() > 0) extendFromAnchor(selection.focusIdx() - 1);
      return true;
    }
    if (ev.name === "right") {
      if (selection.focusKeys().length && selection.focusIdx() < selection.focusKeys().length - 1)
        extendFromAnchor(selection.focusIdx() + 1);
      return true;
    }
    return false;
  };

  // Sidebar keyboard focus (entered via left-arrow at the grid edge).
  // Returns true while sidebar focus is active (it swallows all keys).
  const handleSidebarKeys = (ev: KeyPressEvent): boolean => {
    if (!sidebarActive) return false;
    if (ev.name === "up") setSidebarFocus(placeIdx - 1);
    else if (ev.name === "down") setSidebarFocus(placeIdx + 1);
    else if (ev.name === "left" || ev.name === "right") {
      leaveSidebarToGrid();
      selection.selectTileAt(selection.focusIdx() >= 0 ? selection.focusIdx() : 0);
    } else if (ev.name === "return") {
      const rec = ctx.placesHost[placeIdx];
      if (rec) {
        ctx.closeFileMenu();
        sidebarActive = false;
        placeIdx = -1;
        const target =
          rec.place.scheme === "recent" ? RECENT_URI : rec.place.scheme === "starred" ? STARRED_URI : rec.place.path;
        if (target) ctx.navigate(target);
        else if (rec.place.mountDevice) ctx.mountDevice(rec.place.mountDevice);
      }
    }
    return true;
  };

  // Grid arrows/enter. Returns true when the key moved focus or opened a tile.
  const handleGridNavKeys = (ev: KeyPressEvent): boolean => {
    if (ev.name === "up") {
      selection.moveFocus(0, -1);
      return true;
    }
    if (ev.name === "down") {
      selection.moveFocus(0, 1);
      return true;
    }
    if (ev.name === "left") {
      const atLeftEdge = selection.focusIdx() === -1 || selection.focusIdx() % selection.colsAtBuild() === 0;
      if (atLeftEdge || selection.focusKeys().length === 0) {
        const selRec = ctx.placesHost.findIndex((place) => place.selected);
        const pressedKey = selection.focusIdx() >= 0 ? selection.focusKeys()[selection.focusIdx()] : undefined;
        if (pressedKey !== undefined) {
          const pressedRef = selection.tileRefs.get(pressedKey);
          if (pressedRef && !pressedRef.selected) selection.setTileVisual(pressedKey, TileVisual.Rest);
        }
        sidebarActive = true;
        setSidebarFocus(selRec >= 0 ? selRec : 0);
        return true;
      }
      selection.moveFocus(-1, 0);
      return true;
    }
    if (ev.name === "right") {
      selection.moveFocus(1, 0);
      return true;
    }
    if (ev.name === "return" && selection.focusIdx() >= 0) {
      const key = selection.focusKeys()[selection.focusIdx()];
      const refs = key !== undefined ? selection.tileRefs.get(key) : undefined;
      if (key && refs) {
        if (refs.isDir) ctx.navigate(key);
        else ctx.openFileDefault(key);
      }
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
  const doToggleView = (): void => {
    ctx.toggleViewMode();
  };
  const doZoomIn = (): void => {
    ctx.zoomTiles(1);
  };
  const doZoomOut = (): void => {
    ctx.zoomTiles(-1);
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
    ctx.switchTab(ctx.tabModel.active === 0 ? ctx.tabModel.list.length - 1 : ctx.tabModel.active - 1);
  };
  const doNextTab = (): void => {
    ctx.switchTab(ctx.tabModel.active === ctx.tabModel.list.length - 1 ? 0 : ctx.tabModel.active + 1);
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
      ctx.setStatusMsg("Can't duplicate here");
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
      ctx.setStatusMsg("Can't paste here");
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

  const labelOf = (action: KeyAction): string => KEY_SCHEMA.find((r) => r.action === action)?.label ?? action;

  // KEY_SCHEMA order (config order) doubles as the palette listing order
  const ACTION_TABLE: Array<{ action: KeyAction; run: () => void }> = [
    { action: "quit", run: doQuit },
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
    { action: "toggleView", run: doToggleView },
    { action: "zoomIn", run: doZoomIn },
    { action: "zoomOut", run: doZoomOut },
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
    if (hit(ev, "histBack")) {
      doHistBack();
      return;
    }
    if (hit(ev, "histForward")) {
      doHistForward();
      return;
    }
    if (hit(ev, "showProps")) {
      doShowProps();
      return;
    }
    if (hit(ev, "newFolder")) {
      doNewFolder();
      return;
    }
    if (hit(ev, "newFile")) {
      doNewFile();
      return;
    }
    if (hit(ev, "pathEdit")) {
      doPathEdit();
      return;
    }
    if (hit(ev, "togglePreview")) {
      doTogglePreview();
      return;
    }
    if (hit(ev, "openTerminal")) {
      doOpenTerminal();
      return;
    }
    if (hit(ev, "toggleView")) {
      doToggleView();
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

    // --- plugin commands (core wins ties — checked first above) ---
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

    // --- keyboard navigation: sidebar <-> grid ---
    // sidebar focus swallows ALL keys — it must precede shift-extend or
    // shift+arrows would mutate the grid selection while the sidebar is
    // focused (it returns false when inactive, so grid extend is unchanged)
    if (handleSidebarKeys(ev)) return;
    if (handleShiftExtend(ev, ctrl)) return;
    if (handleGridNavKeys(ev)) return;
    if (hit(ev, "parentDir")) {
      doParentDir();
      return;
    }
    if (!ctrl && !ev.shift && typeof ev.name === "string" && ev.name.length === 1 && /[a-z0-9._-]/i.test(ev.name)) {
      ctx.beginTypeToSearch(ev.name);
      return;
    }

    if (hit(ev, "openMenu")) {
      doOpenMenu();
      return;
    }
    if (hit(ev, "toggleHidden")) {
      doToggleHidden();
      return;
    }
    if (hit(ev, "reloadPlaces")) {
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
