import { describe, expect, test } from "bun:test";
import type { InstallerResult } from "./update-run";
import { parseUpdateArgs, runUpdateCli, updateHelp, type UpdateCliDeps } from "./update-cli";

type Harness = {
  deps: UpdateCliDeps;
  out: string[];
  err: string[];
  installs: Array<{ tag?: string; installDir?: string; capture?: boolean }>;
  asked: string[];
};

const harness = (over: Partial<UpdateCliDeps> = {}): Harness => {
  const out: string[] = [];
  const err: string[] = [];
  const installs: Array<{ tag?: string; installDir?: string; capture?: boolean }> = [];
  const asked: string[] = [];
  const deps: UpdateCliDeps = {
    out: (l) => out.push(l),
    err: (l) => err.push(l),
    current: "1.0.0",
    execPath: "/home/u/.local/bin/tfm",
    isTTY: () => false,
    // Injected, never the real `readInstallInfo`: that reads the machine's
    // $XDG_DATA_HOME/tfm/install.json, so on a dev box with tfm source-installed
    // (channel "source") every command here refused with exit 1 while CI, which
    // has no install.json, stayed green. Tests that exercise the provenance
    // branches pass their own `provenance` to override this.
    provenance: () => null,
    fetch: async () => ({
      ok: true,
      status: 302,
      headers: { get: () => "https://github.com/clarkarch/tfm-tui/releases/tag/v1.1.0" },
      text: async () => "",
    }),
    install: async (d) => {
      installs.push({ tag: d?.tag, installDir: d?.installDir, capture: d?.capture });
      return { ok: true, code: 0, detail: "" };
    },
    ...over,
  };
  return { deps, out, err, installs, asked };
};

describe("arg parsing (pure)", () => {
  test("bare `tfm update` resolves the latest release", () => {
    expect(parseUpdateArgs([])).toEqual({ cmd: "update", tag: null, force: false, error: null });
  });

  test("--tag pins a release, with or without the v", () => {
    expect(parseUpdateArgs(["--tag", "v1.1.0"]).tag).toBe("1.1.0");
    expect(parseUpdateArgs(["--tag=1.1.0"]).tag).toBe("1.1.0");
    expect(parseUpdateArgs(["--tag", "nightly"]).error).toMatch(/tag/);
    expect(parseUpdateArgs(["--tag"]).error).toMatch(/tag/);
  });

  test("--force is the reinstall escape hatch", () => {
    expect(parseUpdateArgs(["--force"]).force).toBe(true);
    expect(parseUpdateArgs(["-f"]).force).toBe(true);
  });

  test("help wins, unknown flags are usage errors", () => {
    expect(parseUpdateArgs(["help"]).cmd).toBe("help");
    expect(parseUpdateArgs(["--help"]).cmd).toBe("help");
    expect(parseUpdateArgs(["--check"]).error).toMatch(/unknown/);
  });
});

