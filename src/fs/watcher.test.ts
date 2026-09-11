import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { makeCwdWatcher } from "./watcher";

// virtual clock: the debounce is a timing unit, tests must not wall-clock sleep
const makeClock = () => {
  const jobs: { at: number; fn: () => void }[] = [];
  let now = 0;
  return {
    setTimeout(cb: () => void, ms: number): unknown {
      const job = { at: now + ms, fn: cb };
      jobs.push(job);
      return job;
    },
    clearTimeout(handle: unknown): void {
      const i = jobs.indexOf(handle as { at: number; fn: () => void });
      if (i >= 0) jobs.splice(i, 1);
    },
    advance(ms: number): void {
      const end = now + ms;
      for (;;) {
        jobs.sort((a, b) => a.at - b.at);
        const next = jobs[0];
        if (!next || next.at > end) break;
        now = next.at;
        jobs.shift()!.fn();
      }
      now = end;
    },
  };
};

// poll until cond() passes — fs.watch events + the 200ms debounce are async
const settleUntil = async (cond: () => boolean, ms = 4000): Promise<void> => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("settleUntil timeout");
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("makeCwdWatcher", () => {
  test("external changes in the watched dir trigger renderGrid (debounced)", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "tfm-watch-"));
    let gridRenders = 0;
    const { syncCwdWatcher } = makeCwdWatcher({
      cwd: () => dir,
      isVirtualCwd: () => false,
      isRenaming: () => false,
      renderGrid: () => {
        gridRenders++;
      },
    });
    syncCwdWatcher();
    writeFileSync(path.join(dir, "new-file"), "x");
    await settleUntil(() => gridRenders > 0);
  });

  test("a burst of events coalesces into at most a few rebuilds", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "tfm-watch-burst-"));
    let gridRenders = 0;
    const { syncCwdWatcher } = makeCwdWatcher({
      cwd: () => dir,
      isVirtualCwd: () => false,
      isRenaming: () => false,
      renderGrid: () => {
        gridRenders++;
      },
    });
    syncCwdWatcher();
    for (let i = 0; i < 10; i++) writeFileSync(path.join(dir, `f${i}`), "x");
    await settleUntil(() => gridRenders > 0);
    // debounce window: 10 rapid creates land inside one 200ms coalesce
    await sleep(500);
    expect(gridRenders).toBeLessThanOrEqual(3);
  });

  test("isRenaming guard swallows the event (inline-edit survives)", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "tfm-watch-rename-"));
    let gridRenders = 0;
    let renaming = true;
    const { syncCwdWatcher } = makeCwdWatcher({
      cwd: () => dir,
      isVirtualCwd: () => false,
      isRenaming: () => renaming,
      renderGrid: () => {
        gridRenders++;
      },
    });
    syncCwdWatcher();
    writeFileSync(path.join(dir, "while-renaming"), "x");
    await sleep(600);
    expect(gridRenders).toBe(0);
    // a later event with the rename finished goes through
    renaming = false;
    writeFileSync(path.join(dir, "after-rename"), "x");
    await settleUntil(() => gridRenders > 0);
  });

  test("virtual cwd closes the watcher: no rebuilds for that URI", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "tfm-watch-virt-"));
    let gridRenders = 0;
    let virtual = false;
    const { syncCwdWatcher } = makeCwdWatcher({
      cwd: () => (virtual ? "recent://" : dir),
      isVirtualCwd: () => virtual,
      isRenaming: () => false,
      renderGrid: () => {
        gridRenders++;
      },
    });
    syncCwdWatcher();
    virtual = true;
    syncCwdWatcher();
    writeFileSync(path.join(dir, "after-virtual"), "x");
    await sleep(600);
    expect(gridRenders).toBe(0);
  });

  test("a failed watch() for the current dir is retried on the next sync", async () => {
    // the early-return keyed on watchedDir alone assumed "recorded == alive":
    // once a watch() call threw (dir vanished between listing and watching),
    // watchedDir stayed latched and every later sync for the same dir
    // early-returned — the grid went permanently stale with no signal
    const dir = mkdtempSync(path.join(os.tmpdir(), "tfm-watch-vanish-"));
    let gridRenders = 0;
    let virtual = false;
    const { syncCwdWatcher } = makeCwdWatcher({
      cwd: () => (virtual ? "recent://" : dir),
      isVirtualCwd: () => virtual,
      isRenaming: () => false,
      renderGrid: () => {
        gridRenders++;
      },
    });
    syncCwdWatcher(); // arms on the real dir
    virtual = true;
    syncCwdWatcher(); // hop away: watcher closed, watchedDir cleared
    rmSync(dir, { recursive: true });
    virtual = false;
    syncCwdWatcher(); // watch() throws ENOENT — must not latch as "watched"
    mkdirSync(dir, { recursive: true });
    syncCwdWatcher(); // same dir again — must re-arm, not early-return
    writeFileSync(path.join(dir, "after-recovery"), "x");
    await settleUntil(() => gridRenders > 0);
  });

  test("an errored watcher is re-armed on the next sync (injected watch)", () => {
    // after the watched dir is replaced (rm -rf + mkdir), the kernel watch
    // dies with an error event; the old handler swallowed it and the dead
    // watcher stayed armed-never-again until the user navigated away and back
    const fakeWatchers: { on: (ev: string, cb: (e: unknown) => void) => void; close: () => void }[] = [];
    let errorCb: ((e: unknown) => void) | null = null;
    let watchCalls = 0;
    const { syncCwdWatcher } = makeCwdWatcher({
      cwd: () => "/w",
      isVirtualCwd: () => false,
      isRenaming: () => false,
      renderGrid: () => {},
      watchImpl: (_dir, cb) => {
        void cb;
        watchCalls++;
        const w = {
          on: (ev: string, cb: (e: unknown) => void) => {
            if (ev === "error") errorCb = cb;
          },
          close: () => {},
        };
        fakeWatchers.push(w);
        return w;
      },
    });
    syncCwdWatcher();
    expect(watchCalls).toBe(1);
    errorCb!(new Error("watch died")); // kernel watch gone (dir replaced)
    syncCwdWatcher();
    expect(watchCalls).toBe(2); // re-armed instead of staying dead
  });

  // --- self-write filtering: dlog appends to /tmp/tfm-dnd.log on EVERY mouse
  // event; when cwd is /tmp the watcher sees it and full-rebuilds the grid
  // visibly after each click. Events for our own sink files must not arm the
  // debounce. ---
  const armedWatcher = (cwd: string, ignorePaths: () => string[], gridRenders: { n: number }) => {
    let cb: ((f?: string | null) => void) | null = null;
    const clock = makeClock();
    const { syncCwdWatcher } = makeCwdWatcher({
      cwd: () => cwd,
      isVirtualCwd: () => false,
      isRenaming: () => false,
      renderGrid: () => {
        gridRenders.n++;
      },
      ignorePaths,
      watchImpl: (_dir, c) => {
        cb = c;
        return { on: () => {}, close: () => {} };
      },
      sched: clock,
    });
    syncCwdWatcher();
    return { fire: (f?: string | null) => cb!(f), clock };
  };

  test("ignored self-written log files do not trigger a rebuild", () => {
    const renders = { n: 0 };
    const w = armedWatcher("/w", () => ["/w/tfm-dnd.log", "/w/tfm-debug.log"], renders);
    w.fire("tfm-dnd.log");
    w.fire("tfm-debug.log");
    w.fire("/w/tfm-dnd.log"); // absolute form from a lenient watch impl
    w.clock.advance(500);
    expect(renders.n).toBe(0);
    // a real external change still rebuilds
    w.fire("new-file.txt");
    w.clock.advance(500);
    expect(renders.n).toBe(1);
  });

  test("a null filename is never filtered (can't tell what changed)", () => {
    const renders = { n: 0 };
    const w = armedWatcher("/w", () => ["/w/tfm-dnd.log"], renders);
    w.fire(null);
    w.clock.advance(500);
    expect(renders.n).toBe(1);
  });

  test("a same-named file outside the watched dir is not filtered", () => {
    // /w2 holds its own tfm-dnd.log — it is NOT the ignored /w one
    const renders = { n: 0 };
    const w = armedWatcher("/w2", () => ["/w/tfm-dnd.log"], renders);
    w.fire("tfm-dnd.log");
    w.clock.advance(500);
    expect(renders.n).toBe(1);
  });

  test("real fs.watch: appends to an ignored sink file don't rebuild, others do", async () => {
    // guards the DEFAULT watchImpl filename plumbing — the injected tests
    // above call the callback directly and would never catch it being dropped
    const dir = mkdtempSync(path.join(os.tmpdir(), "tfm-watch-ignore-"));
    const sink = path.join(dir, "sink.log");
    writeFileSync(sink, "");
    let gridRenders = 0;
    const { syncCwdWatcher } = makeCwdWatcher({
      cwd: () => dir,
      isVirtualCwd: () => false,
      isRenaming: () => false,
      renderGrid: () => {
        gridRenders++;
      },
      ignorePaths: () => [sink],
    });
    syncCwdWatcher();
    writeFileSync(sink, "append\n");
    await sleep(600); // past the 200ms debounce: a rebuild would have landed
    expect(gridRenders).toBe(0);
    writeFileSync(path.join(dir, "real.txt"), "x");
    await settleUntil(() => gridRenders > 0);
  });
});
