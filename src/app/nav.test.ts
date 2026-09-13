import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { initialAppState, makeNav, makeSessionSync, type AppState } from "./nav";
import { makeTabs } from "./tabs";
import { RECENT_URI } from "../fs/uri";

const mkState = (cwd: string): AppState => ({
  cwd,
  history: [cwd],
  histIdx: 0,
  showHidden: false,
  sortBy: "name",
  sortAsc: true,
});

const mkHooks = () => {
  const calls: string[] = [];
  return {
    calls,
    hooks: {
      renderAll: () => calls.push("render"),
      clearSearch: () => calls.push("clearSearch"),
      exitPathEdit: () => calls.push("exitPathEdit"),
      closeFileMenuIfOpen: () => calls.push("closeFileMenu"),
    },
  };
};

// poll until cond() passes (debounced/async sinks — never bare sleeps)
const settleUntil = async (cond: () => boolean, ms = 3000): Promise<void> => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("settleUntil timeout");
};

describe("makeNav", () => {
  test("goBack/goFwd move histIdx and repaint only when possible", () => {
    const st = mkState("/a");
    st.history = ["/a", "/b", "/c"];
    st.histIdx = 0;
    const { calls, hooks } = mkHooks();
    const nav = makeNav(st, hooks);
    nav.goBack();
    expect(st.histIdx).toBe(0);
    expect(calls).toEqual([]);
    nav.goFwd();
    expect(st.histIdx).toBe(1);
    expect(calls).toEqual(["render"]);
    nav.goBack();
    expect(st.histIdx).toBe(0);
    expect(calls).toEqual(["render", "render"]);
  });

  test("canBack/canFwd reflect history bounds", () => {
    const st = mkState("/a");
    st.history = ["/a", "/b"];
    st.histIdx = 0;
    const nav = makeNav(st, mkHooks().hooks);
    expect(nav.canBack()).toBe(false);
    expect(nav.canFwd()).toBe(true);
    st.histIdx = 1;
    expect(nav.canBack()).toBe(true);
    expect(nav.canFwd()).toBe(false);
  });

  test("navigate to a real dir pushes history, clears search, repaints", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "tfm-nav-"));
    const st = mkState("/elsewhere");
    const { calls, hooks } = mkHooks();
    const nav = makeNav(st, hooks);
    nav.navigate(dir);
    expect(st.history).toEqual(["/elsewhere", dir]);
    expect(st.histIdx).toBe(1);
    expect(calls).toEqual(["exitPathEdit", "closeFileMenu", "clearSearch", "render"]);
  });

  test("navigate to the same dir only repaints", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "tfm-nav-"));
    const st = mkState(dir);
    const { calls, hooks } = mkHooks();
    const nav = makeNav(st, hooks);
    nav.navigate(path.join(dir, "sub", ".."));
    expect(st.history).toEqual([dir]);
    expect(calls).toEqual(["exitPathEdit", "closeFileMenu", "render"]);
  });

  test("navigate to a file or missing dir is a no-op (transients still closed)", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "tfm-nav-"));
    const file = path.join(dir, "f.txt");
    writeFileSync(file, "x");
    const st = mkState(dir);
    const { calls, hooks } = mkHooks();
    const nav = makeNav(st, hooks);
    nav.navigate(file);
    nav.navigate(path.join(dir, "nope"));
    expect(st.history).toEqual([dir]);
    expect(st.histIdx).toBe(0);
    // exitPathEdit + closeFileMenu fire unconditionally, even on no-op paths
    expect(calls).toEqual(["exitPathEdit", "closeFileMenu", "exitPathEdit", "closeFileMenu"]);
  });

  test("navigate truncates the forward branch after going back", () => {
    const a = mkdtempSync(path.join(os.tmpdir(), "tfm-nav-"));
    const b = mkdtempSync(path.join(os.tmpdir(), "tfm-nav-"));
    const st = mkState("/start");
    st.history = ["/start", a];
    st.histIdx = 1;
    const { hooks } = mkHooks();
    const nav = makeNav(st, hooks);
    nav.goBack();
    expect(st.histIdx).toBe(0);
    nav.navigate(b);
    expect(st.history).toEqual(["/start", b]);
    expect(st.histIdx).toBe(1);
  });

  test("virtual place: re-entering the current one only repaints, entering from elsewhere pushes", () => {
    const st = mkState(RECENT_URI);
    const { calls, hooks } = mkHooks();
    const nav = makeNav(st, hooks);
    nav.navigate(RECENT_URI);
    expect(st.history).toEqual([RECENT_URI]);
    expect(calls).toEqual(["exitPathEdit", "closeFileMenu", "render"]);
    nav.navigate("starred://");
    expect(st.history).toEqual([RECENT_URI, "starred://"]);
    expect(calls[calls.length - 1]).toBe("render");
    expect(calls).toContain("clearSearch");
  });

  test("goBack/goFwd emit navigate with the resolved history entry", () => {
    const st = mkState("/a");
    st.history = ["/a", "/b", "/c"];
    st.histIdx = 2;
    const { hooks } = mkHooks();
    const seen: string[] = [];
    const nav = makeNav(st, { ...hooks, onNavigate: (d) => seen.push(d) });
    nav.goBack();
    expect(seen).toEqual(["/b"]);
    nav.goBack();
    nav.goFwd();
    expect(seen).toEqual(["/b", "/a", "/b"]);
    // bounds: no move, no emit
    st.histIdx = 0;
    seen.length = 0;
    nav.goBack();
    expect(seen).toEqual([]);
  });

  test("onNavigate fires on real navigations, not on no-ops or dead dirs", () => {
    const st = mkState(RECENT_URI);
    const { hooks } = mkHooks();
    const seen: string[] = [];
    const nav = makeNav(st, { ...hooks, onNavigate: (d) => seen.push(d) });
    nav.navigate(RECENT_URI); // no-op re-enter
    expect(seen).toEqual([]);
    nav.navigate("starred://");
    expect(seen).toEqual(["starred://"]);
  });
});

