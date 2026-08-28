import { describe, expect, test } from "bun:test";
import {
  agreeDragFrame,
  agreeDropFrame,
  dragIconFrame,
  dragOutEnableFrame,
  dropDisableFrame,
  dropInEnableFrame,
  dropPayloadToPaths,
  dragBadgeLabel,
  finishDropFrame,
  parseOsc72Meta,
  percentEncodePath,
  presentDragFrames,
  selfDropRejectFrame,
  startDragFrame,
  startDropFrame,
  uriListPayload,
  uriListToPaths,
} from "./osc72";

describe("frames are byte-exact", () => {
  test("enable/disable/agree/start", () => {
    expect(dragOutEnableFrame()).toBe("\x1b]72;t=o:x=1;\x1b\\");
    expect(dropInEnableFrame()).toBe("\x1b]72;t=a;text/uri-list\x1b\\");
    expect(dropDisableFrame()).toBe("\x1b]72;t=A\x1b\\");
    expect(agreeDragFrame()).toBe("\x1b]72;t=o:o=3;text/uri-list\x1b\\");
    expect(startDragFrame()).toBe("\x1b]72;t=P:x=-1\x1b\\");
    expect(agreeDropFrame()).toBe("\x1b]72;t=m:o=1;text/uri-list\x1b\\");
    expect(startDropFrame(2)).toBe("\x1b]72;t=r:x=2\x1b\\");
    expect(finishDropFrame()).toBe("\x1b]72;t=r:o=1\x1b\\");
    expect(selfDropRejectFrame()).toBe("\x1b]72;t=r:o=0\x1b\\");
  });

  test("present frames: unpadded b64 payload then end marker", () => {
    const [data, end] = presentDragFrames(["/tmp"]);
    expect(end).toBe("\x1b]72;t=p:x=0\x1b\\");
    const expectedB64 = Buffer.from("file:///tmp", "utf8").toString("base64").replace(/=+$/, "");
    expect(data).toBe(`\x1b]72;t=p:x=0:m=0;${expectedB64}\x1b\\`);
  });

  test("drag icon frame sizes label cells and carries unpadded b64", () => {
    const f = dragIconFrame(1);
    expect(f).toBe(`\x1b]72;t=p:x=-1:y=0:X=8:Y=1:o=0:m=0;${Buffer.from("1 item").toString("base64").replace(/=+$/, "")}\x1b\\`);
    expect(dragBadgeLabel(1)).toBe("1 item");
    expect(dragBadgeLabel(3)).toBe("3 items");
  });
});

describe("parseOsc72Meta", () => {
  test("splits colon fields, defaults missing x/y to NaN", () => {
    expect(parseOsc72Meta("t=o:x=3:y=4:m=1")).toEqual({ t: "o", x: 3, y: 4, m: true });
    expect(parseOsc72Meta("t=m")).toEqual({ t: "m", x: NaN, y: NaN, m: false });
    expect(parseOsc72Meta("t=r:x=2").x).toBe(2);
    expect(parseOsc72Meta("t=m:x=-1:y=-1").y).toBe(-1);
  });
});

describe("payload encode/decode round trip", () => {
  test("percentEncodePath keeps root slashes, escapes segments", () => {
    expect(percentEncodePath("/tmp/a b/c&d")).toBe("/tmp/a%20b/c%26d");
  });

  test("uriListPayload is CRLF-joined, unpadded", () => {
    const b64 = uriListPayload(["/a b", "/c"]);
    expect(b64.endsWith("=")).toBe(false);
    expect(Buffer.from(b64, "base64").toString("utf8")).toBe("file:///a%20b\r\nfile:///c");
  });

  test("uriListToPaths decodes file lines, drops others; host part is stripped with the first slash", () => {
    expect(uriListToPaths("file:///tmp/a%20b\r\nhttp://x/y\r\ngarbage")).toEqual(["/tmp/a b"]);
    expect(uriListToPaths("file://localhost/tmp/z")).toEqual(["tmp/z"]);
  });

  test("dropPayloadToPaths falls back to bare absolute paths", () => {
    expect(dropPayloadToPaths("/tmp/a\r\n/tmp/b c")).toEqual(["/tmp/a", "/tmp/b c"]);
    expect(dropPayloadToPaths("")).toEqual([]);
  });

  test("round trip through payload survives spaces", () => {
    const paths = ["/tmp/a b/c d.txt", "/etc/hostname"];
    expect(dropPayloadToPaths(Buffer.from(uriListPayload(paths), "base64").toString("utf8"))).toEqual(paths);
  });
});
