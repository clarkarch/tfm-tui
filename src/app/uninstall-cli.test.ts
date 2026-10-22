import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  parseUninstallArgs,
  rcFiles,
  runUninstallCli,
  stripPathBlock,
  uninstallHelp,
  type UninstallCliDeps,
} from "./uninstall-cli";

// --- The uninstaller is a destructive, path-heavy command, so the tests drive
// it against a REAL sandboxed tree and assert on the filesystem, never on a
// fake's bookkeeping. Every location is passed EXPLICITLY through
// deps.home/deps.xdg (and mirrored into the environment): Bun caches
// os.homedir() at process start, so setting $HOME per-test does nothing — an
// env-only sandbox silently fell through to the machine's real ~/.config,
// ~/.local/state and ~/.cache (which the --purge case then deleted). Inject
// the paths; never rely on $HOME. ---

const ENV_KEYS = [
  "HOME",
  "XDG_DATA_HOME",
  "XDG_CONFIG_HOME",
  "XDG_STATE_HOME",
  "XDG_CACHE_HOME",
  "ZDOTDIR",
  "TFM_CONFIG",
  "TFM_INSTALL_DIR",
] as const;

let savedEnv: Record<string, string | undefined> = {};
let root = "";
let home = "";
let binDir = "";
let binaries: string[] = [];
let dataHome = "";
let configHome = "";
let stateHome = "";
let cacheHome = "";
let dataDir = "";
let configDir = "";
let stateDir = "";
let cacheDir = "";
let applications = "";
let icons: string[] = [];
let serviceFile = "";
let bashrc = "";

const seedProgram = (): void => {
  mkdirSync(home, { recursive: true });
  mkdirSync(binDir, { recursive: true });
  writeFileSync(path.join(binDir, "tfm"), "binary");
  symlinkSync(path.join(binDir, "tfm"), path.join(binDir, "terminal-file-manager"));
  writeFileSync(path.join(binDir, "tfm.bak"), "old binary");

  mkdirSync(dataDir, { recursive: true });
  writeFileSync(path.join(dataDir, "install.json"), '{"channel":"release","version":"1.1.0","dest":""}');

  mkdirSync(applications, { recursive: true });
  writeFileSync(path.join(applications, "tfm.desktop"), "[Desktop Entry]\nExec=tfm\n");
  for (const icon of icons) {
    mkdirSync(path.dirname(icon), { recursive: true });
    writeFileSync(icon, "<svg/>");
  }

  mkdirSync(path.dirname(serviceFile), { recursive: true });
  writeFileSync(serviceFile, "[D-BUS Service]\nExec=/x/tfm --filemanager-service\n");

  mkdirSync(configDir, { recursive: true });
  writeFileSync(path.join(configDir, "config.toml"), "[ui]\n");
  mkdirSync(path.join(configDir, "plugins", "hello"), { recursive: true });
  writeFileSync(path.join(configDir, "plugins", "hello", "hello.ts"), "export default {}\n");

  mkdirSync(stateDir, { recursive: true });
  writeFileSync(path.join(stateDir, "session.json"), "{}");
  writeFileSync(path.join(stateDir, "undo-journal.json"), "[]");

  mkdirSync(cacheDir, { recursive: true });
  writeFileSync(path.join(cacheDir, "cache"), "x");

  writeFileSync(bashrc, '\nexport EDITOR=vim\n\n# tfm PATH\nexport PATH="$HOME/.local/bin:$PATH"\n');
};

const harness = (over: Partial<UninstallCliDeps> = {}) => {
  const out: string[] = [];
  const err: string[] = [];
  const restored: string[] = [];
  const deps: UninstallCliDeps = {
    out: (l) => out.push(l),
    err: (l) => err.push(l),
    execPath: path.join(binDir, "tfm"),
    provenance: () => ({ channel: "release", version: "1.1.0", ref: null, dest: binDir, installedAt: null }),
    isTTY: () => false,
    currentDefault: () => "",
    restoreDefault: async (op) => {
      restored.push(op);
      return { ok: true, message: "nautilus is the default file manager again" };
    },
    refreshDesktop: () => {},
    // explicit seams so no real $HOME/$XDG dir can ever be touched
    home,
    xdg: { data: dataHome, config: configHome, state: stateHome, cache: cacheHome },
    ...over,
  };
  return { deps, out, err, restored };
};