describe("runUpdateCli", () => {
  test("already current: says so, installs nothing, exits 0", async () => {
    const h = harness({
      fetch: async () => ({
        ok: true,
        status: 302,
        headers: { get: () => "https://github.com/clarkarch/tfm-tui/releases/tag/v1.0.0" },
        text: async () => "",
      }),
    });
    expect(await runUpdateCli([], h.deps)).toBe(0);
    expect(h.out).toEqual(["tfm 1.0.0 is up to date"]);
    expect(h.installs).toHaveLength(0);
  });

  test("newer release: prints the arrow, then hands over to the installer", async () => {
    const h = harness();
    expect(await runUpdateCli([], h.deps)).toBe(0);
    expect(h.out[0]).toBe("tfm 1.0.0 → 1.1.0");
    // the version is pinned and the running binary's own dir is preserved
    expect(h.installs).toEqual([{ tag: "v1.1.0", installDir: "/home/u/.local/bin", capture: false }]);
  });

  test("interactive: asks first, and a No changes nothing", async () => {
    const asked: string[] = [];
    const h = harness({
      isTTY: () => true,
      ask: async (q) => {
        asked.push(q);
        return false;
      },
    });
    expect(await runUpdateCli([], h.deps)).toBe(0);
    expect(asked[0]).toContain("Update");
    expect(h.installs).toHaveLength(0);
    expect(h.err.join("\n")).toBe("");
  });

  test("interactive: a Yes installs", async () => {
    const h = harness({ isTTY: () => true, ask: async () => true });
    expect(await runUpdateCli([], h.deps)).toBe(0);
    expect(h.installs).toHaveLength(1);
  });

  test("an installer failure is reported and exits 1", async () => {
    const h = harness({
      install: async (): Promise<InstallerResult> => ({
        ok: false,
        code: 1,
        detail: "FAILED verify, checksum mismatch",
      }),
    });
    expect(await runUpdateCli([], h.deps)).toBe(1);
    expect(h.err.join("\n")).toContain("checksum mismatch");
  });

  test("offline: says so and exits 1, never claiming up to date", async () => {
    const h = harness({
      fetch: async () => {
        throw new Error("ENOTFOUND");
      },
    });
    expect(await runUpdateCli([], h.deps)).toBe(1);
    expect(h.err.join("\n")).toMatch(/github\.com/);
    expect(h.out.join("\n")).not.toContain("up to date");
  });

  test("a dev build refuses instead of replacing bun", async () => {
    const h = harness({ execPath: "/usr/local/bin/bun" });
    expect(await runUpdateCli([], h.deps)).toBe(1);
    expect(h.err.join("\n")).toMatch(/dev build/);
    expect(h.installs).toHaveLength(0);
  });

  test("a source install refuses and points at source.sh", async () => {
    const h = harness({
      provenance: () => ({ channel: "source", version: null, ref: "dev", dest: null, installedAt: null }),
    });
    expect(await runUpdateCli([], h.deps)).toBe(1);
    expect(h.err.join("\n")).toMatch(/source\.sh/);
    expect(h.installs).toHaveLength(0);
  });

  test("--tag installs exactly that release (the check asks about THAT tag only)", async () => {
    const urls: string[] = [];
    const h = harness({
      fetch: async (url) => {
        urls.push(url);
        // the release exists
        return {
          ok: true,
          status: 200,
          headers: { get: () => null },
          text: async () => "",
        };
      },
    });
    expect(await runUpdateCli(["--tag", "v0.9.0"], h.deps)).toBe(0);
    // one HEAD about the pinned tag — never the "what's the latest" question
    expect(urls).toHaveLength(1);
    expect(urls[0]).toContain("/releases/tag/v0.9.0");
    expect(h.installs).toEqual([{ tag: "v0.9.0", installDir: "/home/u/.local/bin", capture: false }]);
  });

  test("--tag for a release that does not exist says so, and never installs", async () => {
    const h = harness({
      fetch: async (url) => {
        if (url.includes("/releases/tag/")) {
          return { ok: false, status: 404, headers: { get: () => null }, text: async () => "" };
        }
        // the releases feed: what IS published
        return {
          ok: true,
          status: 200,
          headers: { get: () => null },
          text: async () =>
            '<feed><entry><link href="https://github.com/clarkarch/tfm-tui/releases/tag/v1.2.0"/></entry>' +
            '<entry><link href="https://github.com/clarkarch/tfm-tui/releases/tag/v1.1.0"/></entry></feed>',
        };
      },
    });
    expect(await runUpdateCli(["--tag", "1.0.1"], h.deps)).toBe(1);
    const said = h.err.join("\n");
    expect(said).toContain("no release v1.0.1");
    // the published ones are named, so the next try is one keystroke away
    expect(said).toContain("v1.2.0");
    expect(said).toContain("v1.1.0");
    expect(h.installs).toHaveLength(0);
  });

  test("a pinned tag that can't be checked (offline) still tries the install", async () => {
    const h = harness({
      current: "1.2.0",
      fetch: async () => {
        throw new Error("ENOTFOUND");
      },
    });
    expect(await runUpdateCli(["--tag", "1.0.0"], h.deps)).toBe(0);
    expect(h.installs).toHaveLength(1);
  });

  test("a downgrade to an older published release is allowed", async () => {
    const h = harness({
      current: "1.2.0",
      fetch: async (url) => {
        if (url.includes("/releases/tag/")) {
          // the release exists
          return { ok: true, status: 200, headers: { get: () => null }, text: async () => "" };
        }
        return {
          ok: true,
          status: 200,
          headers: { get: () => null },
          text: async () => "",
        };
      },
    });
    expect(await runUpdateCli(["--tag", "1.0.0"], h.deps)).toBe(0);
    expect(h.out[0]).toBe("tfm 1.2.0 → 1.0.0");
    expect(h.installs).toEqual([{ tag: "v1.0.0", installDir: "/home/u/.local/bin", capture: false }]);
  });

  test("--tag for the version already installed is a no-op unless --force", async () => {
    const h = harness();
    expect(await runUpdateCli(["--tag", "1.0.0"], h.deps)).toBe(0);
    expect(h.installs).toHaveLength(0);
    const forced = harness();
    expect(await runUpdateCli(["--tag", "1.0.0", "--force"], forced.deps)).toBe(0);
    expect(forced.installs).toHaveLength(1);
  });

  test("--force reinstalls a release you already run", async () => {
    const h = harness({
      fetch: async () => ({
        ok: true,
        status: 302,
        headers: { get: () => "https://github.com/clarkarch/tfm-tui/releases/tag/v1.0.0" },
        text: async () => "",
      }),
    });
    expect(await runUpdateCli(["--force"], h.deps)).toBe(0);
    expect(h.installs).toHaveLength(1);
  });

  test("help prints usage and exits 0", async () => {
    const h = harness();
    expect(await runUpdateCli(["help"], h.deps)).toBe(0);
    expect(h.out.join("\n")).toBe(updateHelp().trimEnd());
  });

  test("a usage error exits 2 with a pointer to help", async () => {
    const h = harness();
    expect(await runUpdateCli(["--nope"], h.deps)).toBe(2);
    expect(h.err.join("\n")).toMatch(/tfm update help/);
  });
});
