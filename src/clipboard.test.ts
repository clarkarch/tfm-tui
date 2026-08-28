import { afterEach, describe, expect, test } from "bun:test";
import { parseCopiedFiles, sysClipTool } from "./clipboard";

const oldWayland = process.env.WAYLAND_DISPLAY;
const oldDisplay = process.env.DISPLAY;
afterEach(() => {
  if (oldWayland === undefined) delete process.env.WAYLAND_DISPLAY;
  else process.env.WAYLAND_DISPLAY = oldWayland;
  if (oldDisplay === undefined) delete process.env.DISPLAY;
  else process.env.DISPLAY = oldDisplay;
});

describe("parseCopiedFiles", () => {
  test("parses the gnome-copied-files format with percent-decoding", () => {
    const res = parseCopiedFiles(
      "copy\nfile:///home/me/a%20b.txt\nfile:///home/me/c.txt",
    );
    expect(res).toEqual({ op: "copy", paths: ["/home/me/a b.txt", "/home/me/c.txt"] });
  });

  test("cut maps to move", () => {
    const res = parseCopiedFiles("cut\nfile:///tmp/x");
    expect(res!.op).toBe("move");
  });

  test("header line is optional", () => {
    const res = parseCopiedFiles("file:///tmp/x");
    expect(res).toEqual({ op: "copy", paths: ["/tmp/x"] });
  });

  test("handles CRLF line endings", () => {
    const res = parseCopiedFiles("copy\r\nfile:///tmp/x\r\nfile:///tmp/y\r\n");
    expect(res!.paths).toEqual(["/tmp/x", "/tmp/y"]);
  });

  test("plain text paths are ignored (tfm publishes text; pastes come back as URIs)", () => {
    expect(parseCopiedFiles("/tmp/plain\n/tmp/paths")).toBeNull();
  });

  test("empty or blank payloads yield null", () => {
    expect(parseCopiedFiles("")).toBeNull();
    expect(parseCopiedFiles("\n\n")).toBeNull();
    expect(parseCopiedFiles("copy\nno-uris-here")).toBeNull();
  });

  test("malformed percent-encoding falls back to the raw string", () => {
    const res = parseCopiedFiles("copy\nfile:///tmp/%zz.txt");
    expect(res!.paths).toEqual(["/tmp/%zz.txt"]);
  });
});

describe("sysClipTool", () => {
  test("Wayland wins when both displays are set", () => {
    process.env.WAYLAND_DISPLAY = "wayland-0";
    process.env.DISPLAY = ":0";
    const t = sysClipTool();
    expect(t!.put).toBe("wl-copy");
    expect(t!.getArgs).toEqual(["-t", "x-special/gnome-copied-files"]);
  });

  test("X11 xclip serves a few requests then exits", () => {
    delete process.env.WAYLAND_DISPLAY;
    process.env.DISPLAY = ":0";
    const t = sysClipTool();
    expect(t!.put).toBe("xclip");
    expect(t!.putBase).toEqual(["-selection", "clipboard", "-l", "4"]);
  });

  test("no display at all → null", () => {
    delete process.env.WAYLAND_DISPLAY;
    delete process.env.DISPLAY;
    expect(sysClipTool()).toBeNull();
  });
});
