import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createTestRenderer, type TestRendererSetup } from "@opentui/core/testing";
import { clearChildren } from "../lib/uiutil";
import { crumbItemIds, isNavigableTarget, makeToolbar, toolbarItemIds } from "./ui-toolbar";
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

const mkToolbar = (
  t: TestRendererSetup,
  prefix: string,
  cwd: string,
  hooks: { onAnimate?: (ids: string[]) => void; cwdOf?: () => string } = {},
) =>
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
    cwd: () => hooks.cwdOf?.() ?? cwd,
    animateCrumbs: hooks.onAnimate,
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

describe("toolbar item ids (animation targets)", () => {
  const mapById = (ids: string[]) => {
    const set = new Set(ids);
    return (id: string) => (set.has(id) ? { id } : null);
  };

  test("toolbarItemIds runs nav, crumbs, sort, search left-to-right", () => {
    const ids = [
      "tfm-p0-nav-back",
      "tfm-p0-nav-fwd",
      "tfm-p0-crumb-0",
      "tfm-p0-crumb-1",
      "tfm-p0-sort-btn",
      "tfm-p0-search-btn",
    ];
    expect(toolbarItemIds(mapById(ids), "tfm-p0-")).toEqual(ids);
  });

  test("absent fixed buttons are skipped, crumb probe stops at the first miss", () => {
    const byId = mapById(["tfm-p0-nav-back", "tfm-p0-crumb-0", "tfm-p0-crumb-2", "tfm-p0-sort-btn"]);
    // crumb-1 missing: the probe never reaches crumb-2 (crumb ids are dense)
    expect(crumbItemIds(byId, "tfm-p0-")).toEqual(["tfm-p0-crumb-0"]);
    expect(toolbarItemIds(byId, "tfm-p0-")).toEqual(["tfm-p0-nav-back", "tfm-p0-crumb-0", "tfm-p0-sort-btn"]);
  });

  test("the crumb probe is capped (a registry that never misses can't loop forever)", () => {
    expect(crumbItemIds(() => ({}), "tfm-p0-", 5)).toHaveLength(5);
  });
});

describe("renderCrumbs directory-change animation", () => {
  test("first build records the crumbs without animating (boot is the intro's job)", async () => {
    const t = await createTestRenderer({ width: 200, height: 6 });
    try {
      const seen: string[][] = [];
      const tb = mkToolbar(t, "tfm-p0-", "/x/alpha", { onAnimate: (ids) => seen.push(ids) });
      t.renderer.root.add(tb.makeToolbarShell());
      await t.renderOnce();
      tb.renderCrumbs();
      await t.renderOnce();
      expect(seen).toEqual([]);
    } finally {
      t.renderer.destroy();
    }
  });

  test("drilling down animates ONLY the new crumbs (shared prefix stays put)", async () => {
    const t = await createTestRenderer({ width: 200, height: 6 });
    try {
      let cwd = "/x/alpha";
      const seen: string[][] = [];
      const tb = mkToolbar(t, "tfm-p0-", cwd, { onAnimate: (ids) => seen.push(ids), cwdOf: () => cwd });
      t.renderer.root.add(tb.makeToolbarShell());
      await t.renderOnce();
      tb.renderCrumbs();
      cwd = "/x/alpha/beta";
      tb.renderCrumbs();
      // crumbs are [/, /x, /x/alpha] then [/, /x, /x/alpha, /x/alpha/beta]
      expect(seen).toEqual([["tfm-p0-crumb-3"]]);
      tb.renderCrumbs();
      expect(seen).toHaveLength(1);
    } finally {
      t.renderer.destroy();
    }
  });

  test("going up animates nothing (nothing new appeared)", async () => {
    const t = await createTestRenderer({ width: 200, height: 6 });
    try {
      let cwd = "/x/alpha/beta";
      const seen: string[][] = [];
      const tb = mkToolbar(t, "tfm-p0-", cwd, { onAnimate: (ids) => seen.push(ids), cwdOf: () => cwd });
      t.renderer.root.add(tb.makeToolbarShell());
      await t.renderOnce();
      tb.renderCrumbs();
      cwd = "/x/alpha";
      tb.renderCrumbs();
      expect(seen).toEqual([]);
    } finally {
      t.renderer.destroy();
    }
  });

  test("lateral move animates from the first divergent crumb", async () => {
    const t = await createTestRenderer({ width: 200, height: 6 });
    try {
      let cwd = "/x/alpha";
      const seen: string[][] = [];
      const tb = mkToolbar(t, "tfm-p0-", cwd, { onAnimate: (ids) => seen.push(ids), cwdOf: () => cwd });
      t.renderer.root.add(tb.makeToolbarShell());
      await t.renderOnce();
      tb.renderCrumbs();
      cwd = "/x/gamma";
      tb.renderCrumbs();
      // [/, /x] shared, /x/gamma is new at index 2
      expect(seen).toEqual([["tfm-p0-crumb-2"]]);
    } finally {
      t.renderer.destroy();
    }
  });

  test("unrelated base animates the whole row (no shared prefix)", async () => {
    const t = await createTestRenderer({ width: 200, height: 6 });
    try {
      let cwd = "/x/alpha";
      const seen: string[][] = [];
      const tb = mkToolbar(t, "tfm-p0-", cwd, { onAnimate: (ids) => seen.push(ids), cwdOf: () => cwd });
      t.renderer.root.add(tb.makeToolbarShell());
      await t.renderOnce();
      tb.renderCrumbs();
      cwd = RECENT_URI;
      tb.renderCrumbs();
      expect(seen).toEqual([["tfm-p0-crumb-0"]]);
    } finally {
      t.renderer.destroy();
    }
  });

  test("same-cwd rebuilds stay silent (retheme, watcher, search)", async () => {
    const t = await createTestRenderer({ width: 200, height: 6 });
    try {
      const seen: string[][] = [];
      const tb = mkToolbar(t, "tfm-p0-", "/x/alpha", { onAnimate: (ids) => seen.push(ids) });
      t.renderer.root.add(tb.makeToolbarShell());
      await t.renderOnce();
      tb.renderCrumbs();
      tb.renderCrumbs();
      tb.renderCrumbs();
      expect(seen).toEqual([]);
    } finally {
      t.renderer.destroy();
    }
  });

  test("path-edit rebuilds never animate", async () => {
    const t = await createTestRenderer({ width: 200, height: 6 });
    try {
      const cwd = "/x/alpha";
      const seen: string[][] = [];
      const tb = mkToolbar(t, "tfm-p0-", cwd, { onAnimate: (ids) => seen.push(ids), cwdOf: () => cwd });
      t.renderer.root.add(tb.makeToolbarShell());
      await t.renderOnce();
      tb.renderCrumbs();
      tb.enterPathEdit();
      tb.renderCrumbs();
      expect(seen).toEqual([]);
      tb.exitPathEdit();
      expect(seen).toEqual([]);
    } finally {
      t.renderer.destroy();
    }
  });
});
