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

  test("the gio run's outcome comes from the shared leaf, not a local boolean pair", async () => {
    const src = (await Bun.file(`${import.meta.dir}/chrome.ts`).text())
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "");
    // the run carries ONE interruption value and the outcome is derived
    // ONCE — the old shape kept two booleans and mapped them at the end,
    // where the CANCEL branch won and hid the deadline
    expect(src.includes('from "../fs/gio-outcome"')).toBe(true);
    expect(/let timedOut = false/.test(src)).toBe(false);
    expect(/let cancelled = false/.test(src)).toBe(false);
    // and the result's outcome is decided by the leaf's pure function
    expect(src.includes("gioOutcomeFor(")).toBe(true);
    // both interruptions are recorded through the leaf's ONE marker — a
    // local flag here would reintroduce the pair the leaf replaced
    expect(/markGioInterrupted\(run, "timed-out"\)/.test(src)).toBe(true);
    expect(/markGioInterrupted\(run, "cancelled"\)/.test(src)).toBe(true);
    // and the result CARRIES the outcome (the consumer reads it)
    expect(/outcome, code: gioExitCode\(/.test(src)).toBe(true);
  });

  test("the late-bound impls are SLOTS, not no-op stubs", async () => {
    const src = (await Bun.file(`${import.meta.dir}/chrome.ts`).text())
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "");
    // the three impls that are assigned AFTER the consumer that captures
    // them (connect / disconnect server, the sidebar hover) live in slots
    expect(src.match(/makeLateSlot</g)?.length ?? 0).toBe(3);
    // a slot is never INITIALIZED with a no-op function: "not yet assigned"
    // must be an explicit state, or a pre-assignment call silently does
    // nothing (no toast, no log)
    expect(/=\s*(async\s*)?\(\)\s*=>\s*\{\}/.test(src)).toBe(false);
  });
});
