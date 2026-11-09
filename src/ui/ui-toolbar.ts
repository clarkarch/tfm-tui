// --- Toolbar: back/fwd nav buttons, breadcrumb path row (with the double-click
// inline path editor), sort + search buttons — as a factory with injected
// callbacks (same seam as ui-chrome.ts). The search QUERY state lives in
// ./search and the keyboard router in ./keymap; this module owns the
// path-edit state machine and the hover-button raster/surface plumbing. ---

import path from "node:path";
import os from "node:os";
import { statSync } from "node:fs";
import { Box, type CliRenderer, Input, InputRenderable, type KeyEvent, type MouseEvent, Text } from "@opentui/core";
import { applySurface, btnSurface, type UiStyle } from "./style";
import type { Theme } from "../config/config";
import { RECENT_URI, STARRED_URI, isVirtualUri } from "../fs/uri";
import { archiveUri, parseArchiveUri } from "../fs/archive-scheme";
import { stripControlChars } from "../lib/uiutil";
import type { MakeIconSlot, SlotElement } from "./ui-slots";
import { hoverEvents, toggleIconState } from "./ui-slots";
import { IconStateIdx, type IconState, type IconSpec } from "../lib/icon-state";
import type { ListEntry } from "../lib/menu-entry";
import type { NotifyLevel } from "../lib/notify-level";
import type { MaybeNode } from "../lib/node-like";
import type { PointerStyle } from "../lib/pointer";

// --- The inline path editor: ONE tagged machine.
//
// closed → armed (the first click of a double-click) → editing. The old
// shape was a boolean (`pathEditMode`) PLUS a timestamp sentinel
// (`crumbClickAt`): two fields for one machine, and the arm could outlive
// the edit. The arm is a PHASE of the same record now, so leaving `editing`
// drops it and no exit can leave a half-state behind.
export type PathEditMode = { kind: "closed" } | { kind: "armed"; at: number } | { kind: "editing" };

// why the editor closed — every exit names itself (the trace says which one
// fired, and the closer is the ONLY writer that leaves `editing`)
export type PathEditCloseReason = "commit" | "cancel" | "navigate" | "superseded";

// One toolbar's LOCAL closer, published to the app-wide registry. The path
// editor holds the keyboard focus, so cancelling it in ONE pane must cancel
// it in the OTHER too: the external exits used to reach the ACTIVE pane
// only, so pane 1's editor survived a navigation in pane 0 — its Input kept
// the focus and swallowed every keystroke.
export type PathEditPeer = {
  isOpen(): boolean;
  close(reason: PathEditCloseReason): void;
};

type ToolbarCtx = {
  // per-pane id prefix ("tfm-p0-"/"tfm-p1-") — dual pane builds one toolbar
  // instance per pane, so every node id must be unique across the registry
  prefix: string;
  renderer(): CliRenderer;
  byId(id: string): MaybeNode;
  // destroys the removed children's native buffers too — never a detach-only
  // sweep, or every crumb rebuild defers its TextBuffers to the GC poke
  destroyChildren(node: unknown): void;
  stripSelectable(): void;
  uiStyle(): UiStyle;
  // live theme — always read through the getter, never captured
  colors(): Theme;
  makeIconSlot: MakeIconSlot;
  setIconState(spec: IconSpec, index: number): void;
  closeFileMenu(): void;
  blurTerminal(): void;
  // focus this toolbar's pane on any press (deferred: grid wires after chrome)
  focusPane?(): void;
  navigate(dir: string): void;
  notify(msg: string, title?: string, level?: NotifyLevel): void;
  canBack(): boolean;
  canFwd(): boolean;
  goBack(): void;
  goFwd(): void;
  openContextMenu(x: number, y: number, title: string, entries: ListEntry[]): void;
  sortEntries(): ListEntry[];
  cwd(): string;
  home: string;
  // transparent-bg force: toolbar rest fills clear so the terminal shows
  // through. Optional so test fakes keep working.
  transparentForce?(): boolean;
  // per-navigate directory-bar animation: renderCrumbs calls this with the ids
  // of ONLY the newly appeared crumbs after rebuilding for a changed cwd
  // (first build + same-target rebuilds pass nothing and stay silent). Wired
  // to the dir-bar animator in wireChrome; absent = instant.
  animateCrumbs?: (ids: string[]) => void;
  // mouse pointer shape (OSC 22 via the wiring's tty-guarded setter).
  // Absent = no pointer changes (old fakes keep working).
  setPointer?(style: PointerStyle): void;
  // open/close THIS pane's search through the search module (./search) —
  // the module owns the open state, so the button must not write the input
  // node's visible flag itself (the router reads the module, not the node)
  toggleSearch(): void;
  // the app-wide path-editor registry: every toolbar appends its LOCAL
  // closer here, so the ONE public closer cancels the editor in EVERY pane.
  // Absent = a lone toolbar (single-pane fakes).
  pathEditPeers?: PathEditPeer[];
  // clock for the double-click window — injected so the window is testable
  // without sleeping (absent = Date.now())
  now?(): number;
  // debug trace (the wiring passes the debug log); optional so fakes keep
  // working
  log?(msg: string): void;
};

