import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import {
  GPM_B_LEFT,
  GPM_B_MIDDLE,
  GPM_B_RIGHT,
  GPM_DOWN,
  GPM_DRAG,
  GPM_EVENT_SIZE,
  GPM_MOVE,
  GPM_UP,
  gpmConnectFrame,
  gpmEventToSgr,
  parseGpmEvent,
  startGpmInput,
  vcFromTty,
  type GpmEvent,
  type GpmSocket,
} from "./gpm";

// Build a raw 28-byte Gpm_Event blob the way the daemon frames it. Offsets are
// pinned against the installed libgpm (see gpm.ts) — a field-order change here
// must fail this builder too, not silently pass.
const frame = (over: Partial<GpmEvent> = {}): Uint8Array => {
  const e: GpmEvent = {
    buttons: 0,
    modifiers: 0,
    vc: 1,
    dx: 0,
    dy: 0,
    x: 5,
    y: 3,
    type: GPM_DOWN,
    clicks: 0,
    margin: 0,
    wdx: 0,
    wdy: 0,
    ...over,
  };
  const b = new Uint8Array(GPM_EVENT_SIZE);
  const dv = new DataView(b.buffer);
  dv.setUint8(0, e.buttons);
  dv.setUint8(1, e.modifiers);
  dv.setUint16(2, e.vc, true);
  dv.setInt16(4, e.dx, true);
  dv.setInt16(6, e.dy, true);
  dv.setInt16(8, e.x, true);
  dv.setInt16(10, e.y, true);
  dv.setInt32(12, e.type, true);
  dv.setInt32(16, e.clicks, true);
  dv.setInt32(20, e.margin, true);
  dv.setInt16(24, e.wdx, true);
  dv.setInt16(26, e.wdy, true);
  return b;
};

const sgrFor = (over: Partial<GpmEvent>): string | null => {
  const parsed = parseGpmEvent(frame(over));
  return parsed && gpmEventToSgr(parsed);
};

describe("parseGpmEvent", () => {
  test("decodes every field at its ABI offset", () => {
    const buf = frame({
      buttons: GPM_B_MIDDLE,
      modifiers: 5,
      vc: 42,
      dx: -3,
      dy: 7,
      x: 80,
      y: 24,
      type: GPM_DRAG | 32,
      clicks: 2,
      margin: 1,
      wdx: -1,
      wdy: 1,
    });
    expect(parseGpmEvent(buf)).toEqual({
      buttons: GPM_B_MIDDLE,
      modifiers: 5,
      vc: 42,
      dx: -3,
      dy: 7,
      x: 80,
      y: 24,
      type: GPM_DRAG | 32,
      clicks: 2,
      margin: 1,
      wdx: -1,
      wdy: 1,
    });
  });

  test("rejects a short buffer", () => {
    expect(parseGpmEvent(new Uint8Array(GPM_EVENT_SIZE - 1))).toBeNull();
  });

  test("honours a non-zero offset", () => {
    const buf = new Uint8Array(GPM_EVENT_SIZE + 4);
    buf.set(frame({ x: 9, y: 2 }), 4);
    expect(parseGpmEvent(buf, 4)?.x).toBe(9);
  });
});

describe("gpmEventToSgr", () => {
  test("left press releases with the matching final byte", () => {
    expect(sgrFor({ type: GPM_DOWN, buttons: GPM_B_LEFT })).toBe("\x1b[<0;5;3M");
    expect(sgrFor({ type: GPM_UP, buttons: GPM_B_LEFT })).toBe("\x1b[<0;5;3m");
  });

  test("middle and right map to buttons 1 and 2", () => {
    expect(sgrFor({ type: GPM_DOWN, buttons: GPM_B_MIDDLE })).toBe("\x1b[<1;5;3M");
    expect(sgrFor({ type: GPM_DOWN, buttons: GPM_B_RIGHT })).toBe("\x1b[<2;5;3M");
  });

  test("drag carries the motion bit with the held button", () => {
    expect(sgrFor({ type: GPM_DRAG, buttons: GPM_B_LEFT })).toBe("\x1b[<32;5;3M");
    expect(sgrFor({ type: GPM_DRAG, buttons: GPM_B_RIGHT })).toBe("\x1b[<34;5;3M");
  });

  test("buttonless motion is button 3 + motion bit (hover)", () => {
    expect(sgrFor({ type: GPM_MOVE, buttons: 0 })).toBe("\x1b[<35;5;3M");
  });

  test("wheel reports scroll bases 0..3", () => {
    expect(sgrFor({ type: GPM_MOVE, wdy: 1 })).toBe("\x1b[<64;5;3M");
    expect(sgrFor({ type: GPM_MOVE, wdy: -1 })).toBe("\x1b[<65;5;3M");
    expect(sgrFor({ type: GPM_MOVE, wdx: 1 })).toBe("\x1b[<66;5;3M");
    expect(sgrFor({ type: GPM_MOVE, wdx: -1 })).toBe("\x1b[<67;5;3M");
  });

  test("kernel shift-state maps to SGR modifier bits", () => {
    // shift_state: 1 shift, 2 altgr, 4 ctrl, 8 alt → SGR +4/+8/+16
    expect(sgrFor({ type: GPM_DOWN, buttons: GPM_B_LEFT, modifiers: 1 })).toBe("\x1b[<4;5;3M");
    expect(sgrFor({ type: GPM_DOWN, buttons: GPM_B_LEFT, modifiers: 4 })).toBe("\x1b[<16;5;3M");
    expect(sgrFor({ type: GPM_DOWN, buttons: GPM_B_LEFT, modifiers: 8 })).toBe("\x1b[<8;5;3M");
    expect(sgrFor({ type: GPM_DOWN, buttons: GPM_B_LEFT, modifiers: 2 })).toBe("\x1b[<8;5;3M");
    expect(sgrFor({ type: GPM_DOWN, buttons: GPM_B_LEFT, modifiers: 1 | 4 })).toBe("\x1b[<20;5;3M");
  });

  test("coordinates are clamped to the 1-based grid", () => {
    expect(sgrFor({ type: GPM_MOVE, x: 0, y: -2 })).toBe("\x1b[<35;1;1M");
  });

  test("a release with no identified button and unknown types are dropped", () => {
    expect(sgrFor({ type: GPM_UP, buttons: 0 })).toBeNull();
    expect(sgrFor({ type: 0 })).toBeNull();
  });
});

