import { describe, expect, test } from "bun:test";
import { bumpHex } from "./color";

describe("bumpHex", () => {
  test("bumps blue channel by one", () => {
    expect(bumpHex("#1a1b26")).toBe("#1a1b27");
  });

  test("carries into green when blue overflows", () => {
    expect(bumpHex("#001fff")).toBe("#002000");
  });

  test("carries into red when green+blue overflow", () => {
    expect(bumpHex("#01ffff")).toBe("#020000");
  });

  test("saturates at white instead of overflowing", () => {
    expect(bumpHex("#ffffff")).toBe("#ffffff");
  });

  test("preserves zero padding", () => {
    expect(bumpHex("#000000")).toBe("#000001");
  });

  test("handles short hex form by parsing what slice gives it", () => {
    // "#abc" parses as 0xabc -> padded to 6 digits
    expect(bumpHex("#abc")).toBe("#000abd");
  });

  test("returns input unchanged when unparseable", () => {
    expect(bumpHex("#nothex")).toBe("#nothex");
    expect(bumpHex("#zzzzzz")).toBe("#zzzzzz");
    expect(bumpHex("")).toBe("");
  });

  test("quirk: treats everything after char 0 as hex, not just #rrggbb", () => {
    // "red".slice(1) === "ed" -> parseInt(_,16) === 237. Only ever fed
    // well-formed #rrggbb internally, but the guard is parseFloat-based.
    expect(bumpHex("red")).toBe("#0000ee");
  });
});
