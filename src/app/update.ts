// --- Update model (leaf): the release/tag vocabulary, version compare, the
// copy every surface prints, and the on-disk check cache. Pure apart from the
// cache IO (injectable path), so the About row, the toast, the in-app check
// and `tfm update` all read one source of truth. The network/spawn halves live
// in ./update-run; the surfaces in ./update-cli and wiring/updates. ---

import { mkdirSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { atomicWriteFile } from "../fs/fsutil";
import type { NotifyLevel } from "../lib/notify-level";

export const UPDATE_REPO = "clarkarch/tfm-tui";

// /releases/latest 302s to /releases/tag/<tag>, so a plain HEAD reads the tag
// with no API token and no rate limit (verified against this repo: 302 with
// location https://github.com/<repo>/releases/tag/v1.0.0). The API path
// (api.github.com/.../releases/latest) is rate limited per IP and 403s on
// shared addresses, which would quietly turn everyone's check into "unknown".
export const UPDATE_LATEST_URL = `https://github.com/${UPDATE_REPO}/releases/latest`;

// The installer the user already trusts (the documented one-liner). `tfm
// update` delegates to it instead of re-implementing download/verify/swap:
// one place decides replace + checksum policy, so the two paths cannot drift.
export const UPDATE_INSTALLER_URL = `https://raw.githubusercontent.com/${UPDATE_REPO}/main/install.sh`;

// one check per day, and the toast fires once per version (see `notified`)
export const UPDATE_CHECK_TTL_MS = 24 * 60 * 60 * 1000;
export const UPDATE_TIMEOUT_MS = 4000;
export const UPDATE_INSTALL_TIMEOUT_MS = 30_000;

export type UpdateStatus =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "current"; current: string }
  | { kind: "available"; current: string; latest: string }
  | { kind: "dev"; current: string }
  | { kind: "unknown"; current: string };

export type ParsedVersion = { nums: number[]; pre: string };

const VERSION_RE = /^v?(\d+(?:\.\d+)*)(?:-([0-9A-Za-z][0-9A-Za-z.-]*))?$/;

export const parseVersion = (raw: string): ParsedVersion | null => {
  const m = VERSION_RE.exec(raw.trim());
  if (!m) return null;
  return { nums: (m[1] as string).split(".").map((n) => Number.parseInt(n, 10)), pre: m[2] ?? "" };
};

// tag -> bare version ("v1.1.0" -> "1.1.0"). Null for anything that isn't a
// version: a tag like `nightly` must read as unknown, never as older.
export const parseTag = (raw: string): string | null => {
  const m = VERSION_RE.exec(raw.trim());
  if (!m) return null;
  return m[2] ? `${m[1]}-${m[2]}` : (m[1] as string);
};

export const tagFor = (version: string): string => `v${version}`;

