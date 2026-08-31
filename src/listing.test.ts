import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { compareEntries, extOf, listDir, type Entry } from "./listing";
import { RECENT_URI, STARRED_URI } from "./uri";

// mkdtemp only creates the last segment — the parent must be a dir that
// exists everywhere (CI runners choke on a hardcoded /tmp/opencode)
const mktmp = (prefix: string): string => mkdtempSync(path.join(os.tmpdir(), prefix));

// listing reads the two registries via xdgDataHome()/xdgStateHome(), which
// re-read the env on every call — redirect both to keep the test sandboxed.
const SANDBOX = mktmp("tfm-listing-");
let oldData: string | undefined;
let oldState: string | undefined;

const W = (p: string, s = "x") => {
  mkdirSync(path.dirname(p), { recursive: true });
  writeFileSync(p, s);
};

beforeAll(() => {
  oldData = process.env.XDG_DATA_HOME;
  oldState = process.env.XDG_STATE_HOME;
  process.env.XDG_DATA_HOME = path.join(SANDBOX, "data");
  process.env.XDG_STATE_HOME = path.join(SANDBOX, "state");
});

afterAll(() => {
  if (oldData === undefined) delete process.env.XDG_DATA_HOME;
  else process.env.XDG_DATA_HOME = oldData;
  if (oldState === undefined) delete process.env.XDG_STATE_HOME;
  else process.env.XDG_STATE_HOME = oldState;
  rmSync(SANDBOX, { recursive: true, force: true });
});

describe("extOf", () => {
  test("lowercases and handles dotfiles / no-ext / multi-dot", () => {
    expect(extOf("Photo.JPG")).toBe("jpg");
    expect(extOf("archive.tar.gz")).toBe("gz");
    expect(extOf("Makefile")).toBe("");
    expect(extOf(".hidden")).toBe(""); // leading dot = no ext
    expect(extOf(".config.toml")).toBe("toml");
  });
});

describe("compareEntries", () => {
  const e = (name: string, isDir = false, size?: number, mtimeMs?: number): Entry => ({ name, isDir, size, mtimeMs });

  test("dirs sort first regardless of mode or direction", () => {
    const cmp = compareEntries("name", false);
    const list = [e("z.txt"), e("dir", true), e("a.txt")].sort(cmp);
    expect(list[0]!.name).toBe("dir");
  });

  test("name asc/desc", () => {
    const list = [e("b"), e("a"), e("c")];
    expect([...list].sort(compareEntries("name", true)).map((x) => x.name)).toEqual(["a", "b", "c"]);
    expect([...list].sort(compareEntries("name", false)).map((x) => x.name)).toEqual(["c", "b", "a"]);
  });

  test("size falls back to 0 for unknown", () => {
    const list = [e("big", false, 100), e("unknown"), e("small", false, 5)];
    expect([...list].sort(compareEntries("size", true)).map((x) => x.name)).toEqual(["unknown", "small", "big"]);
  });

  test("mtime ordering", () => {
    const list = [e("old", false, undefined, 100), e("new", false, undefined, 900)];
    expect([...list].sort(compareEntries("mtime", true)).map((x) => x.name)).toEqual(["old", "new"]);
  });

  test("type compares extension then name", () => {
    const list = [e("b.txt"), e("a.md"), e("a.txt")];
    expect([...list].sort(compareEntries("type", true)).map((x) => x.name)).toEqual(["a.md", "a.txt", "b.txt"]);
  });
});

