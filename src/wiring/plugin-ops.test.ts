import { describe, expect, test } from "bun:test";
import { makePluginOps, type PluginOpsDeps } from "./plugin-ops";

// --- The plugin dir mutations (add / update / remove) share ONE directory
// and the same git machinery, so "a plugin dir is being mutated" is ONE
// state. The guard that owns it used to cover ONLY the add path: an
// in-flight clone raced a remove (the clone re-creates the dir the user
// just removed) and two updates on the same repo interleaved
// `git index.lock`. Every path is fire-and-forget, so the tests settle on
// the OBSERVABLE effects (the fs calls + the toasts), never on sleeps. ---

type Harness = {
  ops: ReturnType<typeof makePluginOps>;
  calls: string[];
  toasts: string[];
  release: {
    install: () => void;
    update: (name: string) => void;
  };
};

const harness = (over: Partial<PluginOpsDeps> = {}): Harness => {
  const calls: string[] = [];
  const toasts: string[] = [];
  let releaseInstall!: () => void;
  let releaseUpdate!: (name: string) => void;
  const deps: PluginOpsDeps = {
    notify: (message, title) => toasts.push(`${title ?? ""}:${message}`),
    progress: (title, message) => {
      calls.push(`progress:${title}:${message}`);
      return () => calls.push(`progress-done:${title}`);
    },
    confirm: async () => true,
    prompt: async () => "https://github.com/owner/repo",
    install: async () => {
      calls.push("install");
      await new Promise<void>((r) => {
        releaseInstall = r;
      });
      return { name: "repo" };
    },
    update: async (name) => {
      calls.push(`update:${name}`);
      await new Promise<void>((r) => {
        releaseUpdate = () => r();
      });
      return "updated";
    },
    remove: (name) => calls.push(`remove:${name}`),
    exists: () => false,
    hasGit: () => true,
    log: (m) => calls.push(`log:${m}`),
    refresh: () => calls.push("refresh"),
    ...over,
  };
  return {
    ops: makePluginOps(deps),
    calls,
    toasts,
    release: {
      install: () => releaseInstall(),
      update: (name) => releaseUpdate(name),
    },
  };
};

// let the fire-and-forget async bodies reach their first await
const settle = async (): Promise<void> => {
  for (let i = 0; i < 12; i++) await Promise.resolve();
};

describe("makePluginOps", () => {
  test("an update while an add is in flight is refused", async () => {
    // the add owns the WHOLE plugins dir (its target name is only known
    // after the URL prompt) — an update racing the clone would pull into a
    // dir the clone is still writing
    const h = harness();
    h.ops.addFromUrl();
    await settle();
    expect(h.calls).toContain("install"); // the add is in flight
    h.ops.update("other");
    await settle();
    expect(h.calls.some((c) => c.startsWith("update:"))).toBe(false);
    // the refusal is ANNOUNCED — a refused op must never be silent
    expect(h.toasts.some((t) => t.includes("running"))).toBe(true);
  });

  test("a remove while an update is in flight is refused", async () => {
    // the same plugin dir: the update's git pull and the remove's rm would
    // fight over the same files
    const h = harness();
    h.ops.update("foo");
    await settle();
    expect(h.calls).toContain("update:foo");
    h.ops.remove("foo");
    await settle();
    expect(h.calls.some((c) => c.startsWith("remove:"))).toBe(false);
    expect(h.toasts.some((t) => t.includes("running"))).toBe(true);
  });

  test("a second op on the SAME plugin is refused", async () => {
    // two updates on one repo interleave `git index.lock` — one fails with
    // a raw git error
    const h = harness();
    h.ops.update("foo");
    await settle();
    h.ops.update("foo");
    await settle();
    expect(h.calls.filter((c) => c === "update:foo").length).toBe(1);
  });

  test("an op on a DIFFERENT plugin is not blocked", async () => {
    // the guard is per plugin dir: another plugin's update touches another
    // directory and must not be refused
    const h = harness();
    h.ops.update("foo");
    await settle();
    h.ops.update("bar");
    await settle();
    expect(h.calls).toContain("update:foo");
    expect(h.calls).toContain("update:bar");
  });

  test("the slot is released when the op settles", async () => {
    // a guard that never releases would freeze the Plugins view for the
    // rest of the session
    const h = harness();
    h.ops.update("foo");
    await settle();
    h.release.update("foo");
    await settle();
    h.ops.remove("foo");
    await settle();
    expect(h.calls).toContain("remove:foo");
  });

  test("the add's slot is released when the clone settles", async () => {
    // the add's lifetime is prompt -> confirm -> clone: the slot must free
    // itself when the clone lands, or the Plugins view stays locked
    const h = harness();
    h.ops.addFromUrl();
    await settle();
    expect(h.calls).toContain("install");
    h.release.install();
    await settle();
    h.ops.update("other");
    await settle();
    expect(h.calls.some((c) => c.startsWith("update:"))).toBe(true);
  });

  test("a cancelled prompt releases the add's slot", async () => {
    // the prompt is part of the add's lifetime — cancelling must not leave
    // the dir locked
    const h = harness({ prompt: async () => null });
    h.ops.addFromUrl();
    await settle();
    expect(h.calls.some((c) => c.startsWith("install:"))).toBe(false);
    h.ops.update("other");
    await settle();
    expect(h.calls.some((c) => c.startsWith("update:"))).toBe(true);
  });

  test("a declined confirm releases the add's slot", async () => {
    const h = harness({ confirm: async () => false });
    h.ops.addFromUrl();
    await settle();
    expect(h.calls).not.toContain("install");
    h.ops.update("other");
    await settle();
    expect(h.calls.some((c) => c.startsWith("update:"))).toBe(true);
  });

  test("the add reports its outcome and refreshes the view", async () => {
    // the happy path is unchanged by the guard
    const h = harness();
    h.ops.addFromUrl();
    await settle();
    expect(h.calls).toContain("install");
    h.release.install();
    await settle();
    expect(h.toasts).toContain("plugins:Installed repo");
    expect(h.calls).toContain("refresh");
  });

  test("an update reports its outcome and refreshes the view", async () => {
    const h = harness();
    h.ops.update("foo");
    await settle();
    h.release.update("foo");
    await settle();
    expect(h.toasts).toContain("plugins:foo · updated");
    expect(h.calls).toContain("refresh");
  });

  test("a failed update toasts the error and never refreshes", async () => {
    const h = harness({
      update: async () => {
        throw new Error("git exploded");
      },
    });
    h.ops.update("foo");
    await settle();
    expect(h.toasts).toContain("plugins:git exploded");
    expect(h.calls).not.toContain("refresh");
  });

  test("a remove reports its outcome and refreshes the view", async () => {
    const h = harness();
    h.ops.remove("foo");
    await settle();
    expect(h.calls).toContain("remove:foo");
    expect(h.toasts).toContain("plugins:Removed foo");
    expect(h.calls).toContain("refresh");
  });
});
