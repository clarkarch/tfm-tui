import { describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
  chmodSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  AmbiguousPluginError,
  derivePluginName,
  findPluginMains,
  installPlugin,
  parseGitUrl,
  removePluginDir,
  updatePlugin,
  type ExecFn,
} from "./plugin-install";

// Installer contract: paste-a-git-URL -> validated -> cloned -> normalized
// into plugins/<name>/<name>.ts. No network here: the git spawn is injected
// (fake exec materializes a fixture tree at the dest arg), so these run
// without a git binary or network.

const mkDir = (): string => mkdtempSync(path.join(os.tmpdir(), "tfm-plugin-install-"));

describe("parseGitUrl", () => {
  test("accepts https with optional #ref and optional subdir token", () => {
    expect(parseGitUrl("https://github.com/u/repo")).toEqual({ url: "https://github.com/u/repo" });
    expect(parseGitUrl("  https://github.com/u/repo.git#main  ")).toEqual({
      url: "https://github.com/u/repo.git",
      ref: "main",
    });
    expect(parseGitUrl("https://github.com/u/mono plugins/foo")).toEqual({
      url: "https://github.com/u/mono",
      subdir: "plugins/foo",
    });
    expect(parseGitUrl("https://github.com/u/mono#dev plugins/foo")).toEqual({
      url: "https://github.com/u/mono",
      ref: "dev",
      subdir: "plugins/foo",
    });
  });

  test("accepts ssh scp-like, ssh:// and git://", () => {
    expect(parseGitUrl("git@github.com:u/repo.git")).toEqual({ url: "git@github.com:u/repo.git" });
    expect(parseGitUrl("ssh://git@github.com/u/repo")).toEqual({ url: "ssh://git@github.com/u/repo" });
    expect(parseGitUrl("git://github.com/u/repo")).toEqual({ url: "git://github.com/u/repo" });
  });

  test("rejects empty, dash-prefixed, control chars and shell metachars", () => {
    expect(() => parseGitUrl("")).toThrow("git URL");
    expect(() => parseGitUrl("   ")).toThrow("git URL");
    expect(() => parseGitUrl("--upload-pack=touch pwn")).toThrow();
    expect(() => parseGitUrl("https://github.com/u/repo\nrm -rf /")).toThrow();
    expect(() => parseGitUrl("https://github.com/u/repo;touch pwn")).toThrow();
    // a host starting with `-` is handed to ssh as an option (no `--`) —
    // git forwards the host as an argv element, so ssh://-oProxyCommand=…
    // is an option-injection vector, not a URL
    expect(() => parseGitUrl("ssh://-oProxyCommand=x/u/repo")).toThrow("starts with '-'");
    expect(() => parseGitUrl("git@-evil.com:u/repo")).toThrow("starts with '-'");
    // a single space is the URL/subdir separator by design (not a rejection):
    // "…/re po" means repo "re" + subdir "po"
    expect(parseGitUrl("https://github.com/u/re po")).toEqual({ url: "https://github.com/u/re", subdir: "po" });
  });

  test("rejects file:// and bare local paths (symlink/hash bypass)", () => {
    expect(() => parseGitUrl("file:///etc/passwd")).toThrow("unsupported");
    expect(() => parseGitUrl("/tmp/some/dir")).toThrow("unsupported");
    expect(() => parseGitUrl("../evil")).toThrow("unsupported");
  });

  test("rejects bad #ref and bad subdir", () => {
    expect(() => parseGitUrl("https://github.com/u/repo#")).toThrow("ref");
    expect(() => parseGitUrl("https://github.com/u/repo#main extra1 extra2")).toThrow();
    expect(() => parseGitUrl("https://github.com/u/repo ../escape")).toThrow("subdir");
    expect(() => parseGitUrl("https://github.com/u/repo /abs/path")).toThrow("subdir");
  });
});

