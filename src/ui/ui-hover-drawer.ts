// --- Hover drawer: auto-hide/collapse panels until the mouse nears their edge.
// Pure decision logic (drawerWantsOpen/collapsedSize/collapsedHeight) is
// exported and tested; the factory wires one reused Timeline per panel onto
// OpenTUI's frame loop (engine.attach) and drives width/height from a single
// renderer.root onMouseMove. Never create a timeline per event — the engine
// registers timelines in a Set and createTimeline never unregisters.
//
// Rules learned the hard way elsewhere in this codebase:
// - Drive proximity from onMouseMove ONLY. A synthetic "over" re-fires on a
//   stationary cursor after any hit-grid change (our own animation changes it
//   every frame) — onMouseOver would feed back.
// - Suppress while a modal/drag/rename is active so a drag to the edge does
//   not pop the drawer.
// - Terminal auto-hide must NOT touch the PTY: it clips the host box height.

import { createTimeline, engine, type JSAnimation } from "@opentui/core";
import type { UiConfig } from "../config/config-schema";
import type { MaybeNode } from "../lib/node-like";

export type DrawerEdge = "left" | "right" | "bottom";

// cells the cursor may sit PAST the expanded panel edge and keep it open
const HYSTERESIS_MARGIN = 1;
const RAIL_W = 4;
const MIN_W = 8;

// pure: should the panel be open at `pos` along `edge`? `size` is the terminal
// dimension along that edge. Closed panels open when the cursor is within
// `zone` cells of the edge; open panels stay open until the cursor clears the
// panel's own edge by `margin` cells (else jitter retriggers).
export const drawerWantsOpen = (o: {
  edge: DrawerEdge;
  pos: number;
  size: number;
  expanded: number;
  open: boolean;
  zone: number;
  margin?: number;
}): boolean => {
  const dist = o.edge === "left" ? o.pos : o.size - 1 - o.pos;
  const margin = o.margin ?? HYSTERESIS_MARGIN;
  return o.open ? dist <= o.expanded - 1 + margin : dist < o.zone;
};

// pure: collapsed width for a width-axis panel
export const collapsedSize = (style: string): number => {
  if (style === "rail") return RAIL_W;
  if (style === "hidden") return 0;
  return MIN_W;
};

// pure: collapsed height for the terminal pane ("header" keeps the title row)
export const collapsedHeight = (style: string): number => (style === "header" ? 1 : 0);

type Tween = { run(target: number, ms: number, onDone?: () => void): void };

const makeTween = (getNode: () => any, axis: "width" | "height"): Tween => {
  let tl: ReturnType<typeof createTimeline> | null = null;
  let usedMs = -1;
  let from = 0;
  let to = 0;
  let onDone: (() => void) | undefined;
  // Last value WE wrote. Never trust the node's getter for `from`: a hidden
  // (display:none) panel keeps its last laid-out width, so reading it back
  // makes `cur === target` and the slide is skipped (the "no animation after
  // first trigger" bug with the hidden collapse style).
  let current: number | null = null;
  const holder = { t: 0 };
  const read = (): number => {
    if (current !== null) return current;
    const n = getNode();
    const v = n?.[axis];
    current = typeof v === "number" ? v : 0;
    return current;
  };
  const write = (v: number): void => {
    current = v;
    const n = getNode();
    if (!n) return;
    try {
      n[axis] = v;
    } catch {}
  };
  // one item, reused: onUpdate lerps from the live `from`/`to` so restart()
  // retargets without accumulating timeline items
  const ensure = (ms: number): void => {
    if (tl && usedMs === ms) return;
    if (tl) {
      try {
        engine.unregister(tl);
      } catch {}
    }
    usedMs = ms;
    tl = createTimeline({ autoplay: false });
    tl.add(holder, {
      t: 1,
      duration: ms,
      ease: "outQuad",
      onUpdate: (a: JSAnimation) => write(Math.round(from + (to - from) * a.progress)),
      // settle hook: fires once the slide finishes (the grid rebuilds columns
      // from the new effective width here, not per frame)
      onComplete: () => onDone?.(),
    });
  };
  return {
    run(target, ms, done) {
      onDone = done;
      const cur = read();
      from = cur;
      to = target;
      if (ms <= 0 || cur === target) {
        write(target);
        onDone?.();
        return;
      }
      // make the node match our tracked value before the first frame (a hidden
      // panel may still hold a stale layout width)
      write(cur);
      ensure(ms);
      tl?.restart();
    },
  };
};

