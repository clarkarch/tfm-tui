import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Box } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import { makeRetheme } from "./ui-retheme";
import { makePick } from "./ui-pick";
import { makeFloats } from "./floats";
import { bumpHex } from "../config/color";
import { ANSI16, TTY_DARK_THEME, TTY_LIGHT_THEME } from "./tty";
import { defaultConfig, type Config } from "../config/config-schema";
import { loadConfig } from "../config/config";
import type { Scheduler } from "../lib/uiutil";

// applyConfig is THE single config-change path (mutate -> applyConfig ->
// scheduleSaveConfig). Pins the contract: geometry setter rewrites, in-place
// config/colors merge (+transparent-bg nudge), theme-sig invalidation diffed
// against the LAST APPLIED state (not the caller's pre-call config — the old
// self-compare skipped raster invalidation silently), rethemeChrome's by-id
// repaint set, and the debounced TOML save (TFM_CONFIG sandbox).

const clone = (c: Config): Config => JSON.parse(JSON.stringify(c));

// a virtual clock for the debounced save/reload — Bun has no fake timers.
// The debounce is TRAILING: every call pushes the run `ms` back, so the
// clock advances past the delay to fire it.
const mkClock = () => {
  let now = 0;
  let seq = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const sched: Scheduler = {
    setTimeout: (fn: () => void, ms: number) => {
      const id = ++seq;
      timers.set(id, { at: now + ms, fn });
      return id;
    },
    clearTimeout: (handle: unknown) => {
      timers.delete(handle as number);
    },
  };
  const advance = (ms: number): void => {
    now += ms;
    for (const [id, t] of [...timers.entries()].sort((a, b) => a[1].at - b[1].at)) {
      if (t.at > now) continue;
      timers.delete(id);
      t.fn();
    }
  };
  return { sched, advance };
};

