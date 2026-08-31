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
});
