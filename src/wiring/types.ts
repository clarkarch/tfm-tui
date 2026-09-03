// --- The wiring cluster types, hand-written in ONE leaf module. Why not
// `ReturnType<typeof wireX>`: the wire functions reference each other's wiring
// types through their deps, so those aliases would be circular. Why one leaf:
// per-module definitions made the wiring files import each other's types,
// which cycles (chrome ↔ grid ↔ grid-foundation ↔ nav — type-only edges, but
// they erase at runtime and muddy the layering). src/imports.test.ts fails the
// suite if any cycle (type-only included) reappears. Factory return types come
// from the widget/pure modules — never from sibling wiring files. ---

import type { createCliRenderer } from "@opentui/core";
import type { BandCtx } from "../input/grid-input";
import type { makeRenderAll } from "../app/render-all";
import type { makeQuit } from "../app/quit";
import type { makeStatus } from "../ui/ui-status";
import type { makeNav, makeSessionSync } from "../app/nav";
import type { makeTabs } from "../app/tabs";
import type { makeSearch } from "../input/search";
import type { makeMenu } from "../ui/ui-menu";
import type { makeChrome } from "../ui/ui-chrome";
import type { makeToolbar } from "../ui/ui-toolbar";
import type { makeNotify } from "../ui/notify";
import type { makeRecentOpen } from "../fs/recent-open";
import type { makeDialogs } from "../ui/ui-dialogs";
import type { makeSelection } from "../input/selection";
import type { makeRename } from "../ui/ui-rename";
import type { makeUndo } from "../app/undo";
import type { makeConflict, makeYesNo } from "../ui/ui-dialogs";
import type { makeProgress } from "../ui/ui-progress";
import type { makeFileOps } from "../fs/fileops";
import type { makeTerminal } from "../ui/ui-term";
import type { makeTrashConfirms, makeTrashOps } from "../fs/trashops";
import type { makePreview } from "../ui/ui-preview";
import type { makeGridRenderer } from "../ui/ui-grid";
import type { makeProps } from "../ui/ui-props";
import type { makeMenuEntries } from "../ui/menu-entries";
import type { makeSettingModel } from "../ui/settings-model";
import type { makeEscMenu } from "../ui/ui-settings";

export type NavWiring = {
  renderAll: ReturnType<typeof makeRenderAll>;
  quitApp: ReturnType<typeof makeQuit>;
  setStatusMsg: ReturnType<typeof makeStatus>["setStatusMsg"];
  tabModel: ReturnType<typeof makeTabs>;
  search: ReturnType<typeof makeSearch>;
} & Pick<ReturnType<typeof makeNav>, "canBack" | "canFwd" | "goBack" | "goFwd" | "navigate"> &
  Pick<ReturnType<typeof makeTabs>, "switchTab" | "newTab" | "closeTab" | "syncTabFromState"> &
  Pick<ReturnType<typeof makeSessionSync>, "scheduleSaveSession" | "restoreSession"> &
  Pick<ReturnType<typeof makeSearch>, "clearSearch" | "beginTypeToSearch" | "wireSearchInput">;

export type ChromeWiring = {
  renderer: Awaited<ReturnType<typeof createCliRenderer>>;
  menu: ReturnType<typeof makeMenu>;
  chrome: ReturnType<typeof makeChrome>;
  toolbar: ReturnType<typeof makeToolbar>;
  notify: ReturnType<typeof makeNotify>["notify"];
  notifySticky: ReturnType<typeof makeNotify>["notifySticky"];
  openFileDefault: ReturnType<typeof makeRecentOpen>["openFileDefault"];
  dialogs: ReturnType<typeof makeDialogs>;
};

export type GridFoundationWiring = {
  selection: ReturnType<typeof makeSelection>;
  rename: ReturnType<typeof makeRename>;
};

export type FileopsWiring = {
  undo: ReturnType<typeof makeUndo>;
  conflict: ReturnType<typeof makeConflict>;
  progress: ReturnType<typeof makeProgress>;
  fileops: ReturnType<typeof makeFileOps>;
  terminal: ReturnType<typeof makeTerminal>;
  trash: ReturnType<typeof makeTrashOps>;
  yesNo: ReturnType<typeof makeYesNo>;
  confirmYesNo: ReturnType<typeof makeYesNo>["confirm"];
} & ReturnType<typeof makeTrashConfirms>;

export type GridWiring = {
  renderPreview: ReturnType<typeof makePreview>["renderPreview"];
  renderGrid: ReturnType<typeof makeGridRenderer>["renderGrid"];
  finishDrag: () => void;
  bandCtx: BandCtx;
  props: ReturnType<typeof makeProps>;
  menuEntries: ReturnType<typeof makeMenuEntries>;
};

export type SettingsWiring = {
  settingGroups: ReturnType<typeof makeSettingModel>["settingGroups"];
  escMenu: ReturnType<typeof makeEscMenu>;
};
