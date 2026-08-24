import { ASCIIFont, Box, ImageRenderable, Input, ScrollBoxRenderable, Text, createCliRenderer } from "@opentui/core";
import { execFile, spawn } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

// --- Color palette (Tokyo Night) ---
const colors = {
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
};

// --- Nerd Font glyphs: FALLBACK ONLY ---
const glyph = {
  home: "\u{F02DC}",
  star: "\u{F04CE}",
  clock: "\u{F0954}",
  bookmark: "\u{F00C6}",
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
type IconState = { fg: string; bg: string };
type IconSpec = {
  slotId: string;
  name: string;
  heightCells: number;
  states: IconState[];
  initialState: number;
  done?: boolean;
};

const iconQueue: IconSpec[] = [];
let iconSeq = 0;

const makeIconSlot = (
  name: string,
  states: IconState[],
  heightCells = 1,
  initialState = 0,
  onMouseDown?: () => void,
): { el: ReturnType<typeof Box>; slotId: string; spec: IconSpec } => {
  const slotId = `tfm-icon-${iconSeq++}`;
  const g = glyph[name as keyof typeof glyph] ?? "\u{FFFD}";
  const spec: IconSpec = { slotId, name, heightCells, states, initialState };
  iconQueue.push(spec);
  return {
    el: Box(
      {
        id: slotId,
        width: Math.round(heightCells * 2),
        height: heightCells,
        ...(onMouseDown ? { onMouseDown } : {}),
      },
      Text({ id: `${slotId}-g`, content: g, fg: states[initialState]?.fg ?? states[0]?.fg }),
    ),
    slotId,
    spec,
  };
};

const setIconState = (spec: IconSpec | undefined, stateIdx: number): boolean => {
  if (!spec) return false;
  spec.initialState = stateIdx;
  const slot: any = renderer.root.findDescendantById(spec.slotId);
  if (!slot) return false;
  const kids = slot.getChildren?.() ?? [];
  const stateImgs = kids.filter((k: any) => typeof k.id === "string" && k.id.startsWith(`${spec.slotId}-s`) && k.id !== `${spec.slotId}-g`);
  if (stateImgs.length === 0) {
    const glyphNode: any = kids.find((k: any) => k.id === `${spec.slotId}-g`);
    if (glyphNode) {
      try { glyphNode.fg = spec.states[stateIdx]?.fg; } catch {}
    }
    return false;
  }
  stateImgs.forEach((k: any, i: number) => { try { k.visible = i === stateIdx; } catch {} });
  return true;
};

// --- App state & history ---
const home = os.homedir();

type AppState = {
  cwd: string;
  history: string[];
  histIdx: number;
  showHidden: boolean;
};

const state: AppState = {
  cwd: process.cwd(),
  history: [process.cwd()],
  histIdx: 0,
  showHidden: false,
};

let renderAll: () => void = () => {};

const canBack = () => state.histIdx > 0;
const canFwd = () => state.histIdx < state.history.length - 1;

const goBack = () => { if (canBack()) { state.histIdx--; renderAll(); } };
const goFwd = () => { if (canFwd()) { state.histIdx++; renderAll(); } };

const navigate = (dir: string) => {
  let target: string;
  try {
    target = path.resolve(dir);
    if (!statSync(target).isDirectory()) return;
  } catch {
    return;
  }
  if (target === path.resolve(state.cwd)) { renderAll(); return; }
  state.history = state.history.slice(0, state.histIdx + 1);
  state.history.push(target);
  state.histIdx++;
  renderAll();
};

// --- System places sources (Nautilus-style: nothing hardcoded) ---

type Place = { icon: string; label: string; path: string | null; ejectable: boolean; device?: string };

type UserDir = { key: string; label: string; p: string };

async function loadSystemPlaces(): Promise<void> {
  sysUserDirs = await readUserDirs();
  sysBookmarks = await readBookmarks();
  sysMounts = await listMounts();
}

let sysUserDirs: UserDir[] = [];
let sysBookmarks: { p: string; label: string }[] = [];
let sysMounts: { label: string; target: string; removable: boolean; device: string }[] = [];

const xdgUserDirsFile = () =>
  path.join(process.env.XDG_CONFIG_HOME ?? path.join(home, ".config"), "user-dirs.dirs");

const XDG_LABELS: Record<string, string> = {
  XDG_DESKTOP_DIR: "Desktop",
  XDG_DOWNLOAD_DIR: "Downloads",
  XDG_DOCUMENTS_DIR: "Documents",
  XDG_MUSIC_DIR: "Music",
  XDG_PICTURES_DIR: "Pictures",
  XDG_VIDEOS_DIR: "Videos",
};

const expandXdgValue = (raw: string): string => {
  const v = raw.trim().replace(/^"(.*)"$/, "$1");
  return v.replace(/^\$HOME/, home).replace(/^~/, home);
};

async function readUserDirs(): Promise<UserDir[]> {
  try {
    const text = await readFile(xdgUserDirsFile(), "utf8");
    const out: UserDir[] = [];
    for (const line of text.split("\n")) {
      const m = line.match(/^(XDG_[A-Z_]+_DIR)\s*=\s*(.+)$/);
      if (!m || !m[1] || !m[2]) continue;
      const label = XDG_LABELS[m[1]];
      if (!label) continue;
      const p = expandXdgValue(m[2]!);
      // XDG rule (and nautilus): pointing at $HOME disables the entry
      if (!p || p === home) continue;
      try {
        if (!statSync(p).isDirectory()) continue;
      } catch { continue; }
      out.push({ key: m[1], label, p });
    }
    return out.sort((a, b) => (a.key < b.key ? -1 : 1));
  } catch {
    return [];
  }
}

async function readBookmarks(): Promise<{ p: string; label: string }[]> {
  try {
    const file = path.join(process.env.XDG_CONFIG_HOME ?? path.join(home, ".config"), "gtk-3.0", "bookmarks");
    const text = await readFile(file, "utf8");
    const out: { p: string; label: string }[] = [];
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      const sp = line.indexOf(" ");
      const uri = sp === -1 ? line : line.slice(0, sp);
      const label = sp === -1 ? "" : line.slice(sp + 1).trim();
      if (!uri.startsWith("file://")) continue;
      let p: string;
      try { p = decodeURIComponent(uri.slice("file://".length)); } catch { continue; }
      try { if (!statSync(p).isDirectory()) continue; } catch { continue; }
      out.push({ p, label: label || path.basename(p) });
    }
    return out;
  } catch {
    return [];
  }
}