beforeEach(() => {
  savedEnv = {};
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  for (const k of ENV_KEYS) delete process.env[k];

  root = mkdtempSync(path.join(os.tmpdir(), "tfm-uninstall-"));
  home = path.join(root, "home");
  binDir = path.join(root, "bin");
  dataHome = path.join(root, "data");
  configHome = path.join(root, "config");
  stateHome = path.join(root, "state");
  cacheHome = path.join(root, "cache");
  // mirror the sandbox into the env too: the deps seams are the real safety,
  // but a stray env fallback must still land inside the temp tree
  process.env.XDG_DATA_HOME = dataHome;
  process.env.XDG_CONFIG_HOME = configHome;
  process.env.XDG_STATE_HOME = stateHome;
  process.env.XDG_CACHE_HOME = cacheHome;

  binaries = [path.join(binDir, "tfm"), path.join(binDir, "terminal-file-manager"), path.join(binDir, "tfm.bak")];
  dataDir = path.join(dataHome, "tfm");
  configDir = path.join(configHome, "tfm");
  stateDir = path.join(stateHome, "tfm");
  cacheDir = path.join(cacheHome, "tfm");
  applications = path.join(dataHome, "applications");
  icons = [
    path.join(dataHome, "icons", "hicolor", "scalable", "apps", "tfm.svg"),
    path.join(dataHome, "icons", "tfm.svg"),
  ];
  serviceFile = path.join(dataHome, "dbus-1", "services", "org.freedesktop.FileManager1.service");
  bashrc = path.join(home, ".bashrc");
  seedProgram();
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  if (root) rmSync(root, { recursive: true, force: true });
});

describe("arg parsing (pure)", () => {
  test("bare `tfm uninstall` keeps the user data", () => {
    expect(parseUninstallArgs([])).toEqual({ cmd: "uninstall", purge: false, error: null });
  });

  test("--purge (and -p) opt into deleting the user data", () => {
    expect(parseUninstallArgs(["--purge"]).purge).toBe(true);
    expect(parseUninstallArgs(["-p"]).purge).toBe(true);
  });

  test("help wins, unknown flags are usage errors", () => {
    expect(parseUninstallArgs(["help"]).cmd).toBe("help");
    expect(parseUninstallArgs(["--help"]).cmd).toBe("help");
    expect(parseUninstallArgs(["--nope"]).error).toMatch(/unknown/);
  });
});

describe("stripPathBlock (pure)", () => {
  test("drops the marker and the one line it introduces, nothing else", () => {
    const src = 'export EDITOR=vim\n\n# tfm PATH\nexport PATH="$HOME/.local/bin:$PATH"\nexport FOO=bar\n';
    const { content, removed } = stripPathBlock(src);
    expect(removed).toBe(true);
    expect(content).toContain("export EDITOR=vim");
    expect(content).toContain("export FOO=bar");
    expect(content).not.toContain("# tfm PATH");
    expect(content).not.toContain(".local/bin");
  });

  test("a file without the marker is untouched", () => {
    const src = "export EDITOR=vim\n";
    expect(stripPathBlock(src)).toEqual({ content: src, removed: false });
  });

  test("a trailing marker with no follower is still removed", () => {
    expect(stripPathBlock("a\n# tfm PATH").content).toBe("a");
  });
});

