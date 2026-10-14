import { statSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execBun, type ExecBunResult } from "./exec-bun";
import { fileUriToPath, pathToUri } from "./uri";
import { trashDir } from "./fsutil";
import { parseServerInput } from "./network";
import { listNetworkMounts, type NetworkMount } from "./netmount";

// --- System places sources, Nautilus-style: XDG user dirs, GTK bookmarks,
// lsblk mounts and the sidebar section model built from them. Owns the
// loaded state behind accessors; callers re-run loadSystemPlaces() to
// refresh. No renderer, no UI state. ---

// lsblk is re-read on every device poll, so this rides the fast Bun.spawn
// path (execBun) — a wedged lsblk resolves empty via the timeout, never throws
const execLsblk = (args: string[]): Promise<ExecBunResult> => execBun("lsblk", args, { timeoutMs: 10_000 });
const home = os.homedir();

export type Place = {
  icon: string;
  label: string;
  path: string | null;
  ejectable: boolean;
  device?: string;
  mountDevice?: string;
  // whole-disk ancestor (/dev/sdb for /dev/sdb1) + every mounted partition
  // on that disk: Eject unmounts each part then powers the disk off. Rides
  // only on ejectable (USB) rows — internal disks never power off.
  disk?: string;
  diskParts?: Array<{ device: string; target: string }>;
  scheme?: "recent" | "starred";
  bookmarked?: boolean;
  // network locations (gvfs): `action:"connect"` opens the server prompt,
  // `networkUri` is the gvfs URI for an active mount or a saved connection
  network?: boolean;
  networkUri?: string;
  action?: "connect";
};

// One sidebar group + the title the sidebar paints above it (see
// [ui] sidebar-section-titles). Title rides with the group so a section hidden
// by [ui] sidebar-show-* can never leave an orphan header.
export type SidebarSection = { title: string; places: Place[] };

// Safely-remove spec: everything ejectDevice needs in one object (the menu
// row and the sidebar icon build the same shape from their Place). `parts`
// is the whole disk's mounted partitions when known — the chain unmounts
// each before powering `disk` off; without it eject degrades to unmounting
// the single `device` (today's unmount-only behavior for non-USB rows).
export type EjectSpec = {
  device?: string;
  label: string;
  target?: string | null;
  disk?: string;
  parts?: Array<{ device: string; target: string }>;
};

type UserDir = { key: string; label: string; p: string };

export type MountEntry = {
  label: string;
  target: string;
  removable: boolean;
  device: string;
  // usb-attached (lsblk TRAN, inherited parent→child like rm): the kernel RM
  // flag lies on many USB-SATA bridges (RM=0), so TRAN is what marks a drive
  // ejectable + power-off-eligible
  usb: boolean;
  // whole-disk ancestor path (/dev/sdb for /dev/sdb1) — power-off targets
  // the disk, unmount targets the partitions
  disk: string;
};

type BookmarkEntry = { p: string; label: string; remote?: boolean; uri?: string };

let sysUserDirs: UserDir[] = [];
let sysBookmarks: BookmarkEntry[] = [];
let sysMounts: MountEntry[] = [];
let sysNetwork: NetworkMount[] = [];

export const loadSystemPlaces = async (opts?: { skipMounts?: boolean }): Promise<void> => {
  // four independent sources — await them concurrently so the sidebar load costs
  // the slowest one, not their sum. lsblk is ~20ms typical but measured 218ms
  // on slow udev (2026-10) — it is the only slow source, so first paint skips
  // it (skipMounts, boot-only: sysMounts is guaranteed empty there) and a
  // background refresh fills mounts in; sysMounts keeps its current value
  // (empty at boot = "This Device" only).
  const [dirs, marks, mounts, network] = await Promise.all([
    readUserDirs(),
    readBookmarks(),
    opts?.skipMounts ? Promise.resolve<MountEntry[] | null>(null) : listMounts(),
    listNetworkMounts(),
  ]);
  sysUserDirs = dirs;
  sysBookmarks = marks;
  if (mounts !== null) sysMounts = mounts;
  sysNetwork = network;
};

const xdgUserDirsFile = () => path.join(process.env.XDG_CONFIG_HOME ?? path.join(home, ".config"), "user-dirs.dirs");

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
      const key = m?.[1];
      const value = m?.[2];
      if (!key || !value) continue;
      const label = XDG_LABELS[key];
      if (!label) continue;
      const p = expandXdgValue(value);
      // XDG rule (and nautilus): pointing at $HOME disables the entry
      if (!p || p === home) continue;
      try {
        if (!statSync(p).isDirectory()) continue;
      } catch {
        continue;
      }
      out.push({ key, label, p });
    }
    return out.sort((a, b) => (a.key < b.key ? -1 : 1));
  } catch {
    return [];
  }
}

