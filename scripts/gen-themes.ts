// Steals opencode's TUI theme assets and emits src/themes.ts with tfm-shaped
// dark palettes. Usage: bun scripts/gen-themes.ts [path-to-opencode-assets]
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const SRC_ARG = process.argv[2];
if (!SRC_ARG) {
  console.error("usage: bun scripts/gen-themes.ts <opencode-assets-dir>");
  process.exit(1);
}
const SRC_DIR = SRC_ARG;
const OUT = new URL("../src/themes.ts", import.meta.url).pathname;

// the tfm default palette already IS tokyonight; skip the near-duplicate
const SKIP = new Set(["tokyonight"]);

const NAMES: Record<string, string> = {
  aura: "Aura", ayu: "Ayu", carbonfox: "Carbon Fox", "catppuccin-frappe": "Frappe",
  catppuccin: "Catppuccin", "catppuccin-macchiato": "Macchiato", cobalt2: "Cobalt 2",
  cursor: "Cursor", dracula: "Dracula", everforest: "Everforest", flexoki: "Flexoki",
  github: "GitHub", gruvbox: "Gruvbox", kanagawa: "Kanagawa", "lucent-orng": "Lucent Orng",
  material: "Material", matrix: "Matrix", mercury: "Mercury", monokai: "Monokai",
  nightowl: "Night Owl", nord: "Nord", "one-dark": "One Dark", opencode: "OpenCode",
  orng: "Orng", "osaka-jade": "Osaka Jade", palenight: "Palenight", rosepine: "Rose Pine",
  solarized: "Solarized", synthwave84: "Synth '84", vercel: "Vercel", vesper: "Vesper",
  zenburn: "Zenburn",
};

type Defs = Record<string, string>;
type Variant = { dark?: string; light?: string };

const mixHex = (a: string, b: string, t: number): string => {
  const pa = parseInt(a.slice(1), 16);
  const pb = parseInt(b.slice(1), 16);
  const ch = (sa: number, sb: number) => Math.round(sa + (sb - sa) * t);
  const r = ch((pa >> 16) & 255, (pb >> 16) & 255);
  const g = ch((pa >> 8) & 255, (pb >> 8) & 255);
  const b2 = ch(pa & 255, pb & 255);
  return `#${((r << 16) | (g << 8) | b2).toString(16).padStart(6, "0")}`;
};

const makeResolver = (defs: Defs) => {
  const resolve = (ref: string | undefined, depth = 0): string | null => {
    if (!ref || depth > 4) return null;
    if (/^#[0-9a-fA-F]{3}$/.test(ref)) {
      return `#${ref[1]}${ref[1]}${ref[2]}${ref[2]}${ref[3]}${ref[3]}`.toLowerCase();
    }
    if (ref.startsWith("#")) return ref.toLowerCase();
    return resolve(defs[ref], depth + 1);
  };
  return resolve;
};

type Entry = { file: string; name: string; theme: Record<string, string> };
const entries: Entry[] = [];

