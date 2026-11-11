import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createTestRenderer, type TestRendererSetup } from "@opentui/core/testing";
import { destroyChildren } from "../lib/uiutil";
import {
  buildCrumbs,
  crumbItemIds,
  isNavigableTarget,
  makeToolbar,
  type PathEditPeer,
  toolbarItemIds,
} from "./ui-toolbar";
import { RECENT_URI } from "../fs/uri";
import { archiveUri } from "../fs/archive-scheme";
import type { MaybeNode } from "../lib/node-like";
import { type IconSpec, NavIdx, PlainIdx } from "../lib/icon-state";

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

describe("buildCrumbs", () => {
  test("real paths in home: Home + segments, each clickable", () => {
    expect(buildCrumbs("/home/u/Docs/x", "/home/u", "box")).toEqual([
      { label: "Home", icon: "home", target: "/home/u" },
      { label: "Docs", target: "/home/u/Docs" },
      { label: "x", target: "/home/u/Docs/x" },
    ]);
  });

  test("outside home: host base + absolute segments", () => {
    expect(buildCrumbs("/mnt/data", "/home/u", "box")).toEqual([
      { label: "box", icon: "desktop-tower", target: "/" },
      { label: "mnt", target: "/mnt" },
      { label: "data", target: "/mnt/data" },
    ]);
  });

  test("virtual places are a single named crumb", () => {
    expect(buildCrumbs(RECENT_URI, "/home/u", "box")).toEqual([{ label: "Recent", icon: "clock", target: RECENT_URI }]);
  });

  test("an archive cwd shows its real location, the file, then inner dirs", () => {
    // the bug this guards: path.resolve(archive://…) glued the URI onto the
    // process cwd and rendered the launch dir in the path bar
    const uri = archiveUri("/home/u/x.tar.gz", "a/b");
    const crumbs = buildCrumbs(uri, "/home/u", "box");
    expect(crumbs.map((c) => c.label)).toEqual(["Home", "x.tar.gz", "a", "b"]);
    expect(crumbs[1]).toEqual({ label: "x.tar.gz", icon: "zip-box", target: archiveUri("/home/u/x.tar.gz") });
    expect(crumbs[2]!.target).toBe(archiveUri("/home/u/x.tar.gz", "a"));
    expect(crumbs[3]!.target).toBe(archiveUri("/home/u/x.tar.gz", "a/b"));
    // the mangled fallback rendered the percent-encoded URI as a crumb label
    expect(crumbs.every((c) => !c.label.includes("%2F"))).toBe(true);
  });

  test("an archive at the root still gets a host-based chain", () => {
    expect(buildCrumbs(archiveUri("/x.rar"), "/home/u", "box").map((c) => c.label)).toEqual(["box", "x.rar"]);
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
  hooks: {
    onAnimate?: (ids: string[]) => void;
    cwdOf?: () => string;
    toggleSearch?: () => void;
    // the nav buttons' enabled source (the wiring's canBack/canFwd)
    canBack?: () => boolean;
    canFwd?: () => boolean;
    // the icon-slot state sink: the raster index painted for a slot
    onIconState?: (spec: IconSpec<any> | undefined, index: number) => void;
    // the icon-slot factory sink: every slot this toolbar builds
    onSlot?: (name: string, spec: IconSpec<any>) => void;
    // the app-wide path-editor registry (both panes join the same one)
    pathEditPeers?: PathEditPeer[];
    // virtual clock for the double-click window
    now?: () => number;
    // debug trace sink (the wiring passes the debug log)
    log?: (msg: string) => void;
    navigate?: (dir: string) => void;
  } = {},
) =>
  makeToolbar({
    prefix,
    renderer: () => t.renderer,
    byId: (id) => t.renderer.root.findDescendantById(id),
    destroyChildren,
    stripSelectable: () => {},
    uiStyle: () => "solid",
    colors: () => COLORS,
    makeIconSlot: (name, states) => {
      // the fake serves EVERY family, so its spec is family-erased
      const spec: IconSpec<any> = {
        slotId: `s-${name}`,
        name,
        heightCells: 1,
        states,
        initialState: PlainIdx.Rest,
        phase: "pending",
      };
      hooks.onSlot?.(name, spec);
      return { el: null, slotId: spec.slotId, spec };
    },
    setIconState: (spec, index) => {
      hooks.onIconState?.(spec, index);
      return true;
    },
    closeFileMenu: () => {},
    blurTerminal: () => {},
    navigate: hooks.navigate ?? (() => {}),
    notify: () => {},
    canBack: hooks.canBack ?? (() => false),
    canFwd: hooks.canFwd ?? (() => false),
    goBack: () => {},
    goFwd: () => {},
    openContextMenu: () => {},
    sortEntries: () => [],
    cwd: () => hooks.cwdOf?.() ?? cwd,
    animateCrumbs: hooks.onAnimate,
    toggleSearch: hooks.toggleSearch ?? (() => {}),
    pathEditPeers: hooks.pathEditPeers,
    now: hooks.now,
    log: hooks.log,
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
    await t.dispose(); // 0.6.0: destroy + await closed
  });
});

describe("the search button", () => {
  // The button used to flip the input node's `visible` flag ITSELF — a
  // second writer of "the search is open" (the router reads the module, and
  // the module owns the query). The button goes through the module now, so
  // the node's flag can never disagree with the router's view.
  test("it opens the search through the module (one owner of the open state)", async () => {
    const t = await createTestRenderer({ width: 200, height: 6 });
    try {
      let toggles = 0;
      const tb = mkToolbar(t, "tfm-p0-", "/x/alpha", {
        toggleSearch: () => {
          toggles++;
        },
      });
      t.renderer.root.add(tb.makeToolbarShell());
      await t.renderOnce();
      const btn = t.renderer.root.findDescendantById("tfm-p0-search-btn") as unknown as {
        screenX: number;
        screenY: number;
      };
      expect(btn).toBeTruthy();
      await t.mockMouse.pressDown(btn.screenX + 1, btn.screenY);
      expect(toggles).toBe(1);
      // the button must NOT write the node's flag itself
      const input = t.renderer.root.findDescendantById("tfm-p0-search") as unknown as { visible: boolean };
      expect(input.visible).toBe(false);
    } finally {
      await t.dispose(); // 0.6.0: destroy + await closed
    }
  });
});

describe("the nav buttons", () => {
  // The hover flag used to live in a TOOLBAR-level map that OUTLIVED the
  // button it belonged to: a rebuilt button inherited the old button's hover
  // (a stale hover raster AND a stale hover bg — the theme flip re-read the
  // stale flag). The state is ONE record owned by the button now, so a
  // rebuild REPLACES it.
  const bgOf = (node: any): string => {
    const c = node?.backgroundColor;
    if (!c) return "none";
    const ints = c.toInts?.();
    return ints ? ints.join(",") : String(c);
  };
  const hexInts = (hex: string): string => {
    const h = hex.replace("#", "");
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16), 255].join(",");
  };

  test("a rebuilt nav button has no stale hover", async () => {
    const t = await createTestRenderer({ width: 200, height: 6 });
    try {
      // the painted raster index per slot
      const painted = new Map<string, number>();
      const tb = mkToolbar(t, "tfm-p0-", "/x/alpha", {
        canBack: () => true,
        onIconState: (spec, index) => {
          if (!spec) return;
          painted.set(spec.slotId, index);
        },
      });
      const shell = tb.makeToolbarShell();
      t.renderer.root.add(shell);
      await t.renderOnce();

      // the rest state (the wiring paints it on every render)
      tb.refreshNav();
      const rest = painted.get("s-chevron-left");
      expect(rest).toBeDefined();

      // hover the back button → its own raster index
      const back = t.renderer.root.findDescendantById("tfm-p0-nav-back") as unknown as {
        screenX: number;
        screenY: number;
      };
      expect(back).toBeTruthy();
      await t.mockMouse.moveTo(back.screenX + 1, back.screenY);
      const hovered = painted.get("s-chevron-left");
      expect(hovered).not.toBe(rest);
      // the paint covers BOTH halves: the wrapper box surface too (the
      // raster bakes its bg into the png — a wrapper that misses the swap
      // leaves a stale square around it)
      const lit = t.renderer.root.findDescendantById("tfm-p0-nav-back") as any;
      expect(bgOf(lit)).toBe(hexInts(COLORS.hoverBg));

      // the toolbar shell is rebuilt: the hovered button dies (a destroyed
      // node never gets its mouse-out) and a fresh one takes its id
      const shellNode = t.renderer.root.findDescendantById("tfm-p0-toolbar") as any;
      expect(shellNode).toBeTruthy();
      destroyChildren(shellNode);
      t.renderer.root.remove(shellNode);
      t.renderer.root.add(tb.makeToolbarShell());
      await t.renderOnce();
      tb.refreshNav();

      // the fresh button must NOT inherit the dead button's hover
      expect(painted.get("s-chevron-left")).toBe(rest);
      // the theme flip repaints the button surfaces (rethemeChrome →
      // repaintButtons) — it must not resurrect the dead hover either
      tb.repaintButtons();
      const fresh = t.renderer.root.findDescendantById("tfm-p0-nav-back") as any;
      expect(bgOf(fresh)).toBe(hexInts(COLORS.bg));
    } finally {
      await t.dispose(); // 0.6.0: destroy + await closed
    }
  });

  test("the enabled flag is re-read from its source on every refresh", async () => {
    // the record CACHES the enabled flag, but the cache is fed by the
    // wiring's source (canBack/canFwd) — a frozen value would keep the
    // button disabled forever
    const t = await createTestRenderer({ width: 200, height: 6 });
    try {
      const painted = new Map<string, number>();
      let canBack = false;
      const tb = mkToolbar(t, "tfm-p0-", "/x/alpha", {
        canBack: () => canBack,
        onIconState: (spec, index) => {
          if (!spec) return;
          painted.set(spec.slotId, index);
        },
      });
      t.renderer.root.add(tb.makeToolbarShell());
      await t.renderOnce();

      tb.refreshNav();
      const disabled = painted.get("s-chevron-left");
      expect(disabled).toBeDefined();
      // the source flips (the user navigated back) → the next refresh follows
      canBack = true;
      tb.refreshNav();
      expect(painted.get("s-chevron-left")).not.toBe(disabled);
    } finally {
      await t.dispose(); // 0.6.0: destroy + await closed
    }
  });

  test("the nav family's index is INVERTED (enabled is the resting state)", async () => {
    // The nav family (back/fwd) is the INVERSE sense of a toggle: an
    // ENABLED button is the resting palette (index 0) and a DISABLED one is
    // the muted palette (index 1). The old shared numeric space carried
    // this as a separate helper with an inverted arithmetic, and nothing
    // pinned WHICH index each sense meant — a flipped mapping painted the
    // disabled button in the enabled palette (or the reverse) and the test
    // suite stayed green because it only compared "changed" vs "unchanged".
    const t = await createTestRenderer({ width: 200, height: 6 });
    try {
      const painted = new Map<string, number>();
      let canBack = false;
      const tb = mkToolbar(t, "tfm-p0-", "/x/alpha", {
        canBack: () => canBack,
        onIconState: (spec, index) => {
          if (!spec) return;
          painted.set(spec.slotId, index);
        },
      });
      t.renderer.root.add(tb.makeToolbarShell());
      await t.renderOnce();

      // DISABLED is the muted palette — index 1, NOT the resting one
      tb.refreshNav();
      expect(painted.get("s-chevron-left")).toBe(Number(NavIdx.Disabled));
      // ENABLED is the RESTING palette — index 0 (the inverse of a toggle,
      // whose "on" is index 1)
      canBack = true;
      tb.refreshNav();
      expect(painted.get("s-chevron-left")).toBe(Number(NavIdx.Enabled));
    } finally {
      await t.dispose(); // 0.6.0: destroy + await closed
    }
  });

  test("a dead button's late mouse-out paints nothing", async () => {
    // the old button's record is STALE after a rebuild: a late mouse-out
    // (the pointer leaves the dead node) must not paint the fresh button
    // with the dead record's raster spec
    const t = await createTestRenderer({ width: 200, height: 6 });
    try {
      const calls: { spec: IconSpec<any>; index: number }[] = [];
      const specs: IconSpec<any>[] = [];
      const tb = mkToolbar(t, "tfm-p0-", "/x/alpha", {
        canBack: () => true,
        onIconState: (spec, index) => {
          if (!spec) return;
          calls.push({ spec, index });
        },
        onSlot: (name, spec) => {
          if (name === "chevron-left") specs.push(spec);
        },
      });
      const shell = tb.makeToolbarShell();
      t.renderer.root.add(shell);
      await t.renderOnce();

      // hover the back button → the old record paints
      const back = t.renderer.root.findDescendantById("tfm-p0-nav-back") as unknown as {
        screenX: number;
        screenY: number;
      };
      expect(back).toBeTruthy();
      await t.mockMouse.moveTo(back.screenX + 1, back.screenY);
      expect(calls.length).toBeGreaterThan(0);
      expect(calls.at(-1)?.spec).toBe(specs[0]);

      // the shell is rebuilt: the old button is DETACHED (it stays alive, so
      // the renderer still fires its mouse-out), the fresh one takes its id
      const shellNode = t.renderer.root.findDescendantById("tfm-p0-toolbar") as any;
      expect(shellNode).toBeTruthy();
      t.renderer.root.remove(shellNode);
      t.renderer.root.add(tb.makeToolbarShell());
      await t.renderOnce();

      // the dead record painted NOTHING
      expect(calls.length).toBe(1);
      expect(specs).toHaveLength(2);
    } finally {
      await t.dispose(); // 0.6.0: destroy + await closed
    }
  });
});

