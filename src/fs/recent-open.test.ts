import { describe, expect, test } from "bun:test";
import { makeRecentOpen } from "./recent-open";
import type { SpawnOutcome } from "./spawn-safe";

const settleUntil = async (cond: () => boolean, ms = 3000): Promise<void> => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("settleUntil timeout");
};

// the spawn's fate, settled ONCE: the spawn either started or failed with a
// reason (the shared type — `SpawnOutcome` from ./spawn-safe). The open's
// toast is decided by this one outcome.

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
    spawnOpen: async (p: string) => {
      calls.push(`spawn:${p}`);
      return { ok: true } as const;
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
    // the spawn's outcome decides the toast — a failed open shows the ERROR,
    // never the optimistic "Opening …"
    const { calls, ctx } = mkCtx({
      spawnOpen: async () => ({ ok: false, reason: "xdg-open: not found" }),
      appForFile: async () => "Video Player",
    });
    const { openFileDefault } = makeRecentOpen(ctx);
    openFileDefault("/home/a/movie.mp4");
    await settleUntil(() => calls.some((c) => c.startsWith("notify:")));
    await new Promise((r) => setTimeout(r, 100));
    expect(calls.some((c) => c.includes("Opening movie.mp4"))).toBe(false);
    expect(calls.filter((c) => c.startsWith("notify:")).length).toBe(1);
  });

  test("a failed open shows the ERROR toast, never the optimistic Opening one", async () => {
    // the open's outcome decides the toast — the spawn's fate is a fact, not
    // a boolean the toast's writer races against
    const { calls, ctx } = mkCtx({
      spawnOpen: async () => ({ ok: false, reason: "Executable not found in $PATH" }),
      appForFile: async () => "Video Player",
    });
    const { openFileDefault } = makeRecentOpen(ctx);
    openFileDefault("/home/a/movie.mp4");
    await settleUntil(() => calls.some((c) => c.startsWith("notify:")));
    await new Promise((r) => setTimeout(r, 100));
    const toasts = calls.filter((c) => c.startsWith("notify:"));
    expect(toasts.length).toBe(1);
    expect(toasts[0]).toBe("notify:open:Can't open movie.mp4 · Executable not found in $PATH");
  });

  test("a late spawn failure does not double-toast", async () => {
    // the spawn's fate and the app probe are two async completions; the old
    // shape raced them against a boolean, so a failure landing AFTER the
    // probe answered produced BOTH the "Opening …" toast and the failure
    // toast. The open settles ONCE — whichever way it lands.
    let fail!: (reason: string) => void;
    const { calls, ctx } = mkCtx({
      spawnOpen: () =>
        new Promise<SpawnOutcome>((res) => {
          fail = (reason) => res({ ok: false, reason });
        }),
      appForFile: async () => "Video Player",
    });
    const { openFileDefault } = makeRecentOpen(ctx);
    openFileDefault("/home/a/movie.mp4");
    // the probe answers first — the optimistic toast is due
    await new Promise((r) => setTimeout(r, 50));
    fail("xdg-open: not found");
    await new Promise((r) => setTimeout(r, 100));
    const toasts = calls.filter((c) => c.startsWith("notify:"));
    expect(toasts.length).toBe(1);
    expect(toasts[0]).toBe("notify:open:Can't open movie.mp4 · xdg-open: not found");
  });

  test("a failed open toasts the error without waiting for the app probe", async () => {
    // the probe is a subprocess (slow); the error must not wait for it —
    // the old shape could only report the failure from the probe's own
    // continuation, so a hung probe meant NO outcome at all
    const { calls, ctx } = mkCtx({
      spawnOpen: async () => ({ ok: false, reason: "boom" }),
      appForFile: () => new Promise<string>(() => {}), // never answers
    });
    const { openFileDefault } = makeRecentOpen(ctx);
    openFileDefault("/home/a/movie.mp4");
    await settleUntil(() => calls.some((c) => c.startsWith("notify:")));
    expect(calls.filter((c) => c.startsWith("notify:")).length).toBe(1);
  });

  test("a rejecting app probe still reports the open (never an unhandled rejection)", async () => {
    // the app's NAME is a best-effort detail (a `gio mime` probe); a
    // rejecting probe must not swallow the outcome — and must not become an
    // unhandled rejection (the crash handler announces it on stderr)
    const { calls, ctx } = mkCtx({
      appForFile: async () => {
        throw new Error("gio exploded");
      },
    });
    const { openFileDefault } = makeRecentOpen(ctx);
    openFileDefault("/home/a/movie.mp4");
    await settleUntil(() => calls.some((c) => c.startsWith("notify:")));
    expect(calls).toContain("notify:open:Opening movie.mp4");
  });

  test("executable routes to the Run prompt, never xdg-open", async () => {
    const { calls, ctx } = mkCtx({
      isExecutable: () => ({ executable: true, needsChmod: false }),
      askExecutable: (p) => {
        calls.push(`ask:${p}`);
      },
    });
    const { openFileDefault } = makeRecentOpen(ctx);
    openFileDefault("/home/a/run.sh");
    expect(calls).toContain("ask:/home/a/run.sh");
    expect(calls.some((c) => c.startsWith("spawn:"))).toBe(false);
    await new Promise((r) => setTimeout(r, 300));
    expect(calls.some((c) => c.startsWith("upsert:"))).toBe(false);
  });

  test("non-executable still spawns when the prompt seam is wired", async () => {
    const { calls, ctx } = mkCtx({
      isExecutable: () => ({ executable: false, needsChmod: false }),
      askExecutable: () => {
        calls.push("ask:unexpected");
      },
    });
    const { openFileDefault } = makeRecentOpen(ctx);
    openFileDefault("/home/a/movie.mp4");
    expect(calls.some((c) => c.startsWith("spawn:"))).toBe(true);
    expect(calls).not.toContain("ask:unexpected");
  });

  test("Open anyway re-runs the plain spawn path", async () => {
    const { calls, ctx } = mkCtx({
      isExecutable: () => ({ executable: true, needsChmod: true }),
      askExecutable: (_p, _info, openAnyway) => {
        calls.push("ask:shown");
        openAnyway();
      },
    });
    const { openFileDefault } = makeRecentOpen(ctx);
    openFileDefault("/home/a/app.AppImage");
    expect(calls).toContain("ask:shown");
    expect(calls.some((c) => c.startsWith("spawn:"))).toBe(true);
  });

  test("trash view never prompts, even for executables", async () => {
    const { calls, ctx } = mkCtx({
      inTrashView: () => true,
      isExecutable: () => ({ executable: true, needsChmod: false }),
      askExecutable: () => {
        calls.push("ask:unexpected");
      },
    });
    const { openFileDefault } = makeRecentOpen(ctx);
    openFileDefault("/home/a/run.sh");
    expect(calls).not.toContain("ask:unexpected");
    expect(calls.some((c) => c.startsWith("spawn:"))).toBe(true);
  });
});
