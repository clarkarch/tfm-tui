import { describe, expect, test } from "bun:test";
import { makeTabs, nextTab, prevTab, type TabStateRef, type TabsHooks } from "./tabs";

const mkState = (cwd = "/tmp/a"): TabStateRef => ({ cwd, history: [cwd], histIdx: 0 });

const silentHooks = (): TabsHooks & { notes: string[] } => {
  const notes: string[] = [];
  return {
    notes,
    onChanged: () => notes.push("changed"),
    status: (msg) => notes.push(`status:${msg}`),
    quit: () => notes.push("quit"),
  };
};

describe("makeTabs", () => {
  test("newTab opens right of active at the given folder with a fresh history", () => {
    const state = mkState("/tmp/a");
    const hooks = silentHooks();
    const tabs = makeTabs(state, hooks);
    tabs.newTab("/tmp/b");
    expect(tabs.list.length).toBe(2);
    expect(tabs.active).toBe(1);
    expect(tabs.list[1]!.history).toEqual(["/tmp/b"]);
    expect(hooks.notes).toContain("status:Tab 2/2");
    expect(hooks.notes).toContain("changed");
  });

  test("newTab defaults to the active tab's cwd", () => {
    const state = mkState("/tmp/here");
    const tabs = makeTabs(state, silentHooks());
    tabs.newTab();
    expect(tabs.list[1]!.history).toEqual(["/tmp/here"]);
  });

  test("switchTab syncs the outgoing slot and adopts the incoming one (ref identity)", () => {
    const state = mkState("/tmp/a");
    const tabs = makeTabs(state, silentHooks());
    tabs.newTab("/tmp/b");
    state.history = ["/tmp/b", "/tmp/b/sub"];
    state.histIdx = 1;
    tabs.switchTab(0);
    expect(tabs.active).toBe(0);
    expect(state.history).toBe(tabs.list[0]!.history);
    expect(state.history).toEqual(["/tmp/a"]);
    tabs.switchTab(1);
    expect(state.history).toBe(tabs.list[1]!.history);
    expect(state.history).toEqual(["/tmp/b", "/tmp/b/sub"]);
    expect(state.histIdx).toBe(1);
  });

  test("switchTab to the same index or out of range is a no-op", () => {
    const state = mkState();
    const hooks = silentHooks();
    const tabs = makeTabs(state, hooks);
    tabs.switchTab(0);
    tabs.switchTab(5);
    tabs.switchTab(-1);
    expect(hooks.notes).toEqual([]);
  });

  test("closeTab before active shifts the index left", () => {
    const state = mkState("/tmp/a");
    const tabs = makeTabs(state, silentHooks());
    tabs.newTab("/tmp/b");
    tabs.newTab("/tmp/c"); // active = 2
    tabs.closeTab(0);
    expect(tabs.list.length).toBe(2);
    expect(tabs.active).toBe(1);
    expect(tabs.list[1]!.history).toEqual(["/tmp/c"]);
  });

  test("closeTab of the active tab syncs its history first", () => {
    const state = mkState("/tmp/a");
    const tabs = makeTabs(state, silentHooks());
    tabs.newTab("/tmp/b"); // active = 1
    state.history = ["/tmp/b", "/tmp/b2"];
    state.histIdx = 1;
    tabs.closeTab(1);
    expect(tabs.active).toBe(0);
    expect(tabs.list[0]!.history).toEqual(["/tmp/a"]);
    expect(state.history).toEqual(["/tmp/a"]);
  });

  test("closing the last tab quits; out-of-range close is a no-op", () => {
    const state = mkState();
    const hooks = silentHooks();
    const tabs = makeTabs(state, hooks);
    tabs.closeTab(3);
    tabs.closeTab(-1);
    tabs.closeTab();
    expect(hooks.notes).toEqual(["quit"]);
  });

  test("adoptTabs replaces the list and clamps the active index", () => {
    const state = mkState("/tmp/old");
    const tabs = makeTabs(state, silentHooks());
    tabs.adoptTabs(
      [
        { history: ["/tmp/x"], histIdx: 0 },
        { history: ["/tmp/y"], histIdx: 0 },
      ],
      7,
    );
    expect(tabs.list.length).toBe(2);
    expect(tabs.active).toBe(1);
    expect(state.history).toBe(tabs.list[1]!.history);
    expect(state.history).toEqual(["/tmp/y"]);
  });

  test("nextTab/prevTab cycle with wrap and no-op on a single tab", () => {
    const tabs = makeTabs(mkState("/tmp/a"), silentHooks());
    nextTab(tabs); // single tab: nothing to cycle
    expect(tabs.active).toBe(0);
    tabs.newTab("/tmp/b");
    tabs.newTab("/tmp/c"); // active = 2
    nextTab(tabs); // wraps to 0
    expect(tabs.active).toBe(0);
    prevTab(tabs); // wraps to last
    expect(tabs.active).toBe(2);
    prevTab(tabs);
    expect(tabs.active).toBe(1);
  });
});

