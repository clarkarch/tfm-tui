import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ABOUT_W, aboutValueRoom } from "../ui/ui-about";
import {
  cacheFresh,
  compareVersions,
  isNewer,
  parseTag,
  parseVersion,
  readUpdateCache,
  statusFor,
  tagFor,
  tagFromRedirect,
  UPDATE_CHECK_TTL_MS,
  UPDATE_LATEST_URL,
  UPDATE_REPO,
  updateCachePath,
  updatePromptYesLabel,
  updateRowActionable,
  updateRowValue,
  updateToast,
  writeUpdateCache,
  type UpdateStatus,
} from "./update";

describe("version vocabulary (pure)", () => {
  test("tags parse with or without the v, prereleases included", () => {
    expect(parseTag("v1.1.0")).toBe("1.1.0");
    expect(parseTag("1.1.0")).toBe("1.1.0");
    expect(parseTag(" v1.0.0-rc.1 ")).toBe("1.0.0-rc.1");
    expect(parseTag("v1.1")).toBe("1.1");
    expect(parseTag("nightly")).toBeNull();
    expect(parseTag("")).toBeNull();
    expect(parseTag("v1.1.0.1x")).toBeNull();
  });

  test("compare is numeric per segment, never a string compare", () => {
    // the bug this pins: "1.10.0" < "1.9.0" as strings, so 1.10 would look
    // older than 1.9 and the update would never be offered
    expect(compareVersions("1.10.0", "1.9.0")).toBeGreaterThan(0);
    expect(compareVersions("1.0.0", "1.0.1")).toBeLessThan(0);
    expect(compareVersions("1.1.0", "1.1.0")).toBe(0);
    expect(compareVersions("1.1", "1.1.0")).toBe(0);
    expect(compareVersions("2.0.0", "1.99.99")).toBeGreaterThan(0);
  });

  test("a prerelease sorts BELOW its release, above the previous one", () => {
    expect(compareVersions("1.1.0-rc.1", "1.1.0")).toBeLessThan(0);
    expect(compareVersions("1.1.0-rc.1", "1.0.0")).toBeGreaterThan(0);
  });

  test("unparsable input never claims an update", () => {
    expect(parseVersion("wat")).toBeNull();
    expect(compareVersions("wat", "1.0.0")).toBeNull();
    expect(isNewer("1.0.0", "wat")).toBe(false);
    expect(isNewer("wat", "1.0.0")).toBe(false);
  });

  test("the redirect Location carries the tag (no API, no rate limit)", () => {
    expect(tagFromRedirect("https://github.com/clarkarch/tfm-tui/releases/tag/v1.1.0")).toBe("1.1.0");
    expect(tagFromRedirect("https://github.com/clarkarch/tfm-tui/releases/tag/v1.1.0-rc.1")).toBe("1.1.0-rc.1");
    // a 200 (no redirect, no releases yet) and a login redirect are both unknown
    expect(tagFromRedirect(null)).toBeNull();
    expect(tagFromRedirect("https://github.com/login?return_to=%2Fx")).toBeNull();
  });

  test("isNewer only when latest is strictly ahead", () => {
    expect(isNewer("1.0.0", "1.1.0")).toBe(true);
    expect(isNewer("1.0.0", "1.0.0")).toBe(false);
    // a pinned OLD tag (--tag v0.9.0) must never read as an update: no downgrade
    expect(isNewer("1.1.0", "1.0.0")).toBe(false);
  });

  test("the tag round-trips through tagFor for the installer env", () => {
    expect(tagFor("1.1.0")).toBe("v1.1.0");
  });

  test("the repo URL constants point at this project", () => {
    expect(UPDATE_REPO).toBe("clarkarch/tfm-tui");
    expect(UPDATE_LATEST_URL).toBe("https://github.com/clarkarch/tfm-tui/releases/latest");
  });
});

