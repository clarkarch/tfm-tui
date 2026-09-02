import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { configPath, defaultConfig, loadConfig, saveConfig } from "./config";

// config.ts is pure file IO over $TFM_CONFIG — every test points it into a
// fresh mkdtemp dir (never a hardcoded dev-machine path, see AGENTS.md).

let dir: string;
let file: string;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "tfm-cfg-"));
  file = path.join(dir, "config.toml");
  savedEnv.TFM_CONFIG = process.env.TFM_CONFIG;
  savedEnv.XDG_CONFIG_HOME = process.env.XDG_CONFIG_HOME;
  delete process.env.TFM_CONFIG;
});

afterEach(() => {
  if (savedEnv.TFM_CONFIG === undefined) delete process.env.TFM_CONFIG;
  else process.env.TFM_CONFIG = savedEnv.TFM_CONFIG;
  if (savedEnv.XDG_CONFIG_HOME === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = savedEnv.XDG_CONFIG_HOME;
  rmSync(dir, { recursive: true, force: true });
});

describe("configPath", () => {
  test("TFM_CONFIG overrides everything", () => {
    process.env.TFM_CONFIG = file;
    expect(configPath()).toBe(file);
  });

  test("falls back to $XDG_CONFIG_HOME/tfm/config.toml", () => {
    process.env.XDG_CONFIG_HOME = path.join(dir, "xdg");
    expect(configPath()).toBe(path.join(dir, "xdg", "tfm", "config.toml"));
  });

  test("falls back to ~/.config/tfm/config.toml", () => {
    expect(configPath()).toBe(path.join(os.homedir(), ".config", "tfm", "config.toml"));
  });
});

describe("loadConfig", () => {
  test("missing file yields the full default config", () => {
    process.env.TFM_CONFIG = file;
    expect(loadConfig()).toEqual(structuredClone(defaultConfig));
  });

  test("valid TOML applies per key and keeps defaults for the rest", () => {
    process.env.TFM_CONFIG = file;
    writeFileSync(file, '[ui]\nsidebar-width = 50\nview-mode = "list"\n');
    const cfg = loadConfig();
    expect(cfg.ui.sidebarWidth).toBe(50);
    expect(cfg.ui.viewMode).toBe("list");
    expect(cfg.ui.tileWidth).toBe(defaultConfig.ui.tileWidth);
    expect(cfg.theme).toEqual(structuredClone(defaultConfig.theme));
  });

  test("out-of-range ints clamp to the schema bounds", () => {
    process.env.TFM_CONFIG = file;
    writeFileSync(file, "[ui]\nsidebar-width = 99999\n");
    const cfg = loadConfig();
    expect(cfg.ui.sidebarWidth).toBeLessThanOrEqual(60);
    expect(cfg.ui.sidebarWidth).toBeGreaterThan(defaultConfig.ui.sidebarWidth);
  });

  test("malformed TOML falls back to defaults and warns on stderr once", () => {
    process.env.TFM_CONFIG = file;
    writeFileSync(file, "this is = not = toml [[[\n");
    const errs: string[] = [];
    const realErr = console.error;
    console.error = (...a: unknown[]) => {
      errs.push(a.join(" "));
    };
    try {
      expect(loadConfig()).toEqual(structuredClone(defaultConfig));
    } finally {
      console.error = realErr;
    }
    expect(errs.length).toBe(1);
    expect(errs[0]).toContain("malformed config");
  });

  test("unknown keys are ignored, not merged", () => {
    process.env.TFM_CONFIG = file;
    writeFileSync(file, '[ui]\nbogus-key = "x"\nsidebar-width = 30\n');
    const cfg = loadConfig();
    expect(cfg.ui.sidebarWidth).toBe(30);
    expect("bogusKey" in cfg.ui).toBe(false);
  });
});

describe("saveConfig", () => {
  test("round-trips through loadConfig", async () => {
    process.env.TFM_CONFIG = file;
    const cfg = structuredClone(defaultConfig);
    cfg.ui.sidebarWidth = 42;
    cfg.ui.viewMode = "list";
    cfg.theme.accent = "#010203";
    cfg.keys.undo = ["ctrl+g"];
    await saveConfig(cfg);
    const back = loadConfig();
    expect(back.ui.sidebarWidth).toBe(42);
    expect(back.ui.viewMode).toBe("list");
    expect(back.theme.accent).toBe("#010203");
    expect(back.keys.undo).toEqual(["ctrl+g"]);
  });

  test("writes atomically: no .tmp residue, parent dirs created", async () => {
    process.env.TFM_CONFIG = path.join(dir, "deep", "nested", "config.toml");
    await saveConfig(structuredClone(defaultConfig));
    expect(existsSync(configPath())).toBe(true);
    expect(existsSync(`${configPath()}.tmp`)).toBe(false);
  });

  test("serialized output carries the regenerated doc comments", async () => {
    process.env.TFM_CONFIG = file;
    await saveConfig(structuredClone(defaultConfig));
    const raw = readFileSync(file, "utf8");
    expect(raw).toContain("[ui]");
    expect(raw).toContain("# ");
    expect(raw).toContain("sidebar-width");
  });
});
