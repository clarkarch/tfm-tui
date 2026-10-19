import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildSections, loadSystemPlaces, parseLsblk } from "./places";
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
        {
          name: "nvme0n1",
          rm: false,
          path: "/dev/nvme0n1",
          children: [{ name: "nvme0n1p2", fstype: "ext4", mountpoints: ["/", "/boot"] }],
        },
        {
          name: "sda",
          rm: true,
          path: "/dev/sda",
          children: [{ name: "sda1", fstype: "vfat", mountpoints: ["/run/media/clark/USB"] }],
        },
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
    // a parentless node is its own disk; non-usb so no power-off either way
    expect(out).toEqual([
      { label: "sdb1", target: "", removable: false, usb: false, device: "/dev/sdb1", disk: "/dev/sdb1" },
    ]);
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

  test("a USB-SATA bridge with RM=0 still counts as removable (TRAN=usb)", () => {
    // many enclosures lie about RM — TRAN is the truth (udisks2
    // ConnectionBus agrees). Without this the drive is a dead row: mounted,
    // so no click-to-mount, and no eject affordance either.
    const out = parseLsblk({
      blockdevices: [
        {
          name: "sdb",
          rm: false,
          tran: "usb",
          path: "/dev/sdb",
          children: [{ name: "sdb1", fstype: "ext4", mountpoints: ["/media/u/disk"] }],
        },
      ],
    });
    expect(out).toEqual([
      { label: "disk", target: "/media/u/disk", removable: true, usb: true, device: "/dev/sdb1", disk: "/dev/sdb" },
    ]);
  });

  test("children inherit the parent's TRAN (lsblk reports tran:null on partitions)", () => {
    const out = parseLsblk({
      blockdevices: [
        {
          name: "sdb",
          rm: true,
          tran: "usb",
          path: "/dev/sdb",
          children: [{ name: "sdb1", tran: null, fstype: "vfat", mountpoints: ["/media/u/stick"] }],
        },
      ],
    });
    expect(out[0]!.usb).toBe(true);
    expect(out[0]!.disk).toBe("/dev/sdb");
  });

  test("TRAN matches case-insensitively (odd builds report USB)", () => {
    const out = parseLsblk({
      blockdevices: [
        {
          name: "sdb",
          rm: false,
          tran: "USB",
          path: "/dev/sdb",
          children: [{ name: "sdb1", fstype: "vfat", mountpoints: ["/media/u/stick"] }],
        },
      ],
    });
    expect(out[0]!.removable).toBe(true);
    expect(out[0]!.usb).toBe(true);
  });

  test("sata/nvme stay non-removable even with children mounted", () => {
    const out = parseLsblk({
      blockdevices: [
        {
          name: "sda",
          rm: false,
          tran: "sata",
          path: "/dev/sda",
          children: [{ name: "sda1", fstype: "ext4", mountpoints: ["/data"] }],
        },
        {
          name: "nvme0n1",
          rm: false,
          tran: "nvme",
          path: "/dev/nvme0n1",
          children: [{ name: "nvme0n1p1", fstype: "ext4", mountpoints: ["/fast"] }],
        },
      ],
    });
    expect(out.map((o) => [o.target, o.removable, o.usb])).toEqual([
      ["/data", false, false],
      ["/fast", false, false],
    ]);
  });

  test("an unmounted USB partition carries its disk for click-to-mount", () => {
    const out = parseLsblk({
      blockdevices: [
        {
          name: "sdb",
          rm: false,
          tran: "usb",
          path: "/dev/sdb",
          children: [{ name: "sdb1", fstype: "ext4", mountpoints: [null] }],
        },
      ],
    });
    expect(out).toEqual([
      { label: "sdb1", target: "", removable: true, usb: true, device: "/dev/sdb1", disk: "/dev/sdb" },
    ]);
  });
});

