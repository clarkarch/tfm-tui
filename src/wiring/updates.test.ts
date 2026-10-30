import { describe, expect, test } from "bun:test";
import type { UpdateCache, UpdateStatus } from "../app/update";
import type { InstallerResult, RunInstallerDeps } from "../app/update-run";
import { wireUpdates, type UpdatesCtx } from "./updates";

const settleUntil = async (cond: () => boolean, ms = 2000): Promise<void> => {
  const deadline = Date.now() + ms;
  while (!cond() && Date.now() < deadline) await Bun.sleep(5);
  if (!cond()) throw new Error("settleUntil timeout");
};

type Harness = {
  ctx: UpdatesCtx;
  notes: Array<{ msg: string; title?: string; level?: string }>;
  stickies: Array<{ msg: string; closed: boolean }>;
  confirmations: Array<{ message: string; yesLabel: string }>;
  installs: RunInstallerDeps[];
  fetches: () => number;
  status: () => UpdateStatus | null;
};

const harness = (over: Partial<UpdatesCtx> = {}, result?: InstallerResult): Harness => {
  const notes: Harness["notes"] = [];
  const stickies: Harness["stickies"] = [];
  const confirmations: Harness["confirmations"] = [];
  const installs: RunInstallerDeps[] = [];
  let fetches = 0;
  let cache: UpdateCache | null = null;
  const ctx: UpdatesCtx = {
    current: "1.0.0",
    execPath: "/home/u/.local/bin/tfm",
    enabled: () => true,
    notify: (msg, title, level) => notes.push({ msg, title, level }),
    sticky: (msg) => {
      const handle = { msg, closed: false };
      stickies.push(handle);
      return {
        close: () => {
          handle.closed = true;
        },
      };
    },
    confirm: (message, yesLabel, onYes) => {
      confirmations.push({ message, yesLabel });
      onYes();
      return true;
    },
    repaint: () => {},
    fetchTag: async () => {
      fetches++;
      return "1.1.0";
    },
    install: async (o) => {
      installs.push(o);
      return result ?? { ok: true, code: 0, detail: "" };
    },
    cache: {
      read: async () => cache,
      write: async (c) => {
        cache = c;
      },
    },
    ...over,
  };
  const wired = wireUpdates(ctx);
  return { ctx, notes, stickies, confirmations, installs, fetches: () => fetches, status: wired.status };
};

