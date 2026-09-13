import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createTestRenderer, type TestRendererSetup } from "@opentui/core/testing";
import { clearChildren } from "../lib/uiutil";
import { isNavigableTarget, makeToolbar } from "./ui-toolbar";
import { RECENT_URI } from "../fs/uri";

describe("isNavigableTarget", () => {
  test("real dirs pass, files and missing paths fail", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "tfm-toolbar-"));
    try {
      const file = path.join(dir, "f.txt");
      writeFileSync(file, "x");
      expect(isNavigableTarget(dir)).toBe(true);
      expect(isNavigableTarget(file)).toBe(false);
      expect(isNavigableTarget(path.join(dir, "nope"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("virtual places always navigate", () => {
    expect(isNavigableTarget(RECENT_URI)).toBe(true);
  });
});

// Dual pane builds one toolbar per pane; this pins that each instance paints
// its OWN cwd (the wiring bug was both toolbars reading the active-pane
// facade, so the unfocused pane's top bar showed the focused pane's path).

const COLORS: any = {
  bg: "#111111",
  sidebarBg: "#000000",
  sidebarFg: "#cccccc",
  sidebarFgMuted: "#888888",
  accent: "#7aa2f7",
  accentBg: "#333333",
  hoverBg: "#222222",
  border: "#333333",
  divider: "#333333",
  white: "#ffffff",
};

const mkToolbar = (t: TestRendererSetup, prefix: string, cwd: string) =>
  makeToolbar({
    prefix,
    renderer: () => t.renderer,
    byId: (id) => t.renderer.root.findDescendantById(id),
    clearChildren,
    stripSelectable: () => {},
    uiStyle: () => "solid",
    colors: () => COLORS,
    makeIconSlot: (name, states) => ({
      el: null,
      slotId: `s-${name}`,
      spec: { slotId: `s-${name}`, name, heightCells: 1, states, initialState: 0 },
    }),
    setIconState: () => {},
    closeFileMenu: () => {},
    blurTerminal: () => {},
    navigate: () => {},
    notify: () => {},
    canBack: () => false,
    canFwd: () => false,
    goBack: () => {},
    goFwd: () => {},
    openContextMenu: () => {},
    sortEntries: () => [],
    cwd: () => cwd,
    home: "/home/u",
  });

describe("makeToolbar (per pane)", () => {
  test("two instances paint their OWN crumb cwd, not a shared one", async () => {
    const t = await createTestRenderer({ width: 200, height: 6 });
    const tb0 = mkToolbar(t, "tfm-p0-", "/x/alpha");
    const tb1 = mkToolbar(t, "tfm-p1-", "/y/bravo");
    t.renderer.root.add(tb0.makeToolbarShell());
    t.renderer.root.add(tb1.makeToolbarShell());
    await t.renderOnce();
    tb0.renderCrumbs();
    tb1.renderCrumbs();
    await t.renderOnce();

    const frame = t.captureCharFrame();
    expect(frame).toContain("alpha");
    expect(frame).toContain("bravo");
    // each toolbar owns its prefixed crumb node
    expect(t.renderer.root.findDescendantById("tfm-p0-crumbs")).toBeTruthy();
    expect(t.renderer.root.findDescendantById("tfm-p1-crumbs")).toBeTruthy();
    t.renderer.destroy();
  });
});
