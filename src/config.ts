import { readFileSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parse, stringify } from "smol-toml";

export type Theme = {
  bg: string;
  sidebarBg: string;
  sidebarFg: string;
  sidebarFgMuted: string;
  accent: string;
  accentBg: string;
  hoverBg: string;
  border: string;
  divider: string;
  white: string;
  // syntax palette for the preview pane; opencode-style per-theme values,
  // falling back to these tokyo-night hues when a config omits them
  syntaxString: string;
  syntaxNumber: string;
  syntaxType: string;
  syntaxFunction: string;
  syntaxOperator: string;
  syntaxProperty: string;
  ansi0: string;
  ansi1: string;
  ansi2: string;
  ansi3: string;
  ansi4: string;
  ansi5: string;
  ansi6: string;
  ansi7: string;
  ansi8: string;
  ansi9: string;
  ansi10: string;
  ansi11: string;
  ansi12: string;
  ansi13: string;
  ansi14: string;
  ansi15: string;
};

export type UiConfig = {
  sidebarWidth: number;
  tileWidth: number;
  tileHeight: number;
  iconCells: number;
  doubleClickMs: number;
  showHidden: boolean;
  previewEnabled: boolean;
  previewWidth: number;
  restoreSession: boolean;
  transparentBg: boolean;
};

export type Config = { ui: UiConfig; theme: Theme };

export const defaultConfig: Config = {
  ui: {
    sidebarWidth: 26,
    tileWidth: 20,
    tileHeight: 5,
    iconCells: 3,
    doubleClickMs: 400,
    showHidden: false,
    previewEnabled: false,
    previewWidth: 40,
    restoreSession: false,
    transparentBg: false,
  },
  theme: {
    bg: "#1a1b26",
    sidebarBg: "#16161e",
    sidebarFg: "#c0caf5",
    sidebarFgMuted: "#565f89",
    accent: "#7aa2f7",
    accentBg: "#292e42",
    hoverBg: "#24283b",
    border: "#292e42",
    divider: "#292e42",
    white: "#c0caf5",
    syntaxString: "#9ece6a",
    syntaxNumber: "#ff9e64",
    syntaxType: "#2ac3de",
    syntaxFunction: "#7aa2f7",
    syntaxOperator: "#89ddff",
    syntaxProperty: "#73daca",
    // ANSI 0-15 pushed into the embedded terminal via OSC 4 so programs inside
    // (ls --color, vim, prompts) match the tfm palette instead of stock xterm
    ansi0: "#16161e",
    ansi1: "#f7768e",
    ansi2: "#9ece6a",
    ansi3: "#e0af68",
    ansi4: "#7aa2f7",
    ansi5: "#bb9af7",
    ansi6: "#7dcfff",
    ansi7: "#c0caf5",
    ansi8: "#565f89",
    ansi9: "#f7768e",
    ansi10: "#9ece6a",
    ansi11: "#e0af68",
    ansi12: "#7aa2f7",
    ansi13: "#bb9af7",
    ansi14: "#7dcfff",
    ansi15: "#c0caf5",
  },
};

const THEME_KEYS = Object.keys(defaultConfig.theme) as (keyof Theme)[];
const HEX_RE = /^#[0-9a-fA-F]{6}$/;

const clampInt = (v: unknown, min: number, max: number, fallback: number): number => {
  const n = typeof v === "number" ? Math.round(v) : NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
};

const pickColor = (v: unknown, fallback: string): string =>
  typeof v === "string" && HEX_RE.test(v) ? v : fallback;

export function configPath(): string {
  if (process.env.TFM_CONFIG) return process.env.TFM_CONFIG;
  const base = process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config");
  return path.join(base, "tfm", "config.toml");
}

export function loadConfig(): Config {
  const file = configPath();
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return defaultConfig;
  }

  let doc: any;
  try {
    doc = parse(raw);
  } catch (err) {
    console.error(`[tfm] ignoring malformed config ${file}: ${err}`);
    return defaultConfig;
  }
  if (typeof doc !== "object" || doc === null) return defaultConfig;

  const uiRaw = typeof doc.ui === "object" && doc.ui !== null ? doc.ui : {};
  const themeRaw = typeof doc.theme === "object" && doc.theme !== null ? doc.theme : {};

  return {
    ui: {
      sidebarWidth: clampInt(uiRaw["sidebar-width"], 16, 60, defaultConfig.ui.sidebarWidth),
      tileWidth: clampInt(uiRaw["tile-width"], 10, 40, defaultConfig.ui.tileWidth),
      tileHeight: clampInt(uiRaw["tile-height"], 3, 10, defaultConfig.ui.tileHeight),
      iconCells: clampInt(uiRaw["icon-cells"], 1, 5, defaultConfig.ui.iconCells),
      doubleClickMs: clampInt(uiRaw["double-click-ms"], 100, 2000, defaultConfig.ui.doubleClickMs),
      showHidden: typeof uiRaw["show-hidden"] === "boolean" ? uiRaw["show-hidden"] : defaultConfig.ui.showHidden,
      previewEnabled: typeof uiRaw["preview-enabled"] === "boolean" ? uiRaw["preview-enabled"] : defaultConfig.ui.previewEnabled,
      previewWidth: clampInt(uiRaw["preview-width"], 20, 80, defaultConfig.ui.previewWidth),
      restoreSession: typeof uiRaw["restore-session"] === "boolean" ? uiRaw["restore-session"] : defaultConfig.ui.restoreSession,
      transparentBg: typeof uiRaw["transparent-bg"] === "boolean" ? uiRaw["transparent-bg"] : defaultConfig.ui.transparentBg,
    },
    theme: THEME_KEYS.reduce((acc, key) => {
      acc[key] = pickColor(themeRaw[key], defaultConfig.theme[key]);
      return acc;
    }, {} as Theme),
  };
}

// The settings UI writes this exact shape; loadConfig reads ui keys kebab-case
// and theme keys camelCase, so the round-trip is stable. Comments in a
// hand-edited file are not preserved (smol-toml cannot round-trip them).
export function serializeConfig(cfg: Config): string {
  const doc = {
    ui: {
      "sidebar-width": cfg.ui.sidebarWidth,
      "tile-width": cfg.ui.tileWidth,
      "tile-height": cfg.ui.tileHeight,
      "icon-cells": cfg.ui.iconCells,
      "double-click-ms": cfg.ui.doubleClickMs,
      "show-hidden": cfg.ui.showHidden,
      "preview-enabled": cfg.ui.previewEnabled,
      "preview-width": cfg.ui.previewWidth,
      "restore-session": cfg.ui.restoreSession,
      "transparent-bg": cfg.ui.transparentBg,
    },
    theme: { ...cfg.theme },
  };
  const header = "# tfm configuration\n# Also editable live: press esc -> Settings in the app.\n\n";
  return header + stringify(doc);
}

export async function saveConfig(cfg: Config): Promise<void> {
  const file = configPath();
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await writeFile(tmp, serializeConfig(cfg));
  await rename(tmp, file);
}
