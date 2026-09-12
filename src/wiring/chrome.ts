// --- Chrome wiring: file context menu, places sidebar + tab strip, toolbar,
// the renderer boot itself, notifications, recent-open and dialogs. The three
// widget factories are created BEFORE the renderer (their ctx fields defer
// renderer access through arrows — the renderer const further down this same
// function is the TDZ seam). Async: index awaits it, everything downstream
// gets a booted renderer. ---

import { createCliRenderer } from "@opentui/core";
import path from "node:path";
import { readdir } from "node:fs/promises";
import { spawnSafe } from "../fs/spawn-safe";
import { loadSystemPlaces } from "../fs/places";
import { buildMountArgs, buildUnmountArgs, gvfsRoot, takeGioPrompt, type GioPrompt } from "../fs/network";
import { makeNetworkActions, type GioResult } from "../fs/netmount";
import { makeMenu, MENU_W } from "../ui/ui-menu";
import { makeChrome } from "../ui/ui-chrome";
import { makeToolbar } from "../ui/ui-toolbar";
import { buildAppContainer, buildTitle } from "../ui/ui-boot-layout";
import { warmEmbeddedIcons } from "../ui/icons";
import { makeNotify } from "../ui/notify";
import { makeRecentOpen } from "../fs/recent-open";
import { upsertRecentXbel } from "../fs/recent";
import { appForFile } from "../fs/apps";
import { makeDialogs } from "../ui/ui-dialogs";
import { clearChildren } from "../lib/uiutil";
import { dlog } from "../app/log";
import type { CoreWiring } from "./core";
import type { FileopsWiring, GridWiring, NavWiring } from "./types";

