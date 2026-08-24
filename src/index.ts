import { ASCIIFont, Box, ImageRenderable, Input, Text, createCliRenderer } from "@opentui/core";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// --- Color palette (Tokyo Night) ---
const colors = {
  bg: "#1a1b26",          // bg
  sidebarBg: "#16161e",   // bg_dark
  sidebarFg: "#c0caf5",   // fg
  sidebarFgMuted: "#565f89", // comment
  accent: "#7aa2f7",      // blue
  accentBg: "#292e42",    // bg_highlight
  border: "#292e42",      // bg_highlight
  divider: "#292e42",
  white: "#c0caf5",       // fg
};

// --- Nerd Font glyphs: FALLBACK ONLY, shown when a raster icon can't load ---
const glyph = {
  home: "\u{F02DC}",
  star: "\u{F04CE}",
  clock: "\u{F0954}",
  "trash-can": "\u{F0A79}",
  folder: "\u{F024B}",
  harddisk: "\u{F02CA}",
  usb: "\u{F0553}",
  eject: "\u{F01EA}",
  search: "\u{F002}",
  file: "\u{F0214}",
  "chevron-left": "\u{F0141}",
  "chevron-right": "\u{F0142}",
  "desktop-tower": "\u{F01C5}",
};

// --- Icon slots ---
// Every icon lives in a fixed-size slot holding a fallback glyph; after boot,
// applyRasterIcons() swaps each for an ImageRenderable. Any failure (no
// resolution, missing rsvg-convert, bad load) leaves the glyph in place.
type IconSpec = {
  slotId: string;
  name: string;
  fallbackGlyph: string;
  fg: string;
  bg: string;
  heightCells: number;
};

const iconQueue: IconSpec[] = [];
let iconSeq = 0;

const makeIconSlot = (name: string, fg: string, bg: string, heightCells = 1): ReturnType<typeof Box> => {
  const slotId = `tfm-icon-${iconSeq++}`;
  const g = glyph[name as keyof typeof glyph] ?? "\u{FFFD}";
  iconQueue.push({ slotId, name, fallbackGlyph: g, fg, bg, heightCells });
  return Box(
    { id: slotId, width: Math.round(heightCells * 2), height: heightCells },
    Text({ id: `${slotId}-g`, content: g, fg }),
  );
};

const sections = [
  {
    items: [
      { icon: "home", label: "Home", ejectable: false },
      { icon: "star", label: "Starred", ejectable: false },
      { icon: "clock", label: "Recent", ejectable: false },
      { icon: "trash-can", label: "Trash", ejectable: false },
    ],
  },
  {
    items: [
      { icon: "folder", label: "Downloads", ejectable: false },
      { icon: "folder", label: "Documents", ejectable: false },
      { icon: "folder", label: "Pictures", ejectable: false },
      { icon: "folder", label: "Videos", ejectable: false },
      { icon: "folder", label: "Projects", ejectable: false },
      { icon: "folder", label: ".config", ejectable: false },
    ],
  },
  {
    items: [
      { icon: "harddisk", label: "This Device", ejectable: false },
      { icon: "usb", label: "USB Drive", ejectable: true },
      { icon: "usb", label: "SD Card", ejectable: true },
    ],
  },
];

const sw = 26;

let activeRenderer: any = null;

const makeRow = (iconName: string, label: string, ejectable: boolean, selected: boolean) => {
  const fg = selected ? colors.accent : colors.sidebarFg;
  const bg = selected ? colors.accentBg : colors.sidebarBg;
  const maxLabel = sw - 4 - (ejectable ? 3 : 0);
  const paddedLabel = label.padEnd(Math.max(0, maxLabel)).slice(0, maxLabel);
  return Box(
    { width: sw, height: 1, flexDirection: "row", columnGap: 1, paddingLeft: 1, backgroundColor: bg },
    makeIconSlot(iconName, fg, bg, 1),
    Text({ content: paddedLabel, fg }),
    ...(ejectable ? [makeIconSlot("eject", fg, bg, 1)] : []),
  );
};

const makeTitle = () =>
  Box(
    { width: sw, height: 5, flexDirection: "column", justifyContent: "center", paddingLeft: 1 },
    ASCIIFont({ text: "tfm", font: "tiny", color: colors.accent }),
    Text({ content: " terminal file manager", fg: colors.sidebarFgMuted }),
  );

const makeDivider = () =>
  Box(
    { width: sw, height: 1 },
    Text({ content: " " + "~".repeat(sw - 2), fg: colors.divider }),
  );

// --- Build sidebar ---
const children: ReturnType<typeof Box>[] = [makeTitle()];

let idx = 0;
for (const section of sections) {
  for (const item of section.items) {
    children.push(makeRow(item.icon, item.label, item.ejectable, idx === 0));
    idx++;
  }
  if (section !== sections[sections.length - 1]) children.push(makeDivider());
}

