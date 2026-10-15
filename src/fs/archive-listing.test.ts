import { describe, expect, test } from "bun:test";
import type { ArchiveRun } from "./archive";
import { archiveUri } from "./archive-scheme";
import { listArchiveDir } from "./archive-listing";

// every tool present → the spawn lane (the only lane that can list)
const whichAll = (): string => "/usr/bin/tool";

// a run that ignores argv and replays canned listing lines (the real parser is
// what's under test, so we only decide WHAT the tool would print)
const runReplaying =
  (lines: string[], code = 0): ArchiveRun =>
  async (_spec, opts) => {
    for (const l of lines) opts?.onLine?.(l);
    return { code, stdout: "", stderr: "" };
  };

const names = (rows: Awaited<ReturnType<typeof listArchiveDir>>): string[] => rows.map((r) => r.name);
const find = (rows: Awaited<ReturnType<typeof listArchiveDir>>, n: string) => rows.find((r) => r.name === n);

describe("listArchiveDir (tar lane)", () => {
  const TAR_LINES = ["a.txt", "dir/", "dir/b.txt", "dir/sub/", "dir/sub/c.txt"];

  test("lists only the top level, dirs from trailing slash", async () => {
    const rows = await listArchiveDir(archiveUri("/tmp/x.tar.gz"), {
      run: runReplaying(TAR_LINES),
      which: whichAll,
    });
    expect(names(rows).sort()).toEqual(["a.txt", "dir"]);
    expect(find(rows, "dir")?.isDir).toBe(true);
    expect(find(rows, "a.txt")?.isDir).toBe(false);
  });

  test("abs URIs point at the member, so a dir tile navigates deeper", async () => {
    const rows = await listArchiveDir(archiveUri("/tmp/x.tar.gz"), {
      run: runReplaying(TAR_LINES),
      which: whichAll,
    });
    expect(find(rows, "dir")?.abs).toBe(archiveUri("/tmp/x.tar.gz", "dir"));
  });

  test("an inner cwd shows just that subtree", async () => {
    const rows = await listArchiveDir(archiveUri("/tmp/x.tar.gz", "dir"), {
      run: runReplaying(TAR_LINES),
      which: whichAll,
    });
    expect(names(rows).sort()).toEqual(["b.txt", "sub"]);
    expect(find(rows, "sub")?.abs).toBe(archiveUri("/tmp/x.tar.gz", "dir/sub"));
  });

  test("looks up members relative to the archive root, not the inner cwd", async () => {
    const rows = await listArchiveDir(archiveUri("/tmp/x.tar.gz", "dir/sub"), {
      run: runReplaying(TAR_LINES),
      which: whichAll,
    });
    expect(names(rows)).toEqual(["c.txt"]);
  });
});

describe("listArchiveDir (zip lane)", () => {
  test("parses unzip -Z1 names", async () => {
    const rows = await listArchiveDir(archiveUri("/tmp/x.zip"), {
      run: runReplaying(["readme.md", "src/", "src/index.ts"]),
      which: whichAll,
    });
    expect(names(rows).sort()).toEqual(["readme.md", "src"]);
    expect(find(rows, "src")?.isDir).toBe(true);
  });
});

describe("listArchiveDir (7z -slt lane)", () => {
  const SLT = [
    "",
    "7-Zip 26.03 (x64) : Copyright",
    "Listing archive: /tmp/x.7z",
    "--",
    "Path = /tmp/x.7z",
    "Type = 7z",
    "----------",
    "Path = dir",
    "Size = 0",
    "Attributes = D drwxr-xr-x",
    "Path = a.txt",
    "Size = 6",
    "Attributes = A -rw-r--r--",
    "Path = dir/b.txt",
    "Size = 6",
    "Attributes = A -rw-r--r--",
  ];

  test("skips the archive's own header block", async () => {
    const rows = await listArchiveDir(archiveUri("/tmp/x.7z"), {
      run: runReplaying(SLT),
      which: whichAll,
    });
    expect(names(rows).sort()).toEqual(["a.txt", "dir"]);
    expect(find(rows, "dir")?.isDir).toBe(true);
    // size rides the member row (7z gives it)
    expect(find(rows, "a.txt")?.size).toBe(6);
  });
});

describe("listArchiveDir failure modes", () => {
  test("a tool failure is an error, never a fake empty listing", async () => {
    await expect(
      listArchiveDir(archiveUri("/tmp/x.tar.gz"), { run: runReplaying([], 2), which: whichAll }),
    ).rejects.toThrow("can't list");
  });

  test("no tar/unzip/7z to list with (js lane) reports honestly", async () => {
    await expect(
      listArchiveDir(archiveUri("/tmp/x.tar.gz"), { run: runReplaying([]), which: () => null }),
    ).rejects.toThrow("no tar/unzip/7z");
  });

  test("a non-archive path is rejected", async () => {
    await expect(listArchiveDir(archiveUri("/tmp/x.txt"), { which: whichAll })).rejects.toThrow("not an archive");
  });
});
