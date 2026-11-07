import { describe, expect, test } from "bun:test";
import { SIGNAL_QUIT_EVENTS, wireSignalQuit } from "./signals";
import { makeForceQuit, type QuitCtx } from "./quit";
import { makeTeardownState } from "../lib/teardown-state";

// The signal path's re-entry guard is the SHARED teardown state — the ONE
// owner of "the app is shutting down". The handler used to keep a private
// `quitOnce` boolean: a second copy of the same fact, which could disagree
// with the quit path's own guard.
describe("wireSignalQuit", () => {
  test("registers SIGHUP and SIGTERM", () => {
    const events: string[] = [];
    const teardown = makeTeardownState();
    wireSignalQuit({ on: (e) => void events.push(e), quit: () => {}, teardown });
    expect(events).toEqual([...SIGNAL_QUIT_EVENTS]);
  });

  test("two signals tear the app down ONCE", () => {
    // the REAL force quit (not a fake): its compare-and-swap is what makes
    // the second signal a no-op, so the fake must mirror that contract
    const calls: string[] = [];
    const teardown = makeTeardownState();
    const ctx = {
      teardown,
      disableDrops: () => calls.push("drops"),
      releaseShiftCapture: () => calls.push("release"),
      flushSession: () => calls.push("session"),
      closeTerminal: () => calls.push("terminal"),
      stopGpm: () => calls.push("gpm"),
      stopChromeTimers: () => calls.push("chrome"),
      stopDevices: () => calls.push("devices"),
      stopUpdates: () => calls.push("updates"),
      stopWatchers: () => calls.push("watchers"),
      stopConfigWatch: () => calls.push("config"),
      onQuit: () => calls.push("onQuit"),
      destroy: () => calls.push("destroy"),
      exit: () => calls.push("exit"),
    } as unknown as QuitCtx;
    const cbs = new Map<string, () => void>();
    wireSignalQuit({
      on: (e, cb) => void cbs.set(e, cb),
      quit: makeForceQuit(ctx),
      teardown,
    });
    cbs.get("SIGHUP")!();
    cbs.get("SIGTERM")!();
    expect(calls.filter((c) => c === "destroy")).toHaveLength(1);
    expect(calls.filter((c) => c === "exit")).toHaveLength(1);
  });

  test("a signal after the teardown already started never asks to quit", () => {
    // the renderer-closed fallback may already have torn the app down — a
    // late SIGHUP must not even ASK (the shared state is the ONE owner of
    // "the app is shutting down")
    const cbs = new Map<string, () => void>();
    let quits = 0;
    const teardown = makeTeardownState();
    wireSignalQuit({
      on: (e, cb) => void cbs.set(e, cb),
      quit: () => void quits++,
      teardown,
    });
    teardown.begin();
    cbs.get("SIGHUP")!();
    expect(quits).toBe(0);
  });

  test("a throwing listener install never throws the boot", () => {
    const teardown = makeTeardownState();
    expect(() =>
      wireSignalQuit({
        on: () => {
          throw new Error("nope");
        },
        quit: () => {},
        teardown,
      }),
    ).not.toThrow();
  });
});
