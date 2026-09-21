import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Box } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import { makeRetheme } from "./ui-retheme";
import { makePick } from "./ui-pick";
import { makeFloats } from "./floats";
import { bumpHex } from "../config/color";
import { ANSI16, COMPAT_DARK_THEME, COMPAT_LIGHT_THEME } from "./compat";
import { defaultConfig, type Config } from "../config/config-schema";
import { loadConfig } from "../config/config";

// applyConfig is THE single config-change path (mutate -> applyConfig ->
// scheduleSaveConfig). Pins the contract: geometry setter rewrites, in-place
// config/colors merge (+transparent-bg nudge), theme-sig invalidation diffed
// against the LAST APPLIED state (not the caller's pre-call config — the old
// self-compare skipped raster invalidation silently), rethemeChrome's by-id
// repaint set, and the debounced TOML save (TFM_CONFIG sandbox).

const clone = (c: Config): Config => JSON.parse(JSON.stringify(c));

let cfgSandbox: string;
let cfgPath: string;
let savedTfmConfig: string | undefined;

const mkCtx = () => {
  const config = clone(defaultConfig);
  const colors: Record<string, string> = { ...defaultConfig.theme };
  const calls = {
    setOnId: [] as Array<[string, (n: any) => void]>,
    bg: [] as string[],
    geom: { sw: 0, tileW: 0, tileH: 0, iconCells: 0 },
    renderAll: 0,
    clearIconCaches: 0,
    resetIconQueue: 0,
    syncTerminalTheme: 0,
    syncTerminalHeight: 0,
    repaintButtons: 0,
    renderCrumbs: 0,
    refreshNav: 0,
    renderMenuContent: 0,
    notify: [] as Array<[string, string?, string?]>,
  };
  const ctx = {
    config,
    colors,
    setOnId: (id: string, fn: (n: any) => void) => {
      calls.setOnId.push([id, fn]);
    },
    byId: () => null,
    renderer: () => ({
      setBackgroundColor: (c: string) => {
        calls.bg.push(c);
      },
    }),
    getSw: () => calls.geom.sw,
    setSw: (v: number) => {
      calls.geom.sw = v;
    },
    setTileW: (v: number) => {
      calls.geom.tileW = v;
    },
    setTileH: (v: number) => {
      calls.geom.tileH = v;
    },
    setIconCells: (v: number) => {
      calls.geom.iconCells = v;
    },
    sideInnerW: () => calls.geom.sw,
    renderAll: () => {
      calls.renderAll++;
    },
    clearIconCaches: () => {
      calls.clearIconCaches++;
    },
    resetIconQueue: () => {
      calls.resetIconQueue++;
    },
    syncTerminalTheme: () => {
      calls.syncTerminalTheme++;
    },
    syncTerminalHeight: () => {
      calls.syncTerminalHeight++;
    },
    repaintButtons: () => {
      calls.repaintButtons++;
    },
    renderCrumbs: () => {
      calls.renderCrumbs++;
    },
    refreshNav: () => {
      calls.refreshNav++;
    },
    escMenu: {
      isOpen: () => false,
      renderMenuContent: () => {
        calls.renderMenuContent++;
      },
    },
    fileMenuIsOpen: () => false,
    renderFileMenu: () => {},
    notify: (msg: string, title?: string, level?: string) => {
      calls.notify.push([msg, title, level]);
    },
    calls,
  };
  return ctx;
};

beforeAll(() => {
  savedTfmConfig = process.env.TFM_CONFIG;
  cfgSandbox = mkdtempSync(path.join(os.tmpdir(), "tfm-retheme-test-"));
  cfgPath = path.join(cfgSandbox, "config.toml");
  process.env.TFM_CONFIG = cfgPath;
});

afterAll(() => {
  if (savedTfmConfig === undefined) delete process.env.TFM_CONFIG;
  else process.env.TFM_CONFIG = savedTfmConfig;
  rmSync(cfgSandbox, { recursive: true, force: true });
});

