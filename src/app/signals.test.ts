import { describe, expect, test } from "bun:test";
import { SIGNAL_QUIT_EVENTS, wireSignalQuit } from "./signals";

describe("wireSignalQuit", () => {
  test("registers SIGHUP and SIGTERM", () => {
    const events: string[] = [];
    wireSignalQuit({ on: (e) => void events.push(e), quit: () => {} });
    expect(events).toEqual([...SIGNAL_QUIT_EVENTS]);
  });

  test("a signal fires the force quit once (re-entry guarded)", () => {
    const seen: string[] = [];
    const cbs = new Map<string, () => void>();
    let quits = 0;
    wireSignalQuit({
      on: (e, cb) => void cbs.set(e, cb),
      quit: () => void quits++,
    });
    cbs.get("SIGHUP")!();
    cbs.get("SIGTERM")!();
    expect(quits).toBe(1);
    expect(seen).toEqual([]);
  });

  test("a throwing listener install never throws the boot", () => {
    expect(() =>
      wireSignalQuit({
        on: () => {
          throw new Error("nope");
        },
        quit: () => {},
      }),
    ).not.toThrow();
  });
});
