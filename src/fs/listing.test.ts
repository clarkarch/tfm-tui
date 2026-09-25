import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { compareEntries, fillStatsInto, listDir, type Entry } from "./listing";
import { extOf } from "./filetype";
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

  // the shared-collator/memo refactor must be order-identical to plain
  // per-call localeCompare — a stray collator option (numeric, caseFirst)
  // or a broken memo key would flip one of these pairs
  test("name/type sorts match plain localeCompare semantics on tricky names", () => {
    const names = [
      "README",
      "config.toml",
      "archive.zip",
      "Image2.png",
      "image10.png",
      "café.txt",
      "cafe.txt",
      "Zebra.tar.gz",
      "a-b.ts",
      "a_b.ts",
      "2.txt",
      "10.txt",
    ];
    const legacyName = (a: Entry, b: Entry): number => a.name.localeCompare(b.name);
    const legacyType = (a: Entry, b: Entry): number =>
      extOf(a.name).localeCompare(extOf(b.name)) || a.name.localeCompare(b.name);
    const ref =
      (cmp: (a: Entry, b: Entry) => number, asc: boolean) =>
      (a: Entry, b: Entry): number =>
        Number(b.isDir) - Number(a.isDir) || (asc ? cmp(a, b) : -cmp(a, b));
    for (const asc of [true, false]) {
      const mk = (): Entry[] => names.map((n) => e(n)).concat([e("some-dir", true)]);
      expect(
        mk()
          .sort(compareEntries("name", asc))
          .map((x) => x.name),
      ).toEqual(
        mk()
          .sort(ref(legacyName, asc))
          .map((x) => x.name),
      );
      expect(
        mk()
          .sort(compareEntries("type", asc))
          .map((x) => x.name),
      ).toEqual(
        mk()
          .sort(ref(legacyType, asc))
          .map((x) => x.name),
      );
    }
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

// [ui] listings-cache (src/fs/listing.ts): a folder's raw scan is reused while
// its dir-mtime signature is unchanged, with a ~2s TTL as the backstop for
// filesystems whose dir mtimes freeze (some fuse/exFAT mounts). Tests simulate
// a frozen mount by utimes-ing the dir BACK to a round-numbered timestamp —
// exact under the s→ns round-trip, unlike restoring a real mtimeMs float.
describe("listings cache", () => {
  const FROZEN = 1700000000; // integer seconds → exact mtimeMs
  const T0 = () => 0;

  // dir with a.txt, first (caching) list, then b.txt added and the dir mtime
  // rewound — a real "soundless" filesystem where no rescan trigger exists
  const frozenDir = async (): Promise<string> => {
    const dir = mktmp("tfm-lc-");
    W(path.join(dir, "a.txt"));
    utimesSync(dir, FROZEN, FROZEN);
    await listDir(dir, false, "name", true, { now: T0 });
    W(path.join(dir, "b.txt"));
    utimesSync(dir, FROZEN, FROZEN);
    return dir;
  };

  test("frozen dir mtime reuses the cached listing (no rescan trigger exists)", async () => {
    const dir = await frozenDir();
    try {
      const out = await listDir(dir, false, "name", true, { now: T0 });
      expect(out.map((x) => x.name)).toEqual(["a.txt"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("TTL expiry re-reads even a frozen dir", async () => {
    const dir = await frozenDir();
    try {
      // 3s on a virtual clock = past the 2s window, no sleep needed
      const out = await listDir(dir, false, "name", true, { now: () => 3000 });
      expect(out.map((x) => x.name)).toEqual(["a.txt", "b.txt"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("cache:false bypasses the reuse entirely", async () => {
    const dir = await frozenDir();
    try {
      const out = await listDir(dir, false, "name", true, { cache: false, now: T0 });
      expect(out.map((x) => x.name)).toEqual(["a.txt", "b.txt"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // listings-cache-stats OFF: the per-call fill loop keeps stats live — the
  // exact mode that justifies shipping WITHOUT yazi's per-file watcher patch
  test("with listings-cache-stats off, a cache hit still re-stats size/mtime", async () => {
    const dir = mktmp("tfm-lc2-");
    try {
      const a = path.join(dir, "a.txt");
      const b = path.join(dir, "b.txt");
      W(a, "x".repeat(100));
      W(b, "y");
      utimesSync(dir, FROZEN, FROZEN);
      await listDir(dir, false, "size", true, { now: T0, cacheStats: false }); // prime
      rmSync(a); // vanish a name…
      writeFileSync(b, "x".repeat(500)); // …and content-edit another in place…
      utimesSync(dir, FROZEN, FROZEN); // …on a "soundless" mount: mtime rewound
      const out = await listDir(dir, false, "size", true, { now: T0, cacheStats: false });
      // a vanished name still listed ⇒ the CACHED scan was served (a rescan
      // would drop it) — without this the fill assertion passes vacuously.
      expect(out.map((x) => x.name)).toContain("a.txt");
      // …yet the stat-fill re-stats per call, so the live file's size is fresh
      expect(out.find((x) => x.name === "b.txt")?.size).toBe(500);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // listings-cache-stats ON (the default): sizes/dates ride in the cache and
  // only refresh on a rescan — the staleness the speed is bought with. The
  // name-sort prime pins the HIT-PATH fill too: a size sort on a cached
  // raw listing must fill the cache itself, not just fresh scans.
  test("with listings-cache-stats on, sizes lag a live edit until the TTL rescan", async () => {
    const dir = mktmp("tfm-lc4-");
    try {
      const f = path.join(dir, "a.txt");
      W(f, "x".repeat(500));
      await listDir(dir, false, "name", true, { now: T0 }); // caches NO stats
      const warm = await listDir(dir, false, "size", true, { now: () => 500 });
      expect(warm[0]!.size).toBe(500); // size sort on a cache HIT fills the cache
      writeFileSync(f, "x".repeat(900)); // in-place edit: dir mtime untouched
      const stale = await listDir(dir, false, "size", true, { now: () => 1000 });
      expect(stale[0]!.size).toBe(500); // next hit serves the cached stat…
      const aged = await listDir(dir, false, "size", true, { now: () => 3000 });
      expect(aged[0]!.size).toBe(900); // …TTL expiry re-scans and re-stats
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("[ui] listings-cache-ttl overrides the default window", async () => {
    const dir = mktmp("tfm-lc5-");
    try {
      const f = path.join(dir, "a.txt");
      W(f, "x".repeat(100));
      await listDir(dir, false, "size", true, { now: T0 });
      writeFileSync(f, "x".repeat(500));
      // 100ms on the virtual clock is inside the default 2s window…
      expect((await listDir(dir, false, "size", true, { now: () => 100 }))[0]!.size).toBe(100);
      // …but expired at the requested 50ms
      const out = await listDir(dir, false, "size", true, { now: () => 100, ttlMs: 50 });
      expect(out[0]!.size).toBe(500);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // fillStatsInto: the grid's list view needs sizes/dates whatever the sort
  // is. It used to run a blocking statSync loop, which froze the whole app
  // (render, frame loop, toast spinner) on a big folder — and tty mode forces
  // list view. Same data, same freshness (nothing cached), but it yields.
  test("fills missing rows through the injected stat and skips complete ones", async () => {
    const entries: Entry[] = [
      { name: "a", isDir: false, size: 1, mtimeMs: 2 },
      { name: "b", isDir: false },
      { name: "c", isDir: false },
    ];
    const asked: string[] = [];
    await fillStatsInto(entries, "/base", {
      stat: async (p) => {
        asked.push(p);
        return { size: p.endsWith("/b") ? 10 : 20, mtimeMs: 7 };
      },
    });
    expect(asked).toEqual(["/base/b", "/base/c"]); // already-complete row untouched
    expect(entries[0]!.size).toBe(1);
    expect(entries[1]!.size).toBe(10);
    expect(entries[2]!.size).toBe(20);
    expect(entries[1]!.mtimeMs).toBe(7);
  });

  test("awaits every stat under a concurrency cap (the frame loop keeps running)", async () => {
    let inFlight = 0;
    let peak = 0;
    let resolved = 0;
    const releasers: Array<() => void> = [];
    const entries: Entry[] = Array.from({ length: 40 }, (_, i) => ({ name: `f${i}`, isDir: false }));
    const fill = fillStatsInto(entries, "/x", {
      concurrency: 4,
      stat: () =>
        new Promise<{ size: number; mtimeMs: number }>((res) => {
          inFlight++;
          peak = Math.max(peak, inFlight);
          releasers.push(() => {
            inFlight--;
            resolved++;
            res({ size: 1, mtimeMs: 1 });
          });
        }),
    });
    await Bun.sleep(0);
    // nothing has landed: the fill really owes its progress to the stat
    // promises, so the caller keeps painting while it walks the rows
    expect(resolved).toBe(0);
    expect(peak).toBeLessThanOrEqual(4);
    for (let i = 0; i < 40; i++) {
      releasers.shift()?.();
      await Bun.sleep(0);
    }
    await fill;
    expect(entries.every((e) => e.size === 1 && e.mtimeMs === 1)).toBe(true);
    expect(peak).toBeLessThanOrEqual(4);
  });

  test("a vanished row stays statless instead of throwing", async () => {
    const entries: Entry[] = [{ name: "gone", isDir: false }];
    await fillStatsInto(entries, "/x", {
      stat: async () => {
        throw new Error("ENOENT");
      },
    });
    expect(entries[0]!.size).toBeUndefined();
  });

  test("real mtime bump re-scans within the TTL", async () => {
    const dir = mktmp("tfm-lc3-");
    try {
      W(path.join(dir, "a.txt"));
      utimesSync(dir, FROZEN, FROZEN);
      await listDir(dir, false, "name", true, { now: T0 });
      // no rewind this time: the mtime really moved. The fallback covers
      // filesystems that NEVER bump the dir mtime (the frozen-mount class) —
      // then it synthesizes the bump so sig-mismatch → rescan still gets pinned
      W(path.join(dir, "b.txt"));
      if (statSync(dir).mtimeMs === FROZEN * 1000) utimesSync(dir, FROZEN + 0.5, FROZEN + 0.5);
      const out = await listDir(dir, false, "name", true, { now: () => 1 });
      expect(out.map((x) => x.name)).toEqual(["a.txt", "b.txt"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