const PSEUDO_FSTYPES = new Set(["squashfs", "tmpfs", "devtmpfs", "proc", "sysfs", "efivarfs", "overlay", "ramfs", "devfs", "cgroup"]);
const SYSTEM_MOUNTS = new Set(["/", "/boot", "/boot/efi", "/efi", "/swap"]);

function parseLsblk(json: any): { label: string; target: string; removable: boolean; device: string }[] {
  const out: { label: string; target: string; removable: boolean; device: string }[] = [];
  const visit = (nodes: any[], parentRm: boolean) => {
    if (!Array.isArray(nodes)) return;
    for (const n of nodes) {
      const name: string = n?.name ?? "";
      const rm = !!n?.rm || parentRm;
      if (/^(loop|zram|ram\d+)/.test(name)) {
        if (Array.isArray(n?.children)) visit(n.children, rm);
        continue;
      }
      if (!name.startsWith("loop")) {
        let mps: string[] = [];
        if (Array.isArray(n?.mountpoints)) {
          mps = n.mountpoints.map((m: any) => (typeof m === "string" ? m : m?.mountpoint)).filter(Boolean);
        } else if (typeof n?.mountpoint === "string") {
          mps = [n.mountpoint];
        }
        for (const target of mps) {
          if (!target || target.startsWith("[")) continue;
          if (SYSTEM_MOUNTS.has(target)) continue;
          if (target.startsWith("/snap") || target.startsWith("/var/lib/docker")) continue;
          if (n?.fstype && PSEUDO_FSTYPES.has(n.fstype)) continue;
          const label = n?.label || path.basename(target) || name;
          const device = n?.path ?? `/dev/${name}`;
          if (!out.some((o) => o.target === target)) out.push({ label, target, removable: rm, device });
        }
      }
      if (Array.isArray(n?.children)) visit(n.children, rm);
    }
  };
  visit(json?.blockdevices ?? [], false);
  return out;
}

