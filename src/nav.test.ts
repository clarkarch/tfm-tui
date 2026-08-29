import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { makeNav, makeSessionSync, type AppState } from "./nav";
import { makeTabs } from "./tabs";
import { RECENT_URI } from "./uri";

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
});

describe("makeSessionSync", () => {
  test("restoreSession off by config flag: state untouched", () => {
    const st = mkState("/a");
    const tabs = makeTabs(st, { onChanged() {}, status() {}, quit() {} });
    const { restoreSession } = makeSessionSync({
      state: st,
      tabModel: tabs,
      config: { ui: { restoreSession: false } } as any,
      isVirtualCwd: () => false,
    });
    restoreSession();
    expect(st.history).toEqual(["/a"]);
    expect(tabs.list.length).toBe(1);
  });

  test("restoreSession adopts saved tabs (ref identity with the model)", async () => {
    const stateDir = mkdtempSync(path.join(os.tmpdir(), "tfm-sess-"));
    const dir = mkdtempSync(path.join(os.tmpdir(), "tfm-sess-cwd-"));
    process.env.XDG_STATE_HOME = stateDir;
    try {
      mkdirSync(path.join(stateDir, "tfm"), { recursive: true });
      writeFileSync(
        path.join(stateDir, "tfm", "session.json"),
        JSON.stringify({ cwd: dir, tabs: [{ history: [dir], histIdx: 0 }], activeTab: 0 }),
      );
      const st = mkState("/a");
      const tabs = makeTabs(st, { onChanged() {}, status() {}, quit() {} });
      const { restoreSession } = makeSessionSync({
        state: st,
        tabModel: tabs,
        config: { ui: { restoreSession: true } } as any,
        isVirtualCwd: () => false,
      });
      restoreSession();
      expect(st.history).toBe(tabs.list[0]!.history);
      expect(st.history).toEqual([dir]);
    } finally {
      delete process.env.XDG_STATE_HOME;
    }
  });

  test("scheduleSaveSession writes the session file after the debounce window", async () => {
    const stateDir = mkdtempSync(path.join(os.tmpdir(), "tfm-sess-save-"));
    process.env.XDG_STATE_HOME = stateDir;
    try {
      const st = mkState("/a");
      const tabs = makeTabs(st, { onChanged() {}, status() {}, quit() {} });
      const { scheduleSaveSession } = makeSessionSync({
        state: st,
        tabModel: tabs,
        config: { ui: { restoreSession: false } } as any,
        isVirtualCwd: () => false,
      });
      scheduleSaveSession();
      const file = path.join(stateDir, "tfm", "session.json");
      await settleUntil(() => {
        try { return JSON.parse(require("node:fs").readFileSync(file, "utf8")).cwd === "/a"; } catch { return false; }
      });
    } finally {
      delete process.env.XDG_STATE_HOME;
    }
  });

  test("scheduleSaveSession skips virtual cwds", async () => {
    const stateDir = mkdtempSync(path.join(os.tmpdir(), "tfm-sess-virt-"));
    process.env.XDG_STATE_HOME = stateDir;
    try {
      const st = mkState("recent://");
      const tabs = makeTabs(st, { onChanged() {}, status() {}, quit() {} });
      const { scheduleSaveSession } = makeSessionSync({
        state: st,
        tabModel: tabs,
        config: { ui: { restoreSession: false } } as any,
        isVirtualCwd: () => true,
      });
      scheduleSaveSession();
      await new Promise((r) => setTimeout(r, 550));
      let threw = false;
      try { require("node:fs").statSync(path.join(stateDir, "tfm", "session.json")); } catch { threw = true; }
      expect(threw).toBe(true);
    } finally {
      delete process.env.XDG_STATE_HOME;
    }
  });
});
