// Pure decision logic for the hover drawer + headless factory tests below
// (timelines driven by mockMouse over a real test renderer, no fixed sleeps
// beyond the poll tick).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Box } from "@opentui/core";
import { createTestRenderer, type TestRendererSetup } from "@opentui/core/testing";
import { collapsedHeight, collapsedSize, drawerWantsOpen, makeHoverDrawer } from "./ui-hover-drawer";
import { defaultConfig } from "../config/config-schema";

describe("drawerWantsOpen", () => {
  test("left edge opens only inside the zone (zone = cells from the edge) while closed", () => {
    const base = { edge: "left" as const, size: 100, expanded: 26, open: false, zone: 2 };
    expect(drawerWantsOpen({ ...base, pos: 0 })).toBe(true); // dist 0
    expect(drawerWantsOpen({ ...base, pos: 1 })).toBe(true); // dist 1
    expect(drawerWantsOpen({ ...base, pos: 2 })).toBe(false); // dist 2
    expect(drawerWantsOpen({ ...base, pos: 3 })).toBe(false);
  });

  test("open left panel stays open one cell past its edge, then clears", () => {
    const base = { edge: "left" as const, size: 100, expanded: 26, open: true, zone: 2 };
    expect(drawerWantsOpen({ ...base, pos: 25 })).toBe(true); // last panel cell
    expect(drawerWantsOpen({ ...base, pos: 26 })).toBe(true); // margin 1
    expect(drawerWantsOpen({ ...base, pos: 27 })).toBe(false);
  });

  test("right edge measures distance from the right cell", () => {
    const base = { edge: "right" as const, size: 100, expanded: 40, open: false, zone: 2 };
    expect(drawerWantsOpen({ ...base, pos: 99 })).toBe(true); // dist 0
    expect(drawerWantsOpen({ ...base, pos: 98 })).toBe(true); // dist 1
    expect(drawerWantsOpen({ ...base, pos: 97 })).toBe(false); // dist 2
  });

  test("open right panel clears once the cursor is past expanded+margin", () => {
    const base = { edge: "right" as const, size: 100, expanded: 40, open: true, zone: 2 };
    expect(drawerWantsOpen({ ...base, pos: 60 })).toBe(true); // dist 39
    expect(drawerWantsOpen({ ...base, pos: 59 })).toBe(true); // dist 40
    expect(drawerWantsOpen({ ...base, pos: 58 })).toBe(false); // dist 41
  });

  test("bottom edge behaves like right on the y axis", () => {
    const base = { edge: "bottom" as const, size: 40, expanded: 13, open: false, zone: 1 };
    expect(drawerWantsOpen({ ...base, pos: 39 })).toBe(true); // dist 0
    expect(drawerWantsOpen({ ...base, pos: 38 })).toBe(false); // dist 1
    expect(drawerWantsOpen({ ...base, open: true, pos: 26 })).toBe(true); // dist 13
    expect(drawerWantsOpen({ ...base, open: true, pos: 25 })).toBe(false); // dist 14
  });
});

describe("collapsed sizes", () => {
  test("rail/hidden/min map to distinct widths", () => {
    expect(collapsedSize("rail")).toBe(4);
    expect(collapsedSize("hidden")).toBe(0);
    expect(collapsedSize("min")).toBe(8);
  });

  test("terminal header keeps a row, hidden is zero", () => {
    expect(collapsedHeight("header")).toBe(1);
    expect(collapsedHeight("hidden")).toBe(0);
  });
});

