// --- tfm — composition root. All logic lives in the ./modules it wires; this
// file (plus ./wiring/*) only instantiates them, in one load-bearing order.
// Cross-cluster references that point backwards in that order are TDZ arrows
// (the wiring modules receive them as getters) — the same seam rule the
// widget factories use internally. Order:
//   core → nav → chrome (renderer boots here) → grid foundation → fileops →
//   plugins → grid → settings → watcher → hover drawer → boot → retheme →
//   dnd → resize → keymap ---
//
// The app graph loads LAZILY (dynamic imports below): --version must answer
// in milliseconds, not after OpenTUI natives + the whole graph load (~250ms).

import pkg from "../package.json";
import path from "node:path";
import { statSync, type Stats } from "node:fs";
import { parseArgs, usageText } from "./app/cli";

// --- CLI: one parse for the whole process. --help/--version and parse errors
// answer BEFORE the lazy app graph loads, so they stay instant. ---
const cli = parseArgs(process.argv);
// help/version win over a parse error (GNU behavior: `tfm --help --bogus` helps)
if (cli.help) {
  console.log(usageText());
  process.exit(0);
}
if (cli.version) {
  console.log(`tfm ${pkg.version}`);
  process.exit(0);
}
if (cli.error) {
  console.error(`tfm: ${cli.error}`);
  console.error("try 'tfm --help'");
  process.exit(2);
}
if (cli.config) process.env.TFM_CONFIG = path.resolve(cli.config);

// headless subcommand (`tfm plugins …`) — answers before the TUI graph loads
if (cli.command?.name === "plugins") {
  const { runPluginsCli } = await import("./app/plugins-cli");
  process.exit(await runPluginsCli(cli.command.args));
}

// launch PATH (`tfm ~/some/path`): chdir before anything resolves the cwd, so
// tabs/history/session all start there. A FILE opens its parent and is then
// selected by the grid. An invalid explicit path is a HARD ERROR (exit 1, no
// boot): the message must stay visible instead of being wiped by the alternate
// screen, and a wrong path is a typo, not "open wherever I happen to be".
// An explicit path also suppresses session restore — the user asked for a
// location, the saved session must not silently win.
const fail = (msg: string): never => {
  console.error(msg);
  process.exit(1);
};
let pendingSelect: string | null = null;
let explicitPath = false;
const target = cli.paths[0];
if (cli.paths.length > 1) console.error(`tfm: only the first path is used: ${target}`);
if (target === "") fail("tfm: empty path");
if (target) {
  const abs = path.resolve(target);
  let st: Stats | null = null;
  try {
    st = statSync(abs);
  } catch {}
  if (st === null) {
    console.error(`tfm: ${target}: no such file or directory`);
    process.exit(1);
  }
  const why = (err: unknown): string => `tfm: ${target}: ${err instanceof Error ? err.message : String(err)}`;
  if (st.isDirectory()) {
    try {
      process.chdir(abs);
    } catch (err) {
      fail(why(err));
    }
    explicitPath = true;
  } else if (st.isFile()) {
    try {
      process.chdir(path.dirname(abs));
    } catch (err) {
      fail(why(err));
    }
    // canonicalize via cwd: chdir resolves symlinks, so a symlinked launch dir
    // would otherwise set pendingSelect to a path the grid never uses as a key
    pendingSelect = path.join(process.cwd(), path.basename(abs));
    explicitPath = true;
  } else {
    fail(`tfm: ${target}: not a directory`);
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
const { wireWatcher, wireBoot, wireDnd, wireResize, wireHoverDrawer } = await import("./wiring/io");
const { wireKeymap } = await import("./wiring/keymap");

if (isDebug) appendLog(`tfm starting pid=${process.pid} argv=[${process.argv.slice(1).join(" ")}]`);

// --- core: config, theme, lookup, icon slots, floats, app state, geometry ---
const core = wireCore({
  renderer: () => chrome.renderer,
  clipboard: () => fileops.fileops.clipboard(),
  pendingSelect,
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
  getPlugins: () => plugins,
});

// --- chrome: file menu, sidebar, toolbar, renderer boot, notify, dialogs ---
const chrome = await wireChrome({
  core,
  nav,
  getGrid: () => grid,
  getFileops: () => fileops,
  getKeyRouter: () => keymap.keyRouter,
  // network "Connect to Server…" prompt — keymap wires LAST (TDZ seam, same
  // as the getGrid/getFileops getters above)
  getPrompt: () => keymap.prompt,
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
  getPrompt: () => keymap.prompt,
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
  getPrompt: () => keymap.prompt,
});

// --- grid: preview, mouse pipeline, grid renderer, props, menu entries ---
const grid = wireGrid({
  core,
  nav,
  chrome,
  gridFoundation,
  fileops,
  plugins,
  // getPick closes over `keymap` (wires last) — only called from the
  // "Compress to…" action at interaction time, so the TDZ is long settled
  getPick: () => keymap.pick,
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

// hover drawer BEFORE boot: it collapses panels at construction and publishes
// the collapsed effective widths, so the boot sequence's first renderAll and
// the first grid build already use them
const hover = wireHoverDrawer({
  core,
  chrome,
  fileops,
  gridFoundation,
  grid,
});

wireBoot({
  core,
  nav,
  chrome,
  gridFoundation,
  grid,
  fileops,
  bootStart,
  skipSessionRestore: explicitPath,
  mountSlots: () => plugins.mountSlots(),
  afterLayout: () => hover.refresh(),
  playSidebarIntro: () => chrome.sidebarIntro.play(),
  playTopbarIntro: () => chrome.topbarIntro.play(),
  // system theme: terminal colors land before the first layout bakes them in
  applyBootSystemTheme: () => settings.systemTheme.applyBootSystemTheme(),
});

const retheme = wireRetheme({
  core,
  nav,
  chrome,
  fileops,
  settings,
  getHover: () => hover,
  // keymap wires last — deferred like every other backward reference
  getKeymap: () => keymap,
  getGrid: () => grid,
  getGridFoundation: () => gridFoundation,
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

// system theme live-follow: terminal palette switches (kitty theme change)
// re-derive through applyConfig — a no-op unless [ui] follow-terminal is on
settings.systemTheme.followSystemTheme();
