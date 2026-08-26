import { ASCIIFont, Box, CliRenderEvents, CodeRenderable, EmbeddedTerminalRenderable, ImageRenderable, Input, InputRenderable, RGBA, Renderable, ScrollBoxRenderable, SyntaxStyle, Text, addDefaultParsers, createCliRenderer } from "@opentui/core";
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, closeSync, createReadStream, createWriteStream, existsSync, openSync, readFileSync, readSync, statSync, watch } from "node:fs";
import { readdir, readFile, stat, lstat, readlink, symlink, rename as fsRename, mkdir, writeFile, chmod, cp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { loadConfig, configPath, saveConfig, defaultConfig, type Config, type Theme } from "./config";
import { THEME_PRESETS, type ThemePreset } from "./themes";

const execFileP = promisify(execFile);

// --- Debug mode (--debug / -d): writes a single event log + crash dump to
// /tmp/tfm-debug.log so testers paste one file instead of a screenshot. ---
const isDebug = process.argv.includes("--debug") || process.argv.includes("-d");
const DEBUG_LOG = "/tmp/tfm-debug.log";
const appendLog = (msg: string): void => {
  try { appendFileSync(DEBUG_LOG, `${new Date().toISOString()} ${msg}\n`); } catch {}
};
const debugLog = (msg: string): void => {
  if (!isDebug) return;
  appendLog(msg);
};

process.on("uncaughtException", (err) => {
  appendLog(`UNCAUGHT EXCEPTION: ${err?.stack ?? err}`);
  try { process.stderr.write(`[tfm] crash — see ${DEBUG_LOG}\n`); } catch {}
  process.exit(1);
});
process.on("unhandledRejection", (reason) => {
  appendLog(`UNHANDLED REJECTION: ${reason instanceof Error ? reason.stack : String(reason)}`);
});
if (isDebug) appendLog(`tfm starting pid=${process.pid} argv=[${process.argv.slice(1).join(" ")}]`);

// --- Config (TOML at ~/.config/tfm/config.toml, TFM_CONFIG overrides path) ---
const config = loadConfig();

// --- Color palette (theme from config; Tokyo Night defaults) ---
const colors: Theme & Record<string, string> = { ...config.theme };

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
  cog: "\u{F0493}",
  power: "\u{F0425}",
  eye: "\u{F0208}",
  "eye-off": "\u{F0209}",
  "content-copy": "\u{F018F}",
  "content-paste": "\u{F0192}",
  "content-cut": "\u{F0190}",
  information: "\u{F02FD}",
  pencil: "\u{F03EB}",
  "folder-plus": "\u{F0770}",
  "select-all": "\u{F0478}",
  sort: "\u{F04BA}",
  "checkbox-marked": "\u{F0132}",
  "checkbox-blank": "\u{F0131}",
  pause: "\u{F03E4}",
  play: "\u{F040A}",
  close: "\u{F0156}",
  terminal: "\u{F120}",
};

// --- File type categories (extension -> icon); generic `file` is the fallback,
// mirroring nautilus's themed-icon fallback chain in spirit ---
const FILE_ICON_BY_EXT: Record<string, string> = {
  js: "file-code", jsx: "file-code", mjs: "file-code", cjs: "file-code",
  ts: "file-code", tsx: "file-code", py: "file-code", rb: "file-code",
  rs: "file-code", go: "file-code", c: "file-code", h: "file-code",
  cpp: "file-code", cc: "file-code", hpp: "file-code", java: "file-code",
  kt: "file-code", swift: "file-code", cs: "file-code", php: "file-code",
  lua: "file-code", pl: "file-code", sh: "file-code", bash: "file-code",
  zsh: "file-code", fish: "file-code", ps1: "file-code", vue: "file-code",
  svelte: "file-code", html: "file-code", css: "file-code", scss: "file-code",
  sql: "file-code", json: "file-code", yaml: "file-code", yml: "file-code",
  toml: "file-code", xml: "file-code", ini: "file-code", conf: "file-code",
  zig: "file-code", nim: "file-code", ex: "file-code", exs: "file-code",
  hs: "file-code", ml: "file-code", r: "file-code", dart: "file-code",
  md: "file-document", markdown: "file-document", txt: "file-document",
  doc: "file-document", docx: "file-document", odt: "file-document",
  rtf: "file-document", log: "file-document", eps: "file-document",
  png: "file-image", jpg: "file-image", jpeg: "file-image", gif: "file-image",
  webp: "file-image", svg: "file-image", bmp: "file-image", ico: "file-image",
  tiff: "file-image", avif: "file-image", heic: "file-image", xcf: "file-image",
  mp4: "file-video", mkv: "file-video", avi: "file-video", mov: "file-video",
  webm: "file-video", wmv: "file-video", flv: "file-video", m4v: "file-video",
  mp3: "file-music", flac: "file-music", wav: "file-music", ogg: "file-music",
  oga: "file-music", m4a: "file-music", opus: "file-music", aac: "file-music",
  zip: "zip-box", tar: "zip-box", gz: "zip-box", bz2: "zip-box", xz: "zip-box",
  zst: "zip-box", "7z": "zip-box", rar: "zip-box", apk: "zip-box", jar: "zip-box",
  pdf: "file-pdf-box",
};

for (const cat of new Set(Object.values(FILE_ICON_BY_EXT))) {
  if (!(cat in glyph)) glyph[cat as keyof typeof glyph] = glyph.file;
}

// shared-mime-info database (same data nautilus's GIO consults): ext -> mime,
// highest-weight glob wins. Loaded once at boot; absent file degrades silently.
let globs2ByExt: Map<string, string> | null = null;
const globs2Weight = new Map<string, number>();

async function loadGlobs2(): Promise<void> {
  try {
    const text = await readFile("/usr/share/mime/globs2", "utf8");
    for (const line of text.split("\n")) {
      if (!line || line.startsWith("#")) continue;
      const parts = line.split(":");
      if (parts.length < 3 || !parts[0] || !parts[1] || !parts[2]) continue;
      const weight = parseInt(parts[0], 10);
      const mime = parts[1];
      const glob = parts[2];
      if (!Number.isFinite(weight) || !glob.startsWith("*.")) continue;
      const ext = glob.slice(2).toLowerCase();
      if (!ext || ext.includes("*") || ext.includes("?") || ext.includes("[")) continue;
      const prevW = globs2Weight.get(ext);
      if (prevW === undefined || weight > prevW) {
        globs2ByExt ??= new Map();
        globs2ByExt.set(ext, mime);
        globs2Weight.set(ext, weight);
      }
    }
  } catch {}
}

const ARCHIVE_MIMES = new Set([
  "application/zip", "application/gzip", "application/x-gzip", "application/bzip2",
  "application/x-bzip2", "application/x-xz", "application/x-7z-compressed",
  "application/vnd.rar", "application/x-rar-compressed", "application/zstd",
  "application/x-tar", "application/java-archive", "application/vnd.android.package-archive",
]);

const mimeCategory = (mime: string): string => {
  const media = mime.split("/")[0] ?? "";
  if (media === "image") return "file-image";
  if (media === "video") return "file-video";
  if (media === "audio") return "file-music";
  if (ARCHIVE_MIMES.has(mime)) return "zip-box";
  if (mime === "application/pdf") return "file-pdf-box";
  if (
    /^text\/x-/.test(mime) ||
    ["text/html", "text/css", "application/javascript", "application/json", "application/xml", "application/yaml"].includes(mime) ||
    mime.endsWith("+xml") || mime.endsWith("+json")
  ) return "file-code";
  if (media === "text" || /^(application\/msword|application\/rtf|application\/vnd\.oasis\.opendocument\.text)/.test(mime)) return "file-document";
  return "file";
};

const fileIconFor = (name: string): string => {
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return "file";
  const ext = name.slice(dot + 1).toLowerCase();
  return FILE_ICON_BY_EXT[ext]
    ?? (globs2ByExt?.get(ext) ? mimeCategory(globs2ByExt.get(ext)!) : undefined)
    ?? "file";
};

const fileIsImage = (name: string): boolean => {
  const dot = name.lastIndexOf(".");
  const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
  if (FILE_ICON_BY_EXT[ext] === "file-image") return true;
  const mime = globs2ByExt?.get(ext);
  return !!mime && mime.startsWith("image/");
};

// --- Icon slots ---
type IconState = { fg: string; bg: string };
type IconSpec = {
  slotId: string;
  name: string;
  heightCells: number;
  states: IconState[];
  // slots that survive renderAll rebuilds (nav/search/sort) must derive fresh
  // state colors on every re-raster, or a runtime theme swap leaves them stale
  statesFactory?: () => IconState[];
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
  statesFactory?: () => IconState[],
): { el: ReturnType<typeof Box>; slotId: string; spec: IconSpec } => {
  const slotId = `tfm-icon-${iconSeq++}`;
  const g = glyph[name as keyof typeof glyph] ?? "\u{FFFD}";
  const spec: IconSpec = { slotId, name, heightCells, states, initialState, ...(statesFactory ? { statesFactory } : {}) };
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
  sortBy: SortMode;
  sortAsc: boolean;
};

const state: AppState = {
  cwd: process.cwd(),
  history: [process.cwd()],
  histIdx: 0,
  showHidden: config.ui.showHidden,
  sortBy: "name",
  sortAsc: true,
};

let renderAll: () => void = () => {};

// --- session persistence: last folder survives restarts ---
const sessionFile = (): string =>
  path.join(process.env.XDG_STATE_HOME ?? path.join(home, ".local/state"), "tfm", "session.json");

let sessionTimer: any = null;
const scheduleSaveSession = (): void => {
  if (sessionTimer) clearTimeout(sessionTimer);
  sessionTimer = setTimeout(() => {
    sessionTimer = null;
    if (isVirtualCwd()) return;
    void mkdir(path.dirname(sessionFile()), { recursive: true })
      .then(() => writeFile(sessionFile(), JSON.stringify({ cwd: state.cwd })))
      .catch(() => {});
  }, 400);
};

const restoreSession = (): void => {
  // off by default: launching tfm from a shell should open where you are;
  // opt in via [ui] restore-session = true
  if (!config.ui.restoreSession) return;
  try {
    const doc = JSON.parse(readFileSync(sessionFile(), "utf8"));
    const cwd = typeof doc?.cwd === "string" ? doc.cwd : "";
    if (!cwd || cwd === RECENT_URI || cwd === STARRED_URI) return;
    try {
      if (statSync(cwd).isDirectory()) { state.cwd = cwd; state.history = [cwd]; state.histIdx = 0; }
    } catch {}
  } catch {}
};

const canBack = () => state.histIdx > 0;
const canFwd = () => state.histIdx < state.history.length - 1;

const goBack = () => { if (canBack()) { state.histIdx--; renderAll(); } };
const goFwd = () => { if (canFwd()) { state.histIdx++; renderAll(); } };

const navigate = (dir: string) => {
  debugLog(`navigate -> ${dir}`);
  pathEditMode = false;
  if (fileMenuState) closeFileMenu();
  if (dir === RECENT_URI || dir === STARRED_URI) {
    if (dir === state.cwd) { renderAll(); return; }
    state.history = state.history.slice(0, state.histIdx + 1);
    state.history.push(dir);
    state.histIdx++;
    clearSearch();
    renderAll();
    return;
  }
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
  clearSearch();
  renderAll();
};

let searchQuery = "";

const clearSearch = () => {
  searchQuery = "";
  try {
    const el: any = renderer.root.findDescendantById("tfm-search");
    if (el) { el.value = ""; el.visible = false; }
  } catch {}
};

// nautilus-style type-to-search: a printable char with the grid focused opens
// the search box seeded with that char instead of doing legacy jump-ahead
const beginTypeToSearch = (ch: string): void => {
  if (termHasFocus()) return; // shell owns the keyboard — never hijack into search
  const el: any = renderer.root.findDescendantById("tfm-search");
  if (!el) return;
  el.visible = true;
  el.value = ch;
  searchQuery = ch;
  void renderGrid();
  setTimeout(() => { try { el.focus(); } catch {} }, 10);
};

// --- System places sources (Nautilus-style: nothing hardcoded) ---

type Place = { icon: string; label: string; path: string | null; ejectable: boolean; device?: string; mountDevice?: string; scheme?: "recent" | "starred"; bookmarked?: boolean };

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

// --- GTK bookmark toggle (properties dialog; folders only, nautilus-compatible) ---
const gtkBookmarksFile = (): string =>
  path.join(process.env.XDG_CONFIG_HOME ?? path.join(home, ".config"), "gtk-3.0", "bookmarks");

const bookmarkUri = (p: string): string =>
  "file://" + p.split("/").map((seg, i) => (i === 0 ? seg : encodeURIComponent(seg))).join("/");

const isBookmarked = (dir: string): boolean =>
  sysBookmarks.some((b) => path.resolve(b.p) === path.resolve(dir));

// rewrite preserving order + custom labels; additions go last (nautilus does too)
const setBookmarked = async (dir: string, on: boolean): Promise<void> => {
  const file = gtkBookmarksFile();
  let lines: string[] = [];
  try { lines = (await readFile(file, "utf8")).split("\n"); } catch {}
  const uri = bookmarkUri(dir);
  const kept = lines.filter((l) => l.trim() && l.split(" ")[0] !== uri);
  if (on) kept.push(uri);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, kept.join("\n") + (kept.length ? "\n" : ""), "utf8");
};

const PSEUDO_FSTYPES = new Set(["squashfs", "tmpfs", "devtmpfs", "proc", "sysfs", "efivarfs", "overlay", "ramfs", "devfs", "cgroup"]);const SYSTEM_MOUNTS = new Set(["/", "/boot", "/boot/efi", "/efi", "/swap"]);

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
      const fstype: string | null | undefined = n?.fstype;
      let mps: string[] = [];
      if (Array.isArray(n?.mountpoints)) {
        mps = n.mountpoints.map((m: any) => (typeof m === "string" ? m : m?.mountpoint)).filter(Boolean);
      } else if (typeof n?.mountpoint === "string") {
        mps = [n.mountpoint];
      }
      const device = n?.path ?? `/dev/${name}`;
      if (mps.length === 0) {
        // mounted-nowhere but has a filesystem -> clickable to mount (nautilus behavior)
        if (fstype && !PSEUDO_FSTYPES.has(fstype)) {
          out.push({ label: n?.label || name, target: "", removable: rm, device });
        }
      }
      for (const target of mps) {
        if (!target || target.startsWith("[")) continue;
        if (SYSTEM_MOUNTS.has(target)) continue;
        if (target.startsWith("/snap") || target.startsWith("/var/lib/docker")) continue;
        const label = n?.label || path.basename(target) || name;
        if (!out.some((o) => o.target === target)) out.push({ label, target, removable: rm, device });
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
  defaults.push({ icon: "clock", label: "Recent", path: null, ejectable: false, scheme: "recent" });
  defaults.push({ icon: "star", label: "Starred", path: null, ejectable: false, scheme: "starred" });
  if (hasTrash) defaults.push({ icon: "trash-can", label: "Trash", path: trashDir, ejectable: false });

  const dirs: Place[] = sysUserDirs.map((d) => ({ icon: "folder", label: d.label, path: d.p, ejectable: false }));

  const bookmarks: Place[] = sysBookmarks.map((b) => ({ icon: "bookmark", label: b.label, path: b.p, ejectable: false, bookmarked: true }));

  const devices: Place[] = [
    { icon: "harddisk", label: "This Device", path: "/", ejectable: false },
    ...sysMounts.map((m): Place => ({
      icon: m.removable ? "usb" : "harddisk",
      label: m.label,
      path: m.target || null,
      ejectable: m.removable && !!m.target,
      device: m.device,
      mountDevice: m.target ? undefined : m.device,
    })),
  ];

  const groups = [defaults];
  if (dirs.length) groups.push(dirs);
  if (bookmarks.length) groups.push(bookmarks);
  groups.push(devices);
  return groups;
}

// --- Places sidebar (rebuilt from scratch on every render, selection = cwd) ---

const placesHost: { row: ReturnType<typeof Box>; rowId: string; labelId: string; specs: IconSpec[]; selected: boolean; place: Place }[] = [];
let mousePlaceIdx = -1;

// mutable: applyConfig() rewrites these when settings change
let sw = config.ui.sidebarWidth;

const mountDevice = (device: string) => {
  spawn("udisksctl", ["mount", "-b", device], { stdio: "ignore" });
  setTimeout(() => { void loadSystemPlaces().then(() => renderAll()); }, 1200);
};

const makeRow = (place: Place): ReturnType<typeof Box> => {
  const idx = placesHost.length;
  const placeTarget = (): string | null =>
    place.scheme === "recent" ? RECENT_URI
    : place.scheme === "starred" ? STARRED_URI
    : place.path;
  const selected = !!place.path
    ? path.resolve(place.path) === path.resolve(state.cwd)
    : !!place.scheme && state.cwd === placeTarget();
  const normFg = colors.sidebarFg;
  const selFg = colors.accent;
  const iconStates: IconState[] = [
    { fg: normFg, bg: colors.sidebarBg },
    { fg: normFg, bg: colors.hoverBg },
    { fg: selFg, bg: colors.accentBg },
  ];
  const maxLabel = sw - 4 - (place.ejectable ? 3 : 0);
  const paddedLabel = place.label.padEnd(Math.max(0, maxLabel)).slice(0, maxLabel);

  const iconSlot = makeIconSlot(place.icon, iconStates, 1, selected ? 2 : 0);
  let ejectSlot: ReturnType<typeof makeIconSlot> | undefined;
  if (place.ejectable && place.device) {
    ejectSlot = makeIconSlot(
      "eject",
      iconStates,
      1,
      selected ? 2 : 0,
      () => ejectDevice(place.device!),
    );
  }
  const specs = ejectSlot ? [iconSlot.spec, ejectSlot.spec] : [iconSlot.spec];

  const rowNode = Box(
    {
      id: `tfm-place-${idx}`,
      width: sw,
      height: 1,
      flexDirection: "row",
      columnGap: 1,
      paddingLeft: 1,
      backgroundColor: selected ? colors.accentBg : colors.sidebarBg,
      onMouseDown: (ev: any) => {
        if (ev.button === 2) {
          closeFileMenu();
          openContextMenu(ev.x, ev.y, place.label, sidebarEntriesFor(place, ev.x, ev.y));
          return;
        }
        blurTerminal();
        closeFileMenu();
        const target = placeTarget();
        if (target) navigate(target);
        else if (place.mountDevice) mountDevice(place.mountDevice);
      },
      onMouseDrop: () => {
        const keys = dragKeys;
        finishDragState();
        const target = placeTarget();
        dlog(`place drop ${place.label} keys=${keys?.length ?? -1} scheme=${place.scheme ?? "-"} target=${target}`);
        if (!keys || !target || place.scheme) return;
        const rest = keys.filter((k) => k.path !== target);
        if (!rest.length) return;
        if (target === path.join(home, ".local/share/Trash/files")) {
          // dropping onto the trash place must gio-trash, not plain-move —
          // otherwise no .trashinfo is written and items can't be restored
          void trashPaths(rest.map((k) => k.path));
        } else {
          void moveInto(target, rest);
        }
      },
      onMouseOver: () => { mousePlaceIdx = idx; normalizePlaces(); },
      onMouseOut: () => { if (mousePlaceIdx === idx) { mousePlaceIdx = -1; normalizePlaces(); } },
    },
    iconSlot.el,
  );
  const labelText: any = Text({
    id: `tfm-place-${idx}-label`,
    content: paddedLabel,
    fg: selected ? selFg : normFg,
  });
  rowNode.add(labelText);
  if (ejectSlot) rowNode.add(ejectSlot.el);
  placesHost.push({
    row: rowNode,
    rowId: `tfm-place-${idx}`,
    labelId: `tfm-place-${idx}-label`,
    specs: ejectSlot ? [iconSlot.spec, ejectSlot.spec] : [iconSlot.spec],
    selected,
    place,
  });
  return rowNode;
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
  if (sidebarActive && placeIdx >= 0) {
    normalizePlaces();
  }
};

const makeTitle = () =>
  Box(
    { id: "tfm-title-box", width: sw, height: 5, flexDirection: "column", justifyContent: "center", paddingLeft: 1 },
    ASCIIFont({ id: "tfm-title-font", text: "tfm", font: "tiny", color: colors.accent }),
    Text({ id: "tfm-title-sub", content: " terminal file manager", fg: colors.sidebarFgMuted }),
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

// nav icons carry 4 rasters: enabled/disabled × normal/hover (bg baked into
// the png, so the wrapper box bg must swap in lockstep)
let navHover: Record<string, boolean> = {};
const navBtnBg = (id: string) => {
  try {
    const n: any = renderer.root.findDescendantById(id);
    if (n) n.backgroundColor = navHover[id] ? colors.hoverBg : colors.bg;
  } catch {}
};

const makeNavButton = (id: "tfm-nav-back" | "tfm-nav-fwd", iconName: string, onActivate: () => void) => {
  const states = (): IconState[] => [
    { fg: colors.sidebarFg, bg: colors.bg },
    { fg: colors.sidebarFgMuted, bg: colors.bg },
    { fg: colors.sidebarFg, bg: colors.hoverBg },
    { fg: colors.sidebarFgMuted, bg: colors.hoverBg },
  ];
  const slot = makeIconSlot(iconName, states(), 1, 0, undefined, states);
  navSpecs[id] = slot.spec;
  return Box(
    {
      id,
      height: 1,
      width: 3,
      justifyContent: "center",
      backgroundColor: colors.bg,
      onMouseDown: () => { closeFileMenu(); onActivate(); },
      onMouseOver: () => { navHover[id] = true; refreshNav(); },
      onMouseOut: () => { navHover[id] = false; refreshNav(); },
    },
    slot.el,
  );
};

const refreshNav = () => {
  const setBtn = (id: string, spec: IconSpec | undefined, on: boolean) => {
    if (!spec) return;
    setIconState(spec, (on ? 0 : 1) + (navHover[id] ? 2 : 0));
    navBtnBg(id);
  };
  setBtn("tfm-nav-back", navSpecs["tfm-nav-back"], canBack());
  setBtn("tfm-nav-fwd", navSpecs["tfm-nav-fwd"], canFwd());
};

const crumbSep = () => Text({ content: " › ", fg: colors.sidebarFgMuted });

let pathEditMode = false;
let crumbClickAt = 0;

const exitPathEdit = () => {
  if (!pathEditMode) return;
  pathEditMode = false;
  renderCrumbs();
};

const enterPathEdit = () => {
  if (pathEditMode) return;
  blurTerminal();
  pathEditMode = true;
  renderCrumbs();
};

const renderCrumbs = () => {
  const box: any = renderer.root.findDescendantById("tfm-crumbs");
  if (!box) return;

  const toolbarRow: any = renderer.root.findDescendantById("tfm-toolbar");

  if (pathEditMode) {
    [...box.getChildren()].forEach((c: any) => box.remove(c));
    let input: any = renderer.root.findDescendantById("tfm-path-input");
    if (!input) {
      // real class instance: proxied composition nodes don't mount under an
      // already-mounted parent
      input = new InputRenderable(renderer, {
        id: "tfm-path-input",
        flexGrow: 1,
        value: isVirtualCwd() ? state.cwd : path.resolve(state.cwd),
        backgroundColor: colors.accentBg,
        focusedBackgroundColor: colors.accentBg,
        textColor: colors.white,
      });
      box.add(input);
      input.on?.("enter", () => {
        const target = String((input as any).value ?? "").replace(/^~(?=\/|$)/, home);
        pathEditMode = false;
        renderCrumbs();
        navigate(target);
      });
      // focused editors can consume keys before the global handler; intercept
      // escape at the source so it always cancels
      const prevHandler = input.handleKeyPress?.bind(input);
      input.handleKeyPress = (key: any) => {
        if (key?.name === "escape") {
          exitPathEdit();
          return true;
        }
        return prevHandler ? prevHandler(key) : false;
      };
    } else {
      try { input.value = isVirtualCwd() ? state.cwd : path.resolve(state.cwd); } catch {}
    }
    try { input.visible = true; } catch {}
    setTimeout(() => { try { input.focus(); } catch {} }, 20);
    stripSelectable();
    return;
  }

  // rebuild crumbs from scratch — appending would duplicate them every nav
  [...box.getChildren()].forEach((c: any) => box.remove(c));

  const cwdAbs = path.resolve(state.cwd);
  const virtCrumb = state.cwd === RECENT_URI
    ? { label: "Recent", icon: "clock" }
    : state.cwd === STARRED_URI
    ? { label: "Starred", icon: "star" }
    : null;
  const inHome = !virtCrumb && (cwdAbs === home || cwdAbs.startsWith(home + path.sep));
  const baseLabel = virtCrumb ? virtCrumb.label : inHome ? "Home" : os.hostname();
  const baseIcon = virtCrumb ? virtCrumb.icon! : inHome ? "home" : "desktop-tower";
  const basePath = virtCrumb ? state.cwd : inHome ? home : "/";
  const rest = virtCrumb ? [] : path.relative(inHome ? home : "/", cwdAbs).split(path.sep).filter(Boolean);

  const crumbs: { label: string; icon?: string; target: string }[] = [
    { label: baseLabel, icon: baseIcon, target: basePath },
    ...rest.map((seg, i) => ({ label: seg, target: path.join(basePath, ...rest.slice(0, i + 1)) })),
  ];

  crumbs.forEach((c, i) => {
    const current = i === crumbs.length - 1;
    const fg = current ? colors.white : colors.sidebarFgMuted;
    // clickable crumbs get hover feedback: baked raster swap + box bg swap
    const iconStates = current
      ? [{ fg, bg: colors.bg }]
      : [
          { fg, bg: colors.bg },
          { fg: colors.white, bg: colors.hoverBg },
        ];
    const iconSlot = c.icon ? makeIconSlot(c.icon, iconStates, 1) : null;
    const paintHover = (on: boolean) => {
      if (iconSlot && !current) setIconState(iconSlot.spec, on ? 1 : 0);
      try {
        const n: any = renderer.root.findDescendantById(`tfm-crumb-${i}`);
        if (n) n.backgroundColor = on && !current ? colors.hoverBg : colors.bg;
      } catch {}
    };
    const crumb = Box(
      {
        id: `tfm-crumb-${i}`,
        height: 1,
        flexDirection: "row",
        alignItems: "center",
        columnGap: 1,
        backgroundColor: colors.bg,
        ...(current
          ? {}
          : {
              onMouseDown: () => navigate(c.target),
              onMouseOver: () => paintHover(true),
              onMouseOut: () => paintHover(false),
            }),
      },
      ...(iconSlot ? [iconSlot.el] : []),
      Text({ content: c.label, fg }),
    );
    box.add(crumb);
    if (i < crumbs.length - 1) box.add(crumbSep());
  });
};

// toolbar buttons swap between two baked rasters (normal/hover bg) and match
// the wrapper box bg so the padding cells track the raster
const hoverBtnStates = (): IconState[] => [
  { fg: colors.sidebarFg, bg: colors.bg },
  { fg: colors.sidebarFg, bg: colors.hoverBg },
];
const hoverBtn = (
  id: string,
  iconName: string,
  onMouseDown: (ev: any) => void,
): ReturnType<typeof Box> => {
  const states = hoverBtnStates;
  const slot = makeIconSlot(iconName, states(), 1, 0, undefined, states);
  const paint = (on: boolean) => {
    setIconState(slot.spec, on ? 1 : 0);
    try {
      const n: any = renderer.root.findDescendantById(id);
      if (n) n.backgroundColor = on ? colors.hoverBg : colors.bg;
    } catch {}
  };
  return Box(
    {
      id,
      height: 1,
      width: 3,
      justifyContent: "center",
      backgroundColor: colors.bg,
      onMouseDown,
      onMouseOver: () => paint(true),
      onMouseOut: () => paint(false),
    },
    slot.el,
  );
};

const makeSearch = () => {
  const wrap = Box({ id: "tfm-search-wrap", height: 1, flexDirection: "row" });

  const input = Input({
    id: "tfm-search",
    width: 16,
    visible: false,
    placeholder: "Search",
    backgroundColor: colors.accentBg,
    focusedBackgroundColor: colors.accentBg,
    textColor: colors.white,
  });

  wrap.add(
    hoverBtn("tfm-search-btn", "search", () => {
      closeFileMenu();
      blurTerminal();
      const el: any = renderer.root.findDescendantById("tfm-search");
      if (!el) return;
      el.visible = !el.visible;
      if (el.visible) el.focus();
    }),
  );
  wrap.add(input);
  return wrap;
};

const makeSortButton = (): ReturnType<typeof Box> =>
  hoverBtn("tfm-sort-btn", "sort", (ev: any) => {
    closeFileMenu();
    openContextMenu(ev.x, ev.y, "", sortEntries());
  });

const makeToolbarShell = (): ReturnType<typeof Box> =>
  Box(
    { id: "tfm-toolbar", width: "100%", height: 1, flexDirection: "row", paddingLeft: 1, paddingRight: 1, columnGap: 1 },
    Box(
      { height: 1, flexGrow: 1, flexBasis: 0, overflow: "hidden", flexDirection: "row", columnGap: 1 },
      makeNavButton("tfm-nav-back", "chevron-left", goBack),
      makeNavButton("tfm-nav-fwd", "chevron-right", goFwd),
      Box({
        id: "tfm-crumbs",
        flexGrow: 1,
        flexBasis: 0,
        height: 1,
        flexDirection: "row",
        columnGap: 1,
        overflow: "hidden",
        onMouseDown: () => {
          const now = Date.now();
          if (pathEditMode) return;
          closeFileMenu();
          if (now - crumbClickAt < 350) {
            crumbClickAt = 0;
            enterPathEdit();
          } else {
            crumbClickAt = now;
          }
        },
      }),
    ),
    makeSortButton(),
    makeSearch(),
  );

// --- Directory listing ---
type SortMode = "name" | "size" | "mtime" | "type";
type Entry = { name: string; isDir: boolean; size?: number; mtimeMs?: number; abs?: string };

// --- Virtual places: Recent (freedesktop recently-used.xbel) & Starred ---
const RECENT_URI = "recent://";
const STARRED_URI = "starred://";
const isVirtualCwd = (p: string = state.cwd): boolean => p === RECENT_URI || p === STARRED_URI;

const xdgDataHome = () => process.env.XDG_DATA_HOME ?? path.join(home, ".local/share");
const xdgStateHome = () => process.env.XDG_STATE_HOME ?? path.join(home, ".local/state");

type XbelItem = { path: string; modified: number };

const xbelPath = (): string => path.join(xdgDataHome(), "recently-used.xbel");

// XBEL timestamps are ISO-8601; Date.parse handles them
const parseIso = (s: string): number => {
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : 0;
};

const uriToPath = (uri: string): string | null => {
  if (!uri.startsWith("file://")) return null;
  try { return decodeURIComponent(uri.slice(7)); } catch { return null; }
};

const readRecentXbel = (): XbelItem[] => {
  let xml = "";
  try { xml = readFileSync(xbelPath(), "utf8"); } catch { return []; }
  const out: XbelItem[] = [];
  const bmRe = /<bookmark\b[^>]*href="([^"]+)"[^>]*>/g;
  let m: RegExpExecArray | null;
  while ((m = bmRe.exec(xml))) {
    const p = uriToPath(m[1]!);
    if (!p) continue;
    // modified attr lives on the same tag; fall back to the application entry
    const tag = m[0];
    const mod = tag.match(/modified="([^"]+)"/)?.[1];
    out.push({ path: p, modified: mod ? parseIso(mod) : 0 });
  }
  // newest first, one row per file
  const seen = new Set<string>();
  const uniq: XbelItem[] = [];
  for (const it of out.sort((a, b) => b.modified - a.modified)) {
    if (seen.has(it.path)) continue;
    seen.add(it.path);
    uniq.push(it);
  }
  return uniq;
};