describe("vcFromTty", () => {
  test("parses a console tty and rejects non-console ttys", () => {
    expect(vcFromTty("/dev/tty7")).toBe(7);
    expect(vcFromTty("/dev/tty12")).toBe(12);
    expect(vcFromTty("/dev/pts/2")).toBeNull();
    expect(vcFromTty("/dev/tty")).toBeNull();
    expect(vcFromTty(null)).toBeNull();
  });
});

describe("gpmConnectFrame", () => {
  test("takes every event for this VC", () => {
    const b = gpmConnectFrame(7, 1234);
    expect(b.length).toBe(16);
    const dv = new DataView(b.buffer);
    expect(dv.getUint16(0, true)).toBe(0xffff); // eventMask
    expect(dv.getUint16(2, true)).toBe(0); // defaultMask
    expect(dv.getUint16(4, true)).toBe(0); // minMod
    expect(dv.getUint16(6, true)).toBe(0xffff); // maxMod
    expect(dv.getInt32(8, true)).toBe(1234); // pid
    expect(dv.getInt32(12, true)).toBe(7); // vc
  });
});

// --- reader ---

class FakeSocket extends EventEmitter implements GpmSocket {
  written: Buffer[] = [];
  destroyed = false;
  write(b: Uint8Array): void {
    this.written.push(Buffer.from(b));
  }
  destroy(): void {
    this.destroyed = true;
  }
}

const startReader = (over: Partial<Parameters<typeof startGpmInput>[0]> = {}) => {
  const sock = new FakeSocket();
  const bytes: string[] = [];
  const input = startGpmInput({
    term: "linux",
    envExists: () => true,
    ttyName: () => "/dev/tty1",
    connect: () => sock,
    onBytes: (s) => bytes.push(s),
    ...over,
  });
  return { sock, bytes, input };
};

describe("startGpmInput", () => {
  test("is inert off a Linux console or without the gpm socket", () => {
    expect(startReader({ term: "xterm-kitty" }).input).toBeNull();
    expect(startReader({ enabled: false }).input).toBeNull();
    expect(startReader({ envExists: () => false }).input).toBeNull();
    expect(startReader({ ttyName: () => "/dev/pts/2" }).input).toBeNull();
  });

  test("sends the connect frame and translates incoming events", () => {
    const { sock, bytes } = startReader();
    expect(sock.written[0]!.length).toBe(16);
    sock.emit("data", Buffer.from(frame({ type: GPM_DOWN, buttons: GPM_B_LEFT })));
    expect(bytes).toEqual(["\x1b[<0;5;3M"]);
  });

  test("reassembles a frame split across chunks and drops interleaved telemetry", () => {
    const { sock, bytes } = startReader();
    const one = Buffer.from(frame({ type: GPM_MOVE }));
    sock.emit("data", one.subarray(0, 10));
    expect(bytes).toEqual([]);
    sock.emit("data", one.subarray(10));
    expect(bytes).toEqual(["\x1b[<35;5;3M"]);
  });

  test("suppresses duplicate motion frames (gpm's 1Hz heartbeat)", () => {
    const { sock, bytes } = startReader();
    const one = Buffer.from(frame({ type: GPM_MOVE }));
    sock.emit("data", one);
    sock.emit("data", one);
    expect(bytes).toEqual(["\x1b[<35;5;3M"]);
  });

  test("stop tears the socket down and ignores later data", () => {
    const { sock, bytes, input } = startReader();
    input!.stop();
    expect(sock.destroyed).toBe(true);
    sock.emit("data", Buffer.from(frame({ type: GPM_MOVE })));
    expect(bytes).toEqual([]);
  });
});
