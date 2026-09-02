// --- The wiring cluster types, hand-written in ONE leaf module. Why not
// `ReturnType<typeof wireX>`: the wire functions reference each other's wiring
// types through their deps, so those aliases would be circular. Why one leaf:
// per-module definitions made the wiring files import each other's types,
// which cycles (chrome ↔ grid ↔ grid-foundation ↔ nav — type-only edges, but
// they erase at runtime and muddy the layering). src/imports.test.ts fails the
// suite if any cycle (type-only included) reappears. Factory return types come
// from the widget/pure modules — never from sibling wiring files. ---

import type { createCliRenderer } from "@opentui/core";
import type { BandCtx } from "../grid-input";
import type { makeRenderAll } from "../render-all";
import type { makeQuit } from "../quit";
import type { makeStatus } from "../ui-status";
import type { makeNav, makeSessionSync } from "../nav";
import type { makeTabs } from "../tabs";
import type { makeSearch } from "../search";
import type { makeMenu } from "../ui-menu";
import type { makeChrome } from "../ui-chrome";
import type { makeToolbar } from "../ui-toolbar";
import type { makeNotify } from "../notify";
import type { makeRecentOpen } from "../recent-open";
import type { makeDialogs } from "../ui-dialogs";
import type { makeSelection } from "../selection";
import type { makeRename } from "../ui-rename";
import type { makeUndo } from "../undo";
import type { makeConflict, makeYesNo } from "../ui-dialogs";
import type { makeProgress } from "../ui-progress";
import type { makeFileOps } from "../fileops";
import type { makeTerminal } from "../ui-term";
import type { makeTrashConfirms, makeTrashOps } from "../trashops";
import type { makePreview } from "../ui-preview";
import type { makeGridRenderer } from "../ui-grid";
import type { makeProps } from "../ui-props";
import type { makeMenuEntries } from "../menu-entries";
import type { makeSettingModel } from "../settings-model";
import type { makeEscMenu } from "../ui-settings";

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
  toastCount: ReturnType<typeof makeNotify>["toastCount"];
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
