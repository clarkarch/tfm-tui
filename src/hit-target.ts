// --- OSC 72 drop-target resolution: walk the renderable chain from a
// terminal-cell hit test up to the root, matching the tfm-place-* /
// tfm-tile-* id conventions. Renderer-free — the hit test, the renderable
// registry and the sidebar place list arrive via ctx, so the walk is
// testable with fake node chains. ---

import type { DropTarget } from "./dnd72";
import type { SelTileRef } from "./selection";

export type HitTargetCtx = {
  // terminal cell -> renderable number (renderer.hitTest in the app)
  hitTest: (x: number, y: number) => number | null | undefined;
  // renderable number -> node (Renderable.renderablesByNumber in the app)
  byNumber: (num: number) => { id?: unknown; parent?: any } | null | undefined;
  // sidebar place records, index-aligned with the tfm-place-N ids
  placesHost: () => Array<{ place?: { path?: string | null } }>;
  tileRefs: Map<string, SelTileRef>;
};

export const makeHitTargetAt =
  (ctx: HitTargetCtx) =>
  (x: number, y: number, dragPaths: string[] | null): DropTarget | null => {
    try {
      const num = ctx.hitTest(x, y);
      if (!num) return null;
      let cur: any = ctx.byNumber(num);
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
        }
        cur = cur.parent;
      }
    } catch {}
    return null;
  };
