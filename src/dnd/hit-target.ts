// --- OSC 72 drop-target resolution: walk the renderable chain from a
// terminal-cell hit test up to the root, matching the tfm-place-* /
// tfm-tile-* id conventions. Renderer-free — the hit test, the renderable
// registry and the sidebar place list arrive via ctx, so the walk is
// testable with fake node chains. ---

import type { DropTarget } from "./dnd72";
import type { SelTileRef } from "../input/selection";

// The walk only reads an id and climbs `parent`, so a two-field view is enough
// for a real renderable chain and a fake chain alike.
type ChainNode = { id?: unknown; parent?: ChainNode | null };

type HitTargetCtx = {
  // terminal cell -> renderable number (renderer.hitTest in the app)
  hitTest: (x: number, y: number) => number | null | undefined;
  // renderable number -> node (Renderable.renderablesByNumber in the app)
  byNumber: (num: number) => ChainNode | null | undefined;
  // sidebar place records, index-aligned with the tfm-place-N ids
  placesHost: () => Array<{ place?: { path?: string | null } }>;
  tileRefs: Map<string, SelTileRef>;
  // per-pane cwds, index-aligned with tfm-pane-N — a drop on a pane's EMPTY
  // background (no tile under the cursor) targets that pane's directory
  panesCwd?: () => string[];
};

export const makeHitTargetAt =
  (ctx: HitTargetCtx) =>
  (x: number, y: number, dragPaths: string[] | null): DropTarget | null => {
    try {
      const num = ctx.hitTest(x, y);
      if (!num) return null;
      let cur: ChainNode | null | undefined = ctx.byNumber(num);
      while (cur) {
        const id: unknown = cur.id;
        if (typeof id === "string") {
          if (id.startsWith("tfm-place-")) {
            const rec = ctx.placesHost()[parseInt(id.slice(10), 10)];
            return rec?.place?.path ? { kind: "place", path: rec.place.path } : null;
          }
          if (id.startsWith("tfm-tile-")) {
            for (const [k, r] of ctx.tileRefs) {
              if (r.tileId === id) {
                if (!r.isDir) return null;
                if (dragPaths?.includes(k)) return null; // dropping onto itself
                return { kind: "folder", path: k };
              }
            }
          }
          // pane column/background (tfm-pane-0 / tfm-pane-col-1) → its cwd
          const pane = /^tfm-pane-(?:col-)?(\d+)$/.exec(id);
          if (pane) {
            const cwd = ctx.panesCwd?.()[Number(pane[1])];
            return cwd ? { kind: "folder", path: cwd } : null;
          }
        }
        cur = cur.parent;
      }
    } catch {}
    return null;
  };