let recordOpenTimer: any = null;
let recordOpenPaths: string[] = [];

// batch opens into one xbel rewrite (opening a selection of N files fires N times)
const recordOpen = (p: string): void => {
  if (inTrashView()) return;
  recordOpenPaths.push(p);
  if (recordOpenTimer) clearTimeout(recordOpenTimer);
  recordOpenTimer = setTimeout(() => {
    const paths = [...new Set(recordOpenPaths)];
    recordOpenPaths = [];
    recordOpenTimer = null;
    void upsertRecentXbel(paths);
  }, 150);
};

const xmlEscapeUri = (p: string): string =>
  "file://" + p.split("/").map((seg, i) => (i === 0 ? seg : encodeURIComponent(seg))).join("/");

const upsertRecentXbel = async (paths: string[]): Promise<void> => {
  try {
    let xml = "";
    try { xml = await readFile(xbelPath(), "utf8"); } catch {}
    const now = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
    type Kept = { uri: string; block: string };
    const kept: Kept[] = [];
    const counts = new Map<string, number>();
    const bmRe = /[ \t]*<bookmark\b[\s\S]*?<\/bookmark>[ \t]*\n?/g;
    for (const blk of xml.match(bmRe) ?? []) {
      const uri = blk.match(/href="([^"]+)"/)?.[1];
      if (!uri) continue;
      if (paths.some((p) => xmlEscapeUri(p) === uri)) {
        counts.set(uri, parseInt(blk.match(/count="(\d+)"/)?.[1] ?? "0", 10) + 1);
        continue;
      }
      kept.push({ uri, block: blk.trim() });
    }
    for (const p of paths) {
      const uri = xmlEscapeUri(p);
      const mime = globs2ByExt?.get(path.extname(p).slice(1).toLowerCase()) ?? "application/octet-stream";
      const count = counts.get(uri) ?? 1;
      kept.push({
        uri,
        block: `  <bookmark href="${uri}" added="${now}" modified="${now}" visited="${now}">
    <info>
      <metadata owner="http://freedesktop.org">
        <mime:mime-type type="${mime}"/>
        <bookmark:applications>
          <bookmark:application name="tfm" exec="&apos;tfm&apos;" modified="${now}" count="${count}"/>
        </bookmark:applications>
      </metadata>
    </info>
  </bookmark>`,
      });
    }
    const head = `<?xml version="1.0" encoding="UTF-8"?>
<xbel version="1.0"
      xmlns:bookmark="http://www.freedesktop.org/standards/desktop-bookmarks"
      xmlns:mime="http://www.freedesktop.org/standards/shared-mime-info">
`;
    const body = kept.slice(-500).map((k) => k.block).join("\n");
    await writeFile(xbelPath(), `${head}${body}\n</xbel>\n`, "utf8");
  } catch {}
};

const openFileDefault = (p: string): void => {
  recordOpen(p);
  spawn("xdg-open", [p], { stdio: "ignore", detached: true }).unref?.();
  void notifyOpenedWith(p);
};

// resolve the app xdg-open will pick so the toast can say what launched
const runOutShort = async (cmd: string[]): Promise<string> => {
  try {
    const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "ignore", stdin: "ignore" });
    const timer = setTimeout(() => { try { proc.kill(); } catch {} }, 1500);
    const out = (await new Response(proc.stdout).text()).trim();
    clearTimeout(timer);
    return out;
  } catch { return ""; }
};

const desktopAppName = async (desktopId: string): Promise<string> => {
  if (!desktopId) return "";
  const dirs = [
    path.join(xdgDataHome(), "applications"),
    "/usr/local/share/applications",
    "/usr/share/applications",
    "/var/lib/flatpak/exports/share/applications",
    path.join(home, ".local/share/flatpak/exports/share/applications"),
  ];
  for (const d of dirs) {
    try {
      // first non-localized Name= inside [Desktop Entry]
      const m = readFileSync(path.join(d, desktopId), "utf8").match(/^\[Desktop Entry\][\s\S]*?^Name=(.+)$/m);
      if (m?.[1]) return m[1].trim();
    } catch {}
  }
  return desktopId.replace(/\.desktop$/, "");
};

const notifyOpenedWith = async (p: string): Promise<void> => {
  const base = path.basename(p);
  let app = "";
  try {
    const mime = await runOutShort(["xdg-mime", "query", "filetype", p]);
    if (mime) app = await desktopAppName(await runOutShort(["xdg-mime", "query", "default", mime]));
  } catch {}
  notify(`Opening ${base}${app ? ` · ${app}` : ""}`, "open");
};

// Starred registry: tfm's own list, kept in sync with gvfs metadata so
// nautilus sees the same stars (gio set metadata::starred).
const starredListPath = (): string => path.join(xdgStateHome(), "tfm", "starred.list");

const readStarredList = (): string[] => {
  try {
    return readFileSync(starredListPath(), "utf8")
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
  } catch { return []; }
};

const writeStarredList = async (paths: string[]): Promise<void> => {
  try {
    await mkdir(path.dirname(starredListPath()), { recursive: true });
    await writeFile(starredListPath(), [...new Set(paths)].join("\n") + "\n", "utf8");
  } catch {}
};

const starredRegistryAdd = (p: string): void => { void writeStarredList([...readStarredList(), p]); };
const starredRegistryRemove = (p: string): void => {
  void writeStarredList(readStarredList().filter((x) => x !== p));
};

const recentEntries = async (): Promise<Entry[]> => {
  const out: Entry[] = [];
  for (const it of readRecentXbel()) {
    let st: any = null;
    try { st = statSync(it.path); } catch { continue; } // drop vanished files
    out.push({ name: path.basename(it.path), isDir: st.isDirectory(), abs: it.path, size: st.size, mtimeMs: it.modified });
  }
  return out;
};

const starredEntries = async (): Promise<Entry[]> => {
  const out: Entry[] = [];
  for (const p of readStarredList()) {
    let st: any = null;
    try { st = statSync(p); } catch { continue; }
    out.push({ name: path.basename(p), isDir: st.isDirectory(), abs: p, size: st.size, mtimeMs: st.mtimeMs ?? 0 });
  }
  return out;
};

async function listDir(dir: string, showHidden: boolean): Promise<Entry[]> {
  let out: Entry[];
  if (dir === RECENT_URI) {
    out = await recentEntries();
    // recency order wins over the global sort mode, like nautilus
    return out.sort((a, b) => (b.mtimeMs ?? 0) - (a.mtimeMs ?? 0));
  }
  if (dir === STARRED_URI) out = await starredEntries();
  else {
  const dirents = await readdir(dir, { withFileTypes: true });
  out = [];
  for (const d of dirents) {
    if (!showHidden && d.name.startsWith(".")) continue;
    let isDir = d.isDirectory();
    // a symlink is a folder only if its target is one — never follow it further
    if (d.isSymbolicLink()) {
      try { isDir = (await stat(path.join(dir, d.name))).isDirectory(); } catch { isDir = false; }
    }
    out.push({ name: d.name, isDir });
  }
  }
  if (state.sortBy === "size" || state.sortBy === "mtime") {
    for (const e of out) {
      try { const st = statSync(e.abs ?? path.join(dir, e.name)); e.size = st.size; e.mtimeMs = st.mtimeMs ?? 0; } catch {}
    }
  }
  const extOf = (n: string): string => {
    const b = n.startsWith(".") ? n.slice(1) : n;
    const i = b.lastIndexOf(".");
    return i > 0 ? b.slice(i + 1).toLowerCase() : "";
  };
  const cmp = (a: Entry, b: Entry): number => {
    switch (state.sortBy) {
      case "size": return (a.size ?? 0) - (b.size ?? 0);
      case "mtime": return (a.mtimeMs ?? 0) - (b.mtimeMs ?? 0);
      case "type": return extOf(a.name).localeCompare(extOf(b.name)) || a.name.localeCompare(b.name);
      default: return a.name.localeCompare(b.name);
    }
  };
  return out.sort((a, b) => Number(b.isDir) - Number(a.isDir) || (state.sortAsc ? cmp(a, b) : -cmp(a, b)));
}

// --- Layout ---
const container = Box(
  { width: "100%", height: "100%", flexDirection: "row" },
  Box(
    { id: "tfm-sidebar-root", width: sw, height: "100%", backgroundColor: colors.sidebarBg, flexDirection: "column" },
    makeTitle(),
    Box({ id: "tfm-places", width: sw, flexDirection: "column" }),
  ),
  Box(
    { id: "tfm-main", flexGrow: 1, height: "100%", backgroundColor: colors.bg, flexDirection: "column" },
    makeToolbarShell(),
    Box({ id: "tfm-grid-host", flexGrow: 1, width: "100%", flexDirection: "column" }),
    // status bar sits above the embedded terminal pane (zero-height until opened),
    // so with a terminal open the bar hugs its top edge instead of sinking below it
    Box(
      { id: "tfm-status", width: "100%", height: 1, flexDirection: "row", justifyContent: "flex-end", paddingRight: 1 },
      Text({ id: "tfm-status-label", content: "", fg: colors.sidebarFgMuted }),
    ),
    Box({ id: "tfm-term-host", width: "100%", height: 0, flexDirection: "column" }),
  ),
  Box(
    {
      id: "tfm-preview",
      width: config.ui.previewWidth,
      height: "100%",
      visible: config.ui.previewEnabled, // display:none in yoga: takes no layout space when hidden
      backgroundColor: colors.sidebarBg,
      flexDirection: "column",
      paddingLeft: 1,
      paddingRight: 1,
    },
  ),
);

// --- Renderer boot ---
const renderer = await createCliRenderer({ exitOnCtrlC: false, targetFps: 60, maxFps: 120 });
renderer.root.add(container);
renderer.setBackgroundColor(colors.bg); // opencode-style: global bg lives on the renderer, not per-box

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const stripSelectable = (node: any = renderer.root): void => {
  if (!node || node.isDestroyed) return;
  try { if (node.selectable) node.selectable = false; } catch {}
  node.getChildren?.().forEach((c: any) => stripSelectable(c));
};

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
const inflightIcons = new Map<string, Promise<Uint8Array>>();

// In a `bun --compile` binary, assets/icons/*.svg are embedded as File blobs
// named "<basename>-<hash>.svg" — plain readFileSync can't see them. Index by
// basename once; dev runs (embeddedFiles empty) fall through to disk.
// Memoize the PROMISE, not the Map: assigning the Map first let concurrent
// callers resolve against a half-filled index during the await loop.
let embeddedIconsP: Promise<Map<string, string>> | null = null;
const embeddedIconTexts = (): Promise<Map<string, string>> =>
  (embeddedIconsP ??= (async () => {
    const map = new Map<string, string>();
    try {
      for (const f of (Bun as any).embeddedFiles ?? []) {
        const iconName = String(f?.name ?? "").match(/^(.+)-[a-z0-9]{8}\.svg$/i)?.[1];
        if (iconName) map.set(iconName, await f.text());
      }
    } catch {}
    return map;
  })());
void embeddedIconTexts(); // warm while the renderer boots