async function readBookmarks(): Promise<BookmarkEntry[]> {
  try {
    const file = gtkBookmarksFile();
    const text = await readFile(file, "utf8");
    const out: BookmarkEntry[] = [];
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      const sp = line.indexOf(" ");
      const uri = sp === -1 ? line : line.slice(0, sp);
      const label = sp === -1 ? "" : line.slice(sp + 1).trim();
      if (uri.startsWith("file://")) {
        const p = fileUriToPath(uri);
        try {
          if (!statSync(p).isDirectory()) continue;
        } catch {
          continue;
        }
        out.push({ p, label: label || path.basename(p) });
        continue;
      }
      // remote gvfs bookmark (sftp://, smb://, …) — kept so saved connections
      // persist across sessions and Nautilus shares the same list
      const parsed = parseServerInput(uri);
      if (!parsed) continue;
      out.push({ p: "", label: label || parsed.label, remote: true, uri: parsed.uri });
    }
    return out;
  } catch {
    return [];
  }
}

// --- GTK bookmark toggle (properties dialog; folders only, nautilus-compatible) ---
const gtkBookmarksFile = (): string =>
  path.join(process.env.XDG_CONFIG_HOME ?? path.join(home, ".config"), "gtk-3.0", "bookmarks");

export const isBookmarked = (dir: string): boolean =>
  sysBookmarks.some((b) => !b.remote && b.p && path.resolve(b.p) === path.resolve(dir));

// rewrite preserving order + custom labels; additions go last (nautilus does too)
export const setBookmarked = async (dir: string, on: boolean): Promise<void> => {
  const file = gtkBookmarksFile();
  let lines: string[] = [];
  try {
    lines = (await readFile(file, "utf8")).split("\n");
  } catch {}
  const uri = pathToUri(dir);
  const kept = lines.filter((l) => l.trim() && l.split(" ")[0] !== uri);
  if (on) kept.push(uri);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, kept.join("\n") + (kept.length ? "\n" : ""), "utf8");
};

const PSEUDO_FSTYPES = new Set([
  "squashfs",
  "tmpfs",
  "devtmpfs",
  "proc",
  "sysfs",
  "efivarfs",
  "overlay",
  "ramfs",
  "devfs",
  "cgroup",
]);
const SYSTEM_MOUNTS = new Set(["/", "/boot", "/boot/efi", "/efi", "/swap"]);

// lsblk's `-J` payload: only these fields are read, and any of them may be
// missing (or mistyped) on an odd util-linux build — so they are typed to what
// the code assumes rather than to what the JSON is guaranteed to carry.
// TRAN exists since util-linux 2.25 (2014); children report tran:null, so it
// inherits exactly like rm.
type LsblkNode = {
  name?: string;
  label?: string;
  path?: string;
  rm?: boolean;
  tran?: string | null;
  fstype?: string | null;
  mountpoint?: string;
  mountpoints?: Array<string | { mountpoint?: string }>;
  children?: LsblkNode[];
  blockdevices?: LsblkNode[];
};

export function parseLsblk(json: unknown): MountEntry[] {
  const out: MountEntry[] = [];
  const visit = (nodes: unknown, parentRm: boolean, parentTran: string | null, parentDisk: string): void => {
    if (!Array.isArray(nodes)) return;
    for (const raw of nodes) {
      const n = raw as LsblkNode;
      const name: string = n?.name ?? "";
      const rm = !!n?.rm || parentRm;
      const tran = typeof n?.tran === "string" && n.tran ? n.tran : parentTran;
      const usb = tran?.toLowerCase() === "usb";
      // the whole disk is the topmost /dev node: children inherit the
      // ancestor's path, the topmost node is its own disk
      const device = n?.path ?? `/dev/${name}`;
      const disk = parentDisk || device;
      if (/^(loop|zram|ram\d+)/.test(name)) {
        const kids = n?.children;
        if (Array.isArray(kids)) visit(kids, rm, tran, disk);
        continue;
      }
      const fstype: string | null | undefined = n?.fstype;
      let mps: string[] = [];
      const rawMps = n?.mountpoints;
      if (Array.isArray(rawMps)) {
        mps = rawMps.map((m) => (typeof m === "string" ? m : m?.mountpoint)).filter((m): m is string => !!m);
      } else if (typeof n?.mountpoint === "string") {
        mps = [n.mountpoint];
      }
      if (mps.length === 0) {
        // mounted-nowhere but has a filesystem -> clickable to mount (nautilus behavior)
        if (fstype && !PSEUDO_FSTYPES.has(fstype)) {
          out.push({ label: n?.label || name, target: "", removable: rm || usb, usb, device, disk });
        }
      }
      for (const target of mps) {
        if (!target || target.startsWith("[")) continue;
        if (SYSTEM_MOUNTS.has(target)) continue;
        if (target.startsWith("/snap") || target.startsWith("/var/lib/docker")) continue;
        const label = n?.label || path.basename(target) || name;
        if (!out.some((o) => o.target === target)) out.push({ label, target, removable: rm || usb, usb, device, disk });
      }
      if (Array.isArray(n?.children)) visit(n.children, rm, tran, disk);
    }
  };
  visit((json as LsblkNode | null | undefined)?.blockdevices ?? [], false, null, "");
  return out;
}

