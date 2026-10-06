import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Box } from "@opentui/core";
import { createTestRenderer, type TestRendererSetup } from "@opentui/core/testing";
import { defaultConfig } from "../config/config-schema";
import type { Theme } from "../config/config";
import { HELP_W, QUICK_TIPS, helpBodyHeight, renderHelpPanel } from "./ui-help";

const colors = defaultConfig.theme as Theme;

// shell padding (2 + 2) leaves HELP_W - 4 cells for a full-width row
const INNER_W = HELP_W - 4;

describe("quick tips", () => {
  test("pool is non-empty problem/fix pairs with no emdash", () => {
    expect(QUICK_TIPS.length).toBeGreaterThan(0);
    for (const tip of QUICK_TIPS) {
      expect(tip.problem.length).toBeGreaterThan(0);
      expect(tip.fix.length).toBeGreaterThan(0);
      expect(`${tip.problem} ${tip.fix}`).not.toContain("—");
      expect(`${tip.problem} ${tip.fix}`).not.toContain("–");
    }
  });

  test("every padded tip row fits the panel inner width (height:1 rows clip)", () => {
    const w = Math.max(...QUICK_TIPS.map((tip) => tip.problem.length));
    for (const tip of QUICK_TIPS) {
      expect(`? ${tip.problem.padEnd(w)}  ${tip.fix}`.length).toBeLessThanOrEqual(INNER_W);
    }
  });

  test("first tip names the artifacting symptom with a bullet", () => {
    expect(QUICK_TIPS[0]?.problem).toBe("icons artifacting/buggy?");
  });

  test("tip pool carries the approved copy, minus the cut tips", () => {
    const problems = QUICK_TIPS.map((tip) => tip.problem);
    expect(QUICK_TIPS.length).toBe(10);
    expect(problems).toContain("shift+clicks highlights tui not files?");
    expect(problems).toContain("ctrl+tab dead in kitty?");
    expect(problems).toContain("icons are boxes?");
    expect(problems).toContain("mouse doesnt work on tty?");
    expect(problems).not.toContain("Nautilus paste empty?");
    expect(problems).not.toContain("panels pop open too fast?");
    expect(problems).not.toContain("video has no thumbnail?");
  });

  test("viewport height stays usable on short terminals", () => {
    expect(helpBodyHeight(24)).toBe(16);
    expect(helpBodyHeight(10)).toBe(8);
  });
});

describe("help panel tips section", () => {
  let t: TestRendererSetup;
  beforeAll(async () => {
    // short terminal: the full tip list must overflow into a scrollable body
    t = await createTestRenderer({ width: 100, height: 24 });
  });
  afterAll(() => {
    t.renderer.destroy();
  });

  const openHelp = async () => {
    const panel: any = Box({ id: "help-test-panel", width: "100%" });
    t.renderer.root.add(panel);
    await t.renderOnce();
    // resolve post-mount: the pre-mount proxy no-ops child adds
    const mounted = t.renderer.root.findDescendantById("help-test-panel") as any;
    renderHelpPanel(colors, mounted, {
      keybinds: () => [],
      renderer: () => t.renderer as any,
      termH: () => 24,
    });
    await t.renderOnce();
    return panel;
  };

  test("rendered panel highlights every problem and scrolls to the footer", async () => {
    const panel = await openHelp();
    // top of the body: hero visible, pinned F1 line below the viewport,
    // the long tail below the fold
    let frame = t.captureCharFrame();
    expect(frame).toContain("Lost? Start here.");
    expect(frame).toContain("F1 opens or closes this");
    expect(frame).not.toContain(QUICK_TIPS[QUICK_TIPS.length - 1]?.problem as string);
    // walk the whole body in steps: every section must surface in some
    // viewport (no hardcoded offsets — the walk follows the clamped top)
    const probes = [
      "MOUSE",
      "TIPS",
      `? ${QUICK_TIPS[0]?.problem}` as string,
      QUICK_TIPS[QUICK_TIPS.length - 1]?.problem as string,
    ];
    const seen = new Set<string>();
    const scroller: any = t.renderer.root.findDescendantById("tfm-help-scroll");
    expect(scroller).toBeDefined();
    let top = 0;
    for (let i = 0; i < 20; i++) {
      scroller.scrollTop = top;
      await t.renderOnce();
      frame = t.captureCharFrame();
      for (const probe of probes) if (frame.includes(probe)) seen.add(probe);
      // the setter clamps: a readback below the request means bottom
      if (scroller.scrollTop < top) break;
      top += 4;
    }
    for (const probe of probes) expect(seen).toContain(probe);
    panel.parent?.remove(panel);
    await t.renderOnce();
  });
});
