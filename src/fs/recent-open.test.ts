import { describe, expect, test } from "bun:test";
import { makeRecentOpen } from "./recent-open";

const settleUntil = async (cond: () => boolean, ms = 3000): Promise<void> => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("settleUntil timeout");
};

const mkCtx = (over: Partial<Parameters<typeof makeRecentOpen>[0]> = {}) => {
  const calls: string[] = [];
  const ctx = {
    inTrashView: () => false,
    notify: (msg: string, title?: string) => {
      calls.push(`notify:${title}:${msg}`);
    },
    upsertRecent: (paths: string[]) => {
      calls.push(`upsert:${paths.join("|")}`);
    },
    spawnOpen: (p: string) => {
      calls.push(`spawn:${p}`);
    },
    openAsRoot: async (p: string) => {
      calls.push(`escalate:${p}`);
    },
    canRead: (_p: string) => true,
    appForFile: async (_p: string) => "Video Player",
    ...over,
  };
  return { calls, ctx };
};

describe("makeRecentOpen", () => {
  test("openFileDefault spawns immediately and toasts the app name", async () => {
    const { calls, ctx } = mkCtx();
    const { openFileDefault } = makeRecentOpen(ctx);
    openFileDefault("/home/a/movie.mp4");
    expect(calls).toContain("spawn:/home/a/movie.mp4");
    await settleUntil(() => calls.some((c) => c.startsWith("notify:")));
    expect(calls.some((c) => c === "notify:open:Opening movie.mp4 · Video Player")).toBe(true);
  });

  test("toasts without app suffix when the probe comes up empty", async () => {
    const { calls, ctx } = mkCtx({ appForFile: async () => "" });
    const { openFileDefault } = makeRecentOpen(ctx);
    openFileDefault("/home/a/file.bin");
    await settleUntil(() => calls.some((c) => c.startsWith("notify:")));
    expect(calls.some((c) => c === "notify:open:Opening file.bin")).toBe(true);
  });

  test("a burst of opens batches + dedupes into ONE xbel rewrite", async () => {
    const { calls, ctx } = mkCtx();
    const { openFileDefault } = makeRecentOpen(ctx);
    openFileDefault("/a");
    openFileDefault("/b");
    openFileDefault("/a"); // duplicate inside the window
    openFileDefault("/c");
    await settleUntil(() => calls.some((c) => c.startsWith("upsert:")));
    const upserts = calls.filter((c) => c.startsWith("upsert:"));
    expect(upserts.length).toBe(1);
    expect(upserts[0]).toBe("upsert:/a|/b|/c");
  });

  test("trash view records nothing", async () => {
    const { calls, ctx } = mkCtx({ inTrashView: () => true });
    const { openFileDefault } = makeRecentOpen(ctx);
    openFileDefault("/a");
    await new Promise((r) => setTimeout(r, 300));
    expect(calls.some((c) => c.startsWith("upsert:"))).toBe(false);
    expect(calls.some((c) => c.startsWith("spawn:"))).toBe(true); // still opens
  });

  test("unreadable file escalates through openAsRoot, never spawns or records", async () => {
    const { calls, ctx } = mkCtx({ canRead: () => false });
    const { openFileDefault } = makeRecentOpen(ctx);
    openFileDefault("/etc/shadow");
    await settleUntil(() => calls.some((c) => c.startsWith("escalate:")));
    expect(calls).toContain("escalate:/etc/shadow");
    expect(calls.some((c) => c.startsWith("spawn:"))).toBe(false);
    await new Promise((r) => setTimeout(r, 300));
    expect(calls.some((c) => c.startsWith("upsert:"))).toBe(false);
  });

  test("readable files never touch openAsRoot", async () => {
    const { calls, ctx } = mkCtx();
    const { openFileDefault } = makeRecentOpen(ctx);
    openFileDefault("/home/a/movie.mp4");
    await settleUntil(() => calls.some((c) => c.startsWith("notify:")));
    expect(calls.some((c) => c.startsWith("escalate:"))).toBe(false);
  });

  test("missing file takes the plain path, never escalates", async () => {
    // canRead is false for ENOENT too — a file deleted between listing and
    // open (or a dangling symlink) must spawn-and-error, not sudo-prompt
    const { calls, ctx } = mkCtx({ canRead: () => false });
    const { openFileDefault } = makeRecentOpen(ctx);
    openFileDefault("/definitely/not/here-tfm-xyz");
    expect(calls).toContain("spawn:/definitely/not/here-tfm-xyz");
    await new Promise((r) => setTimeout(r, 300));
    expect(calls.some((c) => c.startsWith("escalate:"))).toBe(false);
  });

  test("spawn failure suppresses the optimistic Opening toast", async () => {
    let onFailed!: () => void;
    let resolveProbe!: (app: string) => void;
    const { calls, ctx } = mkCtx({
      spawnOpen: (_p: string, f: () => void) => {
        calls.push("spawn:x");
        onFailed = f;
      },
      appForFile: () =>
        new Promise<string>((res) => {
          resolveProbe = res;
        }),
    });
    const { openFileDefault } = makeRecentOpen(ctx);
    openFileDefault("/home/a/movie.mp4");
    onFailed(); // spawn fails before the app probe answers
    resolveProbe("Video Player");
    await new Promise((r) => setTimeout(r, 100));
    expect(calls.some((c) => c.includes("Opening movie.mp4"))).toBe(false);
  });
});