const rasterizeSvg = async (name: string, fg: string, bg: string, pxW: number, pxH: number) =>
  new Promise<Uint8Array>(async (resolve, reject) => {
    let svg: string;
    try {
      svg =
        (await embeddedIconTexts()).get(name) ??
        readFileSync(`${import.meta.dir}/../assets/icons/${name}.svg`, "utf8");
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

// Disk cache for rendered rasters: keyed by everything that changes the output
// (name, tint, bg, pixel size) plus a pipeline-version salt. Theme switches
// naturally miss because fg/bg are part of the key.
const ICON_DISK_VER = "v2";
const iconDiskDir = (): string =>
  path.join(process.env.XDG_CACHE_HOME ?? path.join(home, ".cache"), "tfm", "icons");
const iconDiskPath = (key: string): string =>
  path.join(iconDiskDir(), `${createHash("sha1").update(`${ICON_DISK_VER}:${key}`).digest("hex").slice(0, 20)}.png`);
let iconDirReady: Promise<void> | null = null;
const ensureIconDir = (): Promise<void> =>
  (iconDirReady ??= mkdir(iconDiskDir(), { recursive: true }).then(() => undefined).catch(() => {}));

// Cap concurrent rsvg forks — boot fans out dozens of slots at once and a
// thundering herd of librsvg processes is slower than a capped pipeline.
const RASTER_CONCURRENCY = 12;
let rasterActive = 0;
const rasterWaiters: (() => void)[] = [];
const acquireRasterSlot = async (): Promise<void> => {
  if (rasterActive >= RASTER_CONCURRENCY) await new Promise<void>((r) => rasterWaiters.push(r));
  rasterActive++;
};
const releaseRasterSlot = () => {
  rasterActive--;
  rasterWaiters.shift()?.();
};

const iconPng = async (name: string, fg: string, bg: string, pxW: number, pxH: number): Promise<Uint8Array> => {
  const key = `${name}:${fg}:${bg}:${pxW}x${pxH}`;
  const hit = iconCache.get(key);
  if (hit) return hit;
  // identical requests racing (e.g. 15 folder rows) share one render
  const running = inflightIcons.get(key);
  if (running) return running;
  try {
    const cached = readFileSync(iconDiskPath(key));
    const bytes = new Uint8Array(cached);
    iconCache.set(key, bytes);
    return bytes;
  } catch {}
  const job = (async () => {
    await acquireRasterSlot();
    try {
      const bytes = await rasterizeSvg(name, fg, bg, pxW, pxH);
      iconCache.set(key, bytes);
      void ensureIconDir().then(() => writeFile(iconDiskPath(key), bytes).catch(() => {}));
      return bytes;
    } finally {
      releaseRasterSlot();
    }
  })();
  inflightIcons.set(key, job);
  job.finally(() => inflightIcons.delete(key)).catch(() => {});
  return job;
};

// --- Image thumbnails (magick resize flattened onto bg, cached per file version) ---
const thumbCache = new Map<string, Promise<Uint8Array>>();

const thumbPng = (
  path: string,
  mtimeMs: number,
  size: number,
  pxW: number,
  pxH: number,
  bg: string,
  vector = false,
): Promise<Uint8Array> => {
  // bg in the key: thumbnails are flattened onto it, so a theme swap must miss
  const key = `${path}|${mtimeMs}|${size}|${pxW}x${pxH}|${bg}`;
  let p = thumbCache.get(key);
  if (!p) {
    p = new Promise<Uint8Array>((resolve, reject) => {
      // vectors must render at high density FIRST or we upscale a tiny
      // intrinsic bitmap (a 24-unit icon svg would look like mush)
      const args = [
        ...(vector ? ["-density", "192"] : []),
        path, "-auto-orient", "-background", bg,
        "-thumbnail", `${pxW}x${pxH}^`, "-gravity", "center", "-extent", `${pxW}x${pxH}`,
        "png:-",
      ];
      const proc = spawn("magick", args);
      const chunks: Buffer[] = [];
      proc.stdout.on("data", (c: Buffer) => chunks.push(c));
      proc.on("error", reject);
      proc.on("close", (code) =>
        code === 0 && chunks.length > 0
          ? resolve(new Uint8Array(Buffer.concat(chunks)))
          : reject(new Error(`magick exited ${code}`))
      );
      proc.stdin.end();
    });
    p.catch(() => thumbCache.delete(key));
    thumbCache.set(key, p);
  }
  return p;
};

type ThumbJob = { slotId: string; path: string; mtimeMs: number; size: number; wCells: number; hCells?: number; bg?: string; vector: boolean; fallbackGlyph: string };
let thumbJobs: ThumbJob[] = [];

const drainThumbs = async () => {
  const jobs = thumbJobs;
  thumbJobs = [];
  if (!renderer.resolution || jobs.length === 0) return;
  const { cellW, cellH } = cellMetrics();
  let idx = 0;
  const worker = async () => {
    while (idx < jobs.length) {
      const j = jobs[idx++]!;
      const slot: any = renderer.root.findDescendantById(j.slotId);
      if (!slot) continue;
      const hCells = j.hCells ?? ICON_CELLS_H;
      const jobBg = j.bg ?? colors.bg;
      // 2px inset so kitty's cell->pixel rounding never bleeds onto neighbors
      const pxW = Math.max(1, Math.round(j.wCells * cellW) - 2);
      const pxH = Math.max(1, Math.round(hCells * cellH) - 2);
      try {
        const bytes = await thumbPng(j.path, j.mtimeMs, j.size, pxW, pxH, jobBg, j.vector);
        const img = new ImageRenderable(renderer, {
          id: `${j.slotId}-t`,
          source: bytes,
          width: j.wCells,
          height: hCells,
          fit: "fit",
          protocol: "auto",
        });
        await img.loadPromise!;
        [...slot.getChildren()].forEach((c: any) => { try { slot.remove(c); } catch {} });
        slot.add(img);
      } catch {
        if (slot.getChildren().length === 0) {
          try {
            slot.add(Text({ content: j.fallbackGlyph, fg: colors.sidebarFgMuted }));
          } catch {}
        }
      }
      await new Promise((r) => setTimeout(r, 0));
    }
  };
  await Promise.all([worker(), worker(), worker()]);
};

const dimHex = (hex: string, f: number): string => {
  if (f === 1) return hex;
  const m = hex.match(/^#([0-9a-fA-F]{6})$/);
  if (!m || !m[1]) return hex;
  const n = parseInt(m[1], 16);
  const r = Math.round(((n >> 16) & 255) * f);
  const g = Math.round(((n >> 8) & 255) * f);
  const b = Math.round((n & 255) * f);
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, "0")}`;
};

const rasterStatesInto = async (
  slotId: string,
  name: string,
  states: IconState[],
  heightCells: number,
  wCells: number,
  initial: number,
  dimFactor = 1,
  idPrefix = "s",
) => {
  const { cellW, cellH } = cellMetrics();
  const imgs: any[] = [];
  for (let si = 0; si < states.length; si++) {
    try {
      const st = states[si]!;
      const bytes = await iconPng(
        name,
        dimHex(st.fg, dimFactor),
        dimHex(st.bg, dimFactor),
        Math.max(1, Math.round(wCells * cellW)),
        Math.max(1, Math.round(heightCells * cellH)),
      );
      const img = new ImageRenderable(renderer, {
        id: `${slotId}-${idPrefix}${si}`,
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
    if (spec.statesFactory) {
      try { spec.states = spec.statesFactory(); } catch {}
    }
    const wCells = Math.max(1, Math.round(spec.heightCells * aspect));
    const imgs = await rasterStatesInto(spec.slotId, spec.name, spec.states, spec.heightCells, wCells, spec.initialState);
    if (imgs.length === 0) return;
    slot.width = wCells;
    const kids = slot.getChildren?.() ?? [];
    // drop previous rasters (e.g. after a resize re-raster at new cell pixels)
    kids.filter((k: any) => typeof k.id === "string" && k.id.startsWith(`${spec.slotId}-s`))
      .forEach((k: any) => { try { slot.remove(k); } catch {} });
    const glyphNode: any = kids.find((k: any) => typeof k.id === "string" && k.id.endsWith("-g"));
    // glyph stays in the slot (hidden) so the scrim can fall back to it
    if (glyphNode) { try { glyphNode.visible = false; } catch {} }
    imgs.forEach((im) => slot.add(im));
  }));
  // re-rasters made fresh images visible; while a modal scrim is up the icons
  // must fall back to dimmed glyphs or they float over the menu
  if (menuOpen) setScrim(true);
};

// Kitty placements float above all cells, so the scrim can't dim them.
// While the menu is open every background slot falls back to its glyph,
// pre-darkened to blend into the backdrop; rasters come back on close.
// Slots INSIDE a modal (menu rows, context menus, prompts) sit above the
// scrim and keep their crisp rasters.
const MODAL_ROOT_IDS = new Set(["tfm-menu", "tfm-filemenu", "tfm-prompt"]);

const isModalChild = (slot: any): boolean => {
  let cur: any = slot?.parent;
  while (cur) {
    if (typeof cur?.id === "string" && MODAL_ROOT_IDS.has(cur.id)) return true;
    cur = cur.parent;
  }
  return false;
};

const setScrim = (on: boolean) => {
  for (const spec of iconQueue) {
    const slot: any = renderer.root.findDescendantById(spec.slotId);
    if (!slot) continue;
    if (on && isModalChild(slot)) continue;
    const kids = (slot.getChildren?.() ?? []) as any[];
    const glyphNode: any = kids.find((k) => k.id === `${spec.slotId}-g`);
    if (!glyphNode) continue;
    const stateImgs = kids.filter((k) => typeof k.id === "string" && k.id.startsWith(`${spec.slotId}-s`));
    if (stateImgs.length === 0 && !spec.done) continue;
    if (on) {
      stateImgs.forEach((k) => { try { k.visible = false; } catch {} });
      try {
        glyphNode.fg = dimHex(spec.states[spec.initialState]?.fg ?? colors.sidebarFg, 0.41);
        glyphNode.visible = true;
      } catch {}
    } else {
      if (stateImgs.length === 0) {
        try { glyphNode.visible = true; } catch {}
      } else {
        try { glyphNode.visible = false; } catch {}
        stateImgs.forEach((k, i) => { try { k.visible = i === spec.initialState; } catch {} });
      }
    }
  }
};

// --- Grid (scrollable, culled, interactive) ---
// mutable: applyConfig() rewrites these when settings change
let TILE_W = config.ui.tileWidth;
let TILE_H = config.ui.tileHeight;
let ICON_CELLS_H = config.ui.iconCells;

let scroller: ScrollBoxRenderable | null = null;
let gridGen = 0;
let tileSeq = 0;

// keyboard focus over tiles
let focusKeys: string[] = [];
let focusIdx = -1;
let colsAtBuild = 1;
// anchor tile for shift+click range selection (index into focusKeys)
let selAnchor: number | null = null;

const selectRange = (from: number, to: number): void => {
  clearTileSelection();
  if (focusKeys.length === 0) return;
  const lo = Math.max(0, Math.min(from, to));
  const hi = Math.min(focusKeys.length - 1, Math.max(from, to));
  for (let i = lo; i <= hi; i++) {
    const k = focusKeys[i]!;
    const r = tileRefsByKey.get(k);
    if (r) { r.selected = true; setTileVisual(k, 2); }
  }
};

// sidebar keyboard focus
let sidebarActive = false;
let placeIdx = -1;

const setSidebarFocus = (idx: number): boolean => {
  if (idx < 0 || idx >= placesHost.length) return false;
  placeIdx = idx;
  normalizePlaces();
  return true;
};

const leaveSidebarToGrid = () => {
  sidebarActive = false;
  normalizePlaces();
};

// single source of truth: exactly one accent (cwd-selected) and optionally
// one keyboard-hover highlight; wipes any stray styles deterministically
const normalizePlaces = () => {
  placesHost.forEach((rec, i) => {
    const isSel = rec.selected;
    const isHover = !isSel && (sidebarActive ? i === placeIdx : i === mousePlaceIdx);
    const row: any = renderer.root.findDescendantById(rec.rowId);
    const label: any = renderer.root.findDescendantById(rec.labelId);
    try { if (row) row.backgroundColor = isSel ? colors.accentBg : isHover ? colors.hoverBg : colors.sidebarBg; } catch {}
    rec.specs.forEach((s) => setIconState(s, isSel ? 2 : isHover ? 1 : 0));
    try { if (label) label.fg = isSel ? colors.accent : colors.sidebarFg; } catch {}
  });
};

// arrows and clicks drive the SAME single selection; there is no separate
// focus highlight
const selectTileAt = (idx: number): boolean => {
  if (idx < 0 || idx >= focusKeys.length) return false;
  clearTileSelection();
  const key = focusKeys[idx]!;
  const refs = tileRefsByKey.get(key);
  if (refs) { refs.selected = true; setTileVisual(key, 2); }
  focusIdx = idx;
  void renderPreview();
  if (scroller) {
    try {
      const row = Math.floor(idx / colsAtBuild);
      const vh = renderer.terminalHeight - 3;
      const top = scroller.scrollTop;
      if (row * TILE_H < top) scroller.scrollTo({ x: 0, y: row * TILE_H });
      else if ((row + 1) * TILE_H > top + vh) scroller.scrollTo({ x: 0, y: (row + 1) * TILE_H - vh });
    } catch {}
  }
  return true;
};
const moveFocus = (dx: number, dy: number): boolean => {
  if (focusKeys.length === 0) return false;
  let next = focusIdx === -1 ? 0 : focusIdx + dx + dy * colsAtBuild;
  next = Math.max(0, Math.min(focusKeys.length - 1, next));
  if (next === focusIdx) return false;
  return selectTileAt(next);
};

type TileRefs = { iconSpec?: IconSpec; iconSlotId?: string; selected: boolean; baseFg: string; tileId: string; labelId: string; isDir: boolean };
const tileRefsByKey = new Map<string, TileRefs>();

const tileStates = (dim: boolean): IconState[] => {
  const norm = dim ? colors.sidebarFgMuted : colors.sidebarFg;
  return [
    { fg: norm, bg: colors.bg },
    { fg: norm, bg: colors.hoverBg },
    { fg: colors.accent, bg: colors.accentBg },
    { fg: colors.sidebarFgMuted, bg: colors.bg }, // 3 = cut (pending move)
  ];
};

const setTileVisual = (key: string, mode: 0 | 1 | 2) => {
  const refs = tileRefsByKey.get(key);
  if (!refs) return;
  const cut = mode === 0 && !refs.selected && isCutKey(key);
  setIconState(refs.iconSpec, cut ? 3 : mode);
  if (!refs.iconSpec) {
    // thumbnail slots have no state rasters — fade the whole slot instead
    try {
      const slot: any = renderer.root.findDescendantById(refs.iconSlotId ?? "");
      if (slot) slot.opacity = cut ? 0.45 : 1;
    } catch {}
  }
  const labelReal: any = renderer.root.findDescendantById(refs.labelId);
  if (labelReal) {
    try { labelReal.fg = mode === 2 ? colors.accent : cut ? colors.sidebarFgMuted : refs.baseFg; } catch {}
  }
  const tileReal: any = renderer.root.findDescendantById(refs.tileId);
  if (tileReal) {
    try {
      tileReal.backgroundColor = mode === 0 ? colors.bg : mode === 1 ? colors.hoverBg : colors.accentBg;
    } catch {}
  }
};

// --- inline rename: edit the tile label in place instead of a modal ---
let renameEdit: { key: string; inputId: string; createKind?: "file" | "folder" } | null = null;

const tileLabelFor = (name: string): string =>
  name.length > TILE_W - 2 ? name.slice(0, TILE_W - 5) + "…" : name;

// restores the plain label node; commit=true runs performRename afterwards
const finishInlineRename = (commit: boolean): void => {
  const edit = renameEdit;
  if (!edit) return;
  renameEdit = null;
  const input: any = renderer.root.findDescendantById(edit.inputId);
  const value = String(input?.value ?? "").trim();
  if (input) { try { input.parent?.remove(input); } catch {} }
  const refs = tileRefsByKey.get(edit.key);
  const tile: any = refs ? renderer.root.findDescendantById(refs.tileId) : null;
  if (refs && tile && !renderer.root.findDescendantById(refs.labelId)) {
    const labelText: any = Text({ id: refs.labelId, content: tileLabelFor(path.basename(edit.key)), fg: refs.baseFg });
    tile.add(labelText);
  }
  stripSelectable();
  if (!commit || !value) {
    if (edit.createKind) void rm(edit.key, { recursive: true }).then(() => renderAll());
    return;
  }
  if (value !== path.basename(edit.key)) {
    // create-unit is pushed BEFORE performRename so undo pops rename-back
    // first, then removes the entry entirely
    if (edit.createKind) pushUndoBatch(edit.createKind === "folder" ? "new folder" : "new file", [() => rm(edit.key, { recursive: true })]);
    void performRename(edit.key, value);
    return;
  }
  if (edit.createKind) {
    pushUndoBatch(edit.createKind === "folder" ? "new folder" : "new file", [() => rm(edit.key, { recursive: true })]);
    setStatusMsg(`Created ${value} · ctrl+z to undo`);
  }
};

const startInlineRename = (key: string): void => {
  if (renameEdit) finishInlineRename(false);
  const refs = tileRefsByKey.get(key);
  if (!refs) return;
  const tile: any = renderer.root.findDescendantById(refs.tileId);
  const label: any = renderer.root.findDescendantById(refs.labelId);
  if (!tile || !label || !existsSync(key)) return;
  // real class instance — mounts into the already-mounted tile
  const inputId = `tfm-rename-input`;
  const stale = renderer.root.findDescendantById(inputId);
  if (stale) { try { (stale as any).parent?.remove(stale); } catch {} }
  const input: any = new InputRenderable(renderer, {
    id: inputId,
    width: TILE_W - 2,
    value: path.basename(key),
    backgroundColor: colors.hoverBg,
    focusedBackgroundColor: colors.accentBg,
    textColor: colors.white,
  });
  try { tile.insertBefore(input, label); } catch { tile.add(input); }
  try { tile.remove(label); } catch {}
  renameEdit = { key, inputId };
  input.on?.("enter", () => finishInlineRename(true));
  const prevHandler = input.handleKeyPress?.bind(input);
  input.handleKeyPress = (k: any) => {
    if (k?.name === "escape") { finishInlineRename(false); return true; }
    return prevHandler ? prevHandler(k) : false;
  };
  setTimeout(() => { try { input.focus(); } catch {} }, 20);
  stripSelectable();
};

const uniqueUntitledName = (dir: string, base: string): string => {
  const dot = base.lastIndexOf(".");
  const stem = dot > 0 ? base.slice(0, dot) : base;
  const ext = dot > 0 ? base.slice(dot) : "";
  let n = base;
  let i = 2;
  while (existsSync(path.join(dir, n))) n = `${stem} ${i++}${ext}`;
  return n;
};

// nautilus-style: the entry is created immediately with a default name, then
// its label edits in place; esc/empty name deletes it again
const startInlineCreate = (kind: "file" | "folder"): void => {
  if (renameEdit) finishInlineRename(false);
  if (isVirtualCwd() || inTrashView()) return;
  const name = uniqueUntitledName(state.cwd, kind === "folder" ? "Untitled folder" : "Untitled.txt");
  const target = path.join(state.cwd, name);
  const made = kind === "folder"
    ? mkdir(target, { recursive: true })
    : writeFile(target, "");
  void made
    .then(() => renderGrid())
    .then(() => {
      const idx = focusKeys.indexOf(target);
      if (idx >= 0) selectTileAt(idx);
      startInlineRename(target);
    })
    .catch(() => setStatusMsg("Create failed"));
};

let selStatusGen = 0;
const updateSelectionStatusReal = () => {  const gen = ++selStatusGen;
  const sel: { key: string; isDir: boolean }[] = [];
  tileRefsByKey.forEach((r, k) => { if (r.selected) sel.push({ key: k, isDir: r.isDir }); });
  const setStatus = (s: string) => {
    if (gen !== selStatusGen) return;
    const status: any = renderer.root.findDescendantById("tfm-status-label");
    if (status) { try { status.content = s; } catch {} }
  };
  if (sel.length === 0) return setStatus("");
  // total size of the selected files (dirs contribute their item count instead)
  let bytes = 0;
  for (const s of sel) {
    if (!s.isDir) { try { bytes += statSync(s.key).size; } catch {} }
  }
  const dirs = sel.filter((s) => s.isDir);
  if (dirs.length === 0) {
    return setStatus(`${sel.length} selected${bytes > 0 ? ` · ${fmtBytes(bytes)}` : ""}`);
  }
  void (async () => {
    let contained = 0;
    await Promise.all(dirs.map(async (d) => {
      try { contained += (await readdir(d.key)).length; } catch {}
    }));
    const bits = [`${sel.length} selected`];
    if (bytes > 0) bits.push(fmtBytes(bytes));
    if (dirs.length === 1 && sel.length === 1) bits.push(`${contained} items`);
    setStatus(bits.join(" · "));
  })();
};

const clearTileSelection = () => {
  tileRefsByKey.forEach((refs, k) => {
    if (refs.selected) { refs.selected = false; setTileVisual(k, 0); }
  });
  updateSelectionStatus();
};

const updateSelectionStatus: () => void = () => updateSelectionStatusReal();

// --- File operations ---
type ClipItem = { path: string; isDir: boolean };
let clipboard: { mode: "copy" | "cut"; items: ClipItem[] } | null = null;

// cut (pending-move) tiles render dimmed, nautilus-style
const isCutKey = (key: string): boolean =>
  clipboard?.mode === "cut" && clipboard.items.some((i) => i.path === key);

// re-apply resting visuals after a cut/copy/paste so dimming tracks the clipboard
const refreshCutVisuals = (): void => {
  tileRefsByKey.forEach((refs, key) => { if (!refs.selected) setTileVisual(key, 0); });
};

let statusMsgTimer: any = null;
const setStatusMsg = (text: string) => {
  const status: any = renderer.root.findDescendantById("tfm-status-label");
  if (status) { try { status.content = text; } catch {} }
  if (statusMsgTimer) clearTimeout(statusMsgTimer);
  statusMsgTimer = setTimeout(() => updateSelectionStatusReal(), 2500);
};

const selPaths = (): ClipItem[] => {
  const out: ClipItem[] = [];
  tileRefsByKey.forEach((r, k) => { if (r.selected) out.push({ path: k, isDir: r.isDir }); });
  return out;
};

// --- Undo stack + override (conflict) prompt ---
type ConflictChoice = "replace" | "keepBoth" | "skip";
let conflictPolicy: ConflictChoice | null = null;

type UndoUnit = () => Promise<void> | void;
const undoStack: { label: string; units: UndoUnit[] }[] = [];

const pushUndoBatch = (label: string, units: UndoUnit[]): void => {
  if (!units.length) return;
  undoStack.push({ label, units });
  if (undoStack.length > 30) undoStack.shift();
};

const undoLast = (): void => {
  const entry = undoStack.pop();
  if (!entry) { setStatusMsg("Nothing to undo"); return; }
  void (async () => {
    let failed = 0;
    const failWhy = new Set<string>();
    for (let i = entry.units.length - 1; i >= 0; i--) {
      const u = entry.units[i];
      try { await u?.(); } catch (err) { failed++; failWhy.add(fsErrText(err)); }
    }
    renderAll();
    const why = [...failWhy][0];
    const summary = failed ? `Undo ${entry.label} · ${failed} FAILED${why ? ` (${why})` : ""}` : `Undid: ${entry.label}`;
    setStatusMsg(summary);
    notify(summary, failed ? "undo failed" : "undo");
  })();
};

let conflictOpen = false;
let conflictResolveFn: ((c: ConflictChoice) => void) | null = null;

const closeConflict = (c: ConflictChoice): void => {
  const scrim: any = renderer.root.findDescendantById("tfm-conflict");
  scrim?.parent?.remove(scrim);
  conflictOpen = false;
  const r = conflictResolveFn;
  conflictResolveFn = null;
  r?.(c);
};

const CONFLICT_W = 48;

const promptConflict = (destPath: string, remaining: number): Promise<ConflictChoice> =>
  new Promise<ConflictChoice>((resolve) => {
    closeFileMenu();
    if (propsOpen) closeProps();
    conflictOpen = true;
    conflictResolveFn = resolve;
    const name = path.basename(destPath);
    const parentName = path.basename(path.dirname(destPath)) || "/";
    let bseq = 0;
    const mkBtn = (label: string, onPick: () => void): ReturnType<typeof Box> => {
      const id = `tfm-conflict-b${bseq++}`;
      const setBg = (bg: string) => {
        const n: any = renderer.root.findDescendantById(id);
        if (n) { try { n.backgroundColor = bg; } catch {} }
      };
      return Box(
        {
          id,
          height: 1,
          flexGrow: 1,
          flexDirection: "row",
          justifyContent: "center",
          backgroundColor: colors.sidebarBg,
          onMouseDown: (ev: any) => { try { ev.stopPropagation?.(); } catch {}; onPick(); },
          onMouseOver: () => setBg(colors.hoverBg),
          onMouseOut: () => setBg(colors.sidebarBg),
        },
        Text({ content: label, fg: colors.sidebarFg }),
      );
    };
    const pick = (c: ConflictChoice, all?: ConflictChoice) => {
      if (all) conflictPolicy = all;
      closeConflict(c);
    };
    const rows: ReturnType<typeof Box>[] = [
      Box(
        { width: "100%", height: 1, paddingLeft: 1, paddingRight: 1 },
        Text({ content: ` Replace "${name.slice(0, CONFLICT_W - 14)}"?`, fg: colors.accent }),
      ),
      Box(
        { width: "100%", height: 1, paddingLeft: 1, paddingRight: 1 },
        Text({ content: " " + "~".repeat(CONFLICT_W - 2), fg: colors.divider }),
      ),
      Box(
        { width: "100%", height: 1, paddingLeft: 1, paddingRight: 1 },
        Text({ content: ` an item called "${name}" already exists in ${parentName}`.slice(0, CONFLICT_W - 1), fg: colors.sidebarFgMuted }),
      ),
      Box({ height: 1 }),
      Box(
        { width: "100%", height: 1, flexDirection: "row", columnGap: 1, paddingLeft: 1, paddingRight: 1 },
        mkBtn("[ Replace ]", () => pick("replace")),
        mkBtn("[ Keep both ]", () => pick("keepBoth")),
        mkBtn("[ Skip ]", () => pick("skip")),
      ),
    ];
    if (remaining > 0) {
      rows.push(
        Box({ height: 1 }),
        Box(
          { width: "100%", height: 1, flexDirection: "row", columnGap: 1, paddingLeft: 1, paddingRight: 1 },
          mkBtn("[ Replace all ]", () => pick("replace", "replace")),
          mkBtn("[ Keep both all ]", () => pick("keepBoth", "keepBoth")),
          mkBtn("[ Skip rest ]", () => pick("skip", "skip")),
        ),
      );
    }
    const scrim = Box(
      {
        id: "tfm-conflict",
        position: "absolute",
        left: 0,
        top: 0,
        width: "100%",
        height: "100%",
        alignItems: "center",
        paddingTop: Math.max(2, Math.round(renderer.terminalHeight / 3)),
        zIndex: 3400,
        backgroundColor: RGBA.fromInts(0, 0, 0, 150),
        onMouseDown: () => closeConflict("skip"),
      },
      Box(
        {
          id: "tfm-conflict-panel",
          width: CONFLICT_W,
          backgroundColor: colors.sidebarBg,
          paddingTop: 1,
          paddingBottom: 1,
          flexDirection: "column",
          onMouseDown: (ev: any) => { try { ev.stopPropagation?.(); } catch {} },
        },
        ...rows,
      ),
    );
    renderer.root.add(scrim);
    stripSelectable();
    void drainIconQueue();
  });

// --- live copy progress: floating toast (top-right) with pause/cancel ---
const prog = {
  active: false,
  verb: "copying",
  doneFiles: 0,
  totalFiles: 0,
  bytes: 0,
  totalBytes: 0,
  paused: false,
  cancelled: false,
  currentRs: null as ReturnType<typeof createReadStream> | null,
  toastUp: false,
};
let progLastPaint = 0;

const PROG_TOAST_ID = "tfm-prog-toast";
const PROG_T_TITLE = "tfm-prog-title";
const PROG_T_BAR = "tfm-prog-bar";
const PROG_T_BTNS = "tfm-prog-btns";
const PROG_W = 42;
const PROG_BAR_CELLS = 14;
// braille spinner frames (same as ~/loading_animation.py)
const SPIN_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
let progSpinIdx = 0;
let progSpinTimer: any = null;

const sleepMs = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const progSetText = (nodeId: string, s: string): void => {
  const n: any = renderer.root.findDescendantById(nodeId);
  if (n) { try { n.content = s; } catch {} }
};

const paintProgress = (force = false): void => {
  if (!prog.active || !prog.toastUp) return;
  const now = Date.now();
  if (!force && now - progLastPaint < 120) return;
  progLastPaint = now;
  const pct = prog.totalBytes > 0 ? Math.min(100, Math.floor((prog.bytes / prog.totalBytes) * 100)) : 0;
  const filled = Math.round((pct / 100) * PROG_BAR_CELLS);
  const spin = prog.paused ? "⏸" : SPIN_FRAMES[progSpinIdx];
  progSetText(PROG_T_TITLE, `${spin} ${prog.verb} ${prog.doneFiles}/${prog.totalFiles} (${pct}%)`);
  const line = "█".repeat(filled) + "░".repeat(Math.max(0, PROG_BAR_CELLS - filled)) + ` ${fmtBytes(prog.bytes)}/${fmtBytes(prog.totalBytes)}`;
  progSetText(PROG_T_BAR, line.slice(0, PROG_W - 2));
};

const showProgressToast = (): void => {
  if (prog.toastUp) return;
  prog.toastUp = true;
  const y = 1 + toasts.length * 4;
  const setPauseVisual = (): void => {
    const p: any = renderer.root.findDescendantById(progPauseSpec.slotId);
    const l: any = renderer.root.findDescendantById(progPlaySpec.slotId);
    try { if (p) p.visible = !prog.paused; } catch {}
    try { if (l) l.visible = !!prog.paused; } catch {}
  };
  // pause/play are different shapes → two slots stacked in one hit area
  // toast icons carry a hover state baked for the toast bg
  const progBtnStates = (): IconState[] => [
    { fg: colors.white, bg: colors.accentBg },
    { fg: colors.white, bg: colors.hoverBg },
  ];
  const progPaint = (spec: IconSpec, btnId: string, on: boolean) => {
    setIconState(spec, on ? 1 : 0);
    try {
      const n: any = renderer.root.findDescendantById(btnId);
      if (n) n.backgroundColor = on ? colors.hoverBg : colors.accentBg;
    } catch {}
  };
  const progPauseSpec = makeIconSlot("pause", progBtnStates(), 1, 0, undefined, progBtnStates);
  const progPlaySpec = makeIconSlot("play", progBtnStates(), 1, 0, undefined, progBtnStates);
  const progCloseSpec = makeIconSlot("close", progBtnStates(), 1, 0, undefined, progBtnStates);
  const scrimless = Box(
    {
      id: PROG_TOAST_ID,
      position: "absolute",
      left: renderer.terminalWidth + 2,
      top: y,
      width: PROG_W,
      height: 4,
      zIndex: 3500,
      backgroundColor: colors.accentBg,
      flexDirection: "column",
    },
    // ids live on the TEXT nodes — boxes have no .content, mutating them no-ops
    Box({ height: 1 }, Text({ id: PROG_T_TITLE, content: `${SPIN_FRAMES[0]} ${prog.verb}`, fg: colors.white })),
    Box({ height: 1 }, Text({ id: PROG_T_BAR, content: "", fg: colors.white })),
    Box(
      { id: PROG_T_BTNS, height: 1, flexDirection: "row", paddingLeft: 1, columnGap: 1 },
      (() => {
        const btn = Box(
          {
            id: "tfm-prog-pause",
            width: 2,
            height: 1,
            flexDirection: "row",
            backgroundColor: colors.accentBg,
            onMouseDown: () => {
              prog.paused = !prog.paused;
              if (!prog.paused) { try { prog.currentRs?.resume(); } catch {} }
              else { try { prog.currentRs?.pause(); } catch {} }
              setPauseVisual();
            },
            onMouseOver: () => progPaint(prog.paused ? progPlaySpec.spec : progPauseSpec.spec, "tfm-prog-pause", true),
            onMouseOut: () => progPaint(prog.paused ? progPlaySpec.spec : progPauseSpec.spec, "tfm-prog-pause", false),
          },
          progPauseSpec.el,
          progPlaySpec.el,
        );
        return btn;
      })(),
      Box(
        {
          id: "tfm-prog-close",
          width: 2,
          height: 1,
          flexDirection: "row",
          backgroundColor: colors.accentBg,
          onMouseDown: () => {
            prog.cancelled = true;
            try { prog.currentRs?.destroy(new Error("cancelled")); } catch {}
          },
          onMouseOver: () => progPaint(progCloseSpec.spec, "tfm-prog-close", true),
          onMouseOut: () => progPaint(progCloseSpec.spec, "tfm-prog-close", false),
        },
        progCloseSpec.el,
      ),
    ),
  );
  renderer.root.add(scrimless);
  // button Texts must not enter text-selection mode or they hijack the clicks
  stripSelectable();
  setPauseVisual(); // play slot ships visible — hide until actually paused
  void drainIconQueue();
  const real: any = renderer.root.findDescendantById(PROG_TOAST_ID);
  if (real) animateLeft(real, renderer.terminalWidth + 2, Math.max(0, renderer.terminalWidth - PROG_W - 2), 180);
  progSpinTimer = setInterval(() => {
    progSpinIdx = (progSpinIdx + 1) % SPIN_FRAMES.length;
    paintProgress(true);
  }, 100);
};

// swap to a terminal state (✓/✗ passed in title), linger briefly, slide away
const finishProgressToast = (title: string): void => {
  if (!prog.toastUp) return;
  prog.toastUp = false;
  if (progSpinTimer) { clearInterval(progSpinTimer); progSpinTimer = null; }
  progSetText(PROG_T_TITLE, title.slice(0, PROG_W - 2));
  progSetText(PROG_T_BAR, "");
  // done means the controls go away — nothing left to pause or cancel
  const btns: any = renderer.root.findDescendantById(PROG_T_BTNS);
  if (btns) { try { btns.visible = false; } catch {} }
  setTimeout(() => {
    const real: any = renderer.root.findDescendantById(PROG_TOAST_ID);
    if (!real) return;
    animateLeft(real, typeof real.left === "number" ? real.left : 0, renderer.terminalWidth + 2, 180);
    setTimeout(() => {
      try { (real.parent ?? renderer.root).remove(real); } catch {}
    }, 200);
  }, 1800);
};

// pause/cancel gates used between files AND mid-stream
const pauseGate = async (): Promise<void> => {
  while (prog.paused && !prog.cancelled) await sleepMs(80);
};

const scanTree = async (root: string): Promise<{ files: number; bytes: number }> => {
  let files = 0, bytes = 0;
  const stack = [root];
  while (stack.length) {
    const d = stack.pop()!;
    // lstat: a symlink counts once by its own size and is never followed
    // (following it would loop forever on cycles and duplicate target trees)
    let st;
    try { st = await lstat(d); } catch { continue; }
    if (!st.isDirectory()) { files++; bytes += st.size ?? 0; continue; }
    let kids;
    try { kids = await readdir(d); } catch { continue; }
    for (const k of kids) stack.push(path.join(d, k));
  }
  return { files, bytes };
};

const copyFileProgress = (src: string, dest: string): Promise<void> =>
  new Promise((resolve, reject) => {
    const rs = createReadStream(src);
    const ws = createWriteStream(dest);
    prog.currentRs = rs;
    rs.on("data", (c: any) => {
      prog.bytes += c?.length ?? 0;
      if (prog.paused) { try { rs.pause(); } catch {} }
      if (prog.cancelled) { try { rs.destroy(new Error("cancelled")); } catch {} }
      paintProgress();
    });
    const done = () => { if (prog.currentRs === rs) prog.currentRs = null; };
    let settled = false;
    ws.on("finish", () => { if (!settled) { settled = true; done(); resolve(); } });
    const fail = (e: any) => { if (!settled) { settled = true; done(); reject(e); } };
    ws.on("error", fail);
    rs.on("error", fail);
    rs.on("close", done);
    rs.pipe(ws);
  });

const copyTreeProgress = async (src: string, dest: string): Promise<void> => {
  const st = await lstat(src);
  if (st.isSymbolicLink()) {
    // recreate the link itself — never stream through to the target's contents
    await pauseGate();
    if (prog.cancelled) throw new Error("cancelled");
    await mkdir(path.dirname(dest), { recursive: true });
    const target = await readlink(src);
    try { await symlink(target, dest); } catch (err: any) { if (err?.code !== "EEXIST") throw err; }
    prog.doneFiles++;
    paintProgress(true);
    return;
  }
  if (st.isDirectory()) {
    await mkdir(dest, { recursive: true });
    for (const k of await readdir(src)) {
      await pauseGate();
      if (prog.cancelled) throw new Error("cancelled");
      await copyTreeProgress(path.join(src, k), path.join(dest, k));
    }
  } else {
    await pauseGate();
    if (prog.cancelled) throw new Error("cancelled");
    await mkdir(path.dirname(dest), { recursive: true });
    await copyFileProgress(src, dest);
    prog.doneFiles++;
    paintProgress(true);
  }
};

// terse human text for the fs error codes users actually hit — "FAILED" alone
// gives them nothing to act on (retry vs chmod vs free disk space)
const FS_ERR_TEXT: Record<string, string> = {
  ENOENT: "source gone",
  EACCES: "permission denied",
  EPERM: "permission denied",
  ENOSPC: "disk full",
  EBUSY: "file busy",
  ETXTBSY: "file busy",
  EISDIR: "is a directory",
  ENOTDIR: "not a directory",
  ENAMETOOLONG: "name too long",
  EROFS: "read-only fs",
  EMFILE: "too many open files",
};
const fsErrText = (err: unknown): string => {
  const code = (err as any)?.code;
  if (typeof code === "string") return FS_ERR_TEXT[code] ?? code.toLowerCase();
  return err instanceof Error ? err.message.split(":")[0]?.toLowerCase() ?? "unknown error" : "unknown error";
};

// every destructive-but-reversible file op funnels through here so overrides
// are asked once and undo covers the whole batch
async function runTransfer(op: "copy" | "move", destDir: string, srcs: string[], label: string): Promise<void> {
  conflictPolicy = null;
  const units: UndoUnit[] = [];
  let ok = 0, skipped = 0, replaced = 0, failed = 0, gone = 0;
  const failWhy = new Set<string>();
  const total = srcs.length;
  if (op === "copy") {
    // pre-scan so the progress toast has real totals from byte one
    prog.paused = false;
    prog.cancelled = false;
    prog.doneFiles = 0;
    prog.bytes = 0;
    let files = 0, bytes = 0;
    for (const s of srcs) {
      try { const r = await scanTree(s); files += r.files; bytes += r.bytes; } catch {}
    }
    prog.totalFiles = files || Math.max(1, total);
    prog.totalBytes = bytes;
    // tiny transfers don't need a toast
    if (prog.totalBytes > 4 * 1024 * 1024 || prog.totalFiles > 4) {
      prog.active = true;
      showProgressToast();
      paintProgress(true);
    }
  }
  let cancelled = false;
  try {
  for (const src of srcs) {
    if (cancelled || prog.cancelled) { cancelled = true; break; }
    await pauseGate();
    // source vanished since it was copied/cut — report clearly instead of a
    // cryptic mid-transfer ENOENT
    if (!existsSync(src)) { gone++; skipped++; continue; }
    const base = path.basename(src);
    let target = path.join(destDir, base);
    // nautilus semantics: paste-in-place never asks, it just makes "name (copy)"
    if (target === src && op === "copy") { target = uniqueTarget(destDir, base); }
    else if (target === src) { skipped++; continue; }
    else if (existsSync(target)) {
      const done = ok + skipped;
      const choice = conflictPolicy ?? await promptConflict(target, Math.max(0, total - done - 1));
      if (choice === "skip") { skipped++; continue; }
      if (choice === "keepBoth") target = uniqueTarget(destDir, base);
      else {
        // stash the victim in the trash so ctrl+z can bring it back;
        // re-check first — the target may have vanished while the prompt was up
        try {
          if (existsSync(target)) {
            const victimDest = target;
            const trashLoc = await xdgTrashMove(victimDest);
            units.push(async () => {
              await safeRestoreMove(trashLoc, victimDest);
              try { await rm(path.join(TRASH_DIR, "info", `${path.basename(trashLoc)}.trashinfo`)); } catch {}
            });
            replaced++;
          }
        } catch (err) { failWhy.add(fsErrText(err)); }
      }
    }
    try {
      if (op === "copy") await copyTreeProgress(src, target);
      else await fsMove(src, target);
      const t = target, s = src;
      if (op === "copy") units.push(() => xdgTrashMove(t).then(() => undefined));
      else units.push(() => safeRestoreMove(t, s));
      ok++;
    } catch (err) {
      // don't leave half-copied files behind
      if (op === "copy") { try { await rm(target, { recursive: true }); } catch {} }
      if (prog.cancelled) { cancelled = true; break; }
      failed++;
      failWhy.add(fsErrText(err));
    }
  }
  } finally {
    prog.active = false;
  }
  pushUndoBatch(label, units);
  renderAll();
  const verb = op === "copy" ? "Copied" : "Moved";
  const bits = [`${verb} ${ok} item${ok === 1 ? "" : "s"}`];
  if (replaced) bits.push(`${replaced} replaced`);
  if (skipped) bits.push(`${skipped} skipped`);
  if (gone) bits.push(`${gone} source gone`);
  const why = [...failWhy][0];
  if (failed) bits.push(`${failed} FAILED${why ? ` (${why})` : ""}`);
  if (ok || replaced) bits.push("ctrl+z to undo");
  const summary = bits.join(" · ");
  setStatusMsg(summary);
  // always surface the outcome — success, failure, or cancel
  if (prog.toastUp) {
    finishProgressToast(cancelled ? `✗ ${verb} cancelled` : failed ? `✗ ${op} failed` : `✓ ${verb} ${ok}`);
  }
  const destLabel = `to ~/${path.relative(home, destDir) || "/"}`;
  const msg = `${summary}${!cancelled && !failed && ok + replaced > 0 ? ` ${destLabel}` : ""}`;
  if (cancelled) notify(msg, `${op} cancelled`);
  else if (failed > 0 && ok === 0) notify(msg, `${op} failed`);
  else notify(msg, op);
}

// rename with nautilus-style collision handling: rename() would otherwise
// silently overwrite the existing file
const performRename = async (p: string, v: string): Promise<void> => {
  const dest = path.join(path.dirname(p), v);
  if (path.resolve(dest) === path.resolve(p)) { renderAll(); return; }
  let finalDest = dest;
  const units: UndoUnit[] = [];
  if (existsSync(finalDest)) {
    conflictPolicy = null;
    const choice = await promptConflict(finalDest, 0);
    if (choice === "skip") return;
    if (choice === "keepBoth") {
      finalDest = uniqueTarget(path.dirname(finalDest), path.basename(finalDest));
    } else {
      try {
        const victim = finalDest;
        const trashLoc = await xdgTrashMove(victim);
        units.push(async () => {
          await safeRestoreMove(trashLoc, victim);
          try { await rm(path.join(TRASH_DIR, "info", `${path.basename(trashLoc)}.trashinfo`)); } catch {}
        });
      } catch {}
    }
  }
  try {
    await fsRename(p, finalDest);
    units.push(() => fsRename(finalDest, p));
    pushUndoBatch("rename", units);
    renderAll();
    setStatusMsg(`Renamed to ${path.basename(finalDest)} · ctrl+z to undo`);
    notify(`Renamed to ${path.basename(finalDest)}`, "rename");
  } catch (err) {
    const summary = `Rename failed (${fsErrText(err)})`;
    setStatusMsg(summary);
    notify(`${path.basename(p)}: ${summary}`, "rename failed");
  }
};

const setClipboard = (mode: "copy" | "cut", items: ClipItem[]) => {
  clipboard = items.length ? { mode, items } : null;
  if (clipboard) toSystemClipboard(mode, items);
  setStatusMsg(clipboard ? `${mode === "cut" ? "Cut" : "Copied"} ${items.length} item${items.length === 1 ? "" : "s"}` : "");
  refreshCutVisuals();
};

// --- system clipboard bridge (Nautilus-style copied-files) ---
// Nautilus publishes files on the CLIPBOARD selection as MIME
// `x-special/gnome-copied-files`: first line = "copy"|"cut", then one
// file:// URI per line. wl-copy/xclip let us publish the same thing.
const CLIP_TYPE = "x-special/gnome-copied-files";

const sysClipTool = (): { get: string; put: string; putBase: string[]; getArgs: string[] } | null => {
  if (process.env.WAYLAND_DISPLAY) {
    return { get: "wl-paste", put: "wl-copy", putBase: [], getArgs: ["-t", CLIP_TYPE] };
  }
  if (process.env.DISPLAY) {
    // -l 4: serve a few requests (target probe + fetch) then exit so we don't own it forever
    return { get: "xclip", put: "xclip", putBase: ["-selection", "clipboard", "-l", "4"], getArgs: ["-selection", "clipboard", "-o", "-t", CLIP_TYPE] };
  }
  return null;
};

// We publish PLAIN TEXT full paths (one per line): pasting after tfm-copy
// yields e.g. /home/clark/test.md in any app. Wayland/X11 CLI tools can only
// offer ONE mime type per selection owner, and Nautilus file-paste needs
// x-special/gnome-copied-files — so text wins here; reading stays multi-type
// (we still accept gnome-copied-files from other apps on paste).
const toSystemClipboard = (mode: "copy" | "cut", items: ClipItem[]): void => {
  const t = sysClipTool();
  if (!t || !items.length) return;
  const payload = items.map((i) => i.path).join("\n");
  try {
    const p = spawn(t.put, [...t.putBase], { stdio: ["pipe", "ignore", "ignore"] });
    p.stdin?.end(payload);
    p.unref?.();
    dlog(`system clipboard <- ${mode} ${items.length} item(s) via ${t.put} (text paths)`);
  } catch (err) {
    dlog(`system clipboard FAILED: ${err}`);
  }
};

const pasteSmart = (dest: string): void => {
  if (clipboard?.items.length) {
    dlog(`paste: internal clipboard (${clipboard.items.length} items)`);
    void doPaste(dest);
    return;
  }
  const t = sysClipTool();
  if (!t) { dlog("paste: no system clipboard tool"); return; }
  dlog(`paste: reading system clipboard via ${t.get}`);
  void execFileP(t.get, t.getArgs)
    .then(({ stdout }) => {
      const text = String(stdout ?? "");
      const lines = text.split(/\r?\n/).filter(Boolean);
      dlog(`paste: system clip lines=${lines.length} head=${JSON.stringify(lines.slice(0, 2))}`);
      if (!lines.length) return;
      const op: "copy" | "move" = lines[0] === "cut" ? "move" : "copy";
      const body = lines[0] === "copy" || lines[0] === "cut" ? lines.slice(1) : lines;
      const paths = body
        .filter((l) => l.startsWith("file://"))
        .map((l) => {
          let u = l.slice(7);
          if (!u.startsWith("/")) u = u.slice(u.indexOf("/") + 1);
          try { u = decodeURIComponent(u); } catch {}
          return u;
        });
      if (!paths.length) { dlog("paste: no file:// uris in system clip"); return; }
      void runTransfer(op === "move" ? "move" : "copy", dest, paths, "system-clipboard paste");
    })
    .catch((err) => { dlog(`paste: system clipboard read failed: ${err}`); });
};

const uniqueTarget = (dir: string, base: string): string => {
  const dot = base.lastIndexOf(".");
  const stem = dot > 0 ? base.slice(0, dot) : base;
  const ext = dot > 0 ? base.slice(dot) : "";
  for (let i = 2; ; i++) {
    const cand = i === 2 ? path.join(dir, `${stem} (copy)${ext}`) : path.join(dir, `${stem} (copy ${i - 1})${ext}`);
    if (!existsSync(cand)) return cand;
  }
};

const fsMove = async (src: string, dest: string): Promise<void> => {
  try {
    await fsRename(src, dest);
  } catch (err: any) {
    if (err?.code !== "EXDEV") throw err;
    await cp(src, dest, { recursive: true });
    await rm(src, { recursive: true });
  }
};

// undo/restore moves must never clobber whatever now occupies the target —
// rename() silently overwrites on Linux, so a file created between the original
// op and ctrl+z would be destroyed. Bump to "name (copy)" instead.
const safeRestoreMove = async (src: string, dest: string): Promise<void> => {
  let d = dest;
  if (existsSync(d)) d = uniqueTarget(path.dirname(d), path.basename(d));
  await mkdir(path.dirname(d), { recursive: true });
  await fsMove(src, d);
};

const doPaste = async (dest: string): Promise<void> => {
  if (!clipboard || clipboard.items.length === 0) return;
  const mode = clipboard.mode === "copy" ? "copy" : "move";
  const srcs = clipboard.items.map((i) => i.path);
  clipboard = null;
  refreshCutVisuals();
  await runTransfer(mode, dest, srcs, mode === "copy" ? "paste" : "paste (move)");
};

// --- drag-to-move (press tile → drag → drop on folder tile or sidebar place) ---
let dragKeys: ClipItem[] | null = null;
let dragCtrl = false; // ctrl+drag = internal move, plain drag = external OSC 72
let dragActive = false;
let dropTargetKey: string | null = null;
let dragStartX = 0;
let dragStartY = 0;

// ctrl+press defers its toggle until we know it was a click, not a drag —
// toggling at mousedown unselected the pressed tile and emptied the payload
let ctrlPendingKey: string | null = null;
let ctrlPendingState = false;
const commitPendingCtrlToggle = (): void => {
  const k = ctrlPendingKey;
  ctrlPendingKey = null;
  if (!k || dragActive) return;
  const refs = tileRefsByKey.get(k);
  if (!refs) return;
  refs.selected = ctrlPendingState;
  setTileVisual(k, ctrlPendingState ? 2 : 0);
  updateSelectionStatusReal();
  void renderPreview();
};

const DRAG_GHOST_ID = "tfm-drag-ghost";

const updateDragGhost = (x: number, y: number): void => {
  const g: any = renderer.root.findDescendantById(DRAG_GHOST_ID);
  if (!g) return;
  try {
    const n = dragKeys?.length ?? 0;
    const label = `moving ${n} item${n === 1 ? "" : "s"}`;
    const t: any = renderer.root.findDescendantById(`${DRAG_GHOST_ID}-label`);
    if (t && t.content !== label) t.content = label;
    g.width = label.length + 2;
    g.left = Math.max(0, Math.min(x + 1, renderer.terminalWidth - label.length - 2));
    g.top = Math.max(0, Math.min(y + 1, renderer.terminalHeight - 1));
    g.visible = true;
  } catch {}
};

const hideDragGhost = (): void => {
  const g: any = renderer.root.findDescendantById(DRAG_GHOST_ID);
  if (g) { try { g.visible = false; } catch {} }
};

const finishDragState = (): void => {
  dlog(`finishDragState active=${dragActive} target=${dropTargetKey}`);
  ctrlPendingKey = null;
  hideDragGhost();
  dragCtrl = false;
  if (dropTargetKey) {
    const r = tileRefsByKey.get(dropTargetKey);
    if (r && !r.selected) setTileVisual(dropTargetKey, 0);
  }
  dropTargetKey = null;
  dragActive = false;
  dragKeys = null;
};

// release fires on the source before `drop` reaches the target — defer cleanup
const scheduleDragCleanup = (): void => { setTimeout(finishDragState, 0); };

const moveInto = async (destDir: string, items: ClipItem[]): Promise<void> => {
  const srcs = items
    .filter((it) => !(it.isDir && (destDir === it.path || destDir.startsWith(it.path + path.sep))))
    .map((it) => it.path);
  dlog(`moveInto dest=${destDir} in=${items.length} out=${srcs.length} dropped=[${items.filter((it) => it.isDir && (destDir === it.path || destDir.startsWith(it.path + path.sep))).map((it) => it.path.split("/").pop()).join(",")}]`);
  await runTransfer("move", destDir, srcs, `move to ${path.basename(destDir) || "/"}`);
};

// --- Embedded terminal pane ("Open Terminal Here") ---
// OpenTUI's EmbeddedTerminalRenderable draws the VT stream; the PTY belongs to
// Bun.spawn({ terminal }). Keys route to the shell while focused; clicking the
// grid or sidebar hands focus back to tfm.
const TERM_H = 12;
let term: EmbeddedTerminalRenderable | null = null;
let termChild: ReturnType<typeof Bun.spawn> | null = null;
let termFocused = false;

// the flag can lag reality (click-refocus inside the pane bypasses our focus()
// call) — ask the renderer who owns the keyboard before acting on keys
const termHasFocus = (): boolean =>
  !!term && renderer.currentFocusedRenderable === (term as any);

const blurTerminal = (): void => {
  if (!termFocused) return;
  try { term?.blur(); } catch {}
  termFocused = false;
};

// "#rrggbb" -> xterm "rgb:RRRR/GGGG/BBBB" (8-bit channel doubled to 16-bit)
const hexToRgb16 = (hex: string): string => {
  const b = (/^#?([0-9a-f]{6})$/i.exec(hex.trim()) ?? [, "ffffff"])[1];
  const ch = (i: number) => `${b.slice(i, i + 2)}${b.slice(i, i + 2)}`;
  return `${ch(0)}/${ch(2)}/${ch(4)}`;
};

// make the embedded terminal match the tfm theme: OSC 4 sets the 16-color
// palette (so ls/vim/prompts stop floating on stock xterm hues) and
// OSC 10/11/12 set the default fg/bg/cursor
const syncTerminalTheme = (): void => {
  if (!term) return;
  try {
    const enc = new TextEncoder();
    const spec = (hex: string) => `rgb:${hexToRgb16(hex)}`;
    const osc4 = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]
      .map((i) => `${i};${spec((colors as any)[`ansi${i}`] ?? colors.white)}`)
      .join(";");
    term.write(new Uint8Array([
      ...enc.encode(`\x1b]4;${osc4}\x1b\\`),
      ...enc.encode(`\x1b]10;${spec(colors.white)}\x1b\\`),
      ...enc.encode(`\x1b]11;${spec(colors.bg)}\x1b\\`),
      ...enc.encode(`\x1b]12;${spec(colors.accent)}\x1b\\`),
    ]));
  } catch {}
};

const closeTerminalPane = (): void => {
  try { term?.blur(); } catch {};
  try { termChild?.kill(); } catch {};
  try { (termChild as any)?.terminal?.close(); } catch {};
  termChild = null;
  try { term?.destroy(); } catch {};
  term = null;
  termFocused = false;
  const host: any = renderer.root.findDescendantById("tfm-term-host");
  if (host) { [...host.getChildren()].forEach((c: any) => host.remove(c)); host.height = 0; }
  renderAll();
};

// fish waits up to 10s for a Primary Device Attribute reply the embedded VT
// never sends (boot stalls with a "could not read response" warning). Answer
// the common probes inline; sequences may split across chunks, hence the tail.
const termProbeEnc = new TextEncoder();
let termProbeTail = "";
const answerTerminalProbes = (data: Uint8Array): void => {
  try {
    const pty = (termChild as any)?.terminal;
    if (!pty) return;
    const buf = termProbeTail + new TextDecoder().decode(data);
    let resp = "";
    if (/\x1b\[[0-9]*c/.test(buf)) resp += "\x1b[?62;1;2;6;9;15;22c"; // DA1 (tmux-style vt320)
    if (/\x1b\[>[0-9]*c/.test(buf)) resp += "\x1b[>0;0;0c";           // secondary DA
    if (/\x1b\[5n/.test(buf)) resp += "\x1b[0n";                      // device status OK
    if (resp) pty.write(termProbeEnc.encode(resp));
    termProbeTail = /(?:\x1b|\x1b\[|\x1b\[>)[0-9=>]*$/.test(buf) ? buf.slice(-8) : "";
  } catch {}
};

const openTerminalHere = (dir?: string): void => {
  if (!renderer.resolution) return;
  if (term) { try { term.focus(); } catch {}; termFocused = true; return; }
  const host: any = renderer.root.findDescendantById("tfm-term-host");
  if (!host) return;
  const cwd = dir ?? (isVirtualCwd() ? home : state.cwd);
  host.height = TERM_H + 1;
  const header = Box(
    { id: "tfm-term-header", width: "100%", height: 1, flexDirection: "row", paddingLeft: 1, backgroundColor: colors.sidebarBg },
    Text({ content: ` terminal · ${cwd}`, fg: colors.sidebarFgMuted }),
    Box({ flexGrow: 1 }),
    escHintBtn("tfm-esc-term", closeTerminalPane),
  );
  term = new EmbeddedTerminalRenderable(renderer, {
    id: "tfm-term",
    width: "100%",
    height: TERM_H,
    cols: Math.max(20, renderer.terminalWidth - sw),
    rows: TERM_H,
    maxScrollback: 20_000,
    onData: (data: Uint8Array) => {
      (termChild as any)?.terminal?.write(data);
    },
    onTerminalResize: (cols: number, rows: number) => {
      try { (termChild as any)?.terminal?.resize(cols, rows); } catch {}
    },
  });
  host.add(header);
  host.add(term);
  stripSelectable();
  const shell = process.env.SHELL || "/bin/bash";
  try {
    termChild = Bun.spawn([shell], {
      cwd,
      env: { ...process.env, TERM: "xterm-256color", COLORTERM: "truecolor" },
      terminal: {
        cols: Math.max(20, renderer.terminalWidth - sw),
        rows: TERM_H,
        data(_pty: any, data: Uint8Array) {
          answerTerminalProbes(data);
          try { term?.write(data); } catch {}
        },
      },
    } as any);
  } catch (err) {
    notify(`terminal failed (${fsErrText(err)})`, "terminal");
    closeTerminalPane();
    return;
  }
  termChild.exited.then(() => { if (termChild) closeTerminalPane(); }).catch(() => {});
  syncTerminalTheme();
  void drainIconQueue();
  renderAll();
  setTimeout(() => {
    try { term?.focus(); termFocused = true; } catch {}
    // early prompt bytes can compose before first layout — force a full redraw
    try { term?.invalidate(); } catch {}
  }, 30);
};

const xdgTrashMove = async (p: string): Promise<string> => {
  const trashDir = path.join(home, ".local/share/Trash");
  const filesDir = path.join(trashDir, "files");
  const infoDir = path.join(trashDir, "info");
  await mkdir(filesDir, { recursive: true });
  await mkdir(infoDir, { recursive: true });
  const base = path.basename(p);
  let name = base;
  for (let i = 2; existsSync(path.join(filesDir, name)); i++) name = `${base}.${i}`;
  const stamp = new Date().toISOString().replace(/\.\d+Z$/, "Z");
  await writeFile(path.join(infoDir, `${name}.trashinfo`), `[Trash Info]\nPath=${p}\nDeletionDate=${stamp}\n`);
  const finalPath = path.join(filesDir, name);
  await fsMove(p, finalPath);
  return finalPath;
};

const trashPaths = (paths: string[]): void => {
  void (async () => {
    const units: UndoUnit[] = [];
    let ok = 0;
    const failWhy = new Set<string>();
    for (const p of paths) {
      // always trash via our own xdg path: we control the final name, so the
      // undo unit pairs deterministically (a before/after listing diff could
      // mis-pair when something else trashes a similar name concurrently)
      try {
        const loc = await xdgTrashMove(p);
        const hit = path.basename(loc);
        const from = path.join(TRASH_DIR, "files", hit);
        units.push(async () => {
          await safeRestoreMove(from, p);
          try { await rm(path.join(TRASH_DIR, "info", `${hit}.trashinfo`)); } catch {}
        });
        ok++;
      } catch (err) { failWhy.add(fsErrText(err)); }
    }
    pushUndoBatch(`trash ${ok} item${ok === 1 ? "" : "s"}`, units);
    renderAll();
    const failed = paths.length - ok;
    const why = [...failWhy][0];
    const summary = failed
      ? `Trashed ${ok}/${paths.length} · ${failed} FAILED${why ? ` (${why})` : ""}`
      : `Trashed ${ok} item${ok === 1 ? "" : "s"}`;
    setStatusMsg(ok === paths.length ? `${summary} · ctrl+z to undo` : summary);
    if (failed > 0) notify(summary, "trash failed");
    else notify(`${summary} · ctrl+z to undo`, "trash");
  })();
};

// --- Trash management: restore / delete-permanently / empty ---
const TRASH_DIR = path.join(home, ".local/share/Trash");

const inTrashView = (): boolean => path.resolve(state.cwd) === path.join(TRASH_DIR, "files");

const trashOrigPath = async (name: string): Promise<string | null> => {
  try {
    const raw = await readFile(path.join(TRASH_DIR, "info", `${name}.trashinfo`), "utf8");
    const m = raw.match(/^Path=(.+)$/m);
    if (!m?.[1]) return null;
    let p = m[1].trim();
    // spec says URL-encoded; nautilus writes bare encoded abs paths
    if (p.startsWith("file://")) p = p.slice(7);
    try { p = decodeURIComponent(p); } catch {}
    return path.resolve(p);
  } catch { return null; }
};

const restoreFromTrash = (paths: string[]): void => {
  void (async () => {
    let ok = 0;
    const failWhy = new Set<string>();
    for (const src of paths) {
      const orig = await trashOrigPath(path.basename(src));
      if (!orig) { failWhy.add("no trashinfo"); continue; }
      try {
        await mkdir(path.dirname(orig), { recursive: true });
        let dest = orig;
        if (existsSync(dest)) dest = uniqueTarget(path.dirname(dest), path.basename(dest));
        await fsMove(src, dest);
        try { await rm(path.join(TRASH_DIR, "info", `${path.basename(src)}.trashinfo`)); } catch {}
        ok++;
      } catch (err) { failWhy.add(fsErrText(err)); }
    }
    renderAll();
    const failed = paths.length - ok;
    const why = [...failWhy][0];
    const summary = `Restored ${ok} of ${paths.length}${failed ? ` · ${failed} FAILED${why ? ` (${why})` : ""}` : ""}`;
    setStatusMsg(summary);
    notify(summary, failed ? "restore failed" : "restore");
  })();
};

const deleteForever = (paths: string[]): void => {
  void (async () => {
    let ok = 0;
    const failWhy = new Set<string>();
    for (const p of paths) {
      try {
        await rm(p, { recursive: true });
        try { await rm(path.join(TRASH_DIR, "info", `${path.basename(p)}.trashinfo`)); } catch {}
        ok++;
      } catch (err) { failWhy.add(fsErrText(err)); }
    }
    renderAll();
    const failed = paths.length - ok;
    const why = [...failWhy][0];
    const summary = `Deleted ${ok} of ${paths.length}${failed ? ` · ${failed} FAILED${why ? ` (${why})` : ""}` : ""}`;
    setStatusMsg(summary);
    notify(summary, failed ? "delete failed" : "delete");
  })();
};

const emptyTrash = (): void => {
  void (async () => {
    const filesDir = path.join(TRASH_DIR, "files");
    let names: string[];
    try { names = await readdir(filesDir); } catch (err) {
      renderAll();
      notify(`Could not read trash (${fsErrText(err)})`, "empty failed");
      setStatusMsg("Trash unreadable");
      return;
    }
    let n = 0;
    const failWhy = new Set<string>();
    for (const k of names) {
      try {
        await rm(path.join(filesDir, k), { recursive: true });
        try { await rm(path.join(TRASH_DIR, "info", `${k}.trashinfo`)); } catch {}
        n++;
      } catch (err) { failWhy.add(fsErrText(err)); }
    }
    renderAll();
    const failed = names.length - n;
    const why = [...failWhy][0];
    if (failed > 0) {
      notify(`Emptied ${n}/${names.length} · ${failed} FAILED${why ? ` (${why})` : ""}`, "empty failed");
      setStatusMsg(`Trash partially emptied (${n}/${names.length})`);
      return;
    }
    notify(`Emptied ${n} item${n === 1 ? "" : "s"}`, "trash");
    setStatusMsg(`Trash emptied (${n})`);
  })();
};

let yesNoOpen = false;

const closeYesNo = (): void => {
  const scrim: any = renderer.root.findDescendantById("tfm-yesno");
  scrim?.parent?.remove(scrim);
  yesNoOpen = false;
};

// floating Yes/No confirmation dialog (replaces the old context-menu confirms)
const confirmYesNo = (message: string, yesLabel: string, onYes: () => void, danger = false): boolean => {
  if (yesNoOpen || !renderer.resolution) return false;
  yesNoOpen = true;
  const W = MENU_W;
  let bseq = 0;
  const mkBtn = (label: string, fg: string, onPick: () => void): ReturnType<typeof Box> => {
    const id = `tfm-yesno-b${bseq++}`;
    const setBg = (bg: string) => {
      const n: any = renderer.root.findDescendantById(id);
      if (n) { try { n.backgroundColor = bg; } catch {} }
    };
    return Box(
      {
        id,
        height: 1,
        flexGrow: 1,
        flexDirection: "row",
        justifyContent: "center",
        backgroundColor: colors.sidebarBg,
        onMouseDown: (ev: any) => { try { ev.stopPropagation?.(); } catch {}; onPick(); },
        onMouseOver: () => setBg(colors.hoverBg),
        onMouseOut: () => setBg(colors.sidebarBg),
      },
      Text({ content: label, fg }),
    );
  };
  const yesFg = danger ? colors.ansi1 : colors.accent;
  const scrim = Box(
    {
      id: "tfm-yesno",
      position: "absolute",
      left: 0,
      top: 0,
      width: "100%",
      height: "100%",
      alignItems: "center",
      paddingTop: Math.max(2, Math.round(renderer.terminalHeight / 3)),
      zIndex: 3450,
      backgroundColor: RGBA.fromInts(0, 0, 0, 150),
      onMouseDown: () => closeYesNo(),
    },
    Box(
      {
        id: "tfm-yesno-panel",
        width: W,
        backgroundColor: colors.sidebarBg,
        paddingTop: 1,
        paddingBottom: 1,
        flexDirection: "column",
        onMouseDown: (ev: any) => { try { ev.stopPropagation?.(); } catch {} },
      },
      Box(
        { width: "100%", height: 1, paddingLeft: 1, paddingRight: 1 },
        Text({ content: ` ${message}`.slice(0, W - 2), fg: yesFg }),
      ),
      Box(
        { width: "100%", height: 1, paddingLeft: 1, paddingRight: 1 },
        Text({ content: " " + "~".repeat(W - 2), fg: colors.divider }),
      ),
      Box({ height: 1 }),
      Box(
        { width: "100%", height: 1, flexDirection: "row", columnGap: 1, paddingLeft: 1, paddingRight: 1 },
        mkBtn("[ No ]", colors.sidebarFg, () => closeYesNo()),
        mkBtn(`[ ${yesLabel} ]`, yesFg, () => { closeYesNo(); onYes(); }),
      ),
    ),
  );
  renderer.root.add(scrim);
  stripSelectable();
  return true;
};

const confirmEmptyTrash = (): void => {
  confirmYesNo("Empty Trash?", "Empty", () => emptyTrash(), true);
};

const confirmDeleteForever = (paths: string[]): void => {
  confirmYesNo(`Permanently delete ${paths.length} item${paths.length === 1 ? "" : "s"}?`, "Delete", () => deleteForever(paths), true);
};

// --- Preview pane ---
const TEXT_PREVIEW_MAX = 262144;
const isTextLike = (name: string): boolean => {
  const ext = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1).toLowerCase() : "";
  if (FILE_ICON_BY_EXT[ext] === "file-image" || FILE_ICON_BY_EXT[ext] === "file-video") return false;
  // known-text extensions win even when globs2 reports an odd mime
  // (e.g. toml → application/toml used to fall through the cracks)
  if (["md", "markdown", "txt", "log", "json", "yaml", "yml", "toml", "ini", "conf", "cfg", "html", "css", "csv", "lock", "env"].includes(ext)
    || FILE_ICON_BY_EXT[ext] === "file-code"
    || FILE_ICON_BY_EXT[ext] === "file-document") return true;
  const mime = globs2ByExt?.get(ext);
  if (!mime) return false;
  return mime.startsWith("text/") || /^(application\/(json|xml|javascript|x-yaml|x-sh|toml))/.test(mime) || mime.endsWith("+xml");
};

// --- properties helpers ---
const fmtBytes = (n: number): string => {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = n, i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${i === 0 ? v : v.toFixed(1)} ${units[i]}`;
};

