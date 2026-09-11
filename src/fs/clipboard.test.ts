import { afterEach, describe, expect, test } from "bun:test";
import {
  isCutKeyFor,
  parseCopiedFiles,
  parsePlainPaths,
  publishPathsToSystemClipboard,
  sysClipTool,
} from "./clipboard";

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
    const res = parseCopiedFiles("copy\nfile:///home/me/a%20b.txt\nfile:///home/me/c.txt");
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

  test("bare paths are not URIs (the read path falls back to parsePlainPaths)", () => {
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

  test("gnome payloads from other file managers round-trip through the parser", () => {
    const res = parseCopiedFiles("copy\nfile:///home/me/a%20b.txt");
    expect(res).toEqual({ op: "copy", paths: ["/home/me/a b.txt"] });
  });
});

describe("parsePlainPaths", () => {
  const exists = (p: string) => p === "/tmp/a" || p === "/tmp/b";

  test("accepts only absolute paths that exist (tfm's own text publish)", () => {
    expect(parsePlainPaths("/tmp/a\nrelative/miss\n/tmp/gone\n/tmp/b", exists)).toEqual({
      op: "copy",
      paths: ["/tmp/a", "/tmp/b"],
    });
  });

  test("random copied prose pastes nothing, never a file op", () => {
    expect(parsePlainPaths("hello world\nnot a path", exists)).toBeNull();
  });

  test("blank input yields null", () => {
    expect(parsePlainPaths("", exists)).toBeNull();
    expect(parsePlainPaths("\n\n", exists)).toBeNull();
  });
});

describe("publishPathsToSystemClipboard", () => {
  // the external-paste contract: whatever wl-copy/xclip receives must be
  // readable by a text/plain client. wl-copy offers ONE mime type — passing
  // `-t x-special/gnome-copied-files` makes terminals/editors paste NOTHING.
  test("sends bare paths with no -t (wl-copy infers text/plain)", () => {
    process.env.WAYLAND_DISPLAY = "wayland-0";
    let argv: string[] = [];
    let payload = "";
    const fakeSpawn = ((_cmd: string, args: string[]) => {
      argv = args;
      return {
        stdin: { end: (s: string) => (payload = s) },
        unref: () => {},
      };
    }) as unknown as Parameters<typeof publishPathsToSystemClipboard>[3];
    publishPathsToSystemClipboard("copy", [{ path: "/home/me/a b.txt" }, { path: "/tmp/x" }], () => {}, fakeSpawn);
    expect(argv).toEqual([]); // no -t: wl-copy advertises text/plain + UTF8_STRING
    expect(payload).toBe("/home/me/a b.txt\n/tmp/x");
  });

  test("xclip path: bare paths, no gnome mime arg", () => {
    delete process.env.WAYLAND_DISPLAY;
    process.env.DISPLAY = ":0";
    let argv: string[] = [];
    let payload = "";
    const fakeSpawn = ((_cmd: string, args: string[]) => {
      argv = args;
      return {
        stdin: { end: (s: string) => (payload = s) },
        unref: () => {},
      };
    }) as unknown as Parameters<typeof publishPathsToSystemClipboard>[3];
    publishPathsToSystemClipboard("cut", [{ path: "/tmp/x" }], () => {}, fakeSpawn);
    expect(argv).toEqual(["-selection", "clipboard", "-l", "10"]);
    expect(payload).toBe("/tmp/x");
  });
});

describe("sysClipTool", () => {
  test("Wayland wins when both displays are set", () => {
    process.env.WAYLAND_DISPLAY = "wayland-0";
    process.env.DISPLAY = ":0";
    const t = sysClipTool();
    expect(t!.put).toBe("wl-copy");
    expect(t!.getArgs).toEqual(["-t", "x-special/gnome-copied-files"]);
    expect(t!.getTextArgs).toEqual([]);
  });

  test("X11 xclip serves enough requests then exits (probes + fetch, no mid-paste expiry)", () => {
    delete process.env.WAYLAND_DISPLAY;
    process.env.DISPLAY = ":0";
    const t = sysClipTool();
    expect(t!.put).toBe("xclip");
    expect(t!.putBase).toEqual(["-selection", "clipboard", "-l", "10"]);
    expect(t!.getTextArgs).toEqual(["-selection", "clipboard", "-o"]);
  });

  test("no display at all → null", () => {
    delete process.env.WAYLAND_DISPLAY;
    delete process.env.DISPLAY;
    expect(sysClipTool()).toBeNull();
  });
});

describe("isCutKeyFor", () => {
  const clip = (mode: "copy" | "cut", paths: string[]) => ({ mode, items: paths.map((p) => ({ path: p })) });

  test("null/undefined clipboard cuts nothing", () => {
    expect(isCutKeyFor(null, "/a")).toBe(false);
    expect(isCutKeyFor(undefined, "/a")).toBe(false);
  });

  test("copy mode never dims", () => {
    expect(isCutKeyFor(clip("copy", ["/a"]), "/a")).toBe(false);
  });

  test("cut mode dims exactly the queued paths", () => {
    const c = clip("cut", ["/a", "/b"]);
    expect(isCutKeyFor(c, "/a")).toBe(true);
    expect(isCutKeyFor(c, "/b")).toBe(true);
    expect(isCutKeyFor(c, "/c")).toBe(false);
  });

  test("empty cut items match nothing", () => {
    expect(isCutKeyFor(clip("cut", []), "/a")).toBe(false);
  });
});