// Headless integration: the frame-loop timeline is skipped (animMs 0) so the
// assertions test the mouse→decision→timer→width chain deterministically.
describe("makeHoverDrawer (headless)", () => {
  let t: TestRendererSetup;
  let eff: { sidebar: number; preview: number };
  let settles: number;

  const mountLayout = () => {
    t.renderer.root.add(
      Box(
        { width: "100%", height: "100%", flexDirection: "row" },
        Box(
          { id: "tfm-sidebar-root", width: 26, height: "100%", overflow: "hidden" },
          Box({ id: "tfm-title-box", width: 24, height: 5 }),
          Box({ id: "tfm-places", width: 24 }),
        ),
        Box({ id: "tfm-main", flexGrow: 1, height: "100%" }),
        Box(
          { id: "tfm-preview", width: 40, height: "100%", overflow: "hidden", flexDirection: "column" },
          // fixed-width child: the exact shape that leaked through a width-0
          // parent before the hidden style toggled `visible`
          Box({ id: "tfm-preview-body", width: 38, height: 5 }),
        ),
      ),
    );
  };

  const mkDrawer = (ui: typeof defaultConfig.ui) =>
    makeHoverDrawer({
      renderer: t.renderer,
      byId: (id) => t.renderer.root.findDescendantById(id),
      ui: () => ui,
      terminalOpen: () => false,
      terminalFocused: () => false,
      blocked: () => false,
      setEffectiveSidebar: (n) => {
        eff.sidebar = n;
      },
      setEffectivePreview: (n) => {
        eff.preview = n;
      },
      onSettle: () => {
        settles++;
      },
    });

  // the node's getters report laid-out values — a render is needed to observe
  // a write; poll with renders (no fixed sleeps)
  const settleUntil = async (cond: () => boolean): Promise<void> => {
    for (let i = 0; i < 300; i++) {
      await Bun.sleep(3);
      await t.renderOnce();
      if (cond()) return;
    }
    throw new Error("settleUntil timed out");
  };

  beforeAll(async () => {
    t = await createTestRenderer({ width: 80, height: 24 });
    mountLayout();
    await t.renderOnce();
  });
  afterAll(() => t.renderer.destroy());

  test("mouse near the left edge opens the sidebar; leaving collapses it", async () => {
    const ui = {
      ...defaultConfig.ui,
      sidebarAutoHide: true,
      sidebarCollapseStyle: "rail",
      hoverZoneCells: 2,
      hoverOpenDelayMs: 0,
      hoverCloseDelayMs: 0,
      hoverAnimMs: 0,
    };
    eff = { sidebar: -1, preview: -1 };
    settles = 0;
    mkDrawer(ui);
    const node = () => t.renderer.root.findDescendantById("tfm-sidebar-root") as any;
    const title = () => t.renderer.root.findDescendantById("tfm-title-box") as any;

    // initial: collapsed to the rail, title hidden, grid reserved the rail width
    await t.renderOnce();
    expect(node().width).toBe(collapsedSize("rail"));
    expect(title().visible).toBe(false);
    expect(eff.sidebar).toBe(collapsedSize("rail"));

    await t.mockMouse.moveTo(0, 3);
    await settleUntil(() => node().width === ui.sidebarWidth);
    // onSettle is debounced (coalesces a burst into one rebuild) — wait for it
    await settleUntil(() => settles > 0);
    expect(title().visible).toBe(true);
    expect(eff.sidebar).toBe(ui.sidebarWidth);
    const afterOpen = settles;

    await t.mockMouse.moveTo(40, 3);
    await settleUntil(() => node().width === collapsedSize("rail"));
    await settleUntil(() => settles > afterOpen);
    expect(title().visible).toBe(false);
    expect(eff.sidebar).toBe(collapsedSize("rail"));
    // onSettle fired for the open AND the close (grid rebuilds columns)
    expect(afterOpen).toBeGreaterThan(0);
    expect(settles).toBeGreaterThan(afterOpen);
  });

  test("hidden collapse style makes the pane invisible instead of a width-0 leak", async () => {
    const ui = {
      ...defaultConfig.ui,
      previewEnabled: true,
      previewAutoHide: true,
      previewCollapseStyle: "hidden",
      hoverZoneCells: 2,
      hoverOpenDelayMs: 0,
      hoverCloseDelayMs: 0,
      hoverAnimMs: 0,
    };
    eff = { sidebar: -1, preview: -1 };
    settles = 0;
    mkDrawer(ui);
    const pane = () => t.renderer.root.findDescendantById("tfm-preview") as any;

    await t.renderOnce();
    expect(pane().visible).toBe(false); // collapsed hidden → not rendered
    expect(eff.preview).toBe(0);

    await t.mockMouse.moveTo(79, 3);
    await settleUntil(() => pane().visible === true);
    expect(pane().width).toBe(ui.previewWidth);
    expect(eff.preview).toBe(ui.previewWidth);

    await t.mockMouse.moveTo(30, 3);
    await settleUntil(() => pane().visible === false);
    expect(eff.preview).toBe(0);
  });

  test("hidden style animates open instead of snapping off a stale width getter", async () => {
    // regression: a display:none node keeps its last laid-out width, so reading
    // it back made `cur === target` and the slide was skipped (a hidden pane
    // jumped straight to full width with no animation). Live loop, because
    // renderOnce's frame delta can complete the whole slide in one frame.
    const ui = {
      ...defaultConfig.ui,
      previewEnabled: true,
      previewAutoHide: true,
      previewCollapseStyle: "hidden",
      hoverZoneCells: 3,
      hoverOpenDelayMs: 0,
      hoverCloseDelayMs: 0,
      hoverAnimMs: 400,
    };
    eff = { sidebar: -1, preview: -1 };
    settles = 0;
    mkDrawer(ui);
    const pane = () => t.renderer.root.findDescendantById("tfm-preview") as any;
    await t.renderOnce();
    expect(pane().visible).toBe(false);

    t.renderer.start();
    try {
      await t.mockMouse.moveTo(79, 3);
      const seen: number[] = [];
      for (let i = 0; i < 60; i++) {
        await Bun.sleep(8);
        seen.push(pane().width);
      }
      expect(pane().width).toBe(ui.previewWidth);
      // an intermediate frame proves it slid, not snapped
      expect(seen.some((w) => w > 0 && w < ui.previewWidth)).toBe(true);
    } finally {
      t.renderer.pause();
    }
  });

  test("refresh applies collapse-style and auto-hide changes live", async () => {
    // the settings GUI / live config reload path: mutate ui() then refresh()
    const ui = {
      ...defaultConfig.ui,
      sidebarAutoHide: true,
      sidebarCollapseStyle: "rail",
      previewEnabled: true,
      previewAutoHide: true,
      previewCollapseStyle: "hidden",
      hoverAnimMs: 0,
    };
    const drawer = mkDrawer(ui);
    const root = () => t.renderer.root.findDescendantById("tfm-sidebar-root") as any;
    const pane = () => t.renderer.root.findDescendantById("tfm-preview") as any;
    await t.renderOnce();
    await t.renderOnce();
    expect(root().width).toBe(collapsedSize("rail"));
    expect(root().visible).toBe(true);
    expect(pane().visible).toBe(false);

    ui.sidebarCollapseStyle = "hidden";
    drawer.refresh();
    await t.renderOnce();
    // hidden = display:none, so the laid-out width getter stays stale — the
    // observable contract is that the pane is not rendered at all
    expect(root().visible).toBe(false);

    ui.sidebarCollapseStyle = "rail";
    drawer.refresh();
    await t.renderOnce();
    expect(root().width).toBe(collapsedSize("rail"));
    expect(root().visible).toBe(true);

    ui.sidebarAutoHide = false;
    drawer.refresh();
    await t.renderOnce();
    expect(root().width).toBe(ui.sidebarWidth);
    expect(root().visible).toBe(true);

    ui.previewCollapseStyle = "rail";
    drawer.refresh();
    await t.renderOnce();
    expect(pane().visible).toBe(true);
    expect(pane().width).toBe(collapsedSize("rail"));
  });
});

