// --- Renderer-agnostic UI utilities shared by the wiring layer and the
// widget modules. No OpenTUI/renderer imports — nodes arrive as parameters. ---

// clear-and-rebuild idiom used by every dynamic host (crumbs, sidebar, tab
// strip, menus, grid): drop all children of a renderable. Nodes arrive as
// unknown — OpenTUI hosts are heterogeneous — and are narrowed structurally
// instead of `any`.
type ChildHost = { getChildren: () => Iterable<unknown>; remove: (child: unknown) => void };

const isChildHost = (v: unknown): v is ChildHost =>
  typeof v === "object" &&
  v !== null &&
  "getChildren" in v &&
  "remove" in v &&
  typeof v.getChildren === "function" &&
  typeof v.remove === "function";

export const clearChildren = (node: unknown): void => {
  if (!isChildHost(node)) return;
  try {
    const kids = [...node.getChildren()];
    for (const c of kids) {
      try {
        node.remove(c);
      } catch {}
    }
  } catch {}
};

// trailing debounce: every call pushes the run `ms` back; the body sees the
// latest closure state when it finally fires
// injectable timer pair: tests pass a virtual clock (Bun has no fake
// timers), production defaults to the real one
export type Scheduler = {
  setTimeout(cb: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
};

export const debounced = (ms: number, fn: () => void, sched: Scheduler = globalThis): (() => void) => {
  let t: unknown = null;
  return () => {
    if (t) sched.clearTimeout(t);
    t = sched.setTimeout(() => {
      t = null;
      fn();
    }, ms);
  };
};

// render-path guard: a throw inside one repaint step must not blank the pane
// or kill the rest — log it (injected) and keep the other steps running

// log detail for a caught value: a present .stack wins, else the value
// itself (template-stringified by the caller) — same output as before
const errDetail = (err: unknown): unknown => {
  if (typeof err === "object" && err !== null && "stack" in err) return err.stack ?? err;
  return err;
};

export const safeRenderStep = (
  name: string,
  fn: () => void | Promise<void>,
  log: (msg: string) => void = () => {},
): void => {
  try {
    const r = fn();
    if (r instanceof Promise) r.catch((err) => log(`render ${name} (async): ${errDetail(err)}`));
  } catch (err: unknown) {
    log(`render ${name}: ${errDetail(err)}`);
  }
};
