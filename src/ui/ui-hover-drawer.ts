// --- Hover drawer: auto-hide/collapse panels until the mouse nears their edge.
// Pure decision logic (drawerWantsOpen/collapsedSize/collapsedHeight) is
// exported and tested; the factory wires one reused Timeline per panel onto
// the renderer's own timeline engine (0.6.0 getTimelineEngine) and drives
// width/height from a single renderer.root onMouseMove. Never create a
// registers timelines in a Set and createTimeline never unregisters.
//
// Rules learned the hard way elsewhere in this codebase:
// - Drive proximity from onMouseMove ONLY. A synthetic "over" re-fires on a
//   stationary cursor after any hit-grid change (our own animation changes it
//   every frame) — onMouseOver would feed back.
// - Suppress while a modal/drag/rename is active so a drag to the edge does
//   not pop the drawer.
// - Terminal auto-hide must NOT touch the PTY: it clips the host box height.
// - The grid's column budget is the panel's EFFECTIVE width, and it must
//   follow the PAINTED width (the tween's tracked value) — not the logical
//   state. Publishing the FINAL width the moment a slide starts makes the
//   column math disagree with the paint for the whole slide.

import {
  type CliRenderer,
  createTimeline,
  engine,
  getTimelineEngine,
  type JSAnimation,
  type MouseEvent,
} from "@opentui/core";
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

type Timer = ReturnType<typeof setTimeout>;

// The panel's ONE state record.
//
// The old code carried three loose fields next to the tween's own tracked
// width: `open` (the logical state), `initialized` ("has the drawer applied a
// state since the panel became enabled") and `timer` (the armed transition).
// Their combinations could describe panels nobody sees — `open` flipped
// BEFORE the slide finished, so the published effective width (the grid's
// column budget) disagreed with the PAINTED width mid-slide, and
// `initialized` was an unnamed phase of its own.
//
// The phase names the logical state and the slide in flight; the armed timer
// rides INSIDE it (the panel owns its pending transition — "armed" is not a
// second truth about the panel).
export type PanelPhase =
  // the drawer has not applied a state since the panel became enabled (it
  // just came back, or it was disabled): the first mouse move SNAPS (no
  // slide) — a terminal opening sets its own height and must be reclaimed,
  // not drifted. `open` remembers the last logical state so a
  // disable→enable round trip restores that side, not the other one.
  | { kind: "fresh"; open: boolean; timer: Timer | null }
  // closed and settled
  | { kind: "closed"; timer: Timer | null }
  // the opening slide is in flight (the logical state is already "open")
  | { kind: "opening"; timer: Timer | null }
  // open and settled
  | { kind: "open"; timer: Timer | null }
  // the closing slide is in flight (the logical state is already "closed")
  | { kind: "closing"; timer: Timer | null };

// the phase's logical openness — what the hysteresis compares against
export const phaseOpen = (ph: PanelPhase): boolean => {
  switch (ph.kind) {
    case "open":
    case "opening":
      return true;
    case "fresh":
      return ph.open;
    default:
      return false;
  }
};

// the phase with a different armed timer (the timer rides in the record)
const withTimer = (ph: PanelPhase, timer: Timer | null): PanelPhase => {
  switch (ph.kind) {
    case "fresh":
      return { kind: "fresh", open: ph.open, timer };
    case "closed":
      return { kind: "closed", timer };
    case "opening":
      return { kind: "opening", timer };
    case "open":
      return { kind: "open", timer };
    case "closing":
      return { kind: "closing", timer };
  }
};

type Tween = {
  run(target: number, ms: number, onDone?: () => void): void;
  // the value WE last wrote — the PAINTED width. The node's getter lies for a
  // hidden panel (display:none keeps the last laid-out width), so the tracked
  // value is the only honest source.
  value(): number;
};

