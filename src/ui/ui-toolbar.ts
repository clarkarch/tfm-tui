// --- Toolbar: back/fwd nav buttons, breadcrumb path row (with the double-click
// inline path editor), sort + search buttons — as a factory with injected
// callbacks (same seam as ui-chrome.ts). The search QUERY state lives in
// ./search and the keyboard router in ./keymap; this module owns the
// pathEditMode flag and the hover-button raster/surface plumbing. ---

import path from "node:path";
import os from "node:os";
import { statSync } from "node:fs";
import { Box, Input, InputRenderable, Text } from "@opentui/core";
import { applySurface, btnSurface, type UiStyle } from "./style";
import type { Theme } from "../config/config";
import { RECENT_URI, STARRED_URI, isVirtualUri } from "../fs/uri";
import type { IconSpec, IconState } from "./ui-slots";
import { navIconState, toggleIconState } from "./ui-slots";
import type { ListEntry } from "./ui-menu";
import type { NotifyLevel } from "../lib/notify-level";

type MakeIconSlotFn = (
  name: string,
  states: IconState[],
  heightCells?: number,
  initialState?: number,
  onMouseDown?: (ev: any) => void,
  statesFactory?: () => IconState[],
) => { spec: IconSpec; el: any };

type ToolbarCtx = {
  // per-pane id prefix ("tfm-p0-"/"tfm-p1-") — dual pane builds one toolbar
  // instance per pane, so every node id must be unique across the registry
  prefix: string;
  renderer(): any;
  byId(id: string): any;
  clearChildren(node: unknown): void;
  stripSelectable(): void;
  uiStyle(): UiStyle;
  // live theme — always read through the getter, never captured
  colors(): Theme;
  makeIconSlot: MakeIconSlotFn;
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

export const makeToolbar = (ctx: ToolbarCtx) => {
  const { makeIconSlot, setIconState } = ctx;
  // every node id in this pane's toolbar is namespaced so two instances can
  // coexist in the global renderable registry
  const id = (name: string): string => `${ctx.prefix}${name}`;

  // --- nav buttons: 4 baked rasters each (enabled/disabled × normal/hover;
  // bg baked into the png so the wrapper box bg must swap in lockstep) ---
  const navSpecs: Record<string, IconSpec | undefined> = {
    [id("nav-back")]: undefined,
    [id("nav-fwd")]: undefined,
  };
  const navHover: Record<string, boolean> = {};

  const navBtnBg = (btnId: string) => {
    try {
      const n: any = ctx.byId(btnId);
      if (n) applySurface(n, btnSurface(ctx.uiStyle(), ctx.colors(), !!navHover[btnId]));
    } catch {}
  };

  const makeNavButton = (key: "nav-back" | "nav-fwd", iconName: string, onActivate: () => void) => {
    const btnId = id(key);
    const states = (): IconState[] => [
      { fg: ctx.colors().sidebarFg, bg: ctx.colors().bg },
      { fg: ctx.colors().sidebarFgMuted, bg: ctx.colors().bg },
      { fg: ctx.colors().sidebarFg, bg: ctx.colors().hoverBg },
      { fg: ctx.colors().sidebarFgMuted, bg: ctx.colors().hoverBg },
    ];
    const slot = makeIconSlot(iconName, states(), 1, 0, undefined, states);
    navSpecs[btnId] = slot.spec;
    return Box(
      {
        id: btnId,
        height: 1,
        width: 3,
        justifyContent: "center",
        ...btnSurface(ctx.uiStyle(), ctx.colors(), false),
        onMouseDown: () => {
          ctx.focusPane?.();
          ctx.closeFileMenu();
          onActivate();
        },
        onMouseOver: () => {
          navHover[btnId] = true;
          refreshNav();
        },
        onMouseOut: () => {
          navHover[btnId] = false;
          refreshNav();
        },
      },
      slot.el,
    );
  };

  const refreshNav = () => {
    const setBtn = (btnId: string, on: boolean) => {
      const spec = navSpecs[btnId];
      if (!spec) return;
      setIconState(spec, navIconState(on, !!navHover[btnId]));
      navBtnBg(btnId);
    };
    setBtn(id("nav-back"), ctx.canBack());
    setBtn(id("nav-fwd"), ctx.canFwd());
  };

  // retheme helper: box bg must track the new palette between raster swaps
  const repaintButtons = (): void => {
    for (const key of ["nav-back", "nav-fwd", "search-btn", "sort-btn"]) {
      const btnId = id(key);
      try {
        const n: any = ctx.byId(btnId);
        if (n) applySurface(n, btnSurface(ctx.uiStyle(), ctx.colors(), !!navHover[btnId]));
      } catch {}
    }
  };

  // --- breadcrumbs + inline path edit ---
  const crumbSep = () => Text({ content: " › ", fg: ctx.colors().sidebarFgMuted });

  let pathEditMode = false;
  let crumbClickAt = 0;

  const exitPathEdit = () => {
    if (!pathEditMode) return;
    pathEditMode = false;
    renderCrumbs();
  };

  const enterPathEdit = () => {
    if (pathEditMode) return;
    ctx.blurTerminal();
    pathEditMode = true;
    renderCrumbs();
  };

  const renderCrumbs = () => {
    const box: any = ctx.byId(id("crumbs"));
    if (!box) return;

    if (pathEditMode) {
      ctx.clearChildren(box);
      let input: any = ctx.byId(id("path-input"));
      if (!input) {
        // real class instance: proxied composition nodes don't mount under an
        // already-mounted parent
        input = new InputRenderable(ctx.renderer(), {
          id: id("path-input"),
          flexGrow: 1,
          value: isVirtualUri(ctx.cwd()) ? ctx.cwd() : path.resolve(ctx.cwd()),
          backgroundColor: ctx.colors().accentBg,
          focusedBackgroundColor: ctx.colors().accentBg,
          textColor: ctx.colors().white,
        });
        box.add(input);
        input.on?.("enter", () => {
          const target = String(input.value ?? "").replace(/^~(?=\/|$)/, ctx.home);
          // validate before leaving the edit: navigate() silently ignores
          // non-dirs, which used to eat the keystroke with zero feedback.
          // Stay in the edit on failure so the path can be fixed in place.
          if (!isNavigableTarget(target)) {
            ctx.notify(`No such folder: ${target}`, "navigate", "error");
            return;
          }
          pathEditMode = false;
          renderCrumbs();
          ctx.navigate(target);
        });
        // focused editors can consume keys before the global handler; intercept
        // escape at the source so it always cancels
        const prevHandler = input.handleKeyPress?.bind(input);
        input.handleKeyPress = (key: any) => {
          if (key?.name === "escape") {
            exitPathEdit();
            return true;
          }
          return prevHandler ? prevHandler(key) : false;
        };
      } else {
        try {
          input.value = isVirtualUri(ctx.cwd()) ? ctx.cwd() : path.resolve(ctx.cwd());
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
    ctx.clearChildren(box);

    const cwdAbs = path.resolve(ctx.cwd());
    const virtCrumb =
      ctx.cwd() === RECENT_URI
        ? { label: "Recent", icon: "clock" }
        : ctx.cwd() === STARRED_URI
          ? { label: "Starred", icon: "star" }
          : null;
    const inHome = !virtCrumb && (cwdAbs === ctx.home || cwdAbs.startsWith(ctx.home + path.sep));
    const baseLabel = virtCrumb ? virtCrumb.label : inHome ? "Home" : os.hostname();
    const baseIcon = virtCrumb ? virtCrumb.icon! : inHome ? "home" : "desktop-tower";
    const basePath = virtCrumb ? ctx.cwd() : inHome ? ctx.home : "/";
    const rest = virtCrumb
      ? []
      : path
          .relative(inHome ? ctx.home : "/", cwdAbs)
          .split(path.sep)
          .filter(Boolean);

    const crumbs: { label: string; icon?: string; target: string }[] = [
      { label: baseLabel, icon: baseIcon, target: basePath },
      ...rest.map((seg, i) => ({ label: seg, target: path.join(basePath, ...rest.slice(0, i + 1)) })),
    ];

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
          const n: any = ctx.byId(id(`crumb-${i}`));
          if (n) applySurface(n, btnSurface(ctx.uiStyle(), ctx.colors(), on && !current));
        } catch {}
      };
      const crumb = Box(
        {
          id: id(`crumb-${i}`),
          height: 1,
          flexDirection: "row",
          alignItems: "center",
          columnGap: 1,
          ...btnSurface(ctx.uiStyle(), ctx.colors(), false),
          ...(current
            ? {}
            : {
                onMouseDown: () => {
                  ctx.focusPane?.();
                  ctx.navigate(c.target);
                },
                onMouseOver: () => paintHover(true),
                onMouseOut: () => paintHover(false),
              }),
        },
        ...(iconSlot ? [iconSlot.el] : []),
        Text({ content: c.label, fg }),
      );
      box.add(crumb);
      if (i < crumbs.length - 1) box.add(crumbSep());
    });
  };

  // --- generic hover button: two baked rasters (normal/hover bg), wrapper box
  // bg matches so the padding cells track the raster ---
  const hoverBtn = (id: string, iconName: string, onMouseDown: (ev: any) => void): ReturnType<typeof Box> => {
    const states = (): IconState[] => [
      { fg: ctx.colors().sidebarFg, bg: ctx.colors().bg },
      { fg: ctx.colors().sidebarFg, bg: ctx.colors().hoverBg },
    ];
    const slot = makeIconSlot(iconName, states(), 1, 0, undefined, states);
    const paint = (on: boolean) => {
      setIconState(slot.spec, toggleIconState(on, false));
      try {
        const n: any = ctx.byId(id);
        if (n) applySurface(n, btnSurface(ctx.uiStyle(), ctx.colors(), on));
      } catch {}
    };
    return Box(
      {
        id,
        height: 1,
        width: 3,
        justifyContent: "center",
        ...btnSurface(ctx.uiStyle(), ctx.colors(), false),
        onMouseDown: (ev: any) => {
          ctx.focusPane?.();
          onMouseDown(ev);
        },
        onMouseOver: () => paint(true),
        onMouseOut: () => paint(false),
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
        const el: any = ctx.byId(id("search"));
        if (!el) return;
        el.visible = !el.visible;
        if (el.visible) el.focus();
      }),
    );
    wrap.add(input);
    return wrap;
  };

  const makeSortButton = (): ReturnType<typeof Box> =>
    hoverBtn(id("sort-btn"), "sort", (ev: any) => {
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
        makeNavButton("nav-back", "chevron-left", ctx.goBack),
        makeNavButton("nav-fwd", "chevron-right", ctx.goFwd),
        Box({
          id: id("crumbs"),
          flexGrow: 1,
          flexBasis: 0,
          height: 1,
          flexDirection: "row",
          columnGap: 1,
          overflow: "hidden",
          onMouseDown: () => {
            const now = Date.now();
            if (pathEditMode) return;
            ctx.focusPane?.();
            ctx.closeFileMenu();
            if (now - crumbClickAt < 350) {
              crumbClickAt = 0;
              enterPathEdit();
            } else {
              crumbClickAt = now;
            }
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
    pathEditMode: (): boolean => pathEditMode,
  };
};
