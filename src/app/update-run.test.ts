import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { UPDATE_INSTALLER_URL } from "./update";
import {
  fetchLatestTag,
  firstTfmLine,
  installDirOf,
  installInfoPath,
  isDevBuild,
  readInstallInfo,
  runInstaller,
  type InstallerSpawn,
  type UpdateFetch,
} from "./update-run";

const okText = (body: string): Awaited<ReturnType<UpdateFetch>> => ({
  ok: true,
  status: 200,
  headers: { get: () => null },
  text: async () => body,
});

const redirect = (location: string | null): Awaited<ReturnType<UpdateFetch>> => ({
  ok: !!location,
  status: location ? 302 : 404,
  headers: { get: (n: string) => (n.toLowerCase() === "location" ? location : null) },
  text: async () => "",
});

describe("process identity (pure)", () => {
  test("a JS runner is a dev build, an installed binary is not", () => {
    expect(isDevBuild("/usr/bin/bun")).toBe(true);
    expect(isDevBuild("/usr/local/bin/node")).toBe(true);
    expect(isDevBuild("/home/u/.bun/bin/bun")).toBe(true);
    expect(isDevBuild("/home/u/.local/bin/tfm")).toBe(false);
    expect(isDevBuild("/opt/tfm/tfm")).toBe(false);
  });

  test("the install dir is the binary's own directory", () => {
    expect(installDirOf("/home/u/.local/bin/tfm")).toBe("/home/u/.local/bin");
    expect(installDirOf("/usr/local/bin/terminal-file-manager")).toBe("/usr/local/bin");
  });

  test("provenance lives next to the rest of tfm's XDG data", () => {
    const prev = process.env.XDG_DATA_HOME;
    process.env.XDG_DATA_HOME = "/tmp/opencode/xdg-data-probe";
    try {
      expect(installInfoPath()).toBe("/tmp/opencode/xdg-data-probe/tfm/install.json");
    } finally {
      if (prev === undefined) delete process.env.XDG_DATA_HOME;
      else process.env.XDG_DATA_HOME = prev;
    }
  });
});

describe("latest tag (network seam)", () => {
  test("reads the tag off the /releases/latest redirect", async () => {
    const tag = await fetchLatestTag({
      fetch: async () => redirect("https://github.com/clarkarch/tfm-tui/releases/tag/v1.1.0"),
    });
    expect(tag).toBe("1.1.0");
  });

  test("no releases yet (a 200 or a 404) is null, never a tag", async () => {
    expect(await fetchLatestTag({ fetch: async () => redirect(null) })).toBeNull();
    expect(await fetchLatestTag({ fetch: async () => okText("") })).toBeNull();
  });

  test("offline / timeout resolves null instead of throwing at the caller", async () => {
    const tag = await fetchLatestTag({
      fetch: async () => {
        throw new Error("getaddrinfo ENOTFOUND");
      },
    });
    expect(tag).toBeNull();
  });
});

describe("installer output (pure)", () => {
  test("picks the installer's own headline out of the captured text", () => {
    const out = [
      "tfm: FAILED verify, checksum mismatch",
      "tfm: The download didn't match our security checksum.",
      "tfm: Nothing was installed. Please try again in a moment.",
    ].join("\n");
    expect(firstTfmLine(out)).toBe("FAILED verify, checksum mismatch");
  });

  test("falls back to the last real line when there is no tfm: line", () => {
    expect(firstTfmLine("bash: install.sh: No such file or directory\n")).toBe(
      "bash: install.sh: No such file or directory",
    );
    expect(firstTfmLine("   \n\n")).toBe("");
  });

  test("keeps the detail to one toast-sized line", () => {
    const long = `tfm: ${"x".repeat(400)}`;
    expect(firstTfmLine(long).length).toBeLessThanOrEqual(80);
  });
});