async function listMounts(): Promise<{ label: string; target: string; removable: boolean; device: string }[]> {
  try {
    const { stdout } = await execFileP("lsblk", ["-J", "-o", "NAME,PATH,RM,LABEL,FSTYPE,MOUNTPOINTS,MOUNTPOINT"]);
    return parseLsblk(JSON.parse(stdout));
  } catch {
    return [];
  }
}

function buildSections(): Place[][] {
  const trashDir = path.join(home, ".local/share/Trash/files");
  const hasTrash = (() => { try { return statSync(trashDir).isDirectory(); } catch { return false; } })();

  const defaults: Place[] = [{ icon: "home", label: "Home", path: home, ejectable: false }];
  defaults.push({ icon: "clock", label: "Recent", path: null, ejectable: false });
  defaults.push({ icon: "star", label: "Starred", path: null, ejectable: false });
  if (hasTrash) defaults.push({ icon: "trash-can", label: "Trash", path: trashDir, ejectable: false });

  const dirs: Place[] = sysUserDirs.map((d) => ({ icon: "folder", label: d.label, path: d.p, ejectable: false }));

  const bookmarks: Place[] = sysBookmarks.map((b) => ({ icon: "bookmark", label: b.label, path: b.p, ejectable: false }));

  const devices: Place[] = [
    { icon: "harddisk", label: "This Device", path: "/", ejectable: false },
    ...sysMounts.map((m): Place => ({
      icon: m.removable ? "usb" : "harddisk",
      label: m.label,
      path: m.target,
      ejectable: m.removable,
      device: m.device,
    })),
  ];

  const groups = [defaults];
  if (dirs.length) groups.push(dirs);
  if (bookmarks.length) groups.push(bookmarks);
  groups.push(devices);
  return groups;
}

// --- Places sidebar (rebuilt from scratch on every render, selection = cwd) ---

const placesHost: { row: ReturnType<typeof Box> }[] = [];

const sw = 26;

const makeRow = (place: Place): ReturnType<typeof Box> => {
  const idx = placesHost.length;
  const selected = !!place.path && path.resolve(place.path) === path.resolve(state.cwd);
  const normFg = colors.sidebarFg;
  const selFg = colors.accent;
  const iconStates: IconState[] = [
    { fg: normFg, bg: colors.sidebarBg },
    { fg: selFg, bg: colors.accentBg },
  ];
  const maxLabel = sw - 4 - (place.ejectable ? 3 : 0);
  const paddedLabel = place.label.padEnd(Math.max(0, maxLabel)).slice(0, maxLabel);

  const iconSlot = makeIconSlot(place.icon, iconStates, 1, selected ? 1 : 0);
  const row = Box(
    {
      id: `tfm-place-${idx}`,
      width: sw,
      height: 1,
      flexDirection: "row",
      columnGap: 1,
      paddingLeft: 1,
      backgroundColor: selected ? colors.accentBg : colors.sidebarBg,
      onMouseDown: () => { if (place.path) navigate(place.path); },
    },
    iconSlot.el,
  );
  const labelText: any = Text({
    id: `tfm-place-${idx}-label`,
    content: paddedLabel,
    fg: selected ? selFg : normFg,
  });
  row.add(labelText);
  if (place.ejectable && place.device) {
    const ejectSlot = makeIconSlot(
      "eject",
      [{ fg: normFg, bg: colors.sidebarBg }, { fg: selFg, bg: colors.accentBg }],
      1,
      selected ? 1 : 0,
      () => ejectDevice(place.device!),
    );
    row.add(ejectSlot.el);
  }
  placesHost.push({ row });
  return row;
};

const ejectDevice = (device: string) => {
  spawn("udisksctl", ["unmount", "-b", device], { stdio: "ignore" });
  setTimeout(() => { void loadSystemPlaces().then(() => renderAll()); }, 1500);
};

