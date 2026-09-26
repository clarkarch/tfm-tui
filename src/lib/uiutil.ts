// --- Renderer-agnostic UI utilities. Canonical home (was src/ui/uiutil.ts).
// Moved to src/lib/ because fs/ (watcher, recent-open) and app/ (nav,
// render-all) need debounced/safeRenderStep — importing those from ui/
// inverted the layering (fs -> ui for a 3-line debounce). All import sites
// were rewritten; there is no re-export shim. ---

type ChildHost = { getChildren: () => Iterable<unknown>; remove: (child: unknown) => void };

const isChildHost = (v: unknown): v is ChildHost =>
  typeof v === "object" &&
  v !== null &&
  "getChildren" in v &&
  "remove" in v &&
  typeof v.getChildren === "function" &&
  typeof v.remove === "function";

// Teardown that also DESTROYS the removed children. OpenTUI renderables own
// native memory (TextBuffers, images) freed by a bun finalizer, and bun only
// GCs on JS-heap pressure — never on native pressure (see app/mem-hygiene).
// Detaching without destroy() therefore defers the free to the next 10s poke;
// a rebuild/resize/theme-flip storm outruns it and the native allocator grows
// until small allocations fail (the documented "Failed to create TextBuffer" /
// vanishing floating-UI crash). `keep` (when given) is removed but NOT
// destroyed — the preview pane re-adds its cached node, so destroying it here
// would be a use-after-destroy (its whole SUBTREE is preserved too).
//
// MUST recurse: OpenTUI's `destroy()` only DETACHES its own children (the
// recursive API is the separate `destroyRecursively()`), so a one-level
// destroy destroyed just the container and left every nested tile's
// TextBuffer alive until the GC poke — the exact leak this helper exists to
// prevent. Verified against opentui/core (Renderable.destroy removes children
// without destroying them) and pinned by the nested case in uiutil.test.ts.
type Destroyable = { getChildren?: () => Iterable<unknown>; destroy?: () => void };

// bottom-up: children BEFORE their parent — destroy() clears the child list,
// so a parent-first walk would have nothing left to recurse into
const destroySubtree = (node: unknown, keep: unknown): void => {
  if (node === null || node === undefined) return;
  if (keep !== undefined && node === keep) return;
  const n = node as Destroyable;
  if (typeof n.getChildren === "function") {
    let kids: unknown[] = [];
    try {
      kids = [...n.getChildren()];
    } catch {}
    for (const c of kids) destroySubtree(c, keep);
  }
  try {
    n.destroy?.();
  } catch {}
};

// one node (already detached, or self-detaching) plus everything under it —
// the row-reap path in ui-grid needs a single-node walk, not a host sweep.
export const destroyNode = (node: unknown): void => {
  destroySubtree(node, undefined);
};

export const destroyChildren = (node: unknown, keep?: unknown): void => {
  if (!isChildHost(node)) return;
  let kids: unknown[] = [];
  try {
    kids = [...node.getChildren()];
  } catch {
    return;
  }
  for (const c of kids) {
    try {
      node.remove(c);
    } catch {}
    destroySubtree(c, keep);
  }
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

// promise timeout with timer cleanup on BOTH paths: the timer that fires the
// rejection must be cleared when the inner promise settles first, or every
// call leaks a live handle that holds the event loop (the plugin
// runDeactivate/activate races leaked one 5s timer per unload). Scheduler is
// injectable like debounced so tests run on the virtual clock.
export const withTimeout = <T>(promise: Promise<T>, ms: number, sched: Scheduler = globalThis): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    let settled = false;
    const t = sched.setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error("timeout"));
    }, ms);
    promise.then(
      (v) => {
        if (settled) return;
        settled = true;
        sched.clearTimeout(t);
        resolve(v);
      },
      (e) => {
        if (settled) return;
        settled = true;
        sched.clearTimeout(t);
        reject(e);
      },
    );
  });

// plugin-run guard: plugin run() closures are typed sync but may be async —
// a sync try/catch misses rejections (unhandled rejection, no report). This
// reports sync throws AND async rejections through `report`, never throws
// itself (a throwing reporter is swallowed too).
export const invokeIsolated = (thunk: () => unknown, report: (err: unknown) => void): void => {
  const safeReport = (err: unknown): void => {
    try {
      report(err);
    } catch {}
  };
  let r: unknown;
  try {
    r = thunk();
  } catch (err) {
    safeReport(err);
    return;
  }
  if (r instanceof Promise) {
    r.catch(safeReport);
  }
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