// exported for the device watcher (devwatch.ts): the poll diffs this list,
// loadSystemPlaces() re-reads everything only when it changed
export async function listMounts(): Promise<MountEntry[]> {
  try {
    // timeout: a wedged lsblk must not stall the sidebar load forever
    const { code, stdout } = await execLsblk(["-J", "-o", "NAME,PATH,RM,TRAN,LABEL,FSTYPE,MOUNTPOINTS,MOUNTPOINT"]);
    if (code !== 0) return [];
    return parseLsblk(JSON.parse(stdout));
  } catch {
    return [];
  }
}

export type SidebarVisibility = {
  showRecent?: boolean;
  showStarred?: boolean;
  showTrash?: boolean;
  showUserDirs?: boolean;
  showBookmarks?: boolean;
  showDevices?: boolean;
  showNetwork?: boolean;
};

export function buildSections(vis: SidebarVisibility = {}): SidebarSection[] {
  const { showRecent = true, showStarred = true, showTrash = true } = vis;
  const { showUserDirs = true, showBookmarks = true, showDevices = true, showNetwork = true } = vis;
  const trashFilesDir = path.join(trashDir(), "files");
  const hasTrash = (() => {
    try {
      return statSync(trashFilesDir).isDirectory();
    } catch {
      return false;
    }
  })();

  const defaults: Place[] = [{ icon: "home", label: "Home", path: home, ejectable: false }];
  if (showRecent) defaults.push({ icon: "clock", label: "Recent", path: null, ejectable: false, scheme: "recent" });
  if (showStarred) defaults.push({ icon: "star", label: "Starred", path: null, ejectable: false, scheme: "starred" });
  if (showTrash && hasTrash)
    defaults.push({ icon: "trash-can", label: "Trash", path: trashFilesDir, ejectable: false });

  const dirs: Place[] = showUserDirs
    ? sysUserDirs.map((d) => ({ icon: "folder", label: d.label, path: d.p, ejectable: false }))
    : [];

  const bookmarks: Place[] = showBookmarks
    ? sysBookmarks
        .filter((b) => !b.remote)
        .map((b) => ({
          icon: "bookmark",
          label: b.label,
          path: b.p,
          ejectable: false,
          bookmarked: true,
        }))
    : [];

  const devices: Place[] = [
    { icon: "harddisk", label: "This Device", path: "/", ejectable: false },
    ...sysMounts.map(
      (m): Place => ({
        icon: m.removable ? "usb" : "harddisk",
        label: m.label,
        path: m.target || null,
        ejectable: m.removable && !!m.target,
        device: m.device,
        mountDevice: m.target ? undefined : m.device,
        // every mounted partition sharing this row's disk: the eject chain
        // unmounts each before powering the disk off
        ...(m.usb && m.target
          ? {
              disk: m.disk,
              diskParts: sysMounts
                .filter((o) => o.usb && o.disk === m.disk && o.target)
                .map((o) => ({ device: o.device, target: o.target })),
            }
          : {}),
      }),
    ),
  ];

  // Network: an always-present "Connect to Server…" row, active gvfs mounts,
  // and saved remote bookmarks that aren't mounted yet (click connects). A
  // bookmark whose share is already mounted is shown once, as the mount.
  const normUri = (u: string): string => u.replace(/\/+$/, "").toLowerCase();
  const mounted = new Map(sysNetwork.map((m) => [normUri(m.uri), m]));
  const network: Place[] = [
    { icon: "network", label: "Connect to Server…", path: null, ejectable: false, action: "connect" },
    ...sysNetwork.map(
      (m): Place => ({
        icon: "network",
        label: m.label,
        path: m.path,
        ejectable: false,
        network: true,
        networkUri: m.uri,
      }),
    ),
    ...sysBookmarks
      .filter((b) => b.remote && b.uri && !mounted.has(normUri(b.uri)))
      .map(
        (b): Place => ({
          icon: "network",
          label: b.label,
          path: null,
          ejectable: false,
          network: true,
          networkUri: b.uri,
        }),
      ),
  ];

  const sections: SidebarSection[] = [{ title: "Places", places: defaults }];
  if (dirs.length) sections.push({ title: "Folders", places: dirs });
  if (bookmarks.length) sections.push({ title: "Bookmarks", places: bookmarks });
  if (showDevices) sections.push({ title: "Devices", places: devices });
  if (showNetwork) sections.push({ title: "Network", places: network });
  return sections;
}
