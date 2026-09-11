import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { desktopAppName, appsForFile, parseGioMime, runOutShort } from "./apps";

const oldDataHome = process.env.XDG_DATA_HOME;
afterEach(() => {
  if (oldDataHome === undefined) delete process.env.XDG_DATA_HOME;
  else process.env.XDG_DATA_HOME = oldDataHome;
});

describe("runOutShort", () => {
  test("captures trimmed stdout", async () => {
    const out = await runOutShort(["printf", "  hello \n world  "]);
    expect(out).toBe("hello \n world");
  });

  test("returns empty string for a missing binary", async () => {
    const out = await runOutShort(["definitely-not-a-real-binary-xyz"]);
    expect(out).toBe("");
  });

  test("kills processes that exceed the timeout", async () => {
    const out = await runOutShort(["sleep", "5"], 80);
    expect(out).toBe("");
  });
});

describe("desktopAppName", () => {
  test("reads the first non-localized Name= inside [Desktop Entry]", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "tfm-apps-"));
    process.env.XDG_DATA_HOME = root;
    try {
      const dir = path.join(root, "applications");
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        path.join(dir, "tfm-fake-app.desktop"),
        `[Desktop Entry]\nType=Application\nName[en_US]=Wrong Localized\nGenericName=Also Not This\nName=Right Name\nComment=after\n`,
      );
      expect(await desktopAppName("tfm-fake-app.desktop")).toBe("Right Name");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("falls back to the id without the .desktop suffix", async () => {
    // unique id — must not exist in any real applications dir
    process.env.XDG_DATA_HOME = path.join(os.tmpdir(), `tfm-apps-missing-${Date.now()}`);
    expect(await desktopAppName("tfm-no-such-app-xyzzy.desktop")).toBe("tfm-no-such-app-xyzzy");
  });

  test("empty id yields empty name", async () => {
    expect(await desktopAppName("")).toBe("");
  });
});

describe("parseGioMime", () => {
  test("keeps the default first, dedupes, ignores prose", () => {
    const out =
      "Default application for “text/plain”: dev.zed.Zed.desktop\n" +
      "Registered applications:\n\tdev.zed.Zed.desktop\n\tvim.desktop\n" +
      "Recommended applications:\n\tvim.desktop\n";
    expect(parseGioMime(out)).toEqual(["dev.zed.Zed.desktop", "vim.desktop"]);
  });

  test("empty output yields no handlers", () => {
    expect(parseGioMime("")).toEqual([]);
  });
});

describe("appsForFile", () => {
  test("resolves handlers that exist on disk, drops unknown ids", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "tfm-apps-openwith-"));
    process.env.XDG_DATA_HOME = root;
    try {
      const dir = path.join(root, "applications");
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, "tfm-openwith.desktop"), `[Desktop Entry]\nType=Application\nName=Fake Editor\n`);
      const run = async (cmd: string[]): Promise<string> =>
        cmd[0] === "xdg-mime"
          ? "text/plain"
          : "Default application for “text/plain”: tfm-openwith.desktop\n" +
            "Registered applications:\n\ttfm-openwith.desktop\n\tdefinitely-missing.desktop\n";
      const apps = await appsForFile("/tmp/x.txt", run);
      expect(apps.map((a) => a.name)).toEqual(["Fake Editor"]);
      expect(apps[0]!.file).toBe(path.join(dir, "tfm-openwith.desktop"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a failed mime probe yields no apps", async () => {
    expect(await appsForFile("/x.txt", async () => "")).toEqual([]);
  });
});
