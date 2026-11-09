// --- Wiring-level pin for chrome.ts's path-edit REGISTRY.
//
// The inline path editor is app-wide: its Input holds the keyboard focus, so
// cancelling it in one pane must cancel it in the OTHER pane too (the old
// route reached the ACTIVE pane only — pane 1's editor survived a
// navigation in pane 0 and kept swallowing every keystroke).
//
// The fan-out lives in the toolbar module (its ONE closer walks the
// registry), so the wiring's half is: BOTH toolbars must join the SAME
// registry. A per-pane registry would silently turn the every-pane close
// back into an active-pane close — and the toolbar's unit test could not
// see it (it hands both toolbars one array itself). The invariant is
// invisible in the types (an array literal), so it is pinned structurally.
import { describe, expect, test } from "bun:test";

describe("the chrome wiring's path-edit registry", () => {
  test("both toolbars join ONE shared registry", async () => {
    const src = (await Bun.file(`${import.meta.dir}/chrome.ts`).text())
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "");
    // ONE registry, declared once (not per pane)
    expect(src.match(/const pathEditPeers: PathEditPeer\[\] = \[\]/g)?.length ?? 0).toBe(1);
    // the toolbar ctx receives THAT registry — the shorthand identifier, never
    // a fresh per-pane array (which would turn the every-pane close back into
    // an active-pane close)
    expect(/^\s*pathEditPeers,$/m.test(src)).toBe(true);
    expect(/pathEditPeers:\s*\[\]/.test(src)).toBe(false);
    // and the app-wide predicate reads the same registry
    expect(src.includes("pathEditPeers.some((peer) => peer.isOpen())")).toBe(true);
  });
});