// --- Toolbar (breadcrumbs derived from cwd) ---

const makeNavButton = (iconName: string) =>
  Box(
    { height: 1, width: 3, justifyContent: "center" },
    makeIconSlot(iconName, colors.sidebarFg, colors.bg, 1),
  );

const makeCrumb = (label: string, iconName: string | undefined, current: boolean) => {
  const fg = current ? colors.white : colors.sidebarFgMuted;
  return Box(
    { height: 1, flexDirection: "row", alignItems: "center", columnGap: 1 },
    ...(iconName ? [makeIconSlot(iconName, fg, colors.bg, 1)] : []),
    Text({ content: label, fg }),
  );
};

const makeToolbar = (cwd: string) => {
  const home = os.homedir();
  const inHome = cwd === home || cwd.startsWith(home + path.sep);
  const base = inHome
    ? { label: "Home", icon: "home" }
    : { label: os.hostname(), icon: "desktop-tower" };
  const rest = path.relative(inHome ? home : path.sep, cwd).split(path.sep).filter(Boolean);
  const crumbs = [base, ...rest.map((label) => ({ label, icon: undefined }))];

  return Box(
    { width: "100%", height: 1, flexDirection: "row", paddingLeft: 1, paddingRight: 1, columnGap: 1 },
    Box(
      { height: 1, flexGrow: 1, flexBasis: 0, overflow: "hidden", flexDirection: "row", columnGap: 1 },
      makeNavButton("chevron-left"),
      makeNavButton("chevron-right"),
      ...crumbs.flatMap((c, i) =>
        i === 0 ? [makeCrumb(c.label, c.icon, i === crumbs.length - 1)] : [
          Text({ content: " › ", fg: colors.sidebarFgMuted }),
          makeCrumb(c.label, c.icon, i === crumbs.length - 1),
        ]
      ),
    ),
    makeSearch(),
  );
};

const makeSearch = () => {
  const wrap = Box({ height: 1, flexDirection: "row" });

  const input = Input({
    id: "tfm-search",
    width: 16,
    visible: false,
    placeholder: "Search",
    backgroundColor: colors.accentBg,
    focusedBackgroundColor: colors.accentBg,
    textColor: colors.white,
  });

  const button = Box(
    { id: "tfm-search-btn", height: 1, width: 3, justifyContent: "center", onMouseDown: () => {
      const el: any = activeRenderer?.root.findDescendantById("tfm-search");
      if (!el) return;
      el.visible = !el.visible;
      if (el.visible) el.focus();
    }},
    makeIconSlot("search", colors.sidebarFg, colors.bg, 1),
  );

  wrap.add(button);
  wrap.add(input);
  return wrap;
};

// --- Real directory listing ---

type Entry = { name: string; isDir: boolean };

async function listDir(dir: string): Promise<Entry[]> {
  const dirents = await readdir(dir, { withFileTypes: true });
  return dirents
    .map((d) => ({ name: d.name, isDir: d.isDirectory() }))
    .sort((a, b) => Number(b.isDir) - Number(a.isDir) || a.name.localeCompare(b.name));
}

const cwd = process.cwd();

// --- Layout ---
const container = Box(
  { width: "100%", height: "100%", flexDirection: "row" },
  Box({ width: sw, height: "100%", backgroundColor: colors.sidebarBg, flexDirection: "column" }, ...children),
  Box(
    { flexGrow: 1, height: "100%", backgroundColor: colors.bg, flexDirection: "column" },
    makeToolbar(cwd),
    Box({ id: "tfm-files", flexGrow: 1, width: "100%", flexDirection: "column" }),
  ),
);

const renderer = await createCliRenderer({ exitOnCtrlC: true });
activeRenderer = renderer;
renderer.root.add(container);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const waitForResolution = async () => {
  for (let i = 0; i < 40 && !renderer.resolution; i++) {
    await sleep(50);
  }
};

const cellMetrics = () => {
  const res = renderer.resolution;
  const cellW = res ? res.width / renderer.terminalWidth : 10;
  const cellH = res ? res.height / renderer.terminalHeight : 20;
  return { cellW, cellH, aspect: cellH > 0 ? cellH / cellW : 2 };
};

// --- Runtime SVG pipeline: tint + rasterize at exact cell pixels, cached, async ---
const iconCache = new Map<string, Uint8Array>();