describe("runUninstallCli", () => {
  test("default: removes the program but keeps settings, plugins and caches", async () => {
    const h = harness();
    expect(await runUninstallCli([], h.deps)).toBe(0);
    expect(h.out.join("\n")).toContain("tfm uninstalled");

    for (const bin of binaries) expect(existsSync(bin)).toBe(false);
    expect(existsSync(path.join(applications, "tfm.desktop"))).toBe(false);
    for (const icon of icons) expect(existsSync(icon)).toBe(false);
    expect(existsSync(serviceFile)).toBe(false);
    // the install record is gone and the now-empty data dir is pruned
    expect(existsSync(path.join(dataDir, "install.json"))).toBe(false);
    expect(existsSync(dataDir)).toBe(false);
    // the PATH block is gone, the rest of the rc file survives
    const rc = readFileSync(bashrc, "utf8");
    expect(rc).not.toContain("# tfm PATH");
    expect(rc).toContain("export EDITOR=vim");

    // user data stays
    expect(existsSync(path.join(configDir, "config.toml"))).toBe(true);
    expect(existsSync(path.join(configDir, "plugins", "hello", "hello.ts"))).toBe(true);
    expect(existsSync(path.join(stateDir, "session.json"))).toBe(true);
    expect(existsSync(path.join(cacheDir, "cache"))).toBe(true);
  });

  test("--purge: removes the settings, plugins, state, caches and checkout too", async () => {
    mkdirSync(path.join(dataDir, "src", "tfm-tui"), { recursive: true });
    const h = harness();
    expect(await runUninstallCli(["--purge"], h.deps)).toBe(0);
    expect(existsSync(configDir)).toBe(false);
    expect(existsSync(stateDir)).toBe(false);
    expect(existsSync(cacheDir)).toBe(false);
    expect(existsSync(dataDir)).toBe(false);
  });

  test("restores the default file manager only when tfm actually holds it", async () => {
    const untouched = harness({ currentDefault: () => "nautilus.desktop" });
    expect(await runUninstallCli([], untouched.deps)).toBe(0);
    expect(untouched.restored).toEqual([]);

    const restoring = harness({ currentDefault: () => "tfm.desktop" });
    expect(await runUninstallCli([], restoring.deps)).toBe(0);
    expect(restoring.restored).toEqual(["unset"]);
    expect(restoring.out.join("\n")).toContain("default file manager again");
  });

  test("a failed default-file-manager restore is reported, the binary still goes", async () => {
    const h = harness({
      currentDefault: () => "tfm.desktop",
      restoreDefault: async () => ({ ok: false, message: "No previous file manager recorded · unchanged" }),
    });
    expect(await runUninstallCli([], h.deps)).toBe(1);
    expect(h.err.join("\n")).toContain("No previous file manager recorded");
    expect(existsSync(path.join(binDir, "tfm"))).toBe(false);
  });

  test("a foreign terminal-file-manager is left alone", async () => {
    // a symlink that points somewhere else is not ours to remove
    const link = path.join(binDir, "terminal-file-manager");
    rmSync(link, { force: true });
    const elsewhere = path.join(root, "elsewhere");
    writeFileSync(elsewhere, "x");
    symlinkSync(elsewhere, link);
    const h = harness();
    expect(await runUninstallCli([], h.deps)).toBe(0);
    expect(existsSync(link)).toBe(true);
    expect(h.out.join("\n")).toContain("left");
    // the real binary is still removed
    expect(existsSync(path.join(binDir, "tfm"))).toBe(false);
  });

  test("interactive: a No changes nothing", async () => {
    const asked: string[] = [];
    const h = harness({
      isTTY: () => true,
      ask: async (q) => {
        asked.push(q);
        return false;
      },
    });
    expect(await runUninstallCli([], h.deps)).toBe(0);
    expect(asked[0]).toMatch(/Uninstall tfm/);
    expect(h.out.join("\n")).toContain("cancelled");
    expect(existsSync(path.join(binDir, "tfm"))).toBe(true);
  });

  test("interactive: a Yes removes", async () => {
    const h = harness({ isTTY: () => true, ask: async () => true });
    expect(await runUninstallCli([], h.deps)).toBe(0);
    expect(existsSync(path.join(binDir, "tfm"))).toBe(false);
  });

  test("a dev build refuses instead of deleting the interpreter", async () => {
    const h = harness({ execPath: "/usr/local/bin/bun" });
    expect(await runUninstallCli([], h.deps)).toBe(1);
    expect(h.err.join("\n")).toMatch(/dev build/);
    expect(existsSync(path.join(binDir, "tfm"))).toBe(true);
  });

  test("a source install keeps the checkout unless --purge", async () => {
    mkdirSync(path.join(dataDir, "src"), { recursive: true });
    const kept = harness({
      provenance: () => ({ channel: "source", version: null, ref: "dev", dest: null, installedAt: null }),
    });
    expect(await runUninstallCli([], kept.deps)).toBe(0);
    expect(existsSync(path.join(dataDir, "src"))).toBe(true);
    expect(existsSync(path.join(dataDir, "install.json"))).toBe(false);
    expect(kept.out.join("\n")).toContain("--purge");
  });

  test("help prints usage and exits 0", async () => {
    const h = harness();
    expect(await runUninstallCli(["help"], h.deps)).toBe(0);
    expect(h.out.join("\n")).toBe(uninstallHelp().trimEnd());
  });

  test("a usage error exits 2 with a pointer to help", async () => {
    const h = harness();
    expect(await runUninstallCli(["--nope"], h.deps)).toBe(2);
    expect(h.err.join("\n")).toMatch(/tfm uninstall help/);
  });
});

describe("rcFiles", () => {
  test("scans the shapes install.sh writes, deduped", () => {
    const files = rcFiles(home, configHome);
    expect(files).toContain(path.join(home, ".bashrc"));
    expect(files).toContain(path.join(configHome, "fish", "config.fish"));
    expect(new Set(files).size).toBe(files.length);
  });
});
