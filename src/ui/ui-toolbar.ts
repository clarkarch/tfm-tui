// --- Toolbar: back/fwd nav buttons, breadcrumb path row (with the double-click
// inline path editor), sort + search buttons — as a factory with injected
// callbacks (same seam as ui-chrome.ts). The search QUERY state lives in
// ./search and the keyboard router in ./keymap; this module owns the
// pathEditMode flag and the hover-button raster/surface plumbing. ---

import path from "node:path";
import os from "node:os";
import { Box, Input, InputRenderable, Text } from "@opentui/core";
import { applySurface, btnSurface } from "./style";
import type { Theme } from "../config/config";
import { RECENT_URI, STARRED_URI, isVirtualUri } from "../fs/uri";
import type { IconSpec, IconState } from "./ui-slots";
import { navIconState, toggleIconState } from "./ui-slots";
import type { ListEntry } from "./ui-menu";

export type MakeIconSlotFn = (
  name: string,
  states: IconState[],
  heightCells?: number,
  initialState?: number,
  onMouseDown?: (ev: any) => void,
  statesFactory?: () => IconState[],
) => { spec: IconSpec; el: any };

export type ToolbarCtx = {
  renderer(): any;
  byId(id: string): any;
  clearChildren(node: any): void;
  stripSelectable(): void;
  uiStyle(): "solid" | "outline";
  // live theme — always read through the getter, never captured
  colors(): Theme & Record<string, any>;
  makeIconSlot: MakeIconSlotFn;
  setIconState(spec: IconSpec, index: number): void;
  closeFileMenu(): void;
  blurTerminal(): void;
  navigate(dir: string): void;
  canBack(): boolean;
  canFwd(): boolean;
  goBack(): void;
  goFwd(): void;
  openContextMenu(x: number, y: number, title: string, entries: ListEntry[]): void;
  sortEntries(): ListEntry[];
  cwd(): string;
  home: string;
};

