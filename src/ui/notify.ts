import { Box, Text } from "@opentui/core";
import type { NotifyLevel } from "../lib/notify-level";
import type { MaybeNode, NodeLike } from "../lib/node-like";
import type { PointerStyle } from "../lib/pointer";
import { hoverEvents, type MakeIconSlot, type SlotElement } from "./ui-slots";

// --- Toast notifications (top-right stack, animated slide-in + fade-out).
// THE single toast stack: plain auto-dismiss toasts AND the sticky transfer
// progress toast all live here as entries, so expiry/close reflows every
// survivor uniformly and two toasts can never share a slot. Takes the theme
// colors and a host handle via ctx so it never imports app state. The level
// vocabulary lives in ../lib/notify-level (leaf, so fs/app/input can name it
// without importing from ui/). ---

export type NotifyCtx = {
  rootAdd(node: unknown): void;
  remove(node: unknown): void;
  byId(id: string): MaybeNode;
  termW(): number;
  // terminal height — caps how far an expanded toast may grow
  termH?(): number;
  accentBg(): string;
  white(): string;
  sidebarFgMuted(): string;
  // level tints — optional with a white fallback; the icon plumbing below
  // (slot/drain/selectable) is required
  ansi1?(): string;
  ansi2?(): string;
  // raster level icon: single-state slot (fg = level color on the toast bg);
  // the async drain swaps the fallback glyph for the tinted raster
  makeIconSlot: MakeIconSlot;
  drainIconQueue(): unknown;
  stripSelectable(): void;
  // config knob [ui] toast-duration-ms (default 3000)
  durationMs?(): number;
  // mouse pointer shape (OSC 22 via the wiring's tty-guarded setter) — a
  // clickable toast shows the pointer, a plain one keeps the default shape
  setPointer?(style: PointerStyle): void;
};

// error toasts linger so the failure is actually read; a longer configured
// duration always wins (never shorten what the user asked for)
export const ERROR_TOAST_MS = 5000;

// pure level mapping (tested): raster icon + title/body fg + lifetime. Stays
// on existing Theme keys (white/ansi1/ansi2) — no new theme knobs. The title
// carries the level tint; the description line is MUTED (the secondary-text
// role), so the stack reads title-first. Toasts keep their accentBg fill in
// every ui-style (a border ring would clip the 2-row content shape, same
// reason tiles stay fill-only).
export const toastLevelMeta = (
  level: NotifyLevel,
  colors: { white: string; muted: string; red: string; green: string },
  durationMs: number,
): { icon: "information" | "check" | "close"; titleFg: string; bodyFg: string; duration: number } => {
  if (level === "error")
    return { icon: "close", titleFg: colors.red, bodyFg: colors.muted, duration: Math.max(durationMs, ERROR_TOAST_MS) };
  if (level === "success") return { icon: "check", titleFg: colors.green, bodyFg: colors.muted, duration: durationMs };
  return { icon: "information", titleFg: colors.white, bodyFg: colors.muted, duration: durationMs };
};

export type ToastHandle = { id: number; nodeId: string; close: () => void };

// one width for every toast (plain notifies AND the progress toast) —
// content-sized widths left the stack with zigzag edges on both sides.
export const TOAST_W = 36;
// word-wrap cap for the generic wrapper (tests + any caller that wants the
// old multi-line body); the notify path below pins its own 2-row content.
export const MAX_TOAST_LINES = 3;

// B1 media-object layout: a 2-row level icon owns a left column, with the
// title + description in a text column beside it. The build-time slot width
// mirrors makeIconSlot's own formula (`heightCells * 2`); the drain re-derives
// it from the terminal's cell aspect (≈4 at the usual ~2.0).
export const TOAST_ICON_CELLS = 2;
export const TOAST_ICON_W = TOAST_ICON_CELLS * 2;
export const TOAST_PAD_X = 1;
// vertical gutter above AND below the content block: every notify is the same
// height and the 2-row icon sits with equal space above and below (the old
// shell only had a stray air row at the bottom, which read as top-heavy).
export const TOAST_PAD_Y = 1;
export const TOAST_GAP = 1;
// wrap/truncate budget for the text column (title + body share it): the toast
// width minus both gutters, the icon column and the gap. Deriving it here keeps
// the strings and the flex layout from drifting apart.
export const TOAST_TEXT_BUDGET = TOAST_W - TOAST_PAD_X * 2 - TOAST_ICON_W - TOAST_GAP;

