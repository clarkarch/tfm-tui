// --- Post-mount node lookup helpers: OpenTUI nodes are findable by id only
// after mount and die on every rebuild, so every lookup must tolerate a miss
// and never run before the renderer boots. The renderer root arrives via a
// getter — this module never imports the renderer. ---

export type LookupCtx = { root: () => any };

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export const makeLookup = (ctx: LookupCtx) => {
  const byId = (id: string): any => {
    try {
      return ctx.root().findDescendantById(id);
    } catch {
      return null;
    }
  };

  // set a TEXT node's content by id — ids must live on the Text, not its
  // wrapper Box (boxes have no .content, mutating them no-ops)
  const setTextOnId = (nodeId: string, s: string): void => {
    const n: any = byId(nodeId);
    if (n) {
      try {
        n.content = s;
      } catch {}
    }
  };

  const setOnId = (id: string, fn: (n: any) => void): void => {
    const n: any = byId(id);
    if (!n) return;
    try {
      fn(n);
    } catch {}
  };

  // text renderables default selectable = true — the renderer's text-selection
  // drag hijacks custom drag flows, so strip it recursively after every rebuild
  const stripSelectable = (node: any = ctx.root()): void => {
    if (!node || node.isDestroyed) return;
    try {
      if (node.selectable) node.selectable = false;
    } catch {}
    node.getChildren?.().forEach((c: any) => {
      stripSelectable(c);
    });
  };

  return { byId, setTextOnId, setOnId, stripSelectable };
};

// renderer.resolution is null at boot — anything needing real cell pixels
// must wait for the terminal size to land
export const waitForResolution = async (renderer: any): Promise<void> => {
  for (let i = 0; i < 40 && !renderer.resolution; i++) await sleep(50);
};
