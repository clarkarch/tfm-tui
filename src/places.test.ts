import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildSections, loadSystemPlaces, parseLsblk, systemBookmarks, systemMounts, systemUserDirs } from "./places";
import { isVirtualUri } from "./uri";

const oldConfigHome = process.env.XDG_CONFIG_HOME;
afterEach(() => {
  if (oldConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = oldConfigHome;
});

describe("parseLsblk", () => {
  test("walks children, inherits rm, skips loop/zram/ram and system mounts", () => {
    const out = parseLsblk({
      blockdevices: [
        { name: "nvme0n1", rm: false, path: "/dev/nvme0n1", children: [
          { name: "nvme0n1p2", fstype: "ext4", mountpoints: ["/", "/boot"] },
        ]},
        { name: "sda", rm: true, path: "/dev/sda", children: [
          { name: "sda1", fstype: "vfat", mountpoints: ["/run/media/clark/USB"] },
        ]},
        { name: "loop0", fstype: "squashfs", mountpoints: ["/snap/foo"] },
        { name: "zram0", fstype: "swap", mountpoints: ["[SWAP]"] },
      ],
    });
    expect(out.length).toBe(1);
    expect(out[0]!.target).toBe("/run/media/clark/USB");
    expect(out[0]!.removable).toBe(true);
  });

  test("mounted-nowhere with real fs is clickable-to-mount", () => {
    const out = parseLsblk({
      blockdevices: [{ name: "sdb1", path: "/dev/sdb1", fstype: "ext4", mountpoints: [null] }],
    });
    expect(out).toEqual([{ label: "sdb1", target: "", removable: false, device: "/dev/sdb1" }]);
  });

  test("skips pseudo fstypes, snap/docker targets, duplicate targets", () => {
    const out = parseLsblk({
      blockdevices: [
        { name: "sr0", fstype: "iso9660", mountpoints: ["/snap/x"] },
        { name: "dm-0", fstype: "ext4", mountpoints: ["/var/lib/docker/overlay2/x"] },
        { name: "sdc1", fstype: "ext4", mountpoints: ["/mnt/a", "/mnt/a"] },
      ],
    });
    expect(out.map((o) => o.target)).toEqual(["/mnt/a"]);
  });
});

describe("loadSystemPlaces + buildSections", () => {
  test("reads XDG user dirs (skips $HOME entries) and bookmarks, builds sections", async () => {
    const tmp = mkdtempAndDirs();
    try {
      process.env.XDG_CONFIG_HOME = tmp.configHome;
      await loadSystemPlaces();
      expect(systemUserDirs().map((d) => d.key)).toEqual(["XDG_DOCUMENTS_DIR"]);
      expect(systemBookmarks().map((b) => b.p)).toEqual([tmp.bookmarkDir]);
      const flat = buildSections().flat();
      expect(flat[0]!.label).toBe("Home");
      expect(flat.some((p) => p.label === "Documents" && p.path === tmp.docs)).toBe(true);
      expect(flat.some((p) => p.label === "mydocs" && p.path === tmp.bookmarkDir && p.bookmarked)).toBe(true);
      expect(flat.some((p) => p.scheme === "recent")).toBe(true);
      expect(flat.some((p) => p.scheme === "starred")).toBe(true);
      expect(flat.some((p) => p.label === "This Device" && p.path === "/")).toBe(true);
    } finally {
      rmSync(tmp.root, { recursive: true, force: true });
    }
  });

  test("missing config dir yields empty groups without throwing", async () => {
    process.env.XDG_CONFIG_HOME = path.join(os.tmpdir(), "tfm-places-nonexistent-" + process.pid);
    await loadSystemPlaces();
    expect(systemUserDirs()).toEqual([]);
    expect(systemBookmarks()).toEqual([]);
    const flat = buildSections().flat();
    expect(flat.some((p) => p.label === "Home")).toBe(true);
    expect(flat.some((p) => p.label === "This Device")).toBe(true);
  });
});

describe("virtual place uris used by places", () => {
  test("recent/starred are virtual", () => {
    expect(isVirtualUri("recent://")).toBe(true);
    expect(isVirtualUri("starred://")).toBe(true);
    expect(isVirtualUri("/home")).toBe(false);
  });
});

function mkdtempAndDirs() {
  const root = path.join(os.tmpdir(), "tfm-places-" + process.pid + "-" + Math.random().toString(36).slice(2));
  const configHome = path.join(root, "config");
  const docs = path.join(root, "Documents");
  const bookmarkDir = path.join(root, "bm");
  mkdirSync(configHome, { recursive: true });
  mkdirSync(docs, { recursive: true });
  mkdirSync(bookmarkDir, { recursive: true });
  writeFileSync(path.join(configHome, "user-dirs.dirs"), `XDG_DOCUMENTS_DIR="${docs}"\nXDG_MUSIC_DIR="${os.homedir()}"\n`);
  mkdirSync(path.join(configHome, "gtk-3.0"), { recursive: true });
  writeFileSync(path.join(configHome, "gtk-3.0", "bookmarks"), `file://${bookmarkDir} mydocs\nnot-a-file-uri\n`);
  return { root, configHome, docs, bookmarkDir };
}
