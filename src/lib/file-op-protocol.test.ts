import { describe, expect, test } from "bun:test";
import { OP_NOTIFY_MIN_MS, shouldNotifyTerminal } from "./file-op-protocol";

// The terminal-notification gate: a finished op reaches the desktop only
// when it took long enough that the user plausibly looked away, and NEVER
// when it was cancelled or partially failed (a notification that claims
// "done" for a half-finished op is a lie).

describe("shouldNotifyTerminal", () => {
  test("a long successful op notifies", () => {
    expect(shouldNotifyTerminal(OP_NOTIFY_MIN_MS, false, 0)).toBe(true);
    expect(shouldNotifyTerminal(OP_NOTIFY_MIN_MS + 1, false, 0)).toBe(true);
  });

  test("a quick op does not (the toast is still on screen)", () => {
    expect(shouldNotifyTerminal(0, false, 0)).toBe(false);
    expect(shouldNotifyTerminal(OP_NOTIFY_MIN_MS - 1, false, 0)).toBe(false);
  });

  test("a cancelled op never notifies", () => {
    expect(shouldNotifyTerminal(OP_NOTIFY_MIN_MS * 10, true, 0)).toBe(false);
  });

  test("a partially failed op never notifies", () => {
    expect(shouldNotifyTerminal(OP_NOTIFY_MIN_MS * 10, false, 1)).toBe(false);
  });
});