describe("derivePluginName", () => {
  test("strips .git/trailing slash; subdir wins when present", () => {
    expect(derivePluginName(parseGitUrl("https://github.com/u/repo"))).toBe("repo");
    expect(derivePluginName(parseGitUrl("https://github.com/u/repo.git"))).toBe("repo");
    expect(derivePluginName(parseGitUrl("https://github.com/u/repo/"))).toBe("repo");
    expect(derivePluginName(parseGitUrl("git@github.com:u/my-plug.git"))).toBe("my-plug");
    expect(derivePluginName(parseGitUrl("https://github.com/u/mono plugins/foo"))).toBe("foo");
  });

  test("rejects names that could escape the plugins dir", () => {
    expect(() => derivePluginName(parseGitUrl("https://github.com/u/.git"))).toThrow();
    expect(() => derivePluginName({ url: "https://github.com/u/x", subdir: ".." })).toThrow();
  });
});

describe("findPluginMains", () => {
  test("finds folder mains (<name>/<name>.ts) and flat files", () => {
    const dir = mkDir();
    try {
      mkdirSync(path.join(dir, "aaa"), { recursive: true });
      writeFileSync(path.join(dir, "aaa", "aaa.ts"), "export default {};\n");
      writeFileSync(path.join(dir, "solo.ts"), "export default {};\n");
      writeFileSync(path.join(dir, "notes.txt"), "not a plugin");
      mkdirSync(path.join(dir, "empty"), { recursive: true });
      expect(findPluginMains(dir).sort()).toEqual(["aaa/aaa.ts", "solo.ts"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

const fakeCloneWith = (
  materialize: (dest: string) => void,
): { exec: ExecFn; calls: Array<{ cmd: string; args: string[] }> } => {
  const calls: Array<{ cmd: string; args: string[] }> = [];
  const exec: ExecFn = async (cmd, args) => {
    calls.push({ cmd, args });
    // the clone dest is always the last arg — materialize the fixture there
    // (simulates `git clone <url> <dest>` without network)
    materialize(args[args.length - 1]!);
    return { exit: 0, output: "" };
  };
  return { exec, calls };
};

describe("installPlugin", () => {
  test("clones a single-file plugin and normalizes to <name>/<name>.ts", async () => {
    const dir = mkDir();
    try {
      const { exec, calls } = fakeCloneWith((dest) => {
        mkdirSync(dest, { recursive: true });
        writeFileSync(path.join(dest, "cool.ts"), "export default { name: 'cool', activate: () => ({}) };\n");
      });
      const res = await installPlugin({ dir, raw: "https://github.com/u/cool", exec });
      expect(res.name).toBe("cool");
      expect(existsSync(path.join(dir, "cool", "cool.ts"))).toBe(true);
      // argv is array-passed (no shell): url is one arg, dest is last
      expect(calls[0]!.cmd).toBe("git");
      expect(calls[0]!.args.slice(0, 3)).toEqual(["clone", "--depth", "1"]);
      expect(calls[0]!.args).toContain("https://github.com/u/cool");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("clones a folder-layout plugin (repo name differs from plugin name)", async () => {
    const dir = mkDir();
    try {
      const { exec } = fakeCloneWith((dest) => {
        mkdirSync(path.join(dest, "inner"), { recursive: true });
        writeFileSync(path.join(dest, "inner", "inner.ts"), "export default {};\n");
      });
      const res = await installPlugin({ dir, raw: "https://github.com/u/some-repo", exec });
      expect(res.name).toBe("inner");
      expect(existsSync(path.join(dir, "inner", "inner.ts"))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("ref adds --branch; existing dest refuses without clobbering", async () => {
    const dir = mkDir();
    try {
      const { exec, calls } = fakeCloneWith((dest) => {
        mkdirSync(dest, { recursive: true });
        writeFileSync(path.join(dest, "r.ts"), "export default {};\n");
      });
      await installPlugin({ dir, raw: "https://github.com/u/r#dev", exec });
      expect(calls[0]!.args).toContain("--branch");
      expect(calls[0]!.args).toContain("dev");
      await expect(installPlugin({ dir, raw: "https://github.com/u/r", exec })).rejects.toThrow("already installed");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // chmod-based: root bypasses file perms, so this can't fail as uid 0
  test.skipIf(process.getuid?.() === 0)(
    "a mid-copy failure removes the half-populated dest (re-install stays possible)",
    async () => {
      const dir = mkDir();
      try {
        const { exec } = fakeCloneWith((dest) => {
          mkdirSync(path.join(dest, "broken"), { recursive: true });
          writeFileSync(path.join(dest, "broken", "broken.ts"), "export default {};\n");
          // an unreadable helper makes cpSync of the folder throw mid-copy
          writeFileSync(path.join(dest, "broken", "secret"), "x");
          chmodSync(path.join(dest, "broken", "secret"), 0o000);
        });
        await expect(installPlugin({ dir, raw: "https://github.com/u/broken", exec })).rejects.toThrow();
        // the partially-copied folder is gone, so the existence guard doesn't
        // permanently refuse a retry
        expect(existsSync(path.join(dir, "broken"))).toBe(false);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  test("clone failure surfaces stderr and leaves no dest behind", async () => {
    const dir = mkDir();
    try {
      const exec: ExecFn = async () => ({ exit: 128, output: "Repository not found." });
      await expect(installPlugin({ dir, raw: "https://github.com/u/missing", exec })).rejects.toThrow(
        "Repository not found",
      );
      expect(existsSync(path.join(dir, "missing"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("repo with no plugin errors instead of installing an empty folder", async () => {
    const dir = mkDir();
    try {
      const { exec } = fakeCloneWith((dest) => {
        mkdirSync(dest, { recursive: true });
        writeFileSync(path.join(dest, "README.md"), "# nothing\n");
      });
      await expect(installPlugin({ dir, raw: "https://github.com/u/docs", exec })).rejects.toThrow("no plugin found");
      expect(existsSync(path.join(dir, "docs"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("multi-plugin repo throws AmbiguousPluginError (UI shows a pick list)", async () => {
    const dir = mkDir();
    try {
      const { exec } = fakeCloneWith((dest) => {
        mkdirSync(path.join(dest, "aaa"), { recursive: true });
        writeFileSync(path.join(dest, "aaa", "aaa.ts"), "export default {};\n");
        mkdirSync(path.join(dest, "bbb"), { recursive: true });
        writeFileSync(path.join(dest, "bbb", "bbb.ts"), "export default {};\n");
      });
      const err = await installPlugin({ dir, raw: "https://github.com/u/mono", exec }).catch((e) => e);
      expect(err).toBeInstanceOf(AmbiguousPluginError);
      expect((err as AmbiguousPluginError).candidates.sort()).toEqual(["aaa/aaa.ts", "bbb/bbb.ts"]);
      // subdir disambiguates
      const { exec: exec2 } = fakeCloneWith((dest) => {
        mkdirSync(path.join(dest, "aaa"), { recursive: true });
        writeFileSync(path.join(dest, "aaa", "aaa.ts"), "export default {};\n");
        mkdirSync(path.join(dest, "bbb"), { recursive: true });
        writeFileSync(path.join(dest, "bbb", "bbb.ts"), "export default {};\n");
      });
      const res = await installPlugin({ dir, raw: "https://github.com/u/mono bbb", exec: exec2 });
      expect(res.name).toBe("bbb");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("staging hygiene + provenance", () => {
  const leftovers = (dir: string): string[] => readdirSync(dir).filter((n) => n.startsWith(".tmp-"));

  test("no .tmp-* staging dirs survive any outcome (success or failure)", async () => {
    const dir = mkDir();
    try {
      // success
      const { exec } = fakeCloneWith((dest) => {
        mkdirSync(dest, { recursive: true });
        writeFileSync(path.join(dest, "ok.ts"), "export default {};\n");
      });
      await installPlugin({ dir, raw: "https://github.com/u/ok", exec });
      expect(leftovers(dir)).toEqual([]);
      // clone failure
      const failing: ExecFn = async () => ({ exit: 128, output: "nope" });
      await installPlugin({ dir, raw: "https://github.com/u/gone", exec: failing }).catch(() => {});
      // no-plugin repo
      const { exec: empty } = fakeCloneWith((dest) => mkdirSync(dest, { recursive: true }));
      await installPlugin({ dir, raw: "https://github.com/u/empty", exec: empty }).catch(() => {});
      // ambiguous repo
      const { exec: multi } = fakeCloneWith((dest) => {
        for (const n of ["a", "b"]) {
          mkdirSync(path.join(dest, n), { recursive: true });
          writeFileSync(path.join(dest, n, `${n}.ts`), "export default {};\n");
        }
      });
      await installPlugin({ dir, raw: "https://github.com/u/multi", exec: multi }).catch(() => {});
      // already-installed
      await installPlugin({ dir, raw: "https://github.com/u/ok", exec }).catch(() => {});
      expect(leftovers(dir)).toEqual([]);
      expect(existsSync(path.join(dir, "ok", "ok.ts"))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("install records provenance (url/ref/subdir) for later updates", async () => {
    const dir = mkDir();
    try {
      const { exec } = fakeCloneWith((dest) => {
        mkdirSync(path.join(dest, "inner"), { recursive: true });
        writeFileSync(path.join(dest, "inner", "inner.ts"), "export default {};\n");
      });
      const res = await installPlugin({ dir, raw: "https://github.com/u/repo#dev", exec });
      expect(JSON.parse(readFileSync(path.join(res.dest, ".tfm-source.json"), "utf8"))).toEqual({
        url: "https://github.com/u/repo",
        ref: "dev",
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("update via provenance (no-.git installs)", () => {
  test("folder-main install refreshes from a re-clone, keeping state.json", async () => {
    const dir = mkDir();
    try {
      const { exec: installExec } = fakeCloneWith((dest) => {
        mkdirSync(path.join(dest, "cool"), { recursive: true });
        writeFileSync(path.join(dest, "cool", "cool.ts"), "export const v = 1;\n");
      });
      const res = await installPlugin({ dir, raw: "https://github.com/u/repo", exec: installExec });
      writeFileSync(path.join(res.dest, "state.json"), JSON.stringify({ enabled: false }));
      // upstream moves to v2 (fresh clone materializes the new tree)
      const { exec: updateExec, calls } = fakeCloneWith((dest) => {
        mkdirSync(path.join(dest, "cool"), { recursive: true });
        writeFileSync(path.join(dest, "cool", "cool.ts"), "export const v = 2;\n");
      });
      const out = await updatePlugin({ dir, name: "cool", exec: updateExec });
      expect(out).toBe("updated");
      expect(calls[0]!.cmd).toBe("git");
      expect(calls[0]!.args.slice(0, 2)).toEqual(["clone", "--depth"]);
      expect(readFileSync(path.join(res.dest, "cool.ts"), "utf8")).toContain("v = 2");
      // user state + provenance survive the refresh
      expect(JSON.parse(readFileSync(path.join(res.dest, "state.json"), "utf8"))).toEqual({ enabled: false });
      expect(JSON.parse(readFileSync(path.join(res.dest, ".tfm-source.json"), "utf8"))).toEqual({
        url: "https://github.com/u/repo",
      });
      expect(readdirSync(dir).filter((n) => n.startsWith(".tmp-"))).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("upstream without the plugin errors instead of wiping the install", async () => {
    const dir = mkDir();
    try {
      const { exec: installExec } = fakeCloneWith((dest) => {
        mkdirSync(path.join(dest, "cool"), { recursive: true });
        writeFileSync(path.join(dest, "cool", "cool.ts"), "export const v = 1;\n");
      });
      await installPlugin({ dir, raw: "https://github.com/u/repo", exec: installExec });
      const { exec: renamedExec } = fakeCloneWith((dest) => {
        mkdirSync(path.join(dest, "other"), { recursive: true });
        writeFileSync(path.join(dest, "other", "other.ts"), "export const v = 2;\n");
      });
      await expect(updatePlugin({ dir, name: "cool", exec: renamedExec })).rejects.toThrow("no longer contains");
      expect(readFileSync(path.join(dir, "cool", "cool.ts"), "utf8")).toContain("v = 1");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("updatePlugin / removePluginDir", () => {
  test("update pulls --ff-only; non-git checkout refuses", async () => {
    const dir = mkDir();
    try {
      mkdirSync(path.join(dir, "p", ".git"), { recursive: true });
      writeFileSync(path.join(dir, "p", "p.ts"), "export default {};\n");
      const calls: Array<{ cmd: string; args: string[] }> = [];
      const exec: ExecFn = async (cmd, args) => {
        calls.push({ cmd, args });
        return { exit: 0, output: "Already up to date." };
      };
      const out = await updatePlugin({ dir, name: "p", exec });
      expect(out).toContain("Already up to date");
      expect(calls[0]).toEqual({ cmd: "git", args: ["-C", path.join(dir, "p"), "pull", "--ff-only"] });
      mkdirSync(path.join(dir, "manual"), { recursive: true });
      await expect(updatePlugin({ dir, name: "manual", exec })).rejects.toThrow("not a git checkout");
      await expect(updatePlugin({ dir, name: "missing", exec })).rejects.toThrow("not installed");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("update rejects a tampered provenance URL/ref/subdir before spawning git", async () => {
    const dir = mkDir();
    try {
      const mk = (name: string, src: Record<string, unknown>): void => {
        mkdirSync(path.join(dir, name), { recursive: true });
        writeFileSync(path.join(dir, name, ".tfm-source.json"), JSON.stringify(src));
      };
      mk("badurl", { url: "/etc/passwd" });
      mk("badref", { url: "https://example.com/x.git", ref: "--upload-pack=evil" });
      mk("badsub", { url: "https://example.com/x.git", subdir: "../../etc" });
      const calls: string[] = [];
      const exec: ExecFn = async (_cmd, args) => {
        calls.push(args.join(" "));
        return { exit: 0, output: "" };
      };
      await expect(updatePlugin({ dir, name: "badurl", exec })).rejects.toThrow();
      await expect(updatePlugin({ dir, name: "badref", exec })).rejects.toThrow("unsafe ref");
      await expect(updatePlugin({ dir, name: "badsub", exec })).rejects.toThrow("unsafe subdir");
      // git was never invoked with the hostile values
      expect(calls).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("update failure surfaces git output", async () => {
    const dir = mkDir();
    try {
      mkdirSync(path.join(dir, "p", ".git"), { recursive: true });
      const exec: ExecFn = async () => ({ exit: 1, output: "CONFLICT" });
      await expect(updatePlugin({ dir, name: "p", exec })).rejects.toThrow("CONFLICT");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("remove deletes the folder; missing dirs and unsafe names rejected", () => {
    const dir = mkDir();
    try {
      mkdirSync(path.join(dir, "p"), { recursive: true });
      writeFileSync(path.join(dir, "p", "p.ts"), "export default {};\n");
      removePluginDir(dir, "p");
      expect(existsSync(path.join(dir, "p"))).toBe(false);
      // silent success would let the caller toast "Removed <name>" for nothing
      expect(() => removePluginDir(dir, "p")).toThrow("not installed");
      expect(() => removePluginDir(dir, "../evil")).toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
