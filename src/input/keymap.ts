// --- Keyboard router: ONE keypress entry point with a strict precedence
// chain — quit > capture > conflict > yes/no > rename > props > esc-menu >
// terminal > path-edit > file menu > search > sidebar > grid. Action keys are
// remappable via config [keys] (see config-schema.ts); modal-internal nav
// (arrows/enter/esc inside menus) and type-to-search stay structural. The
// modal chain order IS load-bearing — do not reorder. ---
import path from "node:path";
import { RECENT_URI, STARRED_URI } from "../fs/uri";
import { loadSystemPlaces } from "../fs/places";
import type { KeyAction } from "../config/config-schema";
import { keyMatch, parseKeySpec } from "../config/config-schema";
import type { Selection } from "./selection";
import { TileVisual } from "./grid-input";

// Keypress shape the router actually reads. The renderer hands a richer
// object (scan codes, text, meta); dispatch only touches name + modifiers.
export type KeyPressEvent = {
  name?: string;
  shift?: boolean;
  ctrl?: boolean;
  control?: boolean;
  [extra: string]: unknown;
};

// structural subset of index's AppState — the router only touches these
export type KeyState = {
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
  trashPaths(paths: string[]): void;
  restoreFromTrash(paths: string[]): void;
  startInlineRename(p: string): void;
  setClipboard(mode: "copy" | "cut", items: Array<{ path: string; isDir: boolean }>): void;
  isVirtualCwd(): boolean;
  pasteSmart(dir: string): void;
  undoLast(): void;
  redoLast(): void;
};

export const makeKeyRouter = (ctx: KeyRouterCtx) => {
  const { selection } = ctx;

  // sidebar keyboard focus
  let sidebarActive = false;
  let placeIdx = -1;

  // does this event match any configured bind for the action?
  const hit = (ev: KeyPressEvent, action: KeyAction): boolean => {
    const specs = ctx.keybinds(action);
    if (!specs?.length) return false;
    for (const specText of specs) {
      const spec = parseKeySpec(specText);
      if (spec && keyMatch(ev, spec)) return true;
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
  // Order is load-bearing (capture > quit > conflict > yes/no > rename >
  // props > esc-menu > terminal > path-edit > file menu > search > sidebar >
  // grid > actions) — do not reorder. ---

  // Modal layers swallow everything while open (mostly mouse-driven dialogs).
  const handleModalKeys = (ev: KeyPressEvent): boolean => {
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
    // host UI. Click the grid/sidebar (or ✕) to leave the shell.
    if (ctx.termOwnsKeyboard()) return true;
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
      let i = (fmenu.idx + delta + count) % count;
      while (entries[i]?.sep) i = (i + delta + count) % count;
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

  const handleKey = (ev: KeyPressEvent): void => {
    const ctrl = !!ev.ctrl || !!ev.control;
    // keybind capture in the settings panel is the ONE state above quit:
    // recording ctrl+q must not quit the app mid-capture
    if (ctx.escMenu.captureKey(ev)) return;
    if (hit(ev, "quit")) {
      ctx.quit();
      return;
    }
    if (handleModalKeys(ev)) return;

    // file context menu open: arrows/enter navigate it, esc closes.
    // getFileMenuState() returns the LIVE state object — mutating fmenu.idx
    // below updates the menu module's state in place.
    if (handleFileMenuKeys(ev)) return;
    if (handleSearchKeys(ev)) return;

    // --- keyboard navigation: sidebar <-> grid ---
    if (handleShiftExtend(ev, ctrl)) return;
    if (handleSidebarKeys(ev)) return;
    if (handleGridNavKeys(ev)) return;
    if (hit(ev, "parentDir")) {
      // virtual views have no fs parent (path.resolve would shred the URI)
      if (ctx.isVirtualCwd()) {
        ctx.navigate(ctx.home);
        return;
      }
      const cwd = path.resolve(ctx.state.cwd);
      const parent = path.dirname(cwd);
      if (parent !== cwd) ctx.navigate(parent);
      return;
    }
    if (!ctrl && !ev.shift && typeof ev.name === "string" && ev.name.length === 1 && /[a-z0-9._-]/i.test(ev.name)) {
      ctx.beginTypeToSearch(ev.name);
      return;
    }

    if (hit(ev, "openMenu")) {
      ctx.escMenu.openMenu();
      return;
    }
    if (hit(ev, "toggleHidden")) {
      ctx.state.showHidden = !ctx.state.showHidden;
      void ctx.renderGrid();
      return;
    }
    if (hit(ev, "reloadPlaces")) {
      void loadSystemPlaces().then(() => ctx.renderAll());
      return;
    }

    // --- tabs (kitty needs map no_op for ctrl+tab / ctrl+shift+tab — its
    // default next_tab/previous_tab eat the keys before they reach us) ---
    if (hit(ev, "newTab")) {
      ctx.newTab();
      return;
    }
    if (hit(ev, "closeTab")) {
      ctx.closeTab();
      return;
    }
    if (hit(ev, "prevTab")) {
      ctx.switchTab(ctx.tabModel.active === 0 ? ctx.tabModel.list.length - 1 : ctx.tabModel.active - 1);
      return;
    }
    if (hit(ev, "nextTab")) {
      ctx.switchTab(ctx.tabModel.active === ctx.tabModel.list.length - 1 ? 0 : ctx.tabModel.active + 1);
      return;
    }

    // --- file operations ---
    if (hit(ev, "selectAll")) {
      selection.selectAll();
      return;
    }
    const selected = selection.selPaths();
    if (hit(ev, "trash") && selected.length) {
      if (ctx.inTrashView()) {
        // no cursor coords in a keybind — the confirm dialog is a centered modal
        ctx.confirmDeleteForever(selected.map((item) => item.path));
      } else ctx.trashPaths(selected.map((item) => item.path));
      return;
    }
    if (hit(ev, "renameOrRestore") && selected.length === 1 && selected[0]) {
      // in the trash rename restores instead
      if (ctx.inTrashView()) {
        ctx.restoreFromTrash(selected.map((item) => item.path));
        return;
      }
      ctx.startInlineRename(selected[0].path);
      return;
    }
    if (hit(ev, "copy") && selected.length) {
      ctx.setClipboard("copy", selected);
      return;
    }
    if (hit(ev, "cut") && selected.length) {
      ctx.setClipboard("cut", selected);
      return;
    }
    if (hit(ev, "paste") && !ctx.isVirtualCwd() && !ctx.inTrashView()) {
      ctx.pasteSmart(ctx.state.cwd);
      return;
    }
    if (hit(ev, "redo")) {
      ctx.redoLast();
      return;
    }
    if (hit(ev, "undo")) {
      ctx.undoLast();
      return;
    }
  };

  return {
    handleKey,
    // kb-focus highlight read by makeChrome
    sidebarActive: (): boolean => sidebarActive,
    placeIdx: (): number => placeIdx,
    setSidebarFocus,
    leaveSidebarToGrid,
  };
};
