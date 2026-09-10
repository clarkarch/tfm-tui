import { describe, expect, test } from "bun:test";
import { makePluginEvents } from "./plugin-events";

describe("makePluginEvents", () => {
  test("on/emit delivers payloads in order", () => {
    const bus = makePluginEvents();
    const seen: string[] = [];
    bus.on("navigate", ({ dir }) => seen.push(dir));
    bus.emit("navigate", { dir: "/a" });
    bus.emit("navigate", { dir: "/b" });
    expect(seen).toEqual(["/a", "/b"]);
  });

  test("unsubscribe stops delivery; other listeners intact", () => {
    const bus = makePluginEvents();
    const a: string[] = [];
    const b: string[] = [];
    const unsub = bus.on("selection", ({ paths }) => a.push(paths.join(",")));
    bus.on("selection", ({ paths }) => b.push(paths.join(",")));
    bus.emit("selection", { paths: ["/x"] });
    unsub();
    bus.emit("selection", { paths: ["/y"] });
    expect(a).toEqual(["/x"]);
    expect(b).toEqual(["/x", "/y"]);
  });

  test("a throwing listener never breaks its neighbors", () => {
    const bus = makePluginEvents();
    const good: string[] = [];
    bus.on("trash", () => {
      throw new Error("boom");
    });
    bus.on("trash", ({ op }) => good.push(op));
    expect(() => bus.emit("trash", { op: "trash", paths: [] })).not.toThrow();
    expect(good).toEqual(["trash"]);
  });
});
