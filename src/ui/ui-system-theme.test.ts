import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { defaultConfig, type Config } from "../config/config-schema";
import { makeSystemTheme } from "./ui-system-theme";

// makeSystemTheme bridges the renderer terminal query (getPalette /
// waitForThemeMode / THEME_MODE) to applyConfig: resolve at boot/toggle,
// live-follow on terminal theme switches, silent terminals keep the preset.

const PALETTE = [
  "#16161e",
  "#f7768e",
  "#9ece6a",
  "#e0af68",
  "#7aa2f7",
  "#bb9af7",
  "#7dcfff",
  "#c0caf5",
  "#565f89",
  "#f7768e",
  "#9ece6a",
  "#e0af68",
  "#7aa2f7",
  "#bb9af7",
  "#7dcfff",
  "#c0caf5",
];

class FakeRenderer extends EventEmitter {
  themeMode: "dark" | "light" | null = "dark";
  paletteCalls = 0;
  failPalette = false;
  palTimeouts: number[] = [];
  modeTimeouts: number[] = [];
  bgCalls: string[] = [];
  async waitForThemeMode(ms: number): Promise<"dark" | "light" | null> {
    this.modeTimeouts.push(ms);
    return this.themeMode;
  }
  async getPalette(opts?: { timeout?: number }): Promise<{
    palette: Array<string | null>;
    defaultForeground: string | null;
    defaultBackground: string | null;
    cursorColor: string | null;
  }> {
    this.paletteCalls++;
    this.palTimeouts.push(opts?.timeout ?? -1);
    if (this.failPalette) throw new Error("no osc support");
    return {
      palette: [...PALETTE],
      defaultForeground: "#c0caf5",
      defaultBackground: "#1a1b26",
      cursorColor: "#ff9e64",
    };
  }
  setBackgroundColor(c: string): void {
    this.bgCalls.push(c);
  }
}

const clone = (c: Config): Config => JSON.parse(JSON.stringify(c));

// manual clock for the follow debounce (repo rule: timing units test on a
// virtual clock — bun has no fake timers)
const manualSched = () => {
  const pending = new Map<number, () => void>();
  let next = 1;
  return {
    pending,
    sched: {
      setTimeout: (cb: () => void, _ms: number): unknown => {
        const id = next++;
        pending.set(id, cb);
        return id;
      },
      clearTimeout: (h: unknown): void => {
        pending.delete(h as number);
      },
    },
  };
};

const mkCtx = (
  follow: boolean,
  sched?: { setTimeout(cb: () => void, ms: number): unknown; clearTimeout(h: unknown): void },
) => {
  const config = clone(defaultConfig);
  config.ui.followTerminal = follow;
  const colors = { ...config.theme };
  const renderer = new FakeRenderer();
  const calls = { apply: 0, saves: 0, log: [] as string[] };
  const sys = makeSystemTheme({
    renderer: () => renderer,
    config,
    colors,
    applyConfig: (fresh: Config) => {
      calls.apply++;
      Object.assign(config.theme, fresh.theme);
      Object.assign(config.ui, fresh.ui);
    },
    scheduleSaveConfig: () => {
      calls.saves++;
    },
    log: (m: string) => calls.log.push(m),
    ...(sched ? { sched } : {}),
  });
  return { config, colors, renderer, calls, sys };
};

