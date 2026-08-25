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