// The smallest content block: the title row + ONE body row. A toast whose
// message fits in a single line stays exactly this tall, so the common
// stack is the stack it always was.
export const TOAST_CONTENT_ROWS = TOAST_ICON_CELLS;
// total toast height: the content block plus the symmetric top/bottom gutter.
export const TOAST_H = TOAST_CONTENT_ROWS + TOAST_PAD_Y * 2;

// Body rows a toast shows WITHOUT a click. The description used to be folded
// into ONE ellipsized line (29 cells), so a long error ("Create failed ·
// ENOSPC: no space left on device, open '/…'") was unreadable and nothing
// else on screen carried the text. The toast now GROWS to fit its message up
// to this many body rows; past it, the toast is clickable (see TOAST_EXPAND).
export const TOAST_MAX_BODY_LINES = 3;
// The most an expanded toast ever shows — the terminal height caps it lower.
export const TOAST_EXPAND_MAX_LINES = 12;
// How long an expanded toast stays expanded before it folds back and goes
// back on its clock. An expanded toast is held still (it is being READ), but
// it must not live on the screen forever if nobody clicks it again.
export const TOAST_EXPANDED_HOLD_MS = 30000;

// content rows = title + body rows (the title always has its own row)
export const toastContentRows = (bodyLines: number): number => 1 + bodyLines;
// the toast's total height for a message of that many body rows
export const toastHeightFor = (bodyLines: number): number => toastContentRows(bodyLines) + TOAST_PAD_Y * 2;

// How many body rows an expanded toast may show: the cap, bounded by half the
// terminal (a toast must never eat the screen it reports on). A terminal too
// small for that keeps the visible cap.
export const expandCapFor = (termH?: number): number => {
  if (!termH || termH <= 0) return TOAST_EXPAND_MAX_LINES;
  const room = Math.floor(termH / 2) - toastContentRows(0) - TOAST_PAD_Y * 2;
  return Math.max(TOAST_MAX_BODY_LINES, Math.min(TOAST_EXPAND_MAX_LINES, room));
};

// the "there is more" mark on the last visible row of a cut message
export const ellipsizeToastLine = (line: string, budget: number): string => {
  const tail = `${line}…`;
  return tail.length > budget ? truncateToastText(tail, budget) : tail;
};

// truncate with an ellipsis instead of a hard cut
export const truncateToastText = (s: string, budget: number): string =>
  s.length > budget ? `${s.slice(0, Math.max(0, budget - 1))}…` : s;

// greedy word wrap with hard-slicing for space-less runs (URLs, hashes).
// Always returns ≥1 line; overflow past maxLines folds into an ellipsis on
// the last kept line so the cut is visible, never silent.
export const wrapToastText = (s: string, budget: number, maxLines: number = MAX_TOAST_LINES): string[] => {
  const chunks: string[] = [];
  for (const word of s.split(/\s+/).filter(Boolean)) {
    let rest = word;
    while (rest.length > budget) {
      chunks.push(rest.slice(0, budget));
      rest = rest.slice(budget);
    }
    if (rest) chunks.push(rest);
  }
  if (!chunks.length) return [""];
  const lines: string[] = [];
  let cur = "";
  for (const w of chunks) {
    const next = cur ? `${cur} ${w}` : w;
    if (next.length <= budget) cur = next;
    else {
      lines.push(cur);
      cur = w;
    }
  }
  if (cur) lines.push(cur);
  if (lines.length <= maxLines) return lines;
  const kept = lines.slice(0, maxLines);
  // lines.length > maxLines is guaranteed here, so the last kept row exists
  const lastIdx = maxLines - 1;
  const last = kept[lastIdx];
  if (last === undefined) return kept;
  const tail = `${last}…`;
  kept[lastIdx] = tail.length > budget ? truncateToastText(tail, budget) : tail;
  return kept;
};

