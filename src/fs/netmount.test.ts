import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { listNetworkMounts, makeNetworkActions, type GioResult, type NetworkSink } from "./netmount";

const oldRuntime = process.env.XDG_RUNTIME_DIR;
beforeEach(() => {
  process.env.XDG_RUNTIME_DIR = "/run/user/4242";
});
afterEach(() => {
  if (oldRuntime === undefined) delete process.env.XDG_RUNTIME_DIR;
  else process.env.XDG_RUNTIME_DIR = oldRuntime;
});

type Calls = { mount: string[]; unmount: string[]; notify: [string, string?, string?][] };

const makeSink = (opts: {
  result?: GioResult;
  names?: string[] | (() => string[]);
}): { sink: NetworkSink; calls: Calls } => {
  const calls: Calls = { mount: [], unmount: [], notify: [] };
  const sink: NetworkSink = {
    gvfsRoot: () => "/run/user/4242/gvfs",
    mount: async (uri) => {
      calls.mount.push(uri);
      return opts.result ?? { code: 0, stdout: "", stderr: "" };
    },
    unmount: async (uri) => {
      calls.unmount.push(uri);
      return opts.result ?? { code: 0, stdout: "", stderr: "" };
    },
    readdir: async () => (typeof opts.names === "function" ? opts.names() : (opts.names ?? [])),
    notify: (m, t, l) => calls.notify.push([m, t, l]),
  };
  return { sink, calls };
};

describe("listNetworkMounts", () => {
  test("parses gvfs dirs, skips unparseable names, tolerates a missing root", async () => {
    const mounts = await listNetworkMounts(async () => [
      "sftp:host=example.com,user=bob",
      "junk",
      "smb-share:server=nas,share=pub",
    ]);
    expect(mounts.map((m) => m.path)).toEqual([
      "/run/user/4242/gvfs/sftp:host=example.com,user=bob",
      "/run/user/4242/gvfs/smb-share:server=nas,share=pub",
    ]);
    expect(mounts[0]!.uri).toBe("sftp://bob@example.com/");
    await expect(listNetworkMounts(async () => Promise.reject(new Error("ENOENT")))).resolves.toEqual([]);
  });
});

describe("makeNetworkActions.connect", () => {
  test("runs `gio mount <uri>`, resolves the new fuse dir, and remembers the uri", async () => {
    let mounted = false;
    const { sink, calls } = makeSink({ names: () => (mounted ? ["sftp:host=example.com,user=bob"] : []) });
    const realMount = sink.mount;
    sink.mount = async (uri) => {
      mounted = true;
      return realMount(uri);
    };
    const actions = makeNetworkActions(sink);
    const p = await actions.connect("bob@example.com:/srv");
    expect(calls.mount).toEqual(["sftp://bob@example.com/srv"]);
    expect(p).toBe("/run/user/4242/gvfs/sftp:host=example.com,user=bob");
    expect(actions.uriForPath(p!)).toBe("sftp://bob@example.com/srv");
    expect(calls.notify.at(-1)).toEqual(["Connected to example.com", "network", "success"]);
  });

  test("rejects an unsupported address without spawning gio", async () => {
    const { sink, calls } = makeSink({});
    const actions = makeNetworkActions(sink);
    expect(await actions.connect("file:///etc")).toBeNull();
    expect(calls.mount.length).toBe(0);
    expect(calls.notify.at(-1)).toEqual(["Unsupported server address", "network", "error"]);
  });

  test("surfaces the tool's error line when the mount fails", async () => {
    const { sink, calls } = makeSink({ result: { code: 1, stdout: "", stderr: "Error: password required\n" } });
    const actions = makeNetworkActions(sink);
    expect(await actions.connect("sftp://host/")).toBeNull();
    expect(calls.notify.at(-1)).toEqual(["Connect failed: Error: password required", "network", "error"]);
  });
});

describe("makeNetworkActions.disconnect", () => {
  test("unmounts the remembered uri for a path", async () => {
    const { sink, calls } = makeSink({});
    const actions = makeNetworkActions(sink);
    actions.rememberUri("/run/user/4242/gvfs/sftp:host=example.com,user=bob", "sftp://bob@example.com/");
    expect(await actions.disconnect("/run/user/4242/gvfs/sftp:host=example.com,user=bob")).toBe(true);
    expect(calls.unmount).toEqual(["sftp://bob@example.com/"]);
    expect(calls.notify.at(-1)).toEqual(["Disconnected example.com", "network", "success"]);
  });

  test("reconstructs the uri from the gvfs name when never remembered", async () => {
    const { sink, calls } = makeSink({});
    const actions = makeNetworkActions(sink);
    await actions.disconnect("/run/user/4242/gvfs/smb-share:server=nas,share=pub,user=bob");
    expect(calls.unmount).toEqual(["smb://bob@nas/pub"]);
  });

  test("reports an undeterminable path instead of guessing", async () => {
    const { sink, calls } = makeSink({});
    const actions = makeNetworkActions(sink);
    expect(await actions.disconnect("/run/user/4242/gvfs/junk")).toBe(false);
    expect(calls.unmount.length).toBe(0);
    expect(calls.notify.at(-1)).toEqual(["Can't determine the mount to disconnect", "network", "error"]);
  });

  test("keeps the mapping on a failed unmount", async () => {
    const { sink, calls } = makeSink({ result: { code: 1, stdout: "", stderr: "Error: busy" } });
    const actions = makeNetworkActions(sink);
    const p = "/run/user/4242/gvfs/sftp:host=example.com,user=bob";
    actions.rememberUri(p, "sftp://bob@example.com/");
    expect(await actions.disconnect(p)).toBe(false);
    expect(actions.uriForPath(p)).toBe("sftp://bob@example.com/");
    expect(calls.notify.at(-1)).toEqual(["Disconnect failed: Error: busy", "network", "error"]);
  });
});
