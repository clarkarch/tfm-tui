// --- Renderer-agnostic UI utilities shared by index.ts and the extracted
// widgets. No OpenTUI/renderer imports — nodes arrive as parameters. ---

// clear-and-rebuild idiom used by every dynamic host (crumbs, sidebar, tab
// strip, menus, grid): drop all children of a renderable
export const clearChildren = (node: any): void => {
  if (!node) return;
  try { [...node.getChildren()].forEach((c: any) => { node.remove(c); }); } catch {}
};

// trailing debounce: every call pushes the run `ms` back; the body sees the
// latest closure state when it finally fires
export const debounced = (ms: number, fn: () => void): (() => void) => {
  let t: any = null;
  return () => {
    if (t) clearTimeout(t);
    t = setTimeout(() => { t = null; fn(); }, ms);
  };
};

// render-path guard: a throw inside one repaint step must not blank the pane
// or kill the rest — log it (injected) and keep the other steps running
export const safeRenderStep = (name: string, fn: () => void | Promise<void>, log: (msg: string) => void = () => {}): void => {
  try {
    const r = fn();
    if (r instanceof Promise) r.catch((err) => log(`render ${name} (async): ${err?.stack ?? err}`));
  } catch (err: any) {
    log(`render ${name}: ${err?.stack ?? err}`);
  }
};