export const wireChrome = async (deps: {
  core: CoreWiring;
  nav: NavWiring;
  // late clusters — only read at runtime, post-boot
  getGrid: () => GridWiring;
  getFileops: () => FileopsWiring;
  getKeyRouter: () => { sidebarActive(): boolean; placeIdx(): number };
  // network "Connect to Server…" prompt — prompt overlaps keymap, wired LAST
  getPrompt: () => {
    open(o: {
      title: string;
      placeholder?: string;
      okLabel?: string;
      initial?: string;
      password?: boolean;
    }): Promise<string | null>;
  };
  // grid's finishDragCtx (internal drag commit) — grid wiring builds it later
  finishDrag(): void;
}) => {
  const { core, nav, getGrid, getFileops, getKeyRouter } = deps;
  const { byId, stripSelectable } = core.lookup;
  const { makeIconSlot, setIconState, drainIconQueue } = core.slots;
  const { themeGet, home, state } = core;
  const uiStyle = () => core.config.ui.uiStyle;

  // --- File context menu (right-click a tile) — widget lives in ./ui-menu.
  // Hoisted above chrome/toolbar/conflict/grid-ctx, which all consume
  // closeFileMenu/openContextMenu/fileMenuIsOpen. Safe pre-boot: every ctx
  // field defers renderer access (same seam rule as makeSlots) ---
  const menu = makeMenu({
    byId,
    rootAdd: (node) => renderer.root.add(node),
    termW: () => renderer.terminalWidth,
    termH: () => renderer.terminalHeight,
    stripSelectable,
    drainIconQueue: () => drainIconQueue(),
    uiStyle,
    colors: themeGet,
    menuW: MENU_W,
    floats: core.floats,
    makeIconSlot,
  });

  // --- Network locations: "+ → connect" calls land here. The impls are
  // assigned further down (they need notify); the wrappers only defer, and
  // nothing invokes them before the wiring returns (TDZ seam rule). ---
  let connectServerImpl: (raw?: string) => Promise<void> = async () => {};
  let disconnectServerImpl: (mountPath: string) => Promise<void> = async () => {};
  const connectServer = (raw?: string): void => {
    void connectServerImpl(raw);
  };
  const disconnectServer = (mountPath: string): void => {
    void disconnectServerImpl(mountPath);
  };

  // --- Places sidebar + tab strip — widget lives in ./ui-chrome ---
  const chrome = makeChrome({
    byId,
    uiStyle,
    colors: themeGet,
    sw: () => core.geometry.sw,
    sideInnerW: core.sideInnerW,
    tabBar: () => core.config.ui.tabBar,
    renderAll: nav.renderAll,
    navigate: (target) => nav.navigate(target),
    blurTerminal: () => getFileops().terminal.blurTerminal(),
    closeFileMenu: menu.closeFileMenu,
    openContextMenu: menu.openContextMenu,
    sidebarEntriesFor: (place, x, y) => getGrid().menuEntries.sidebarEntriesFor(place, x, y),
    finishDrag: deps.finishDrag,
    dlog: (msg) => dlog(msg),
    trashPaths: (paths) => getFileops().trash.trashPaths(paths),
    moveInto: (dest, items) => getFileops().fileops.moveInto(dest, items),
    kbActive: () => getKeyRouter().sidebarActive(),
    kbIdx: () => getKeyRouter().placeIdx(),
    tabs: () => nav.tabModel,
    closeTab: nav.closeTab,
    switchTab: nav.switchTab,
    newTab: nav.newTab,
    // toolbar is built after the chrome ctx (TDZ seam) — keep the arrow
    hoverBtn: (id, icon, onMouseDown) => toolbar.hoverBtn(id, icon, onMouseDown),
    stripSelectable,
    drainIconQueue,
    makeIconSlot,
    setIconState,
    stateCwd: () => state.cwd,
    connectServer,
  });

  // --- Toolbar — widget lives in ./ui-toolbar (nav buttons, crumbs, inline
  // path edit, sort/search buttons). ---
  const toolbar = makeToolbar({
    renderer: () => renderer,
    byId,
    clearChildren,
    stripSelectable,
    uiStyle,
    colors: themeGet,
    makeIconSlot,
    setIconState,
    closeFileMenu: menu.closeFileMenu,
    blurTerminal: () => getFileops().terminal.blurTerminal(),
    navigate: nav.navigate,
    // arrow wrapper: notify is declared below (TDZ seam rule)
    notify: (m, t, l) => notify(m, t, l),
    canBack: nav.canBack,
    canFwd: nav.canFwd,
    goBack: nav.goBack,
    goFwd: nav.goFwd,
    openContextMenu: menu.openContextMenu,
    sortEntries: () => getGrid().menuEntries.sortEntries(),
    cwd: () => state.cwd,
    home,
  });

  // --- Layout: the pre-mount skeleton (title + three panels) lives in
  // ./ui-boot-layout; ids are repainted by rethemeChrome, so they must stay
  // byte-identical there. ---
  const container = buildAppContainer({
    sw: core.geometry.sw,
    sideInnerW: core.sideInnerW(),
    // eager object, not a getter — buildAppContainer/buildTitle read fields
    // directly (typed as Theme in ui-boot-layout so tsc enforces this)
    colors: core.colors,
    uiStyle: core.config.ui.uiStyle,
    tabBarVisible: core.config.ui.tabBar,
    previewWidth: core.config.ui.previewWidth,
    previewEnabled: core.config.ui.previewEnabled,
    title: buildTitle({ width: core.sideInnerW(), colors: core.colors, visible: core.config.ui.sidebarTitle }),
    toolbarShell: toolbar.makeToolbarShell(),
  });

  // --- Renderer boot ---
  const renderer = await createCliRenderer({
    exitOnCtrlC: false,
    targetFps: 60,
    maxFps: 120,
    ...(core.config.ui.transparentBg ? {} : { backgroundColor: core.colors.bg }),
  });
  renderer.root.add(container);
  warmEmbeddedIcons(); // index the embedded svg blobs while the renderer boots
  renderer.setBackgroundColor(core.colors.bg); // opencode-style: global bg lives on the renderer, not per-box

  // --- Notifications — its consumers (recent-open, undo, fileops, terminal,
  // trashops, settings, dnd72) take `notify` directly; the sticky transfer
  // progress toast lives in the same stack via notifySticky, so every
  // survivor reflows uniformly and two toasts never share a slot. ---
  const { notify, notifySticky } = makeNotify({
    rootAdd: (node) => renderer.root.add(node),
    remove: (node) => {
      const p: any = node.parent ?? renderer.root;
      p.remove(node);
    },
    byId,
    termW: () => renderer.terminalWidth,
    accentBg: () => core.colors.accentBg,
    white: () => core.colors.white,
    sidebarFgMuted: () => core.colors.sidebarFgMuted,
    ansi1: () => core.colors.ansi1,
    ansi2: () => core.colors.ansi2,
    makeIconSlot: core.slots.makeIconSlot,
    drainIconQueue: () => core.slots.drainIconQueue(),
    stripSelectable: core.lookup.stripSelectable,
    durationMs: () => core.config.ui.toastDurationMs,
  });

  // --- Recent-files recording + default open: batching/toast logic lives in
  // ./recent-open (tested); xbel write, xdg-open spawn and the app probe are
  // injected here ---
  const { openFileDefault } = makeRecentOpen({
    inTrashView: core.inTrashView,
    notify,
    upsertRecent: (paths) => upsertRecentXbel(paths),
    spawnOpen: (p) => {
      spawnSafe("xdg-open", [p], { stdio: "ignore", detached: true }, (err) =>
        dlog(`open ${p}: ${err.message}`),
      ).unref?.();
    },
    appForFile,
  });

  const dialogs = makeDialogs({
    byId,
    rootAdd: (node) => renderer.root.add(node),
    stripSelectable,
    termH: () => renderer.terminalHeight,
    uiStyle,
    colors: () => core.colors,
    closeFileMenu: menu.closeFileMenu,
  });

  // --- Network location actions (impls for the deferred wrappers above):
  // connect through gvfs, driving credential prompts through the shared text
  // overlay, then refresh places and navigate the FUSE path. `gio` is spawned
  // argv-array (never shelled) with stdin/stdout pipes the app scripts, so
  // gio's own terminal prompt never touches the TUI. ---
  const GIO_TIMEOUT_MS = 120_000;

  const runGio = async (args: string[], interactive: boolean): Promise<GioResult> => {
    const proc = Bun.spawn(["gio", ...args], {
      stdin: interactive ? "pipe" : "ignore",
      stdout: "pipe",
      stderr: "pipe",
      // LC_ALL=C pins the prompt labels to English (User/Password/Domain) so
      // takeGioPrompt's matcher is deterministic under any user locale
      env: { ...process.env, LC_ALL: "C", LANG: "C" },
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    let cancelled = false;
    const arm = (): void => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timedOut = true;
        try {
          proc.kill();
        } catch {}
      }, GIO_TIMEOUT_MS);
    };
    arm();
    let buf = "";
    let stderr = "";

    const answerPrompt = async (p: GioPrompt): Promise<void> => {
      if (p.message) {
        // last line is the specific ask ("Enter user and password for …");
        // the first is a generic "Authentication Required"
        const line = p.message.split("\n").filter(Boolean).pop();
        if (line) nav.setStatusMsg(line.slice(0, 120));
      }
      const answer = await deps.getPrompt().open({
        title: p.title,
        ...(p.default ? { initial: p.default } : {}),
        ...(p.kind === "choice" ? { placeholder: "Number" } : {}),
        okLabel: p.kind === "choice" ? "Send" : "OK",
        password: p.password,
      });
      if (answer === null) {
        cancelled = true;
        try {
          proc.kill();
        } catch {}
        return;
      }
      try {
        if (proc.stdin) {
          proc.stdin.write(`${answer}\n`);
          proc.stdin.flush?.();
        }
      } catch {}
      arm();
    };

    const stdoutDone = (async () => {
      const dec = new TextDecoder();
      for await (const chunk of proc.stdout) {
        buf += dec.decode(chunk as Uint8Array, { stream: true });
        if (!interactive) continue;
        for (;;) {
          const p = takeGioPrompt(buf);
          if (!p) break;
          buf = buf.slice(p.consumed);
          await answerPrompt(p);
          if (cancelled) return;
        }
      }
    })();
    const stderrDone = (async () => {
      const dec = new TextDecoder();
      for await (const chunk of proc.stderr) stderr += dec.decode(chunk as Uint8Array, { stream: true });
    })();
    const code = await proc.exited;
    clearTimeout(timer);
    await Promise.all([stdoutDone, stderrDone]);
    if (cancelled) return { code: 130, stdout: "", stderr: "cancelled" };
    return { code, stdout: "", stderr: timedOut ? stderr || "timed out" : stderr };
  };

  const network = makeNetworkActions({
    gvfsRoot,
    // mount can prompt for credentials; unmount never does
    mount: (uri) => runGio(buildMountArgs(uri), true),
    unmount: (uri) => runGio(buildUnmountArgs(uri), false),
    readdir: (dir) => readdir(dir),
    notify: (m, t, l) => {
      try {
        notify(m, t, l);
      } catch {}
    },
    log: (m) => dlog(m),
  });

  connectServerImpl = async (raw?: string): Promise<void> => {
    let input = raw ?? "";
    if (!input) {
      const v = await deps.getPrompt().open({
        title: "Connect to Server…",
        placeholder: "sftp://user@host/path",
        okLabel: "Connect",
      });
      if (!v) return;
      input = v;
    }
    const mountPath = await network.connect(input);
    if (!mountPath) return;
    await loadSystemPlaces();
    nav.renderAll();
    nav.navigate(mountPath);
  };

  disconnectServerImpl = async (mountPath: string): Promise<void> => {
    const cwd = core.state.cwd;
    // leave the share before unmounting it — navigating away first avoids
    // reading a dead FUSE path
    if (cwd === mountPath || cwd.startsWith(mountPath + path.sep)) nav.navigate(core.home);
    const ok = await network.disconnect(mountPath);
    if (!ok) return;
    await loadSystemPlaces();
    nav.renderAll();
  };

  return {
    renderer,
    menu,
    chrome,
    toolbar,
    notify,
    notifySticky,
    openFileDefault,
    dialogs,
    connectServer,
    disconnectServer,
  };
};
