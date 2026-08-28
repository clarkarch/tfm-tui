import { describe, expect, test } from "bun:test";
import { makeTabs, tabTitle, type TabStateRef, type TabsHooks } from "./tabs";

const mkState = (cwd = "/tmp/a"): TabStateRef => ({
  cwd,
  history: [cwd],
  histIdx: 0,
});

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
    // navigate on tab B — navigate() reassigns state.history to a NEW array
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

  test("switchTab to the same index is a no-op", () => {
    const state = mkState();
    const hooks = silentHooks();
    const tabs = makeTabs(state, hooks);
    tabs.switchTab(0);
    expect(hooks.notes).toEqual([]);
  });

  test("switchTab out of range is a no-op", () => {
    const state = mkState();
    const hooks = silentHooks();
    const tabs = makeTabs(state, hooks);
    tabs.switchTab(5);
    tabs.switchTab(-1);
    expect(hooks.notes).toEqual([]);
  });

  test("closeTab before active shifts the index left", () => {
    const state = mkState("/tmp/a");
    const tabs = makeTabs(state, silentHooks());
    tabs.newTab("/tmp/b");
    tabs.newTab("/tmp/c"); // active = 2
    tabs.switchTab(2);
    tabs.closeTab(0); // close first of 3
    expect(tabs.list.length).toBe(2);
    expect(tabs.active).toBe(1);
    expect(tabs.list[1]!.history).toEqual(["/tmp/c"]);
  });

  test("closeTab after active keeps the index", () => {
    const state = mkState("/tmp/a");
    const tabs = makeTabs(state, silentHooks());
    tabs.newTab("/tmp/b");
    tabs.newTab("/tmp/c"); // active = 2
    tabs.closeTab(0);
    expect(tabs.active).toBe(1);
    expect(tabs.list[0]!.history).toEqual(["/tmp/b"]);
  });

  test("closeTab of the active tab syncs its history first", () => {
    const state = mkState("/tmp/a");
    const tabs = makeTabs(state, silentHooks());
    tabs.newTab("/tmp/b"); // active = 1
    state.history = ["/tmp/b", "/tmp/b2"];
    state.histIdx = 1;
    tabs.closeTab(1); // close active; falls back to tab 0
    expect(tabs.active).toBe(0);
    // the outgoing slot captured the navigated history before the splice
    expect(tabs.list[0]!.history).toEqual(["/tmp/a"]);
    expect(state.history).toEqual(["/tmp/a"]);
  });

  test("closing the last tab quits", () => {
    const state = mkState();
    const hooks = silentHooks();
    const tabs = makeTabs(state, hooks);
    tabs.closeTab();
    expect(hooks.notes).toContain("quit");
    expect(tabs.list.length).toBe(1);
  });

  test("closeTab out of range is a no-op", () => {
    const state = mkState();
    const hooks = silentHooks();
    const tabs = makeTabs(state, hooks);
    tabs.closeTab(3);
    tabs.closeTab(-1);
    expect(hooks.notes).toEqual([]);
    expect(tabs.list.length).toBe(1);
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

  test("each tab keeps an independent history across switches", () => {
    const state = mkState("/tmp/a");
    const tabs = makeTabs(state, silentHooks());
    tabs.newTab("/tmp/b");
    state.history = ["/tmp/b", "/tmp/sub"];
    state.histIdx = 1;
    tabs.switchTab(0);
    state.history = ["/tmp/a", "/tmp/other"];
    tabs.syncTabFromState(); // renderAll does this before every tabstrip paint
    tabs.switchTab(1);
    expect(state.history).toEqual(["/tmp/b", "/tmp/sub"]);
    expect(tabs.list[0]!.history).toEqual(["/tmp/a", "/tmp/other"]);
  });
});

describe("tabTitle", () => {
  test("uses the tab's current cwd basename", () => {
    expect(tabTitle({ history: ["/home/clark/Projects"], histIdx: 0 })).toBe("Projects");
  });

  test("follows histIdx through the history", () => {
    expect(tabTitle({ history: ["/a", "/b/c"], histIdx: 1 })).toBe("c");
  });

  test("virtual places get their friendly names", () => {
    expect(tabTitle({ history: ["recent://"], histIdx: 0 })).toBe("Recent");
    expect(tabTitle({ history: ["starred://"], histIdx: 0 })).toBe("Starred");
  });

  test("long names truncate at 16 with an ellipsis", () => {
    const long = "a-very-long-folder-name";
    expect(tabTitle({ history: [`/x/${long}`], histIdx: 0 })).toBe(long.slice(0, 15) + "…");
  });

  test("empty history falls back to /", () => {
    expect(tabTitle({ history: [], histIdx: 0 })).toBe("/");
  });
});