// numeric per segment, never a string compare ("1.10.0" sorts BELOW "1.9.0"
// as a string, which would silently stop offering the update). A prerelease
// sorts below its own release. Null when either side is unparsable.
export const compareVersions = (a: string, b: string): number | null => {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) return null;
  const len = Math.max(pa.nums.length, pb.nums.length);
  for (let i = 0; i < len; i++) {
    const d = (pa.nums[i] ?? 0) - (pb.nums[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  if (pa.pre === pb.pre) return 0;
  if (!pa.pre) return 1;
  if (!pb.pre) return -1;
  return pa.pre < pb.pre ? -1 : 1;
};

// strictly ahead: equal is not an update, and an OLDER latest (a pinned --tag,
// or a dev build ahead of the release) must never read as one.
export const isNewer = (current: string, latest: string): boolean => {
  const c = compareVersions(current, latest);
  return c !== null && c < 0;
};

// the redirect Location (".../releases/tag/v1.1.0") -> "1.1.0". A 200 (no
// releases yet) or GitHub's login redirect both carry no tag.
export const tagFromRedirect = (location: string | null | undefined): string | null => {
  if (!location) return null;
  const m = /\/releases\/tag\/([^/?#]+)\/?$/.exec(location);
  return m ? parseTag(m[1] as string) : null;
};

export const statusFor = (o: { current: string; latest?: string | null; isDev?: boolean }): UpdateStatus => {
  // a source build has no comparable version: it iterates with git, not tags
  if (o.isDev === true) return { kind: "dev", current: o.current };
  const latest = o.latest ?? null;
  // "couldn't ask" is never "up to date"
  if (latest === null || parseVersion(latest) === null) return { kind: "unknown", current: o.current };
  if (!isNewer(o.current, latest)) return { kind: "current", current: o.current };
  return { kind: "available", current: o.current, latest };
};

// --- copy: one place, so the About row, the toast and the confirm cannot
// disagree. Plain language, no em dashes, and the row value must fit
// aboutValueRoom(ABOUT_W) or it truncates mid-word (pinned by a test). ---
export const updateRowValue = (s: UpdateStatus): string => {
  switch (s.kind) {
    case "idle":
      return "check for updates";
    case "checking":
      return "checking…";
    case "current":
      return `up to date · v${s.current}`;
    case "available":
      return `update to v${s.latest}`;
    case "dev":
      return "dev build";
    case "unknown":
      return "couldn't check";
  }
};

// the row is a control, not a readout: every settled state can be clicked to
// check again (only a check already in flight is not clickable)
export const updateRowActionable = (s: UpdateStatus): boolean => s.kind !== "checking";

export const updateToast = (s: UpdateStatus): { title: string; message: string; level: NotifyLevel } => {
  switch (s.kind) {
    case "idle":
      return { title: "Update", message: "Checking for updates…", level: "info" };
    case "available":
      return {
        title: "Update",
        message: "A new version of tfm is available, open the menu to update",
        level: "info",
      };
    case "current":
      return { title: "Update", message: `tfm ${s.current} is up to date`, level: "success" };
    case "dev":
      return { title: "Update", message: "This is a dev build, update it with source.sh", level: "info" };
    case "unknown":
      return { title: "Update", message: "Couldn't check for updates, check your connection", level: "error" };
    case "checking":
      return { title: "Update", message: "Checking for updates…", level: "info" };
  }
};

// the confirm: one line that always fits wrapYesNoMessage's 45-cell budget,
// with the version riding the button instead (the message stays break-proof).
export const UPDATE_PROMPT_MESSAGE = "A new version of tfm is available!";

// the widest label the yes button already carries is "Delete permanently"
// (18 cells) inside `[ <label> ]`; past that it clips mid-word, so an exotic
// version (a prerelease) falls back to the plain verb.
export const UPDATE_PROMPT_LABEL_BUDGET = 18;
export const updatePromptYesLabel = (latest: string, budget = UPDATE_PROMPT_LABEL_BUDGET): string => {
  const label = `Update to ${latest}`;
  return label.length <= budget ? label : "Update";
};

// --- check cache: $XDG_CACHE_HOME/tfm/update-check.json. Ephemeral (a TTL
// window + the last version we told the user about), so it is cache, not
// state. `notified` is what keeps the startup check to one toast per release
// instead of one per launch. ---
export type UpdateCache = {
  checkedAt: number;
  latest: string | null;
  notified: string | null;
};

export const updateCachePath = (): string =>
  path.join(process.env.XDG_CACHE_HOME ?? path.join(os.homedir(), ".cache"), "tfm", "update-check.json");

export const readUpdateCache = async (file = updateCachePath()): Promise<UpdateCache | null> => {
  try {
    const raw: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (typeof raw !== "object" || raw === null) return null;
    const c = raw as { checkedAt?: unknown; latest?: unknown; notified?: unknown };
    if (typeof c.checkedAt !== "number" || !Number.isFinite(c.checkedAt)) return null;
    const latest = typeof c.latest === "string" ? c.latest : null;
    const notified = typeof c.notified === "string" ? c.notified : null;
    return { checkedAt: c.checkedAt, latest, notified };
  } catch {
    return null;
  }
};

export const writeUpdateCache = async (data: UpdateCache, file = updateCachePath()): Promise<void> => {
  mkdirSync(path.dirname(file), { recursive: true });
  // tmp+rename: a truncated write would otherwise be a valid hit forever
  await atomicWriteFile(file, JSON.stringify(data));
};

export const cacheFresh = (cache: UpdateCache | null, now: number, ttl = UPDATE_CHECK_TTL_MS): boolean => {
  if (!cache) return false;
  const age = now - cache.checkedAt;
  // a clock that jumped BACKWARDS (or a stamped-future file) is not fresh: an
  // expired entry must not become immortal
  return age >= 0 && age < ttl;
};
