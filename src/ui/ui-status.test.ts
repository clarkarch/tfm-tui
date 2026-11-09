import { describe, expect, test } from "bun:test";
import { makeStatus } from "./ui-status";

// virtual clock: the reclaim debounce is a timing unit — no wall-clock sleeps
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

// the selection summary the status bar shows when no transient message is live
const SUMMARY = "2 selected · 1.2 MB";

const mkEnv = (resetDelayMs = 30) => {
  const nodes: Record<string, { content: string }> = { "tfm-status-label": { content: "" } };
  let refreshes = 0;
  const clock = makeClock();
  const { setStatusMsg, setStatusLabel } = makeStatus({
    setText: (id, text) => {
      const n = nodes[id];
      if (n) n.content = text;
    },
    // the selection's status write goes through the status module's summary
    // writer (the production wiring routes it there) — the fake mirrors that
    // so the guard is exercised, not bypassed
    refresh: () => {
      refreshes++;
      setStatusLabel("tfm-status-label", SUMMARY);
    },
    resetDelayMs,
    sched: clock,
  });
  return { nodes, setStatusMsg, setStatusLabel, refreshCount: () => refreshes, clock };
};

describe("makeStatus", () => {
  test("writes to the status label node", () => {
    const { nodes, setStatusMsg } = mkEnv();
    setStatusMsg("Copied 3 items");
    expect(nodes["tfm-status-label"]!.content).toBe("Copied 3 items");
  });

  test("a missing node is tolerated (rebuilds kill nodes constantly)", () => {
    const { setStatusMsg } = makeStatus({
      setText: () => {},
      refresh: () => {},
      resetDelayMs: 5,
      sched: makeClock(),
    });
    expect(() => setStatusMsg("x")).not.toThrow();
  });

  test("the selection-summary refresh reclaims the bar after the quiet period", () => {
    const { setStatusMsg, refreshCount, clock } = mkEnv(30);
    setStatusMsg("transient");
    clock.advance(10);
    expect(refreshCount()).toBe(0);
    clock.advance(30);
    expect(refreshCount()).toBe(1);
  });

  test("rapid messages debounce: the reset fires once, after the LAST call", () => {
    const { setStatusMsg, refreshCount, clock } = mkEnv(40);
    setStatusMsg("a");
    clock.advance(15);
    setStatusMsg("b");
    clock.advance(15);
    setStatusMsg("c");
    expect(refreshCount()).toBe(0);
    clock.advance(80);
    expect(refreshCount()).toBe(1);
  });

  test("default reset delay is used when none is given", async () => {
    // no sched injected: exercises the real-clock default — the 2500ms
    // default cannot fire inside a 50ms window, a safe negative assert
    const nodes: Record<string, { content: string }> = { "tfm-status-label": { content: "" } };
    let refreshes = 0;
    const { setStatusMsg } = makeStatus({
      setText: (id, text) => {
        const n = nodes[id];
        if (n) n.content = text;
      },
      refresh: () => {
        refreshes++;
      },
    });
    setStatusMsg("x");
    await new Promise((r) => setTimeout(r, 50));
    expect(refreshes).toBe(0); // 2500ms default — must not have fired yet
  });
});

// The status bar shows EITHER a transient message (an op's outcome) OR the
// selection summary. The phase used to live in the LABEL NODE's content, so
// nothing knew a message was live: a selection-driven write simply
// overwrote it (the message was yanked before its window elapsed) while the
// reclaim timer stayed armed.
describe("status phase", () => {
  test("a selection refresh does not yank a transient message", () => {
    const { nodes, setStatusMsg, setStatusLabel, clock } = mkEnv(30);
    setStatusMsg("Copied 3 items");
    // the selection changes while the transient message is live
    setStatusLabel("tfm-status-label", SUMMARY);
    expect(nodes["tfm-status-label"]!.content).toBe("Copied 3 items");
    // the window ends: the bar goes back to the selection summary (the
    // reclaim refresh recomputes it)
    clock.advance(30);
    expect(nodes["tfm-status-label"]!.content).toBe(SUMMARY);
  });

  test("the summary owns the bar when no transient message is live", () => {
    const { nodes, setStatusLabel } = mkEnv(30);
    setStatusLabel("tfm-status-label", SUMMARY);
    expect(nodes["tfm-status-label"]!.content).toBe(SUMMARY);
  });

  test("a newer transient message takes the bar back", () => {
    const { nodes, setStatusMsg, setStatusLabel } = mkEnv(30);
    setStatusLabel("tfm-status-label", SUMMARY);
    setStatusMsg("Moved 2 items");
    expect(nodes["tfm-status-label"]!.content).toBe("Moved 2 items");
    // and the summary cannot steal it back
    setStatusLabel("tfm-status-label", SUMMARY);
    expect(nodes["tfm-status-label"]!.content).toBe("Moved 2 items");
  });
});

// The module test above proves the GUARD works; this rule proves the
// production path actually consults it. The selection module writes the
// label itself (its own ctx.setText), so without this route the guard is
// never reached and the message is yanked exactly as before.
describe("no-drift rule: both status writers consult the phase", () => {
  test("the selection's label write goes through the status module", async () => {
    const src = await Bun.file(`${import.meta.dir}/../wiring/grid-foundation.ts`).text();
    expect(/setText:\s*nav\.setStatusLabel/.test(src)).toBe(true);
    // the raw sink must not be handed to the selection anymore
    expect(/setText:\s*core\.lookup\.setTextOnId/.test(src)).toBe(false);
  });
});