const renderSidebar = () => {
  const hostBox: any = renderer.root.findDescendantById("tfm-places");
  if (!hostBox) return;
  [...hostBox.getChildren()].forEach((c: any) => hostBox.remove(c));
  placesHost.length = 0;

  const groups = buildSections();
  groups.forEach((group, gi) => {
    for (const place of group) hostBox.add(makeRow(place));
    if (gi < groups.length - 1) hostBox.add(makeDivider());
  });
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

// --- Toolbar ---

const navSpecs: Record<"tfm-nav-back" | "tfm-nav-fwd", IconSpec | undefined> = {
  "tfm-nav-back": undefined,
  "tfm-nav-fwd": undefined,
};

const makeNavButton = (id: "tfm-nav-back" | "tfm-nav-fwd", iconName: string, onActivate: () => void) => {
  const slot = makeIconSlot(
    iconName,
    [
      { fg: colors.sidebarFg, bg: colors.bg },
      { fg: colors.sidebarFgMuted, bg: colors.bg },
    ],
    1,
    0,
  );
  navSpecs[id] = slot.spec;
  return Box(
    { id, height: 1, width: 3, justifyContent: "center", onMouseDown: onActivate },
    slot.el,
  );
};

const refreshNav = () => {
  const setBtn = (spec: IconSpec | undefined, on: boolean) => setIconState(spec, on ? 0 : 1);
  setBtn(navSpecs["tfm-nav-back"], canBack());
  setBtn(navSpecs["tfm-nav-fwd"], canFwd());
};

const crumbSep = () => Text({ content: " › ", fg: colors.sidebarFgMuted });

const renderCrumbs = () => {
  const box: any = renderer.root.findDescendantById("tfm-crumbs");
  if (!box) return;
  [...box.getChildren()].forEach((c: any) => box.remove(c));

  const cwdAbs = path.resolve(state.cwd);
  const inHome = cwdAbs === home || cwdAbs.startsWith(home + path.sep);
  const baseLabel = inHome ? "Home" : os.hostname();
  const baseIcon = inHome ? "home" : "desktop-tower";
  const basePath = inHome ? home : "/";
  const rest = path.relative(inHome ? home : "/", cwdAbs).split(path.sep).filter(Boolean);

  const crumbs: { label: string; icon?: string; target: string }[] = [
    { label: baseLabel, icon: baseIcon, target: basePath },
    ...rest.map((seg, i) => ({ label: seg, target: path.join(basePath, ...rest.slice(0, i + 1)) })),
  ];

  crumbs.forEach((c, i) => {
    const current = i === crumbs.length - 1;
    const fg = current ? colors.white : colors.sidebarFgMuted;
    const crumb = Box(
      {
        height: 1,
        flexDirection: "row",
        alignItems: "center",
        columnGap: 1,
        ...(current ? {} : { onMouseDown: () => navigate(c.target) }),
      },
      ...(c.icon ? [makeIconSlot(c.icon, [{ fg, bg: colors.bg }], 1).el] : []),
      Text({ content: c.label, fg }),
    );
    box.add(crumb);
    if (i < crumbs.length - 1) box.add(crumbSep());
  });
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
    {
      id: "tfm-search-btn",
      height: 1,
      width: 3,
      justifyContent: "center",
      onMouseDown: () => {
        const el: any = renderer.root.findDescendantById("tfm-search");
        if (!el) return;
        el.visible = !el.visible;
        if (el.visible) el.focus();
      },
    },
    makeIconSlot("search", [{ fg: colors.sidebarFg, bg: colors.bg }], 1).el,
  );

  wrap.add(button);
  wrap.add(input);
  return wrap;
};

const makeToolbarShell = (): ReturnType<typeof Box> =>
  Box(
    { width: "100%", height: 1, flexDirection: "row", paddingLeft: 1, paddingRight: 1, columnGap: 1 },
    Box(
      { height: 1, flexGrow: 1, flexBasis: 0, overflow: "hidden", flexDirection: "row", columnGap: 1 },
      makeNavButton("tfm-nav-back", "chevron-left", goBack),
      makeNavButton("tfm-nav-fwd", "chevron-right", goFwd),
      Box({ id: "tfm-crumbs", height: 1, flexDirection: "row", columnGap: 1 }),
    ),
    makeSearch(),
  );

// --- Directory listing ---
type Entry = { name: string; isDir: boolean };

async function listDir(dir: string, showHidden: boolean): Promise<Entry[]> {
  const dirents = await readdir(dir, { withFileTypes: true });
  return dirents
    .filter((d) => showHidden || !d.name.startsWith("."))
    .map((d) => ({ name: d.name, isDir: d.isDirectory() }))
    .sort((a, b) => Number(b.isDir) - Number(a.isDir) || a.name.localeCompare(b.name));
}

