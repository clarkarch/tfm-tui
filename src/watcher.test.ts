import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
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
});
