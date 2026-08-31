import { beforeAll, afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { readRecentXbel, readStarredList, upsertRecentXbel, writeStarredList } from "./recent";

// xbelPath()/starredListPath() are computed per call from XDG env, so each
// test redirects both homes into a throwaway fixture dir.
const DATA = path.join(os.tmpdir(), `tfm-recent-test-${process.pid}/data`);
const STATE = path.join(os.tmpdir(), `tfm-recent-test-${process.pid}/state`);
let oldData: string | undefined;
let oldState: string | undefined;

beforeAll(() => {
  oldData = process.env.XDG_DATA_HOME;
  oldState = process.env.XDG_STATE_HOME;
  process.env.XDG_DATA_HOME = DATA;
  process.env.XDG_STATE_HOME = STATE;
  mkdirSync(DATA, { recursive: true });
  mkdirSync(STATE, { recursive: true });
});

afterAll(() => {
  if (oldData === undefined) delete process.env.XDG_DATA_HOME;
  else process.env.XDG_DATA_HOME = oldData;
  if (oldState === undefined) delete process.env.XDG_STATE_HOME;
  else process.env.XDG_STATE_HOME = oldState;
});

const XBEL = path.join(DATA, "recently-used.xbel");

const writeXbel = (body: string) =>
  writeFileSync(XBEL, `<?xml version="1.0" encoding="UTF-8"?>\n<xbel version="1.0">\n${body}\n</xbel>\n`, "utf8");

describe("readRecentXbel", () => {
  test("missing file yields empty list", () => {
    expect(readRecentXbel()).toEqual([]);
  });

  test("extracts file:// bookmarks newest-first, deduped, dropping foreign schemes", () => {
    writeXbel(`  <bookmark href="file:///a.txt" added="2026-01-01T00:00:00Z" modified="2026-01-03T00:00:00Z" visited="2026-01-01T00:00:00Z"/>
  <bookmark href="http://example.com" added="2026-01-02T00:00:00Z" modified="2026-01-04T00:00:00Z" visited="2026-01-02T00:00:00Z"/>
  <bookmark href="file:///b%20c.txt" added="2026-01-02T00:00:00Z" modified="2026-01-02T00:00:00Z" visited="2026-01-02T00:00:00Z"/>
  <bookmark href="file:///a.txt" added="2026-01-01T00:00:00Z" modified="2026-01-01T00:00:00Z" visited="2026-01-01T00:00:00Z"/>`);
    const items = readRecentXbel();
    expect(items.map((i) => i.path)).toEqual(["/a.txt", "/b c.txt"]);
    expect(items[0]!.modified).toBe(Date.parse("2026-01-03T00:00:00Z"));
    expect(items[1]!.modified).toBe(Date.parse("2026-01-02T00:00:00Z"));
  });

  test("unparseable timestamps fall back to 0 and sort last", () => {
    writeXbel(`  <bookmark href="file:///x.txt" added="x" modified="garbage" visited="x"/>
  <bookmark href="file:///y.txt" added="x" modified="2026-01-01T00:00:00Z" visited="x"/>`);
    const items = readRecentXbel();
    expect(items[0]!.path).toBe("/y.txt");
    expect(items[1]!.path).toBe("/x.txt");
    expect(items[1]!.modified).toBe(0);
  });
});

describe("upsertRecentXbel", () => {
  test("creates a valid document with tfm application metadata when none existed", async () => {
    await upsertRecentXbel(["/home/clark/new doc.txt"]);
    const xml = readFileSync(XBEL, "utf8");
    expect(xml).toContain('href="file:///home/clark/new%20doc.txt"');
    expect(xml).toContain('name="tfm"');
    expect(xml).toContain('exec="&apos;tfm&apos;"');
    expect(xml.trimEnd().endsWith("</xbel>")).toBe(true);
  });

  test("re-adding bumps count and moves to end, preserving other entries", async () => {
    writeXbel(`  <bookmark href="file:///kept.txt" added="2026-01-01T00:00:00Z" modified="2026-01-01T00:00:00Z" visited="2026-01-01T00:00:00Z">
    <info><metadata owner="http://freedesktop.org"><bookmark:applications><bookmark:application name="tfm" exec="&apos;tfm&apos;" modified="2026-01-01T00:00:00Z" count="2"/></bookmark:applications></metadata></info>
  </bookmark>`);
    await upsertRecentXbel(["/kept.txt"]);
    const xml = readFileSync(XBEL, "utf8");
    expect((xml.match(/file:\/\/\/kept\.txt/g) ?? []).length).toBe(1);
    expect(xml).toContain('count="3"');
    expect(xml).toContain('href="file:///kept.txt" added=');
  });

  test("caps the document at 500 entries", async () => {
    const many = Array.from({ length: 510 }, (_, i) => `/tmp/f-${i}.txt`);
    await upsertRecentXbel(many);
    const xml = readFileSync(XBEL, "utf8");
    expect((xml.match(/<bookmark /g) ?? []).length).toBe(500);
  });
});

describe("starred registry", () => {
  test("missing file yields empty list", () => {
    expect(readStarredList()).toEqual([]);
  });

  test("round-trips and dedupes", async () => {
    await writeStarredList(["/a", "/b"]);
    await writeStarredList([...readStarredList(), "/b", "/c"]);
    expect(readStarredList()).toEqual(["/a", "/b", "/c"]);
  });
});