describe("runInstaller", () => {
  const fakeSpawn = (
    code: number,
    output = "",
    probe?: (argv: string[]) => void,
  ): { spawn: InstallerSpawn; argv: string[][]; envs: Record<string, string | undefined>[] } => {
    const argv: string[][] = [];
    const envs: Record<string, string | undefined>[] = [];
    return {
      argv,
      envs,
      spawn: (a, o) => {
        argv.push(a);
        envs.push(o.env);
        probe?.(a);
        return { exited: Promise.resolve(code), output: async () => output };
      },
    };
  };

  test("delegates to the published installer with the version + dir pinned", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "tfm-update-run-"));
    const tmp = path.join(dir, "installer.sh");
    // the staged script exists only DURING the run (it is cleaned up after),
    // so the proof has to be taken at spawn time
    let staged = "";
    const f = fakeSpawn(0, "", () => {
      staged = readFileSync(tmp, "utf8");
    });
    try {
      const res = await runInstaller({
        tag: "v1.1.0",
        installDir: "/home/u/.local/bin",
        fetch: async (url) => {
          expect(url).toBe(UPDATE_INSTALLER_URL);
          return okText("#!/usr/bin/env bash\necho hi\n");
        },
        spawn: f.spawn,
        tmpFile: () => tmp,
      });
      expect(res.ok).toBe(true);
      expect(f.argv[0]).toEqual(["bash", tmp]);
      expect(f.envs[0]?.TFM_VERSION).toBe("v1.1.0");
      expect(f.envs[0]?.TFM_INSTALL_DIR).toBe("/home/u/.local/bin");
      // the installer appends the restart hint to its own success panel
      expect(f.envs[0]?.TFM_UPDATE_HINT).toBe("1");
      // the script really was staged for bash before it ran
      expect(staged).toContain("echo hi");
      expect(existsSync(tmp)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("hands back the installer's failure line for the toast", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "tfm-update-run-"));
    const tmp = path.join(dir, "installer.sh");
    const f = fakeSpawn(1, "tfm: FAILED download, download failed\ntfm: Nothing was installed.\n");
    try {
      const res = await runInstaller({
        fetch: async () => okText("#!/usr/bin/env bash\n"),
        spawn: f.spawn,
        tmpFile: () => tmp,
      });
      expect(res.ok).toBe(false);
      expect(res.code).toBe(1);
      expect(res.detail).toBe("FAILED download, download failed");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a fetch that isn't a script is refused before anything runs", async () => {
    const spawned: string[][] = [];
    const res = await runInstaller({
      // a captive portal / proxy answering 200 with HTML: never execute it
      fetch: async () => okText("<html>you are offline</html>"),
      spawn: (a) => {
        spawned.push(a);
        return { exited: Promise.resolve(0), output: async () => "" };
      },
    });
    expect(res.ok).toBe(false);
    expect(spawned).toHaveLength(0);
    expect(res.detail).toMatch(/installer/);
  });

  test("a download failure never spawns bash", async () => {
    const spawned: string[][] = [];
    const res = await runInstaller({
      fetch: async () => ({ ok: false, status: 500, headers: { get: () => null }, text: async () => "" }),
      spawn: (a) => {
        spawned.push(a);
        return { exited: Promise.resolve(0), output: async () => "" };
      },
    });
    expect(res.ok).toBe(false);
    expect(spawned).toHaveLength(0);
  });

  test("a missing bash degrades to a failure result, never a throw", async () => {
    const res = await runInstaller({
      fetch: async () => okText("#!/usr/bin/env bash\n"),
      spawn: () => {
        // Bun.spawn throws SYNCHRONOUSLY on a missing binary
        throw new Error("Executable not found in $PATH: bash");
      },
      tmpFile: () => path.join(os.tmpdir(), "tfm-update-missing-bash.sh"),
    });
    expect(res.ok).toBe(false);
    expect(res.detail).toContain("bash");
  });

  test("the staged script is removed on both outcomes", async () => {
    for (const code of [0, 3]) {
      const dir = mkdtempSync(path.join(os.tmpdir(), "tfm-update-run-"));
      const tmp = path.join(dir, "installer.sh");
      try {
        await runInstaller({
          fetch: async () => okText("#!/usr/bin/env bash\n"),
          spawn: () => ({ exited: Promise.resolve(code), output: async () => "" }),
          tmpFile: () => tmp,
        });
        expect(existsSync(tmp), `code=${code}`).toBe(false);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });
});

describe("install provenance", () => {
  test("round-trips channel + version so update can't guess wrong", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "tfm-install-info-"));
    const file = path.join(dir, "install.json");
    try {
      writeFileSync(file, JSON.stringify({ channel: "source", ref: "dev", dest: "/home/u/.local/bin" }));
      expect(readInstallInfo(file)).toEqual({
        channel: "source",
        version: null,
        ref: "dev",
        dest: "/home/u/.local/bin",
        installedAt: null,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("garbage or an unknown channel reads as no provenance", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "tfm-install-info-"));
    const file = path.join(dir, "install.json");
    try {
      writeFileSync(file, "}{");
      expect(readInstallInfo(file)).toBeNull();
      writeFileSync(file, JSON.stringify({ channel: "whatever" }));
      expect(readInstallInfo(file)).toBeNull();
      expect(readInstallInfo(path.join(dir, "absent.json"))).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
