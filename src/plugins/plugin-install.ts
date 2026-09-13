// --- Plugin installer: paste-a-git-URL -> validated -> cloned -> normalized
// into plugins/<name>/<name>.ts (folder layout the loader discovers).
// Pure + injectable: the git spawn arrives as an ExecFn so tests fake it
// (no network/binary needed). Takes the plugins dir as a param — never
// imports ./plugins (sibling) or ui/ (layering: the settings model must not
// pull node:fs through here; wiring passes callbacks instead).
// Security: argv is array-passed (no shell), dash-prefixed URLs rejected,
// file:// and bare paths rejected, names gated by PLUGIN_NAME_RE (shared
// leaf with the loader), .tmp staging dirs are dot-prefixed so the rescan
// skips them. ---

import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { PLUGIN_NAME_RE } from "./plugin-api";

type ParsedGitUrl = { url: string; ref?: string; subdir?: string };

const REF_RE = /^[A-Za-z0-9._\-/]+$/;
const SUBDIR_RE = /^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/;
const SCP_RE = /^[\w.-]+@[\w.-]+:.+/;

// paste format: URL[#ref] [subdir] — the ref pins a branch/tag, the subdir
// picks one plugin out of a monorepo (both optional)
export const parseGitUrl = (raw: string): ParsedGitUrl => {
  const trimmed = raw.trim();
  if (!trimmed) throw new Error("enter a git URL (e.g. https://github.com/owner/repo)");
  for (const ch of trimmed) {
    const code = ch.charCodeAt(0);
    if (code < 0x20 || code === 0x7f) throw new Error("invalid git URL (control characters)");
  }
  const parts = trimmed.split(/\s+/);
  if (parts.length > 2) throw new Error("expected: URL[#ref] [subdir]");
  const [first, subdir] = parts as [string, string | undefined];
  // argv is array-passed straight to `git` (never shelled), so metacharacters
  // are inert by construction — the denylist below is belt-and-braces against
  // pastes that were never URLs at all. Dash checks: a URL that STARTS with
  // `-` parses as a git flag, and a HOST that starts with `-` (ssh://-oProxy
  // …) is handed to ssh as an option (git passes the host as an argv element
  // with no `--`). Tab is deliberately NOT a separator: it fails the
  // control-char check above (paste format is space-separated only).
  if (!first || first.startsWith("-")) throw new Error(`invalid git URL: ${JSON.stringify(first ?? "")}`);
  if (first.includes(";") || first.includes("|") || first.includes("`") || first.includes("$(")) {
    throw new Error(`invalid git URL: ${JSON.stringify(first)}`);
  }
  let url = first;
  let ref: string | undefined;
  const hash = first.indexOf("#");
  if (hash >= 0) {
    url = first.slice(0, hash);
    ref = first.slice(hash + 1);
    if (!ref || !REF_RE.test(ref)) throw new Error(`invalid #ref: ${JSON.stringify(ref)}`);
  }
  const ok =
    url.startsWith("https://") ||
    url.startsWith("http://") ||
    url.startsWith("ssh://") ||
    url.startsWith("git://") ||
    SCP_RE.test(url);
  if (!ok) throw new Error(`unsupported git URL (use https://, ssh://, git:// or git@host:…): ${JSON.stringify(url)}`);
  // host leading with `-` = ssh option injection (git forwards the host to
  // ssh as an argv element without `--`)
  const host = ((): string | null => {
    const uri = url.match(/^(?:https?|ssh|git):\/\/([^/?#@]+)/);
    if (uri) return uri[1] ?? null;
    const scp = url.match(/^[\w.-]+@([^/]+):/);
    return scp ? (scp[1] ?? null) : null;
  })();
  if (host !== null && host.startsWith("-")) {
    throw new Error(`invalid git URL (host starts with '-'): ${JSON.stringify(url)}`);
  }
  if (subdir !== undefined) {
    const segs = subdir.split("/");
    if (!SUBDIR_RE.test(subdir) || segs.some((s) => s === "" || s === "." || s === "..")) {
      throw new Error(`invalid subdir: ${JSON.stringify(subdir)}`);
    }
  }
  return subdir !== undefined
    ? ref !== undefined
      ? { url, ref, subdir }
      : { url, subdir }
    : ref !== undefined
      ? { url, ref }
      : { url };
};

const baseOf = (s: string): string => {
  const noTrail = s.replace(/\/+$/, "");
  const last = noTrail.slice(Math.max(noTrail.lastIndexOf("/"), noTrail.lastIndexOf(":")) + 1);
  return last.replace(/\.git$/, "") || noTrail;
};

// folder name under plugins/ — from the subdir when given, else the repo.
// The SINGLE-main normalize step below may still rename it to the found
// plugin's own name (repo names often differ from plugin names).
export const derivePluginName = (parsed: ParsedGitUrl): string => {
  const base = parsed.subdir ? baseOf(parsed.subdir) : baseOf(parsed.url);
  if (!PLUGIN_NAME_RE.test(base)) throw new Error(`could not derive plugin name from ${JSON.stringify(base)}`);
  return base;
};

// relative mains under a (cloned) root: folder mains (<sub>/<sub>.ts) plus
// flat files (*.ts). Mirrors discoverPlugins without migrating anything.
export const findPluginMains = (root: string): string[] => {
  let names: string[];
  try {
    names = readdirSync(root).sort();
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const n of names) {
    if (n.startsWith(".")) continue;
    const full = path.join(root, n);
    let st: ReturnType<typeof lstatSync> | undefined;
    try {
      st = lstatSync(full);
    } catch {
      continue;
    }
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory()) {
      const main = path.join(full, `${n}.ts`);
      try {
        if (statSync(main).isFile()) out.push(`${n}/${n}.ts`);
      } catch {}
    } else if (st.isFile() && n.endsWith(".ts")) {
      out.push(n);
    }
  }
  return out;
};

type ExecResult = { exit: number; output: string };
export type ExecFn = (cmd: string, args: string[], opts?: { cwd?: string }) => Promise<ExecResult>;

// production spawn: array argv (no shell), piped output, 120s kill cap.
// Never throws — failures arrive as non-zero exit (callers surface output).
const defaultExec: ExecFn = async (cmd, args, opts) => {
  try {
    const proc = Bun.spawn([cmd, ...args], {
      cwd: opts?.cwd,
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
    });
    const timer = setTimeout(() => {
      try {
        proc.kill();
      } catch {}
    }, 120_000);
    try {
      const [out, err, exit] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      const output = `${out}\n${err}`.trim();
      return { exit, output };
    } finally {
      clearTimeout(timer);
    }
  } catch (err) {
    return { exit: 127, output: err instanceof Error ? err.message : String(err) };
  }
};

export class AmbiguousPluginError extends Error {
  candidates: string[];
  constructor(candidates: string[]) {
    super(`repo holds ${candidates.length} plugins — pick one: ${candidates.join(", ")}`);
    this.name = "AmbiguousPluginError";
    this.candidates = candidates;
  }
}

const rmrf = (p: string): void => {
  try {
    rmSync(p, { recursive: true, force: true });
  } catch {}
};

// install provenance: where this folder came from, so Update works even
// when the install carries no .git of its own (folder-main and subdir
// installs copy just the plugin subfolder — the clone's .git never leaves
// tmp). Manual installs have no provenance file and keep the old refusal.
const SOURCE_FILE = ".tfm-source.json";
type SourceRecord = { url: string; ref?: string; subdir?: string };

const readSource = (dest: string): SourceRecord | null => {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path.join(dest, SOURCE_FILE), "utf8"));
    if (typeof parsed !== "object" || parsed === null) return null;
    const r = parsed as Record<string, unknown>;
    if (typeof r.url !== "string" || !r.url) return null;
    return {
      url: r.url,
      ...(typeof r.ref === "string" && r.ref ? { ref: r.ref } : {}),
      ...(typeof r.subdir === "string" && r.subdir ? { subdir: r.subdir } : {}),
    };
  } catch {
    return null;
  }
};