describe("resolveSystemTheme", () => {
  test("no-ops when follow-terminal is off (never queries the terminal)", async () => {
    const { sys, renderer, calls } = mkCtx(false);
    expect(await sys.resolveSystemTheme(50)).toBe(false);
    expect(renderer.paletteCalls).toBe(0);
    expect(calls.apply).toBe(0);
  });

  test("derives + applies the terminal theme when on", async () => {
    const { sys, config, calls } = mkCtx(true);
    expect(await sys.resolveSystemTheme(200)).toBe(true);
    expect(calls.apply).toBe(1);
    expect(config.theme.bg).toBe("#1a1b26");
    // orange cursor reads on the blue-tinted selection fill (pinned in
    // system-theme.test.ts); the bridge asserts the derived value lands
    expect(config.theme.accent).toBe("#ff9e64");
    expect(config.theme.ansi2).toBe("#9ece6a");
    expect(config.ui.followTerminal).toBe(true);
  });

  test("a successful runtime resolve schedules a config save", async () => {
    const { sys, calls } = mkCtx(true);
    expect(await sys.resolveSystemTheme(200)).toBe(true);
    expect(calls.saves).toBe(1);
  });

  test("every resolve logs what it derived (always-on trace, no --debug)", async () => {
    const { sys, calls } = mkCtx(true);
    expect(await sys.resolveSystemTheme(200)).toBe(true);
    const line = calls.log.find((l) => l.startsWith("system theme derived"));
    expect(line).toContain("bg=#1a1b26");
    expect(line).toContain("accent=");
    expect(line).toContain("border=");
  });

  test("no save when off or when the terminal stays silent", async () => {
    const off = mkCtx(false);
    expect(await off.sys.resolveSystemTheme(50)).toBe(false);
    expect(off.calls.saves).toBe(0);
    const { sys, renderer, calls } = mkCtx(true);
    renderer.failPalette = true;
    expect(await sys.resolveSystemTheme(200)).toBe(false);
    expect(calls.saves).toBe(0);
  });

  test("silent terminal (palette throw) keeps the preset and reports false", async () => {
    const { sys, renderer, config, calls } = mkCtx(true);
    renderer.failPalette = true;
    expect(await sys.resolveSystemTheme(200)).toBe(false);
    expect(calls.apply).toBe(0);
    expect(config.theme.bg).toBe(defaultConfig.theme.bg);
    expect(calls.log.length).toBeGreaterThan(0);
  });

  test("missing renderer resolves false without throwing", async () => {
    const config = clone(defaultConfig);
    config.ui.followTerminal = true;
    const sys = makeSystemTheme({
      renderer: () => null,
      config,
      colors: { ...config.theme },
      applyConfig: () => {
        throw new Error("must not apply");
      },
    });
    expect(await sys.resolveSystemTheme(50)).toBe(false);
  });

  test("null themeMode still derives (mode inferred from bg brightness)", async () => {
    const { sys, renderer, config } = mkCtx(true);
    renderer.themeMode = null;
    expect(await sys.resolveSystemTheme(200)).toBe(true);
    expect(config.theme.bg).toBe("#1a1b26");
  });
});

describe("applyBootSystemTheme", () => {
  test("writes config.theme + colors directly, no applyConfig/renderAll", async () => {
    const { sys, config, colors } = mkCtx(true);
    let applied = false;
    const sysNoApply = makeSystemTheme({
      renderer: () => new FakeRenderer(),
      config,
      colors,
      applyConfig: () => {
        applied = true;
      },
    });
    expect(await sysNoApply.applyBootSystemTheme(200)).toBe(true);
    expect(applied).toBe(false);
    expect(config.theme.bg).toBe("#1a1b26");
    // runtime colors carry the opaque bumpHex nudge; config stores RAW hex
    expect(colors.bg).toBe("#1a1b27");
    expect(sys).toBeDefined();
  });

  test("false when follow-terminal is off or the terminal is silent", async () => {
    const off = mkCtx(false);
    expect(await off.sys.applyBootSystemTheme(50)).toBe(false);
    const { sys, renderer } = mkCtx(true);
    renderer.failPalette = true;
    expect(await sys.applyBootSystemTheme(200)).toBe(false);
  });

  test("compat/console mode skips the boot derive (static console palette wins)", async () => {
    const h = mkCtx(true);
    const sys = makeSystemTheme({
      renderer: () => h.renderer,
      config: h.config,
      colors: h.colors,
      applyConfig: () => {},
      compatActive: () => true,
    });
    const before = h.config.theme.bg;
    expect(await sys.applyBootSystemTheme(200)).toBe(false);
    // never queried, never painted, config theme untouched
    expect(h.renderer.paletteCalls).toBe(0);
    expect(h.renderer.bgCalls).toEqual([]);
    expect(h.config.theme.bg).toBe(before);
  });

  test("boot success fires onBootDerived once; silence/off never fire", async () => {
    const h = mkCtx(true);
    const fired: unknown[] = [];
    const sys = makeSystemTheme({
      renderer: () => h.renderer,
      config: h.config,
      colors: h.colors,
      applyConfig: () => {},
      onBootDerived: (t) => fired.push(t),
    });
    expect(await sys.applyBootSystemTheme(200)).toBe(true);
    expect(fired).toHaveLength(1);
    const silent = mkCtx(true);
    silent.renderer.failPalette = true;
    let silentFired = 0;
    const sysSilent = makeSystemTheme({
      renderer: () => silent.renderer,
      config: silent.config,
      colors: silent.colors,
      applyConfig: () => {},
      onBootDerived: () => silentFired++,
    });
    expect(await sysSilent.applyBootSystemTheme(200)).toBe(false);
    expect(silentFired).toBe(0);
  });
});