export const makeToolbar = (ctx: ToolbarCtx) => {
  const { makeIconSlot, setIconState } = ctx;

  // --- nav buttons: 4 baked rasters each (enabled/disabled × normal/hover;
  // bg baked into the png so the wrapper box bg must swap in lockstep) ---
  const navSpecs: Record<"tfm-nav-back" | "tfm-nav-fwd", IconSpec | undefined> = {
    "tfm-nav-back": undefined,
    "tfm-nav-fwd": undefined,
  };
  const navHover: Record<string, boolean> = {};

  const navBtnBg = (id: string) => {
    try {
      const n: any = ctx.byId(id);
      if (n) applySurface(n, btnSurface(ctx.uiStyle(), ctx.colors(), !!navHover[id]));
    } catch {}
  };

  const makeNavButton = (id: "tfm-nav-back" | "tfm-nav-fwd", iconName: string, onActivate: () => void) => {
    const states = (): IconState[] => [
      { fg: ctx.colors().sidebarFg, bg: ctx.colors().bg },
      { fg: ctx.colors().sidebarFgMuted, bg: ctx.colors().bg },
      { fg: ctx.colors().sidebarFg, bg: ctx.colors().hoverBg },
      { fg: ctx.colors().sidebarFgMuted, bg: ctx.colors().hoverBg },
    ];
    const slot = makeIconSlot(iconName, states(), 1, 0, undefined, states);
    navSpecs[id] = slot.spec;
    return Box(
      {
        id,
        height: 1,
        width: 3,
        justifyContent: "center",
        ...btnSurface(ctx.uiStyle(), ctx.colors(), false),
        onMouseDown: () => {
          ctx.closeFileMenu();
          onActivate();
        },
        onMouseOver: () => {
          navHover[id] = true;
          refreshNav();
        },
        onMouseOut: () => {
          navHover[id] = false;
          refreshNav();
        },
      },
      slot.el,
    );
  };

  const refreshNav = () => {
    const setBtn = (id: string, spec: IconSpec | undefined, on: boolean) => {
      if (!spec) return;
      setIconState(spec, navIconState(on, !!navHover[id]));
      navBtnBg(id);
    };
    setBtn("tfm-nav-back", navSpecs["tfm-nav-back"], ctx.canBack());
    setBtn("tfm-nav-fwd", navSpecs["tfm-nav-fwd"], ctx.canFwd());
  };

  // retheme helper: box bg must track the new palette between raster swaps
  const repaintButtons = (): void => {
    for (const id of ["tfm-nav-back", "tfm-nav-fwd", "tfm-search-btn", "tfm-sort-btn"]) {
      try {
        const n: any = ctx.byId(id);
        if (n) applySurface(n, btnSurface(ctx.uiStyle(), ctx.colors(), !!navHover[id]));
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
    const box: any = ctx.byId("tfm-crumbs");
    if (!box) return;

    if (pathEditMode) {
      ctx.clearChildren(box);
      let input: any = ctx.byId("tfm-path-input");
      if (!input) {
        // real class instance: proxied composition nodes don't mount under an
        // already-mounted parent
        input = new InputRenderable(ctx.renderer(), {
          id: "tfm-path-input",
          flexGrow: 1,
          value: isVirtualUri(ctx.cwd()) ? ctx.cwd() : path.resolve(ctx.cwd()),
          backgroundColor: ctx.colors().accentBg,
          focusedBackgroundColor: ctx.colors().accentBg,
          textColor: ctx.colors().white,
        });
        box.add(input);
        input.on?.("enter", () => {
          const target = String((input as any).value ?? "").replace(/^~(?=\/|$)/, ctx.home);
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
          const n: any = ctx.byId(`tfm-crumb-${i}`);
          if (n) applySurface(n, btnSurface(ctx.uiStyle(), ctx.colors(), on && !current));
        } catch {}
      };
      const crumb = Box(
        {
          id: `tfm-crumb-${i}`,
          height: 1,
          flexDirection: "row",
          alignItems: "center",
          columnGap: 1,
          ...btnSurface(ctx.uiStyle(), ctx.colors(), false),
          ...(current
            ? {}
            : {
                onMouseDown: () => ctx.navigate(c.target),
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
        onMouseDown,
        onMouseOver: () => paint(true),
        onMouseOut: () => paint(false),
      },
      slot.el,
    );
  };

  const makeSearch = () => {
    const wrap = Box({ id: "tfm-search-wrap", height: 1, flexDirection: "row" });

    const input = Input({
      id: "tfm-search",
      width: 16,
      visible: false,
      placeholder: "Search",
      backgroundColor: ctx.colors().accentBg,
      focusedBackgroundColor: ctx.colors().accentBg,
      textColor: ctx.colors().white,
    });

    wrap.add(
      hoverBtn("tfm-search-btn", "search", () => {
        ctx.closeFileMenu();
        ctx.blurTerminal();
        const el: any = ctx.byId("tfm-search");
        if (!el) return;
        el.visible = !el.visible;
        if (el.visible) el.focus();
      }),
    );
    wrap.add(input);
    return wrap;
  };

  const makeSortButton = (): ReturnType<typeof Box> =>
    hoverBtn("tfm-sort-btn", "sort", (ev: any) => {
      ctx.closeFileMenu();
      ctx.openContextMenu(ev.x, ev.y, "", ctx.sortEntries());
    });

  const makeToolbarShell = (): ReturnType<typeof Box> =>
    Box(
      {
        id: "tfm-toolbar",
        width: "100%",
        height: 1,
        flexDirection: "row",
        paddingLeft: 1,
        paddingRight: 1,
        columnGap: 1,
      },
      Box(
        { height: 1, flexGrow: 1, flexBasis: 0, overflow: "hidden", flexDirection: "row", columnGap: 1 },
        makeNavButton("tfm-nav-back", "chevron-left", ctx.goBack),
        makeNavButton("tfm-nav-fwd", "chevron-right", ctx.goFwd),
        Box({
          id: "tfm-crumbs",
          flexGrow: 1,
          flexBasis: 0,
          height: 1,
          flexDirection: "row",
          columnGap: 1,
          overflow: "hidden",
          onMouseDown: () => {
            const now = Date.now();
            if (pathEditMode) return;
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