describe("toolbar item ids (animation targets)", () => {
  // the probes only ask whether an id resolves; the stand-in carries just the id
  const mapById = (ids: string[]) => {
    const set = new Set(ids);
    return (id: string): MaybeNode => (set.has(id) ? ({ id } as unknown as MaybeNode) : null);
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
    expect(crumbItemIds(() => ({}) as unknown as MaybeNode, "tfm-p0-", 5)).toHaveLength(5);
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
      await t.dispose(); // 0.6.0: destroy + await closed
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
      await t.dispose(); // 0.6.0: destroy + await closed
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
      await t.dispose(); // 0.6.0: destroy + await closed
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
      await t.dispose(); // 0.6.0: destroy + await closed
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
      await t.dispose(); // 0.6.0: destroy + await closed
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
      await t.dispose(); // 0.6.0: destroy + await closed
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
      await t.dispose(); // 0.6.0: destroy + await closed
    }
  });

  test("path-edit re-seed strips control chars (0.6.0 Input rejects C0)", async () => {
    // the `existing` branch re-seeds a LIVE input instead of constructing:
    // driven here with a destroyChildren that spares the input (the real one
    // drops it first, taking the ctor path — both must strip). A raw write
    // throws NativeError inside try/catch and leaves the stale path in the box
    const t = await createTestRenderer({ width: 200, height: 6 });
    try {
      let cwd = "/x/alpha";
      const tb = makeToolbar({
        prefix: "tfm-p0-",
        renderer: () => t.renderer,
        byId: (id) => t.renderer.root.findDescendantById(id),
        destroyChildren: () => {}, // spare the live input → existing branch
        stripSelectable: () => {},
        uiStyle: () => "solid",
        colors: () => COLORS,
        makeIconSlot: (name, states) => ({
          el: null,
          slotId: `s-${name}`,
          // the fake serves EVERY family, so its spec is family-erased
          spec: {
            slotId: `s-${name}`,
            name,
            heightCells: 1,
            states,
            initialState: PlainIdx.Rest,
            phase: "pending",
          } as IconSpec<any>,
        }),
        setIconState: () => true,
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
        toggleSearch: () => {},
        home: "/home/u",
      });
      t.renderer.root.add(tb.makeToolbarShell());
      await t.renderOnce();
      tb.renderCrumbs();
      tb.enterPathEdit();
      await t.renderOnce();
      cwd = "/x/beta\x01gamma";
      tb.renderCrumbs(); // mid-edit rebuild → existing-branch re-seed
      await t.renderOnce();
      const input = t.renderer.root.findDescendantById("tfm-p0-path-input") as any;
      expect(input).toBeTruthy();
      // stripped re-seed, not the stale pre-tick path
      expect(input.value).toBe("/x/betagamma");
    } finally {
      await t.dispose(); // 0.6.0: destroy + await closed
    }
  });
});