// --- Layout ---
const container = Box(
  { width: "100%", height: "100%", flexDirection: "row" },
  Box(
    { width: sw, height: "100%", backgroundColor: colors.sidebarBg, flexDirection: "column" },
    makeTitle(),
    Box({ id: "tfm-places", width: sw, flexDirection: "column" }),
  ),
  Box(
    { flexGrow: 1, height: "100%", backgroundColor: colors.bg, flexDirection: "column" },
    makeToolbarShell(),
    Box({ id: "tfm-grid-host", flexGrow: 1, width: "100%", flexDirection: "column" }),
    Box(
      { id: "tfm-status", width: "100%", height: 1, flexDirection: "row", paddingLeft: 1, paddingRight: 1 },
      Text({ id: "tfm-status-label", content: "", fg: colors.sidebarFgMuted }),
    ),
  ),
);

// --- Renderer boot ---
const renderer = await createCliRenderer({ exitOnCtrlC: true });
renderer.root.add(container);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const waitForResolution = async () => {
  for (let i = 0; i < 40 && !renderer.resolution; i++) await sleep(50);
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

const rasterStatesInto = async (slotId: string, name: string, states: IconState[], heightCells: number, wCells: number, initial: number) => {
  const { cellW, cellH } = cellMetrics();
  const imgs: any[] = [];
  for (let si = 0; si < states.length; si++) {
    try {
      const st = states[si]!;
      const bytes = await iconPng(
        name,
        st.fg,
        st.bg,
        Math.max(1, Math.round(wCells * cellW)),
        Math.max(1, Math.round(heightCells * cellH)),
      );
      const img = new ImageRenderable(renderer, {
        id: `${slotId}-s${si}`,
        source: bytes,
        width: wCells,
        height: heightCells,
        fit: "fit",
        protocol: "auto",
      });
      await img.loadPromise!;
      img.visible = si === initial;
      imgs.push(img);
    } catch {}
  }
  return imgs;
};

const drainIconQueue = async () => {
  if (!renderer.resolution) return;
  const aspect = cellMetrics().aspect;
  const pending = iconQueue.filter((s) => !s.done);
  await Promise.all(pending.map(async (spec) => {
    spec.done = true;
    const slot: any = renderer.root.findDescendantById(spec.slotId);
    if (!slot) return;
    const wCells = Math.max(1, Math.round(spec.heightCells * aspect));
    const imgs = await rasterStatesInto(spec.slotId, spec.name, spec.states, spec.heightCells, wCells, spec.initialState);
    if (imgs.length === 0) return;
    slot.width = wCells;
    const kids = slot.getChildren?.() ?? [];
    const glyphNode: any = kids.find((k: any) => typeof k.id === "string" && k.id.endsWith("-g"));
    if (glyphNode) slot.remove(glyphNode);
    imgs.forEach((im) => slot.add(im));
  }));
};

// --- Grid (scrollable, culled, interactive) ---
const TILE_W = 20;
const TILE_H = 5;
const ICON_CELLS_H = 3;

let scroller: ScrollBoxRenderable | null = null;
let gridGen = 0;

type TileRefs = { iconSpec?: IconSpec; labelText: any; selected: boolean };
const tileRefsByKey = new Map<string, TileRefs>();

const tileStates = (): IconState[] => [
  { fg: colors.sidebarFg, bg: colors.bg },
  { fg: colors.sidebarFg, bg: colors.hoverBg },
  { fg: colors.accent, bg: colors.accentBg },
];

const setTileVisual = (key: string, mode: 0 | 1 | 2) => {
  const refs = tileRefsByKey.get(key);
  if (!refs) return;
  setIconState(refs.iconSpec, mode);
  try { refs.labelText.fg = mode === 2 ? colors.accent : colors.sidebarFg; } catch {}
};

const clearGrid = () => {
  if (!scroller) return;
  const content: any = scroller.content;
  [...content.getChildren()].forEach((c: any) => content.remove(c));
  tileRefsByKey.clear();
};

const renderGrid = async () => {
  if (!scroller) return;
  const gen = ++gridGen;
  clearGrid();
  const entries = await listDir(state.cwd, state.showHidden);
  if (gen !== gridGen) return;

  const status: any = renderer.root.findDescendantById("tfm-status-label");
  const shortCwd = state.cwd.startsWith(home) ? "~" + state.cwd.slice(home.length) : state.cwd;
  if (status) status.content = `${entries.length} item${entries.length === 1 ? "" : "s"}  ·  ${shortCwd}${state.showHidden ? "  ·  hidden" : ""}`;

  if (entries.length === 0) {
    scroller.content.add(Text({ content: " empty folder", fg: colors.sidebarFgMuted }));
    return;
  }

  await waitForResolution();
  if (gen !== gridGen) return;
  const { aspect } = cellMetrics();
  const cols = Math.max(1, Math.floor((renderer.terminalWidth - sw - 3) / TILE_W));

  const buildTile = (e: Entry) => {
    const key = path.join(state.cwd, e.name);
    let lastClick = 0;
    const tile = Box({
      width: TILE_W,
      height: TILE_H,
      flexDirection: "column",
      alignItems: "center",
      justifyContent: "flex-start",
      onMouseDown: () => {
        const now = Date.now();
        if (now - lastClick < 400) {
          if (e.isDir) navigate(key);
          lastClick = 0;
          return;
        }
        lastClick = now;
        tileRefsByKey.forEach((refs, k) => {
          if (refs.selected) { refs.selected = false; setTileVisual(k, 0); }
        });
        const refs = tileRefsByKey.get(key);
        if (refs) { refs.selected = true; setTileVisual(key, 2); }
      },
      onMouseOver: () => {
        const refs = tileRefsByKey.get(key);
        if (!refs?.selected) setTileVisual(key, 1);
      },
      onMouseOut: () => {
        const refs = tileRefsByKey.get(key);
        if (!refs?.selected) setTileVisual(key, 0);
      },
    });

    const slotW = Math.max(1, Math.round(aspect * ICON_CELLS_H));
    const iconSlot = makeIconSlot(e.isDir ? "folder" : "file", tileStates(), ICON_CELLS_H, 0);
    const tileBox = Box({ width: slotW, height: ICON_CELLS_H, flexDirection: "row", justifyContent: "center" }, iconSlot.el);
    tile.add(tileBox);

    const label = e.name.length > TILE_W - 2 ? e.name.slice(0, TILE_W - 5) + "…" : e.name;
    const labelText: any = Text({ content: label, fg: colors.sidebarFg });
    tile.add(labelText);

    tileRefsByKey.set(key, { iconSpec: iconSlot.spec, labelText, selected: false });

    return tile;
  };

  for (let i = 0; i < entries.length; i += cols) {
    const row = Box({ height: TILE_H, flexDirection: "row" });
    for (const e of entries.slice(i, i + cols)) row.add(buildTile(e));
    scroller.content.add(row);
  }

  void drainIconQueue();
};

// --- Orchestration ---
renderAll = () => {
  state.cwd = state.history[state.histIdx] ?? state.cwd;
  refreshNav();
  renderCrumbs();
  renderSidebar();
  void drainIconQueue();
  void renderGrid();
};

const boot = async () => {
  await waitForResolution();
  scroller = new ScrollBoxRenderable(renderer, {
    id: "tfm-scroll",
    flexGrow: 1,
    width: "100%",
    scrollY: true,
    viewportCulling: true,
    contentOptions: { flexDirection: "column" },
  });
  const host: any = renderer.root.findDescendantById("tfm-grid-host");
  host.add(scroller);
  await loadSystemPlaces();
  renderAll();
};
boot();

// --- Keyboard ---
renderer.keyInput.on("keypress", (e: any) => {
  const el: any = renderer.root.findDescendantById("tfm-search");
  if (el?.visible && (e.name === "escape" || e.name === "return")) {
    el.visible = false;
    return;
  }
  const ctrl = !!e.ctrl || !!e.control;
  if (ctrl && (e.name === "h" || e.unicode === "h")) {
    state.showHidden = !state.showHidden;
    renderGrid();
  }
  if (ctrl && (e.name === "r" || e.unicode === "r")) {
    void loadSystemPlaces().then(() => renderAll());
  }
});
