// --- Update side effects: the network read that resolves "latest", the
// delegation to install.sh, and the provenance file the installer writes.
// Everything is injected (fetch / spawn / tmp path / clock-free) so the whole
// thing is testable without a network or a shell. ---

import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { xdgDataHome } from "../fs/uri";
import { errMessage } from "../lib/uiutil";
import {
  tagFromRedirect,
  UPDATE_INSTALLER_URL,
  UPDATE_INSTALL_TIMEOUT_MS,
  UPDATE_LATEST_URL,
  UPDATE_RELEASES_FEED_URL,
  UPDATE_RELEASE_TAG_URL,
  UPDATE_TIMEOUT_MS,
} from "./update";

// --- process identity: a dev run (`bun src/index.ts`) has no install of its
// own, and its "install dir" would be bun's. Refusing beats replacing the
// wrong binary; the check is the same runner-name test the CLI arg parser and
// restart use. ---
const RUNNER_RE = /^(bun|node|deno)(\.exe)?$/;

export const isDevBuild = (execPath: string): boolean => {
  const base = execPath.replace(/\\/g, "/").split("/").pop() ?? "";
  return RUNNER_RE.test(base);
};

export const installDirOf = (execPath: string): string => path.dirname(execPath.replace(/\/+$/, ""));

// --- provenance: $XDG_DATA_HOME/tfm/install.json, written by install.sh on a
// successful install. Without it an update can only guess whether the running
// binary came from a release, a source build or a local file. ---
export type InstallChannel = "release" | "source" | "local";

export type InstallInfo = {
  channel: InstallChannel;
  version: string | null;
  ref: string | null;
  dest: string | null;
  installedAt: string | null;
};

export const installInfoPath = (dataHome = xdgDataHome()): string => path.join(dataHome, "tfm", "install.json");

export const readInstallInfo = (file = installInfoPath()): InstallInfo | null => {
  try {
    const raw: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (typeof raw !== "object" || raw === null) return null;
    const r = raw as Record<string, unknown>;
    const channel = r.channel;
    if (channel !== "release" && channel !== "source" && channel !== "local") return null;
    const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);
    return {
      channel,
      version: str(r.version),
      ref: str(r.ref),
      dest: str(r.dest),
      installedAt: str(r.installedAt),
    };
  } catch {
    return null;
  }
};

// --- network seam. The installer text and the tag both come through here so
// tests never touch the network. ---

export type UpdateFetchResult = {
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
};

export type UpdateFetchInit = { method: string; redirect?: "manual"; signal?: AbortSignal };

export type UpdateFetch = (url: string, init: UpdateFetchInit) => Promise<UpdateFetchResult>;

const defaultFetch: UpdateFetch = (url, init) => fetch(url, init) as unknown as Promise<UpdateFetchResult>;

// "latest" via the /releases/latest 302 (see ./update for why no API). Never
// throws: a null reads as "couldn't ask" for every caller, which is a
// different answer from "you are current" and must stay distinguishable.
export const fetchLatestTag = async (
  deps: { fetch?: UpdateFetch; signal?: AbortSignal } = {},
): Promise<string | null> => {
  const f = deps.fetch ?? defaultFetch;
  try {
    const res = await f(UPDATE_LATEST_URL, {
      method: "HEAD",
      redirect: "manual",
      signal: deps.signal ?? AbortSignal.timeout(UPDATE_TIMEOUT_MS),
    });
    return tagFromRedirect(res.headers.get("location"));
  } catch {
    return null;
  }
};

// Does a release with this tag exist? true = yes, false = no (404),
// null = couldn't ask (offline, rate limited, a status we don't read as an
// answer). The caller must treat null as "unknown", NOT as "no": the
// installer still tries, and it reports a missing release in its own words.
export const releaseExists = async (
  tag: string,
  deps: { fetch?: UpdateFetch; signal?: AbortSignal } = {},
): Promise<boolean | null> => {
  const f = deps.fetch ?? defaultFetch;
  try {
    const res = await f(UPDATE_RELEASE_TAG_URL(tag), {
      method: "HEAD",
      signal: deps.signal ?? AbortSignal.timeout(UPDATE_TIMEOUT_MS),
    });
    if (res.status === 404) return false;
    if (res.ok) return true;
    return null;
  } catch {
    return null;
  }
};