// rwx triad -> plain words; execute means "run" for files, "enter" for folders
const permWords = (mode: number, shift: number, isDir: boolean): string => {
  const r = !!(mode & (4 << shift));
  const w = !!(mode & (2 << shift));
  const x = !!(mode & (1 << shift));
  if (!r && !w && !x) return "no access";
  const out: string[] = [];
  if (r) out.push("read");
  if (w) out.push("write");
  if (x) out.push(isDir ? "enter" : "run");
  return out.join(", ");
};

let idNameCache: Map<number, string> | null = null;
const idName = (uid: number): string => {
  idNameCache ??= (() => {
    const m = new Map<number, string>();
    try {
      for (const line of readFileSync("/etc/passwd", "utf8").split("\n")) {
        const p = line.split(":");
        const uidN = Number(p[2]);
        if (p[0] && Number.isFinite(uidN)) m.set(uidN, p[0]);
      }
    } catch {}
    return m;
  })();
  return idNameCache.get(uid) ?? String(uid);
};

const fmtDate = (ms?: number): string => {
  if (!ms) return "-";
  const d = new Date(ms);
  const p2 = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`;
};

const mimeLabelFor = (name: string): string => {
  const dot = name.lastIndexOf(".");
  const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
  const mime = globs2ByExt?.get(ext);
  if (mime) return mime;
  const cat = FILE_ICON_BY_EXT[ext];
  return cat === "file-image" ? "image/*"
    : cat === "file-video" ? "video/*"
    : cat === "file-music" ? "audio/*"
    : cat === "zip-box" ? "archive"
    : cat === "file-pdf-box" ? "application/pdf"
    : cat === "file-code" ? "code"
    : cat === "file-document" ? "document"
    : "data";
};

// recursive dir totals; null when the tree is absurdly large
const dirWalkStats = async (root: string): Promise<{ bytes: number; files: number; folders: number } | null> => {
  let bytes = 0, files = 0, folders = 0, count = 0;
  const stack: string[] = [root];
  while (stack.length) {
    const dir = stack.pop()!;
    let dirents;
    try { dirents = await readdir(dir, { withFileTypes: true }); } catch { continue; }
    for (const d of dirents) {
      if (++count > 200000) return null;
      const p = path.join(dir, d.name);
      // symlinks: report the link's own size, never follow (cycles / dupes)
      if (d.isSymbolicLink()) { files++; try { bytes += (await lstat(p)).size; } catch {} continue; }
      if (d.isDirectory()) { folders++; stack.push(p); continue; }
      files++;
      try { bytes += (await stat(p)).size; } catch {}
    }
  }
  return { bytes, files, folders };
};

let previewGen = 0;

// --- syntax highlighting for the preview pane (tree-sitter via @opentui/core) ---
// bundled grammars: javascript, typescript, markdown, zig. Extra languages are
// registered opencode-style: wasm + query URLs, downloaded once and cached by
// the client's download utils.
const EXTRA_PARSERS = [
  {
    filetype: "json",
    wasm: "https://github.com/tree-sitter/tree-sitter-json/releases/download/v0.24.8/tree-sitter-json.wasm",
    queries: { highlights: ["https://raw.githubusercontent.com/nvim-treesitter/nvim-treesitter/refs/heads/master/queries/json/highlights.scm"] },
  },
  {
    filetype: "bash",
    wasm: "https://github.com/tree-sitter/tree-sitter-bash/releases/download/v0.25.0/tree-sitter-bash.wasm",
    queries: { highlights: ["https://raw.githubusercontent.com/nvim-treesitter/nvim-treesitter/refs/heads/master/queries/bash/highlights.scm"] },
  },
  {
    filetype: "python",
    wasm: "https://github.com/tree-sitter/tree-sitter-python/releases/download/v0.23.6/tree-sitter-python.wasm",
    queries: { highlights: ["https://github.com/tree-sitter/tree-sitter-python/raw/refs/heads/master/queries/highlights.scm"] },
  },
  {
    filetype: "rust",
    wasm: "https://github.com/tree-sitter/tree-sitter-rust/releases/download/v0.24.0/tree-sitter-rust.wasm",
    queries: { highlights: ["https://raw.githubusercontent.com/nvim-treesitter/nvim-treesitter/refs/heads/master/queries/rust/highlights.scm"] },
  },
  {
    filetype: "go",
    wasm: "https://github.com/tree-sitter/tree-sitter-go/releases/download/v0.25.0/tree-sitter-go.wasm",
    queries: { highlights: ["https://raw.githubusercontent.com/nvim-treesitter/nvim-treesitter/refs/heads/master/queries/go/highlights.scm"] },
  },
  {
    filetype: "css",
    wasm: "https://github.com/tree-sitter/tree-sitter-css/releases/download/v0.25.0/tree-sitter-css.wasm",
    queries: { highlights: ["https://raw.githubusercontent.com/nvim-treesitter/nvim-treesitter/refs/heads/master/queries/css/highlights.scm"] },
  },
  {
    filetype: "yaml",
    wasm: "https://github.com/tree-sitter-grammars/tree-sitter-yaml/releases/download/v0.7.2/tree-sitter-yaml.wasm",
    queries: { highlights: ["https://raw.githubusercontent.com/nvim-treesitter/nvim-treesitter/refs/heads/master/queries/yaml/highlights.scm"] },
  },
  {
    filetype: "toml",
    wasm: "https://github.com/tree-sitter-grammars/tree-sitter-toml/releases/download/v0.7.0/tree-sitter-toml.wasm",
    queries: { highlights: ["https://raw.githubusercontent.com/nvim-treesitter/nvim-treesitter/master/queries/toml/highlights.scm"] },
  },
];
addDefaultParsers(EXTRA_PARSERS);

const PREVIEW_FT_BY_EXT: Record<string, string> = {
  js: "javascript", mjs: "javascript", cjs: "javascript", jsx: "javascriptreact",
  ts: "typescript", mts: "typescript", cts: "typescript", tsx: "typescriptreact",
  md: "markdown", markdown: "markdown", mdx: "markdown",
  zig: "zig",
  json: "json", jsonc: "json",
  sh: "bash", bash: "bash", zsh: "bash",
  py: "python", rs: "rust", go: "go",
  css: "css", scss: "css",
  yml: "yaml", yaml: "yaml",
  toml: "toml",
};

let previewSyntaxStyle: InstanceType<typeof SyntaxStyle> | null = null;
let previewSyntaxSig = "";
const getPreviewSyntaxStyle = () => {
  const t = colors as Theme;
  const sig = [t.accent, t.white, t.sidebarFg, t.sidebarFgMuted,
    t.syntaxString, t.syntaxNumber, t.syntaxType, t.syntaxFunction, t.syntaxOperator, t.syntaxProperty].join("|");
  if (!previewSyntaxStyle || previewSyntaxSig !== sig) {
    try { previewSyntaxStyle?.destroy(); } catch {}
    // cached nodes hold a reference to the old style
    previewCodeCache = null;
    previewSyntaxStyle = SyntaxStyle.fromStyles({
      keyword: { fg: t.accent, bold: true },
      string: { fg: t.syntaxString ?? "#9ece6a" },
      comment: { fg: t.sidebarFgMuted, italic: true },
      function: { fg: t.syntaxFunction ?? "#7aa2f7" },
      method: { fg: t.syntaxFunction ?? "#7aa2f7" },
      type: { fg: t.syntaxType ?? "#2ac3de" },
      "type.builtin": { fg: t.syntaxType ?? "#2ac3de" },
      number: { fg: t.syntaxNumber ?? "#ff9e64" },
      constant: { fg: t.syntaxNumber ?? "#ff9e64" },
      "constant.builtin": { fg: t.syntaxNumber ?? "#bb9af7" },
      operator: { fg: t.syntaxOperator ?? t.white },
      punctuation: { fg: t.sidebarFgMuted },
      property: { fg: t.syntaxProperty ?? "#73daca" },
      variable: { fg: t.sidebarFg },
    });
    previewSyntaxSig = sig;
  }
  return previewSyntaxStyle;
};
let previewCodeSeq = 0;
// reuse the (already-parsed/highlighted) node when the same file is previewed again
let previewCodeCache: { key: string; mtimeMs: number; size: number; node: any } | null = null;

const renderPreview = async () => {
  if (!config.ui.previewEnabled) return;
  const gen = ++previewGen;
  const pane: any = renderer.root.findDescendantById("tfm-preview");
  if (!pane) return;
  [...pane.getChildren()].forEach((c: any) => pane.remove(c));

  // target = focused tile, else single selected, else folder summary
  let key: string | null = null;
  if (focusIdx >= 0 && focusKeys[focusIdx]) key = focusKeys[focusIdx]!;
  else {
    let selCount = 0;
    let selKey: string | null = null;
    tileRefsByKey.forEach((r, k) => { if (r.selected) { selCount++; selKey = k; } });
    if (selCount === 1 && selKey) key = selKey;
    else if (selCount > 1) {
      pane.add(Text({ content: `${selCount} items selected`, fg: colors.sidebarFg }));
      return;
    }
  }

  if (!key || !existsSync(key)) {
    pane.add(Box({ height: 1 }));
    pane.add(Text({ content: "no selection", fg: colors.sidebarFgMuted }));
    return;
  }

  let st: any = null;
  try { st = statSync(key); } catch { return; }
  if (gen !== previewGen) return;
  const isDirTarget = st.isDirectory();

  pane.add(Text({ content: ` ${path.basename(key)}${isDirTarget ? "/" : ""}`, fg: colors.white }));
  pane.add(Text({ content: "~".repeat(Math.max(0, config.ui.previewWidth - 2)), fg: colors.divider }));

  // metadata lives in right-click -> Properties…; the pane shows content only
  if (isDirTarget) {
    void drainIconQueue();
    return;
  }

  // pictures: render the actual image (svg included) instead of nothing
  if (fileIsImage(key) && st.size > 0 && st.size <= 26214400) {
    const w = Math.max(4, config.ui.previewWidth - 4);
    const maxH = Math.max(4, renderer.terminalHeight - 8);
    const h = Math.min(maxH, Math.max(3, Math.round(w / cellMetrics().aspect)));
    const slotId = `tfm-icon-${iconSeq++}`;
    pane.add(Box(
      { width: "100%", flexDirection: "row", justifyContent: "center" },
      Box({ id: slotId, width: w, height: h }),
    ));
    thumbJobs.push({
      slotId,
      path: key,
      mtimeMs: st.mtimeMs ?? 0,
      size: st.size,
      wCells: w,
      hCells: h,
      bg: colors.sidebarBg,
      vector: key.toLowerCase().endsWith(".svg"),
      fallbackGlyph: glyph[fileIconFor(key) as keyof typeof glyph] ?? glyph.file!,
    });
    void drainThumbs();
    return;
  }

  if (!isTextLike(key) || st.size > TEXT_PREVIEW_MAX) return;

  try {
    const text = (await readFile(key, "utf8")).slice(0, 65536);
    if (gen !== previewGen) return;
    const mtimeMs = st.mtimeMs ?? 0;
    const size = st.size ?? 0;
    if (previewCodeCache && previewCodeCache.key === key
      && previewCodeCache.mtimeMs === mtimeMs && previewCodeCache.size === size) {
      pane.add(previewCodeCache.node);
      return;
    }
    // real class instance (not a proxied helper) so it mounts into the live pane
    const codeNode: any = new CodeRenderable(renderer, {
      id: `tfm-preview-code-${previewCodeSeq++}`,
      content: text,
      filetype: PREVIEW_FT_BY_EXT[path.extname(key).slice(1).toLowerCase()],
      syntaxStyle: getPreviewSyntaxStyle()!,
      width: Math.max(8, config.ui.previewWidth - 2),
      height: Math.max(1, renderer.terminalHeight - 6),
      selectable: false,
    });
    previewCodeCache = { key, mtimeMs, size, node: codeNode };
    pane.add(codeNode);
    void drainIconQueue();
  } catch {}
};

// --- Notifications (top-right, animated) ---
type Toast = { id: number; nodeId: string; timer: any };
let toasts: Toast[] = [];
let toastSeq = 0;

const animateLeft = (node: any, from: number, to: number, ms: number): void => {
  const steps = 8;
  let i = 0;
  const tick = () => {
    i++;
    try { node.left = Math.round(from + ((to - from) * i) / steps); } catch {}
    if (i < steps) setTimeout(tick, Math.max(16, ms / steps));
  };
  tick();
};

const notify = (message: string, title = "tfm"): void => {
  const id = ++toastSeq;
  const w = Math.max(24, Math.min(44, message.length + title.length + 6));
  const y = 1 + toasts.length * 4;
  const node: any = Box(
    {
      id: `tfm-toast-${id}`,
      position: "absolute",
      left: renderer.terminalWidth + 2,
      top: y,
      width: w,
      height: 3,
      zIndex: 3500,
      backgroundColor: colors.accentBg,
      flexDirection: "column",
      paddingLeft: 1,
    },
    Text({ content: title.slice(0, w - 3), fg: colors.white }),
    Text({ content: message.slice(0, w - 3), fg: colors.sidebarFgMuted }),
  );
  renderer.root.add(node);
  // the proxy is dead weight post-mount — animate/dismiss via the real renderable
  const real: any = renderer.root.findDescendantById(`tfm-toast-${id}`);
  if (!real) return;
  const targetX = Math.max(0, renderer.terminalWidth - w - 2);
  animateLeft(real, renderer.terminalWidth + 2, targetX, 180);
  const entry: Toast = { id, nodeId: `tfm-toast-${id}`, timer: null };
  toasts.push(entry);
  entry.timer = setTimeout(() => {
    let op = 1;
    const fade = () => {
      op -= 0.18;
      try { real.opacity = Math.max(0, op); } catch {}
      if (op > 0) setTimeout(fade, 24);
      else {
        try { (real.parent ?? renderer.root).remove(real); } catch {}
        toasts = toasts.filter((t) => t.id !== id);
        toasts.forEach((t, i) => {
          const n: any = renderer.root.findDescendantById(t.nodeId);
          try { n.top = 1 + i * 4; } catch {}
        });
      }
    };
    fade();
  }, 3000);
};

let bandStart: { x: number; y: number } | null = null;
const BAND_ID = "tfm-band";

const bandNode = (): any => renderer.root.findDescendantById(BAND_ID);

const updateBandRect = (ev: any) => {
  if (!bandStart) return;
  const b = bandNode();
  if (!b) return;
  try {
    b.x = Math.min(bandStart.x, ev.x);
    b.y = Math.min(bandStart.y, ev.y);
    b.width = Math.abs(ev.x - bandStart.x) + 1;
    b.height = Math.abs(ev.y - bandStart.y) + 1;
    b.visible = true;
  } catch {}
};

const finalizeBand = (ev: any) => {
  const start = bandStart;
  bandStart = null;
  selAnchor = null;
  const b = bandNode();
  if (b) { try { b.visible = false; } catch {} }
  if (!start) return;
  const x0 = Math.min(start.x, ev.x), y0 = Math.min(start.y, ev.y);
  const x1 = Math.max(start.x, ev.x), y1 = Math.max(start.y, ev.y);
  clearTileSelection();
  tileRefsByKey.forEach((refs, key) => {
    const t: any = renderer.root.findDescendantById(refs.tileId);
    if (!t) return;
    const tx = t.screenX, ty = t.screenY, tw = t.width, th = t.height;
    if (tx < x1 + 1 && tx + tw > x0 && ty < y1 + 1 && ty + th > y0) {
      refs.selected = true;
      setTileVisual(key, 2);
    }
  });
  updateSelectionStatusReal();
  void renderPreview();
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
  // a rebuild destroys the edit input; drop the state with it
  if (renameEdit) renameEdit = null;
  clearGrid();
  const q = searchQuery.trim().toLowerCase();
  let allEntries: Entry[];
  try {
    allEntries = await listDir(state.cwd, state.showHidden || q.length > 0);
  } catch (err) {
    // restricted dir (/root, foreign 000 dirs): say why instead of a blank pane
    if (gen !== gridGen) return;
    await waitForResolution();
    if (gen !== gridGen) return;
    const { aspect } = cellMetrics();
    const iconCells = 8;
    const slotW = Math.max(1, Math.round(aspect * iconCells));
    const paneH = Math.max(8, renderer.terminalHeight - 3);
    scroller.add(Box(
      {
        width: "100%",
        height: paneH,
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: colors.bg,
      },
      makeIconSlot("close", [{ fg: colors.sidebarFgMuted, bg: colors.bg }], iconCells).el,
      Box({ height: 1 }),
      Text({ content: `can't open this folder (${fsErrText(err)})`, fg: colors.sidebarFgMuted }),
      Text({ content: pathEditMode ? "" : "edit the path above to go elsewhere", fg: colors.divider }),
      Box({ width: slotW, height: 0 }),
    ));
    stripSelectable();
    void drainIconQueue();
    return;
  }
  const entries = q ? allEntries.filter((e) => e.name.toLowerCase().includes(q)) : allEntries;
  if (gen !== gridGen) return;

  if (entries.length === 0) {
    await waitForResolution();
    if (gen !== gridGen) return;
    const { aspect } = cellMetrics();
    const iconCells = 8;
    const slotW = Math.max(1, Math.round(aspect * iconCells));
    const paneH = Math.max(8, renderer.terminalHeight - 3);
    const emptyState = Box(
      {
        width: "100%",
        height: paneH,
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: colors.bg,
      },
      makeIconSlot("folder", [{ fg: colors.sidebarFgMuted, bg: colors.bg }], iconCells).el,
      Box({ height: 1 }),
      Text({
        content: q ? "no matches"
          : state.cwd === RECENT_URI ? "no recent files"
          : state.cwd === STARRED_URI ? "nothing starred yet"
          : "this folder is empty",
        fg: colors.sidebarFgMuted,
      }),
    );
    scroller.content.add(emptyState);
    void drainIconQueue();
    return;
  }

  await waitForResolution();
  if (gen !== gridGen) return;
  const { aspect } = cellMetrics();
  const reservedRight = config.ui.previewEnabled ? config.ui.previewWidth : 0;
  const cols = Math.max(1, Math.floor((renderer.terminalWidth - sw - reservedRight - 3) / TILE_W));

  const buildTile = (e: Entry, idx: number) => {
    const key = e.abs ?? path.join(state.cwd, e.name);
    let lastClick = 0;
    const tileId = `tfm-tile-${tileSeq++}`;
    const labelId = `${tileId}-label`;
    const tile = Box({
      id: tileId,
      width: TILE_W,
      height: TILE_H,
      flexDirection: "column",
      alignItems: "center",
      justifyContent: "flex-start",
      onMouseDown: (ev: any) => {
        try { ev.stopPropagation?.(); } catch {}
        closeFileMenu();
        if (renameEdit && renameEdit.key !== key) finishInlineRename(false);
        if (ev.button === 2) {
          // Nautilus behavior: right-click selects the tile unless it's already
          // part of the live multi-selection
          if (!tileRefsByKey.get(key)?.selected) {
            clearTileSelection();
            const r = tileRefsByKey.get(key);
            if (r) { r.selected = true; setTileVisual(key, 2); }
            updateSelectionStatusReal();
            void renderPreview();
          }
          openContextMenu(ev.x, ev.y, "", fileEntriesFor(key, e.isDir, ev.x, ev.y));
          return;
        }
        // the ctrl modifier decides internal vs external for drags
        // (see the OSC 72 offer handler)
        const now = Date.now();
        if (now - lastClick < config.ui.doubleClickMs) {
          if (e.isDir) navigate(key);
          else openFileDefault(key);
          lastClick = 0;
          return;
        }
        lastClick = now;
        const mods = ev.modifiers ?? {};

        // ctrl+click (no movement): toggle membership — coexists with ctrl+drag
        // which still means internal move once the drag threshold trips.
        // The toggle itself is DEFERRED to mouseup: applying it here unselected
        // the pressed tile, so ctrl+dragging a selected file moved 0 items and
        // rubber-band + ctrl+drag dropped the pressed file from the payload.
        if (mods.ctrl) {
          const refs = tileRefsByKey.get(key);
          const wasSel = !!refs?.selected;
          ctrlPendingKey = key;
          ctrlPendingState = !wasSel;
          updateSelectionStatusReal();
          void renderPreview();
          dragKeys = wasSel ? selPaths() : [...selPaths(), { path: key, isDir: e.isDir }];
          dlog(`ctrl mousedown ${key} wasSel=${wasSel} provisional=${dragKeys.length}`);
          dragActive = false;
          dragStartX = ev.x;
          dragStartY = ev.y;
          dragCtrl = true;
          return;
        }

        // shift+click / alt+click: range select. The anchor persists across
        // clicks so each alt+click re-extends from the SAME origin; plain and
        // ctrl clicks are what move/reset it.
        if ((mods.shift || mods.alt)) {
          if (selAnchor === null) selAnchor = focusIdx >= 0 ? focusIdx : 0;
          selectRange(selAnchor, idx);
          updateSelectionStatusReal();
          void renderPreview();
          dragKeys = selPaths();
          dragActive = false;
          dragStartX = ev.x;
          dragStartY = ev.y;
          dragCtrl = false;
          return;
        }

        const prevSel = selPaths();
        const wasSelected = !!tileRefsByKey.get(key)?.selected;
        clearTileSelection();
        selAnchor = idx;
        const refs = tileRefsByKey.get(key);
        if (refs) {
          if (wasSelected && prevSel.length > 1) {
            for (const s of prevSel) {
              const r2 = tileRefsByKey.get(s.path);
              if (r2) { r2.selected = true; setTileVisual(s.path, 2); }
            }
          } else {
            refs.selected = true;
            setTileVisual(key, 2);
          }
        }
        updateSelectionStatusReal();
        void renderPreview();
        dragKeys = wasSelected && prevSel.length > 1 ? prevSel : [{ path: key, isDir: e.isDir }];
        dragActive = false;
        dragStartX = ev.x;
        dragStartY = ev.y;
        dragCtrl = !!ev.modifiers?.ctrl;
        dlog(`tile mousedown ${key} wasSel=${wasSelected} prevN=${prevSel.length} -> keys=${dragKeys.length} ctrl=${dragCtrl}`);
      },
      onMouseUp: () => { if (dragKeys) { dlog("tile mouseup -> cleanup scheduled"); commitPendingCtrlToggle(); scheduleDragCleanup(); } },
      onMouseDragEnd: () => { if (dragKeys) { dlog("tile dragend -> cleanup scheduled"); commitPendingCtrlToggle(); scheduleDragCleanup(); } },
      onMouseDrag: (ev: any) => {
        if (!dragKeys) return;
        if (!dragActive && (Math.abs(ev.x - dragStartX) > 1 || Math.abs(ev.y - dragStartY) > 1)) {
          dragActive = true;
          ctrlPendingKey = null; // it became a drag — the click-toggle never happened
          // payload tiles must actually be selected or the visual state lies
          for (const k of dragKeys) {
            const r = tileRefsByKey.get(k.path);
            if (r && !r.selected) { r.selected = true; setTileVisual(k.path, 2); }
          }
          dlog(`internal drag start n=${dragKeys.length}`);
          setStatusMsg(`Dragging ${dragKeys.length} item${dragKeys.length === 1 ? "" : "s"}…`);
        }
        if (dragActive) updateDragGhost(ev.x, ev.y);
      },
      onMouseDrop: () => {
        const keys = dragKeys;
        const dest = dropTargetKey;
        dlog(`tile drop keys=${keys?.length ?? -1}[${keys?.map((k) => k.path.split("/").pop()).join(",") ?? ""}] dest=${dest} isDir=${e.isDir}`);
        finishDragState();
        if (keys && dest && e.isDir) void moveInto(dest, keys.filter((k) => k.path !== dest));
      },
      onMouseOver: () => {
        if (dragActive) {
          const draggingSelf = !!dragKeys?.some((k) => k.path === key);
          if (e.isDir && !draggingSelf) { dlog(`hover target set ${key}`); dropTargetKey = key; setTileVisual(key, 2); }
          return;
        }
        const refs = tileRefsByKey.get(key);
        if (!refs?.selected) setTileVisual(key, 1);
      },
      onMouseOut: () => {
        if (dragActive && dropTargetKey === key) {
          dropTargetKey = null;
          setTileVisual(key, 0);
          return;
        }
        const refs = tileRefsByKey.get(key);
        if (!refs?.selected) setTileVisual(key, 0);
      },
    });

    const dim = e.name.startsWith(".");
    const baseFg = dim ? colors.sidebarFgMuted : colors.sidebarFg;
    const slotW = Math.max(1, Math.round(aspect * ICON_CELLS_H));

    // image tiles: empty slot until the thumbnail lands (no icon->photo swap);
    // everything else queues its category raster as usual
    const wantsThumb = !e.isDir && fileIsImage(e.name);
    let st: any = null;
    if (wantsThumb) { try { st = statSync(key); } catch {} }
    const useThumb = wantsThumb && st && typeof st.size === "number" && st.size > 0 && st.size <= 26214400;

    let slotId: string;
    let iconSpec: IconSpec | undefined;
    let iconSlotEl: ReturnType<typeof Box>;
    if (useThumb) {
      slotId = `tfm-icon-${iconSeq++}`;
      iconSlotEl = Box({ id: slotId, width: slotW, height: ICON_CELLS_H, flexDirection: "row", justifyContent: "center" });
    } else {
      const s = makeIconSlot(e.isDir ? "folder" : fileIconFor(e.name), tileStates(dim), ICON_CELLS_H, 0);
      slotId = s.slotId;
      iconSpec = s.spec;
      iconSlotEl = s.el;
    }
    const tileBox = Box({ width: slotW, height: ICON_CELLS_H, flexDirection: "row", justifyContent: "center" }, iconSlotEl);
    tile.add(tileBox);

    const label = e.name.length > TILE_W - 2 ? e.name.slice(0, TILE_W - 5) + "…" : e.name;
    const labelText: any = Text({ id: labelId, content: label, fg: baseFg });
    tile.add(labelText);

    tileRefsByKey.set(key, { iconSpec, iconSlotId: slotId, selected: false, baseFg, tileId, labelId, isDir: e.isDir });

    if (useThumb && st) {
        thumbJobs.push({
          slotId,
          path: key,
          mtimeMs: st.mtimeMs ?? 0,
          size: st.size,
          wCells: slotW,
          vector: e.name.toLowerCase().endsWith(".svg"),
          fallbackGlyph: glyph[fileIconFor(e.name) as keyof typeof glyph] ?? glyph.file!,
        });
    }

    return tile;
  };

  let tileIdx = 0;
  for (let i = 0; i < entries.length; i += cols) {
    const row = Box({ height: TILE_H, flexDirection: "row" });
    for (const e of entries.slice(i, i + cols)) row.add(buildTile(e, tileIdx++));
    scroller.content.add(row);
  }

  // cut (pending-move) tiles render dimmed; apply after mount so id lookups work
  tileRefsByKey.forEach((_, key) => { if (isCutKey(key)) setTileVisual(key, 0); });

  // fresh Text nodes default selectable=true; strip AFTER the async rebuild or
  // the renderer's text-selection drag hijacks file-drag events
  stripSelectable();
  void drainIconQueue();
  void drainThumbs();
  focusKeys = [...tileRefsByKey.keys()];
  focusIdx = -1;
  selAnchor = null;
  colsAtBuild = cols;
  updateSelectionStatusReal();
};