// --- The inline path editor: ONE machine (closed → armed → editing) with ONE
// closer. The old shape was a boolean plus a timestamp sentinel, and every
// external exit was routed to the ACTIVE pane only: pane 1's editor kept the
// keyboard focus and swallowed typing after a navigation in pane 0.

describe("the inline path editor", () => {
  // press the crumbs box (the empty area right of the crumbs — a crumb child
  // would navigate, the box itself arms the double-click)
  const pressCrumbs = async (t: TestRendererSetup, prefix: string): Promise<void> => {
    const box = t.renderer.root.findDescendantById(`${prefix}crumbs`) as unknown as {
      screenX: number;
      screenY: number;
    };
    expect(box).toBeTruthy();
    await t.mockMouse.pressDown(box.screenX + 60, box.screenY);
  };

  test("closing the path editor cancels it in EVERY pane", async () => {
    const t = await createTestRenderer({ width: 200, height: 6 });
    try {
      // both panes join the SAME registry — the editor holds the keyboard
      // focus, so cancelling it in one pane must cancel it in the other
      const peers: PathEditPeer[] = [];
      const tb0 = mkToolbar(t, "tfm-p0-", "/x/alpha", { pathEditPeers: peers });
      const tb1 = mkToolbar(t, "tfm-p1-", "/x/beta", { pathEditPeers: peers });
      t.renderer.root.add(tb0.makeToolbarShell());
      t.renderer.root.add(tb1.makeToolbarShell());
      await t.renderOnce();
      tb1.enterPathEdit();
      expect(tb1.pathEditMode()).toBe(true);
      // what a navigation does: the ACTIVE pane's closer fires
      tb0.exitPathEdit("navigate");
      expect(tb1.pathEditMode()).toBe(false);
      expect(tb0.pathEditMode()).toBe(false);
    } finally {
      await t.dispose(); // 0.6.0: destroy + await closed
    }
  });

  test("a committed path closes the editor through the SAME closer", async () => {
    const t = await createTestRenderer({ width: 200, height: 6 });
    const dir = mkdtempSync(path.join(os.tmpdir(), "tfm-toolbar-"));
    try {
      const logs: string[] = [];
      const navs: string[] = [];
      const tb = mkToolbar(t, "tfm-p0-", "/x/alpha", {
        log: (m) => logs.push(m),
        navigate: (d) => navs.push(d),
      });
      t.renderer.root.add(tb.makeToolbarShell());
      await t.renderOnce();
      tb.renderCrumbs();
      tb.enterPathEdit();
      await t.renderOnce();
      const input = t.renderer.root.findDescendantById("tfm-p0-path-input") as any;
      expect(input).toBeTruthy();
      input.value = dir;
      input.submit();
      expect(tb.pathEditMode()).toBe(false);
      expect(navs).toEqual([dir]);
      // the commit went through the ONE closer — a direct state write in the
      // enter handler skipped it (and everything the closer does)
      expect(logs).toContain("pathedit: closed (commit)");
    } finally {
      rmSync(dir, { recursive: true, force: true });
      await t.dispose(); // 0.6.0: destroy + await closed
    }
  });

  test("a committed path leaves no double-click arm behind", async () => {
    const t = await createTestRenderer({ width: 200, height: 6 });
    const dir = mkdtempSync(path.join(os.tmpdir(), "tfm-toolbar-"));
    try {
      let clock = 1_000;
      const tb = mkToolbar(t, "tfm-p0-", "/x/alpha", { now: () => clock, navigate: () => {} });
      t.renderer.root.add(tb.makeToolbarShell());
      await t.renderOnce();
      // a double-click on the crumbs opens the editor
      await pressCrumbs(t, "tfm-p0-");
      clock += 10;
      await pressCrumbs(t, "tfm-p0-");
      expect(tb.pathEditMode()).toBe(true);
      // commit → the editor closes
      const input = t.renderer.root.findDescendantById("tfm-p0-path-input") as any;
      expect(input).toBeTruthy();
      input.value = dir;
      input.submit();
      expect(tb.pathEditMode()).toBe(false);
      // the arm died with the edit: the next click must NOT re-open the
      // editor (the old timestamp sentinel survived the commit)
      await pressCrumbs(t, "tfm-p0-");
      expect(tb.pathEditMode()).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      await t.dispose(); // 0.6.0: destroy + await closed
    }
  });

  test("a second click outside the double-click window does not open the editor", async () => {
    const t = await createTestRenderer({ width: 200, height: 6 });
    try {
      let clock = 1_000;
      const tb = mkToolbar(t, "tfm-p0-", "/x/alpha", { now: () => clock });
      t.renderer.root.add(tb.makeToolbarShell());
      await t.renderOnce();
      await pressCrumbs(t, "tfm-p0-");
      clock += 1_000; // the window (350ms) has passed
      await pressCrumbs(t, "tfm-p0-");
      expect(tb.pathEditMode()).toBe(false);
    } finally {
      await t.dispose(); // 0.6.0: destroy + await closed
    }
  });
});