describe("listDir", () => {
  test("hidden filtering, symlink-as-dir, dirs-first name sort", async () => {
    const dir = mktmp("tfm-ld-");
    try {
      W(path.join(dir, "zed.txt"));
      W(path.join(dir, ".hidden"));
      mkdirSync(path.join(dir, "sub"));
      mkdirSync(path.join(dir, "target"));
      symlinkSync(path.join(dir, "target"), path.join(dir, "link"));
      symlinkSync(path.join(dir, "gone-nowhere"), path.join(dir, "broken"));

      const shown = await listDir(dir, false, "name", true);
      expect(shown.map((x) => x.name)).toEqual(["link", "sub", "target", "broken", "zed.txt"]);
      expect(shown.find((x) => x.name === "link")?.isDir).toBe(true);
      expect(shown.find((x) => x.name === "broken")?.isDir).toBe(false);
      expect(shown.find((x) => x.name === "sub")?.isDir).toBe(true);

      const withHidden = await listDir(dir, true, "name", true);
      expect(withHidden.map((x) => x.name)).toContain(".hidden");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("size sort stat-fills entries; desc flips within isDir groups", async () => {
    const dir = mktmp("tfm-ld2-");
    try {
      W(path.join(dir, "big.txt"), "x".repeat(1000));
      W(path.join(dir, "small.txt"), "x");
      const asc = await listDir(dir, false, "size", true);
      expect(asc.map((x) => x.name)).toEqual(["small.txt", "big.txt"]);
      const desc = await listDir(dir, false, "size", false);
      expect(desc.map((x) => x.name)).toEqual(["big.txt", "small.txt"]);
      expect(desc[0]!.size).toBe(1000);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("mtime sort uses real mtimes", async () => {
    const dir = mktmp("tfm-ld3-");
    try {
      W(path.join(dir, "old.txt"));
      W(path.join(dir, "new.txt"));
      const t = Date.now() / 1000;
      utimesSync(path.join(dir, "old.txt"), t - 100, t - 100);
      utimesSync(path.join(dir, "new.txt"), t, t);
      const out = await listDir(dir, false, "mtime", true);
      expect(out.map((x) => x.name)).toEqual(["old.txt", "new.txt"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("RECENT_URI: recency order wins over sort mode; vanished files dropped", async () => {
    const dataHome = process.env.XDG_DATA_HOME!;
    const keep = path.join(SANDBOX, "keep.txt");
    W(keep, "x");
    const gone = path.join(SANDBOX, "vanished.txt"); // never created
    W(
      path.join(dataHome, "recently-used.xbel"),
      `<?xml version="1.0" encoding="UTF-8"?>
<xbel version="1.0" xmlns:bookmark="http://www.freedesktop.org/standards/desktop-bookmarks">
  <bookmark href="file://${encodeURI(gone)}" added="2026-01-01T00:00:00Z" modified="2026-01-01T00:00:00Z" visited="2026-01-01T00:00:00Z"><info><metadata owner="http://freedesktop.org"><mime:mime-type type="text/plain"/><bookmark:applications><bookmark:application name="tfm" exec="&apos;tfm&apos;" modified="2026-01-01T00:00:00Z" count="1"/></bookmark:applications></metadata></info></bookmark>
  <bookmark href="file://${encodeURI(keep)}" added="2026-02-02T00:00:00Z" modified="2026-02-02T00:00:00Z" visited="2026-02-02T00:00:00Z"><info><metadata owner="http://freedesktop.org"><mime:mime-type type="text/plain"/><bookmark:applications><bookmark:application name="tfm" exec="&apos;tfm&apos;" modified="2026-02-02T00:00:00Z" count="1"/></bookmark:applications></metadata></info></bookmark>
</xbel>
`,
    );
    try {
      // sortBy=name asc would put "keep.txt" first by alphabet anyway — use
      // size asc to prove recency (newest first) overrides the sort mode
      const out = await listDir(RECENT_URI, false, "size", true);
      expect(out.map((x) => x.abs)).toEqual([keep]); // vanished dropped, newest first
    } finally {
      rmSync(path.join(dataHome, "recently-used.xbel"), { force: true });
    }
  });

  test("STARRED_URI: reads the tfm registry", async () => {
    const stateHome = process.env.XDG_STATE_HOME!;
    const a = path.join(SANDBOX, "a-star.txt");
    const b = path.join(SANDBOX, "b-star.txt");
    W(a);
    W(b);
    W(path.join(stateHome, "tfm", "starred.list"), `${a}\n${b}\n`);
    try {
      const out = await listDir(STARRED_URI, false, "name", true);
      expect(out.map((x) => x.name)).toEqual(["a-star.txt", "b-star.txt"]);
    } finally {
      rmSync(path.join(stateHome, "tfm", "starred.list"), { force: true });
    }
  });
});
