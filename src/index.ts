// --- tfm — composition root. All logic lives in the ./modules it wires; this
// file (plus ./wiring/*) only instantiates them, in one load-bearing order.
// Cross-cluster references that point backwards in that order are TDZ arrows
// (the wiring modules receive them as getters) — the same seam rule the
// widget factories use internally. Order:
//   core → nav → chrome (renderer boots here) → grid foundation → fileops →
//   plugins → grid → settings → watcher → boot → retheme → dnd → resize → keymap ---
//
// The app graph loads LAZILY (dynamic imports below): --version must answer
// in milliseconds, not after OpenTUI natives + the whole graph load (~250ms).

import pkg from "../package.json";
import { statSync } from "node:fs";

if (process.argv.includes("--version") || process.argv.includes("-v")) {
  console.log(`tfm ${pkg.version}`);
  process.exit(0);
}

// optional launch dir (`tfm ~/some/path`): chdir before anything resolves
// the cwd, so tabs/history/session all start there. Static imports above are
// already hoisted, but none of them touch the cwd — only the graph below
// does. Non-dirs warn on stderr (pre-alternate-screen, so it stays visible).
const { launchDirFromArgv } = await import("./app/boot");
const launchDir = launchDirFromArgv(process.argv);
if (launchDir) {
  try {
    if (statSync(launchDir).isDirectory()) process.chdir(launchDir);
    else console.error(`tfm: not a directory: ${launchDir}`);
  } catch {
    console.error(`tfm: not a directory: ${launchDir}`);
  }
}

// wall-clock start precedes the graph load so the launch toast tells the
// truth about startup (imports were ~200ms of it, silently uncounted before)
const bootStart = performance.now();

const { appendLog, isDebug } = await import("./app/log");
const { wireCore } = await import("./wiring/core");
const { wireNav } = await import("./wiring/nav");
const { wireChrome } = await import("./wiring/chrome");
const { wireGridFoundation } = await import("./wiring/grid-foundation");
const { wireFileops } = await import("./wiring/fileops");
const { wireGrid } = await import("./wiring/grid");
const { wirePlugins } = await import("./wiring/plugins");
const { wireSettings, wireRetheme } = await import("./wiring/settings");
const { wireWatcher, wireBoot, wireDnd, wireResize } = await import("./wiring/io");
const { wireKeymap } = await import("./wiring/keymap");

if (isDebug) appendLog(`tfm starting pid=${process.pid} argv=[${process.argv.slice(1).join(" ")}]`);

// --- core: config, theme, lookup, icon slots, floats, app state, geometry ---
const core = wireCore({
  renderer: () => chrome.renderer,
  clipboard: () => fileops.fileops.clipboard(),
});

// --- nav: renderAll, quit, status, history, tabs, session, type-to-search ---
const nav = wireNav({
  core,
  getChrome: () => chrome,
  getDnd: () => dnd,
  getGridFoundation: () => gridFoundation,
  getGrid: () => grid,
  getTermHasFocus: () => fileops.terminal.termHasFocus(),
  getTerm: () => fileops.terminal,
  getWatcher: () => watcher,
});

// --- chrome: file menu, sidebar, toolbar, renderer boot, notify, dialogs ---
const chrome = await wireChrome({
  core,
  nav,
  getGrid: () => grid,
  getFileops: () => fileops,
  getKeyRouter: () => keymap.keyRouter,
  finishDrag: () => grid.finishDrag(),
});

// --- grid foundation: selection + inline rename (before fileops — its ctx
// takes refreshCutVisuals directly) ---
const gridFoundation = wireGridFoundation({
  core,
  nav,
  chrome,
  getGrid: () => grid,
  getFileops: () => fileops,
});

// --- fileops: undo, conflict, progress, copy/move/paste, terminal, trash ---
const fileops = wireFileops({
  core,
  nav,
  chrome,
  gridFoundation,
  finishDrag: () => grid.finishDrag(),
});

// --- plugins: user extensions (after fileops — api context needs selection
// + nav/chrome sinks; before grid — menu entries merge plugin sections;
// before settings — aggregated rows feed the settings model) ---
// getKeymap/getPick close over `keymap`, which wires LAST — wirePlugins
// degrades both via tdzSafe until the keymap exists, so an eager plugin
// calling api.commands()/ui.pick at activate top level gets []/noop instead
// of a TDZ throw (lazy post-boot calls see the full table).
const plugins = await wirePlugins({
  core,
  nav,
  chrome,
  gridFoundation,
  getKeymap: () => ({ commands: () => keymap.keyRouter.commands() }),
  getPick: () => keymap.pick,
  getConfirm: () => fileops.yesNo,
});

// --- grid: preview, mouse pipeline, grid renderer, props, menu entries ---
const grid = wireGrid({
  core,
  nav,
  chrome,
  gridFoundation,
  fileops,
  plugins,
});

// --- settings: settings model + esc menu ---
// getPrompt closes over `keymap`, which wires LAST — only called from
// post-boot installer rows, so the TDZ is settled by first use (same seam
// as wirePlugins' getKeymap/getPick above).
const settings = wireSettings({
  core,
  nav,
  chrome,
  grid,
  plugins,
  getRetheme: () => retheme,
  getPrompt: () => keymap.prompt,
});

// --- watcher → boot → retheme: the boot sequence starts between the esc-menu
// and the retheme wiring, exactly like the old flat wiring ---
const watcher = wireWatcher({
  core,
  getGridFoundation: () => gridFoundation,
  getGrid: () => grid,
});

wireBoot({
  core,
  nav,
  chrome,
  gridFoundation,
  grid,
  fileops,
  bootStart,
});

const retheme = wireRetheme({
  core,
  nav,
  chrome,
  fileops,
  settings,
});

// --- dnd (OSC 72) + resize + keyboard router ---
const dnd = wireDnd({
  core,
  nav,
  chrome,
  gridFoundation,
  grid,
  fileops,
});

wireResize({
  core,
  nav,
  chrome,
});

const keymap = wireKeymap({
  core,
  nav,
  chrome,
  gridFoundation,
  grid,
  fileops,
  settings,
  plugins,
  getRetheme: () => retheme,
});
