// --- Floating layers: THE single source of truth for which modal/cursor
// layer is open, in what order, and who gets dismissed when. Widgets keep
// their rendering and their internal render-guard flags, but every open/close
// transition routes through here — a layer can no longer be forgotten on
// screen because dismissal is POLICY, not per-call-site bookkeeping.
//
// Model: at most ONE modal layer (escmenu/props/conflict/yesno) plus at most
// ONE cursor popup (filemenu) on top of it — the popup legitimately spawns
// from inside a modal (the permission menu inside the properties dialog).
//
// Policy (lives here, nowhere else):
// - opening a modal clears the whole desktop (popup + any other modal) first;
// - opening a DESKTOP popup (the right-click context menu) clears the whole
//   desktop too — ONE floating UI at a time. A right-click that lands in the
//   same frame as a modal opens slips past the modal's scrim (the scrim has
//   no layout yet), and keeping the modal would leave both on screen;
// - a NESTED popup (keepModalBelow — the permission menu inside the
//   properties dialog) replaces an existing popup and keeps the modal below;
// - closing a layer also closes everything opened above it (closing props
//   takes its permission popup with it);
// - closers are raw teardowns captured at open time — they must never call
//   back into this module (public close fns are floats.close wrappers).
//
// Pure module: no renderer imports. z-order table exported for the widgets. ---

import type { FloatKind } from "../lib/float-kind";

// z-order of the floating layers — the one table documenting which layer
// renders above which. Outside the stack: band rect 2500 (gesture), progress
// toast 3500 (non-modal chrome), drag ghost 4000 (gesture).
export const FLOAT_Z: Record<FloatKind, number> = {
  escmenu: 3000,
  props: 3300,
  conflict: 3400,
  yesno: 3450,
  filemenu: 3600,
  // generic filter-list overlay (the core command palette + api.ui.pick): the
  // newest modal wins, so it sits on top; opening one dismisses the rest
  // through the standard modal policy below
  pick: 3700,
  // single-line text prompt (plugin git-URL entry): above pick so it
  // replaces the palette via the modal policy instead of stacking scrims
  // (floats depth stays 1)
  prompt: 3750,
  // bulk-rename editor (F2 on a multi-selection): newest modal, same
  // replace-don't-stack rule
  bulkrename: 3760,
};

export type Floats = {
  /**
   * register a layer as open; `closer` is its raw teardown.
   *
   * `keepModalBelow` marks a popup that BELONGS to the modal underneath it
   * (the properties dialog's permission menu): it replaces an existing popup
   * but leaves that modal open. A desktop popup (the right-click context
   * menu) omits it and clears the whole desktop instead.
   */
  open(kind: FloatKind, closer: () => void, opts?: FloatOpenOpts): void;
  /** close `kind` and everything opened above it; no-op when not open */
  close(kind: FloatKind): void;
  /** close everything, top-down */
  closeAll(): void;
  isOpen(kind: FloatKind): boolean;
  top(): FloatKind | null;
  depth(): number;
  /** any layer above the filemenu popup is a modal (the popup may live
   * inside one — props + its permission menu). Used for the raster scrim. */
  hasModal(): boolean;
};

// how a popup relates to the modal below it — see Floats.open.
export type FloatOpenOpts = {
  /** the popup belongs to the modal underneath (the props permission menu) */
  keepModalBelow?: boolean;
};

// `onModalChange` fires on every 0<->1 modal transition (the background
// raster scrim hooks here). Keep it optional so the pure module stays
// renderer-free and the existing tests call makeFloats() with no args.
export const makeFloats = (opts: { onModalChange?: (open: boolean) => void } = {}): Floats => {
  const { onModalChange } = opts;
  type Entry = { kind: FloatKind; closer: () => void };
  let stack: Entry[] = [];
  let modalLast = false;

  // top-down so children tear down before their parents
  const runClosers = (entries: Entry[]): void => {
    for (const e of [...entries].reverse()) e.closer();
  };

  const hasModal = (): boolean => stack.some((e) => e.kind !== "filemenu");

  const syncModal = (): void => {
    if (!onModalChange) return;
    const now = hasModal();
    if (now === modalLast) return;
    modalLast = now;
    try {
      onModalChange(now);
    } catch {}
  };

  const open = (kind: FloatKind, closer: () => void, opts?: FloatOpenOpts): void => {
    // a popup that belongs to the modal below it (the props permission menu)
    // keeps that modal; everything else — a modal, or a DESKTOP popup — clears
    // the whole desktop, so only ONE floating UI is ever on screen.
    const nested = kind === "filemenu" && opts?.keepModalBelow === true;
    if (nested) {
      const old = stack.filter((e) => e.kind === "filemenu");
      stack = stack.filter((e) => e.kind !== "filemenu");
      runClosers(old);
    } else {
      const all = stack;
      stack = [];
      runClosers(all);
      // stack-emptied dip: a modal the closer itself just cleared (e.g. a
      // confirm opening over the esc-menu ran its content-dim(false)) must
      // refire below, or the new modal paints with the background undimmed
      syncModal();
    }
    stack.push({ kind, closer });
    syncModal();
  };

  const close = (kind: FloatKind): void => {
    const idx = stack.findIndex((e) => e.kind === kind);
    if (idx < 0) return;
    const victims = stack.slice(idx); // kind + everything above it
    stack = stack.slice(0, idx);
    runClosers(victims);
    syncModal();
  };

  const closeAll = (): void => {
    const all = stack;
    stack = [];
    runClosers(all);
    syncModal();
  };

  return {
    open,
    close,
    closeAll,
    isOpen: (kind) => stack.some((e) => e.kind === kind),
    top: () => stack[stack.length - 1]?.kind ?? null,
    depth: () => stack.length,
    hasModal,
  };
};
