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