// The click-to-expand state of one toast. The description is pre-wrapped, so
// "expanding" is a HEIGHT change: the text column grows (its own overflow
// clips the rows past it) and the shell follows. The one line that differs
// between the two views is the cut one, so it carries its own id.
type ToastExpand = {
  // the text column whose height is the visible row count
  columnId: string;
  // the cut line: its id, the compact text (with the "…") and the full text
  lineId: string;
  compactLine: string;
  fullLine: string;
  // body rows: now, and when expanded
  compactBody: number;
  expandedBody: number;
  expanded: boolean;
};

type ToastEntry = {
  id: number;
  nodeId: string;
  height: number;
  sticky: boolean;
  // auto-dismiss handle; null while a sticky toast waits for an explicit close
  // or while the toast is held still (hovered / expanded)
  timer: ReturnType<typeof setTimeout> | null;
  // safety net for the expanded state: an expanded toast is held still, but
  // not FOREVER — after this it collapses and goes back on its clock
  holdTimer: ReturnType<typeof setTimeout> | null;
  // when the toast expires, and the ms that were left when it was paused
  deadline: number;
  remaining: number;
  paused: boolean;
  // the pointer is on the toast: it is held still while it is read
  hovered: boolean;
  // click-to-expand; null = the message fits, there is nothing to expand
  expand: ToastExpand | null;
};

// shared slide-in animation (slide-out is just the reverse direction)
const animateLeft = (node: NodeLike, from: number, to: number, ms: number): void => {
  const steps = 8;
  let i = 0;
  const tick = () => {
    i++;
    try {
      node.left = Math.round(from + ((to - from) * i) / steps);
    } catch {}
    if (i < steps) setTimeout(tick, Math.max(16, ms / steps));
  };
  tick();
};