export const installPlugin = async (opts: {
  dir: string;
  raw: string;
  exec?: ExecFn;
}): Promise<{ name: string; dest: string }> => {
  const { dir, raw, exec = defaultExec } = opts;
  const parsed = parseGitUrl(raw);
  // fail fast on underivable names before paying for a clone
  derivePluginName(parsed);
  const tmp = path.join(dir, `.tmp-install-${process.pid}-${crypto.randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  rmrf(tmp);
  try {
    const args = ["clone", "--depth", "1"];
    if (parsed.ref) args.push("--branch", parsed.ref);
    args.push(parsed.url, tmp);
    const res = await exec("git", args);
    if (res.exit !== 0) throw new Error(`clone failed: ${res.output.slice(0, 200) || `exit ${res.exit}`}`);
    const source = parsed.subdir ? path.join(tmp, parsed.subdir) : tmp;
    try {
      if (!statSync(source).isDirectory()) throw new Error();
    } catch {
      throw new Error(`subdir not found in repo: ${JSON.stringify(parsed.subdir)}`);
    }
    const mains = findPluginMains(source);
    if (!mains.length) throw new Error("no plugin found (need <name>/<name>.ts or <name>.ts)");
    if (mains.length > 1) throw new AmbiguousPluginError(mains);
    const main = mains[0]!;
    // folder main: install just that folder; flat file: install the whole
    // source root (helpers ride along) under the file's own name
    const srcFolder = main.includes("/") ? path.join(source, path.dirname(main)) : source;
    const finalName = main.includes("/") ? path.basename(path.dirname(main)) : path.basename(main, ".ts");
    if (!PLUGIN_NAME_RE.test(finalName)) throw new Error(`unsafe plugin name: ${JSON.stringify(finalName)}`);
    const dest = path.join(dir, finalName);
    if (existsSync(dest)) throw new Error(`"${finalName}" already installed (remove it first)`);
    cpSync(srcFolder, dest, { recursive: true });
    writeFileSync(
      path.join(dest, SOURCE_FILE),
      JSON.stringify(
        {
          url: parsed.url,
          ...(parsed.ref ? { ref: parsed.ref } : {}),
          ...(parsed.subdir ? { subdir: parsed.subdir } : {}),
        },
        null,
        2,
      ),
    );
    return { name: finalName, dest };
  } finally {
    rmrf(tmp);
  }
};

export const updatePlugin = async (opts: { dir: string; name: string; exec?: ExecFn }): Promise<string> => {
  const { dir, name, exec = defaultExec } = opts;
  if (!PLUGIN_NAME_RE.test(name)) throw new Error(`unsafe plugin name: ${JSON.stringify(name)}`);
  const dest = path.join(dir, name);
  try {
    if (!statSync(dest).isDirectory()) throw new Error();
  } catch {
    throw new Error(`"${name}" is not installed`);
  }
  let isGit = false;
  try {
    isGit = statSync(path.join(dest, ".git")).isDirectory();
  } catch {}
  if (isGit) {
    const res = await exec("git", ["-C", dest, "pull", "--ff-only"]);
    if (res.exit !== 0) throw new Error(`update failed: ${res.output.slice(0, 200) || `exit ${res.exit}`}`);
    return res.output.slice(0, 200) || "updated";
  }
  // refresh path: folder/subdir installs carry provenance but no .git, so
  // re-clone and copy the same plugin over the live folder. state.json
  // (enabled flag, keybinds) and the provenance record survive the refresh.
  const src = readSource(dest);
  if (!src) throw new Error(`"${name}" is not a git checkout (installed manually?)`);
  const tmp = path.join(dir, `.tmp-update-${process.pid}-${crypto.randomUUID()}`);
  rmrf(tmp);
  try {
    const args = ["clone", "--depth", "1"];
    if (src.ref) args.push("--branch", src.ref);
    args.push(src.url, tmp);
    const res = await exec("git", args);
    if (res.exit !== 0) throw new Error(`update failed: ${res.output.slice(0, 200) || `exit ${res.exit}`}`);
    const source = src.subdir ? path.join(tmp, src.subdir) : tmp;
    try {
      if (!statSync(source).isDirectory()) throw new Error();
    } catch {
      throw new Error(`subdir not found in update: ${JSON.stringify(src.subdir)}`);
    }
    const mains = findPluginMains(source);
    const main = mains.find((m) => m === `${name}/${name}.ts` || m === `${name}.ts`);
    if (!main) throw new Error(`upstream no longer contains "${name}" (reinstall from URL?)`);
    const srcFolder = main.includes("/") ? path.join(source, path.dirname(main)) : source;
    cpSync(srcFolder, dest, {
      recursive: true,
      filter: (s) => {
        const b = path.basename(s);
        return b !== "state.json" && b !== SOURCE_FILE;
      },
    });
    return "updated";
  } finally {
    rmrf(tmp);
  }
};

export const removePluginDir = (dir: string, name: string): string => {
  if (!PLUGIN_NAME_RE.test(name)) throw new Error(`unsafe plugin name: ${JSON.stringify(name)}`);
  // existence-checked: silent success on a missing dir would let the caller
  // toast "Removed <name>" for nothing (mirrors updatePlugin's guard)
  try {
    if (!statSync(path.join(dir, name)).isDirectory()) throw new Error();
  } catch {
    throw new Error(`"${name}" is not installed`);
  }
  rmrf(path.join(dir, name));
  return name;
};
