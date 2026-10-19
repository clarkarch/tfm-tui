import { describe, expect, test } from "bun:test";
import { planShowFolders, planShowItems } from "./filemanager1";

// Pure FileManager1 call planner: D-Bus URIs -> per-directory open plans.
// The daemon (src/app/filemanager-service.ts) opens one tfm per plan; the
// file-launch path (index.ts pendingSelect) highlights the file. URIs decode
// through the shared lenient fileUriToPath — never a new decoder.

describe("planShowItems", () => {
  test("a file highlights inside its parent dir", () => {
    expect(planShowItems(["file:///home/u/some%20dir/a.txt"])).toEqual([
      { dir: "/home/u/some dir", select: "/home/u/some dir/a.txt" },
    ]);
  });

  test("files group by parent; first file per dir is the highlight", () => {
    expect(planShowItems(["file:///a/1.txt", "file:///a/2.txt", "file:///b/3.txt"])).toEqual([
      { dir: "/a", select: "/a/1.txt" },
      { dir: "/b", select: "/b/3.txt" },
    ]);
  });

  test("a directory URI (trailing slash) opens with no highlight", () => {
    expect(planShowItems(["file:///home/u/docs/"])).toEqual([{ dir: "/home/u/docs", select: null }]);
  });

  test("non-file schemes and garbage are dropped, never crash the daemon", () => {
    expect(planShowItems(["https://example.invalid/x", "garbage", ""])).toEqual([]);
    expect(planShowItems([])).toEqual([]);
  });

  test("file://host/path strips the host (external payloads carry one)", () => {
    expect(planShowItems(["file://localhost/tmp/z"])).toEqual([{ dir: "/tmp", select: "/tmp/z" }]);
  });
});

describe("planShowFolders", () => {
  test("folders open as-is; files degrade to their parent (a folder view can't highlight)", () => {
    expect(planShowFolders(["file:///home/u/docs", "file:///home/u/docs/a.txt"])).toEqual([
      { dir: "/home/u/docs", select: null },
    ]);
  });

  test("non-file URIs are dropped", () => {
    expect(planShowFolders(["https://example.invalid/x"])).toEqual([]);
  });
});