describe("followSystemTheme", () => {
  test("a THEME_MODE event re-resolves while follow-terminal is on", async () => {
    const { sys, renderer, config, calls } = mkCtx(true);
    const stop = sys.followSystemTheme();
    renderer.emit("theme_mode", "light");
    const deadline = Date.now() + 2000;
    while (calls.apply === 0 && Date.now() < deadline) await Bun.sleep(10);
    expect(calls.apply).toBeGreaterThan(0);
    expect(config.theme.bg).toBe("#1a1b26");
    stop?.();
  });

  test("no re-resolve after stop, or when follow-terminal is off", async () => {
    // stopped subscription: the listener is gone, nothing is even scheduled
    const h = mkCtx(true, manualSched().sched);
    const stop = h.sys.followSystemTheme();
    (stop as () => void)();
    h.renderer.emit("theme_mode", "light");
    expect(h.calls.apply).toBe(0);

    // flag off: the debounced handler runs but bails before querying
    const clk = manualSched();
    const off = mkCtx(false, clk.sched);
    off.sys.followSystemTheme();
    off.renderer.emit("theme_mode", "light");
    expect(clk.pending.size).toBe(1);
    for (const fn of [...clk.pending.values()]) fn();
    clk.pending.clear();
    await Bun.sleep(0);
    expect(off.renderer.paletteCalls).toBe(0);
    expect(off.calls.apply).toBe(0);
  });

  test("a PALETTE event re-resolves too (same-mode palette switches)", async () => {
    const { sys, renderer, calls } = mkCtx(true);
    const stop = sys.followSystemTheme();
    renderer.emit("palette", {});
    const deadline = Date.now() + 2000;
    while (calls.apply === 0 && Date.now() < deadline) await Bun.sleep(10);
    expect(calls.apply).toBeGreaterThan(0);
    stop?.();
  });
});

describe("boot renderer bg (B1)", () => {
  test("boot path sets the renderer background to the derived bg", async () => {
    const { sys, renderer } = mkCtx(true);
    expect(await sys.applyBootSystemTheme(200)).toBe(true);
    // opaque mode: renderer bg tracks the nudged runtime bg, not the preset
    expect(renderer.bgCalls).toEqual(["#1a1b27"]);
  });

  test("boot path sets transparent renderer bg when transparentBg is on", async () => {
    const h = mkCtx(true);
    h.config.ui.transparentBg = true;
    expect(await h.sys.applyBootSystemTheme(200)).toBe(true);
    expect(h.renderer.bgCalls).toEqual(["transparent"]);
  });
});

describe("stale landings (B2)", () => {
  test("a resolve landing after toggle-off is dropped", async () => {
    const config = clone(defaultConfig);
    config.ui.followTerminal = true;
    let release!: (v: {
      palette: Array<string | null>;
      defaultForeground: string | null;
      defaultBackground: string | null;
      cursorColor: string | null;
    }) => void;
    const gate = new Promise<{
      palette: Array<string | null>;
      defaultForeground: string | null;
      defaultBackground: string | null;
      cursorColor: string | null;
    }>((res) => {
      release = res;
    });
    const renderer = new FakeRenderer();
    (renderer as unknown as { getPalette: () => Promise<unknown> }).getPalette = () => gate;
    let applied = 0;
    const sys = makeSystemTheme({
      renderer: () => renderer,
      config,
      colors: { ...config.theme },
      applyConfig: () => {
        applied++;
      },
    });
    const p = sys.resolveSystemTheme(2000);
    // user picks a preset while the query is in flight
    config.ui.followTerminal = false;
    release({
      palette: [...PALETTE],
      defaultForeground: "#c0caf5",
      defaultBackground: "#1a1b26",
      cursorColor: "#ff9e64",
    });
    expect(await p).toBe(false);
    expect(applied).toBe(0);
  });
});

describe("independent settle (B3)", () => {
  test("a slow theme-mode does not discard a fast palette", async () => {
    const { sys, renderer, config } = mkCtx(true);
    renderer.waitForThemeMode = () => new Promise(() => {}) as Promise<null>;
    expect(await sys.resolveSystemTheme(120)).toBe(true);
    expect(config.theme.bg).toBe("#1a1b26");
  });
});

describe("query budgets (B4)", () => {
  test("boot defaults to a short budget, runtime to the full one", async () => {
    const boot = mkCtx(true);
    boot.renderer.themeMode = null; // force the waitForThemeMode leg
    await boot.sys.applyBootSystemTheme();
    expect(boot.renderer.palTimeouts[0]).toBeLessThanOrEqual(300);
    expect(boot.renderer.modeTimeouts[0]).toBeLessThanOrEqual(300);
    const run = mkCtx(true);
    await run.sys.resolveSystemTheme();
    expect(run.renderer.palTimeouts[0]).toBe(800);
  });
});
