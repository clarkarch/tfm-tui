import { describe, expect, test } from "bun:test";
import { makeFileManagerService, SERVICE_NAME, SERVICE_PATH } from "./filemanager-service";

// Daemon contract (faked bus — no session bus needed): owns
// org.freedesktop.FileManager1, routes ShowItems/ShowFolders into per-dir
// open plans, degrades ShowItemProperties to highlight. Every URI batch is
// isolated: a throwing opener never takes the daemon down.

type Opened = { dir: string; select: string | null };

const harness = () => {
  const opened: Opened[] = [];
  const logged: string[] = [];
  const exported: string[] = [];
  const bus = {
    export: (_path: string, _iface: unknown) => exported.push(_path),
    requestName: async (_name: string, _flags: unknown) => 1 as const,
  };
  const svc = makeFileManagerService({
    bus: bus as never,
    openPlan: (plan: Opened) => opened.push(plan),
    log: (m: string) => logged.push(m),
  });
  return { opened, logged, exported, svc };
};

describe("makeFileManagerService", () => {
  test("exports the FileManager1 object path and owns the well-known name", async () => {
    const { exported, svc } = harness();
    expect(SERVICE_NAME).toBe("org.freedesktop.FileManager1");
    expect(SERVICE_PATH).toBe("/org/freedesktop/FileManager1");
    const code = await svc.start();
    expect(code).toBe(0);
    expect(exported).toEqual([SERVICE_PATH]);
  });

  test("a taken name exits 2 with an honest message (nautilus holds it)", async () => {
    const logged: string[] = [];
    const svc = makeFileManagerService({
      bus: { export: () => {}, requestName: async () => 3 } as never,
      openPlan: () => {},
      log: (m: string) => logged.push(m),
    });
    expect(await svc.start()).toBe(2);
    expect(logged.join("\n")).toMatch(/already owned|in use/i);
  });

  test("ShowItems opens one plan per dir with the highlight", () => {
    const { opened, svc } = harness();
    svc.showItems(["file:///a/1.txt", "file:///a/2.txt", "file:///b/3.txt"], "");
    expect(opened).toEqual([
      { dir: "/a", select: "/a/1.txt" },
      { dir: "/b", select: "/b/3.txt" },
    ]);
  });

  test("ShowFolders opens plain dirs; ShowItemProperties degrades to highlight", () => {
    const { opened, svc } = harness();
    svc.showFolders(["file:///home/u/docs/"], "");
    expect(opened).toEqual([{ dir: "/home/u/docs", select: null }]);
    svc.showItemProperties(["file:///a/1.txt"], "");
    expect(opened[1]).toEqual({ dir: "/a", select: "/a/1.txt" });
  });

  test("garbage batches open nothing and never throw (daemon survives)", () => {
    const { opened, logged, svc } = harness();
    expect(() => svc.showItems(["https://x/y", ""], "")).not.toThrow();
    expect(opened).toEqual([]);
    expect(logged.join("\n")).toContain("no local");
  });

  test("a throwing opener is isolated per plan (one bad dir keeps the rest)", () => {
    const opened: Opened[] = [];
    const logged: string[] = [];
    const svc = makeFileManagerService({
      bus: {} as never,
      openPlan: (plan: Opened) => {
        if (plan.dir === "/a") throw new Error("boom");
        opened.push(plan);
      },
      log: (m: string) => logged.push(m),
    });
    expect(() => svc.showItems(["file:///a/1.txt", "file:///b/3.txt"], "")).not.toThrow();
    expect(opened).toEqual([{ dir: "/b", select: "/b/3.txt" }]);
    expect(logged.join("\n")).toContain("boom");
  });
});