describe("applyConfig", () => {
  test("merges the fresh config into the live one and rewrites geometry through the setters", () => {
    const ctx = mkCtx();
    const retheme = makeRetheme(ctx as any);
    const fresh = clone(defaultConfig);
    fresh.ui.sidebarWidth = 30;
    fresh.ui.tileWidth = 14;
    fresh.ui.tileHeight = 8;
    fresh.ui.iconCells = 3;
    retheme.applyConfig(fresh);
    expect(ctx.calls.geom).toEqual({ sw: 30, tileW: 14, tileH: 8, iconCells: 3 });
    expect(ctx.config.ui.sidebarWidth).toBe(30); // live config mutated in place
    expect(ctx.calls.renderAll).toBe(1);
  });

  test("colors merge in place; transparent-bg off nudges bg opaque, on keeps the raw hex", () => {
    const ctx = mkCtx();
    const retheme = makeRetheme(ctx as any);
    const fresh = clone(defaultConfig);
    const rawBg = fresh.theme.bg;
    retheme.applyConfig(fresh);
    expect(ctx.colors.bg).toBe(bumpHex(rawBg)); // off (default) -> nudged
    expect(ctx.colors.accent).toBe(defaultConfig.theme.accent);

    const on = clone(defaultConfig);
    on.ui.transparentBg = true;
    on.theme.bg = "#010203";
    retheme.applyConfig(on);
    expect(ctx.colors.bg).toBe("#010203"); // on -> faithful
    expect(ctx.config.ui.transparentBg).toBe(true);
  });

  test("theme change invalidates rasters + repaints chrome + syncs the terminal", () => {
    const ctx = mkCtx();
    const retheme = makeRetheme(ctx as any);
    const fresh = clone(defaultConfig);
    fresh.theme.accent = "#ff0000";
    retheme.applyConfig(fresh);
    expect(ctx.calls.clearIconCaches).toBe(1);
    expect(ctx.calls.resetIconQueue).toBe(1);
    expect(ctx.calls.syncTerminalTheme).toBe(1);
    expect(ctx.calls.repaintButtons).toBe(1); // rethemeChrome ran
    expect(ctx.calls.bg).toEqual([bumpHex(defaultConfig.theme.bg)]); // renderer bg reset
  });

  test("compat-active applyConfig paints the static console palette, ignoring user hues", () => {
    // the Linux VT ignores 48;2 truecolor, so compat paints one hand-tuned
    // static palette (dark/light by configured-bg brightness) instead of the
    // user's theme — two wildly different user themes land byte-identical
    const ctx = mkCtx();
    (ctx as Record<string, unknown>).compatActive = () => true;
    const retheme = makeRetheme(ctx as any);
    const dark = clone(defaultConfig);
    dark.ui.compatMode = "on";
    dark.theme.accent = "#ff0000";
    dark.theme.bg = "#1a1b26";
    retheme.applyConfig(dark);
    expect(ctx.colors).toEqual(COMPAT_DARK_THEME);
    for (const v of Object.values(ctx.colors)) expect(ANSI16).toContain(v);

    const other = clone(defaultConfig);
    other.ui.compatMode = "on";
    other.theme.accent = "#00ff00";
    other.theme.bg = "#101014";
    retheme.applyConfig(other);
    expect(ctx.colors).toEqual(COMPAT_DARK_THEME); // hues discarded, same static

    const light = clone(defaultConfig);
    light.ui.compatMode = "on";
    light.theme.bg = "#e1e2e7";
    retheme.applyConfig(light);
    expect(ctx.colors).toEqual(COMPAT_LIGHT_THEME);
  });

  test("compat-active user-theme edits invalidate nothing (theme is not painted)", () => {
    const ctx = mkCtx();
    (ctx as Record<string, unknown>).compatActive = () => true;
    const retheme = makeRetheme(ctx as any);
    const booted = clone(defaultConfig);
    booted.ui.compatMode = "on";
    retheme.applyConfig(booted);
    const baseline = { ...ctx.calls };
    const fresh = clone(defaultConfig);
    fresh.ui.compatMode = "on";
    fresh.theme.accent = "#123456";
    retheme.applyConfig(fresh);
    expect(ctx.calls.clearIconCaches).toBe(baseline.clearIconCaches);
    expect(ctx.calls.resetIconQueue).toBe(baseline.resetIconQueue);
    expect(ctx.calls.renderAll).toBe(baseline.renderAll);
    expect(ctx.config.theme.accent).toBe("#123456"); // still STORED for life off-console
  });

  test("a ui-only knob flip re-renders but never invalidates the raster caches", () => {
    const ctx = mkCtx();
    const retheme = makeRetheme(ctx as any);
    const fresh = clone(defaultConfig);
    fresh.ui.showHidden = true;
    retheme.applyConfig(fresh);
    expect(ctx.calls.clearIconCaches).toBe(0);
    expect(ctx.calls.resetIconQueue).toBe(0);
    expect(ctx.calls.renderAll).toBe(1);
  });

  test("icons mode flip invalidates the raster caches (icons re-raster)", () => {
    const ctx = mkCtx();
    const retheme = makeRetheme(ctx as any);
    const fresh = clone(defaultConfig);
    fresh.ui.icons = "transparent";
    retheme.applyConfig(fresh);
    expect(ctx.calls.clearIconCaches).toBe(1);
    expect(ctx.calls.resetIconQueue).toBe(1);
    expect(ctx.calls.renderAll).toBe(1);
  });

  test("force-glyph flip invalidates the raster caches (drains resume on the way back)", () => {
    // off->on stops the drains; on->off must re-raster, or tiles keep glyphs
    // forever, same invalidation contract as the icons-mode flip
    const ctx = mkCtx();
    const retheme = makeRetheme(ctx as any);
    const on = clone(defaultConfig);
    (on.ui as Record<string, unknown>).forceGlyph = true;
    retheme.applyConfig(on);
    expect(ctx.calls.clearIconCaches).toBe(1);
    expect(ctx.calls.resetIconQueue).toBe(1);
  });

  test("force-glyph rising edge nudges toward list view once (no repeat spam)", () => {
    const ctx = mkCtx();
    const retheme = makeRetheme(ctx as any);
    const on = clone(defaultConfig);
    (on.ui as Record<string, unknown>).forceGlyph = true;
    retheme.applyConfig(on);
    expect(ctx.calls.notify.length).toBe(1);
    expect(String(ctx.calls.notify[0]![0])).toMatch(/list/i);

    retheme.applyConfig(clone(ctx.config));
    expect(ctx.calls.notify.length).toBe(1); // held on: silent

    const off = clone(ctx.config);
    (off.ui as Record<string, unknown>).forceGlyph = false;
    retheme.applyConfig(off);
    retheme.applyConfig(on);
    expect(ctx.calls.notify.length).toBe(2); // off->on again: remind again
  });

  test("a hover-geometry toggle re-renders so tiles gain or lose lift room", () => {
    const ctx = mkCtx();
    const retheme = makeRetheme(ctx as any);
    const fresh = clone(defaultConfig);
    fresh.ui.fileHoverAnimation = true;
    retheme.applyConfig(fresh);
    expect(ctx.calls.renderAll).toBe(1);
  });

  test("a value-only knob skips the heavy renderAll (no grid rebuild churn)", () => {
    const ctx = mkCtx();
    const retheme = makeRetheme(ctx as any);
    const fresh = clone(defaultConfig);
    fresh.ui.toastDurationMs = 5000;
    fresh.ui.hoverAnimMs = 200;
    retheme.applyConfig(fresh);
    // consumers read these live; a full clear-and-rebuild was pure native churn
    expect(ctx.calls.renderAll).toBe(0);
    expect(ctx.config.ui.toastDurationMs).toBe(5000);
    expect(ctx.config.ui.hoverAnimMs).toBe(200);
  });

  test("a terminal-height change syncs the open pane without a full renderAll", () => {
    const ctx = mkCtx();
    const retheme = makeRetheme(ctx as any);
    const fresh = clone(defaultConfig);
    fresh.ui.terminalHeight = 16;
    retheme.applyConfig(fresh);
    expect(ctx.config.ui.terminalHeight).toBe(16);
    expect(ctx.calls.syncTerminalHeight).toBe(1);
    // value-only knob: the settings row repainted itself, no grid rebuild churn
    expect(ctx.calls.renderAll).toBe(0);
  });

  test("a layout knob still re-renders", () => {
    const ctx = mkCtx();
    const retheme = makeRetheme(ctx as any);
    const fresh = clone(defaultConfig);
    fresh.ui.sidebarWidth = 31;
    retheme.applyConfig(fresh);
    expect(ctx.calls.renderAll).toBe(1);
  });

  test("theme flip is diffed against the LAST APPLIED state, not the caller's config (pinned regression)", () => {
    const ctx = mkCtx();
    const retheme = makeRetheme(ctx as any);
    // first flip primes the last-applied signature
    const first = clone(defaultConfig);
    first.theme.accent = "#111111";
    retheme.applyConfig(first);
    expect(ctx.calls.clearIconCaches).toBe(1);

    // settings-row pattern: mutate the LIVE config, then applyConfig(config)
    ctx.config.theme.accent = "#222222";
    retheme.applyConfig(ctx.config);
    expect(ctx.calls.clearIconCaches).toBe(2); // still detected!
    expect(ctx.colors.accent).toBe("#222222");
  });
});

