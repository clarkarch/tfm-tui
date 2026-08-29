import { describe, expect, test } from "bun:test";
import { hexToRgb16, terminalProbeReply, xtShiftEscapeFrame } from "./ui-term";

describe("hexToRgb16", () => {
  test("doubles each 8-bit channel to 16-bit", () => {
    expect(hexToRgb16("#1a1b26")).toBe("1a1a/1b1b/2626");
  });

  test("accepts hex without the leading #", () => {
    expect(hexToRgb16("1a1b26")).toBe("1a1a/1b1b/2626");
  });

  test("case-insensitive, preserves case of doubled halves", () => {
    expect(hexToRgb16("#AaBbCc")).toBe("AaAa/BbBb/CcCc");
  });

  test("trims whitespace", () => {
    expect(hexToRgb16("  #1a1b26\t")).toBe("1a1a/1b1b/2626");
  });

  test("invalid hex falls back to ffffff per channel", () => {
    expect(hexToRgb16("zzz")).toBe("ffff/ffff/ffff");
    expect(hexToRgb16("#12345")).toBe("ffff/ffff/ffff");
  });
});

describe("terminalProbeReply", () => {
  test("answers Primary DA (CSI c)", () => {
    const { resp, tail } = terminalProbeReply("ls\r\n\x1b[0c");
    expect(resp).toContain("\x1b[?62;1;2;6;9;15;22c");
    expect(tail).toBe("");
  });

  test("answers secondary DA (CSI > c)", () => {
    const { resp } = terminalProbeReply("\x1b[>0c");
    expect(resp).toContain("\x1b[>0;0;0c");
  });

  test("answers device status report (CSI 5 n) with OK", () => {
    const { resp } = terminalProbeReply("\x1b[5n");
    expect(resp).toContain("\x1b[0n");
  });

  test("combined probes accumulate responses", () => {
    const { resp } = terminalProbeReply("\x1b[0c\x1b[5n");
    expect(resp).toBe("\x1b[?62;1;2;6;9;15;22c\x1b[0n");
  });

  test("buffer ending mid-sequence keeps an 8-char tail for reassembly", () => {
    const { resp, tail } = terminalProbeReply("ls\x1b[");
    expect(resp).toBe("");
    expect(tail).toBe("ls\x1b[".slice(-8));
    const reassembled = terminalProbeReply(tail + "0c");
    expect(reassembled.resp).toContain("\x1b[?62;1;2;6;9;15;22c");
  });

  test("clean buffer without probes yields no reply and no tail", () => {
    const { resp, tail } = terminalProbeReply("plain output\r\n");
    expect(resp).toBe("");
    expect(tail).toBe("");
  });
});

describe("xtShiftEscapeFrame", () => {
  test("enable uses CSI > 1 s", () => {
    expect(xtShiftEscapeFrame(true)).toBe("\x1b[>1s");
  });

  test("release uses CSI > 0 s", () => {
    expect(xtShiftEscapeFrame(false)).toBe("\x1b[>0s");
  });
});