// clickable "esc" hint shared by floating UIs (prompt/props/menu)
const escHintBtn = (id: string, onClose: () => void): ReturnType<typeof Box> => {
  // X (close) raster with hover swap — replaced the old text "esc" hint
  const states = (): IconState[] => [
    { fg: colors.sidebarFgMuted, bg: colors.sidebarBg },
    { fg: colors.white, bg: colors.hoverBg },
  ];
  const slot = makeIconSlot("close", states(), 1, 0, undefined, states);
  const paint = (on: boolean) => {
    setIconState(slot.spec, on ? 1 : 0);
    try {
      const n: any = renderer.root.findDescendantById(id);
      if (n) n.backgroundColor = on ? colors.hoverBg : colors.sidebarBg;
    } catch {}
  };
  return Box(
    {
      id,
      // extra cell keeps the X off the panel edge
      width: 3,
      height: 1,
      justifyContent: "center",
      backgroundColor: colors.sidebarBg,
      onMouseDown: () => onClose(),
      onMouseOver: () => paint(true),
      onMouseOut: () => paint(false),
    },
    slot.el,
  );
};

// --- Prompt modal (rename / new folder) ---
let promptOpen = false;

const closePrompt = () => {
  const scrim: any = renderer.root.findDescendantById("tfm-prompt");
  scrim?.parent?.remove(scrim);
  promptOpen = false;
};

