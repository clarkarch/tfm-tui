import { afterEach, describe, expect, test } from "bun:test";
import {
  buildMountArgs,
  buildUnmountArgs,
  gvfsRoot,
  isNetworkPath,
  parseGvfsName,
  parseServerInput,
  takeGioPrompt,
} from "./network";

const oldRuntime = process.env.XDG_RUNTIME_DIR;
afterEach(() => {
  if (oldRuntime === undefined) delete process.env.XDG_RUNTIME_DIR;
  else process.env.XDG_RUNTIME_DIR = oldRuntime;
});

describe("parseServerInput", () => {
  test("accepts a gvfs URI and derives a host label", () => {
    expect(parseServerInput("sftp://bob@example.com/srv")).toEqual({
      uri: "sftp://bob@example.com/srv",
      label: "example.com/srv",
    });
    expect(parseServerInput("smb://nas/pub")).toEqual({ uri: "smb://nas/pub", label: "nas/pub" });
  });

  test("accepts scp-like [user@]host:/path as sftp", () => {
    expect(parseServerInput("bob@example.com:/srv")).toEqual({
      uri: "sftp://bob@example.com/srv",
      label: "example.com",
    });
    expect(parseServerInput("host:relative")).toEqual({ uri: "sftp://host/relative", label: "host" });
    expect(parseServerInput("host:")).toEqual({ uri: "sftp://host/", label: "host" });
  });

  test("rejects unknown schemes, file://, whitespace and empty input", () => {
    expect(parseServerInput("file:///etc")).toBeNull();
    expect(parseServerInput("gopher://x")).toBeNull();
    expect(parseServerInput("")).toBeNull();
    expect(parseServerInput("  sftp://a b/")).toBeNull();
    expect(parseServerInput("sftp://host/\x07")).toBeNull();
  });
});

describe("gio argv builders", () => {
  test("mount/unmount pass the URI as one argv element, never a shell string", () => {
    expect(buildMountArgs("sftp://bob@example.com/srv")).toEqual(["mount", "sftp://bob@example.com/srv"]);
    expect(buildUnmountArgs("sftp://bob@example.com/srv")).toEqual(["mount", "-u", "sftp://bob@example.com/srv"]);
  });
});

describe("gvfsRoot / isNetworkPath", () => {
  test("honors $XDG_RUNTIME_DIR", () => {
    process.env.XDG_RUNTIME_DIR = "/run/user/4242";
    expect(gvfsRoot()).toBe("/run/user/4242/gvfs");
    expect(isNetworkPath("/run/user/4242/gvfs/sftp:host=a/foo")).toBe(true);
    expect(isNetworkPath("/run/user/4242/gvfs")).toBe(true);
    expect(isNetworkPath("/run/user/4242/gvfs-other")).toBe(false);
    expect(isNetworkPath("/home/bob")).toBe(false);
  });
});

describe("parseGvfsName", () => {
  test("decodes an sftp fuse dir into a disconnectable URI", () => {
    const m = parseGvfsName("sftp:host=example.com,user=bob,port=2222");
    expect(m).not.toBeNull();
    expect(m!.scheme).toBe("sftp");
    expect(m!.uri).toBe("sftp://bob@example.com:2222/");
    expect(m!.label).toBe("example.com");
  });

  test("decodes smb-share (server/share) and keeps a human label", () => {
    const m = parseGvfsName("smb-share:server=nas,share=pub,user=bob");
    expect(m!.scheme).toBe("smb");
    expect(m!.uri).toBe("smb://bob@nas/pub");
    expect(m!.label).toBe("nas/pub");
  });

  test("returns null without a host", () => {
    expect(parseGvfsName("not-a-mount")).toBeNull();
    expect(parseGvfsName("sftp:user=bob")).toBeNull();
  });
});

describe("takeGioPrompt", () => {
  test("detects a User prompt with its default", () => {
    const p = takeGioPrompt("Password required for bob@host\nUser [bob]: ");
    expect(p).not.toBeNull();
    expect(p!.kind).toBe("user");
    expect(p!.title).toBe("User name");
    expect(p!.default).toBe("bob");
    expect(p!.password).toBe(false);
    expect(p!.message).toBe("Password required for bob@host");
    expect(p!.consumed).toBe("Password required for bob@host\nUser [bob]: ".length);
  });

  test("marks a Password prompt for masking and carries no default", () => {
    const p = takeGioPrompt("User [bob]: \n");
    expect(p).toBeNull(); // trailing newline = not a pending prompt
    const pw = takeGioPrompt("Password: ");
    expect(pw!.kind).toBe("password");
    expect(pw!.password).toBe(true);
    expect(pw!.default).toBeUndefined();
  });

  test("detects a numbered host-key question", () => {
    const p = takeGioPrompt("The identity of host is unknown.\n[1] Yes\n[2] No\nChoice: ");
    expect(p!.kind).toBe("choice");
    expect(p!.title).toBe("Choice");
    expect(p!.message).toBe("The identity of host is unknown.\n[1] Yes\n[2] No");
  });

  test("returns null for ordinary output", () => {
    expect(takeGioPrompt("")).toBeNull();
    expect(takeGioPrompt("Mounting...\n")).toBeNull();
    expect(takeGioPrompt("User: notatail")).toBeNull();
  });
});
