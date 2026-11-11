// --- `tfm update`: check the published releases, then delegate the install to
// install.sh (the same script the documented one-liner runs, so replace +
// checksum policy stays in ONE place). Headless: answers before the lazy TUI
// graph loads, like `tfm plugins`. Pure arg dispatch is separated from the
// network/spawn side so every branch is unit-testable. ---

import pkg from "../../package.json";
import { errMessage } from "../lib/uiutil";
import { askOnce } from "../lib/cli-ask";
import { isNewer, parseTag, tagFor, UPDATE_LATEST_URL, UPDATE_RELEASES_URL } from "./update";
import {
  fetchLatestTag,
  fetchReleaseTags,
  installDirOf,
  isDevBuild,
  readInstallInfo,
  releaseExists,
  runInstaller,
  type InstallInfo,
  type InstallerResult,
  type InstallerSpawn,
  type UpdateFetch,
} from "./update-run";

export type UpdateCommand = "update" | "help";

export type UpdateArgs = { cmd: UpdateCommand; tag: string | null; force: boolean; error: string | null };

// PURE: `tfm update [--tag VERSION] [--force]`
export const parseUpdateArgs = (args: string[]): UpdateArgs => {
  const base: UpdateArgs = { cmd: "update", tag: null, force: false, error: null };
  let tag: string | null = null;
  let force = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i] as string;
    if (a === "help" || a === "--help" || a === "-h") return { ...base, cmd: "help" };
    if (a === "--force" || a === "-f") {
      force = true;
      continue;
    }
    let raw: string | null = null;
    if (a === "--tag") raw = args[++i] ?? null;
    else if (a.startsWith("--tag=")) raw = a.slice("--tag=".length);
    if (raw !== null) {
      if (raw === null || raw === "") return { ...base, error: "option '--tag' needs a version" };
      const version = parseTag(raw);
      if (!version) return { ...base, error: `option '--tag' is not a release version: ${JSON.stringify(raw)}` };
      tag = version;
      continue;
    }
    return { ...base, error: `unknown option '${a}'` };
  }
  return { ...base, tag, force };
};

export const updateHelp = (): string =>
  `tfm update: install the newest tfm

Usage: tfm update [--tag VERSION] [--force]

  --tag VERSION   install one specific release instead of the latest
  --force         install again even when you already have that version

It checks first, asks before changing anything, and only ever replaces the
tfm you are running. Source builds update with source.sh instead.

  exit codes: 0 ok or already current · 1 failed · 2 usage
`;

export type UpdateCliDeps = {
  out?: (line: string) => void;
  err?: (line: string) => void;
  current?: string;
  execPath?: string;
  argv?: string[];
  provenance?: () => InstallInfo | null;
  fetch?: UpdateFetch;
  spawn?: InstallerSpawn;
  install?: (deps: Parameters<typeof runInstaller>[0]) => Promise<InstallerResult>;
  tmpFile?: () => string;
  isTTY?: () => boolean;
  ask?: (question: string) => Promise<boolean>;
};

export const runUpdateCli = async (args: string[], deps: UpdateCliDeps = {}): Promise<number> => {
  const out = deps.out ?? ((s: string) => console.log(s));
  const err = deps.err ?? ((s: string) => console.error(s));
  const current = deps.current ?? pkg.version;
  const execPath = deps.execPath ?? process.execPath;
  const parsed = parseUpdateArgs(args);

  if (parsed.error) {
    err(`tfm: ${parsed.error}`);
    err("try 'tfm update help'");
    return 2;
  }
  if (parsed.cmd === "help") {
    out(updateHelp().trimEnd());
    return 0;
  }

  // a dev run has no install of its own and source builds iterate with git:
  // replacing them from a release would silently switch channels
  if (isDevBuild(execPath)) {
    err("tfm: this is a dev build, update it with source.sh");
    return 1;
  }
  const provenance = (deps.provenance ?? readInstallInfo)();
  if (provenance?.channel === "source") {
    err("tfm: this tfm was built from source, update it with source.sh");
    return 1;
  }

  // resolve the target: a pinned --tag skips the "what's the latest" question
  let latest: string | null = parsed.tag;
  if (latest === null) {
    latest = await fetchLatestTag(deps.fetch ? { fetch: deps.fetch } : {});
    if (latest === null) {
      err(`tfm: couldn't reach ${new URL(UPDATE_LATEST_URL).host}, check your connection`);
      return 1;
    }
  }
  // A pinned tag must name a release that EXISTS. Without this check the
  // user confirms a downgrade and then watches the installer fail with a raw
  // curl 404 — and the installer's "check your internet connection" is wrong
  // for a version that was never published. One HEAD answers it; when the
  // answer is unknown (offline) the install still runs and reports itself.
  if (parsed.tag !== null) {
    const tag = tagFor(latest);
    const probe = await releaseExists(tag, deps.fetch ? { fetch: deps.fetch } : {});
    // only an ANSWER can say "there is no such release" — an unknown probe
    // (offline) proceeds, and the installer reports the missing tag itself
    if (probe.ok && !probe.exists) {
      err(`tfm: there's no release ${tag}`);
      const tags = await fetchReleaseTags(deps.fetch ? { fetch: deps.fetch } : {});
      // stable versions first — the alphas are noise for someone who typed
      // "1.0.1" and meant a released version
      const stable = (tags ?? []).filter((t) => /^v\d+\.\d+\.\d+$/.test(t));
      const list = stable.length > 0 ? stable : (tags ?? []);
      err(
        list.length > 0
          ? `published releases: ${list.slice(0, 8).join(", ")}`
          : `see ${UPDATE_RELEASES_URL} for the published versions`,
      );
      return 1;
    }
  }
  if (!parsed.force && (latest === current || (parsed.tag === null && !isNewer(current, latest)))) {
    out(`tfm ${current} is up to date`);
    return 0;
  }

  out(`tfm ${current} → ${latest}`);
  const interactive = (deps.isTTY ?? (() => process.stdin.isTTY === true))();
  // the non-interactive policy is NAMED at the ask site: the update is
  // non-destructive and the user explicitly asked for it, so a piped
  // `tfm update` installs without a question (the old shape derived this
  // from the `interactive` BOOLEAN, so the answer was a property of the
  // boolean rather than of the question)
  const outcome = await askOnce({
    question: "Update now?",
    interactive,
    nonInteractive: "assume-yes",
    defaultAnswer: "yes",
    ...(deps.ask ? { ask: deps.ask } : {}),
  });
  if (outcome.kind === "aborted" || !outcome.value) {
    out("cancelled, nothing changed");
    return 0;
  }

  const install = deps.install ?? runInstaller;
  try {
    const res = await install({
      tag: tagFor(latest),
      // the running binary knows where it lives, so a custom install dir is
      // preserved with no config and no stored setting
      installDir: installDirOf(execPath),
      capture: false,
      ...(deps.fetch ? { fetch: deps.fetch } : {}),
      ...(deps.spawn ? { spawn: deps.spawn } : {}),
      ...(deps.tmpFile ? { tmpFile: deps.tmpFile } : {}),
    });
    if (!res.ok) {
      err(`tfm: update failed${res.detail ? ` (${res.detail})` : ""}`);
      return 1;
    }
    return 0;
  } catch (e) {
    err(`tfm: update failed (${errMessage(e)})`);
    return 1;
  }
};