describe("rethemeChrome", () => {
  test("paints the boot-baked widgets by id (widths, surfaces, fg colors)", () => {
    const ctx = mkCtx();
    const retheme = makeRetheme(ctx as any);
    ctx.calls.setOnId.length = 0;
    retheme.rethemeChrome();

    const painted = new Map(ctx.calls.setOnId);
    for (const id of [
      "tfm-sidebar-root",
      "tfm-main",
      "tfm-title-box",
      "tfm-places",
      "tfm-preview",
      "tfm-status-label",
      "tfm-term-header",
    ]) {
      expect(painted.has(id), `rethemeChrome must repaint ${id}`).toBe(true);
    }
    // the sidebar root fn applies width + a chrome surface
    const node: any = {};
    painted.get("tfm-sidebar-root")!(node);
    expect(node.width).toBe(ctx.calls.geom.sw);
    expect(node.backgroundColor).toBeTruthy();
  });

  test("outline-partial repaints floats solid (fill, no border ring)", () => {
    // outline-partial = outline chrome + SOLID floats; pure outline keeps its
    // border-only floats. The repaint path must match the build path or a
    // runtime style flip leaves the live panel mismatched.
    for (const [style, filled] of [
      ["outline", false],
      ["outline-partial", true],
    ] as const) {
      const ctx = mkCtx();
      (ctx.config.ui as any).uiStyle = style;
      // float repaints only run while their layer is open
      ctx.escMenu.isOpen = () => true;
      (ctx as any).fileMenuIsOpen = () => true;
      const retheme = makeRetheme(ctx as any);
      ctx.calls.setOnId.length = 0;
      retheme.rethemeChrome();
      const painted = new Map(ctx.calls.setOnId);
      for (const id of ["tfm-menu-panel", "tfm-filemenu"]) {
        const node: any = {};
        painted.get(id)!(node);
        if (filled) {
          expect(node.backgroundColor, `${id} @ ${style}`).toBeTruthy();
          expect(node.border, `${id} @ ${style}`).toBe(false);
        } else {
          expect(node.border, `${id} @ ${style}`).toBe(true);
        }
      }
    }
  });
});