export type HoverDrawerCtx = {
  renderer: any;
  byId(id: string): MaybeNode;
  ui(): UiConfig;
  terminalOpen(): boolean;
  // keyboard focus inside the embedded shell — a focused terminal never
  // collapses (typing into a 1-row pane), pinned open until blur
  terminalFocused(): boolean;
  blocked(): boolean;
  // grid column budget a panel leaves on its side, so renderGrid re-columns
  // after an auto-hide (the node width changes but ctx.sw/previewEff don't)
  setEffectiveSidebar(n: number): void;
  setEffectivePreview(n: number): void;
  // called when a slide settles — the grid rebuilds its rows here
  onSettle?(): void;
  log?(msg: string): void;
};

type Panel = {
  key: "sidebar" | "preview" | "terminal";
  edge: DrawerEdge;
  nodeId: string;
  axis: "width" | "height";
  enabled(): boolean;
  expanded(): number;
  collapsed(): number;
  size(): number;
  restore(): void;
  // width this panel occupies for grid column math (width panels only; -1 = n/a)
  effective(open: boolean): number;
  // only width panels (sidebar/preview) change how many columns the grid fits
  rebuildsGrid: boolean;
  // last published effective width — a settle only rebuilds when it changed
  lastEff: number;
  // a "hidden" collapse must toggle `visible` — width 0 + overflow:hidden does
  // NOT push a scissor rect (OpenTUI requires width > 0), so fixed-width
  // children paint through a zero-width parent
  applyVisible(open: boolean): void;
  open: boolean;
  // false until the drawer has applied a state to this panel since it became
  // enabled — a terminal opening (which sets its own height) must snap, not
  // drift, on the next near-edge move
  initialized: boolean;
  timer: ReturnType<typeof setTimeout> | null;
  tween: Tween;
};