// poll on observable state — never a fixed sleep
const settleUntil = async (cond: () => boolean, label: string): Promise<void> => {
  const deadline = Date.now() + 4000;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timeout waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 5));
  }
};

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
    clearFailedThumbs: 0,
    resetIconQueue: 0,
    syncThumbnailFit: 0,
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
    clearFailedThumbs: () => {
      calls.clearFailedThumbs++;
    },
    resetIconQueue: () => {
      calls.resetIconQueue++;
    },
    syncThumbnailFit: () => {
      calls.syncThumbnailFit++;
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

// a PRIVATE config path per test — the real writer must never touch the
// shared sandbox file (a RED run of an unimplemented seam writes for real),
// and the watcher only reacts to its own file's basename.
const useConfigPath = (name: string): { file: string; restore: () => void } => {
  const file = path.join(cfgSandbox, `${name}.toml`);
  const saved = process.env.TFM_CONFIG;
  process.env.TFM_CONFIG = file;
  return {
    file,
    restore: () => {
      if (saved === undefined) delete process.env.TFM_CONFIG;
      else process.env.TFM_CONFIG = saved;
    },
  };
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
  test("live-reload watcher creates a missing config dir (fresh profile)", () => {
    // fs.watch throws ENOENT synchronously on a missing dir; without the
    // mkdir the watcher never installed and external edits never reloaded
    const missingParent = path.join(cfgSandbox, "fresh-profile");
    const saved = process.env.TFM_CONFIG;
    process.env.TFM_CONFIG = path.join(missingParent, "config.toml");
    try {
      expect(existsSync(missingParent)).toBe(false);
      makeRetheme(mkCtx() as any);
      expect(existsSync(missingParent)).toBe(true);
    } finally {
      if (saved === undefined) delete process.env.TFM_CONFIG;
      else process.env.TFM_CONFIG = saved;
    }
  });

  test("config watcher stop/start are idempotent and re-arm after stop", () => {
    // quit closes the watcher (event-loop pin); a failed restart recover
    // re-arms it — both must be safe to call twice and in any order
    const retheme = makeRetheme(mkCtx() as any);
    expect(() => {
      retheme.stopConfigWatch();
      retheme.stopConfigWatch();
      retheme.startConfigWatch();
      retheme.startConfigWatch();
      retheme.stopConfigWatch();
    }).not.toThrow();
  });

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

  test("colors merge in place; off nudges bg, on/force keep the raw hex", () => {
    const ctx = mkCtx();
    const retheme = makeRetheme(ctx as any);
    const fresh = clone(defaultConfig);
    const rawBg = fresh.theme.bg;
    retheme.applyConfig(fresh);
    expect(ctx.colors.bg).toBe(bumpHex(rawBg)); // off (default) -> nudged
    expect(ctx.colors.accent).toBe(defaultConfig.theme.accent);

    const on = clone(defaultConfig);
    on.ui.transparentBg = "on";
    on.theme.bg = "#010203";
    retheme.applyConfig(on);
    expect(ctx.colors.bg).toBe("#010203"); // on -> faithful
    expect(ctx.config.ui.transparentBg).toBe("on");

    const force = clone(defaultConfig);
    force.ui.transparentBg = "force";
    force.theme.bg = "#010203";
    retheme.applyConfig(force);
    expect(ctx.colors.bg).toBe("#010203"); // force -> faithful (fills clear at the surface seam)
    expect(ctx.calls.bg.at(-1)).toBe("transparent"); // renderer stays transparent
  });

  test("theme change re-rasters via the queue + repaints chrome + syncs the terminal (memory kept)", () => {
    // WHY the wipe is gone: icon/thumb keys already carry fg/bg/mode, so a
    // flip misses naturally while the old theme's rasters stay hot for
    // cycling back — the per-flip wipe made every switch cold (rapid theme
    // cycling lag). resetIconQueue still re-renders (disk serves the misses).
    const ctx = mkCtx();
    const retheme = makeRetheme(ctx as any);
    const fresh = clone(defaultConfig);
    fresh.theme.accent = "#ff0000";
    retheme.applyConfig(fresh);
    expect(ctx.calls.clearIconCaches).toBe(0);
    expect(ctx.calls.clearFailedThumbs).toBe(1);
    expect(ctx.calls.resetIconQueue).toBe(1);
    expect(ctx.calls.syncTerminalTheme).toBe(1);
    expect(ctx.calls.repaintButtons).toBe(1); // rethemeChrome ran
    expect(ctx.calls.bg).toEqual([bumpHex(defaultConfig.theme.bg)]); // renderer bg reset
  });

  test("theme flip restyles the grid scrollbars via the optional hook (absent = no-op)", () => {
    // hook present: a theme flip fans out once (thumb/track follow the palette
    // without rebuilding the scrollers or dropping the scroll pos)
    const ctx = mkCtx();
    let restyled = 0;
    (ctx as any).restyleScrollbars = () => {
      restyled++;
    };
    const retheme = makeRetheme(ctx as any);
    const fresh = clone(defaultConfig);
    fresh.theme.accent = "#00ff00";
    retheme.applyConfig(fresh);
    expect(restyled).toBe(1);
    // hook absent (old fakes): the same flip must not throw
    const bare = makeRetheme(mkCtx() as any);
    const fresh2 = clone(defaultConfig);
    fresh2.theme.accent = "#0000ff";
    expect(() => bare.applyConfig(fresh2)).not.toThrow();
  });

  test("tty-active applyConfig paints the static console palette, ignoring user hues", () => {
    // the Linux VT ignores 48;2 truecolor, so tty mode paints one hand-tuned
    // static palette (dark/light by configured-bg brightness) instead of the
    // user's theme — two wildly different user themes land byte-identical
    const ctx = mkCtx();
    (ctx as Record<string, unknown>).isTtyMode = () => true;
    const retheme = makeRetheme(ctx as any);
    const dark = clone(defaultConfig);
    dark.ui.ttyMode = "on";
    dark.theme.accent = "#ff0000";
    dark.theme.bg = "#1a1b26";
    retheme.applyConfig(dark);
    expect(ctx.colors).toEqual(TTY_DARK_THEME);
    for (const v of Object.values(ctx.colors)) expect(ANSI16).toContain(v);

    const other = clone(defaultConfig);
    other.ui.ttyMode = "on";
    other.theme.accent = "#00ff00";
    other.theme.bg = "#101014";
    retheme.applyConfig(other);
    expect(ctx.colors).toEqual(TTY_DARK_THEME); // hues discarded, same static

    const light = clone(defaultConfig);
    light.ui.ttyMode = "on";
    light.theme.bg = "#e1e2e7";
    retheme.applyConfig(light);
    expect(ctx.colors).toEqual(TTY_LIGHT_THEME);
  });

  test("tty-active user-theme edits invalidate nothing (theme is not painted)", () => {
    const ctx = mkCtx();
    (ctx as Record<string, unknown>).isTtyMode = () => true;
    const retheme = makeRetheme(ctx as any);
    const booted = clone(defaultConfig);
    booted.ui.ttyMode = "on";
    retheme.applyConfig(booted);
    const baseline = { ...ctx.calls };
    const fresh = clone(defaultConfig);
    fresh.ui.ttyMode = "on";
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
    expect(ctx.calls.clearFailedThumbs).toBe(0);
    expect(ctx.calls.resetIconQueue).toBe(0);
    expect(ctx.calls.renderAll).toBe(1);
  });

  test("icons mode flip re-rasters via the queue (transparent flag is in the key, memory kept)", () => {
    // same no-wipe contract as the theme flip: the transparency mode rides
    // the cache key, so old-mode rasters stay valid for flipping back
    const ctx = mkCtx();
    const retheme = makeRetheme(ctx as any);
    const fresh = clone(defaultConfig);
    fresh.ui.icons = "transparent";
    retheme.applyConfig(fresh);
    expect(ctx.calls.clearIconCaches).toBe(0);
    expect(ctx.calls.clearFailedThumbs).toBe(1);
    expect(ctx.calls.resetIconQueue).toBe(1);
    expect(ctx.calls.renderAll).toBe(1);
  });

  test("force-glyph flip re-rasters via the queue (drains resume on the way back, memory kept)", () => {
    // off->on stops the drains; on->off must re-raster, or tiles keep glyphs
    // forever — same no-wipe contract as the theme flip (resetIconQueue
    // re-renders, the kept memory serves a flip back)
    const ctx = mkCtx();
    const retheme = makeRetheme(ctx as any);
    const on = clone(defaultConfig);
    (on.ui as Record<string, unknown>).forceGlyph = true;
    retheme.applyConfig(on);
    expect(ctx.calls.clearIconCaches).toBe(0);
    expect(ctx.calls.clearFailedThumbs).toBe(1);
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

  test("the dual-pane hook gets the applied PAIR — the edge is a fact about the transition", () => {
    // The off→on edge ("dual pane just turned on") used to be inferred in
    // the wiring from a shadow field (`lastDual`) that ONLY the hook itself
    // updated. The hook received no previous value, so it could only
    // re-derive the edge — and a hook that threw (the call site swallows
    // it) left the shadow stale: the edge was then missed, or it fired
    // AGAIN on the next apply, re-pointing pane 1 and wiping the user's
    // navigation there.
    const ctx = mkCtx() as any;
    const pairs: Array<[boolean, boolean]> = [];
    ctx.normalizePanes = (prev: boolean, next: boolean) => {
      pairs.push([prev, next]);
    };
    const retheme = makeRetheme(ctx);
    const on = clone(defaultConfig);
    (on.ui as Record<string, unknown>).dualPane = true;
    retheme.applyConfig(on);
    // the flip: off → on
    expect(pairs).toEqual([[false, true]]);
    // held on: the previous value is now true, so the edge is NOT an edge
    retheme.applyConfig(clone(ctx.config));
    expect(pairs).toEqual([
      [false, true],
      [true, true],
    ]);
    // off, then on again: a NEW edge
    const off = clone(ctx.config);
    (off.ui as Record<string, unknown>).dualPane = false;
    retheme.applyConfig(off);
    retheme.applyConfig(on);
    expect(pairs).toEqual([
      [false, true],
      [true, true],
      [true, false],
      [false, true],
    ]);
  });

  test("follow-terminal under tty warns once that the console palette wins", () => {
    const ctx = mkCtx();
    (ctx as Record<string, unknown>).isTtyMode = () => true;
    const retheme = makeRetheme(ctx as any);
    const on = clone(defaultConfig);
    (on.ui as Record<string, unknown>).followTerminal = true;
    retheme.applyConfig(on);
    expect(ctx.calls.notify.length).toBe(1);
    expect(String(ctx.calls.notify[0]![0])).toMatch(/console/i);

    retheme.applyConfig(clone(ctx.config));
    expect(ctx.calls.notify.length).toBe(1); // held on: silent

    const off = clone(ctx.config);
    (off.ui as Record<string, unknown>).followTerminal = false;
    retheme.applyConfig(off);
    retheme.applyConfig(on);
    expect(ctx.calls.notify.length).toBe(2); // off->on again: remind again
  });

  test("follow-terminal off the console stays silent", () => {
    const ctx = mkCtx();
    const retheme = makeRetheme(ctx as any);
    const on = clone(defaultConfig);
    (on.ui as Record<string, unknown>).followTerminal = true;
    retheme.applyConfig(on);
    expect(ctx.calls.notify.length).toBe(0);
  });

  test("tile-hover enable/direction re-render (headroom is baked at build)", () => {
    // fileHoverAnimation/direction BAKE layout at tile build (marginTop
    // headroom + the refs.hoverLift flag, ui-grid-rows.ts) — the live per-hover
    // read only covers the highlight/lift paint and includeLabel. Exempting
    // them skipped renderAll, so toggling the feature on did nothing until the
    // next natural rebuild (the reported "needs manual reload"). The grid sig
    // already covers both keys, so un-exempting rebuilds exactly once.
    const ctx = mkCtx();
    const retheme = makeRetheme(ctx as any);
    const fresh = clone(defaultConfig);
    fresh.ui.fileHoverAnimation = true;
    fresh.ui.fileHoverSlideDir = "down";
    retheme.applyConfig(fresh);
    expect(ctx.calls.renderAll).toBe(1);
    expect(ctx.config.ui.fileHoverAnimation).toBe(true);
    expect(ctx.config.ui.fileHoverSlideDir).toBe("down");
  });

  test("tile-hover include-label stays value-only (rides live in the animator)", () => {
    // includeLabel is read per hover at ui-grid-anim.ts playHover — no baked
    // layout depends on it, so it skips the grid rebuild.
    const ctx = mkCtx();
    const retheme = makeRetheme(ctx as any);
    const fresh = clone(defaultConfig);
    fresh.ui.fileHoverIncludeLabel = true;
    retheme.applyConfig(fresh);
    expect(ctx.calls.renderAll).toBe(0);
    expect(ctx.config.ui.fileHoverIncludeLabel).toBe(true);
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

  test("a thumbnail-policy change updates mounted thumbnails before the repaint", () => {
    // grid/list, preview, and the properties hero all mount ImageRenderables
    // through the shared slot owner. The config path must update those live
    // nodes before renderAll can decide whether the grid needs a rebuild.
    const ctx = mkCtx();
    const order: string[] = [];
    const retheme = makeRetheme({
      ...ctx,
      syncThumbnailFit: () => order.push("thumbnail"),
      renderAll: () => order.push("render"),
    } as any);
    const fresh = clone(defaultConfig);
    fresh.ui.thumbnailFit = "crop";
    retheme.applyConfig(fresh);
    expect(ctx.config.ui.thumbnailFit).toBe("crop");
    expect(order).toEqual(["thumbnail", "render"]);
  });

  test("theme flip is diffed against the LAST APPLIED state, not the caller's config (pinned regression)", () => {
    const ctx = mkCtx();
    const retheme = makeRetheme(ctx as any);
    // first flip primes the last-applied signature
    const first = clone(defaultConfig);
    first.theme.accent = "#111111";
    retheme.applyConfig(first);
    expect(ctx.calls.clearFailedThumbs).toBe(1);

    // settings-row pattern: mutate the LIVE config, then applyConfig(config)
    ctx.config.theme.accent = "#222222";
    retheme.applyConfig(ctx.config);
    expect(ctx.calls.clearFailedThumbs).toBe(2); // still detected!
    expect(ctx.colors.accent).toBe("#222222");
  });

  test("applyConfig converges pane sort state through the syncSortMode hook", () => {
    // the grid reads per-pane AppState.sortBy, not config — a sort-mode
    // settings change must re-seed state or renderAll repaints the same order
    const ctx = mkCtx();
    let hookCalls = 0;
    const retheme = makeRetheme({
      ...ctx,
      syncSortMode: () => {
        hookCalls++;
      },
    } as any);
    const fresh = clone(defaultConfig);
    fresh.ui.sortMode = "size";
    retheme.applyConfig(fresh);
    expect(hookCalls).toBe(1);
    expect(ctx.calls.renderAll).toBe(1);
  });

  test("applyConfig converges the pane state BEFORE it repaints", () => {
    // the repaint must paint the NEW sort/hidden state: the convergence hooks
    // run before renderAll, or the grid rebuilds with the old order/filter
    // and the setting looks like it did nothing.
    const ctx = mkCtx();
    const order: string[] = [];
    const retheme = makeRetheme({
      ...ctx,
      syncSortMode: () => order.push("sort"),
      syncShowHidden: () => order.push("hidden"),
      renderAll: () => order.push("render"),
    } as any);
    const fresh = clone(defaultConfig);
    fresh.ui.sortMode = "size";
    fresh.ui.showHidden = true;
    retheme.applyConfig(fresh);
    expect(order).toEqual(["sort", "hidden", "render"]);
  });

  test("applyConfig converges pane hidden state through the syncShowHidden hook", () => {
    // the grid reads per-pane AppState.showHidden, not config — an external
    // config.toml edit (live reload) that flips show-hidden must re-seed state
    // or renderAll repaints the same filter. The GUI row writes state itself,
    // but the file-reload path never touches it (same hook shape as sort).
    const ctx = mkCtx();
    let hookCalls = 0;
    const retheme = makeRetheme({
      ...ctx,
      syncShowHidden: () => {
        hookCalls++;
      },
    } as any);
    const fresh = clone(defaultConfig);
    fresh.ui.showHidden = true;
    retheme.applyConfig(fresh);
    expect(hookCalls).toBe(1);
    expect(ctx.calls.renderAll).toBe(1);
  });
});

describe("rethemeChrome", () => {
  test("a sidebar-title mode change repaints the title block WITHOUT a theme flip", () => {
    // the title block is boot-baked (renderAll never rebuilds it), so
    // rethemeChrome alone isn't enough — applyConfig paints the title itself.
    // Without that, switching modes in Settings only landed after a restart.
    const ctx = mkCtx();
    const retheme = makeRetheme(ctx as any);
    const files = clone(defaultConfig);
    files.ui.sidebarTitle = "files";
    retheme.applyConfig(files);

    const painted = new Map(ctx.calls.setOnId);
    const font: any = {};
    painted.get("tfm-title-font")!(font);
    expect(font.text).toBe("Files");
    expect(font.color).toBe(ctx.colors.white);
    const sub: any = {};
    painted.get("tfm-title-sub")!(sub);
    expect(sub.visible).toBe(false);
    // the box drops one row (no tagline) — matches buildTitle's files height
    const box: any = {};
    painted.get("tfm-title-box")!(box);
    expect(box.height).toBe(4);

    // none hides the whole block; tfm restores the original title
    const noneMode = clone(defaultConfig);
    noneMode.ui.sidebarTitle = "none";
    ctx.calls.setOnId.length = 0;
    retheme.applyConfig(noneMode);
    const after = new Map(ctx.calls.setOnId);
    const font2: any = {};
    after.get("tfm-title-font")!(font2);
    expect(font2.visible).toBe(false);
    const sub2: any = {};
    after.get("tfm-title-sub")!(sub2);
    expect(sub2.visible).toBe(false);

    const tfmMode = clone(defaultConfig);
    tfmMode.ui.sidebarTitle = "tfm";
    ctx.calls.setOnId.length = 0;
    retheme.applyConfig(tfmMode);
    const back = new Map(ctx.calls.setOnId);
    const font3: any = {};
    back.get("tfm-title-font")!(font3);
    expect(font3.text).toBe("tfm");
    expect(font3.color).toBe(ctx.colors.accent);
    const sub3: any = {};
    back.get("tfm-title-sub")!(sub3);
    expect(sub3.visible).toBe(true);
    // wordmark + tagline need the full 5-row box again
    const box3: any = {};
    back.get("tfm-title-box")!(box3);
    expect(box3.height).toBe(5);
  });

  test("a theme flip still repaints the title block (rethemeChrome path)", () => {
    const ctx = mkCtx();
    const retheme = makeRetheme(ctx as any);
    const first = clone(defaultConfig);
    first.theme.accent = "#111111";
    retheme.applyConfig(first);
    ctx.calls.setOnId.length = 0;
    retheme.rethemeChrome();
    const painted = new Map(ctx.calls.setOnId);
    const font: any = {};
    painted.get("tfm-title-font")!(font);
    expect(font.color).toBe("#111111");
    expect(font.text).toBe("tfm");
  });

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
        byId: (id) => t.renderer.root.findDescendantById(id),
        rootAdd: (n) => t.renderer.root.add(n),
        destroyChildren: (node: any) => {
          for (const c of [...node.getChildren()]) c.destroy?.();
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
      await t.dispose(); // 0.6.0: destroy + await closed
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

  test("a failed save tells the user it did not save (and never claims a reload)", async () => {
    // the renderer swallows console.error, so the old path reported a failed
    // write to nobody: the setting looked applied and was NOT persisted.
    const cfg = useConfigPath("failed-save");
    try {
      const ctx = mkCtx();
      const retheme = makeRetheme({
        ...ctx,
        save: async () => {
          throw new Error("ENOSPC: no space left on device");
        },
      } as any);
      retheme.scheduleSaveConfig();
      await settleUntil(() => ctx.calls.notify.some(([m]) => /not saved/i.test(String(m))), "the save failure notice");
      const failures = ctx.calls.notify.filter(([m]) => /not saved/i.test(String(m)));
      expect(failures.length).toBe(1);
      expect(failures[0]![2]).toBe("error");
      expect(String(failures[0]![0])).toMatch(/no space left/i);
      // nothing was written, so nothing reloaded either
      expect(ctx.calls.notify.some(([m]) => /reloaded/i.test(String(m)))).toBe(false);
    } finally {
      cfg.restore();
    }
  });

  test("every failed save attempt reports (the old permanent latch silenced the rest)", async () => {
    // the old latch fired ONCE per session: a later disk-full (or a
    // read-only mount) was swallowed in silence.
    const cfg = useConfigPath("failed-save-twice");
    try {
      const ctx = mkCtx();
      const clock = mkClock();
      const retheme = makeRetheme({
        ...ctx,
        sched: clock.sched,
        save: async () => {
          throw new Error("EROFS: read-only file system");
        },
      } as any);
      const failures = () => ctx.calls.notify.filter(([m]) => /not saved/i.test(String(m)));
      retheme.scheduleSaveConfig();
      clock.advance(500);
      await settleUntil(() => failures().length === 1, "the first failure notice");
      retheme.scheduleSaveConfig();
      clock.advance(500);
      await settleUntil(() => failures().length === 2, "the second failure notice");
      expect(failures().length).toBe(2);
    } finally {
      cfg.restore();
    }
  });

  test("a slow save does not overlap the next one (the newest change wins)", async () => {
    // two overlapping atomic writes can land OUT OF ORDER (the older
    // tmp+rename lands last) → the file holds the OLD config and the
    // newest change is lost.
    const cfg = useConfigPath("save-chain");
    try {
      const ctx = mkCtx();
      const clock = mkClock();
      const gates: Array<{ cfg: Config; resolve: () => void }> = [];
      const retheme = makeRetheme({
        ...ctx,
        sched: clock.sched,
        save: (c: Config) =>
          new Promise<void>((resolve) => {
            gates.push({ cfg: c, resolve });
          }),
      } as any);

      ctx.config.ui.sidebarWidth = 21;
      retheme.scheduleSaveConfig();
      clock.advance(500);
      await settleUntil(() => gates.length === 1, "the injected save to run");
      expect(gates[0]!.cfg.ui.sidebarWidth).toBe(21);

      // a second change lands while the first write is still in flight
      ctx.config.ui.sidebarWidth = 34;
      retheme.scheduleSaveConfig();
      clock.advance(500);
      // one write at a time: the second waits for the first to land
      expect(gates.length).toBe(1);

      gates[0]!.resolve();
      await settleUntil(() => gates.length === 2, "the queued save to run");
      // the queued write carries the NEWEST config, not a stale snapshot
      expect(gates[1]!.cfg.ui.sidebarWidth).toBe(34);
    } finally {
      cfg.restore();
    }
  });

  test("an external config edit still reloads (the watcher path survives the latch refactor)", async () => {
    const cfg = useConfigPath("external-edit");
    try {
      const ctx = mkCtx();
      makeRetheme(ctx as any);
      writeFileSync(cfg.file, "[ui]\nsidebar-width = 44\n");
      await settleUntil(() => ctx.calls.notify.some(([m]) => /reloaded/i.test(String(m))), "the reload toast");
      expect(ctx.config.ui.sidebarWidth).toBe(44);
    } finally {
      cfg.restore();
    }
  });

  test("a repeated reload with the SAME conflict set does not re-toast (the conflict latch)", async () => {
    // the conflict toast fires once per CHANGE, not per reload — a lingering
    // hand-edited clash must not nag on every save.
    const cfg = useConfigPath("conflict-latch");
    try {
      const ctx = mkCtx();
      makeRetheme(ctx as any);
      const conflicts = () => ctx.calls.notify.filter(([, t]) => t === "keybind conflict");
      const reloads = () => ctx.calls.notify.filter(([m]) => /reloaded/i.test(String(m)));
      const conflicting = '[keys]\nquit = ["ctrl+q"]\ncopy = ["ctrl+q"]\n';
      writeFileSync(cfg.file, conflicting);
      await settleUntil(() => conflicts().length === 1, "the keybind conflict toast");
      // the SAME conflicting file again: the reload fires, the conflict does not
      writeFileSync(cfg.file, conflicting);
      await settleUntil(() => reloads().length === 2, "the second reload toast");
      expect(conflicts().length).toBe(1);
    } finally {
      cfg.restore();
    }
  });
});