describe("status (pure)", () => {
  test("dev builds are their own state, never compared to a tag", () => {
    expect(statusFor({ current: "1.0.0", isDev: true, latest: "1.1.0" })).toEqual({ kind: "dev", current: "1.0.0" });
  });

  test("an unreachable/unknown latest is 'unknown', not 'current'", () => {
    // telling someone they are up to date when we could not ask GitHub is a lie
    expect(statusFor({ current: "1.0.0", latest: null }).kind).toBe("unknown");
    expect(statusFor({ current: "1.0.0", latest: "wat" }).kind).toBe("unknown");
  });

  test("equal (or older) latest reads as current, newer as available", () => {
    expect(statusFor({ current: "1.0.0", latest: "1.0.0" }).kind).toBe("current");
    expect(statusFor({ current: "1.1.0", latest: "1.0.0" }).kind).toBe("current");
    expect(statusFor({ current: "1.0.0", latest: "1.1.0" })).toEqual({
      kind: "available",
      current: "1.0.0",
      latest: "1.1.0",
    });
  });

  test("every row value fits the About value room (or it truncates mid-word)", () => {
    const room = aboutValueRoom(ABOUT_W);
    const states: UpdateStatus[] = [
      { kind: "idle" },
      { kind: "checking" },
      { kind: "current", current: "1.0.0" },
      { kind: "available", current: "1.0.0", latest: "1.1.0" },
      { kind: "dev", current: "1.0.0" },
      { kind: "unknown", current: "1.0.0" },
    ];
    for (const s of states) {
      const value = updateRowValue(s);
      expect(value.length, `${s.kind}: ${value}`).toBeLessThanOrEqual(room);
      expect(value).not.toContain("\u2014");
    }
  });

  test("the row is a control: only a check already running is not clickable", () => {
    expect(updateRowActionable({ kind: "available", current: "1.0.0", latest: "1.1.0" })).toBe(true);
    expect(updateRowActionable({ kind: "idle" })).toBe(true);
    expect(updateRowActionable({ kind: "current", current: "1.0.0" })).toBe(true);
    expect(updateRowActionable({ kind: "unknown", current: "1.0.0" })).toBe(true);
    expect(updateRowActionable({ kind: "checking" })).toBe(false);
  });

  test("toast copy is plain language and level-correct", () => {
    expect(updateToast({ kind: "available", current: "1.0.0", latest: "1.1.0" })).toEqual({
      title: "Update",
      message: "A new version of tfm is available, open the menu to update",
      level: "info",
    });
    expect(updateToast({ kind: "current", current: "1.0.0" }).level).toBe("success");
    expect(updateToast({ kind: "current", current: "1.0.0" }).message).toBe("tfm 1.0.0 is up to date");
    expect(updateToast({ kind: "unknown", current: "1.0.0" }).level).toBe("error");
    // no em dash anywhere in the copy the user reads
    for (const s of [
      { kind: "idle" as const },
      { kind: "available" as const, current: "1.0.0", latest: "1.1.0" },
      { kind: "current" as const, current: "1.0.0" },
      { kind: "unknown" as const, current: "1.0.0" },
      { kind: "dev" as const, current: "1.0.0" },
    ]) {
      expect(updateToast(s).message).not.toContain("\u2014");
    }
  });

  test("the yes button says the version while it fits the button", () => {
    // the widest existing label is "Delete permanently" (18); the button is
    // `[ <label> ]` in a ~22-cell box, so past 18 it clips mid-word
    expect(updatePromptYesLabel("1.1.0")).toBe("Update to 1.1.0");
    expect(updatePromptYesLabel("1.10.0")).toBe("Update to 1.10.0");
    expect(updatePromptYesLabel("1.1.0-rc.1")).toBe("Update");
  });
});

describe("check cache (fs, sandboxed path)", () => {
  const sandbox = (): string => mkdtempSync(path.join(os.tmpdir(), "tfm-update-"));

  test("round-trips through an XDG-cache-shaped path", async () => {
    const dir = sandbox();
    const file = path.join(dir, "tfm", "update-check.json");
    try {
      expect(await readUpdateCache(file)).toBeNull();
      await writeUpdateCache({ checkedAt: 123, latest: "1.1.0", notified: null }, file);
      expect(await readUpdateCache(file)).toEqual({ checkedAt: 123, latest: "1.1.0", notified: null });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("garbage, a missing file, and a half-written shape all read as no cache", async () => {
    const dir = sandbox();
    const file = path.join(dir, "update-check.json");
    try {
      writeFileSync(file, "{not json");
      expect(await readUpdateCache(file)).toBeNull();
      writeFileSync(file, JSON.stringify({ checkedAt: "yesterday", latest: 5 }));
      expect(await readUpdateCache(file)).toBeNull();
      expect(await readUpdateCache(path.join(dir, "nope.json"))).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("freshness is a TTL window over checkedAt", () => {
    const now = 1_000_000_000_000;
    const fresh = { checkedAt: now - 1000, latest: "1.1.0", notified: null };
    const stale = { checkedAt: now - UPDATE_CHECK_TTL_MS - 1, latest: "1.1.0", notified: null };
    expect(cacheFresh(fresh, now)).toBe(true);
    expect(cacheFresh(stale, now)).toBe(false);
    expect(cacheFresh(null, now)).toBe(false);
    // a clock that jumped backwards must not make an entry fresh forever
    expect(cacheFresh({ checkedAt: now + UPDATE_CHECK_TTL_MS * 2, latest: null, notified: null }, now)).toBe(false);
  });

  test("the default path honors $XDG_CACHE_HOME", () => {
    const prev = process.env.XDG_CACHE_HOME;
    process.env.XDG_CACHE_HOME = "/tmp/opencode/xdg-cache-probe";
    try {
      expect(updateCachePath()).toBe("/tmp/opencode/xdg-cache-probe/tfm/update-check.json");
    } finally {
      if (prev === undefined) delete process.env.XDG_CACHE_HOME;
      else process.env.XDG_CACHE_HOME = prev;
    }
  });
});