const makeTween = (
  getNode: () => MaybeNode,
  axis: "width" | "height",
  renderer: CliRenderer,
  owner: Pick<ReturnType<typeof getTimelineEngine>, "register" | "unregister"> | null,
  onWrite?: (v: number) => void,
): Tween => {
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
    // the drawer publishes the effective width from the PAINTED value — the
    // panel's column budget must track the slide, not jump to its target
    onWrite?.(v);
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
        (owner ?? engine).unregister(tl);
      } catch {}
    }
    usedMs = ms;
    // real renderer: register on the owner engine (per-renderer frame loop);
    // fakes keep the legacy default-engine path (never attached). Guarded: a
    // destroyed renderer throws out of getTimelineEngine/attach, and this is
    // the one ensure() outside a play()-level try/catch (driven by mousemove).
    // The fallback strands one un-stepped timeline on the default engine at
    // worst (stop()'s owner-unregister mismatch throws into its own
    // try/catch) — unreachable in practice, nothing drives a dead renderer.
    try {
      tl = owner ? createTimeline({ autoplay: false }, renderer) : createTimeline({ autoplay: false });
    } catch {
      tl = createTimeline({ autoplay: false });
    }
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
    value: () => read(),
  };
};

export type HoverDrawerCtx = {
  renderer: CliRenderer;
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
  // only width panels (sidebar/preview) change how many columns the grid fits
  rebuildsGrid: boolean;
  // a "hidden" collapse must toggle `visible` — width 0 + overflow:hidden does
  // NOT push a scissor rect (OpenTUI requires width > 0), so fixed-width
  // children paint through a zero-width parent
  applyVisible(open: boolean): void;
  phase: PanelPhase;
  tween: Tween;
};