describe("wireUpdates", () => {
  test("the boot check stays quiet while the toggle is off", async () => {
    const h = harness({ enabled: () => false });
    const u = wireUpdates(h.ctx);
    await u.checkOnBoot();
    expect(h.notes).toEqual([]);
  });

  test("a fresh cache means no network at all", async () => {
    const h = harness();
    const u = wireUpdates(h.ctx);
    await u.checkOnBoot();
    await u.checkOnBoot();
    expect(h.notes.length).toBe(1);
  });

  test("boot toasts once per version, not once per launch", async () => {
    const h = harness();
    const u = wireUpdates(h.ctx);
    await u.checkOnBoot();
    expect(h.notes).toEqual([
      { msg: "A new version of tfm is available, open the menu to update", title: "Update", level: "info" },
    ]);
    // second launch, same cache (fresh): nothing new to say
    h.notes.length = 0;
    await u.checkOnBoot();
    expect(h.notes).toEqual([]);
  });

  test("a manual check always answers, even when it just checked", async () => {
    const h = harness();
    const u = wireUpdates(h.ctx);
    await u.checkOnBoot();
    h.notes.length = 0;
    await u.checkNow({ toast: "always" });
    expect(h.notes.length).toBe(1);
  });

  test("a dev build never touches the network", async () => {
    let fetched = 0;
    const h = harness({
      execPath: "/usr/local/bin/bun",
      fetchTag: async () => {
        fetched++;
        return null;
      },
    });
    const u = wireUpdates(h.ctx);
    await u.checkOnBoot();
    expect(fetched).toBe(0);
    expect(u.status()).toEqual({ kind: "dev", current: "1.0.0" });
  });

  test("an unreachable github reads as unknown, never as up to date", async () => {
    const h = harness({ fetchTag: async () => null });
    const u = wireUpdates(h.ctx);
    await u.checkNow({ toast: "always" });
    expect(u.status()?.kind).toBe("unknown");
    expect(h.notes[0]?.msg).toMatch(/Couldn't check/);
    expect(h.notes[0]?.level).toBe("error");
  });

  test("clicking the row when already up to date reports it and does not install", async () => {
    const h = harness({ fetchTag: async () => "1.0.0" });
    const u = wireUpdates(h.ctx);
    await u.activate();
    expect(h.confirmations).toEqual([]);
    expect(h.installs).toEqual([]);
    expect(h.notes[0]?.msg).toBe("tfm 1.0.0 is up to date");
  });

  test("clicking the row checks first, then asks", async () => {
    const h = harness();
    const u = wireUpdates(h.ctx);
    await u.activate();
    expect(h.confirmations).toEqual([{ message: "A new version of tfm is available!", yesLabel: "Update to 1.1.0" }]);
  });

  test("an already-known update asks immediately, with no second check", async () => {
    const h = harness();
    const u = wireUpdates(h.ctx);
    await u.checkNow({ toast: "never" });
    expect(h.fetches()).toBe(1);
    await u.activate();
    expect(h.confirmations.length).toBe(1);
    // the click reused the answer it already had
    expect(h.fetches()).toBe(1);
  });

  test("confirming installs the pinned release into the running binary's dir", async () => {
    const h = harness();
    const u = wireUpdates(h.ctx);
    await u.activate();
    await settleUntil(() => h.notes.some((n) => n.level === "success"));
    expect(h.installs).toHaveLength(1);
    expect(h.installs[0]?.tag).toBe("v1.1.0");
    expect(h.installs[0]?.installDir).toBe("/home/u/.local/bin");
    expect(h.installs[0]?.capture).toBe(true);
    // the progress toast is opened and then closed, so the outcome is the only thing left
    expect(h.stickies.map((s) => s.msg)).toEqual(["Updating tfm…"]);
    expect(h.stickies[0]?.closed).toBe(true);
    expect(h.notes.at(-1)).toEqual({
      msg: "tfm 1.1.0 ready · restart",
      title: "update",
      level: "success",
    });
  });

  test("after a successful install the row stops offering the old version", async () => {
    const h = harness();
    const u = wireUpdates(h.ctx);
    await u.activate();
    await settleUntil(() => u.status()?.kind === "current");
    expect(u.status()).toEqual({ kind: "current", current: "1.1.0" });
  });

  test("a failed install keeps the update on offer and reports the installer's line", async () => {
    const h = harness({}, { ok: false, code: 1, detail: "FAILED verify, checksum mismatch" });
    const u = wireUpdates(h.ctx);
    await u.activate();
    await settleUntil(() => h.notes.some((n) => n.level === "error"));
    expect(h.notes.at(-1)?.msg).toContain("checksum mismatch");
    expect(u.status()?.kind).toBe("available");
    expect(h.stickies[0]?.closed).toBe(true);
  });

  test("stop() aborts in flight work: a late answer never toasts", async () => {
    let release: ((t: string | null) => void) | null = null;
    const h = harness({
      fetchTag: () =>
        new Promise<string | null>((r) => {
          release = r;
        }),
    });
    const u = wireUpdates(h.ctx);
    const pending = u.checkNow({ toast: "always" });
    // the check reads the cache first, so wait until the fetch is really in flight
    await settleUntil(() => release !== null);
    u.stop();
    (release as unknown as (t: string | null) => void)("1.1.0");
    await pending;
    expect(h.notes).toEqual([]);
  });

  test("overlapping checks share one request", async () => {
    let fetches = 0;
    const h = harness({
      fetchTag: async () => {
        fetches++;
        await Bun.sleep(10);
        return "1.1.0";
      },
    });
    const u = wireUpdates(h.ctx);
    await Promise.all([u.checkNow({ toast: "never" }), u.checkNow({ toast: "never" })]);
    expect(fetches).toBe(1);
  });

  test("a manual check during an in-flight check still asks the network and answers", async () => {
    // the boot check holds the request; a MANUAL check must not reuse it —
    // "a manual check always hits the network and always answers"
    let fetches = 0;
    let release: ((t: string | null) => void) | null = null;
    let reached: (() => void) | null = null;
    const inFlight = new Promise<void>((r) => {
      reached = r;
    });
    const h = harness({
      fetchTag: () =>
        new Promise<string | null>((r) => {
          fetches++;
          release = r;
          reached?.();
        }),
    });
    const u = wireUpdates(h.ctx);
    const boot = u.checkOnBoot();
    await inFlight;
    const manual = u.checkNow({ toast: "always" });
    (release as unknown as (t: string | null) => void)("1.1.0");
    await boot;
    h.notes.length = 0; // only the manual check's own answer matters now
    await settleUntil(() => fetches === 2);
    (release as unknown as (t: string | null) => void)("1.1.0");
    await manual;
    expect(fetches).toBe(2);
    expect(h.notes.length).toBe(1);
  });

  test("stop() during the cache read starts no fetch and repaints nothing", async () => {
    // the generation used to be captured AFTER the cache read, so a stop()
    // that landed during the read compared the new generation with itself:
    // the fetch started anyway and its answer painted into a dead renderer
    let fetches = 0;
    const repaints: string[] = [];
    let release: (() => void) | null = null;
    let reached: (() => void) | null = null;
    const reading = new Promise<void>((r) => {
      reached = r;
    });
    const h = harness({
      repaint: () => repaints.push("repaint"),
      fetchTag: async () => {
        fetches++;
        return "1.1.0";
      },
      cache: {
        read: async () => {
          reached?.();
          await new Promise<void>((r) => {
            release = r;
          });
          return null;
        },
        write: async () => {},
      },
    });
    const u = wireUpdates(h.ctx);
    const pending = u.checkOnBoot();
    await reading;
    const painted = repaints.length;
    u.stop();
    (release as unknown as () => void)();
    await pending;
    expect(fetches).toBe(0);
    expect(repaints.length).toBe(painted);
  });

  test("a fresh-cache check that lands after stop() repaints nothing", async () => {
    // the fresh-cache branch had NO generation guard at all: it published
    // (and repainted the About row) no matter whether stop() had run
    const repaints: string[] = [];
    let release: (() => void) | null = null;
    let reached: (() => void) | null = null;
    const reading = new Promise<void>((r) => {
      reached = r;
    });
    const h = harness({
      repaint: () => repaints.push("repaint"),
      now: () => 1_000_000,
      cache: {
        read: async () => {
          reached?.();
          await new Promise<void>((r) => {
            release = r;
          });
          return { checkedAt: 1_000_000, latest: "1.1.0", notified: null };
        },
        write: async () => {},
      },
    });
    const u = wireUpdates(h.ctx);
    const pending = u.checkOnBoot();
    await reading;
    const painted = repaints.length;
    u.stop();
    (release as unknown as () => void)();
    await pending;
    expect(repaints.length).toBe(painted);
  });

  test("the row repaints once the check settles", async () => {
    const repaints: string[] = [];
    const h = harness({ repaint: () => repaints.push("repaint") });
    const u = wireUpdates(h.ctx);
    await u.checkNow({ toast: "never" });
    expect(repaints.length).toBeGreaterThan(0);
  });
});
