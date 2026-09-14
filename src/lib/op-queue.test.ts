import { describe, expect, test } from "bun:test";
import { makeOpQueue } from "./op-queue";

describe("makeOpQueue", () => {
  test("runs ops serially in enqueue order", async () => {
    const q = makeOpQueue();
    const order: string[] = [];
    const slow = q.enqueue(async () => {
      await Bun.sleep(30);
      order.push("slow");
    });
    const fast = q.enqueue(async () => {
      order.push("fast");
    });
    await Promise.all([slow, fast]);
    expect(order).toEqual(["slow", "fast"]);
  });

  test("a rejection reaches only its caller; the chain stays alive", async () => {
    const q = makeOpQueue();
    const seen: string[] = [];
    const bad = q.enqueue(async () => {
      throw new Error("boom");
    });
    const good = q.enqueue(async () => {
      seen.push("after");
      return 42;
    });
    await expect(bad).rejects.toThrow("boom");
    await expect(good).resolves.toBe(42);
    expect(seen).toEqual(["after"]);
  });

  test("isIdle is false while an op runs or waits behind one", async () => {
    const q = makeOpQueue();
    expect(q.isIdle()).toBe(true);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const first = q.enqueue(() => gate);
    const second = q.enqueue(async () => {});
    await Bun.sleep(10);
    expect(q.isIdle()).toBe(false);
    release();
    await Promise.all([first, second]);
    expect(q.isIdle()).toBe(true);
  });
});
