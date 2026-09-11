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