const openPrompt = (title: string, initial: string, onSubmit: (value: string) => void) => {
  if (promptOpen || !renderer.resolution) return;
  promptOpen = true;
  const scrim = Box(
    {
      id: "tfm-prompt",
      position: "absolute",
      left: 0,
      top: 0,
      width: "100%",
      height: "100%",
      alignItems: "center",
      paddingTop: Math.max(2, Math.round(renderer.terminalHeight / 3)),
      zIndex: 3200,
      backgroundColor: RGBA.fromInts(0, 0, 0, 150),
      onMouseDown: () => { closePrompt(); },
    },
    Box(
      {
        id: "tfm-prompt-panel",
        width: MENU_W,
        backgroundColor: colors.sidebarBg,
        paddingTop: 1,
        paddingBottom: 1,
        flexDirection: "column",
        onMouseDown: (ev: any) => { try { ev.stopPropagation?.(); } catch {} },
      },
      Box(
        { width: "100%", height: 1, flexDirection: "row", alignItems: "center", paddingLeft: 1, paddingRight: 1 },
        Text({ content: ` ${title}`.slice(0, MENU_W - 7), fg: colors.accent }),
        Box({ flexGrow: 1 }),
        escHintBtn("tfm-esc-prompt", closePrompt),
      ),
      Box(
        { width: "100%", height: 1, paddingLeft: 1, paddingRight: 1 },
        Text({ content: " " + "~".repeat(MENU_W - 2), fg: colors.divider }),
      ),
    ),
  );
  renderer.root.add(scrim);

  const panel: any = renderer.root.findDescendantById("tfm-prompt-panel");
  const input = new InputRenderable(renderer, {
    id: "tfm-prompt-input",
    flexGrow: 1,
    value: initial,
    backgroundColor: colors.accentBg,
    focusedBackgroundColor: colors.accentBg,
    textColor: colors.white,
  });
  panel.add(input);
  const prevHandler = input.handleKeyPress?.bind(input);
  input.handleKeyPress = (key: any) => {
    if (key?.name === "escape") { closePrompt(); return true; }
    if (key?.name === "return") {
      const v = String((input as any).value ?? "").trim();
      closePrompt();
      if (v) onSubmit(v);
      return true;
    }
    return prevHandler ? prevHandler(key) : false;
  };
  setTimeout(() => { try { input.focus(); } catch {} }, 20);
  stripSelectable();
};

// --- Properties dialog (floating, right-click -> Properties…) ---
const PROPS_W = 46;
let propsOpen = false;

const closeProps = (): void => {
  const scrim: any = renderer.root.findDescendantById("tfm-props");
  scrim?.parent?.remove(scrim);
  propsOpen = false;
};

const openProperties = (targetPath: string): void => {
  closeFileMenu();
  let st: any = null;
  try { st = statSync(targetPath); } catch { return; }
  if (propsOpen) closeProps();
  const isDirTarget = st.isDirectory();
  propsOpen = true;

  const scrim = Box(
    {
      id: "tfm-props",
      position: "absolute",
      left: 0,
      top: 0,
      width: "100%",
      height: "100%",
      alignItems: "center",
      paddingTop: Math.max(2, Math.round(renderer.terminalHeight / 4)),
      zIndex: 3300,
      backgroundColor: RGBA.fromInts(0, 0, 0, 150),
      onMouseDown: () => closeProps(),
    },
    Box(
      {
        id: "tfm-props-panel",
        width: PROPS_W,
        backgroundColor: colors.sidebarBg,
        paddingTop: 1,
        paddingBottom: 1,
        flexDirection: "column",
        onMouseDown: (ev: any) => { try { ev.stopPropagation?.(); } catch {} },
      },
    ),
  );
  renderer.root.add(scrim);

  const panel: any = renderer.root.findDescendantById("tfm-props-panel");
  if (!panel) return;

  // star & bookmark are on/off toggles AND hovers — 4 baked rasters each
  // (idx = on*1 + hover*2), plus matching wrapper-box bg swaps
  const propsToggleStates = (): IconState[] => [
    { fg: colors.sidebarFgMuted, bg: colors.sidebarBg },
    { fg: colors.accent, bg: colors.sidebarBg },
    { fg: colors.sidebarFgMuted, bg: colors.hoverBg },
    { fg: colors.accent, bg: colors.hoverBg },
  ];
  const propsTogglePaint = (btnId: string, spec: IconSpec, on: boolean, hover: boolean) => {
    setIconState(spec, (on ? 1 : 0) + (hover ? 2 : 0));
    try {
      const n: any = renderer.root.findDescendantById(btnId);
      if (n) n.backgroundColor = hover ? colors.hoverBg : colors.sidebarBg;
    } catch {}
  };

  const starSlot = makeIconSlot("star", propsToggleStates(), 1, 0, () => {
    starred = !starred;
    propsTogglePaint("tfm-props-star", starSlot.spec, starred, starHover);
    if (starred) starredRegistryAdd(targetPath);
    else starredRegistryRemove(targetPath);
    void execFileP("gio", ["set", "-t", "string", targetPath, "metadata::starred", starred ? "true" : ""]).catch(() => {});
  });
  let starHover = false;
  let starred = readStarredList().includes(targetPath);
  if (starred) setIconState(starSlot.spec, 1);
  void execFileP("gio", ["info", "-a", "metadata::starred", targetPath]).then(
    ({ stdout }) => {
      const m = stdout.match(/metadata::starred:\s*(\S+)/);
      const gioStarred = !!m && m[1] !== "";
      if (gioStarred && !starred) {
        starred = true;
        starredRegistryAdd(targetPath); // adopt stars made outside tfm
      }
      setIconState(starSlot.spec, (starred ? 1 : 0) + (starHover ? 2 : 0));
    },
  ).catch(() => {});
  // folders can be bookmarked (gtk bookmarks → sidebar); files can't.
  // created unconditionally like starSlot — just not rendered for files
  let bmHover = false;
  let bookmarked = isBookmarked(targetPath);
  const bmSlot = makeIconSlot("bookmark", propsToggleStates(), 1, bookmarked ? 1 : 0, () => {
    bookmarked = !bookmarked;
    propsTogglePaint("tfm-props-bm", bmSlot.spec, bookmarked, bmHover);
    void setBookmarked(targetPath, bookmarked)
      .then(() => loadSystemPlaces())
      .then(() => renderAll());
  });
  panel.add(Box(
    { width: "100%", height: 1, flexDirection: "row", alignItems: "center" },
    (() => {
      const b = Box(
        {
          id: "tfm-props-star",
          paddingLeft: 1,
          backgroundColor: colors.sidebarBg,
          onMouseOver: () => { starHover = true; propsTogglePaint("tfm-props-star", starSlot.spec, starred, true); },
          onMouseOut: () => { starHover = false; propsTogglePaint("tfm-props-star", starSlot.spec, starred, false); },
        },
        starSlot.el,
      );
      return b;
    })(),
    ...(isDirTarget
      ? [
          Box(
            {
              id: "tfm-props-bm",
              paddingLeft: 1,
              backgroundColor: colors.sidebarBg,
              onMouseOver: () => { bmHover = true; propsTogglePaint("tfm-props-bm", bmSlot.spec, bookmarked, true); },
              onMouseOut: () => { bmHover = false; propsTogglePaint("tfm-props-bm", bmSlot.spec, bookmarked, false); },
            },
            bmSlot.el,
          ),
        ]
      : []),
    Box({ flexGrow: 1 }),
    escHintBtn("tfm-esc-props", closeProps),
  ));

  // hero: big category icon below the title, or the actual picture for images
  const iconName = isDirTarget ? "folder" : fileIconFor(targetPath);
  const ICON_H = 6;
  const { aspect } = cellMetrics();
  const heroW = Math.max(1, Math.round(aspect * ICON_H));
  const wantsThumb = !isDirTarget && fileIsImage(targetPath) && st.size > 0 && st.size <= 26214400;
  let heroEl: ReturnType<typeof Box>;
  if (wantsThumb) {
    const slotId = `tfm-icon-${iconSeq++}`;
    heroEl = Box({ id: slotId, width: heroW, height: ICON_H });
    thumbJobs.push({
      slotId,
      path: targetPath,
      mtimeMs: st.mtimeMs ?? 0,
      size: st.size,
      wCells: heroW,
      hCells: ICON_H,
      bg: colors.sidebarBg,
      vector: targetPath.toLowerCase().endsWith(".svg"),
      fallbackGlyph: glyph[iconName as keyof typeof glyph] ?? glyph.file!,
    });
  } else {
    heroEl = makeIconSlot(iconName, [{ fg: colors.sidebarFg, bg: colors.sidebarBg }], ICON_H).el;
  }
  panel.add(Box(
    { width: "100%", height: ICON_H + 1, flexDirection: "row", justifyContent: "center", alignItems: "center" },
    heroEl,
  ));
  panel.add(Box(
    { width: "100%", height: 1, flexDirection: "row", justifyContent: "center", paddingLeft: 1, paddingRight: 1 },
    Text({ content: path.basename(targetPath).slice(0, PROPS_W - 4), fg: colors.white }),
  ));
  panel.add(Box(
    { width: "100%", height: 1, flexDirection: "row", justifyContent: "center", paddingLeft: 1, paddingRight: 1 },
    Text({
      id: "tfm-props-size",
      content: isDirTarget ? "calculating…" : `${fmtBytes(st.size ?? 0)} (${st.size ?? 0} bytes)`,
      fg: colors.accent,
    }),
  ));
  panel.add(Box(
    { width: "100%", height: 1, paddingLeft: 1, paddingRight: 1 },
    Text({ content: " " + "~".repeat(PROPS_W - 2), fg: colors.divider }),
  ));

  const row = (label: string, value: string, id?: string) =>
    Box({ width: "100%", height: 1, flexDirection: "row", paddingLeft: 1 },
      Text({ content: ` ${label}`.padEnd(12), fg: colors.sidebarFgMuted }),
      Text({ ...(id ? { id } : {}), content: String(value).slice(0, PROPS_W - 14), fg: colors.sidebarFg }));

  if (isDirTarget) {
    void dirWalkStats(targetPath).then((s) => {
      if (!propsOpen || !s) {
        if (propsOpen) {
          const n: any = renderer.root.findDescendantById("tfm-props-size");
          if (n) { try { n.content = "huge"; } catch {} }
        }
        return;
      }
      const n: any = renderer.root.findDescendantById("tfm-props-size");
      if (n) { try { n.content = `${fmtBytes(s.bytes)} · ${s.files} files · ${s.folders} folders`; } catch {} }
    });
  }
  panel.add(row("type", isDirTarget ? "inode/directory" : mimeLabelFor(targetPath)));
  panel.add(row("location", path.dirname(targetPath).replace(home, "~").slice(0, PROPS_W - 14)));
  panel.add(row("modified", fmtDate(st.mtimeMs)));
  panel.add(row("accessed", fmtDate(st.atimeMs)));

  // --- nautilus-style permissions editor: click a class to pick access,
  // checkbox toggles the execute bit ---
  const permRowId = (cls: string): string => `tfm-props-perm-${cls}`;
  // assigned only when the exec checkbox exists (exec-capable files)
  let syncExecCheckbox: () => void = () => {};
  const refreshPermRows = (): void => {
    progSetText(permRowId("owner"), permWords(st.mode, 6, isDirTarget));
    progSetText(permRowId("group"), permWords(st.mode, 3, isDirTarget));
    progSetText(permRowId("others"), permWords(st.mode, 0, isDirTarget));
    syncExecCheckbox();
  };
  const applyMode = async (nm: number): Promise<void> => {
    try { await chmod(targetPath, nm); } catch { setStatusMsg("chmod failed"); return; }
    try { st.mode = statSync(targetPath).mode; } catch { return; }
    refreshPermRows();
  };
  const permClassMenu = (shift: number): ListEntry[] => {
    const cur = (st.mode >> shift) & 7;
    const mk = (bits: number, label: string): ListEntry => ({
      label: `${cur === bits ? "●" : "○"} ${label}`,
      action: () => {
        closeFileMenu();
        void applyMode((st.mode & ~(7 << shift)) | (bits << shift));
      },
    });
    return [mk(6, "read & write"), mk(4, "read-only"), mk(0, "none")];
  };
  const permRow = (label: string, cls: string, shift: number) => {
    const rowId = `tfm-props-perm-${cls}`;
    return Box(
      {
        id: rowId,
        width: "100%", height: 1, flexDirection: "row", paddingLeft: 1,
        backgroundColor: colors.sidebarBg,
        onMouseDown: (ev: any) => openContextMenu(ev.x, ev.y, "", permClassMenu(shift)),
        onMouseOver: () => setOnId(rowId, (n) => { n.backgroundColor = colors.hoverBg; }),
        onMouseOut: () => setOnId(rowId, (n) => { n.backgroundColor = colors.sidebarBg; }),
      },
      Text({ content: ` ${label}`.padEnd(12), fg: colors.sidebarFgMuted }),
      Text({ id: permRowId(cls), content: permWords(st.mode, shift, isDirTarget), fg: colors.sidebarFg }),
    );
  };
  panel.add(permRow("you", "owner", 6));
  panel.add(permRow("group", "group", 3));
  panel.add(permRow("others", "others", 0));
  panel.add(row("owner", `${idName(st.uid)}:${idName(st.gid)}`));

  // "execute as program" only makes sense for things that can actually run:
  // already-executable files, ELF binaries, shebang scripts, known script exts
  const execCapable = ((): boolean => {
    if (isDirTarget) return false;
    if (st.mode & 0o111) return true;
    const ext = path.extname(targetPath).slice(1).toLowerCase();
    if (["sh", "bash", "zsh", "py", "pl", "rb", "run"].includes(ext)) return true;
    try {
      const head = Buffer.alloc(4);
      const fd = openSync(targetPath, "r");
      try { readSync(fd, head, 0, 4, 0); } finally { closeSync(fd); }
      return (head[0] === 0x7f && head[1] === 0x45 && head[2] === 0x4c && head[3] === 0x46)
        || (head[0] === 0x23 && head[1] === 0x21);
    } catch { return false; }
  })();
  if (execCapable) {
    // raster checkbox: two slots (marked/blank) stacked in one hit area,
    // visibility flips with the exec bit
    const cbOnSpec = makeIconSlot("checkbox-marked", [{ fg: colors.accent, bg: colors.sidebarBg }], 1, 0);
    const cbOffSpec = makeIconSlot("checkbox-blank", [{ fg: colors.sidebarFgMuted, bg: colors.sidebarBg }], 1, 0);
    syncExecCheckbox = (): void => {
      const on = !!(st.mode & 0o100);
      const a: any = renderer.root.findDescendantById(cbOnSpec.slotId);
      const b: any = renderer.root.findDescendantById(cbOffSpec.slotId);
      try { if (a) a.visible = on; } catch {}
      try { if (b) b.visible = !on; } catch {}
    };
    panel.add(Box({ height: 1 }));
    const execRowId = "tfm-props-exec";
    const execRow = Box(
      {
        id: execRowId,
        width: "100%", height: 1, flexDirection: "row", columnGap: 1, paddingLeft: 1,
        backgroundColor: colors.sidebarBg,
        onMouseDown: () => {
          let nm: number;
          if (st.mode & 0o100) nm = st.mode & ~0o111;
          else {
            nm = st.mode;
            for (const sh of [6, 3, 0]) { if ((st.mode >> sh) & 4) nm |= 1 << sh; }
          }
          void applyMode(nm);
        },
        onMouseOver: () => setOnId(execRowId, (n) => { n.backgroundColor = colors.hoverBg; }),
        onMouseOut: () => setOnId(execRowId, (n) => { n.backgroundColor = colors.sidebarBg; }),
      },
      Box({ width: 2, height: 1, flexDirection: "row" }, cbOffSpec.el, cbOnSpec.el),
      Text({ content: "execute as program", fg: colors.sidebarFg }),
    );
    panel.add(execRow);
    syncExecCheckbox();
  }
  stripSelectable();
  void drainIconQueue();
  void drainThumbs();
};

// --- File context menu (right-click a tile) ---
type ListEntry = { icon?: string; label: string; hint?: string; hintIcon?: string; action: () => void; sep?: boolean };
let fileMenuState: { idx: number; entries: ListEntry[] } | null = null;

const closeFileMenu = () => {
  const scrim: any = renderer.root.findDescendantById("tfm-filemenu");
  scrim?.parent?.remove(scrim);
  fileMenuState = null;
};

const renderFileMenu = () => {
  const panel: any = renderer.root.findDescendantById("tfm-filemenu-panel");
  if (!panel || !fileMenuState) return;
  [...panel.getChildren()].forEach((c: any) => panel.remove(c));
  const row = (entry: ListEntry, i: number) => {
    if (entry.sep) {
      // plain spacer row — no divider glyph
      return Box({ width: "100%", height: 1 });
    }
    return Box(
      {
        width: "100%",
        height: 1,
        flexDirection: "row",
        columnGap: 1,
        paddingLeft: 1,
        paddingRight: 1,
        backgroundColor: i === fileMenuState!.idx ? colors.accentBg : undefined,
        onMouseDown: (ev: any) => {
          try { ev.stopPropagation?.(); } catch {}
          entry.action();
        },
        onMouseOver: () => {
          if (fileMenuState && fileMenuState.idx !== i) { fileMenuState.idx = i; renderFileMenu(); }
        },
      },
      ...(entry.icon ? [makeIconSlot(entry.icon, [{ fg: colors.sidebarFg, bg: i === fileMenuState!.idx ? colors.accentBg : colors.sidebarBg }, { fg: colors.white, bg: colors.accentBg }], 1, i === fileMenuState!.idx ? 1 : 0).el] : []),
      Text({ content: entry.label, fg: i === fileMenuState!.idx ? colors.white : colors.sidebarFg }),
      Box({ flexGrow: 1 }),
      ...(entry.hintIcon
        ? [makeIconSlot(entry.hintIcon, [
            { fg: colors.sidebarFgMuted, bg: i === fileMenuState!.idx ? colors.accentBg : colors.sidebarBg },
            { fg: colors.white, bg: colors.accentBg },
          ], 1, i === fileMenuState!.idx ? 1 : 0).el]
        : entry.hint ? [Text({ content: entry.hint + " ", fg: colors.sidebarFgMuted })] : []),
    );
  };
  panel.add(Box(
    { width: "100%", height: 1, paddingLeft: 1, paddingRight: 1 },
    Text({ content: " " + "~".repeat(MENU_W - 2), fg: colors.divider }),
  ));
  fileMenuState.entries.forEach((e2, i) => panel.add(row(e2, i)));
  void drainIconQueue();
};

// small unscoped box spawned at the cursor — no scrim
const openContextMenu = (x: number, y: number, title: string, entries: ListEntry[]): void => {
  closeFileMenu();
  fileMenuState = { idx: 0, entries };
  const w = MENU_W;
  const h = entries.length + 2;
  let px = x, py = y;
  if (px + w > renderer.terminalWidth - 1) px = Math.max(0, renderer.terminalWidth - w - 1);
  if (py + h > renderer.terminalHeight - 1) py = Math.max(0, renderer.terminalHeight - h - 1);
  const menu = Box(
    {
      id: "tfm-filemenu",
      position: "absolute",
      left: px,
      top: py,
      width: w,
      // above every modal (props/prompt/conflict/toast) — context menus can be
      // spawned from inside any of them
      zIndex: 3600,
      backgroundColor: colors.sidebarBg,
      flexDirection: "column",
    },
    Box(
      { id: "tfm-filemenu-panel", width: "100%", flexDirection: "column" },
    ),
  );
  renderer.root.add(menu);
  renderFileMenu();
  stripSelectable();
};

