import { describe, expect, test } from "bun:test";
import {
  agreeDragFrame,
  agreeDropFrame,
  agreeSelfDropFrame,
  rejectHoverFrame,
  dragIconFrame,
  dragOutEnableFrame,
  dropDisableFrame,
  dropInEnableFrame,
  dropMachineIdFrame,
  releaseRemoteDirFrame,
  requestRemoteChildFrame,
  requestRemoteFileFrame,
  serveDataFrames,
  serveErrorFrame,
  dropPayloadToPaths,
  dragBadgeLabel,
  finishDropFrame,
  finishSelfDropFrame,
  parseOsc72Meta,
  percentEncodePath,
  presentDragFrames,
  cancelDropFrame,
  startDragFrame,
  startDropFrame,
  uriListPayload,
  uriListToPaths,
} from "./osc72";

describe("frames are byte-exact", () => {
  test("enable/disable/agree/start", () => {
    expect(dragOutEnableFrame()).toBe("\x1b]72;t=o:x=1;\x1b\\");
    expect(dropInEnableFrame()).toBe("\x1b]72;t=a;text/uri-list\x1b\\");
    // drop-side machine-id declaration (lets kitty flag cross-machine
    // payloads with X=1); emitted only when an id is known
    expect(dropMachineIdFrame("1:abcd")).toBe("\x1b]72;t=a:x=1;1:abcd\x1b\\");

    // remote fetch frames (both indices 1-based per spec)
    expect(requestRemoteFileFrame(1, 2)).toBe("\x1b]72;t=r:x=1:y=2\x1b\\");
    expect(requestRemoteChildFrame(5, 2)).toBe("\x1b]72;t=r:Y=5:x=2\x1b\\");
    expect(releaseRemoteDirFrame(5)).toBe("\x1b]72;t=r:Y=5\x1b\\");

    // serve frames: data chunks (4096 b64 chars, keys repeated, m on all but
    // the trailing empty EOF) + client error shape
    expect(serveDataFrames("t=k:x=1", "QUJD")).toEqual(["\x1b]72;t=k:x=1:m=0;QUJD\x1b\\", "\x1b]72;t=k:x=1:m=0\x1b\\"]);
    const big = "A".repeat(5000);
    const served = serveDataFrames("t=k:x=2:X=1", big);
    expect(served.length).toBe(3); // 4096 + 904 + EOF
    expect(served[0]).toBe(`\x1b]72;t=k:x=2:X=1:m=1;${"A".repeat(4096)}\x1b\\`);
    expect(served[1]).toBe(`\x1b]72;t=k:x=2:X=1:m=0;${"A".repeat(904)}\x1b\\`);
    expect(served[2]).toBe("\x1b]72;t=k:x=2:X=1:m=0\x1b\\");
    // concatenated chunk payloads reassemble to the input
    const payloadOf = (f: string): string => f.slice(f.lastIndexOf(";") + 1, -2);
    expect(served.slice(0, 2).map(payloadOf)).toEqual(["A".repeat(4096), "A".repeat(904)]);
    expect(serveErrorFrame("ENOENT", "gone")).toBe("\x1b]72;t=E;ENOENT:gone\x1b\\");
    expect(serveErrorFrame("EIO")).toBe("\x1b]72;t=E;EIO\x1b\\");
    expect(dropDisableFrame()).toBe("\x1b]72;t=A\x1b\\");
    expect(agreeDragFrame()).toBe("\x1b]72;t=o:o=3;text/uri-list\x1b\\");
    expect(startDragFrame()).toBe("\x1b]72;t=P:x=-1\x1b\\");
    expect(agreeDropFrame()).toBe("\x1b]72;t=m:o=1;text/uri-list\x1b\\");
    // self-drop hover answers kitty per hover event (o=2: the self-drop path
    // always moves via moveInto), misses reject so kitty treats the drop as
    // not accepted instead of cancelling the whole session late
    expect(agreeSelfDropFrame()).toBe("\x1b]72;t=m:o=2;text/uri-list\x1b\\");
    expect(rejectHoverFrame()).toBe("\x1b]72;t=m:o=0\x1b\\");
    // post-drop completion on the self path (mirrors t=r:o=1 on the external one)
    expect(finishSelfDropFrame()).toBe("\x1b]72;t=r:o=2\x1b\\");
    expect(startDropFrame(2)).toBe("\x1b]72;t=r:x=2\x1b\\");
    expect(finishDropFrame()).toBe("\x1b]72;t=r:o=1\x1b\\");
    expect(cancelDropFrame()).toBe("\x1b]72;t=r:o=0\x1b\\");
  });

  test("present frames: unpadded b64 payload then end marker", () => {
    const [data, end] = presentDragFrames(["/tmp"]);
    expect(end).toBe("\x1b]72;t=p:x=0\x1b\\");
    const expectedB64 = Buffer.from("file:///tmp", "utf8").toString("base64").replace(/=+$/, "");
    expect(data).toBe(`\x1b]72;t=p:x=0:m=0;${expectedB64}\x1b\\`);
  });

  test("drag icon frame sizes label cells and carries unpadded b64", () => {
    const f = dragIconFrame(1);
    expect(f).toBe(
      `\x1b]72;t=p:x=-1:y=0:X=8:Y=1:o=0:m=0;${Buffer.from("1 item").toString("base64").replace(/=+$/, "")}\x1b\\`,
    );
    expect(dragBadgeLabel(1)).toBe("1 item");
    expect(dragBadgeLabel(3)).toBe("3 items");
  });
});

describe("parseOsc72Meta", () => {
  test("splits colon fields, defaults missing x/y to NaN", () => {
    expect(parseOsc72Meta("t=o:x=3:y=4:m=1")).toEqual({ t: "o", x: 3, y: 4, X: NaN, Y: NaN, i: 0, o: 0, m: true });
    expect(parseOsc72Meta("t=m")).toEqual({ t: "m", x: NaN, y: NaN, X: NaN, Y: NaN, i: 0, o: 0, m: false });
    expect(parseOsc72Meta("t=r:x=2").x).toBe(2);
    expect(parseOsc72Meta("t=m:x=-1:y=-1").y).toBe(-1);
  });

  test("parses remote-machine keys (X/Y NaN when absent, o/i default 0)", () => {
    const meta = parseOsc72Meta("t=r:x=1:X=1");
    expect(meta.X).toBe(1);
    expect(meta.Y).toBeNaN();
    // X=0 is meaningful on the file-serve path (regular file), so absent
    // must stay NaN — a default 0 would be indistinguishable from a file
    expect(parseOsc72Meta("t=r:x=1").X).toBeNaN();
    expect(parseOsc72Meta("t=m:o=2").o).toBe(2);
    expect(parseOsc72Meta("t=a:i=5").i).toBe(5);
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
    // host-strip must KEEP the leading slash — "tmp/z" is cwd-relative and either
    // ENOENTs or copies to the wrong place (was pinned to the buggy output)
    expect(uriListToPaths("file://localhost/tmp/z")).toEqual(["/tmp/z"]);
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