// path-bar commit check: virtual places always navigate; real paths must be
// existing dirs (navigate() silently ignores the rest). Pure for tests — the
// widget decides whether to stay in the edit on false.
export const isNavigableTarget = (target: string): boolean => {
  if (isVirtualUri(target)) return true;
  try {
    return statSync(target).isDirectory();
  } catch {
    return false;
  }
};

// --- Breadcrumb model (pure, so the archive/real-path machinery is testable
// without mounting). A crumb is one clickable segment: `target` is what a click
// navigates to. Real paths get base + segments; virtual places get one crumb;
// an archive cwd shows its REAL location, then a crumb for the archive file,
// then the inner dirs — never `path.resolve` on a URI (that glued the archive
// onto process.cwd() and rendered the launch dir in the path bar). ---
export type Crumb = { label: string; icon?: string; target: string };

const dirChain = (dir: string, home: string, host: string): Crumb[] => {
  const abs = path.resolve(dir);
  const inHome = abs === home || abs.startsWith(home + path.sep);
  const baseLabel = inHome ? "Home" : host;
  const baseIcon = inHome ? "home" : "desktop-tower";
  const basePath = inHome ? home : "/";
  const rest = path.relative(basePath, abs).split(path.sep).filter(Boolean);
  return [
    { label: baseLabel, icon: baseIcon, target: basePath },
    ...rest.map((seg, i) => ({ label: seg, target: path.join(basePath, ...rest.slice(0, i + 1)) })),
  ];
};

export const buildCrumbs = (cwd: string, home: string, host: string): Crumb[] => {
  if (cwd === RECENT_URI) return [{ label: "Recent", icon: "clock", target: cwd }];
  if (cwd === STARRED_URI) return [{ label: "Starred", icon: "star", target: cwd }];
  const archive = parseArchiveUri(cwd);
  if (archive) {
    const inner = archive.inner ? archive.inner.split("/").filter(Boolean) : [];
    return [
      ...dirChain(path.dirname(archive.file), home, host),
      { label: path.basename(archive.file), icon: "zip-box", target: archiveUri(archive.file) },
      ...inner.map((seg, i) => ({ label: seg, target: archiveUri(archive.file, inner.slice(0, i + 1).join("/")) })),
    ];
  }
  return dirChain(cwd, home, host);
};

// animation targets inside one toolbar (ids are prefix-namespaced per pane).
// Crumb ids are dense (`crumb-0..N`), so the probe stops at the first miss;
// the cap keeps a never-missing registry from looping forever. Only existing
// nodes are returned — the animator skips the rest anyway, but callers
// (startup cascade order asserts) want the resolved list.
export const crumbItemIds = (byId: (id: string) => MaybeNode, prefix: string, cap = 128): string[] => {
  const ids: string[] = [];
  for (let i = 0; i < cap; i++) {
    let n: MaybeNode = null;
    try {
      n = byId(`${prefix}crumb-${i}`);
    } catch {
      n = null;
    }
    if (!n) break;
    ids.push(`${prefix}crumb-${i}`);
  }
  return ids;
};