const sidebarEntriesFor = (place: Place, x: number, y: number): ListEntry[] => {
  const target = place.scheme === "recent" ? RECENT_URI
    : place.scheme === "starred" ? STARRED_URI
    : place.path;
  const entries: ListEntry[] = [];
  if (target) {
    entries.push({ icon: "folder", label: "Open", action: () => { closeFileMenu(); navigate(target); } });
    entries.push({ icon: "terminal", label: "Open Terminal Here", action: () => { closeFileMenu(); openTerminalHere(target); } });
    // paste into real places (not virtual views, not the trash)
    if (!place.scheme && target !== path.join(TRASH_DIR, "files")) {
      entries.push({
        icon: "content-paste",
        label: clipboard && clipboard.items.length ? `Paste ${clipboard.items.length} item${clipboard.items.length === 1 ? "" : "s"}` : "Paste",
        action: () => { closeFileMenu(); pasteSmart(target); },
      });
    }
    if (target === path.join(TRASH_DIR, "files")) {
      entries.push({ icon: "trash-can", label: "Empty Trash", action: () => { closeFileMenu(); confirmEmptyTrash(); } });
    } else if (place.bookmarked) {
      entries.push({ icon: "bookmark", label: "Remove bookmark", action: () => {
        closeFileMenu();
        void setBookmarked(target, false).then(() => loadSystemPlaces()).then(() => renderAll());
      } });
    }
  }
  if (place.ejectable && place.device) {
    entries.push({ icon: "eject", label: "Eject", action: () => { closeFileMenu(); ejectDevice(place.device!); } });
  }
  if (!target && place.mountDevice) {
    entries.push({ icon: "usb", label: "Mount", action: () => { closeFileMenu(); mountDevice(place.mountDevice!); } });
  }
  return entries;
};

const fileEntriesFor = (targetPath: string, isDir: boolean, x: number, y: number): ListEntry[] => {
  const entries: ListEntry[] = [];
  // Nautilus trash semantics: Restore / Open / delete-for-real; no rename,
  // clipboard ops or trashing inside the trash
  if (inTrashView()) {
    const inSel = !!tileRefsByKey.get(targetPath)?.selected;
    const targets: ClipItem[] = inSel && selPaths().length > 1 ? selPaths() : [{ path: targetPath, isDir }];
    entries.push(
      { icon: "folder", label: `Restore${inSel && targets.length > 1 ? ` ${targets.length} items` : ""}`, action: () => { closeFileMenu(); restoreFromTrash(targets.map((t) => t.path)); } },
      { icon: "eye", label: "Open", action: () => { closeFileMenu(); openFileDefault(targetPath); } },
      { icon: "trash-can", label: `Delete permanently`, action: () => { closeFileMenu(); confirmDeleteForever(targets.map((t) => t.path)); } },
    );
    return entries;
  }
  if (isDir) entries.push({ icon: "folder", label: "Open", action: () => { closeFileMenu(); navigate(targetPath); } });
  else entries.push({ icon: "eye", label: "Open", action: () => { closeFileMenu(); openFileDefault(targetPath); } });
  // actions apply to the whole live selection when the right-clicked tile is
  // part of it (Nautilus behavior), otherwise just this tile
  const inSel = !!tileRefsByKey.get(targetPath)?.selected;
  const targets: ClipItem[] = inSel && selPaths().length > 1 ? selPaths() : [{ path: targetPath, isDir }];
  entries.push(
    { icon: "content-copy", label: `Copy${inSel && targets.length > 1 ? ` ${targets.length} items` : ""}`, action: () => { closeFileMenu(); setClipboard("copy", targets); } },
    { icon: "content-cut", label: `Cut${inSel && targets.length > 1 ? ` ${targets.length} items` : ""}`, action: () => { closeFileMenu(); setClipboard("cut", targets); } },
    ...(isDir
      ? [{
          icon: "content-paste",
          label: clipboard && clipboard.items.length ? `Paste ${clipboard.items.length} item${clipboard.items.length === 1 ? "" : "s"} into folder` : "Paste into folder",
          action: () => { closeFileMenu(); pasteSmart(targetPath); },
        } satisfies ListEntry]
      : []),
    { icon: "pencil", label: "Rename…", action: () => {
        closeFileMenu();
        startInlineRename(targetPath);
      } },
    { icon: "trash-can", label: `Trash${inSel && targets.length > 1 ? ` ${targets.length} items` : ""}`, action: () => { closeFileMenu(); trashPaths(targets.map((t) => t.path)); } },
  );
  entries.push({ icon: "information", label: "Properties…", action: () => openProperties(targetPath) });
  return entries;
};

const sortEntries = (): ListEntry[] => {
  // nautilus convention: picking a different key sorts it in its natural
  // direction; clicking the active key flips ascending/descending.
  // Direction arrow sits at the row's right edge via hint.
  const pick = (key: SortMode, naturalAsc: boolean): void => {
    closeFileMenu();
    if (state.sortBy === key) state.sortAsc = !state.sortAsc;
    else { state.sortBy = key; state.sortAsc = naturalAsc; }
    void renderGrid();
  };
  const entry = (key: SortMode, label: string, naturalAsc: boolean): ListEntry => ({
    label,
    ...(state.sortBy === key ? { hintIcon: state.sortAsc ? "arrow-up" : "arrow-down" } : {}),
    action: () => pick(key, naturalAsc),
  });
  return [
    entry("name", "Name", true),
    entry("size", "Size", false),
    entry("mtime", "Modified", true),
    entry("type", "Type", true),
  ];
};

const emptyAreaEntries = (x: number, y: number): ListEntry[] => {
  const entries: ListEntry[] = [];
  if (inTrashView()) {
    entries.push({ icon: "trash-can", label: "Empty Trash", action: () => { closeFileMenu(); confirmEmptyTrash(); } });
  }
  if (isVirtualCwd()) {
    // read-only virtual views: nothing to paste or create here
    entries.push(
      { icon: "select-all", label: "Select all", action: () => {
        closeFileMenu();
        tileRefsByKey.forEach((r, k) => { r.selected = true; setTileVisual(k, 2); });
        updateSelectionStatusReal();
      } },
    );
    return entries;
  }
  entries.push(
    { icon: "file", label: "New File", action: () => { closeFileMenu(); startInlineCreate("file"); } },
    { icon: "folder-plus", label: "New Folder", action: () => { closeFileMenu(); startInlineCreate("folder"); } },
    { icon: "select-all", label: "Select all", action: () => {
      closeFileMenu();
      tileRefsByKey.forEach((r, k) => { r.selected = true; setTileVisual(k, 2); });
      updateSelectionStatusReal();
    } },
    { icon: "content-paste", label: clipboard && clipboard.items.length ? `Paste ${clipboard.items.length} item${clipboard.items.length === 1 ? "" : "s"}` : "Paste", action: () => { closeFileMenu(); pasteSmart(state.cwd); } },
    { icon: "information", label: "Properties…", action: () => { closeFileMenu(); openProperties(state.cwd); } },
    // nautilus puts shell access in its own group at the bottom
    { sep: true, label: "", action: () => {} },
    { icon: "terminal", label: "Open Terminal Here", action: () => { closeFileMenu(); openTerminalHere(); } },
  );
  return entries;
};

// --- ESC menu (scrim pattern stolen from opencode's Dialog) ---
type MenuEntry = { label: string; hint?: string; action: () => void };

let menuOpen = false;
let menuView: "root" | "settings" = "root";
let menuIdx = 0;

const MENU_W = 36;

const quitApp = () => {
  disableDrops();
  // release the shift-capture request made at boot
  try { process.stdout.write("\x1b[>0s"); } catch {}
  try { renderer.destroy(); } catch {}
  process.exit(0);
};

// --- Settings model: declarative rows drive both rendering and key/mouse input ---
type SettingRow =
  | { kind: "toggle"; label: string; get: () => boolean; set: (v: boolean) => void }
  | { kind: "stepper"; label: string; min: number; max: number; step: number; fmt: (v: number) => string; get: () => number; set: (v: number) => void }
  | { kind: "cycle"; label: string; names: string[]; getIdx: () => number; setIdx: (i: number) => void }
  | { kind: "action"; label: string; keepOpen?: boolean; run: () => void };

const themePresetIdx = (): number =>
  THEME_PRESETS.findIndex((p) => JSON.stringify(p.theme) === JSON.stringify(config.theme));

const commitSetting = (): void => {
  applyConfig(config);
  scheduleSaveConfig();
};

const resetToDefaults = (): void => {
  const fresh = structuredClone(defaultConfig);
  state.showHidden = fresh.ui.showHidden;
  applyConfig(fresh);
  scheduleSaveConfig();
};

const settingGroups = (): { header?: string; rows: SettingRow[] }[] => [
  {
    rows: [
      { kind: "cycle", label: "theme", names: THEME_PRESETS.map((p) => p.name), getIdx: themePresetIdx,
        setIdx: (i) => { applyConfig({ ui: { ...config.ui }, theme: { ...THEME_PRESETS[i]!.theme } }); scheduleSaveConfig(); } },
      { kind: "toggle", label: "hidden files",
        // state.showHidden is the effective runtime flag (ctrl+h writes it
        // without persisting); config is only updated when the GUI commits
        get: () => state.showHidden,
        set: (v) => { config.ui.showHidden = v; state.showHidden = v; commitSetting(); } },
      { kind: "toggle", label: "preview pane", get: () => config.ui.previewEnabled,
        set: (v) => { config.ui.previewEnabled = v; commitSetting(); } },
    ],
  },
  {
    header: "layout",
    rows: [
      { kind: "stepper", label: "sidebar width", min: 16, max: 60, step: 1, fmt: (v) => `${v}`, get: () => config.ui.sidebarWidth, set: (v) => { config.ui.sidebarWidth = v; commitSetting(); } },
      { kind: "stepper", label: "tile width", min: 10, max: 40, step: 1, fmt: (v) => `${v}`, get: () => config.ui.tileWidth, set: (v) => { config.ui.tileWidth = v; commitSetting(); } },
      { kind: "stepper", label: "tile height", min: 3, max: 10, step: 1, fmt: (v) => `${v}`, get: () => config.ui.tileHeight, set: (v) => { config.ui.tileHeight = v; commitSetting(); } },
      { kind: "stepper", label: "icon size", min: 1, max: 5, step: 1, fmt: (v) => `${v}`, get: () => config.ui.iconCells, set: (v) => { config.ui.iconCells = v; commitSetting(); } },
      { kind: "stepper", label: "preview width", min: 20, max: 80, step: 2, fmt: (v) => `${v}`, get: () => config.ui.previewWidth, set: (v) => { config.ui.previewWidth = v; commitSetting(); } },
    ],
  },
  {
    header: "behavior",
    rows: [
      { kind: "stepper", label: "double-click ms", min: 100, max: 2000, step: 50, fmt: (v) => `${v}`, get: () => config.ui.doubleClickMs, set: (v) => { config.ui.doubleClickMs = v; commitSetting(); } },
    ],
  },
  {
    header: "config",
    rows: [
      { kind: "action", label: "reset to defaults", keepOpen: true, run: resetToDefaults },
      { kind: "action", label: "edit config.toml…", run: () => { spawn("xdg-open", [configPath()], { stdio: "ignore", detached: true }).unref?.(); } },
      { kind: "action", label: "back", keepOpen: true, run: () => { menuView = "root"; menuIdx = 0; } },
    ],
  },
];

const settingsFlatRows = (): SettingRow[] => settingGroups().flatMap((g) => g.rows);

const applyAdjust = (row: SettingRow, dir: number): boolean => {
  switch (row.kind) {
    case "toggle": row.set(!row.get()); return true;
    case "stepper": {
      const next = Math.max(row.min, Math.min(row.max, row.get() + dir * row.step));
      if (next !== row.get()) { row.set(next); return true; }
      return false;
    }
    case "cycle": {
      const n = row.names.length;
      const cur = row.getIdx();
      const next = cur < 0 ? (dir > 0 ? 0 : n - 1) : (cur + dir + n) % n;
      row.setIdx(next);
      return true;
    }
    default: return false;
  }
};

const adjustSelectedSetting = (dir: number): void => {
  if (menuView !== "settings") return;
  const row = settingsFlatRows()[menuIdx];
  if (!row || !applyAdjust(row, dir)) return;
  renderMenuContent();
};

const menuActivate = () => {
  if (menuView === "settings") {
    const row = settingsFlatRows()[menuIdx];
    if (!row) return;
    if (row.kind === "toggle") { applyAdjust(row, 1); renderMenuContent(); return; }
    if (row.kind === "action") {
      if (row.keepOpen) { row.run(); renderMenuContent(); }
      else { closeMenu(); row.run(); }
      return;
    }
    applyAdjust(row, 1);
    renderMenuContent();
    return;
  }
  const items = rootMenuItems();
  const it = items[menuIdx] ?? items[0];
  if (!it) return;
  if (it.keepOpen) { it.action(); return; }
  closeMenu();
  it.action();
};

const rootMenuItems = (): { icon: string; label: string; hint?: string; keepOpen?: boolean; action: () => void }[] => [
  {
    icon: "cog",
    label: "Settings",
    // stays open: the action switches the menu to the settings view; closing
    // first would destroy the scrim/panel the view renders into
    keepOpen: true,
    action: () => { menuView = "settings"; menuIdx = 0; renderMenuContent(); },
  },
  {
    icon: "power",
    label: "Quit",
    hint: "ctrl+q",
    action: quitApp,
  },
];

const SETTINGS_W = 44;
const SET_LABEL_W = 17;

const renderMenuContent = () => {
  const panel: any = renderer.root.findDescendantById("tfm-menu-panel");
  if (!panel) return;
  [...panel.getChildren()].forEach((c: any) => panel.remove(c));

  const isSettings = menuView === "settings";
  const panelW = isSettings ? SETTINGS_W : MENU_W;
  try { panel.width = panelW; } catch {}

  panel.add(Box(
    { width: "100%", height: 1, flexDirection: "row", alignItems: "center", paddingLeft: 2, paddingRight: 1 },
    Text({ content: isSettings ? "Menu — settings" : "Menu", fg: colors.accent }),
    Box({ flexGrow: 1 }),
    escHintBtn("tfm-esc-menu", closeMenu),
  ));
  panel.add(Box(
    { width: "100%", height: 1, paddingLeft: 1, paddingRight: 1 },
    Text({ content: " " + "~".repeat(panelW - 2), fg: colors.divider }),
  ));

  const hoverSelect = (index: number) => () => {
    if (menuIdx !== index) { menuIdx = index; renderMenuContent(); }
  };

  const rootRow = (
    icon: string | undefined,
    label: string,
    hint: string | undefined,
    active: boolean,
    index: number,
    onClick: (ev?: any) => void,
  ) =>
    Box(
      {
        width: "100%",
        height: 1,
        flexDirection: "row",
        columnGap: 1,
        paddingLeft: 1,
        paddingRight: 1,
        backgroundColor: active ? colors.accentBg : undefined,
        onMouseDown: onClick,
        onMouseOver: hoverSelect(index),
      },
      ...(icon
        ? [makeIconSlot(
            icon,
            [
              { fg: colors.sidebarFg, bg: active ? colors.accentBg : colors.sidebarBg },
              { fg: colors.white, bg: colors.accentBg },
            ],
            1,
            active ? 1 : 0,
          ).el]
        : []),
      Text({ content: icon ? label : ` ${label}`, fg: active ? colors.white : colors.sidebarFg }),
      Box({ flexGrow: 1 }),
      ...(hint ? [Text({ content: hint + " ", fg: colors.sidebarFgMuted })] : []),
    );

  const activateRow = (index: number) => (ev: any) => {
    try { ev.stopPropagation?.(); } catch {}
    menuIdx = index;
    menuActivate();
  };

  // value column shared by stepper/cycle rows: ‹ value ›
  const chevron = (dirText: "‹" | "›", active: boolean, index: number, rowSpec: SettingRow, dir: number) => {
    const tId = `tfm-chev-${index}-${dir}`;
    return Box(
      {
        width: 2,
        justifyContent: "center",
        onMouseDown: (ev: any) => {
          try { ev.stopPropagation?.(); } catch {}
          const changed = applyAdjust(rowSpec, dir);
          if (menuIdx !== index || changed) {
            menuIdx = index;
            renderMenuContent();
          }
        },
        onMouseOver: () => setOnId(tId, (n) => { n.fg = colors.white; }),
        onMouseOut: () => setOnId(tId, (n) => { n.fg = active ? colors.white : colors.sidebarFgMuted; }),
      },
      Text({ id: tId, content: dirText, fg: active ? colors.white : colors.sidebarFgMuted }),
    );
  };

  const settingsRow = (rowSpec: SettingRow, index: number) => {
    const active = menuIdx === index;
    const labelFg = active ? colors.white : colors.sidebarFg;
    let control: any;
    let rowActivate: (ev?: any) => void = activateRow(index);

    if (rowSpec.kind === "toggle") {
      const on = rowSpec.get();
      control = Box(
        { width: 6, justifyContent: "flex-end" },
        Text({ content: on ? "on" : "off", fg: on ? colors.accent : colors.sidebarFgMuted }),
      );
    } else if (rowSpec.kind === "stepper" || rowSpec.kind === "cycle") {
      const value = rowSpec.kind === "stepper"
        ? rowSpec.fmt(rowSpec.get())
        : (() => { const i = rowSpec.getIdx(); return i >= 0 ? rowSpec.names[i] ?? "?" : "custom"; })();
      control = Box(
        { flexDirection: "row", alignItems: "center", onMouseDown: (ev: any) => { try { ev.stopPropagation?.(); } catch {} } },
        chevron("‹", active, index, rowSpec, -1),
        Box(
          { width: 13, justifyContent: "flex-end", paddingRight: 1 },
          Text({
            content: value.length > 12 ? value.slice(0, 12) : value,
            fg: active ? colors.white : colors.sidebarFgMuted,
          }),
        ),
        chevron("›", active, index, rowSpec, 1),
      );
      rowActivate = (ev?: any) => {
        try { ev?.stopPropagation?.(); } catch {}
        menuIdx = index;
        applyAdjust(rowSpec, 1);
        renderMenuContent();
      };
    } else {
      control = Box({ width: 6 });
    }

    return Box(
      {
        width: "100%",
        height: 1,
        flexDirection: "row",
        paddingLeft: 1,
        paddingRight: 1,
        backgroundColor: active ? colors.accentBg : undefined,
        onMouseDown: rowActivate,
        onMouseOver: hoverSelect(index),
      },
      Text({ content: ` ${rowSpec.label.slice(0, SET_LABEL_W).padEnd(SET_LABEL_W)}`, fg: labelFg }),
      Box({ flexGrow: 1 }),
      control,
    );
  };

  if (!isSettings) {
    const items = rootMenuItems();
    items.forEach((it, i) => panel.add(rootRow(it.icon, it.label, it.hint, i === menuIdx, i, activateRow(i))));
  } else {
    let flatIdx = 0;
    settingGroups().forEach((group, gi) => {
      if (gi > 0) panel.add(Box({ width: "100%", height: 1 }));
      if (group.header) {
        panel.add(Box(
          { width: "100%", height: 1, paddingLeft: 1 },
          Text({ content: group.header.toUpperCase(), fg: colors.sidebarFgMuted }),
        ));
      }
      for (const rowSpec of group.rows) {
        panel.add(settingsRow(rowSpec, flatIdx));
        flatIdx++;
      }
    });
    panel.add(Box({ width: "100%", height: 1 }));
    panel.add(Box(
      { width: "100%", height: 1, paddingLeft: 1, paddingRight: 1 },
      Text({ content: "←→ adjust · enter select", fg: colors.sidebarFgMuted }),
    ));
  }

  // center the panel vertically based on its actual content height so tall
  // views never overflow small terminals
  const scrim: any = renderer.root.findDescendantById("tfm-menu");
  if (scrim) {
    const rows = [...panel.getChildren()].length;
    try { scrim.paddingTop = Math.max(1, Math.floor((renderer.terminalHeight - rows - 2) / 2)); } catch {}
  }

  stripSelectable();
  void drainIconQueue();
};

const openMenu = () => {
  if (menuOpen) return;
  menuOpen = true;
  menuView = "root";
  menuIdx = 0;
  bandStart = null;
  const pendingBand = bandNode();
  if (pendingBand) { try { pendingBand.visible = false; } catch {} }
  setScrim(true);
  const scrim = Box(
    {
      id: "tfm-menu",
      position: "absolute",
      left: 0,
      top: 0,
      width: "100%",
      height: "100%",
      alignItems: "center",
      paddingTop: Math.max(2, Math.round(renderer.terminalHeight / 3)),
      zIndex: 3000,
      backgroundColor: RGBA.fromInts(0, 0, 0, 150),
      onMouseDown: () => closeMenu(),
    },
    Box(
      {
        id: "tfm-menu-panel",
        width: MENU_W,
        backgroundColor: colors.sidebarBg,
        paddingTop: 1,
        paddingBottom: 1,
        onMouseDown: (ev: any) => {
          try { ev.stopPropagation?.(); } catch {}
        },
      },
    ),
  );
  renderer.root.add(scrim);
  renderMenuContent();
};

const closeMenu = () => {
  if (!menuOpen) return;
  menuOpen = false;
  const scrim: any = renderer.root.findDescendantById("tfm-menu");
  scrim?.parent?.remove(scrim);
  setScrim(false);
};

const moveMenu = (delta: number) => {
  const count = menuView === "settings" ? settingsFlatRows().length : rootMenuItems().length;
  menuIdx = (menuIdx + delta + count) % count;
  renderMenuContent();
};

// --- Live directory watching: external changes refresh the grid ---
let cwdWatcher: ReturnType<typeof watch> | null = null;
let watchedDir: string | null = null;
let cwdWatchTimer: any = null;

const syncCwdWatcher = (): void => {
  if (isVirtualCwd()) {
    if (cwdWatcher) { try { cwdWatcher.close(); } catch {} cwdWatcher = null; }
    watchedDir = null;
    return;
  }
  const dir = path.resolve(state.cwd);
  if (watchedDir === dir) return;
  watchedDir = dir;
  if (cwdWatcher) { try { cwdWatcher.close(); } catch {} cwdWatcher = null; }
  try {
    cwdWatcher = watch(dir, () => {
      if (cwdWatchTimer) clearTimeout(cwdWatchTimer);
      cwdWatchTimer = setTimeout(() => {
        cwdWatchTimer = null;
        // our own create+inline-edit would wipe the editor mid-keystroke
        if (renameEdit) return;
        if (path.resolve(state.cwd) === watchedDir) void renderGrid();
      }, 200);
    });
    cwdWatcher.on("error", () => {});
  } catch {}
};

// --- Orchestration ---
renderAll = () => {
  state.cwd = state.history[state.histIdx] ?? state.cwd;
  syncCwdWatcher();
  refreshNav();
  renderCrumbs();
  renderSidebar();
  void drainIconQueue();
  void renderGrid();
  void renderPreview();
  stripSelectable();
  scheduleSaveSession();
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
    onMouseDown: (ev: any) => {
      closeFileMenu();
      clearSearch();
      blurTerminal();
      if (pathEditMode) { exitPathEdit(); return; }
      if (renameEdit) finishInlineRename(false);
      clearTileSelection();
      // band shows only once a drag actually moves the pointer
      if (ev.button === 0) bandStart = { x: ev.x, y: ev.y };
      if (ev.button === 2) openContextMenu(ev.x, ev.y, "", emptyAreaEntries(ev.x, ev.y));
    },
    onMouseDrag: (ev: any) => updateBandRect(ev),
    onMouseDragEnd: (ev: any) => finalizeBand(ev),
    onMouseUp: (ev: any) => { if (bandStart) finalizeBand(ev); },
  });
  const host: any = renderer.root.findDescendantById("tfm-grid-host");
  host.add(scroller);
  renderer.root.add(Box({
    id: BAND_ID,
    visible: false,
    position: "absolute",
    zIndex: 2500,
    border: true,
    borderStyle: "rounded",
    borderColor: colors.accent,
  }));
  renderer.root.add(Box({
    id: DRAG_GHOST_ID,
    visible: false,
    position: "absolute",
    left: 0,
    top: 0,
    width: 12,
    height: 1,
    zIndex: 4000,
    backgroundColor: colors.accent,
    flexDirection: "row",
    paddingLeft: 1,
  }, Text({ id: `${DRAG_GHOST_ID}-label`, content: "moving 0 items", fg: colors.bg })));

  await loadGlobs2();
  restoreSession();
  await loadSystemPlaces();
  renderAll();

  if (isDebug) {
    debugLog(`terminal ${renderer.terminalWidth}x${renderer.terminalHeight} cwd=${process.cwd()} config=${configPath()}`);
    setStatusMsg(`debug: ${DEBUG_LOG}`);
  }

  const inputEl: any = renderer.root.findDescendantById("tfm-search");
  if (inputEl?.on) {
    let searchTimer: any = null;
    inputEl.on("input", () => {
      try { searchQuery = String(inputEl.value ?? ""); } catch {}
      if (searchTimer) clearTimeout(searchTimer);
      searchTimer = setTimeout(() => { searchTimer = null; void renderGrid(); }, 150);
    });
    // enter/escape semantics live in the global key handler (enter commits
    // into the first match; escape cancels) — no listener here by design
  }
};
boot();

// --- Config application & persistence ---
// Single path for every config change (file watcher, settings UI, reset):
// mutate -> applyConfig -> scheduleSaveConfig. Geometry values that used to be
// baked into consts are rewritten here, and raster caches are invalidated only
// when colors actually changed.

const setOnId = (id: string, fn: (n: any) => void): void => {
  const n: any = renderer.root.findDescendantById(id);
  if (!n) return;
  try { fn(n); } catch {}
};