export const makeNotify = (
  ctx: NotifyCtx,
): {
  notify: (message: string, title?: string, level?: NotifyLevel) => void;
  notifySticky: (children: SlotElement[], opts?: { width?: number; height?: number }) => ToastHandle | null;
} => {
  let toasts: ToastEntry[] = [];
  let toastSeq = 0;

  // slot grid: entries stack downward with a 1-row gap, each at the running
  // sum of the heights above it — a toast is as tall as its message, the
  // progress toast rides the same slot math, so they tile without overlap
  const slotTop = (i: number): number => {
    let y = 1;
    for (let j = 0; j < i; j++) y += (toasts[j]?.height ?? TOAST_H) + 1;
    return y;
  };

  const removeEntry = (id: number): void => {
    const entry = toasts.find((t) => t.id === id);
    if (!entry) return;
    if (entry.timer) {
      try {
        clearTimeout(entry.timer);
      } catch {}
    }
    if (entry.holdTimer) {
      try {
        clearTimeout(entry.holdTimer);
      } catch {}
      entry.holdTimer = null;
    }
    const node = ctx.byId(entry.nodeId);
    try {
      if (node) ctx.remove(node);
    } catch {}
    toasts = toasts.filter((t) => t.id !== id);
    restack();
  };

  // reflow survivors after an expiry or a sticky close — positions derive
  // from live array order, never from show-time counts, so they can't stale
  const restack = (): void => {
    toasts.forEach((t, i) => {
      const n = ctx.byId(t.nodeId);
      // a toast reaped by a rebuild is simply not restacked (this used to rely
      // on a property write on null throwing inside the try)
      if (!n) return;
      try {
        n.top = slotTop(i);
      } catch {}
    });
  };

  // one dismiss path for expiry AND sticky close: fade, then remove +
  // reflow. (The progress toast used to slide out while notifies faded —
  // same stack, same goodbye now.)
  const fadeOut = (id: number): void => {
    const entry = toasts.find((t) => t.id === id);
    if (!entry) return;
    if (entry.timer) {
      try {
        clearTimeout(entry.timer);
      } catch {}
      entry.timer = null;
    }
    if (entry.holdTimer) {
      try {
        clearTimeout(entry.holdTimer);
      } catch {}
      entry.holdTimer = null;
    }
    const real = ctx.byId(entry.nodeId);
    if (!real) {
      removeEntry(id);
      return;
    }
    let op = 1;
    const fade = () => {
      op -= 0.18;
      try {
        real.opacity = Math.max(0, op);
      } catch {}
      if (op > 0) setTimeout(fade, 24);
      else removeEntry(id);
    };
    fade();
  };

  // --- the auto-dismiss clock ---
  // ONE deadline, so a pause (the pointer is on the toast, or the toast is
  // expanded) resumes with the time that was LEFT instead of restarting the
  // whole window — a message must not be yanked away while it is read.
  const startTimer = (entry: ToastEntry, ms: number): void => {
    if (entry.sticky) return;
    entry.remaining = ms;
    entry.deadline = Date.now() + ms;
    entry.timer = setTimeout(() => fadeOut(entry.id), ms);
  };

  const pauseTimer = (entry: ToastEntry): void => {
    if (entry.sticky || !entry.timer) return;
    entry.remaining = Math.max(0, entry.deadline - Date.now());
    try {
      clearTimeout(entry.timer);
    } catch {}
    entry.timer = null;
    entry.paused = true;
  };

  const resumeTimer = (entry: ToastEntry): void => {
    if (entry.sticky || entry.timer || !entry.paused) return;
    entry.paused = false;
    startTimer(entry, entry.remaining);
  };

  // Release the clock only when NOTHING holds the toast: the pointer may
  // still be on it, and it may still be expanded. (A hover-out while the
  // toast is expanded must not put it back on the countdown — the message
  // would vanish while it is being read.)
  const releaseTimer = (entry: ToastEntry): void => {
    if (entry.hovered || entry.expand?.expanded) return;
    resumeTimer(entry);
  };

  // grow/shrink a toast in place: the text column's height is the visible row
  // count (its own overflow clips the rest), the shell follows, and the stack
  // reflows around it
  const setExpanded = (entry: ToastEntry, on: boolean): void => {
    const ex = entry.expand;
    if (!ex) return;
    const body = on ? ex.expandedBody : ex.compactBody;
    ex.expanded = on;
    // the cut line shows its full text while expanded
    const line = ctx.byId(ex.lineId);
    try {
      if (line) line.content = on ? ex.fullLine : ex.compactLine;
    } catch {}
    const col = ctx.byId(ex.columnId);
    try {
      if (col) col.height = toastContentRows(body);
    } catch {}
    const shell = ctx.byId(entry.nodeId);
    try {
      if (shell) shell.height = toastHeightFor(body);
    } catch {}
    entry.height = toastHeightFor(body);
    restack();
    // an expanded toast holds still until it is collapsed again
    if (on) {
      pauseTimer(entry);
      // ...but not forever: an expanded toast folds itself back and goes on
      // its clock if nobody touches it
      if (entry.holdTimer) {
        try {
          clearTimeout(entry.holdTimer);
        } catch {}
      }
      entry.holdTimer = setTimeout(() => {
        entry.holdTimer = null;
        setExpanded(entry, false);
      }, TOAST_EXPANDED_HOLD_MS);
    } else {
      if (entry.holdTimer) {
        try {
          clearTimeout(entry.holdTimer);
        } catch {}
        entry.holdTimer = null;
      }
      releaseTimer(entry);
    }
  };

  const pushToast = (
    id: number,
    width: number,
    height: number,
    children: SlotElement[],
    sticky: boolean,
    duration?: number,
    expand?: ToastExpand | null,
  ): ToastHandle | null => {
    // toasts fire from all over (incl. error paths during native memory
    // pressure — see the OOM note in AGENTS.md); a missing toast must never
    // take the app down, so the whole build is guarded
    try {
      const nodeId = `tfm-toast-${id}`;
      const y = slotTop(toasts.length);
      const entryOf = (): ToastEntry | undefined => toasts.find((t) => t.id === id);
      const node = Box(
        {
          id: nodeId,
          position: "absolute",
          left: ctx.termW() + 2,
          top: y,
          width,
          height,
          zIndex: 3500,
          backgroundColor: ctx.accentBg(),
          flexDirection: "column",
          // symmetric gutter: the old shell had only paddingLeft, so text could
          // touch the right edge (and the icon column needs the left one)
          paddingLeft: TOAST_PAD_X,
          paddingRight: TOAST_PAD_X,
          // matching vertical gutter so the content block is centered
          paddingTop: TOAST_PAD_Y,
          paddingBottom: TOAST_PAD_Y,
          // a clickable toast grows/shrinks on a click; every toast holds
          // still while the pointer is on it, so the click is never a race
          // against the auto-dismiss
          ...(expand
            ? {
                onMouseDown: () => {
                  const entry = entryOf();
                  if (entry?.expand) setExpanded(entry, !entry.expand.expanded);
                },
              }
            : {}),
          ...hoverEvents(
            (on) => {
              const entry = entryOf();
              if (!entry) return;
              entry.hovered = on;
              if (on) pauseTimer(entry);
              else releaseTimer(entry);
            },
            // only a clickable toast shows the pointer. A plain toast writes
            // NO pointer shape at all: the sticky progress toast has buttons
            // of its own, and a toast-level "default" would fight them.
            ctx.setPointer && expand ? (style: PointerStyle) => ctx.setPointer?.(style) : undefined,
          ),
        },
        ...children,
      );
      ctx.rootAdd(node);
      // the proxy is dead weight post-mount — animate/dismiss via the real renderable
      const real = ctx.byId(nodeId);
      if (!real) {
        // lookup miss (the memory-pressure scenario the guard anticipates):
        // the node is mounted but untracked — no timer, no removal path. It
        // must not sit on screen forever.
        try {
          node.destroy?.();
        } catch {}
        return null;
      }
      // re-assert the slot: post-mount this is the prop value already, but a
      // concurrent show may have moved the reservation since y was computed
      try {
        real.top = y;
      } catch {}
      const targetX = Math.max(0, ctx.termW() - width - 2);
      animateLeft(real, ctx.termW() + 2, targetX, 180);
      const entry: ToastEntry = {
        id,
        nodeId,
        height,
        sticky,
        timer: null,
        holdTimer: null,
        deadline: 0,
        remaining: 0,
        paused: false,
        hovered: false,
        expand: expand ?? null,
      };
      toasts.push(entry);
      startTimer(entry, duration ?? ctx.durationMs?.() ?? 3000);
      return {
        id,
        nodeId,
        close: () => fadeOut(id),
      };
    } catch {
      // toast allocation failed (memory pressure) — drop it silently
      return null;
    }
  };

  return {
    notify(message, title = "tfm", level: NotifyLevel = "info") {
      // total-failure-safe like pushToast: toasts fire from error paths under
      // native memory pressure, so a throw anywhere in the build drops the
      // toast instead of taking the reporting call site down with it
      try {
        const w = TOAST_W;
        const meta = toastLevelMeta(
          level,
          {
            white: ctx.white(),
            muted: ctx.sidebarFgMuted(),
            red: ctx.ansi1?.() ?? ctx.white(),
            green: ctx.ansi2?.() ?? ctx.white(),
          },
          ctx.durationMs?.() ?? 3000,
        );
        // The description is READABLE, not folded into one line: it wraps to
        // as many rows as it needs (the terminal caps the expansion) and the
        // toast GROWS to fit. A message past TOAST_MAX_BODY_LINES is cut
        // with a "…" and the toast is clickable — the click shows the rest
        // and holds the toast still.
        const cap = expandCapFor(ctx.termH?.());
        const full = wrapToastText(message, TOAST_TEXT_BUDGET, cap);
        const truncated = full.length > TOAST_MAX_BODY_LINES;
        const visible = truncated ? TOAST_MAX_BODY_LINES : full.length;
        // the cut row: the same line, marked as cut in the compact view
        const cutIdx = truncated ? visible - 1 : -1;
        const compactLine = truncated ? ellipsizeToastLine(full[cutIdx] ?? "", TOAST_TEXT_BUDGET) : "";
        const id = ++toastSeq;
        const columnId = `tfm-toast-txt-${id}`;
        const lineId = `tfm-toast-line-${id}`;
        // the level icon is a 2-row raster slot that owns the toast's left
        // column (B1 media-object layout); the drain swaps the fallback glyph
        // for the tinted raster async. The toast shell is a floating layer
        // whose island keeps its accentBg fill in EVERY ui-style (see
        // FLOAT_TOAST_PREFIX in ui-slots), so this is the raster's flatten
        // target and the icon is opaque under `transparent-partial` like every
        // other float icon — it is decoration, so it has no hover state.
        const slot = ctx.makeIconSlot(meta.icon, [{ fg: meta.titleFg, bg: ctx.accentBg() }], TOAST_ICON_CELLS);
        pushToast(
          id,
          w,
          // the toast is as tall as its message: the content block (title +
          // body rows) plus the symmetric vertical gutter
          toastHeightFor(visible),
          [
            // B1: icon column + text column. The title and the body lines
            // share the text column, so the description hangs INDENTED under
            // the title (both start at TOAST_PAD_X + icon + gap), not at the
            // toast edge. The icon is 2 rows tall and sits at the TOP of the
            // block, next to the title — `flex-start`, because a taller body
            // would push a centered icon into the middle of the message.
            Box(
              { flexDirection: "row", columnGap: TOAST_GAP, alignItems: "flex-start" },
              slot.el,
              Box(
                {
                  id: columnId,
                  flexDirection: "column",
                  // the text column owns the rest of the toast's width: the
                  // lines are pre-wrapped to it, so the column does not change
                  // width when the toast expands
                  width: TOAST_TEXT_BUDGET,
                  // an explicit width turns flex-shrink OFF, and the icon slot
                  // is re-rastered at the terminal's own cell aspect (it can
                  // come back 1 cell wider than the 4 the build reserved) —
                  // the column shrinks instead of pushing the text past the
                  // toast's edge
                  flexShrink: 1,
                  // the column's height IS the visible row count: its own
                  // overflow clips the rows past it, so growing the column is
                  // what reveals them
                  height: toastContentRows(visible),
                  overflow: "hidden",
                },
                Text({ content: truncateToastText(title, TOAST_TEXT_BUDGET), fg: meta.titleFg, flexShrink: 0 }),
                ...full.map((line, i) =>
                  Text({
                    id: i === cutIdx ? lineId : undefined,
                    content: i === cutIdx ? compactLine : line,
                    fg: meta.bodyFg,
                    // a Text shrinks by default, and a shrunk row paints OVER
                    // the one above it — the rows must keep their height so
                    // the column's overflow clips them instead
                    flexShrink: 0,
                  }),
                ),
              ),
            ),
          ],
          false,
          meta.duration,
          truncated
            ? {
                columnId,
                lineId,
                compactLine,
                fullLine: full[cutIdx] ?? "",
                compactBody: visible,
                expandedBody: full.length,
                expanded: false,
              }
            : null,
        );
      } catch {
        return;
      }
      // icon Texts must not enter text-selection mode; the drain is what
      // swaps the fallback glyph for the raster (its async rejection is
      // dropped — same fire-and-forget contract as the progress toast)
      try {
        ctx.stripSelectable();
      } catch {}
      try {
        const pending = ctx.drainIconQueue() as unknown;
        if (pending instanceof Promise) pending.catch(() => {});
      } catch {}
    },
    notifySticky(children, opts) {
      return pushToast(++toastSeq, opts?.width ?? TOAST_W, opts?.height ?? TOAST_H, children, true);
    },
  };
};

// Shared sticky-toast closer for the two notifySticky callers (the transfer
// toast + plugin api.ui): a null handle = no toast — the closer no-ops;
// double-close is a no-op.
export const stickyClose = (handle: ToastHandle | null | undefined): (() => void) => {
  if (!handle) return () => {};
  let closed = false;
  return () => {
    if (closed) return;
    closed = true;
    try {
      handle.close();
    } catch {}
  };
};