describe("makeSessionSync", () => {
  const mkModels = (a: AppState, b: AppState) => [
    makeTabs(a, { onChanged() {}, status() {}, quit() {} }),
    makeTabs(b, { onChanged() {}, status() {}, quit() {} }),
  ];

  const mkCtx = (models: ReturnType<typeof mkModels>, paneRef: { v: 0 | 1 }, config: any, isVirtualCwd = () => false) =>
    makeSessionSync({
      paneTabs: () => [
        { tabs: models[0]!.list, activeTab: models[0]!.active },
        { tabs: models[1]!.list, activeTab: models[1]!.active },
      ],
      syncTabsFromState: () => {
        models[0]!.syncTabFromState();
        models[1]!.syncTabFromState();
      },
      adoptPaneTabs: (pane, tabs, activeTab) => models[pane]!.adoptTabs(tabs, activeTab),
      adoptDefaultTabs: () => {
        models[0]!.adoptTab();
        models[1]!.adoptTab();
      },
      activePane: () => paneRef.v,
      setActivePane: (i) => {
        paneRef.v = i;
      },
      config,
      isVirtualCwd,
    });

  test("restoreSession off by config flag: state untouched", () => {
    const a = mkState("/a");
    const b = mkState("/b");
    const models = mkModels(a, b);
    const { restoreSession } = mkCtx(models, { v: 0 }, { ui: { restoreSession: false } });
    restoreSession();
    expect(a.history).toEqual(["/a"]);
    expect(models[0]!.list.length).toBe(1);
  });

  test("restoreSession adopts both panes' tabs (ref identity) and the active pane", () => {
    const stateDir = mkdtempSync(path.join(os.tmpdir(), "tfm-sess-"));
    const dir = mkdtempSync(path.join(os.tmpdir(), "tfm-sess-cwd-"));
    process.env.XDG_STATE_HOME = stateDir;
    try {
      mkdirSync(path.join(stateDir, "tfm"), { recursive: true });
      writeFileSync(
        path.join(stateDir, "tfm", "session.json"),
        JSON.stringify({
          panes: [
            { tabs: [{ history: [dir], histIdx: 0 }], activeTab: 0 },
            { tabs: [{ history: [os.tmpdir()], histIdx: 0 }], activeTab: 0 },
          ],
          activePane: 1,
        }),
      );
      const a = mkState("/a");
      const b = mkState("/b");
      const models = mkModels(a, b);
      const paneRef: { v: 0 | 1 } = { v: 0 };
      const { restoreSession } = mkCtx(models, paneRef, { ui: { restoreSession: true, dualPane: true } });
      restoreSession();
      expect(a.history).toBe(models[0]!.list[0]!.history);
      expect(a.history).toEqual([dir]);
      expect(b.history).toEqual([os.tmpdir()]);
      expect(paneRef.v).toBe(1);
    } finally {
      delete process.env.XDG_STATE_HOME;
    }
  });

  test("restoreSession clamps pane 1 to pane 0 when dual pane is off", () => {
    const stateDir = mkdtempSync(path.join(os.tmpdir(), "tfm-sess-clamp-"));
    const dir = mkdtempSync(path.join(os.tmpdir(), "tfm-sess-clamp-cwd-"));
    process.env.XDG_STATE_HOME = stateDir;
    try {
      mkdirSync(path.join(stateDir, "tfm"), { recursive: true });
      writeFileSync(
        path.join(stateDir, "tfm", "session.json"),
        JSON.stringify({
          panes: [
            { tabs: [{ history: [dir], histIdx: 0 }], activeTab: 0 },
            { tabs: [{ history: [dir], histIdx: 0 }], activeTab: 0 },
          ],
          activePane: 1,
        }),
      );
      const models = mkModels(mkState("/a"), mkState("/b"));
      const paneRef: { v: 0 | 1 } = { v: 1 };
      const { restoreSession } = mkCtx(models, paneRef, { ui: { restoreSession: true, dualPane: false } });
      restoreSession();
      expect(paneRef.v).toBe(0);
    } finally {
      delete process.env.XDG_STATE_HOME;
    }
  });

  test("scheduleSaveSession writes both pane tab lists after the debounce window", async () => {
    const stateDir = mkdtempSync(path.join(os.tmpdir(), "tfm-sess-save-"));
    process.env.XDG_STATE_HOME = stateDir;
    try {
      const models = mkModels(mkState("/a"), mkState("/b"));
      const { scheduleSaveSession } = mkCtx(models, { v: 0 }, { ui: { restoreSession: false } });
      scheduleSaveSession();
      const file = path.join(stateDir, "tfm", "session.json");
      await settleUntil(() => {
        try {
          const doc = JSON.parse(require("node:fs").readFileSync(file, "utf8"));
          return doc.panes[0].tabs[0].history[0] === "/a" && doc.panes[1].tabs[0].history[0] === "/b";
        } catch {
          return false;
        }
      });
    } finally {
      delete process.env.XDG_STATE_HOME;
    }
  });

  test("scheduleSaveSession skips virtual cwds", async () => {
    const stateDir = mkdtempSync(path.join(os.tmpdir(), "tfm-sess-virt-"));
    process.env.XDG_STATE_HOME = stateDir;
    try {
      const models = mkModels(mkState("recent://"), mkState("recent://"));
      const { scheduleSaveSession } = mkCtx(models, { v: 0 }, { ui: { restoreSession: false } }, () => true);
      scheduleSaveSession();
      await new Promise((r) => setTimeout(r, 550));
      let threw = false;
      try {
        require("node:fs").statSync(path.join(stateDir, "tfm", "session.json"));
      } catch {
        threw = true;
      }
      expect(threw).toBe(true);
    } finally {
      delete process.env.XDG_STATE_HOME;
    }
  });
});

