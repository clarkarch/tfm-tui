// tfm plugin API types (apiVersion 3). For editor autocomplete in a plugin:
//
//   /// <reference path="/abs/path/to/plugins-sample/tfm-api.d.ts" />
//
// HAND-MAINTAINED mirror of src/plugins/plugin-api.ts — keep in sync when core
// bumps PLUGIN_API_VERSION.

export type TfmSettingRow =
  | { kind: "action"; label: string; run: () => void; keepOpen?: boolean }
  | { kind: "toggle"; label: string; get: () => boolean; set: (v: boolean) => void; repaint?: boolean }
  | { kind: "number"; label: string; get: () => number; set: (v: number) => void }
  | { kind: "text"; label: string; get: () => string; set: (v: string) => void }
  | { kind: "keybind"; label: string; get: () => string[]; set: (v: string[]) => void };

export type TfmMenuItem = {
  label: string;
  hint?: string;
  run: (paths: string[]) => void;
};

export type TfmCommand = {
  id: string;
  title: string;
  hint?: string;
  run: () => void;
  defaultBinds?: string[];
};

export type TfmPreview = {
  exts: string[];
  render: (path: string) => string | Promise<string>;
};

export type TfmEventPayload = {
  navigate: { dir: string };
  selection: { paths: string[] };
  "file-op": { op: string; paths: string[]; dest?: string; outcome?: { cancelled: boolean; failed: number } };
  trash: { op: string; paths: string[] };
  undo: { op: string; label: string };
  theme: { preset: string; theme?: unknown };
  quit: Record<string, never>;
  boot: Record<string, never>;
};

export type TfmFileOpHook = (payload: {
  op: "copy" | "move" | "rename" | "duplicate" | "trash" | "restore" | "delete-forever" | "empty" | string;
  paths: string[];
  dest?: string;
}) => // biome-ignore lint/suspicious/noConfusingVoidType: hooks may return nothing
{ skip?: boolean; reason?: string } | undefined | void;

export type TfmStore = {
  get<T>(key: string, fallback: T): T;
  set(key: string, value: unknown): void;
};

export type TfmApi = {
  notify(message: string, title?: string): void;
  setStatusMsg(message: string): void;
  log(message: string): void;
  store(name: string): TfmStore;
  selection(): Array<{ path: string; isDir: boolean }>;
  cwd(): string;
  navigate(dir: string): void;
  open(path: string): void;
  reveal(path: string): void;
  select(paths: string[]): void;
  commands(): Array<{ id: string; title: string; hint?: string; run: () => void }>;
  ui: {
    pick(opts: { title: string; items: Array<{ label: string; hint?: string; run: () => void }> }): void;
    confirm(opts: { title: string; body?: string; danger?: boolean }): Promise<boolean>;
    prompt(opts: { title: string; value?: string; placeholder?: string; okLabel?: string }): Promise<string | null>;
    notifySticky(message: string, title?: string): () => void;
  };
  events: {
    on<E extends keyof TfmEventPayload>(evt: E, cb: (payload: TfmEventPayload[E]) => void): () => void;
  };
  hooks: {
    beforeFileOp(fn: TfmFileOpHook): () => void;
  };
};

export type TfmSlotContext = {
  app: string;
  version: string;
  renderer: () => unknown;
  colors: () => unknown;
  cwd: () => string;
  selection: () => string[];
};

export type TfmSlotData = { cwd: string; selection: string[] };

export type TfmPluginActivateResult = {
  rows?: TfmSettingRow[];
  fileMenu?: (sel: { paths: string[] }) => TfmMenuItem[];
  sidebarMenu?: (place: { path?: string | null; scheme?: string }) => TfmMenuItem[];
  emptyAreaMenu?: (area: { cwd: string }) => TfmMenuItem[];
  commands?: TfmCommand[];
  preview?: TfmPreview[];
  // OpenTUI renderables for tfm's regions; import @opentui/core and build nodes
  slots?: Partial<
    Record<"statusbar" | "sidebar-footer", (ctx: Readonly<TfmSlotContext>, data: TfmSlotData) => unknown>
  >;
  deactivate?: () => void | Promise<void>;
};

export type TfmPluginModule = {
  name: string;
  version?: string;
  author?: string;
  description?: string;
  apiVersion?: number;
  minApiVersion?: number;
  activate: (api: TfmApi) => TfmPluginActivateResult | undefined | Promise<TfmPluginActivateResult | undefined>;
  deactivate?: () => void | Promise<void>;
};