const rasterizeSvg = (name: string, fg: string, bg: string, pxW: number, pxH: number) =>
  new Promise<Uint8Array>((resolve, reject) => {
    let svg: string;
    try {
      svg = readFileSync(`${import.meta.dir}/../assets/icons/${name}.svg`, "utf8");
    } catch (err) {
      return reject(err);
    }
    // single-color sources: retint hex fills; inject a fill if the source has none
    const tinted = /#[0-9a-fA-F]{6}/.test(svg)
      ? svg.replace(/#[0-9a-fA-F]{6}/g, fg)
      : svg.replace(/<svg\b/, `<svg fill="${fg}"`);

    const proc = spawn("rsvg-convert", ["--background-color", bg, "-w", String(pxW), "-h", String(pxH)]);
    const chunks: Buffer[] = [];
    proc.stdout.on("data", (c: Buffer) => chunks.push(c));
    proc.on("error", reject);
    proc.on("close", (code) =>
      code === 0 && chunks.length > 0
        ? resolve(new Uint8Array(Buffer.concat(chunks)))
        : reject(new Error(`rsvg-convert exited ${code}`))
    );
    proc.stdin.end(tinted);
  });

const iconPng = async (name: string, fg: string, bg: string, pxW: number, pxH: number): Promise<Uint8Array> => {
  const key = `${name}:${fg}:${bg}:${pxW}x${pxH}`;
  const hit = iconCache.get(key);
  if (hit) return hit;
  const bytes = await rasterizeSvg(name, fg, bg, pxW, pxH);
  iconCache.set(key, bytes);
  return bytes;
};

// Swap every queued slot's glyph for its raster; on any failure keep the glyph.
const applyRasterIcons = async () => {
  await waitForResolution();
  if (!renderer.resolution) return;
  await Promise.all(iconQueue.map(async (spec) => {
    const slot: any = renderer.root.findDescendantById(spec.slotId);
    if (!slot) return;
    const wCells = Math.max(1, Math.round(spec.heightCells * cellMetrics().aspect));
    try {
      const bytes = await iconPng(
        spec.name,
        spec.fg,
        spec.bg,
        Math.max(1, Math.round(wCells * cellMetrics().cellW)),
        Math.max(1, Math.round(spec.heightCells * cellMetrics().cellH)),
      );
      const img = new ImageRenderable(renderer, {
        id: `${spec.slotId}-img`,
        source: bytes,
        width: wCells,
        height: spec.heightCells,
        fit: "fit",
        protocol: "auto",
      });
      await img.loadPromise!;
      slot.width = wCells;
      const g: any = renderer.root.findDescendantById(`${spec.slotId}-g`);
      if (g) slot.remove(g);
      slot.add(img);
    } catch {}
  }));
};

applyRasterIcons();

const TILE_W = 20;
const TILE_H = 5;
const ICON_CELLS_H = 3;

const buildGrid = async () => {
  const pane: any = renderer.root.findDescendantById("tfm-files");
  if (!pane) return;
  await waitForResolution();
  const hasRes = !!renderer.resolution;
  const cols = Math.max(1, Math.floor((renderer.terminalWidth - sw - 2) / TILE_W));
  const entries = await listDir(cwd);

  for (let i = 0; i < entries.length; i += cols) {
    const row = Box({ height: TILE_H, flexDirection: "row" });
    for (const e of entries.slice(i, i + cols)) {
      const tile = Box({
        width: TILE_W,
        height: TILE_H,
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "flex-start",
      });

      const { aspect, cellW, cellH } = cellMetrics();
      const slotW = Math.max(1, Math.round(aspect * ICON_CELLS_H));
      const iconName = e.isDir ? "folder" : "file";
      const iconSlot = Box({
        width: slotW,
        height: ICON_CELLS_H,
        flexDirection: "row",
        justifyContent: "center",
      });
      tile.add(iconSlot);

      let placed = false;
      if (hasRes) {
        try {
          const bytes = await iconPng(
            iconName,
            colors.sidebarFg,
            colors.bg,
            Math.max(1, Math.round(slotW * cellW)),
            Math.max(1, Math.round(ICON_CELLS_H * cellH)),
          );
          const img = new ImageRenderable(renderer, {
            source: bytes,
            width: slotW,
            height: ICON_CELLS_H,
            fit: "fit",
            protocol: "auto",
          });
          await img.loadPromise!;
          iconSlot.add(img);
          placed = true;
        } catch {}
      }
      if (!placed) iconSlot.add(Text({ content: glyph[iconName as keyof typeof glyph], fg: colors.sidebarFg }));

      const label = e.name.length > TILE_W - 2 ? e.name.slice(0, TILE_W - 5) + "…" : e.name;
      tile.add(Text({ content: label, fg: colors.sidebarFg }));

      row.add(tile);
    }
    pane.add(row);
  }
};
buildGrid();

renderer.keyInput.on("keypress", (e) => {
  const el: any = renderer.root.findDescendantById("tfm-search");
  if (!el?.visible) return;
  if (e.name === "escape" || e.name === "return") {
    el.visible = false;
  }
});
