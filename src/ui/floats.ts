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
// - opening the popup replaces an existing popup and keeps the modal below;
// - closing a layer also closes everything opened above it (closing props
//   takes its permission popup with it);
// - closers are raw teardowns captured at open time — they must never call
//   back into this module (public close fns are floats.close wrappers).
//
// Pure module: no renderer imports. z-order table exported for the widgets. ---

export type FloatKind = "filemenu" | "props" | "conflict" | "yesno" | "escmenu";

// z-order of the floating layers — the one table documenting which layer
// renders above which. Outside the stack: band rect 2500 (gesture), progress
// toast 3500 (non-modal chrome), drag ghost 4000 (gesture).
export const FLOAT_Z: Record<FloatKind, number> = {
  escmenu: 3000,
  props: 3300,
  conflict: 3400,
  yesno: 3450,
  filemenu: 3600,
};

export type Floats = {
  /** register a layer as open; `closer` is its raw teardown */
  open(kind: FloatKind, closer: () => void): void;
  /** close `kind` and everything opened above it; no-op when not open */
  close(kind: FloatKind): void;
  /** close everything, top-down */
  closeAll(): void;
  isOpen(kind: FloatKind): boolean;
  top(): FloatKind | null;
  depth(): number;
};

export const makeFloats = (): Floats => {
  type Entry = { kind: FloatKind; closer: () => void };
  let stack: Entry[] = [];

  // top-down so children tear down before their parents
  const runClosers = (entries: Entry[]): void => {
    for (const e of [...entries].reverse()) e.closer();
  };

  const open = (kind: FloatKind, closer: () => void): void => {
    if (kind === "filemenu") {
      const old = stack.filter((e) => e.kind === "filemenu");
      stack = stack.filter((e) => e.kind !== "filemenu");
      runClosers(old);
    } else {
      const all = stack;
      stack = [];
      runClosers(all);
    }
    stack.push({ kind, closer });
  };

  const close = (kind: FloatKind): void => {
    const idx = stack.findIndex((e) => e.kind === kind);
    if (idx < 0) return;
    const victims = stack.slice(idx); // kind + everything above it
    stack = stack.slice(0, idx);
    runClosers(victims);
  };

  const closeAll = (): void => {
    const all = stack;
    stack = [];
    runClosers(all);
  };

  return {
    open,
    close,
    closeAll,
    isOpen: (kind) => stack.some((e) => e.kind === kind),
    top: () => (stack.length ? stack[stack.length - 1]!.kind : null),
    depth: () => stack.length,
  };
};