// left-to-right cascade order: nav buttons, crumbs, sort + search buttons
export const toolbarItemIds = (byId: (id: string) => MaybeNode, prefix: string, cap = 128): string[] => {
  const live = (id: string): boolean => {
    try {
      return !!byId(id);
    } catch {
      return false;
    }
  };
  return [
    `${prefix}nav-back`,
    `${prefix}nav-fwd`,
    ...crumbItemIds(byId, prefix, cap),
    `${prefix}sort-btn`,
    `${prefix}search-btn`,
  ].filter(live);
};

export const makeToolbar = (ctx: ToolbarCtx) => {
  const { makeIconSlot, setIconState } = ctx;
  // transparent-bg force as a surface-seam value (absent = today's behavior)
  const tForce = () => (ctx.transparentForce?.() ? "force" : undefined);
  // every node id in this pane's toolbar is namespaced so two instances can
  // coexist in the global renderable registry
  const id = (name: string): string => `${ctx.prefix}${name}`;

  // --- nav buttons: ONE record per button, owned by the button ---
  //
  // The record holds everything the button's paint reads: the raster spec,
  // the ENABLED source (the wiring's canBack/canFwd seam), the cached
  // enabled flag and the hover flag. The old shape was TWO toolbar-level
  // maps (`navSpecs` + `navHover`) that OUTLIVED the button they belonged
  // to: a rebuilt button inherited the DEAD button's hover (a stale raster
  // index AND a stale hover bg — the theme flip re-read the stale flag).
  // The map below holds only the CURRENTLY MOUNTED button's record, and a
  // rebuild replaces it.
  type NavButtonState = {
    id: string;
    spec: IconSpec;
    // where the enabled flag comes from (the wiring seam)
    isEnabled(): boolean;
    // the cached enabled flag (refreshed by refreshNav)
    enabled: boolean;
    hovered: boolean;
  };
  const navButtons = new Map<string, NavButtonState>();

  // the nav raster index: enabled/disabled × normal/hover. It lives HERE
  // (its only consumer) because the index and the hover flag are ONE state
  // — the record's paint reads both.
  const navIconState = (enabled: boolean, hovered: boolean): number =>
    (enabled ? IconStateIdx.Rest : IconStateIdx.Active) + (hovered ? IconStateIdx.HoverOffset : 0);

  // the paint: BOTH halves of a button (the baked raster state AND the
  // wrapper box surface) read the ONE record.
  const paintNavButton = (btn: NavButtonState): void => {
    // a stale record (its button was rebuilt) must not paint the new button
    if (navButtons.get(btn.id) !== btn) return;
    setIconState(btn.spec, navIconState(btn.enabled, btn.hovered));
    try {
      const n = ctx.byId(btn.id);
      if (n) applySurface(n, btnSurface(ctx.uiStyle(), ctx.colors(), btn.hovered, undefined, tForce()));
    } catch {}
  };

  const makeNavButton = (
    key: "nav-back" | "nav-fwd",
    iconName: string,
    onActivate: () => void,
    isEnabled: () => boolean,
  ) => {
    const btnId = id(key);
    const states = (): IconState[] => [
      { fg: ctx.colors().sidebarFg, bg: ctx.colors().bg },
      { fg: ctx.colors().sidebarFgMuted, bg: ctx.colors().bg },
      { fg: ctx.colors().sidebarFg, bg: ctx.colors().hoverBg },
      { fg: ctx.colors().sidebarFgMuted, bg: ctx.colors().hoverBg },
    ];
    const slot = makeIconSlot(iconName, states(), 1, 0, undefined, states);
    // the record is OWNED by this button: a rebuild (a fresh shell) makes a
    // NEW record and REPLACES the dead button's one, so the dead button's
    // hover cannot survive.
    const btn: NavButtonState = {
      id: btnId,
      spec: slot.spec,
      isEnabled,
      enabled: isEnabled(),
      hovered: false,
    };
    navButtons.set(btnId, btn);
    return Box(
      {
        id: btnId,
        height: 1,
        width: 3,
        justifyContent: "center",
        ...btnSurface(ctx.uiStyle(), ctx.colors(), false, undefined, tForce()),
        onMouseDown: () => {
          ctx.focusPane?.();
          ctx.closeFileMenu();
          onActivate();
        },
        ...hoverEvents((on) => {
          btn.hovered = on;
          paintNavButton(btn);
        }, ctx.setPointer),
      },
      slot.el,
    );
  };

  const refreshNav = () => {
    for (const btn of navButtons.values()) {
      btn.enabled = btn.isEnabled();
      paintNavButton(btn);
    }
  };

  // retheme helper: box bg must track the new palette between raster swaps
  const repaintButtons = (): void => {
    // the nav buttons paint their hover half from their OWN record
    for (const btn of navButtons.values()) {
      try {
        const n = ctx.byId(btn.id);
        if (n) applySurface(n, btnSurface(ctx.uiStyle(), ctx.colors(), btn.hovered, undefined, tForce()));
      } catch {}
    }
    // the generic hover buttons (search/sort) keep their rest surface
    for (const key of ["search-btn", "sort-btn"]) {
      try {
        const n = ctx.byId(id(key));
        if (n) applySurface(n, btnSurface(ctx.uiStyle(), ctx.colors(), false, undefined, tForce()));
      } catch {}
    }
  };

  // --- breadcrumbs + inline path edit ---
  const crumbSep = () => Text({ content: " › ", fg: ctx.colors().sidebarFgMuted });

  // the editor machine: closed → armed (the first click of a double-click) →
  // editing. ONE record, so the arm cannot outlive the edit.
  let pathEdit: PathEditMode = { kind: "closed" };
  // the double-click window (the arm's lifetime)
  const PATH_EDIT_DOUBLE_CLICK_MS = 350;
  const nowMs = (): number => ctx.now?.() ?? Date.now();
  const isEditing = (): boolean => pathEdit.kind === "editing";
  // per-navigate animation guard: the crumb TARGETS last built for. Null
  // until the first build (which only records — the startup intro covers
  // boot). On rebuild the shared target prefix stays put and only the suffix
  // past the first divergence replays — drilling down animates just the new
  // crumbs, going up animates nothing, same-target rebuilds (retheme,
  // watcher, search, path edit) stay instant.
  let lastCrumbTargets: string[] | null = null;

  // the ONLY writer that leaves `editing`: every exit (commit, cancel,
  // navigate) goes through it, so no exit can skip its side effects.
  const closeLocal = (reason: PathEditCloseReason): void => {
    if (!isEditing()) return;
    pathEdit = { kind: "closed" };
    ctx.log?.(`pathedit: closed (${reason})`);
    // the editor is gone — default (stale-until-move, same rule as menus)
    ctx.setPointer?.("default");
    renderCrumbs();
  };

  // the ONE public closer: it cancels the editor in EVERY pane (the registry
  // holds each toolbar's local close). The old route reached the ACTIVE
  // pane only, so the other pane's editor survived — with its Input still
  // focused, swallowing every keystroke.
  const exitPathEdit = (reason: PathEditCloseReason = "cancel"): void => {
    const peers = ctx.pathEditPeers;
    if (!peers) {
      closeLocal(reason);
      return;
    }
    for (const peer of peers) peer.close(reason);
  };

  const enterPathEdit = () => {
    if (isEditing()) return;
    ctx.blurTerminal();
    // one editor at a time: this pane's editor supersedes the other pane's
    // (two focused Inputs = one of them is stale)
    exitPathEdit("superseded");
    pathEdit = { kind: "editing" };
    // the editor owns the keyboard now — text pointer until it lands
    ctx.setPointer?.("text");
    renderCrumbs();
  };

  // the crumbs box: the first click ARMS the editor, the second (inside the
  // window) opens it. The arm is a phase of the machine, not a separate
  // timestamp that could survive the edit.
  const armOrOpenPathEdit = (): void => {
    if (isEditing()) return;
    const at = nowMs();
    if (pathEdit.kind === "armed" && at - pathEdit.at < PATH_EDIT_DOUBLE_CLICK_MS) {
      pathEdit = { kind: "closed" };
      enterPathEdit();
      return;
    }
    pathEdit = { kind: "armed", at };
  };

  // publish this toolbar's LOCAL closer to the app-wide registry
  ctx.pathEditPeers?.push({ isOpen: isEditing, close: closeLocal });

  const renderCrumbs = () => {
    const box = ctx.byId(id("crumbs"));
    if (!box) return;

    if (isEditing()) {
      ctx.destroyChildren(box);
      // resolve once and construct only on a miss: both branches share this
      // binding, and a `let` would lose its narrowing inside the enter handler
      const existing = ctx.byId(id("path-input"));
      const input =
        existing ??
        new InputRenderable(ctx.renderer(), {
          id: id("path-input"),
          flexGrow: 1,
          // cwd-seeded (a mounted path can carry odd bytes) — strip so the
          // 0.6.0 Input ctor never throws NativeError here
          value: stripControlChars(isVirtualUri(ctx.cwd()) ? ctx.cwd() : path.resolve(ctx.cwd())),
          backgroundColor: ctx.colors().accentBg,
          focusedBackgroundColor: ctx.colors().accentBg,
          textColor: ctx.colors().white,
        });
      if (!existing) {
        // real class instance: proxied composition nodes don't mount under an
        // already-mounted parent
        box.add(input);
        input.on?.("enter", () => {
          const target = String(input.value ?? "").replace(/^~(?=\/|$)/, ctx.home);
          // validate before leaving the edit: navigate() silently ignores
          // non-dirs, which used to eat the keystroke with zero feedback.
          // Stay in the edit on failure so the path can be fixed in place.
          if (!isNavigableTarget(target)) {
            ctx.notify(`No such folder · ${target}`, "navigate", "error");
            return;
          }
          // the commit goes through the SAME closer as every other exit: a
          // direct state write here skipped whatever the closer does (the
          // trace, the other panes' editors, the arm reset)
          exitPathEdit("commit");
          ctx.navigate(target);
        });
        // focused editors can consume keys before the global handler; intercept
        // escape at the source so it always cancels
        const prevHandler = input.handleKeyPress?.bind(input);
        input.handleKeyPress = (key: KeyEvent) => {
          if (key?.name === "escape") {
            exitPathEdit("cancel");
            return true;
          }
          return prevHandler ? prevHandler(key) : false;
        };
      } else {
        try {
          input.value = stripControlChars(isVirtualUri(ctx.cwd()) ? ctx.cwd() : path.resolve(ctx.cwd()));
        } catch {}
      }
      try {
        input.visible = true;
      } catch {}
      setTimeout(() => {
        try {
          input.focus();
        } catch {}
      }, 20);
      ctx.stripSelectable();
      return;
    }

    // rebuild crumbs from scratch — appending would duplicate them every nav
    ctx.destroyChildren(box);

    const crumbs = buildCrumbs(ctx.cwd(), ctx.home, os.hostname());

    crumbs.forEach((c, i) => {
      const current = i === crumbs.length - 1;
      const fg = current ? ctx.colors().white : ctx.colors().sidebarFgMuted;
      // clickable crumbs get hover feedback: baked raster swap + box bg swap
      const iconStates = current
        ? [{ fg, bg: ctx.colors().bg }]
        : [
            { fg, bg: ctx.colors().bg },
            { fg: ctx.colors().white, bg: ctx.colors().hoverBg },
          ];
      const iconSlot = c.icon ? makeIconSlot(c.icon, iconStates, 1) : null;
      const paintHover = (on: boolean) => {
        if (iconSlot && !current) setIconState(iconSlot.spec, toggleIconState(on, false));
        try {
          const n = ctx.byId(id(`crumb-${i}`));
          if (n) applySurface(n, btnSurface(ctx.uiStyle(), ctx.colors(), on && !current, undefined, tForce()));
        } catch {}
      };
      const crumb = Box(
        {
          id: id(`crumb-${i}`),
          height: 1,
          flexDirection: "row",
          alignItems: "center",
          columnGap: 1,
          ...btnSurface(ctx.uiStyle(), ctx.colors(), false, undefined, tForce()),
          ...(current
            ? {}
            : {
                onMouseDown: () => {
                  ctx.focusPane?.();
                  ctx.navigate(c.target);
                },
                ...hoverEvents(paintHover, ctx.setPointer),
              }),
        },
        ...(iconSlot ? [iconSlot.el] : []),
        Text({ content: c.label, fg }),
      );
      box.add(crumb);
      if (i < crumbs.length - 1) box.add(crumbSep());
    });

    const targets = crumbs.map((c) => c.target);
    if (lastCrumbTargets === null) {
      lastCrumbTargets = targets;
    } else {
      let common = 0;
      while (
        common < lastCrumbTargets.length &&
        common < targets.length &&
        lastCrumbTargets[common] === targets[common]
      )
        common++;
      lastCrumbTargets = targets;
      if (common < targets.length) {
        try {
          ctx.animateCrumbs?.(targets.slice(common).map((_, k) => id(`crumb-${common + k}`)));
        } catch {}
      }
    }
  };

  // --- generic hover button: two baked rasters (normal/hover bg), wrapper box
  // bg matches so the padding cells track the raster ---
  const hoverBtn = (id: string, iconName: string, onMouseDown: (ev: MouseEvent) => void): SlotElement => {
    const states = (): IconState[] => [
      { fg: ctx.colors().sidebarFg, bg: ctx.colors().bg },
      { fg: ctx.colors().sidebarFg, bg: ctx.colors().hoverBg },
    ];
    const slot = makeIconSlot(iconName, states(), 1, 0, undefined, states);
    const paint = (on: boolean) => {
      setIconState(slot.spec, toggleIconState(on, false));
      try {
        const n = ctx.byId(id);
        if (n) applySurface(n, btnSurface(ctx.uiStyle(), ctx.colors(), on, undefined, tForce()));
      } catch {}
    };
    return Box(
      {
        id,
        height: 1,
        width: 3,
        justifyContent: "center",
        ...btnSurface(ctx.uiStyle(), ctx.colors(), false, undefined, tForce()),
        onMouseDown: (ev: MouseEvent) => {
          ctx.focusPane?.();
          onMouseDown(ev);
        },
        ...hoverEvents(paint, ctx.setPointer),
      },
      slot.el,
    );
  };

  const makeSearch = () => {
    const wrap = Box({ id: id("search-wrap"), height: 1, flexDirection: "row" });

    const input = Input({
      id: id("search"),
      width: 16,
      visible: false,
      // live substring filter; honors the show-hidden toggle (grid lists and
      // recursive search both pass state.showHidden)
      placeholder: "Search",
      backgroundColor: ctx.colors().accentBg,
      focusedBackgroundColor: ctx.colors().accentBg,
      textColor: ctx.colors().white,
    });

    wrap.add(
      hoverBtn(id("search-btn"), "search", () => {
        ctx.closeFileMenu();
        ctx.blurTerminal();
        // the search module owns the open state (and the query) — the button
        // only asks it to toggle
        ctx.toggleSearch();
      }),
    );
    wrap.add(input);
    return wrap;
  };

  const makeSortButton = (): SlotElement =>
    hoverBtn(id("sort-btn"), "sort", (ev: MouseEvent) => {
      ctx.closeFileMenu();
      ctx.openContextMenu(ev.x, ev.y, "", ctx.sortEntries());
    });

  const makeToolbarShell = (): ReturnType<typeof Box> =>
    Box(
      {
        id: id("toolbar"),
        width: "100%",
        height: 1,
        flexDirection: "row",
        paddingLeft: 1,
        paddingRight: 1,
        columnGap: 1,
      },
      Box(
        { height: 1, flexGrow: 1, flexBasis: 0, overflow: "hidden", flexDirection: "row", columnGap: 1 },
        makeNavButton("nav-back", "chevron-left", ctx.goBack, ctx.canBack),
        makeNavButton("nav-fwd", "chevron-right", ctx.goFwd, ctx.canFwd),
        Box({
          id: id("crumbs"),
          flexGrow: 1,
          flexBasis: 0,
          height: 1,
          flexDirection: "row",
          columnGap: 1,
          overflow: "hidden",
          onMouseDown: () => {
            if (isEditing()) return;
            ctx.focusPane?.();
            ctx.closeFileMenu();
            armOrOpenPathEdit();
          },
        }),
      ),
      makeSortButton(),
      makeSearch(),
    );

  return {
    makeToolbarShell,
    renderCrumbs,
    refreshNav,
    repaintButtons,
    hoverBtn,
    enterPathEdit,
    exitPathEdit,
    pathEditMode: isEditing,
  };
};
