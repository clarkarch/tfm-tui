import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { tdzSafe, wirePlugins } from "./plugins";

describe("tdzSafe", () => {
  test("passes the getter value through when healthy", () => {
    expect(tdzSafe(() => 42, 0)()).toBe(42);
  });

  test("a throwing getter (TDZ pre-init access) yields the fallback, never throws", () => {
    // mirrors index.ts: `keymap` is a const initialized after wirePlugins
    // scans, so an eager api.commands() at activate top level would throw a
    // ReferenceError without the guard
    const read = (): string[] => keymap.commands();
    expect(() => read()).toThrow(ReferenceError);
    expect(tdzSafe(read, [] as string[])()).toEqual([]);
    const keymap = { commands: () => ["quit"] };
    expect(tdzSafe(read, [] as string[])()).toEqual(["quit"]);
  });
});

describe("api action surface (wired passthrough)", () => {
  const oldCfg = process.env.XDG_CONFIG_HOME;
  const oldCache = process.env.XDG_CACHE_HOME;
  afterEach(() => {
    if (oldCfg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = oldCfg;
    if (oldCache === undefined) delete process.env.XDG_CACHE_HOME;
    else process.env.XDG_CACHE_HOME = oldCache;
  });

  test("prompt/navigate/open/reveal/select reach their collaborators", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "tfm-wire-plugins-"));
    process.env.XDG_CONFIG_HOME = path.join(root, "config");
    process.env.XDG_CACHE_HOME = path.join(root, "cache");
    const calls: string[] = [];
    const fakePrompt = {
      open: (o: { title: string; initial?: string }) => {
        calls.push(`prompt:${o.title}:${o.initial ?? ""}`);
        return Promise.resolve("typed");
      },
    };
    const nav = {
      navigate: (d: string) => calls.push(`nav:${d}`),
      setStatusMsg: (m: string) => calls.push(`status:${m}`),
    };
    const chrome = {
      notify: () => {},
      notifySticky: () => null,
      openFileDefault: (p: string) => calls.push(`open:${p}`),
    };
    const selection = {
      selPaths: () => [{ path: "/x/a", isDir: false }],
      selectPaths: (ps: string[]) => calls.push(`select:${ps.join(",")}`),
    };
    const core = { state: { cwd: "/x" }, config: { keys: {} } };
    try {
      const wiring = await wirePlugins({
        core: core as never,
        nav: nav as never,
        chrome: chrome as never,
        gridFoundation: { selection } as never,
        getKeymap: () => ({ commands: () => [] }),
        getPick: () => ({ open: () => {} }),
        getPrompt: () => fakePrompt,
      });
      const api = wiring.api;
      expect(await api.ui.prompt({ title: "hi", value: "pre" })).toBe("typed");
      expect(calls).toContain("prompt:hi:pre");
      api.navigate("/y");
      expect(calls).toContain("nav:/y");
      api.open("/x/a");
      expect(calls).toContain("open:/x/a");
      api.select(["/x/a"]);
      expect(calls).toContain("select:/x/a");
      api.reveal("/x/a");
      expect(calls).toContain("nav:/x"); // reveal navigates to dirname
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("background scan (lazy first paint)", () => {
  const oldCfg = process.env.XDG_CONFIG_HOME;
  const oldCache = process.env.XDG_CACHE_HOME;
  afterEach(() => {
    if (oldCfg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = oldCfg;
    if (oldCache === undefined) delete process.env.XDG_CACHE_HOME;
    else process.env.XDG_CACHE_HOME = oldCache;
  });

  // the scan runs in the background: wirePlugins returns while a slow
  // activate is still parked, and the live array hydrates when it settles
  // (registrations merge with no re-wiring — same seam menus/keymap read).
  test("wirePlugins returns before a slow activate settles; commands surface after", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "tfm-wire-plugins-lazy-"));
    const pluginsHome = path.join(root, "config", "tfm", "plugins");
    process.env.XDG_CONFIG_HOME = path.join(root, "config");
    process.env.XDG_CACHE_HOME = path.join(root, "cache");
    const { mkdirSync, writeFileSync } = await import("node:fs");
    // an activate that parks ~1.5s: under the current await-scan wiring the
    // wirePlugins promise cannot settle before it; background scan returns at once
    mkdirSync(path.join(pluginsHome, "slow"), { recursive: true });
    writeFileSync(
      path.join(pluginsHome, "slow", "slow.ts"),
      `export default { name: "slow", activate: async () => { await new Promise((r) => setTimeout(r, 1500)); return { commands: [{ id: "slow:hi", title: "hi", run: () => {} }] }; } };\n`,
    );
    // headless renderer: a bare object takes makePluginSlots' no-op degrade
    // path (prod with a live renderer takes the success path instead — this
    // test only pins scan hydration + the api.commands merge, which are
    // renderer-independent)
    const fakeRenderer = {};
    try {
      let renders = 0;
      const t0 = Date.now();
      const wiring = await wirePlugins({
        core: { state: { cwd: "/x" }, config: { keys: {}, ui: { lazyStartup: true } } } as never,
        nav: {
          navigate: () => {},
          setStatusMsg: () => {},
          renderAll: () => {
            renders++;
          },
        } as never,
        chrome: {
          renderer: fakeRenderer,
          notify: () => {},
          notifySticky: () => null,
          openFileDefault: () => {},
        } as never,
        gridFoundation: { selection: { selPaths: () => [], selectPaths: () => {} } } as never,
        getKeymap: () => ({ commands: () => [] }),
        getPick: () => ({ open: () => {} }),
      });
      // deterministic core: the scan is still parked on its 1.5s activate, so
      // the live array is empty at return (old await-scan code returns it full)
      expect(wiring.plugins.length).toBe(0);
      // secondary timing bound: returned well before the parked activate could
      // settle (the window above is purely synchronous setup, no awaits)
      expect(Date.now() - t0).toBeLessThan(1000);
      // the live array hydrates when the scan settles (poll, never sleep —
      // suite rule for fire-and-forget races)
      const deadline = Date.now() + 10000;
      while (wiring.plugins.length === 0 && Date.now() < deadline) await Bun.sleep(10);
      expect(wiring.plugins.map((p) => p.name)).toEqual(["slow"]);
      expect(wiring.api.commands().map((c) => c.id)).toContain("slow:hi");
      // late arrivals paint: the background scan triggers one renderAll when
      // it settles, so slots/rows/menus don't wait for the next navigation
      const deadline2 = Date.now() + 10000;
      while (renders === 0 && Date.now() < deadline2) await Bun.sleep(10);
      expect(renders).toBeGreaterThanOrEqual(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 15000);

  // [ui] lazy-startup off (default) = classic: the scan settles BEFORE
  // wirePlugins returns, so plugins are present on the first paint. A SLOW
  // activate proves the await: instant plugins resolve either way, so only a
  // parked activate tells eager from background (the lazy test's mirror).
  // The classic path must NOT render: at wirePlugins time the later wirings
  // (grid/settings/watcher/keymap) don't exist yet, so an eager renderAll
  // TDZ-throws inside every step that reads them (the bug this pins — the
  // fake's counter goes red, no debug-log probe needed).
  test("classic scan awaits: slow plugin present at return, renders nothing", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "tfm-wire-plugins-classic-"));
    const pluginsHome = path.join(root, "config", "tfm", "plugins");
    process.env.XDG_CONFIG_HOME = path.join(root, "config");
    process.env.XDG_CACHE_HOME = path.join(root, "cache");
    const { mkdirSync, writeFileSync } = await import("node:fs");
    mkdirSync(path.join(pluginsHome, "slow2"), { recursive: true });
    writeFileSync(
      path.join(pluginsHome, "slow2", "slow2.ts"),
      `export default { name: "slow2", activate: async () => { await new Promise((r) => setTimeout(r, 800)); return { commands: [{ id: "slow2:hi", title: "hi", run: () => {} }] }; } };\n`,
    );
    const fakeRenderer = {};
    try {
      const t0 = Date.now();
      let renders = 0;
      const wiring = await wirePlugins({
        core: { state: { cwd: "/x" }, config: { keys: {}, ui: { lazyStartup: false } } } as never,
        nav: {
          navigate: () => {},
          setStatusMsg: () => {},
          renderAll: () => {
            renders++;
          },
        } as never,
        chrome: {
          renderer: fakeRenderer,
          notify: () => {},
          notifySticky: () => null,
          openFileDefault: () => {},
        } as never,
        gridFoundation: { selection: { selPaths: () => [], selectPaths: () => {} } } as never,
        getKeymap: () => ({ commands: () => [] }),
        getPick: () => ({ open: () => {} }),
      });
      // the await held the return past the 800ms activate: hydrated at return
      expect(Date.now() - t0).toBeGreaterThanOrEqual(700);
      expect(wiring.plugins.map((p) => p.name)).toEqual(["slow2"]);
      expect(wiring.api.commands().map((c) => c.id)).toContain("slow2:hi");
      // … and settled with zero renders: an eager renderAll here TDZ-throws
      // (later wirings don't exist yet) — the fake counts, it can't throw
      expect(renders).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 15000);
});

describe("api.ui.prompt fallbacks", () => {
  const oldCfg = process.env.XDG_CONFIG_HOME;
  const oldCache = process.env.XDG_CACHE_HOME;
  afterEach(() => {
    if (oldCfg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = oldCfg;
    if (oldCache === undefined) delete process.env.XDG_CACHE_HOME;
    else process.env.XDG_CACHE_HOME = oldCache;
  });

  test("resolves null when the prompt widget is absent", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "tfm-wire-noprompt-"));
    process.env.XDG_CONFIG_HOME = path.join(root, "config");
    process.env.XDG_CACHE_HOME = path.join(root, "cache");
    try {
      const wiring = await wirePlugins({
        core: { state: { cwd: "/x" }, config: { keys: {} } } as never,
        nav: { navigate: () => {}, setStatusMsg: () => {} } as never,
        chrome: { notify: () => {}, notifySticky: () => null, openFileDefault: () => {} } as never,
        gridFoundation: { selection: { selPaths: () => [], selectPaths: () => {} } } as never,
        getKeymap: () => ({ commands: () => [] }),
        getPick: () => ({ open: () => {} }),
      });
      expect(await wiring.api.ui.prompt({ title: "x" })).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