export const makeHoverDrawer = (ctx: HoverDrawerCtx) => {
  // 0.6.0: per-renderer timeline engine (same rule as ui-grid-anim) — the
  // tweens register on this owner; fakes keep the default-engine path.
  let owner: Pick<ReturnType<typeof getTimelineEngine>, "register" | "unregister"> | null = null;
  try {
    if (typeof ctx.renderer?.setFrameCallback === "function") owner = getTimelineEngine(ctx.renderer);
  } catch {}
  const getNode = (id: string): MaybeNode => {
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
        t.visible = visible && ctx.ui().sidebarTitle !== "none";
      } catch {}
    }
  };

  // the width a panel occupies RIGHT NOW — the grid's column budget. With
  // auto-hide on this is the PAINTED width (the tween's tracked value): the
  // logical state would publish the slide's TARGET while the panel is still
  // moving, and the grid's column math would then disagree with the paint.
  const effectiveWidth = (p: Panel): number => {
    const ui = ctx.ui();
    if (p.key === "sidebar") return ui.sidebarAutoHide ? p.tween.value() : ui.sidebarWidth;
    if (p.key === "preview") {
      if (!ui.previewEnabled) return 0;
      return ui.previewAutoHide ? p.tween.value() : ui.previewWidth;
    }
    // the terminal's height never changes the column budget
    return -1;
  };

  // the width a panel takes when the drawer does NOT manage it (auto-hide
  // off): the full configured width (a disabled preview shows nothing).
  const shownWidth = (p: Panel): number => {
    const ui = ctx.ui();
    if (p.key === "sidebar") return ui.sidebarWidth;
    if (p.key === "preview") return ui.previewEnabled ? ui.previewWidth : 0;
    return ui.terminalHeight + 1;
  };

  // publish a panel's effective width (the grid's column budget)
  const publishEffective = (p: Panel): void => {
    const eff = effectiveWidth(p);
    if (p.key === "sidebar") ctx.setEffectiveSidebar(eff);
    else if (p.key === "preview") ctx.setEffectivePreview(eff);
  };

  const makePanel = (spec: Omit<Panel, "phase" | "tween">): Panel => {
    const p = {
      ...spec,
      phase: { kind: "fresh", open: false, timer: null } as PanelPhase,
      tween: null as unknown as Tween,
    };
    // every painted value republishes the effective width — the column
    // budget follows the slide
    p.tween = makeTween(
      () => getNode(spec.nodeId),
      spec.axis,
      ctx.renderer,
      owner,
      () => publishEffective(p),
    );
    return p;
  };

  const panels: Panel[] = [
    makePanel({
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
    }),
    makePanel({
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
    }),
    makePanel({
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
      applyVisible: () => {},
      rebuildsGrid: false,
    }),
  ];

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

  // drop the panel's armed transition (the phase owns its pending timer)
  const clearArmed = (p: Panel): void => {
    const t = p.phase.timer;
    if (t) {
      try {
        clearTimeout(t);
      } catch {}
    }
    p.phase = withTimer(p.phase, null);
  };

  const apply = (p: Panel, open: boolean, animate: boolean): void => {
    // an apply supersedes any armed transition — the timer is CLEARED, not
    // just dropped from the record (a stray timeout would apply a second
    // time, long after the panel settled)
    clearArmed(p);
    // the width the grid assumes right now — the settle compares against it
    const before = effectiveWidth(p);
    const target = open ? p.expanded() : p.collapsed();
    // the phase names the slide in flight; the logical state IS the target
    // from here on (the old `open` field flipped here too)
    p.phase = open ? { kind: "opening", timer: null } : { kind: "closing", timer: null };
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
      // the slide settled — the phase is the settled state now. An armed
      // transition (the mouse left mid-slide) SURVIVES the settle: the
      // pending close still belongs to the panel.
      const armed = p.phase.timer;
      p.phase = open ? { kind: "open", timer: armed } : { kind: "closed", timer: armed };
      if (!open) {
        p.applyVisible(false);
        if (p.key === "sidebar") setTitleVisible(false);
      }
      // rebuild the grid only when a width panel actually changed the column
      // budget, and only once the slide settled
      if (animate && p.rebuildsGrid && effectiveWidth(p) !== before) requestSettle();
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
      clearArmed(p);
      return;
    }
    if (wants === phaseOpen(p.phase)) {
      clearArmed(p);
      return;
    }
    clearArmed(p);
    const ui = ctx.ui();
    const delay = wants ? ui.hoverOpenDelayMs : ui.hoverCloseDelayMs;
    const timer = setTimeout(() => {
      // the timer fired — it is the phase's own, so drop it before acting
      if (p.phase.timer === timer) p.phase = withTimer(p.phase, null);
      if (ctx.blocked() || !p.enabled()) return;
      apply(p, wants, true);
      log(`${p.key} ${wants ? "open" : "close"}`);
    }, delay);
    // the timer rides in the phase record — "armed" is not a second truth
    p.phase = withTimer(p.phase, timer);
  };

  const onMove = (ev: MouseEvent): void => {
    if (ctx.blocked()) return;
    const ui = ctx.ui();
    for (const p of panels) {
      if (!p.enabled()) {
        // the drawer does not manage this panel: drop the armed transition
        // and the applied state (the next move snaps instead of sliding)
        if (p.phase.kind !== "fresh") {
          clearArmed(p);
          p.phase = { kind: "fresh", open: phaseOpen(p.phase), timer: null };
        }
        continue;
      }
      const wants = drawerWantsOpen({
        edge: p.edge,
        pos: p.edge === "bottom" ? ev.y : ev.x,
        size: p.size(),
        expanded: p.expanded(),
        open: phaseOpen(p.phase),
        zone: ui.hoverZoneCells,
      });
      if (p.phase.kind === "fresh") {
        // first move after enable: snap to the correct state (a terminal sets
        // its own height on open; the drawer must reclaim it, not drift)
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
      clearArmed(p);
      if (!p.enabled()) {
        // the drawer stops managing this panel — restore it and forget the
        // applied state (a later enable snaps instead of drifting)
        p.phase = { kind: "fresh", open: phaseOpen(p.phase), timer: null };
        try {
          p.restore();
        } catch {}
        // a panel that just got disabled must be restored to its shown width
        // HERE — the drawer owns panel widths, so it can't rely on applyConfig
        // having reset the node (a width-panel left collapsed would stick)
        if (p.rebuildsGrid) p.tween.run(shownWidth(p), 0);
        publishEffective(p);
        continue;
      }
      apply(p, phaseOpen(p.phase) || keepOpen(p), false);
    }
  };

  // initial state: collapse every enabled panel immediately; disabled panels
  // still publish their effective width so the first grid build is correct
  for (const p of panels) {
    if (p.enabled()) {
      apply(p, false, false);
    } else {
      p.applyVisible(false);
      if (p.rebuildsGrid) p.tween.run(shownWidth(p), 0);
      publishEffective(p);
    }
  }

  // Renderer-owned engine attach already happened in getTimelineEngine()
  // above; fakes take the default-engine path inside makeTween.
  ctx.renderer.root.onMouseMove = onMove;

  return { refresh, onMouseMove: onMove, panels };
};