describe("loadSystemPlaces + buildSections", () => {
  test("reads XDG user dirs (skips $HOME entries) and bookmarks, builds sections", async () => {
    const tmp = mkdtempAndDirs();
    try {
      process.env.XDG_CONFIG_HOME = tmp.configHome;
      await loadSystemPlaces();
      const flat = buildSections().flatMap((s) => s.places);
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
    process.env.XDG_CONFIG_HOME = path.join(os.tmpdir(), `tfm-places-nonexistent-${process.pid}`);
    await loadSystemPlaces();
    const flat = buildSections().flatMap((s) => s.places);
    expect(flat.some((p) => p.label === "Home")).toBe(true);
    expect(flat.some((p) => p.label === "This Device")).toBe(true);
  });
});

describe("loadSystemPlaces skipMounts (lazy first paint)", () => {
  const oldPath = process.env.PATH;
  const oldCfg = process.env.XDG_CONFIG_HOME;
  afterEach(() => {
    if (oldPath === undefined) delete process.env.PATH;
    else process.env.PATH = oldPath;
    if (oldCfg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = oldCfg;
  });

  // lsblk costs ~200ms on slow udev and used to gate the first renderAll.
  // Boot loads dirs/bookmarks/network first and refreshes mounts in the
  // background — skipMounts must not spawn lsblk at all. Stub on PATH (same
  // seam install.sh tests use for curl): a marker file records invocation.
  // SCOPE: these tests pin places.ts only (skipMounts skips the spawn, full
  // load performs it). The FLAG branch (which call wiring/io.ts makes) is
  // pinned in wiring/io-boot-mounts.test.ts — these tests never read
  // lazyStartup and would stay green through a wiring flip-flop.
  const withLsblkStub = async (): Promise<{ root: string; markerBytes: () => number }> => {
    const root = path.join(os.tmpdir(), `tfm-places-skip-${process.pid}-${Date.now()}`);
    const bin = path.join(root, "bin");
    const marker = path.join(root, "lsblk-called");
    mkdirSync(bin, { recursive: true });
    writeFileSync(
      path.join(bin, "lsblk"),
      `#!/bin/sh\necho called >> ${JSON.stringify(marker)}\necho '{"blockdevices":[]}'\n`,
      { mode: 0o755 },
    );
    process.env.PATH = `${bin}${path.delimiter}${oldPath ?? ""}`;
    const configHome = path.join(root, "config");
    mkdirSync(configHome, { recursive: true });
    process.env.XDG_CONFIG_HOME = configHome;
    return {
      root,
      markerBytes: (): number => {
        try {
          return Bun.file(marker).size;
        } catch {
          return 0;
        }
      },
    };
  };

  test("skipMounts loads the rest without spawning lsblk; full load spawns it", async () => {
    // one test for both halves of the places-level contract (skip = no spawn,
    // full = spawn) — the second half used to live inline in the test above
    const { root, markerBytes } = await withLsblkStub();
    try {
      await loadSystemPlaces({ skipMounts: true });
      expect(markerBytes()).toBe(0);
      // the rest still loaded (sysMounts keeps whatever earlier tests left —
      // the skip only promises "no lsblk spawn", pinned above — so assert a
      // static section instead of mount-dependent content)
      expect(buildSections()[0]!.places[0]!.label).toBe("Home");
      // full load spawns lsblk (stub records it)
      await loadSystemPlaces();
      expect(markerBytes()).toBeGreaterThan(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("virtual place uris used by places", () => {
  test("recent/starred are virtual", () => {
    expect(isVirtualUri("recent://")).toBe(true);
    expect(isVirtualUri("starred://")).toBe(true);
    expect(isVirtualUri("/home")).toBe(false);
  });
});

describe("network places", () => {
  test("a remote gvfs bookmark becomes a network place; Connect row always present", async () => {
    const root = path.join(os.tmpdir(), `tfm-net-${process.pid}-${Math.random().toString(36).slice(2)}`);
    const configHome = path.join(root, "config");
    mkdirSync(path.join(configHome, "gtk-3.0"), { recursive: true });
    writeFileSync(path.join(configHome, "gtk-3.0", "bookmarks"), "sftp://bob@example.com/pub remote\n");
    const oldRuntime = process.env.XDG_RUNTIME_DIR;
    try {
      process.env.XDG_CONFIG_HOME = configHome;
      // nonexistent runtime dir -> listNetworkMounts finds no real mounts
      process.env.XDG_RUNTIME_DIR = path.join(root, "runtime");
      await loadSystemPlaces();
      const flat = buildSections().flatMap((s) => s.places);
      expect(flat.some((p) => p.action === "connect" && p.label === "Connect to Server…")).toBe(true);
      const remote = flat.find((p) => p.network && p.networkUri === "sftp://bob@example.com/pub");
      expect(remote?.label).toBe("remote");
      expect(remote?.path).toBeNull();
    } finally {
      if (oldRuntime === undefined) delete process.env.XDG_RUNTIME_DIR;
      else process.env.XDG_RUNTIME_DIR = oldRuntime;
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("buildSections visibility toggles", () => {
  test("hiding recent/starred drops only those rows, Home stays", async () => {
    const tmp = mkdtempAndDirs();
    try {
      process.env.XDG_CONFIG_HOME = tmp.configHome;
      await loadSystemPlaces();
      const flat = buildSections({ showRecent: false, showStarred: false }).flatMap((s) => s.places);
      expect(flat.some((p) => p.label === "Home")).toBe(true);
      expect(flat.some((p) => p.scheme === "recent")).toBe(false);
      expect(flat.some((p) => p.scheme === "starred")).toBe(false);
    } finally {
      rmSync(tmp.root, { recursive: true, force: true });
    }
  });

  test("hiding user dirs/bookmarks/devices/network drops whole groups", async () => {
    const tmp = mkdtempAndDirs();
    try {
      process.env.XDG_CONFIG_HOME = tmp.configHome;
      await loadSystemPlaces();
      const flat = buildSections({
        showUserDirs: false,
        showBookmarks: false,
        showDevices: false,
        showNetwork: false,
      }).flatMap((s) => s.places);
      expect(flat.some((p) => p.label === "Documents")).toBe(false);
      expect(flat.some((p) => p.label === "mydocs")).toBe(false);
      expect(flat.some((p) => p.label === "This Device")).toBe(false);
      expect(flat.some((p) => p.action === "connect")).toBe(false);
      // defaults survive the group hides
      expect(flat.some((p) => p.label === "Home")).toBe(true);
    } finally {
      rmSync(tmp.root, { recursive: true, force: true });
    }
  });
});

describe("buildSections section titles", () => {
  test("every section carries the title the sidebar renders it under", async () => {
    const tmp = mkdtempAndDirs();
    try {
      process.env.XDG_CONFIG_HOME = tmp.configHome;
      await loadSystemPlaces();
      const titles = buildSections().map((s) => s.title);
      expect(titles[0]).toBe("Places");
      expect(titles).toContain("Folders");
      expect(titles).toContain("Bookmarks");
      expect(titles).toContain("Devices");
      expect(titles).toContain("Network");
    } finally {
      rmSync(tmp.root, { recursive: true, force: true });
    }
  });

  test("a hidden group takes its title with it (no orphan header)", async () => {
    const tmp = mkdtempAndDirs();
    try {
      process.env.XDG_CONFIG_HOME = tmp.configHome;
      await loadSystemPlaces();
      const titles = buildSections({
        showUserDirs: false,
        showBookmarks: false,
        showDevices: false,
        showNetwork: false,
      }).map((s) => s.title);
      expect(titles).toEqual(["Places"]);
    } finally {
      rmSync(tmp.root, { recursive: true, force: true });
    }
  });
});

function mkdtempAndDirs() {
  const root = path.join(os.tmpdir(), `tfm-places-${process.pid}-${Math.random().toString(36).slice(2)}`);
  const configHome = path.join(root, "config");
  const docs = path.join(root, "Documents");
  const bookmarkDir = path.join(root, "bm");
  mkdirSync(configHome, { recursive: true });
  mkdirSync(docs, { recursive: true });
  mkdirSync(bookmarkDir, { recursive: true });
  writeFileSync(
    path.join(configHome, "user-dirs.dirs"),
    `XDG_DOCUMENTS_DIR="${docs}"\nXDG_MUSIC_DIR="${os.homedir()}"\n`,
  );
  mkdirSync(path.join(configHome, "gtk-3.0"), { recursive: true });
  writeFileSync(path.join(configHome, "gtk-3.0", "bookmarks"), `file://${bookmarkDir} mydocs\nnot-a-file-uri\n`);
  return { root, configHome, docs, bookmarkDir };
}
