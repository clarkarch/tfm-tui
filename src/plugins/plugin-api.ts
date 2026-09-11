// --- Plugin API: the ONLY surface plugins may touch. Core never imports
// plugin code statically (plugins live outside src/, loaded by dynamic
// import in ./plugins) — a plugin that wants more than this gets a warn at
// load and nothing else. Add capabilities here (with a version bump), never
// by letting plugins reach into core modules. ---
// Leaf module: erased types plus dependency-free runtime helpers over them
// (bind accessors below) — no imports beyond types, so ui/ AND fs/ can use
// it without layering violations or import cycles.

import type { SettingRow } from "../ui/settings";
import type { Command } from "../lib/command";
import type { PluginEventName, PluginEventPayload } from "../lib/plugin-events";
import type { FileOpHookDecision, FileOpHookPayload } from "../lib/plugin-hooks";

export const PLUGIN_API_VERSION = 3;

// plugin names become path segments — reject anything that could escape
export const PLUGIN_NAME_RE = /^[a-z0-9][a-z0-9_-]*$/i;

// per-plugin JSON state (plugins/<name>/state.json). Synchronous on purpose:
// SettingRow get/set closures are sync, so the store loads once and writes
// through on set. Namespaced by the loader: api.store() always returns the
// CALLING plugin's own store regardless of the name argument (cross-plugin
// reads warn and return the caller's store instead).
export type PluginStore = {
  get<T>(key: string, fallback: T): T;
  set(key: string, value: unknown): void;
};

export type PluginApi = {
  notify(message: string, title?: string): void;
  setStatusMsg(message: string): void;
  log(message: string): void;
  store(pluginName: string): PluginStore;
  // live file-manager context (read at call time, never cached by plugins):
  // the current multi-selection and cwd. Spawning helpers (xdg-open, ffmpeg…)
  // is the plugin's own job — Bun gives it full node:child_process, so core
  // exposes no process wrappers.
  selection(): Array<{ path: string; isDir: boolean }>;
  cwd(): string;
  // action surface — drive tfm, not just observe it. navigate flips the cwd,
  // open launches a file's default app, reveal jumps to a file's folder and
  // highlights it, select replaces the grid selection with the given paths
  // (paths not currently listed are ignored).
  navigate(dir: string): void;
  open(path: string): void;
  reveal(path: string): void;
  select(paths: string[]): void;
  // every dispatchable action, core table first then plugin contributions in
  // load order. Prefer LAZY calls (inside run/open): the keymap wires last,
  // so a top-level call during your own activate sees only plugin commands
  // (never throws — the core half appears post-boot).
  commands(): Command[];
  // generic filter-list overlay (the pick widget): any plugin gets fuzzy
  // lists over arbitrary items — the palette is just the first client.
  // confirm is the floating Yes/No dialog; notifySticky pins a toast in the
  // same stack (returns a closer). All three are isolated: a throwing
  // callback never breaks core UI.
  ui: {
    pick(opts: { title: string; items: Array<{ label: string; hint?: string; run: () => void }> }): void;
    confirm(opts: { title: string; body?: string; danger?: boolean }): Promise<boolean>;
    // single-line text input (the prompt widget the installer uses). Resolves
    // the trimmed value, or null on cancel/close.
    prompt(opts: { title: string; value?: string; placeholder?: string; okLabel?: string }): Promise<string | null>;
    notifySticky(message: string, title?: string): () => void;
  };
  // push channel (polling selection()/cwd() is the pull fallback).
  // Subscribe at activate top level; MUST unsubscribe in deactivate —
  // the loader does not auto-remove listeners (it can't reach your closure).
  // Listeners must be SYNC: quit fires inside the synchronous teardown path
  // (process.exit kills pending async IO), so an async quit listener can
  // never complete — flush files in deactivate instead.
  events: {
    on<E extends PluginEventName>(evt: E, cb: (payload: PluginEventPayload[E]) => void): () => void;
  };
  // INTERCEPT channel: veto a file operation before core starts it. Sync-only
  // and first-skip-wins; return { skip: true, reason? } to block. Unsubscribe
  // on deactivate like events listeners.
  hooks: {
    beforeFileOp(fn: (payload: FileOpHookPayload) => FileOpHookDecision): () => void;
  };
};

// one plugin-contributed command. ids should be namespaced ("name:verb") —
// the loader warns on non-namespaced ids but loads anyway. defaultBinds are
// key specs in config-schema syntax ("ctrl+g"); the user can remap them in
// the Plugins view (persisted in the plugin's own store, conflict-checked
// against core [keys] + other plugins). Bare letters/numbers are rejected
// like core binds (reserved for type-to-search).
export type PluginCommand = {
  id: string;
  title: string;
  hint?: string;
  run: () => void;
  defaultBinds?: string[];
};