describe("open-float repaints", () => {
  test("open floats repaint on theme switch; closed ones are skipped", () => {
    const ctx = mkCtx();
    const painted: string[] = [];
    (ctx as any).floatRepaints = [
      { isOpen: () => true, repaint: () => painted.push("open-float") },
      { isOpen: () => false, repaint: () => painted.push("closed-float") },
    ];
    const retheme = makeRetheme(ctx as any);
    const fresh = clone(defaultConfig);
    fresh.theme.accent = "#ff0000";
    retheme.applyConfig(fresh);
    expect(painted).toEqual(["open-float"]);
  });

  test("a throwing float repaint is isolated — the rest still repaint", () => {
    const ctx = mkCtx();
    const painted: string[] = [];
    (ctx as any).floatRepaints = [
      {
        isOpen: () => true,
        repaint: () => {
          throw new Error("float-boom");
        },
      },
      { isOpen: () => true, repaint: () => painted.push("second") },
    ];
    const retheme = makeRetheme(ctx as any);
    const fresh = clone(defaultConfig);
    fresh.theme.accent = "#ff0000";
    expect(() => retheme.applyConfig(fresh)).not.toThrow();
    expect(painted).toEqual(["second"]);
  });

  test("no float list, no fan-out (optional dep)", () => {
    const ctx = mkCtx();
    const retheme = makeRetheme(ctx as any);
    const fresh = clone(defaultConfig);
    fresh.theme.accent = "#ff0000";
    expect(() => retheme.applyConfig(fresh)).not.toThrow();
    expect(ctx.calls.renderAll).toBe(1);
  });

  test("end-to-end: an open pick repaints through a real applyConfig theme switch", async () => {
    // the reported issue, no fakes: pick open in a real renderer, theme flip
    // through the real retheme path, painted panel carries the new palette
    const t = await createTestRenderer({ width: 90, height: 24 });
    try {
      const floats = makeFloats();
      const live: Record<string, string> = { ...defaultConfig.theme };
      const pick = makePick({
        renderer: () => t.renderer,
        byId: (id) => t.renderer.root.findDescendantById(id),
        rootAdd: (n) => t.renderer.root.add(n),
        clearChildren: (node: any) => {
          for (const c of [...node.getChildren()]) node.remove(c);
        },
        stripSelectable: () => {},
        colors: () => live as any,
        uiStyle: () => "solid",
        floats,
        escHintBtn: (id) => Box({ id, width: 3, height: 1 }),
        drainIconQueue: () => {},
        commands: () => [{ label: "quit tfm", run: () => {} }],
      });
      pick.open({ title: "Palette" });
      await t.renderOnce();
      expect(floats.isOpen("pick")).toBe(true);

      const ctx = mkCtx();
      // retheme merges into ITS colors ref — point it at the live palette so
      // the switch actually changes what the pick reads
      (ctx as any).colors = live;
      (ctx as any).floatRepaints = [{ isOpen: () => pick.isOpen(), repaint: () => pick.repaint() }];
      // byId that resolves against the real renderer for the chrome repaints
      const retheme = makeRetheme(ctx as any);
      const fresh = clone(defaultConfig);
      fresh.theme.sidebarBg = "#101020";
      fresh.theme.accentBg = "#303040";
      // live palette flips with the commit (what applyConfig's merge does)
      Object.assign(live, fresh.theme);
      retheme.applyConfig(fresh);
      await t.renderOnce();
      const panel = t.renderer.root.findDescendantById("tfm-pick-panel") as any;
      const ints = [...panel.backgroundColor.toInts()];
      expect(ints).toEqual([0x10, 0x10, 0x20, 255]);
      expect(floats.isOpen("pick")).toBe(true);
    } finally {
      t.renderer.destroy();
    }
  });
});

describe("scheduleSaveConfig", () => {
  test("debounced save writes the live config to the TOML path (TFM_CONFIG sandbox)", async () => {
    const ctx = mkCtx();
    const retheme = makeRetheme(ctx as any);
    ctx.config.ui.sidebarWidth = 33;
    retheme.scheduleSaveConfig();
    // poll on observable fs state — never a fixed sleep
    const deadline = Date.now() + 4000;
    while (!existsSync(cfgPath) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
    }
    const reloaded = loadConfig();
    expect(reloaded.ui.sidebarWidth).toBe(33);
    // serializer aligns values into columns — match the padded form
    expect(readFileSync(cfgPath, "utf8")).toMatch(/sidebar-width\s+= 33/);
  });
});
