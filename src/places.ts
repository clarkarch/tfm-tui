import { execFile } from "node:child_process";
import { statSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { pathToUri } from "./uri";
import { trashDir } from "./fsutil";

// --- System places sources, Nautilus-style: XDG user dirs, GTK bookmarks,
// lsblk mounts and the sidebar section model built from them. Owns the
// loaded state behind accessors; callers re-run loadSystemPlaces() to
// refresh. No renderer, no UI state. ---

const execFileP = promisify(execFile);
const home = os.homedir();

export type Place = { icon: string; label: string; path: string | null; ejectable: boolean; device?: string; mountDevice?: string; scheme?: "recent" | "starred"; bookmarked?: boolean };

export type UserDir = { key: string; label: string; p: string };

export type MountEntry = { label: string; target: string; removable: boolean; device: string };

export type BookmarkEntry = { p: string; label: string };

let sysUserDirs: UserDir[] = [];
let sysBookmarks: BookmarkEntry[] = [];
let sysMounts: MountEntry[] = [];

export const systemUserDirs = (): UserDir[] => sysUserDirs;
export const systemBookmarks = (): BookmarkEntry[] => sysBookmarks;
export const systemMounts = (): MountEntry[] => sysMounts;

export const loadSystemPlaces = async (): Promise<void> => {
  sysUserDirs = await readUserDirs();
  sysBookmarks = await readBookmarks();
  sysMounts = await listMounts();
};

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

export async function readUserDirs(): Promise<UserDir[]> {
  try {
    const text = await readFile(xdgUserDirsFile(), "utf8");
    const out: UserDir[] = [];
    for (const line of text.split("\n")) {
      const m = line.match(/^(XDG_[A-Z_]+_DIR)\s*=\s*(.+)$/);
      if (!m?.[1] || !m[2]) continue;
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

export async function readBookmarks(): Promise<BookmarkEntry[]> {
  try {
    const file = gtkBookmarksFile();
    const text = await readFile(file, "utf8");
    const out: BookmarkEntry[] = [];
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
export const gtkBookmarksFile = (): string =>
  path.join(process.env.XDG_CONFIG_HOME ?? path.join(home, ".config"), "gtk-3.0", "bookmarks");

export const bookmarkUri = pathToUri;

export const isBookmarked = (dir: string): boolean =>
  sysBookmarks.some((b) => path.resolve(b.p) === path.resolve(dir));

// rewrite preserving order + custom labels; additions go last (nautilus does too)
export const setBookmarked = async (dir: string, on: boolean): Promise<void> => {
  const file = gtkBookmarksFile();
  let lines: string[] = [];
  try { lines = (await readFile(file, "utf8")).split("\n"); } catch {}
  const uri = bookmarkUri(dir);
  const kept = lines.filter((l) => l.trim() && l.split(" ")[0] !== uri);
  if (on) kept.push(uri);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, kept.join("\n") + (kept.length ? "\n" : ""), "utf8");
};

const PSEUDO_FSTYPES = new Set(["squashfs", "tmpfs", "devtmpfs", "proc", "sysfs", "efivarfs", "overlay", "ramfs", "devfs", "cgroup"]);
const SYSTEM_MOUNTS = new Set(["/", "/boot", "/boot/efi", "/efi", "/swap"]);

export function parseLsblk(json: any): MountEntry[] {
  const out: MountEntry[] = [];
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

export async function listMounts(): Promise<MountEntry[]> {
  try {
    const { stdout } = await execFileP("lsblk", ["-J", "-o", "NAME,PATH,RM,LABEL,FSTYPE,MOUNTPOINTS,MOUNTPOINT"]);
    return parseLsblk(JSON.parse(stdout));
  } catch {
    return [];
  }
}

export function buildSections(): Place[][] {
  const trashFilesDir = path.join(trashDir(), "files");
  const hasTrash = (() => { try { return statSync(trashFilesDir).isDirectory(); } catch { return false; } })();

  const defaults: Place[] = [{ icon: "home", label: "Home", path: home, ejectable: false }];
  defaults.push({ icon: "clock", label: "Recent", path: null, ejectable: false, scheme: "recent" });
  defaults.push({ icon: "star", label: "Starred", path: null, ejectable: false, scheme: "starred" });
  if (hasTrash) defaults.push({ icon: "trash-can", label: "Trash", path: trashFilesDir, ejectable: false });

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
