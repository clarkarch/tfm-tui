import { describe, expect, test } from "bun:test";
import { hexToRgb16, pasteDroppedPaths, promptClickArrows, ptyScreenState, shellQuotePaths, terminalProbeReply, xtShiftEscapeFrame, type TermDropSink } from "./ui-term";

const makeSink = () => {
  const calls: string[] = [];
  const sink: TermDropSink = {
    ptyWrite: (s) => calls.push(`write:${s}`),
    focusTerm: () => calls.push("focus"),
    finishDrag: () => calls.push("finishDrag"),
    paintCue: (hot) => calls.push(`cue:${hot}`),
    log: (m) => calls.push(`log:${m}`),
  };
  return { calls, sink };
};

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
    const reassembled = terminalProbeReply(`${tail}0c`);
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

describe("shellQuotePaths", () => {
  test("plain paths get single quotes", () => {
    expect(shellQuotePaths(["/home/clark/notes.txt"])).toBe("'/home/clark/notes.txt'");
  });

  test("spaces survive without escapes inside the quotes", () => {
    expect(shellQuotePaths(["/tmp/my stuff/a b.txt"])).toBe("'/tmp/my stuff/a b.txt'");
  });

  test("embedded single quotes use the '\\'' idiom", () => {
    expect(shellQuotePaths(["/tmp/it's.txt"])).toBe("'/tmp/it'\\''s.txt'");
  });

  test("multiple paths join with single spaces", () => {
    expect(shellQuotePaths(["/a", "/b c", "/d"])).toBe("'/a' '/b c' '/d'");
  });

  test("empty list yields an empty string", () => {
    expect(shellQuotePaths([])).toBe("");
  });
});

describe("pasteDroppedPaths", () => {
  test("pastes quoted paths + trailing space, focuses, logs; returns true", () => {
    const { calls, sink } = makeSink();
    expect(pasteDroppedPaths(["/tmp/a.txt", "/tmp/b c"], sink)).toBe(true);
    expect(calls).toEqual([
      "finishDrag",
      "cue:false",
      "write:'/tmp/a.txt' '/tmp/b c' ",
      "focus",
      "log:term drop n=2",
    ]);
  });

  test("null payload still cleans up drag state and cue but writes nothing", () => {
    const { calls, sink } = makeSink();
    expect(pasteDroppedPaths(null, sink)).toBe(false);
    expect(calls).toEqual(["finishDrag", "cue:false"]);
  });

  test("empty payload behaves like null", () => {
    const { calls, sink } = makeSink();
    expect(pasteDroppedPaths([], sink)).toBe(false);
    expect(calls).toEqual(["finishDrag", "cue:false"]);
  });
});

describe("ptyScreenState", () => {
  test("mouse reporting DECSET sets mouse on, DECRST off", () => {
    let s = { mouse: false, alt: false };
    s = ptyScreenState("\x1b[?1000h\x1b[?1006h", s).state;
    expect(s.mouse).toBe(true);
    s = ptyScreenState("\x1b[?1000l\x1b[?1006l", s).state;
    expect(s.mouse).toBe(false);
  });

  test("alt screen 1049 tracked separately from mouse", () => {
    const { state } = ptyScreenState("\x1b[?1049h", { mouse: false, alt: false });
    expect(state.alt).toBe(true);
    expect(state.mouse).toBe(false);
  });

  test("sequence split across chunks is still seen via the carried tail", () => {
    let s = { mouse: false, alt: false };
    let r = ptyScreenState("some output \x1b[?10", s);
    s = r.state;
    r = ptyScreenState(`${r.tail}00h more`, s);
    expect(r.state.mouse).toBe(true);
  });
});

describe("promptClickArrows", () => {
  test("click right of the cursor emits forward-char arrows", () => {
    expect(promptClickArrows(5, 0, 8, 0, "❯ echo hello")).toBe("\x1b[C".repeat(3));
  });

  test("click left of the cursor emits backward-char arrows", () => {
    expect(promptClickArrows(8, 0, 5, 0, "❯ echo hello")).toBe("\x1b[D".repeat(3));
  });

  test("click past the line end clamps to the last text column", () => {
    // line "hello" ends at col 4; click at col 20 from cursor 2 -> 2 rights
    expect(promptClickArrows(2, 0, 20, 0, "hello")).toBe("\x1b[C".repeat(2));
  });

  test("click past the end while the cursor is already there does nothing", () => {
    expect(promptClickArrows(4, 0, 20, 0, "hello")).toBe(null);
  });

  test("click on a different row never bridges", () => {
    expect(promptClickArrows(5, 0, 8, 2, "hello")).toBe(null);
  });

  test("click on the cursor cell does nothing", () => {
    expect(promptClickArrows(5, 1, 5, 1, "hello")).toBe(null);
  });
});
