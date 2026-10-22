// --- `tfm uninstall`: remove the installed program — the binary and its
// second command name, the desktop entry and icons, the FileManager1
// activator, the PATH line the installer added, and the install record.
// `--purge` additionally deletes the user data (config + plugins, state,
// caches, and a source checkout).
//
// Headless: answers before the lazy TUI graph loads, like `tfm update`, and
// deliberately LOCAL — unlike install/update there is nothing to download, so
// removal must work offline. The artifact paths below mirror install.sh (the
// one installer) and the shared leaves it already has: the desktop id is
// TFM_DESKTOP_ID (src/fs/default-filemanager), the activator path is
// fileManagerServiceFile (src/app/filemanager-service), the install record is
// installInfoPath (src/app/update-run), and the data/state/config/cache roots
// are the same $XDG_*/tfm dirs the app already uses. Keep these in sync with
// install.sh: applications/tfm.desktop, icons/hicolor/scalable/apps/tfm.svg,
// icons/tfm.svg, and the `# tfm PATH` rc block. ---

import {
  lstatSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmdirSync,
  rmSync,
  statSync,
  writeFileSync,
  type Stats,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { errMessage } from "../lib/uiutil";
import { probeDefaultFileManagerSync, setDefaultFileManager, TFM_DESKTOP_ID } from "../fs/default-filemanager";
import { xdgCacheHome, xdgConfigHome, xdgDataHome, xdgStateHome } from "../fs/uri";
import { fileManagerServiceFile } from "./filemanager-service";
import { readTtyLine } from "./update-cli";
import { installDirOf, installInfoPath, isDevBuild } from "./update-run";

export type UninstallCommand = "uninstall" | "help";

export type UninstallArgs = { cmd: UninstallCommand; error: string | null };

// PURE: `tfm uninstall`
export const parseUninstallArgs = (args: string[]): UninstallArgs => {
  const first = args[0];
  if (first === undefined) return { cmd: "uninstall", error: null };
  if (first === "help" || first === "--help" || first === "-h") return { cmd: "help", error: null };
  return { cmd: "uninstall", error: `unknown option '${first}'` };
};

export const uninstallHelp = (): string =>
  `tfm uninstall: remove the installed tfm

Usage: tfm uninstall

It shows what it will remove and asks twice: keep or delete your settings and
plugins, then confirm the uninstall. Runs without prompts outside a terminal
and keeps your data then. A custom TFM_CONFIG file is left alone. Source
builds update with source.sh; this only removes.

  exit codes: 0 removed · 1 a part could not be removed · 2 usage
`;

export type UninstallCliDeps = {
  out?: (line: string) => void;
  err?: (line: string) => void;
  // the running binary owns the install location — a custom TFM_INSTALL_DIR
  // needs no config, exactly as `tfm update` derives it
  execPath?: string;
  isTTY?: () => boolean;
  ask?: (question: string) => Promise<boolean>;
  // default-file-manager seams (prod probes xdg-mime; tests never spawn)
  currentDefault?: () => string;
  restoreDefault?: (op: "set" | "unset") => Promise<{ ok: boolean; message: string }>;
  // best-effort desktop-database refresh after the entry is removed
  refreshDesktop?: (applicationsDir: string) => void;
  // Prod derives these from the environment. Tests pass them so no real
  // $HOME/$XDG dir can ever be touched — inject EVERY env read, never fall
  // through to the machine's own files.
  home?: string;
  xdg?: { data?: string; config?: string; state?: string; cache?: string };
};

// Every path the uninstaller touches, resolved once. The `xdg`/`home` deps
// override the environment, which is what keeps tests off the real machine.
type UninstallPaths = {
  home: string;
  binDir: string;
  dataDir: string;
  configDir: string;
  stateDir: string;
  cacheDir: string;
  applications: string;
  icons: string[];
  serviceFile: string;
  rcFiles: string[];
};

const resolvePaths = (deps: UninstallCliDeps, binDir: string): UninstallPaths => {
  const home = deps.home ?? os.homedir();
  const data = deps.xdg?.data ?? xdgDataHome();
  const config = deps.xdg?.config ?? xdgConfigHome();
  const state = deps.xdg?.state ?? xdgStateHome();
  const cache = deps.xdg?.cache ?? xdgCacheHome();
  return {
    home,
    binDir,
    dataDir: path.dirname(installInfoPath(data)),
    configDir: path.join(config, "tfm"),
    stateDir: path.join(state, "tfm"),
    cacheDir: path.join(cache, "tfm"),
    applications: path.join(data, "applications"),
    icons: [path.join(data, "icons", "hicolor", "scalable", "apps", "tfm.svg"), path.join(data, "icons", "tfm.svg")],
    serviceFile: fileManagerServiceFile(data),
    rcFiles: rcFiles(home, config),
  };
};

const defaultNoAsk = async (question: string): Promise<boolean> => {
  process.stdout.write(`${question} [y/N] `);
  const line = (await readTtyLine()).trim().toLowerCase();
  return line === "y" || line === "yes";
};

const existsLstat = (p: string): boolean => {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
};

export const prettyHome = (p: string, home = os.homedir()): string => {
  if (p === home) return "~";
  if (p.startsWith(`${home}/`)) return `~${p.slice(home.length)}`;
  return p;
};

// Remove the installer's PATH block: the `# tfm PATH` marker line and the one
// line after it (install.sh writes exactly that pair). Nothing else is touched.
export const stripPathBlock = (content: string): { content: string; removed: boolean } => {
  const lines = content.split("\n");
  const out: string[] = [];
  let removed = false;
  for (let i = 0; i < lines.length; i++) {
    if (!removed && (lines[i] ?? "").trim() === "# tfm PATH") {
      if (lines[i + 1] !== undefined) i++; // skip the export/fish_add_path line
      removed = true;
      continue;
    }
    out.push(lines[i] as string);
  }
  return { content: out.join("\n"), removed };
};

// Every rc file the installer may have written the block into (it picks ONE
// from the login shell; scanning the candidates for the marker is robust and
// touches nothing without it). Deduped — $ZDOTDIR and the config dir can
// coincide with $HOME.
export const rcFiles = (home = os.homedir(), configHome = xdgConfigHome()): string[] => {
  const zshDir = process.env.ZDOTDIR || home;
  const candidates = [
    path.join(home, ".bashrc"),
    path.join(home, ".bash_profile"),
    path.join(home, ".profile"),
    path.join(zshDir, ".zshrc"),
    path.join(configHome, "fish", "config.fish"),
    path.join(home, ".config", "fish", "config.fish"),
  ];
  return [...new Set(candidates)];
};

// tfm.bak / tfm-ffmpeg are only swept when they are regular files — a symlink
// by that name is the user's own (the same `! -L` rule install.sh uses).
const isOwnedLeftover = (p: string): boolean => {
  try {
    return lstatSync(p).isFile();
  } catch {
    return false;
  }
};

// the FileManager1 service file is only ours when its Exec carries the daemon
// flag; a hand-written activator for another manager is left alone.
const isTfmServiceFile = (p: string): boolean => {
  try {
    if (!lstatSync(p).isFile()) return false;
    return readFileSync(p, "utf8").includes("--filemanager-service");
  } catch {
    return false;
  }
};

// best-effort: the entry is gone, so a stale mimeinfo.cache row is worth
// clearing; a missing tool just leaves the desktop to refresh it later.
const refreshDesktopDatabase = (applications: string): void => {
  try {
    Bun.spawnSync(["update-desktop-database", applications], {
      stdout: "ignore",
      stderr: "ignore",
      stdin: "ignore",
    });
  } catch {}
};

const pruneIfEmpty = (dir: string): void => {
  try {
    if (readdirSync(dir).length === 0) rmdirSync(dir);
  } catch {}
};

// The second command name is ours ONLY when it is a symlink to <bin>/tfm or a
// same-size copy of it (the no-symlink-fs fallback). A same-named directory or
// an unrelated file is left alone with a warning.
type SecondNameResult = { status: "absent" | "removed" | "foreign" | "failed"; detail?: string };

const removeSecondName = (binDir: string): SecondNameResult => {
  const link = path.join(binDir, "terminal-file-manager");
  let st: Stats;
  try {
    st = lstatSync(link);
  } catch {
    return { status: "absent" };
  }
  const main = path.join(binDir, "tfm");
  if (st.isDirectory()) return { status: "foreign", detail: "it is a directory" };
  if (st.isSymbolicLink()) {
    let target = "";
    try {
      target = readlinkSync(link);
    } catch {}
    if (path.resolve(binDir, target) !== main) return { status: "foreign", detail: "it points elsewhere" };
  } else if (st.isFile()) {
    let same = false;
    try {
      same = statSync(main).size === st.size;
    } catch {}
    if (!same) return { status: "foreign", detail: "it is not a copy of tfm" };
  } else {
    return { status: "foreign", detail: "it is not a regular file" };
  }
  try {
    rmSync(link, { force: true });
    return { status: "removed" };
  } catch (e) {
    return { status: "failed", detail: errMessage(e) };
  }
};

export const runUninstallCli = async (args: string[], deps: UninstallCliDeps = {}): Promise<number> => {
  const out = deps.out ?? ((s: string) => console.log(s));
  const err = deps.err ?? ((s: string) => console.error(s));
  const parsed = parseUninstallArgs(args);

  if (parsed.error) {
    err(`tfm: ${parsed.error}`);
    err("try 'tfm uninstall help'");
    return 2;
  }
  if (parsed.cmd === "help") {
    out(uninstallHelp().trimEnd());
    return 0;
  }

  const execPath = (deps.execPath ?? process.execPath).replace(/\/+$/, "");
  // a dev run is bun (or a JS script), never an installed tfm: removing its
  // "install dir" would delete the interpreter it is running under
  if (isDevBuild(execPath)) {
    err("tfm: this is a dev build, there is nothing installed to remove");
    return 1;
  }

  const binDir = installDirOf(execPath);
  const dirs = resolvePaths(deps, binDir);
  const pretty = (p: string): string => prettyHome(p, dirs.home);
  const dataDirs = [dirs.configDir, dirs.stateDir, dirs.cacheDir, dirs.dataDir];

  // --- what will happen, before asking ---
  const plan: string[] = [];
  const planPath = (p: string): void => {
    if (existsLstat(p)) plan.push(pretty(p));
  };
  planPath(execPath);
  planPath(path.join(binDir, "terminal-file-manager"));
  planPath(path.join(binDir, "tfm.bak"));
  planPath(path.join(binDir, "tfm-ffmpeg"));
  planPath(path.join(dirs.applications, TFM_DESKTOP_ID));
  for (const icon of dirs.icons) planPath(icon);
  if (isTfmServiceFile(dirs.serviceFile)) planPath(dirs.serviceFile);
  const rcHits = dirs.rcFiles.filter((f) => {
    try {
      return readFileSync(f, "utf8").includes("# tfm PATH");
    } catch {
      return false;
    }
  });
  for (const f of rcHits) plan.push(`PATH line in ${pretty(f)}`);
  planPath(path.join(dirs.dataDir, "install.json"));

  const interactive = (deps.isTTY ?? (() => process.stdin.isTTY === true))();
  const ask = deps.ask ?? defaultNoAsk;
  // green success line on a real terminal; plain when piped or NO_COLOR
  const green = (s: string): string => (interactive && !process.env.NO_COLOR ? `\u001b[32m${s}\u001b[0m` : s);
  let removeData = false;
  let items: string[] = plan;
  if (interactive) {
    const go = await ask("Uninstall tfm?");
    if (!go) {
      out("cancelled, nothing changed");
      return 0;
    }
    removeData = await ask("Delete your settings, plugins and caches too?");
    if (removeData) items = [...plan, ...dataDirs.filter(existsLstat).map(pretty)];
  }

  // --- perform ---
  const failures: string[] = [];
  const warnings: string[] = [];
  const removeTarget = (p: string, recursive = false): boolean => {
    try {
      rmSync(p, { recursive, force: true });
      return true;
    } catch (e) {
      err(`tfm: couldn't remove ${pretty(p)} · ${errMessage(e)}`);
      failures.push(p);
      return false;
    }
  };

  // 1. give folder opens back to whoever had them BEFORE removing the entry.
  // A restore that cannot happen is a WARNING, not a failed uninstall: the
  // binary is going regardless (a stale default is fixable, an unremoved
  // install is not).
  try {
    const current = (deps.currentDefault ?? probeDefaultFileManagerSync)().trim();
    if (current === TFM_DESKTOP_ID) {
      const res = await (deps.restoreDefault ?? setDefaultFileManager)("unset");
      if (res.ok) out(res.message);
      else
        warnings.push(
          "folder opens still point to tfm · choose another with: xdg-mime default <file>.desktop inode/directory",
        );
    }
  } catch (e) {
    warnings.push(`couldn't check the file manager default (${errMessage(e)})`);
  }

  // 2. the second command name first — it is validated against the main binary
  const second = removeSecondName(binDir);
  if (second.status === "foreign") {
    out(`left ${pretty(path.join(binDir, "terminal-file-manager"))} alone · ${second.detail}`);
  } else if (second.status === "failed") {
    err(`tfm: couldn't remove terminal-file-manager · ${second.detail ?? "unknown error"}`);
    failures.push(path.join(binDir, "terminal-file-manager"));
  }
  for (const leftover of ["tfm.bak", "tfm-ffmpeg"]) {
    const p = path.join(binDir, leftover);
    if (isOwnedLeftover(p)) removeTarget(p);
  }

  // 3. desktop registration + icons + the D-Bus activator
  const hadEntry = existsLstat(path.join(dirs.applications, TFM_DESKTOP_ID));
  removeTarget(path.join(dirs.applications, TFM_DESKTOP_ID));
  for (const icon of dirs.icons) removeTarget(icon);
  if (hadEntry) {
    try {
      (deps.refreshDesktop ?? refreshDesktopDatabase)(dirs.applications);
    } catch {}
  }
  if (isTfmServiceFile(dirs.serviceFile)) removeTarget(dirs.serviceFile);

  // 4. the PATH line the installer added
  for (const f of rcHits) {
    try {
      const { content, removed } = stripPathBlock(readFileSync(f, "utf8"));
      if (removed) {
        writeFileSync(f, content);
        out(`removed the PATH line from ${pretty(f)}`);
      }
    } catch (e) {
      err(`tfm: couldn't edit ${pretty(f)} · ${errMessage(e)}`);
      failures.push(f);
    }
  }

  // 5. the install record, or every tfm-owned dir when the data goes too
  if (removeData) {
    if (process.env.TFM_CONFIG) out(`left your custom config alone: ${pretty(process.env.TFM_CONFIG)}`);
    for (const dir of dataDirs) removeTarget(dir, true);
  } else {
    removeTarget(path.join(dirs.dataDir, "install.json"));
    pruneIfEmpty(dirs.dataDir);
  }

  // 6. the binary LAST: any earlier failure still leaves a runnable tfm
  removeTarget(execPath);

  for (const w of warnings) err(`note: ${w}`);
  if (failures.length) {
    err(`tfm: uninstall failed to remove ${failures.length} thing${failures.length === 1 ? "" : "s"}`);
    return 1;
  }
  out(green("removed"));
  for (const item of items) out(`  ${item}`);
  return 0;
};
