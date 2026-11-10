import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { lstatSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fdArgs, fdOutcomeFor, parseSearchPaths, searchTree } from "./search";
import type { FdOutcome } from "./search";

// Recursive type-to-search backend: fd fast path (injectable runner) with a
// built-in readdir walk fallback. Real temp trees for the fs paths; the fd
// output is faked so no binary is required.

const mktmp = (prefix: string): string => mkdtempSync(path.join(os.tmpdir(), prefix));
const W = (p: string, s = "x") => {
  mkdirSync(path.dirname(p), { recursive: true });
  writeFileSync(p, s);
};

let dir: string;
beforeEach(() => {
  dir = mktmp("tfm-search-");
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("parseSearchPaths", () => {
  test("splits CRLF/LF, trims, drops blank lines", () => {
    expect(parseSearchPaths("/a\n/b\r\n\n  /c  \n")).toEqual(["/a", "/b", "/c"]);
  });

  test("empty output is an empty list", () => {
    expect(parseSearchPaths("")).toEqual([]);
  });
});

describe("fdArgs", () => {
  test("fixed-string, case-insensitive, absolute, capped; hidden only when asked", () => {
    const a = fdArgs("bar", false, 50);
    expect(a).toContain("--fixed-strings");
    expect(a).toContain("--ignore-case");
    expect(a).toContain("--absolute-path");
    expect(a).toContain("--max-results");
    expect(a).toContain("50");
    expect(a).not.toContain("--hidden");
    expect(a.at(-1)).toBe("bar");
    expect(a.at(-2)).toBe("--"); // query is never parsed as an option
    expect(fdArgs("bar", true, 50)).toContain("--hidden");
  });
});

describe("fdOutcomeFor", () => {
  test("the exit code decides the outcome (no matches is a valid answer)", () => {
    // fd exits 1 on "no matches" — that is a SUCCESSFUL answer (the walk must
    // NOT take over); 2+ is a real error (bad dir, permission) and the walk
    // takes over.
    expect(fdOutcomeFor(1, "", false)).toEqual({ ok: true, paths: [] });
    expect(fdOutcomeFor(0, "/a\n/b\n", false)).toEqual({ ok: true, paths: ["/a", "/b"] });
    expect(fdOutcomeFor(2, "", false)).toEqual({ ok: false, reason: "failed" });
  });

  test("an abort is neither a match nor a failure", () => {
    // the abort WINS over the exit code: the caller abandoned the search, so
    // its answer is void — reporting it as "no matches" would be a silently
    // empty result set.
    expect(fdOutcomeFor(0, "/a\n", true)).toEqual({ ok: false, reason: "aborted" });
    expect(fdOutcomeFor(143, "", true)).toEqual({ ok: false, reason: "aborted" });
  });
});

describe("searchTree", () => {
  test("fd path: maps output to relative-name entries with isDir from stat", async () => {
    W(path.join(dir, "sub", "bar.txt"));
    mkdirSync(path.join(dir, "sub", "bardir"));
    const runner = async (_bin: string, args: string[], cwd: string): Promise<FdOutcome> => {
      expect(args.at(-1)).toBe("bar");
      expect(cwd).toBe(dir);
      return { ok: true, paths: [path.join(dir, "sub", "bar.txt"), path.join(dir, "sub", "bardir")] };
    };
    const entries = await searchTree(dir, "bar", { fdBin: "fd", runFd: runner });
    const byName = Object.fromEntries(entries.map((e) => [e.name, e]));
    expect(byName["sub/bar.txt"]!.isDir).toBe(false);
    expect(byName["sub/bardir"]!.isDir).toBe(true);
    expect(entries.every((e) => e.abs)).toBe(true);
  });

  test("fd exits with no matches → empty result, no fallback walk", async () => {
    W(path.join(dir, "sub", "bar.txt"));
    let calls = 0;
    const entries = await searchTree(dir, "bar", {
      fdBin: "fd",
      runFd: async () => {
        calls++;
        // an empty path list is "no matches" — a VALID answer, and the walk
        // must NOT take over (a matching file exists on disk)
        return { ok: true, paths: [] };
      },
    });
    expect(entries).toEqual([]);
    expect(calls).toBe(1);
  });

  test("fd failure falls back to the built-in walk", async () => {
    W(path.join(dir, "sub", "bar.txt"));
    const entries = await searchTree(dir, "bar", {
      fdBin: "fd",
      runFd: async () => ({ ok: false, reason: "failed" }),
    });
    expect(entries.map((e) => e.name)).toContain("sub/bar.txt");
  });

  test("an aborted fd search is not reported as no matches", async () => {
    // a matching file exists, so a search that FELL BACK to the walk would
    // find it — the abort must win: no results, and NO walk fallback (the
    // caller abandoned the search; walking the tree would burn CPU on a
    // superseded search).
    W(path.join(dir, "bar.txt"));
    const entries = await searchTree(dir, "bar", {
      fdBin: "fd",
      runFd: async () => ({ ok: false, reason: "aborted" }),
    });
    expect(entries).toEqual([]);
  });

  test("a search abandoned AFTER fd answered yields no results", async () => {
    // the lane can answer a moment before the caller's abort lands — the
    // cancellation still wins over the answer (a stale result set would
    // repaint a folder the user already moved on from)
    W(path.join(dir, "bar.txt"));
    const ac = new AbortController();
    const entries = await searchTree(dir, "bar", {
      fdBin: "fd",
      signal: ac.signal,
      runFd: async (_bin, _args, _cwd, signal) => {
        expect(signal).toBe(ac.signal);
        ac.abort();
        return { ok: true, paths: [path.join(dir, "bar.txt")] };
      },
    });
    expect(entries).toEqual([]);
  });

  test("walk fallback: case-insensitive substring, nested dirs, cap", async () => {
    W(path.join(dir, "a", "BAR-one.txt"));
    W(path.join(dir, "a", "b", "bar-two.txt"));
    W(path.join(dir, "a", "b", "other.txt"));
    mkdirSync(path.join(dir, "bar-dir"));
    const all = await searchTree(dir, "bar", { fdBin: null, limit: 50 });
    const names = all.map((e) => e.name).sort();
    expect(names).toEqual(["a/BAR-one.txt", "a/b/bar-two.txt", "bar-dir"]);
    expect(all.find((e) => e.name === "bar-dir")!.isDir).toBe(true);

    const capped = await searchTree(dir, "bar", { fdBin: null, limit: 1 });
    expect(capped.length).toBe(1);
  });

  test("walk fallback marks links and sizes them by link bytes", async () => {
    W(path.join(dir, "target.txt"), "x".repeat(500));
    const link = path.join(dir, "alias.txt");
    symlinkSync(path.join(dir, "target.txt"), link);
    const entries = await searchTree(dir, "alias", { fdBin: null });
    const hit = entries.find((e) => e.name === "alias.txt");
    expect(hit?.isLink).toBe(true);
    expect(hit?.size).toBe(lstatSync(link).size);
  });

  test("walk fallback honors the hidden flag", async () => {
    W(path.join(dir, ".hidden-bar.txt"));
    expect(await searchTree(dir, "bar", { fdBin: null })).toEqual([]);
    const withHidden = await searchTree(dir, "bar", { fdBin: null, hidden: true });
    expect(withHidden.map((e) => e.name)).toContain(".hidden-bar.txt");
  });

  test("blank query is an empty search", async () => {
    W(path.join(dir, "bar.txt"));
    expect(await searchTree(dir, "   ", { fdBin: null })).toEqual([]);
  });

  test("an already-aborted signal short-circuits without spawning fd", async () => {
    W(path.join(dir, "bar.txt"));
    let calls = 0;
    const ac = new AbortController();
    ac.abort();
    const entries = await searchTree(dir, "bar", {
      fdBin: "fd",
      signal: ac.signal,
      runFd: async () => {
        calls++;
        return { ok: true, paths: [] };
      },
    });
    expect(entries).toEqual([]);
    expect(calls).toBe(0);
  });

  test("abort during fd yields no results and never throws", async () => {
    // a matching file exists, so a NON-aborted fd-failure would fall back and
    // find it (tested above); here the abort must win. Both the post-fd guard
    // and the walk's own abort check refuse the aborted signal — this pins the
    // end-to-end contract, not which of the two guards fires.
    W(path.join(dir, "bar.txt"));
    const ac = new AbortController();
    const entries = await searchTree(dir, "bar", {
      fdBin: "fd",
      signal: ac.signal,
      runFd: async (_bin, _args, _cwd, signal) => {
        // fd observes the abort and dies; the lane reports a failure, and the
        // caller's own cancellation still wins over it
        expect(signal).toBe(ac.signal);
        ac.abort();
        return { ok: false, reason: "failed" };
      },
    });
    expect(entries).toEqual([]);
  });
});