// The published release tags, newest first (the ATOM feed). Null when the
// feed can't be read — the caller then points at the releases page instead.
export const fetchReleaseTags = async (
  deps: { fetch?: UpdateFetch; signal?: AbortSignal } = {},
): Promise<string[] | null> => {
  const f = deps.fetch ?? defaultFetch;
  try {
    const res = await f(UPDATE_RELEASES_FEED_URL, {
      method: "GET",
      signal: deps.signal ?? AbortSignal.timeout(UPDATE_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const body = await res.text();
    const tags: string[] = [];
    const re = /releases\/tag\/([^"<]+)/g;
    let m: RegExpExecArray | null = re.exec(body);
    while (m) {
      const tag = m[1];
      if (tag && !tags.includes(tag)) tags.push(tag);
      m = re.exec(body);
    }
    return tags.length > 0 ? tags : null;
  } catch {
    return null;
  }
};

// --- the installer run -----------------------------------------------------

export type InstallerChild = { exited: Promise<number>; output(): Promise<string> };

export type InstallerSpawn = (
  argv: string[],
  opts: { env: Record<string, string | undefined>; capture: boolean },
) => InstallerChild;

const defaultSpawn: InstallerSpawn = (argv, opts) => {
  // Bun.spawn throws SYNCHRONOUSLY on a missing binary; runInstaller guards the
  // call, so a bash-less host degrades to a failure result instead of a crash
  const proc = Bun.spawn(argv, {
    stdio: opts.capture ? ["ignore", "pipe", "pipe"] : ["inherit", "inherit", "inherit"],
    env: opts.env,
  });
  // drain EAGERLY: reading only after `exited` deadlocks on a full pipe
  const drained = opts.capture
    ? Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]).then(
        ([out, err]) => `${out}${err}`,
      )
    : Promise.resolve("");
  return { exited: proc.exited, output: () => drained };
};

export type InstallerResult = { ok: boolean; code: number | null; detail: string };

// the installer's own headline, for the one-line failure toast. Plain (non-tty)
// install.sh prints "tfm: FAILED <step>, <what>" then "tfm: <headline>";
// keeping ONE line means the toast never grows past its 3-line cap.
export const firstTfmLine = (output: string): string => {
  // biome's noControlCharactersInRegex rejects a literal ESC, so the byte is
  // spliced in at runtime (the same trick install-ui.test.ts uses)
  const ansi = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");
  const lines = output
    .split("\n")
    .map((l) => l.replace(ansi, "").trim())
    .filter(Boolean);
  const pick = lines.find((l) => l.startsWith("tfm: ")) ?? lines[lines.length - 1] ?? "";
  const text = pick.startsWith("tfm: ") ? pick.slice(5) : pick;
  return text.length > 80 ? `${text.slice(0, 79)}…` : text;
};

export type RunInstallerDeps = {
  // the release tag to pin (TFM_VERSION); omitted = the installer's own latest
  tag?: string;
  // where to install; omitted = the installer's default ($HOME/.local/bin)
  installDir?: string;
  // false = stream the installer's own UI into the terminal (the CLI path);
  // true = capture it for a toast (the in-app path)
  capture?: boolean;
  fetch?: UpdateFetch;
  spawn?: InstallerSpawn;
  tmpFile?: () => string;
  removeTmp?: (file: string) => void;
};

export const runInstaller = async (deps: RunInstallerDeps = {}): Promise<InstallerResult> => {
  const fail = (detail: string): InstallerResult => ({ ok: false, code: null, detail });
  const f = deps.fetch ?? defaultFetch;
  let script: string;
  try {
    const res = await f(UPDATE_INSTALLER_URL, {
      method: "GET",
      signal: AbortSignal.timeout(UPDATE_INSTALL_TIMEOUT_MS),
    });
    if (!res.ok) return fail(`couldn't download the installer (HTTP ${res.status})`);
    script = await res.text();
  } catch (err) {
    return fail(`couldn't download the installer (${errMessage(err)})`);
  }
  // a captive portal or proxy answers 200 with HTML; never hand that to bash
  if (!script.startsWith("#!")) return fail("the downloaded installer wasn't a script");

  const tmp = (deps.tmpFile ?? (() => path.join(os.tmpdir(), `tfm-update-${process.pid}.sh`)))();
  try {
    writeFileSync(tmp, script, { mode: 0o700 });
  } catch (err) {
    return fail(`couldn't stage the installer (${errMessage(err)})`);
  }

  const env: Record<string, string | undefined> = { ...process.env, TFM_UPDATE_HINT: "1" };
  if (deps.tag) env.TFM_VERSION = deps.tag;
  if (deps.installDir) env.TFM_INSTALL_DIR = deps.installDir;

  try {
    const child = (deps.spawn ?? defaultSpawn)(["bash", tmp], { env, capture: deps.capture === true });
    const code = await child.exited;
    const output = await child.output();
    if (code === 0) return { ok: true, code, detail: "" };
    return { ok: false, code, detail: firstTfmLine(output) || `the installer exited ${code}` };
  } catch (err) {
    return fail(errMessage(err));
  } finally {
    try {
      if (deps.removeTmp) deps.removeTmp(tmp);
      else if (existsSync(tmp)) rmSync(tmp, { force: true });
    } catch {}
  }
};