// Repaints widgets whose colors were baked at boot and which renderAll's
// rebuilds never touch. Without this a runtime theme swap leaves the sidebar,
// title, inputs, band, ghost and status bar in the old palette.
const rethemeChrome = (): void => {
  setOnId("tfm-sidebar-root", (n) => { n.backgroundColor = colors.sidebarBg; });
  setOnId("tfm-main", (n) => { n.backgroundColor = colors.bg; });
  setOnId("tfm-title-font", (n) => { n.color = colors.accent; });
  setOnId("tfm-title-sub", (n) => { n.fg = colors.sidebarFgMuted; });
  setOnId("tfm-preview", (n) => { n.backgroundColor = colors.sidebarBg; });
  setOnId(BAND_ID, (n) => { n.borderColor = colors.accent; });
  setOnId(DRAG_GHOST_ID, (n) => { n.backgroundColor = colors.accent; });
  setOnId(`${DRAG_GHOST_ID}-label`, (n) => { n.fg = colors.bg; });
  setOnId("tfm-status-label", (n) => { n.fg = colors.sidebarFgMuted; });
  setOnId("tfm-prompt-panel", (n) => { n.backgroundColor = colors.sidebarBg; });
  setOnId("tfm-term-header", (n) => { n.backgroundColor = colors.sidebarBg; });
  // toolbar hover buttons: box bg must track the new palette between raster swaps
  for (const id of ["tfm-nav-back", "tfm-nav-fwd", "tfm-search-btn", "tfm-sort-btn"]) {
    setOnId(id, (n) => {
      (n as any).backgroundColor = navHover[id] ? colors.hoverBg : colors.bg;
    });
  }
  renderCrumbs();
  refreshNav();
  for (const id of ["tfm-search", "tfm-path-input", "tfm-prompt-input"]) {
    setOnId(id, (n) => {
      n.backgroundColor = colors.accentBg;
      n.focusedBackgroundColor = colors.accentBg;
      n.textColor = colors.white;
    });
  }
  if (menuOpen) {
    setOnId("tfm-menu-panel", (n) => { n.backgroundColor = colors.sidebarBg; });
    renderMenuContent();
  }
  if (fileMenuState) {
    setOnId("tfm-filemenu", (n) => { n.backgroundColor = colors.sidebarBg; });
    renderFileMenu();
  }
};

const applyConfig = (fresh: Config): void => {
  const themeChanged = JSON.stringify(config.theme) !== JSON.stringify(fresh.theme);
  Object.assign(config.ui, fresh.ui);
  Object.assign(config.theme, fresh.theme);
  Object.assign(colors, fresh.theme);

  sw = config.ui.sidebarWidth;
  TILE_W = config.ui.tileWidth;
  TILE_H = config.ui.tileHeight;
  ICON_CELLS_H = config.ui.iconCells;
  for (const id of ["tfm-sidebar-root", "tfm-title-box", "tfm-places"]) {
    setOnId(id, (n) => { n.width = sw; });
  }
  const pane: any = renderer.root.findDescendantById("tfm-preview");
  if (pane) {
    try {
      pane.visible = config.ui.previewEnabled;
      pane.width = config.ui.previewWidth;
    } catch {}
  }

  if (themeChanged) {
    iconCache.clear();
    thumbCache.clear();
    for (const s of iconQueue) s.done = false;
    try { renderer.setBackgroundColor(colors.bg); } catch {}
    // grid/sidebar rebuild picks up the new palette; everything else needs this
    rethemeChrome();
    syncTerminalTheme();
  }
  renderAll();
};

let cfgSaveTimer: any = null;
// signature of the last file WE wrote; the watcher skips it so saving doesn't
// re-enter applyConfig and churn the rasters
let lastSavedSig = "";
let saveWarned = false;

const scheduleSaveConfig = (): void => {
  if (cfgSaveTimer) clearTimeout(cfgSaveTimer);
  cfgSaveTimer = setTimeout(() => {
    cfgSaveTimer = null;
    saveConfig(config)
      .then(async () => { try { lastSavedSig = JSON.stringify(loadConfig()); } catch {} })
      .catch(() => {
        if (!saveWarned) {
          saveWarned = true;
          console.error(`[tfm] could not write config to ${configPath()}`);
        }
      });
  }, 500);
};

// --- live config reload ---
let cfgTimer: any = null;
try {
  const cfgPath = configPath();
  const watcher = watch(path.dirname(cfgPath), (_event, filename) => {
    if (!filename || filename !== path.basename(cfgPath)) return;
    if (cfgTimer) clearTimeout(cfgTimer);
    cfgTimer = setTimeout(() => {
      try {
        const fresh = loadConfig();
        if (JSON.stringify(fresh) === lastSavedSig) return;
        applyConfig(fresh);
        setStatusMsg("config reloaded");
      } catch {}
    }, 250);
  });
  watcher.on("error", () => {});
} catch {}

// --- OSC 72 drop-in (kitty drag-and-drop): accept OS file drags onto the terminal ---
// wire format per yazi's reference impl: enter(t=m)/ready(t=M) carry a plaintext
// space-separated MIME list; data arrives as unpadded base64 chunks (t=r) that we
// request with StartDrop and acknowledge with FinishDrop(copy).
// Sequences are received via renderer.subscribeOsc — OpenTUI's stdin parser hands
// every OSC it frames to subscribers, so no second reader races the renderer.
const DND_LOG = "/tmp/tfm-dnd.log";
const dlog = (msg: string): void => {
  try { appendFileSync(DND_LOG, `${new Date().toISOString()} ${msg}\n`); } catch {}
  if (isDebug) appendLog(`[dnd] ${msg}`);
};

const osc72Write = (s: string, label: string): void => {
  dlog(`tx ${label}`);
  try { process.stdout.write(s); } catch {}
};

const enableDrops = (): void => {
  osc72Write("\x1b]72;t=o:x=1;\x1b\\", "enable drag-out"); // trailing ; = empty machine-id, byte-exact w/ yazi
  osc72Write("\x1b]72;t=a;text/uri-list\x1b\\", "enable drop-in");
};
const disableDrops = (): void => osc72Write("\x1b]72;t=A\x1b\\", "disable drop");

let osc72DropIdx = -1;
const osc72Arrive: Record<number, string> = {};
// outgoing drag session state
let osc72DragPaths: string[] | null = null;
let osc72DragOp = 1; // 1 copy / 2 move
let osc72SelfHandled = false; // self-drop already moved/copied the files
let osc72SelfTargetKey: string | null = null; // folder tile currently highlighted
let osc72EndTimer: any = null;
// NOTE: an experiment to detect cursor-exit mid-drag by flipping SGR pixel
// mode (?1016) failed: OpenTUI's mouse parser drops negatives outright
// (parse.mouse.ts returns null) and interprets pixel coords as cells, corrupting
// dispatch/highlights app-wide. Kitty reports OOB motion only in that mode,
// so internal->external handoff within one gesture is not implementable here.
let osc72OfferSeen = false; // internal-first: we decline offers, remember the gesture happened
let osc72Engaged = false; // handed off to the OS mid-gesture

// resolve a terminal cell position to an internal drop target (folder tile or place)
const resolveDropTargetAt = (x: number, y: number): { kind: "folder" | "place"; path: string } | null => {
  try {
    const num = renderer.hitTest(x, y);
    if (!num) return null;
    let cur: any = (Renderable as any).renderablesByNumber?.get(num);
    while (cur) {
      const id: unknown = cur.id;
      if (typeof id === "string") {
        if (id.startsWith("tfm-place-")) {
          const rec = placesHost[parseInt(id.slice(10), 10)];
          return rec?.place.path ? { kind: "place", path: rec.place.path } : null;
        }
        if (id.startsWith("tfm-tile-")) {
          for (const [k, r] of tileRefsByKey) {
            if (r.tileId === id) {
              if (!r.isDir) return null;
              if (osc72DragPaths?.includes(k)) return null; // dropping onto itself
              return { kind: "folder", path: k };
            }
          }
        }
      }
      cur = cur.parent;
    }
  } catch {}
  return null;
};

const clearSelfDropHighlight = (): void => {
  if (osc72SelfTargetKey) {
    const r = tileRefsByKey.get(osc72SelfTargetKey);
    if (r && !r.selected) setTileVisual(osc72SelfTargetKey, 0);
    osc72SelfTargetKey = null;
  }
};

// kitty renders this text badge next to the cursor for the whole drag session —
// the visual feedback we lose by handing the pointer to the OS
const sendDragIcon = (n: number): void => {
  const label = `${n} item${n === 1 ? "" : "s"}`;
  const b64 = Buffer.from(label, "utf8").toString("base64").replace(/=+$/, "");
  // byte-exact w/ yazi: fmt:y / size cells:X,Y / opacity / m flag — NO terminator
  osc72Write(`\x1b]72;t=p:x=-1:y=0:X=${label.length + 2}:Y=1:o=0:m=0;${b64}\x1b\\`, "drag icon");
};

const beginOsc72Drag = (paths: string[]): void => {
  osc72DragPaths = paths;
  osc72DragOp = 1;
  osc72SelfHandled = false;
  finishDragState(); // pointer is about to be grabbed by the terminal
  osc72Write("\x1b]72;t=o:o=3;text/uri-list\x1b\\", "agree drag either");
  presentDragUriList(paths);
  sendDragIcon(paths.length);
  osc72Write("\x1b]72;t=P:x=-1\x1b\\", "start drag");
  setStatusMsg(`Dragging ${paths.length} item${paths.length === 1 ? "" : "s"} — drop into another app or a folder`);
};

// self-dropped back onto tfm: route to the folder/place under the cursor,
// otherwise cancel — this is what makes one plain drag serve both worlds
const handleSelfDropHover = (x: number, y: number): void => {
  clearSelfDropHighlight();
  const target = x >= 0 ? resolveDropTargetAt(x, y) : null;
  dlog(`self hover ${x},${y} -> ${target ? target.kind + ":" + target.path : "none"}`);
  if (!target) {
    mousePlaceIdx = -1;
    normalizePlaces();
    return;
  }
  if (target.kind === "folder") {
    osc72SelfTargetKey = target.path;
    setTileVisual(target.path, 2);
  } else {
    const idx = placesHost.findIndex((p) => p.place.path === target.path);
    if (idx >= 0) { mousePlaceIdx = idx; normalizePlaces(); }
  }
};

const finishSelfDrop = async (x: number, y: number): Promise<void> => {
  dlog(`self drop at ${x},${y}`);
  if (osc72EndTimer) { clearTimeout(osc72EndTimer); osc72EndTimer = null; }
  const paths = osc72DragPaths;
  osc72SelfHandled = true;
  const target = resolveDropTargetAt(x, y);
  clearSelfDropHighlight();
  osc72DragPaths = null;
  osc72SelfHandled = false;
  if (!paths?.length || !target) {
    osc72Write("\x1b]72;t=r:o=0\x1b\\", "self drop rejected");
    setStatusMsg("drag cancelled");
    return;
  }
  const destDir = target.path;
  // same routing as tile/place drops: conflict prompt, undo units, honest counts —
  // never silently skip collisions; the trash place must gio-trash, not raw-move
  if (destDir === path.join(home, ".local/share/Trash/files")) {
    void trashPaths(paths);
    return;
  }
  const items: ClipItem[] = paths.map((p) => ({
    path: p,
    isDir:
      tileRefsByKey.get(p)?.isDir ??
      (() => {
        try { return statSync(p).isDirectory(); } catch { return false; }
      })(),
  }));
  await moveInto(destDir, items);
};

const percentEncodePath = (p: string): string => encodeURIComponent(p).replace(/%2F/g, "/");

const presentDragUriList = (paths: string[]): void => {
  const b64 = Buffer.from(paths.map((p) => `file://${percentEncodePath(p)}`).join("\r\n"), "utf8")
    .toString("base64")
    .replace(/=+$/, ""); // unpadded, like yazi
  osc72Write(`\x1b]72;t=p:x=0:m=0;${b64}\x1b\\`, `present drag ${b64.length} b64 chars`);
  osc72Write("\x1b]72;t=p:x=0\x1b\\", "present drag end");
};

const uriListToPaths = (data: string): string[] =>
  data
    .split(/\r?\n/)
    .filter((l) => l.startsWith("file://"))
    .map((l) => {
      let u = l.slice(7);
      if (!u.startsWith("/")) u = u.slice(u.indexOf("/") + 1);
      try { u = decodeURIComponent(u); } catch {}
      return u;
    });

const finishOsc72Drop = async (idx: number): Promise<void> => {
  const b64 = osc72Arrive[idx];
  delete osc72Arrive[idx];
  osc72DropIdx = -1;
  osc72Write(`\x1b]72;t=r:o=1\x1b\\`, `finish drop idx=${idx}`);
  dlog(`drop complete, uri-list bytes=${b64 ? Buffer.from(b64, "base64").length : 0}`);
  if (!b64) return;
  if (isVirtualCwd()) {
    setStatusMsg("Drops land in a real folder");
    return;
  }
  const text = Buffer.from(b64, "base64").toString("utf8");
  let paths = uriListToPaths(text);
  // some sources deliver bare paths (text/plain) instead of file:// URIs
  if (!paths.length) paths = text.split(/\r?\n/).filter((l) => l.startsWith("/"));
  dlog(`paths: ${paths.join(" | ") || "(none)"}`);
  if (paths.length) await runTransfer("copy", state.cwd, paths, "drop");
};

const handleOsc72 = (meta: string, payload: string): void => {
  let t = "";
  let x = NaN, y = NaN, m = false;
  for (const part of meta.split(":")) {
    const [k, v] = part.split("=");
    if (k === "t") t = v ?? "";
    else if (k === "x") x = parseInt(v ?? "", 10);
    else if (k === "y") y = parseInt(v ?? "", 10);
    else if (k === "m") m = v === "1";
  }

  // --- outgoing drag session ---
  // middle-button drags go external (OS session + icon badge); left drags are
  // declined so the internal move flow keeps the pointer and its UI feedback
  if (t === "o" && x >= 0) {
    const want = !dragCtrl && !!dragKeys?.length && !promptOpen && !menuOpen && !fileMenuState;
    dlog(`drag offer x=${x} y=${y} ctrl=${dragCtrl} accept=${want} keys=${dragKeys?.length ?? -1} prompt=${promptOpen} menu=${menuOpen} fmenu=${!!fileMenuState}`);
    if (!want || !dragKeys) return; // left-drag: kitty falls back to normal mouse events
    beginOsc72Drag(dragKeys.map((k) => k.path));
    return;
  }
  if (t === "e") {
    if (x === 2) { osc72DragOp = y === 2 ? 2 : 1; dlog(`drag op=${osc72DragOp === 2 ? "move" : "copy"}`); }
    else if (x === 3) { dlog(`drag landed op=${osc72DragOp}`); }
    else if (x === 4) {
      const canceled = y !== 0;
      dlog(`drag end canceled=${canceled} op=${osc72DragOp} selfHandled=${osc72SelfHandled}`);
      const pathsAtEnd = osc72DragPaths;
      const finishExternal = (): void => {
        if (!canceled && pathsAtEnd && !osc72SelfHandled) {
          // released over another app: honor move semantics by trashing our copies
          if (osc72DragOp === 2) trashPaths(pathsAtEnd);
          else notify(`Sent ${pathsAtEnd.length} item${pathsAtEnd.length === 1 ? "" : "s"}`, "drag & drop");
        } else if (canceled) setStatusMsg("drag cancelled");
        osc72DragPaths = null;
        osc72SelfHandled = false;
        clearSelfDropHighlight();
      };
      if (osc72EndTimer) { clearTimeout(osc72EndTimer); osc72EndTimer = null; }
      // a self-drop M may still be in flight behind the end event — defer
      if (!canceled && pathsAtEnd && !osc72SelfHandled) osc72EndTimer = setTimeout(finishExternal, 700);
      else finishExternal();
    }
    else if (x === 5 && osc72DragPaths && !osc72SelfHandled) { dlog("drag send request"); presentDragUriList(osc72DragPaths); }
    return;
  }

  // --- self-drop: hover/drop events landing back on tfm during OUR session ---
  if ((t === "m" || t === "M") && osc72DragPaths) {
    if (x === -1 && y === -1) { clearSelfDropHighlight(); mousePlaceIdx = -1; normalizePlaces(); return; }
    if (t === "m") { handleSelfDropHover(x, y); return; }
    void finishSelfDrop(x, y); // M — dropped on ourselves
    return;
  }

  // DropLeave
  if (t === "m" && x === -1 && y === -1) {
    dlog("leave");
    osc72DropIdx = -1;
    for (const k of Object.keys(osc72Arrive)) delete osc72Arrive[Number(k)];
    return;
  }

  if (t === "m" || t === "M") {
    const mimes = payload.split(/\s+/).filter(Boolean);
    const idx = mimes.indexOf("text/uri-list");
    dlog(`${t === "M" ? "ready" : "enter"} mimes=[${mimes}] uriIdx=${idx} busy=${osc72DropIdx >= 0}`);
    if (idx < 0 || osc72DropIdx >= 0) return;
    osc72Write(`\x1b]72;t=m:o=1;text/uri-list\x1b\\`, "agree copy");
    if (t === "M") {
      // kitty's mime indices are 1-based (yazi requests ipairs index)
      osc72DropIdx = idx + 1;
      osc72Arrive[osc72DropIdx] = "";
      osc72Write(`\x1b]72;t=r:x=${osc72DropIdx}\x1b\\`, `start drop uriIdx=${idx} wire=${osc72DropIdx}`);
    }
    return;
  }
  if (t === "r" && x === osc72DropIdx) {
    osc72Arrive[x] += payload;
    // presence of payload or m=1 means more chunks are coming
    if (!payload && !m) void finishOsc72Drop(x);
    return;
  }
  if (t === "R") { dlog(`drop error: ${payload}`); setStatusMsg("drop failed"); return; }
  if (t === "E") { dlog(`drag offer error: ${payload}`); setStatusMsg("drag failed"); return; }
  dlog(`unhandled osc72 type t=${JSON.stringify(t)} x=${x} y=${y} payloadLen=${payload.length}`);
};

renderer.subscribeOsc((seq: string) => {
  const start = seq.indexOf("]72;");
  if (start < 0) return;
  const body = seq.slice(start + 4).replace(/(\x1b\\|\x07|\x9c)$/, "");
  handleOsc72(body.slice(0, body.indexOf(";") < 0 ? body.length : body.indexOf(";")), body.indexOf(";") < 0 ? "" : body.slice(body.indexOf(";") + 1));
});
enableDrops();
// XTSHIFTESCAPE=1 (CSI > Ps s): ask the terminal (kitty, ghostty, xterm) to
// forward shift+click instead of using it for native text selection.
// Terminals that don't know the sequence ignore it; alt+click is the fallback.
osc72Write("\x1b[>1s", "xtshiftescape on");

// --- resize: repave rasters and rebuild layout ---
let resizeTimer: any = null;
renderer.on(CliRenderEvents.RESIZE, () => {
  if (resizeTimer) clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    for (const s of iconQueue) s.done = false;
    renderAll();
  }, 150);
});

// --- Keyboard ---
renderer.keyInput.on("keypress", (e: any) => {
  const ctrl = !!e.ctrl || !!e.control;
  if (ctrl && (e.name === "q" || e.unicode === "q")) {
    quitApp();
    return;
  }
  if (promptOpen) return;

  // override/conflict modal: esc = skip, everything else swallowed (mouse-driven)
  if (conflictOpen) {
    if (e.name === "escape") closeConflict("skip");
    return;
  }

  // inline rename: the focused Input consumes typing; swallow everything else
  // so arrows/shortcuts don't move grid focus mid-edit (esc/enter handled at
  // the source via handleKeyPress / "enter")
  if (renameEdit) return;

  // floating properties dialog: esc/enter closes, everything else swallowed
  if (propsOpen) {
    if (e.name === "escape" || e.name === "return") closeProps();
    return;
  }

  // notification test: ctrl+g (ctrl+i is indistinguishable from tab)
  if (ctrl && e.name === "g") {
    notify(`hello at ${new Date().toLocaleTimeString()}`, "debug");
    return;
  }

  if (menuOpen) {
    if (e.name === "escape") closeMenu();
    else if (e.name === "up") moveMenu(-1);
    else if (e.name === "down") moveMenu(1);
    else if (e.name === "left") adjustSelectedSetting(-1);
    else if (e.name === "right") adjustSelectedSetting(1);
    else if (e.name === "return") menuActivate();
    return;
  }

  // embedded terminal owns the keyboard while focused — everything below is
  // host UI. Click the grid/sidebar (or ✕) to leave the shell.
  if (termFocused || termHasFocus()) return;

  const el: any = renderer.root.findDescendantById("tfm-search");
  const pathInput: any = renderer.root.findDescendantById("tfm-path-input");

  if (pathInput?.visible || pathEditMode) {
    if (e.name === "escape") {
      exitPathEdit();
      return;
    }
    return;
  }

  // file context menu open: arrows/enter navigate it, esc closes
  if (fileMenuState) {
    const entries = fileMenuState.entries;
    const count = entries.length;
    const step = (d: number) => {
      let i = (fileMenuState!.idx + d + count) % count;
      while (entries[i]?.sep) i = (i + d + count) % count;
      fileMenuState!.idx = i;
      renderFileMenu();
    };
    if (e.name === "escape") closeFileMenu();
    else if (e.name === "up") step(-1);
    else if (e.name === "down") step(1);
    else if (e.name === "return") entries[fileMenuState.idx]?.action();
    return;
  }

  if (el?.visible) {
    if (e.name === "escape") {
      const had = !!searchQuery;
      clearSearch();
      if (had) void renderGrid();
      return;
    }
    // enter commits: open the first folder match (dirs sort first in the
    // filtered grid); fall back to opening the first file match
    if (e.name === "return") {
      const firstDir = focusKeys.find((k) => tileRefsByKey.get(k)?.isDir);
      const targetKey = firstDir ?? focusKeys[0];
      const refs = targetKey !== undefined ? tileRefsByKey.get(targetKey) : undefined;
      if (targetKey && refs) {
        if (refs.isDir) navigate(targetKey);
        else { openFileDefault(targetKey); clearSearch(); void renderGrid(); }
      } else {
        clearSearch();
        void renderGrid();
      }
      return;
    }
    return;
  }

  // --- keyboard navigation: sidebar <-> grid ---
  // shift+arrows extend the selection from the anchor instead of moving it
  const extendFromAnchor = (next: number): void => {
    if (selAnchor === null) {
      selAnchor = focusIdx >= 0 ? focusIdx : 0;
    }
    if (next === focusIdx || next < 0 || next >= focusKeys.length) return;
    selectTileAt(next);
    selectRange(selAnchor, next);
    updateSelectionStatusReal();
    void renderPreview();
  };
  if (e.shift && !ctrl && e.name === "up") { if (focusKeys.length) { selAnchor = selAnchor ?? (focusIdx >= 0 ? focusIdx : 0); extendFromAnchor(focusIdx < 0 ? 0 : focusIdx - colsAtBuild); } return; }
  if (e.shift && !ctrl && e.name === "down") { if (focusKeys.length) { selAnchor = selAnchor ?? (focusIdx >= 0 ? focusIdx : 0); extendFromAnchor(focusIdx < 0 ? 0 : focusIdx + colsAtBuild); } return; }
  if (e.shift && !ctrl && e.name === "left") { if (focusKeys.length && focusIdx > 0) extendFromAnchor(focusIdx - 1); return; }
  if (e.shift && !ctrl && e.name === "right") { if (focusKeys.length && focusIdx < focusKeys.length - 1) extendFromAnchor(focusIdx + 1); return; }

  if (sidebarActive) {
    if (e.name === "up") { setSidebarFocus(placeIdx - 1); return; }
    if (e.name === "down") { setSidebarFocus(placeIdx + 1); return; }
    if (e.name === "left" || e.name === "right") {
      leaveSidebarToGrid();
      selectTileAt(focusIdx >= 0 ? focusIdx : 0);
      return;
    }
    if (e.name === "return") {
      const rec = placesHost[placeIdx];
      if (rec) {
        closeFileMenu();
        sidebarActive = false;
        placeIdx = -1;
        const target = rec.place.scheme === "recent" ? RECENT_URI
          : rec.place.scheme === "starred" ? STARRED_URI
          : rec.place.path;
        if (target) navigate(target);
        else if (rec.place.mountDevice) mountDevice(rec.place.mountDevice);
      }
      return;
    }
    return;
  }

  if (e.name === "up") { moveFocus(0, -1); return; }
  if (e.name === "down") { moveFocus(0, 1); return; }
  if (e.name === "left") {
    const atLeftEdge = focusIdx === -1 || focusIdx % colsAtBuild === 0;
    if (atLeftEdge || focusKeys.length === 0) {
      const selRec = placesHost.findIndex((p) => p.selected);
      const pk = focusIdx >= 0 ? focusKeys[focusIdx] : undefined;
      if (pk !== undefined) {
        const pr = tileRefsByKey.get(pk);
        if (pr && !pr.selected) setTileVisual(pk, 0);
      }
      sidebarActive = true;
      setSidebarFocus(selRec >= 0 ? selRec : 0);
      return;
    }
    moveFocus(-1, 0);
    return;
  }
  if (e.name === "right") { moveFocus(1, 0); return; }
  if (e.name === "return" && focusIdx >= 0) {
    const key = focusKeys[focusIdx];
    const refs = key !== undefined ? tileRefsByKey.get(key) : undefined;
    if (key && refs) {
      if (refs.isDir) navigate(key);
      else openFileDefault(key);
    }
    return;
  }
  if (e.name === "backspace") {
    const parent = path.dirname(path.resolve(state.cwd));
    if (parent !== path.resolve(state.cwd)) navigate(parent);
    return;
  }
  if (!ctrl && !e.shift && typeof e.name === "string" && e.name.length === 1 && /[a-z0-9._-]/i.test(e.name)) {
    beginTypeToSearch(e.name);
    return;
  }

  if (e.name === "escape") {
    openMenu();
    return;
  }
  if (ctrl && (e.name === "h" || e.unicode === "h")) {
    state.showHidden = !state.showHidden;
    renderGrid();
  }
  if (ctrl && (e.name === "r" || e.unicode === "r")) {
    void loadSystemPlaces().then(() => renderAll());
  }

  // --- file operations ---
  if (ctrl && (e.name === "a" || e.unicode === "a")) {
    tileRefsByKey.forEach((r, k) => { r.selected = true; setTileVisual(k, 2); });
    updateSelectionStatusReal();
    return;
  }
  const selected = selPaths();
  if (e.name === "delete" && selected.length) {
    if (inTrashView()) {
      // no cursor coords in a keybind — the confirm dialog is a centered modal
      confirmDeleteForever(selected.map((s) => s.path));
    }
    else trashPaths(selected.map((s) => s.path));
    return;
  }
  if (e.name === "f2" && selected.length === 1 && selected[0]) {
    // in the trash F2 restores instead of renaming
    if (inTrashView()) {
      restoreFromTrash(selected.map((s) => s.path));
      return;
    }
    const p = selected[0].path;
    startInlineRename(p);
    return;
  }
  if (ctrl && (e.name === "c" || e.unicode === "c") && selected.length) {
    setClipboard("copy", selected);
    return;
  }
  if (ctrl && (e.name === "x" || e.unicode === "x") && selected.length) {
    setClipboard("cut", selected);
    return;
  }
  if (ctrl && (e.name === "v" || e.unicode === "v") && !isVirtualCwd()) {
    pasteSmart(state.cwd);
    return;
  }
  if (ctrl && (e.name === "z" || e.unicode === "z")) {
    undoLast();
    return;
  }
});