// --- The tab model's ONE invariant: the list is NEVER empty and the active
// index is always INSIDE it.
//
// The old clamp (`Math.min(Math.max(0, activeIdx), list.length - 1)`) yields
// -1 for an EMPTY list: `list[-1]` is undefined, so `adoptTab` /
// `syncTabFromState` silently no-op'd and the pane kept showing the PREVIOUS
// folder while its tab strip showed none. The empty adopt is now a REFUSAL
// (the model's own tab is the floor) and it is ANNOUNCED — a broken session
// must not vanish silently.
describe("the tab model's invariant", () => {
  const withLog = () => {
    const logs: string[] = [];
    return { logs, log: (msg: string) => logs.push(msg) };
  };

  test("an empty adopt is REFUSED — the tab list is never empty", () => {
    const state = mkState("/tmp/a");
    const tabs = makeTabs(state, silentHooks());
    tabs.adoptTabs([], 0);
    // the old shape emptied the list and clamped the active index to -1
    expect(tabs.list.length).toBe(1);
    expect(tabs.active).toBe(0);
    // and the pane keeps the folder it had (not a stale one)
    expect(state.history).toEqual(["/tmp/a"]);
  });

  test("the refusal is ANNOUNCED — a broken session does not vanish silently", () => {
    const { logs, log } = withLog();
    const tabs = makeTabs(mkState("/tmp/a"), silentHooks(), log);
    tabs.adoptTabs([], 0);
    expect(logs).toHaveLength(1);
    // the announcement names the REFUSAL — not some other trace
    expect(logs[0]).toContain("empty");
  });

  test("adopting the model's OWN list does not empty it", () => {
    const tabs = makeTabs(mkState("/tmp/a"), silentHooks());
    tabs.newTab("/tmp/b"); // two tabs
    // the adopt clears the list before filling it — adopting the list
    // itself would clear the very array it is filling
    tabs.adoptTabs(tabs.list, 0);
    expect(tabs.list.length).toBe(2);
    expect(tabs.active).toBe(0);
  });

  test("the active index stays inside the list through every operation", () => {
    const tabs = makeTabs(mkState("/tmp/a"), silentHooks());
    const inRange = (): boolean => tabs.active >= 0 && tabs.active < tabs.list.length;
    expect(inRange()).toBe(true);
    tabs.newTab("/tmp/b");
    expect(inRange()).toBe(true);
    tabs.newTab("/tmp/c");
    expect(inRange()).toBe(true);
    tabs.switchTab(0);
    expect(inRange()).toBe(true);
    tabs.closeTab(1); // close a tab AFTER the active one
    expect(inRange()).toBe(true);
    tabs.closeTab(0); // close the active one
    expect(inRange()).toBe(true);
    tabs.adoptTabs(
      [
        { history: ["/tmp/x"], histIdx: 0 },
        { history: ["/tmp/y"], histIdx: 0 },
        { history: ["/tmp/z"], histIdx: 0 },
      ],
      99,
    );
    expect(inRange()).toBe(true);
    expect(tabs.active).toBe(2);
  });

  test("a missing active tab is ANNOUNCED, not silently ignored", () => {
    const { logs, log } = withLog();
    const tabs = makeTabs(mkState("/tmp/a"), silentHooks(), log);
    // the list is exposed by reference (the session saver holds it), so an
    // outside mutation can break the invariant — that must be said, not
    // swallowed
    tabs.list.length = 0;
    tabs.syncTabFromState();
    expect(logs).toHaveLength(1);
  });

  test("an adopted tab with an out-of-range history index is clamped", () => {
    const { logs, log } = withLog();
    const state = mkState("/tmp/a");
    const tabs = makeTabs(state, silentHooks(), log);
    // the tab's own pair is broken — adopting it verbatim would break the
    // state's pair too
    tabs.adoptTabs([{ history: ["/tmp/x", "/tmp/y"], histIdx: 99 }], 0);
    expect(state.histIdx).toBe(1);
    expect(logs.some((m) => m.includes("history index"))).toBe(true);
  });

  test("the state pair is clamped before it is copied into the tab", () => {
    const { logs, log } = withLog();
    const state = mkState("/tmp/a");
    state.histIdx = 99;
    const tabs = makeTabs(state, silentHooks(), log);
    tabs.syncTabFromState();
    // the tab must not inherit a broken pair
    expect(state.histIdx).toBe(0);
    expect(logs.some((m) => m.includes("history index"))).toBe(true);
  });
});
