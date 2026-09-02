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
  searchVisible(): boolean;
  searchQuery(): string;
  clearSearch(): void;
  exitPathEdit(): void;
  beginTypeToSearch(ch: string): void;
  renderGrid(): void | Promise<void>;
  renderPreview(): void | Promise<void>;
  renderAll(): void;
  selection: Selection;
  // sidebar kb-focus state (read by makeChrome for the highlight)
  placesHost: Array<{ selected: boolean; place: { scheme?: string; path?: string | null; mountDevice?: string } }>;
  normalizePlaces(): void;
  mountDevice(dev: string): void;
  navigate(dir: string): void;
  openFileDefault(p: string): void;
  // file menu
  getFileMenuState(): { idx: number; entries: Array<{ sep?: boolean; action(): void }> } | null;
  closeFileMenu(): void;
  renderFileMenu(): void;
  // tabs
  tabModel: { active: number; list: unknown[] };
  newTab(): void;
  closeTab(): void;
  switchTab(i: number): void;
  // file ops
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
  const hit = (e: any, action: KeyAction): boolean => {
    const specs = ctx.keybinds(action);
    if (!specs?.length) return false;
    for (const s of specs) {
      const spec = parseKeySpec(s);
      if (spec && keyMatch(e, spec)) return true;
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

  const handleKey = (e: any): void => {
    const ctrl = !!e.ctrl || !!e.control;
    // keybind capture in the settings panel is the ONE state above quit:
    // recording ctrl+q must not quit the app mid-capture
    if (ctx.escMenu.captureKey(e)) return;
    if (hit(e, "quit")) {
      ctx.quit();
      return;
    }
    // override/conflict modal: esc = skip, everything else swallowed (mouse-driven)
    if (ctx.conflict.isOpen()) {
      if (e.name === "escape") ctx.conflict.closeConflict("skip");
      return;
    }

    // yes/no confirm: esc = No, everything else swallowed (mouse-driven)
    if (ctx.yesNo.isOpen()) {
      if (e.name === "escape") ctx.yesNo.close();
      return;
    }

    // inline rename: the focused Input consumes typing; swallow everything else
    // so arrows/shortcuts don't move grid focus mid-edit (esc/enter handled at
    // the source via handleKeyPress / "enter")
    if (ctx.isRenaming()) return;

    // floating properties dialog: esc/enter closes, everything else swallowed
    if (ctx.propsIsOpen()) {
      if (e.name === "escape" || e.name === "return") ctx.closeProps();
      return;
    }

    if (ctx.escMenu.isOpen()) {
      if (e.name === "escape") ctx.escMenu.closeMenu();
      else if (e.name === "up") ctx.escMenu.moveMenu(-1);
      else if (e.name === "down") ctx.escMenu.moveMenu(1);
      else if (e.name === "left") ctx.escMenu.adjustSelectedSetting(-1);
      else if (e.name === "right") ctx.escMenu.adjustSelectedSetting(1);
      else if (e.name === "tab") ctx.escMenu.menuTab();
      else if (e.name === "return") ctx.escMenu.menuActivate();
      return;
    }

    // embedded terminal owns the keyboard while focused — everything below is
    // host UI. Click the grid/sidebar (or ✕) to leave the shell.
    if (ctx.termOwnsKeyboard()) return;

    if (ctx.pathInputVisible() || ctx.pathEditMode()) {
      if (e.name === "escape") {
        ctx.exitPathEdit();
      }
      return;
    }

    // file context menu open: arrows/enter navigate it, esc closes.
    // getFileMenuState() returns the LIVE state object — mutating fmenu.idx
    // below updates the menu module's state in place.
    const fmenu = ctx.getFileMenuState();
    if (fmenu) {
      const entries = fmenu.entries;
      const count = entries.length;
      const step = (d: number) => {
        let i = (fmenu.idx + d + count) % count;
        while (entries[i]?.sep) i = (i + d + count) % count;
        fmenu.idx = i;
        ctx.renderFileMenu();
      };
      if (e.name === "escape") ctx.closeFileMenu();
      else if (e.name === "up") step(-1);
      else if (e.name === "down") step(1);
      else if (e.name === "return") entries[fmenu.idx]?.action();
      return;
    }

    if (ctx.searchVisible()) {
      if (e.name === "escape") {
        const had = !!ctx.searchQuery();
        ctx.clearSearch();
        if (had) void ctx.renderGrid();
        return;
      }
      // enter commits: open the first folder match (dirs sort first in the
      // filtered grid); fall back to opening the first file match
      if (e.name === "return") {
        const firstDir = selection.focusKeys().find((k) => selection.tileRefs.get(k)?.isDir);
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
      return;
    }

    // --- keyboard navigation: sidebar <-> grid ---
    // shift+arrows extend the selection from the anchor instead of moving it
    if (e.shift && !ctrl && e.name === "up") {
      if (selection.focusKeys().length) {
        if (selection.selAnchor() === null)
          selection.setSelAnchor(selection.focusIdx() >= 0 ? selection.focusIdx() : 0);
        extendFromAnchor(selection.focusIdx() < 0 ? 0 : selection.focusIdx() - selection.colsAtBuild());
      }
      return;
    }
    if (e.shift && !ctrl && e.name === "down") {
      if (selection.focusKeys().length) {
        if (selection.selAnchor() === null)
          selection.setSelAnchor(selection.focusIdx() >= 0 ? selection.focusIdx() : 0);
        extendFromAnchor(selection.focusIdx() < 0 ? 0 : selection.focusIdx() + selection.colsAtBuild());
      }
      return;
    }
    if (e.shift && !ctrl && e.name === "left") {
      if (selection.focusKeys().length && selection.focusIdx() > 0) extendFromAnchor(selection.focusIdx() - 1);
      return;
    }
    if (e.shift && !ctrl && e.name === "right") {
      if (selection.focusKeys().length && selection.focusIdx() < selection.focusKeys().length - 1)
        extendFromAnchor(selection.focusIdx() + 1);
      return;
    }

    if (sidebarActive) {
      if (e.name === "up") {
        setSidebarFocus(placeIdx - 1);
        return;
      }
      if (e.name === "down") {
        setSidebarFocus(placeIdx + 1);
        return;
      }
      if (e.name === "left" || e.name === "right") {
        leaveSidebarToGrid();
        selection.selectTileAt(selection.focusIdx() >= 0 ? selection.focusIdx() : 0);
        return;
      }
      if (e.name === "return") {
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
        return;
      }
      return;
    }

    if (e.name === "up") {
      selection.moveFocus(0, -1);
      return;
    }
    if (e.name === "down") {
      selection.moveFocus(0, 1);
      return;
    }
    if (e.name === "left") {
      const atLeftEdge = selection.focusIdx() === -1 || selection.focusIdx() % selection.colsAtBuild() === 0;
      if (atLeftEdge || selection.focusKeys().length === 0) {
        const selRec = ctx.placesHost.findIndex((p) => p.selected);
        const pk = selection.focusIdx() >= 0 ? selection.focusKeys()[selection.focusIdx()] : undefined;
        if (pk !== undefined) {
          const pr = selection.tileRefs.get(pk);
          if (pr && !pr.selected) selection.setTileVisual(pk, 0);
        }
        sidebarActive = true;
        setSidebarFocus(selRec >= 0 ? selRec : 0);
        return;
      }
      selection.moveFocus(-1, 0);
      return;
    }
    if (e.name === "right") {
      selection.moveFocus(1, 0);
      return;
    }
    if (e.name === "return" && selection.focusIdx() >= 0) {
      const key = selection.focusKeys()[selection.focusIdx()];
      const refs = key !== undefined ? selection.tileRefs.get(key) : undefined;
      if (key && refs) {
        if (refs.isDir) ctx.navigate(key);
        else ctx.openFileDefault(key);
      }
      return;
    }
    if (hit(e, "parentDir")) {
      const cwd = path.resolve(ctx.state.cwd);
      const parent = path.dirname(cwd);
      if (parent !== cwd) ctx.navigate(parent);
      return;
    }
    if (!ctrl && !e.shift && typeof e.name === "string" && e.name.length === 1 && /[a-z0-9._-]/i.test(e.name)) {
      ctx.beginTypeToSearch(e.name);
      return;
    }

    if (hit(e, "openMenu")) {
      ctx.escMenu.openMenu();
      return;
    }
    if (hit(e, "toggleHidden")) {
      ctx.state.showHidden = !ctx.state.showHidden;
      void ctx.renderGrid();
      return;
    }
    if (hit(e, "reloadPlaces")) {
      void loadSystemPlaces().then(() => ctx.renderAll());
      return;
    }

    // --- tabs (kitty needs map no_op for ctrl+tab / ctrl+shift+tab — its
    // default next_tab/previous_tab eat the keys before they reach us) ---
    if (hit(e, "newTab")) {
      ctx.newTab();
      return;
    }
    if (hit(e, "closeTab")) {
      ctx.closeTab();
      return;
    }
    if (hit(e, "prevTab")) {
      ctx.switchTab(ctx.tabModel.active === 0 ? ctx.tabModel.list.length - 1 : ctx.tabModel.active - 1);
      return;
    }
    if (hit(e, "nextTab")) {
      ctx.switchTab(ctx.tabModel.active === ctx.tabModel.list.length - 1 ? 0 : ctx.tabModel.active + 1);
      return;
    }

    // --- file operations ---
    if (hit(e, "selectAll")) {
      selection.selectAll();
      return;
    }
    const selected = selection.selPaths();
    if (hit(e, "trash") && selected.length) {
      if (ctx.inTrashView()) {
        // no cursor coords in a keybind — the confirm dialog is a centered modal
        ctx.confirmDeleteForever(selected.map((s) => s.path));
      } else ctx.trashPaths(selected.map((s) => s.path));
      return;
    }
    if (hit(e, "renameOrRestore") && selected.length === 1 && selected[0]) {
      // in the trash rename restores instead
      if (ctx.inTrashView()) {
        ctx.restoreFromTrash(selected.map((s) => s.path));
        return;
      }
      ctx.startInlineRename(selected[0].path);
      return;
    }
    if (hit(e, "copy") && selected.length) {
      ctx.setClipboard("copy", selected);
      return;
    }
    if (hit(e, "cut") && selected.length) {
      ctx.setClipboard("cut", selected);
      return;
    }
    if (hit(e, "paste") && !ctx.isVirtualCwd()) {
      ctx.pasteSmart(ctx.state.cwd);
      return;
    }
    if (hit(e, "redo")) {
      ctx.redoLast();
      return;
    }
    if (hit(e, "undo")) {
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