export const makeHoverDrawer = (ctx: HoverDrawerCtx) => {
  const getNode = (id: string): any => {
    try {
      return ctx.byId(id);
    } catch {
      return null;
    }
  };
  const log = (msg: string): void => ctx.log?.(msg);

  const setTitleVisible = (visible: boolean): void => {
    const t = getNode("tfm-title-box");
    if (t) {
      try {
        // the drawer's open state AND the [ui] sidebar-title preference
        t.visible = visible && ctx.ui().sidebarTitle;
      } catch {}
    }
  };

  const panels: Panel[] = [
    {
      key: "sidebar",
      edge: "left",
      nodeId: "tfm-sidebar-root",
      axis: "width",
      enabled: () => ctx.ui().sidebarAutoHide,
      expanded: () => ctx.ui().sidebarWidth,
      collapsed: () => collapsedSize(ctx.ui().sidebarCollapseStyle),
      size: () => ctx.renderer.terminalWidth,
      restore: () => {
        setTitleVisible(true);
        const n = getNode("tfm-sidebar-root");
        if (n) {
          try {
            n.visible = true;
          } catch {}
        }
      },
      effective: (open) => {
        const ui = ctx.ui();
        return ui.sidebarAutoHide ? (open ? ui.sidebarWidth : collapsedSize(ui.sidebarCollapseStyle)) : ui.sidebarWidth;
      },
      applyVisible: (open) => {
        const ui = ctx.ui();
        const n = getNode("tfm-sidebar-root");
        if (n) {
          try {
            n.visible = !(ui.sidebarAutoHide && !open && ui.sidebarCollapseStyle === "hidden");
          } catch {}
        }
      },
      rebuildsGrid: true,
      lastEff: -1,
      open: false,
      initialized: false,
      timer: null,
      tween: makeTween(() => getNode("tfm-sidebar-root"), "width"),
    },
    {
      key: "preview",
      edge: "right",
      nodeId: "tfm-preview",
      axis: "width",
      enabled: () => ctx.ui().previewAutoHide && ctx.ui().previewEnabled,
      expanded: () => ctx.ui().previewWidth,
      collapsed: () => collapsedSize(ctx.ui().previewCollapseStyle),
      size: () => ctx.renderer.terminalWidth,
      restore: () => {
        const n = getNode("tfm-preview");
        if (n) {
          try {
            n.visible = ctx.ui().previewEnabled;
          } catch {}
        }
      },
      effective: (open) => {
        const ui = ctx.ui();
        if (!ui.previewEnabled) return 0;
        return ui.previewAutoHide ? (open ? ui.previewWidth : collapsedSize(ui.previewCollapseStyle)) : ui.previewWidth;
      },
      applyVisible: (open) => {
        const ui = ctx.ui();
        const n = getNode("tfm-preview");
        if (n) {
          try {
            n.visible = ui.previewEnabled && !(ui.previewAutoHide && !open && ui.previewCollapseStyle === "hidden");
          } catch {}
        }
      },
      rebuildsGrid: true,
      lastEff: -1,
      open: false,
      initialized: false,
      timer: null,
      tween: makeTween(() => getNode("tfm-preview"), "width"),
    },
    {
      key: "terminal",
      edge: "bottom",
      nodeId: "tfm-term-host",
      axis: "height",
      enabled: () => ctx.ui().terminalAutoHide && ctx.terminalOpen(),
      expanded: () => ctx.ui().terminalHeight + 1,
      collapsed: () => collapsedHeight(ctx.ui().terminalCollapseStyle),
      size: () => ctx.renderer.terminalHeight,
      // terminal open + auto-hide just got disabled: restore its full height
      restore: () => {
        if (!ctx.terminalOpen()) return;
        const n = getNode("tfm-term-host");
        if (n) {
          try {
            n.height = ctx.ui().terminalHeight + 1;
          } catch {}
        }
      },
      effective: () => -1,
      applyVisible: () => {},
      rebuildsGrid: false,
      lastEff: -1,
      open: false,
      initialized: false,
      timer: null,
      tween: makeTween(() => getNode("tfm-term-host"), "height"),
    },
  ];

  // publish a panel's effective width and report whether it changed
  const writeEffective = (p: Panel): boolean => {
    const eff = p.effective(p.open);
    if (p.key === "sidebar") ctx.setEffectiveSidebar(eff);
    else if (p.key === "preview") ctx.setEffectivePreview(eff);
    const changed = eff !== p.lastEff;
    p.lastEff = eff;
    return changed;
  };

  // coalesce rebuild requests from both width panels into ONE grid rebuild
  // (rapid pane toggling used to wave a full clear+rebuild per toggle, which is
  // exactly the native-alloc churn that wedges the allocator — see AGENTS OOM)
  let settleTimer: ReturnType<typeof setTimeout> | null = null;
  const requestSettle = (): void => {
    if (settleTimer) clearTimeout(settleTimer);
    settleTimer = setTimeout(() => {
      settleTimer = null;
      // never rebuild under a modal/drag/rename — the column math would run
      // on a hidden grid and churn native buffers for nothing
      if (ctx.blocked()) return;
      ctx.onSettle?.();
    }, 80);
  };

  const apply = (p: Panel, open: boolean, animate: boolean): void => {
    p.open = open;
    const target = open ? p.expanded() : p.collapsed();
    const widthChanged = writeEffective(p);
    // Reveal BEFORE an open slide. A close does NOT hide immediately: a
    // `hidden` collapse must stay visible for the whole slide and hide on
    // settle, or the collapse is never seen (it just blinks away). At width 0
    // the scissor is skipped, so hiding in the same frame as the final write
    // (before render) is what keeps the fixed-width children from leaking.
    if (open) {
      p.applyVisible(true);
      if (p.key === "sidebar") setTitleVisible(true);
    }
    p.tween.run(target, animate ? ctx.ui().hoverAnimMs : 0, () => {
      if (!p.open) {
        p.applyVisible(false);
        if (p.key === "sidebar") setTitleVisible(false);
      }
      // rebuild the grid only when a width panel actually changed the column
      // budget, and only once the slide settled
      if (animate && p.rebuildsGrid && widthChanged) requestSettle();
    });
  };

  // pin-open check shared by the timer path above and the direct-apply
  // paths below (first-move snap, refresh): a focused terminal reads open
  // no matter what the mouse says
  const keepOpen = (p: Panel): boolean => p.key === "terminal" && ctx.terminalFocused();

  const schedule = (p: Panel, wants: boolean): void => {
    // a keyboard-focused terminal never collapses: drop the close (and any
    // armed close timer) instead of scheduling it — opens proceed normally
    if (!wants && keepOpen(p)) {
      if (p.timer) {
        clearTimeout(p.timer);
        p.timer = null;
      }
      return;
    }
    if (wants === p.open) {
      if (p.timer) {
        clearTimeout(p.timer);
        p.timer = null;
      }
      return;
    }
    if (p.timer) clearTimeout(p.timer);
    const ui = ctx.ui();
    const delay = wants ? ui.hoverOpenDelayMs : ui.hoverCloseDelayMs;
    p.timer = setTimeout(() => {
      p.timer = null;
      if (ctx.blocked() || !p.enabled()) return;
      apply(p, wants, true);
      log(`${p.key} ${wants ? "open" : "close"}`);
    }, delay);
  };

  const onMove = (ev: any): void => {
    if (ctx.blocked()) return;
    const ui = ctx.ui();
    for (const p of panels) {
      if (!p.enabled()) {
        p.initialized = false;
        continue;
      }
      const wants = drawerWantsOpen({
        edge: p.edge,
        pos: p.edge === "bottom" ? ev.y : ev.x,
        size: p.size(),
        expanded: p.expanded(),
        open: p.open,
        zone: ui.hoverZoneCells,
      });
      // first move after enable: snap to the correct state (a terminal sets its
      // own height on open; the drawer must reclaim it, not drift)
      if (!p.initialized) {
        p.initialized = true;
        apply(p, wants || keepOpen(p), false);
        continue;
      }
      schedule(p, wants);
    }
  };

  // Resync after a config/theme change: rethemeChrome writes the full sidebar
  // width by id, which would snap an auto-hidden panel open. Apply current
  // states without animation, and restore panels that just got disabled.
  const refresh = (): void => {
    for (const p of panels) {
      if (p.timer) {
        clearTimeout(p.timer);
        p.timer = null;
      }
      if (!p.enabled()) {
        p.initialized = false;
        try {
          p.restore();
        } catch {}
        // a panel that just got disabled must be restored to its shown width
        // HERE — the drawer owns panel widths, so it can't rely on applyConfig
        // having reset the node (a width-panel left collapsed would stick)
        if (p.rebuildsGrid) p.tween.run(p.effective(true), 0);
        writeEffective(p);
        continue;
      }
      apply(p, p.open || keepOpen(p), false);
      p.initialized = true;
    }
  };

  // initial state: collapse every enabled panel immediately; disabled panels
  // still publish their effective width so the first grid build is correct
  for (const p of panels) {
    if (p.enabled()) {
      apply(p, false, false);
      p.initialized = true;
    } else {
      p.applyVisible(p.open);
      if (p.rebuildsGrid) p.tween.run(p.effective(true), 0);
      writeEffective(p);
    }
  }

  try {
    engine.attach(ctx.renderer);
  } catch {}
  ctx.renderer.root.onMouseMove = onMove;

  return { refresh, onMouseMove: onMove, panels };
};
