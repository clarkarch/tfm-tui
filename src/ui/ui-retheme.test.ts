import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { makeRetheme } from "./ui-retheme";
import { bumpHex } from "../config/color";
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
    repaintButtons: 0,
    renderCrumbs: 0,
    refreshNav: 0,
    renderMenuContent: 0,
    setStatusMsg: [] as string[],
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
    setStatusMsg: (msg: string) => {
      calls.setStatusMsg.push(msg);
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