for (const file of readdirSync(SRC_DIR).filter((f) => f.endsWith(".json")).sort()) {
  const slug = file.replace(/\.json$/, "");
  if (SKIP.has(slug)) continue;
  const name = NAMES[slug];
  if (!name) throw new Error(`no display name for ${slug}; add it to NAMES`);

  const json = JSON.parse(readFileSync(path.join(SRC_DIR, file), "utf8"));
  const defs: Defs = json.defs ?? {};
  const resolve = makeResolver(defs);
  // dark variants only; tfm is a dark-terminal app. Values are either flat
  // strings ("primary": "purple") or {dark, light} objects.
  const slot = (key: string): string | null => {
    const v = json.theme?.[key];
    if (typeof v === "string") return resolve(v);
    return resolve((v as Variant)?.dark);
  };

  const bg = slot("background");
  const fg = slot("text");
  const muted = slot("textMuted");
  const accent = slot("primary");
  const borderSubtle = slot("borderSubtle");
  const border = slot("border");
  if (!bg || !fg || !muted || !accent || !(borderSubtle ?? border)) {
    // e.g. lucent-orng is built around a transparent terminal background,
    // which an opaque file-manager grid cannot honor — drop it
    console.warn(`skipping ${slug}: no usable dark background`);
    continue;
  }
  // some themes ship "transparent" panels/elements — fall back to derived shades
  const panel = slot("backgroundPanel") ?? bg;
  const element = slot("backgroundElement") ?? mixHex(bg, accent, 0.18);

  // tfm requires opaque #rrggbb everywhere; composite alpha hex onto bg
  const opaque = (hex: string): string => {
    const m = hex.match(/^#[0-9a-fA-F]{8}$/);
    if (!m) return hex;
    const n = parseInt(m[0].slice(1), 16);
    const rgb = `#${(n >>> 8).toString(16).padStart(6, "0")}`;
    return mixHex(bg, rgb, (n & 255) / 255);
  };

  // key order MUST match defaultConfig.theme exactly — settings compares
  // presets to the live theme via JSON.stringify
  const raw = {
    bg,
    sidebarBg: panel,
    sidebarFg: fg,
    sidebarFgMuted: muted,
    accent,
    accentBg: element,
    hoverBg: mixHex(bg, fg, 0.1),
    border: (borderSubtle ?? border)!,
    divider: (borderSubtle ?? border)!,
    white: fg,
    // opencode assets carry per-theme syntax palettes; tokyo-night hues as
    // fallback keep old/partial assets working
    syntaxString: slot("syntaxString") ?? "#9ece6a",
    syntaxNumber: slot("syntaxNumber") ?? "#ff9e64",
    syntaxType: slot("syntaxType") ?? "#2ac3de",
    syntaxFunction: slot("syntaxFunction") ?? "#7aa2f7",
    syntaxOperator: slot("syntaxOperator") ?? "#89ddff",
    syntaxProperty: slot("syntaxProperty") ?? "#73daca",
  };
  // ANSI 0-15 for the embedded terminal (OSC 4): derived from semantic slots
  // where assets have them, tokyo-night hues as fallback. Brights mix toward
  // fg so they stay on-palette.
  const dull: string[] = [
    panel,
    slot("error") ?? "#f7768e",
    slot("success") ?? slot("diffAdded") ?? "#9ece6a",
    slot("warning") ?? "#e0af68",
    accent,
    slot("secondary") ?? "#bb9af7",
    slot("syntaxType") ?? "#2ac3de",
    fg,
    muted,
  ];
  const bright = (i: number): string => mixHex(dull[i] ?? fg, fg, 0.3);
  const rawAny = raw as Record<string, string>;
  for (let i = 0; i < 16; i++) {
    const base = i < 9 ? dull[i] ?? fg : i === 15 ? fg : bright(i - 7);
    rawAny[`ansi${i}`] = base;
  }
  entries.push({
    file: slug,
    name,
    theme: Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, opaque(v)])) as Record<string, string>,
  });
}

entries.sort((a, b) => {
  if (a.file === "opencode") return -1;
  if (b.file === "opencode") return 1;
  return a.name.localeCompare(b.name);
});

const body = entries
  .map((e) => `  { name: ${JSON.stringify(e.name)}, theme: ${JSON.stringify(e.theme)} },`)
  .join("\n");

const out = `// Generated by scripts/gen-themes.ts from opencode's TUI theme assets
// (packages/tui/src/theme/assets). Dark variants only. Do not edit by hand;
// regenerate instead: bun scripts/gen-themes.ts <assets-dir>
import { defaultConfig, type Theme } from "./config";

export type ThemePreset = { name: string; theme: Theme };

export const THEME_PRESETS: ThemePreset[] = [
  // the tfm default palette (tokyo night flavored) stays first so a fresh
  // install matches a preset exactly and the cycle row does not say "custom"
  { name: "Tokyo Night", theme: defaultConfig.theme },
${body}
];
`;

writeFileSync(OUT, out);
console.log(`wrote ${OUT} with ${entries.length + 1} presets`);