describe("initialAppState", () => {
  test("the start dir is its own one-entry history", () => {
    const st = initialAppState({ ui: { showHidden: false } } as any, "/start/dir");
    expect(st.cwd).toBe("/start/dir");
    expect(st.history).toEqual(["/start/dir"]);
    expect(st.histIdx).toBe(0);
  });

  test("sort defaults to name-ascending", () => {
    const st = initialAppState({ ui: { showHidden: false } } as any, "/x");
    expect(st.sortBy).toBe("name");
    expect(st.sortAsc).toBe(true);
  });

  test("showHidden seeds from config", () => {
    expect(initialAppState({ ui: { showHidden: true } } as any, "/x").showHidden).toBe(true);
    expect(initialAppState({ ui: { showHidden: false } } as any, "/x").showHidden).toBe(false);
  });

  test("cwd defaults to the process dir", () => {
    expect(initialAppState({ ui: { showHidden: false } } as any).cwd).toBe(process.cwd());
  });

  test("pendingSelect seeds from the launch file (null by default)", () => {
    expect(initialAppState({ ui: { showHidden: false } } as any, "/x").pendingSelect).toBeNull();
    expect(initialAppState({ ui: { showHidden: false } } as any, "/x", "/x/pick.txt").pendingSelect).toBe(
      "/x/pick.txt",
    );
  });
});
