import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { makeCwdWatcher } from "./watcher";

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
});