describe("terminal auto-hide follows ui().terminalHeight (headless)", () => {
  let t2: TestRendererSetup;

  const settleUntil = async (cond: () => boolean): Promise<void> => {
    for (let i = 0; i < 300; i++) {
      await Bun.sleep(3);
      await t2.renderOnce();
      if (cond()) return;
    }
    throw new Error("settleUntil timed out");
  };

  beforeAll(async () => {
    t2 = await createTestRenderer({ width: 80, height: 24 });
    t2.renderer.root.add(
      Box(
        { width: "100%", height: "100%", flexDirection: "column" },
        Box({ id: "tfm-main", flexGrow: 1 }),
        Box({ id: "tfm-term-host", width: "100%", height: 13 }),
      ),
    );
    await t2.renderOnce();
  });
  afterAll(() => t2.renderer.destroy());

  test("expand/collapse/restore size the host from live config, not the old const", async () => {
    // 9 ≠ the old TERM_H 12: every size below proves the config value is read
    const ui = {
      ...defaultConfig.ui,
      terminalHeight: 9,
      terminalAutoHide: true,
      terminalCollapseStyle: "hidden",
      hoverZoneCells: 2,
      hoverOpenDelayMs: 0,
      hoverCloseDelayMs: 0,
      hoverAnimMs: 0,
    };
    const drawer = makeHoverDrawer({
      renderer: t2.renderer,
      byId: (id) => t2.renderer.root.findDescendantById(id),
      ui: () => ui,
      terminalOpen: () => true,
      terminalFocused: () => false,
      blocked: () => false,
      setEffectiveSidebar: () => {},
      setEffectivePreview: () => {},
    });
    const host = () => t2.renderer.root.findDescendantById("tfm-term-host") as any;

    await t2.renderOnce();
    // the drawer only clips height — visibility belongs to the pane lifecycle
    // (terminal applyVisible is deliberately a noop). Yoga clamps a 0-height
    // box to 1 row, so collapse reads back ≤ 1, not exactly 0.
    expect(host().height).toBeLessThanOrEqual(1);

    await t2.mockMouse.moveTo(40, 23); // bottom edge, inside the zone
    await settleUntil(() => host().height === 10);
    expect(host().height).toBe(ui.terminalHeight + 1);
    // (no onSettle assert: the terminal panel sets rebuildsGrid false — a
    // height slide never rebuilds grid columns)

    await t2.mockMouse.moveTo(40, 3); // far from the edge
    await settleUntil(() => host().height <= 1);

    // disabling auto-hide restores the full configured height (not the const)
    ui.terminalAutoHide = false;
    drawer.refresh();
    await t2.renderOnce();
    expect(host().height).toBe(10);
  });

  test("a keyboard-focused terminal never collapses under auto-hide", async () => {
    // typing into a 1-row pane is the bug: focusing the shell must pin the
    // pane open until blur, even with the mouse far from the edge
    const ui = {
      ...defaultConfig.ui,
      terminalHeight: 9,
      terminalAutoHide: true,
      terminalCollapseStyle: "hidden",
      hoverZoneCells: 2,
      hoverOpenDelayMs: 0,
      hoverCloseDelayMs: 0,
      hoverAnimMs: 0,
    };
    let focused = false;
    makeHoverDrawer({
      renderer: t2.renderer,
      byId: (id) => t2.renderer.root.findDescendantById(id),
      ui: () => ui,
      terminalOpen: () => true,
      terminalFocused: () => focused,
      blocked: () => false,
      setEffectiveSidebar: () => {},
      setEffectivePreview: () => {},
    });
    const host = () => t2.renderer.root.findDescendantById("tfm-term-host") as any;

    await t2.mockMouse.moveTo(40, 23);
    await settleUntil(() => host().height === 10);

    focused = true; // user tabs into the shell, mouse drifts away
    await t2.mockMouse.moveTo(40, 3);
    await Bun.sleep(30); // close delay is 0: any scheduled close has fired by now
    await t2.renderOnce();
    expect(host().height).toBe(10);

    focused = false; // blur: the next move away may collapse again
    await t2.mockMouse.moveTo(41, 4);
    await settleUntil(() => host().height <= 1);
  });
});
