// --- A late-bound implementation slot: "not yet assigned" is ONE named
// state, not the IDENTITY OF A NO-OP FUNCTION.
//
// The old shape initialized a slot with a no-op stub (`= async () => {}`),
// so "the impl is not assigned yet" and "the impl legitimately does
// nothing" were the SAME VALUE: a call that landed before the assignment
// silently did nothing — no toast, no log, no clue. The slot is now a
// tagged record (unset | set) and a call on an unset slot LOGS instead of
// pretending to succeed (the same discipline as `tdzSafe`).

import { describe, expect, test } from "bun:test";
import { makeLateSlot, tdzSafe } from "./late-slot";

describe("tdzSafe (the late-bound READER)", () => {
  test("announces the fallback it had to use", () => {
    const logs: string[] = [];
    const read = (): string[] => {
      throw new ReferenceError("keymap is not initialized");
    };
    expect(tdzSafe(read, [] as string[], (msg) => logs.push(msg))()).toEqual([]);
    // the fallback is a legitimate value — but the miss must be ANNOUNCED
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain("tdzSafe");
  });
});

describe("a late-bound implementation slot", () => {
  test("a call before the impl is assigned LOGS instead of silently succeeding", () => {
    const logs: string[] = [];
    const slot = makeLateSlot<(raw?: string) => Promise<void>>("connectServer", (msg) => logs.push(msg));
    // the slot is EXPLICITLY unset — not "a function that does nothing"
    expect(slot.state().kind).toBe("unset");
    slot.call("sftp://host/path");
    // the no-op stub's silence was the defect: the call must say so
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain("connectServer");
    // and the slot is STILL unset — a failed call does not "become" assigned
    expect(slot.state().kind).toBe("unset");
  });

  test("an assigned slot calls through with the args and stops logging", async () => {
    const logs: string[] = [];
    const seen: Array<string | undefined> = [];
    const slot = makeLateSlot<(raw?: string) => Promise<void>>("connectServer", (msg) => logs.push(msg));
    slot.assign(async (raw) => {
      seen.push(raw);
    });
    expect(slot.state().kind).toBe("set");
    await slot.call("sftp://host/path");
    expect(seen).toEqual(["sftp://host/path"]);
    expect(logs).toEqual([]);
  });

  test("a sync slot works the same way (the sidebar hover seam)", () => {
    const logs: string[] = [];
    const hover: Array<[string, boolean]> = [];
    const slot = makeLateSlot<(key: string, hovered: boolean) => void>("hoverRow", (msg) => logs.push(msg));
    slot.call("tfm-place-0", true);
    expect(logs).toHaveLength(1);
    slot.assign((key, hovered) => {
      hover.push([key, hovered]);
    });
    slot.call("tfm-place-0", true);
    expect(hover).toEqual([["tfm-place-0", true]]);
    expect(logs).toHaveLength(1);
  });
});