// one file-context-menu entry. The plugin receives the selection-aware paths
// (whole selection when the right-clicked tile is part of it, else the tile)
// and runs with them after core closes the menu.
export type PluginFileMenuEntry = {
  label: string;
  hint?: string;
  run: (paths: string[]) => void;
};

// one preview contribution: render a file's preview as text. exts are
// lowercase without dots (["csv", "tsv"]). render() may be async; a throw or
// empty string falls through to core's default preview. Long renders race
// the gen-counter like core file reads (stale results dropped).
export type PluginPreview = {
  exts: string[];
  render: (path: string) => string | Promise<string>;
};

// what activate() may return. Rows render in the esc menu's dedicated
// Plugins view (one category per plugin); fileMenu builders append entries
// to the file context menu with the live selection; commands join the
// api.commands() list the palette plugin shows. May be async — the loader
// awaits it (a slow activate blocks only its own load). deactivate runs on
// unload/remove/disable so timers/listeners/children never leak.
type PluginActivateResult = {
  rows?: SettingRow[];
  fileMenu?: (sel: { paths: string[] }) => PluginFileMenuEntry[];
  // sidebar right-click (place target) + empty-area right-click (cwd).
  // Same entry shape as fileMenu; run() receives [target] / [cwd].
  sidebarMenu?: (place: { path?: string | null; scheme?: string }) => PluginFileMenuEntry[];
  emptyAreaMenu?: (area: { cwd: string }) => PluginFileMenuEntry[];
  commands?: PluginCommand[];
  // preview renderers by extension (checked before core's text/image/video
  // branches). First plugin in load order whose exts match wins.
  preview?: PluginPreview[];
  // OpenTUI slot contributions: return real renderables for tfm's UI regions
  // ("statusbar", "sidebar-footer"). Structural (no @opentui import here) —
  // the ctx/data shape is documented in docs/plugins.md. Requires the plugin
  // file to import @opentui/core (runtime support is installed at boot).
  slots?: Record<string, (ctx: Readonly<object>, data: object) => unknown>;
  deactivate?: () => void | Promise<void>;
};

export type PluginModule = {
  name: string;
  // optional manifest metadata, surfaced in the Plugins view for transparency
  version?: string;
  author?: string;
  description?: string;
  apiVersion?: number;
  minApiVersion?: number;
  activate: (api: PluginApi) => PluginActivateResult | undefined | Promise<PluginActivateResult | undefined>;
  deactivate?: () => void | Promise<void>;
};

// effective binds for a plugin command: user remap in the plugin's own store
// (key `keys:<id>`) wins, else the command's defaultBinds, else []. Lives
// here (not the fs-heavy loader) so the settings model can read it without
// importing node:fs into ui/.
export const getPluginCommandBinds = (plugin: LoadedPlugin, cmdId: string): string[] => {
  try {
    const cmd = plugin.commands.find((c) => c.id === cmdId);
    const fallback = cmd?.defaultBinds ?? [];
    const v: unknown = plugin.store.get(`keys:${cmdId}`, fallback);
    return Array.isArray(v) && v.every((s) => typeof s === "string") ? [...(v as string[])] : [...fallback];
  } catch {
    return [];
  }
};

export const setPluginCommandBinds = (plugin: LoadedPlugin, cmdId: string, binds: string[]): void => {
  plugin.store.set(`keys:${cmdId}`, [...binds]);
};

// plugin-contributed commands as dispatchable Command[] (hint falls back to
// "" — most plugin commands carry no bind); core table comes first at callers
export const flattenPluginCommands = (plugins: Array<{ commands: PluginCommand[] }>): Command[] =>
  plugins.flatMap((p) => p.commands.map((c) => ({ ...c, hint: c.hint ?? "" })));

// one installed plugin, as the loader hands it to the settings model and
// the menu builders: its rows, its file-menu builder (null when the plugin
// contributes none), its commands, and its own store (the model builds the
// on/off toggle over it). deactivate is the result-level hook if present,
// else the module-level one, else null. file is the main path (reload key).
export type LoadedPlugin = {
  name: string;
  version: string;
  author: string;
  description: string;
  rows: SettingRow[];
  fileMenu: ((sel: { paths: string[] }) => PluginFileMenuEntry[]) | null;
  sidebarMenu: ((place: { path?: string | null; scheme?: string }) => PluginFileMenuEntry[]) | null;
  emptyAreaMenu: ((area: { cwd: string }) => PluginFileMenuEntry[]) | null;
  commands: PluginCommand[];
  preview: PluginPreview[];
  store: PluginStore;
  deactivate: (() => void | Promise<void>) | null;
  // slot contributions' unregister (set when the plugin returned `slots`);
  // called on reload/remove/quit so registry entries never leak
  disposeSlots?: (() => void) | null;
  file: string;
};
