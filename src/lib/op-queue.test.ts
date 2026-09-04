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
});
