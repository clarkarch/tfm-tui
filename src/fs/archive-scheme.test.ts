import { describe, expect, test } from "bun:test";
import { ARCHIVE_URI, isVirtualUri } from "./uri";
import { archiveBrowseUri, archiveUri, isArchiveUri, parseArchiveUri } from "./archive-scheme";

describe("archiveUri / parseArchiveUri", () => {
  test("round-trips a plain archive path", () => {
    const uri = archiveUri("/home/clark/a b/c.zip");
    expect(uri).toBe(`${ARCHIVE_URI}${encodeURIComponent("/home/clark/a b/c.zip")}`);
    expect(parseArchiveUri(uri)).toEqual({ file: "/home/clark/a b/c.zip", inner: "" });
  });

  test("carries an inner directory after !/", () => {
    const uri = archiveUri("/tmp/t.tar.gz", "dir/sub");
    expect(parseArchiveUri(uri)).toEqual({ file: "/tmp/t.tar.gz", inner: "dir/sub" });
  });

  test("normalizes leading/trailing slashes on the inner path", () => {
    expect(parseArchiveUri(archiveUri("/tmp/t.zip", "/dir/"))).toEqual({ file: "/tmp/t.zip", inner: "dir" });
  });

  test("percent-sign in a filename survives the round-trip", () => {
    const p = "/tmp/100% done.zip";
    expect(parseArchiveUri(archiveUri(p))?.file).toBe(p);
  });

  test("rejects non-archive URIs and empty file parts", () => {
    expect(parseArchiveUri("recent://")).toBeNull();
    expect(parseArchiveUri(`${ARCHIVE_URI}`)).toBeNull();
  });
});

describe("isArchiveUri", () => {
  test("matches only the archive scheme", () => {
    expect(isArchiveUri(archiveUri("/tmp/a.zip"))).toBe(true);
    expect(isArchiveUri("/tmp/a.zip")).toBe(false);
    expect(isArchiveUri("recent://")).toBe(false);
    // archives are a virtual place: the shared guard must treat them as one
    expect(isVirtualUri(archiveUri("/tmp/a.zip"))).toBe(true);
  });
});

describe("archiveBrowseUri", () => {
  test("returns the cwd URI for a recognized archive file only", () => {
    expect(archiveBrowseUri("/tmp/a.zip", false)).toBe(archiveUri("/tmp/a.zip"));
    expect(archiveBrowseUri("/tmp/a.tar.gz", false)).toBe(archiveUri("/tmp/a.tar.gz"));
    expect(archiveBrowseUri("/tmp/notes.txt", false)).toBeNull();
    // a directory named like an archive is a directory, not a browsable archive
    expect(archiveBrowseUri("/tmp/a.zip", true)).toBeNull();
  });
});
