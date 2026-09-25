// --- gpm mouse for the Linux text console. Stock gpm (1.20.x) does NOT emit
// xterm mouse escapes (its kernel-side TIOCL_SELMOUSEREPORT path only covers
// ?1000/1005 and stalled upstream for 25+ years), so nothing lands in the
// tty's stdin. What it DOES offer is the /dev/gpmctl client socket: connect,
// hand it a Gpm_Connect, and it streams raw Gpm_Event frames — including the
// motion events tfm's hover/rubber-band/drag need and the kernel report path
// can't carry. This module is that client + a Gpm_Event → SGR translator; the
// chrome wiring merges the SGR bytes into the renderer's stdin.
//
// No libgpm: the connection is plain AF_UNIX + a 16-byte frame, so the ABI is
// the only contract. It is pinned against the installed library (1.20.7):
// sizeof(Gpm_Event)=28, sizeof(Gpm_Connect)=16, GPM_USE_MAGIC compiled OFF
// (Gpm_GetEvent reads 0x1c bytes with no magic prefix). The daemon tags every
// frame with vc; we keep the frame only when vc matches our console, which
// sidesteps the teardown case where our close fails and gpm silently
// re-points the connection at the vc-0 default console. ---

import { connect as netConnect, type Socket } from "node:net";
import { existsSync, readFileSync, readlinkSync } from "node:fs";

export const GPM_EVENT_SIZE = 28;
export const GPM_CONNECT_SIZE = 16;
const GPM_NODE_CTL = "/dev/gpmctl";

// kernel shift_state — gpm folds TIOCL_GETSHIFTSTATE into event.modifiers:
// bit 1 shift, bit 2 altgr, bit 4 ctrl, bit 8 alt.
const SHIFT = 1;
const ALTGR = 2;
const CTRL = 4;
const ALT = 8;

export const GPM_B_RIGHT = 1;
export const GPM_B_MIDDLE = 2;
export const GPM_B_LEFT = 4;
export const GPM_B_UP = 16;
export const GPM_B_DOWN = 32;

export const GPM_MOVE = 1;
export const GPM_DRAG = 2;
export const GPM_DOWN = 4;
export const GPM_UP = 8;

// gpm.h: "if set in the defaultMask, force an already used event to pass
// over to another handler" — without it, an event our eventMask claims never
// reaches the default handler (do_client.c returns 1 = used).
export const GPM_HARD = 256;

export type GpmEvent = {
  buttons: number;
  modifiers: number;
  vc: number;
  dx: number;
  dy: number;
  x: number;
  y: number;
  type: number;
  clicks: number;
  margin: number;
  wdx: number;
  wdy: number;
};

export const parseGpmEvent = (buf: Uint8Array, off = 0): GpmEvent | null => {
  if (buf.byteLength - off < GPM_EVENT_SIZE) return null;
  const dv = new DataView(buf.buffer, buf.byteOffset + off, GPM_EVENT_SIZE);
  return {
    buttons: dv.getUint8(0),
    modifiers: dv.getUint8(1),
    vc: dv.getUint16(2, true),
    dx: dv.getInt16(4, true),
    dy: dv.getInt16(6, true),
    x: dv.getInt16(8, true),
    y: dv.getInt16(10, true),
    type: dv.getInt32(12, true),
    clicks: dv.getInt32(16, true),
    margin: dv.getInt32(20, true),
    wdx: dv.getInt16(24, true),
    wdy: dv.getInt16(26, true),
  };
};

const primaryButton = (buttons: number): number => {
  if (buttons & GPM_B_LEFT) return 0;
  if (buttons & GPM_B_MIDDLE) return 1;
  if (buttons & GPM_B_RIGHT) return 2;
  return 3;
};

const modifierBits = (m: number): number => (m & SHIFT ? 4 : 0) | (m & (ALT | ALTGR) ? 8 : 0) | (m & CTRL ? 16 : 0);

// One Gpm_Event → the SGR mouse escape OpenTUI's parser already understands.
// Returns null for events with no mouse meaning (bare GPM_UP with no button,
// unhandled types, noise). Coordinates are already 1-based from gpm; clamp
// into the grid so a marginal drag can't emit a 0 coordinate.
export const gpmEventToSgr = (ev: GpmEvent): string | null => {
  let base: number;
  let final: "M" | "m";
  const mods = modifierBits(ev.modifiers);

  if (ev.type & GPM_DOWN) {
    base = primaryButton(ev.buttons);
    final = "M";
  } else if (ev.type & GPM_UP) {
    const b = primaryButton(ev.buttons);
    if (b === 3) return null;
    base = b;
    final = "m";
  } else if (ev.type & GPM_DRAG) {
    base = 32 | primaryButton(ev.buttons);
    final = "M";
  } else if (ev.type & GPM_MOVE) {
    if (ev.wdy > 0) base = 64;
    else if (ev.wdy < 0) base = 65;
    else if (ev.wdx > 0) base = 66;
    else if (ev.wdx < 0) base = 67;
    else base = 32 | primaryButton(ev.buttons);
    final = "M";
  } else {
    return null;
  }

  const x = Math.max(1, ev.x);
  const y = Math.max(1, ev.y);
  return `\x1b[<${base + mods};${x};${y}${final}`;
};

// Button releases need state: on GPM_UP the daemon reports currently-held
// buttons, so a lone release arrives with buttons=0 (unidentifiable) and a
// pure function would drop every mouseup — leaving tfm's press armed forever
// (no drag cleanup, no deferred ctrl-toggle). The translator remembers the
// last pressed button and synthesizes the release from it; a reported button
// always wins. One slot is enough (single pointer); an interleaved second
// DOWN overwrites it and any release clears it.
export const makeGpmTranslator = (): ((ev: GpmEvent) => string | null) => {
  let lastDown: number | null = null;
  return (ev: GpmEvent): string | null => {
    if (ev.type & GPM_DOWN) {
      const b = primaryButton(ev.buttons);
      if (b === 3) return null;
      lastDown = b;
      return gpmEventToSgr(ev);
    }
    if (ev.type & GPM_UP) {
      const b = primaryButton(ev.buttons);
      const release = b === 3 ? lastDown : b;
      lastDown = null;
      if (release === null) return null;
      const mask = [GPM_B_LEFT, GPM_B_MIDDLE, GPM_B_RIGHT][release];
      if (mask === undefined) return null;
      return gpmEventToSgr({ ...ev, buttons: mask });
    }
    return gpmEventToSgr(ev);
  };
};

// Gpm_Connect: take every event for our VC, all modifiers — and let bare
// MOVE fall through to the daemon's default handler (do_selection's pointer
// highlight = the native gpm pointer). do_client.c only passes an already
// claimed event on when defaultMask carries GPM_HARD, so the mask is
// MOVE|HARD; buttons stay client-only, keeping gpm selection/paste out.
export const gpmConnectFrame = (vc: number, pid: number): Buffer => {
  const b = Buffer.alloc(GPM_CONNECT_SIZE);
  b.writeUInt16LE(0xffff, 0);
  b.writeUInt16LE(GPM_MOVE | GPM_HARD, 2);
  b.writeUInt16LE(0, 4);
  b.writeUInt16LE(0xffff, 6);
  b.writeInt32LE(pid, 8);
  b.writeInt32LE(vc, 12);
  return b;
};

// /dev/tty7 → 7; anything that isn't a console VT → null.
export const vcFromTty = (tty: string | null | undefined): number | null => {
  if (!tty) return null;
  const m = /^\/dev\/tty(\d+)$/.exec(tty);
  return m ? Number(m[1]) : null;
};

// Kernel's currently active console (e.g. "tty1\n" from
// /sys/class/tty/tty0/active) → 1. Used when the app sits behind a pty
// (asciinema rec, script(1)) on a Linux console: gpm still tags frames with
// the physical console's vc. Missing/unparsable (containers, remote hosts
// without a console) keeps gpm inert.
const SYSFS_ACTIVE_CONSOLE = "/sys/class/tty/tty0/active";

export const vcFromActiveConsole = (content: string | null | undefined): number | null => {
  if (!content) return null;
  const m = /^tty(\d+)\s*$/.exec(content);
  return m ? Number(m[1]) : null;
};

export type GpmSocket = {
  write(b: Uint8Array): unknown;
  destroy(): unknown;
  on(event: "error", cb: (err: Error) => void): unknown;
};

// node:tty has no ttyname; /proc/self/fd/N resolves it everywhere Linux gpm
// exists. Returns console (/dev/ttyN) or pty (/dev/pts/N) paths — callers
// decide which is usable (vcFromTty for the direct path, pty pattern for the
// recorder fallback). Falls back null when no fd is a tty at all, so piped
// non-console stdio stays a clean no-op.
const procTtyName = (): string | null => {
  for (const fd of [0, 1, 2]) {
    try {
      const p = readlinkSync(`/proc/self/fd/${fd}`);
      if (/^\/dev\/(tty\d+|pts\/\d+)$/.test(p)) return p;
    } catch {}
  }
  return null;
};

export type GpmInputOptions = {
  term?: string | undefined;
  /** environment — injectable so tests control SSH/asciinema markers */
  env?: Record<string, string | undefined>;
  /** probe for /dev/gpmctl — injectable so tests stay fs-free */
  envExists?: (p: string) => boolean;
  /** resolve the controlling console tty — injectable (node:tty in prod) */
  ttyName?: () => string | null;
  /** resolve the kernel's active console vc (pty fallback) — injectable */
  activeVc?: () => number | null;
  /** AF_UNIX connect — injectable so tests use a fake socket */
  connect?: (path: string) => GpmSocket;
  onBytes: (sgr: string) => void;
  log?: (msg: string) => void;
};

// Attach to gpm. Returns null (feature inert) everywhere but a Linux console
// with a live gpm daemon — kittty/ghostty/X/tmux and no-gpm machines are
// untouched. Never throws: a gpm hiccup must not take the TUI down.
// Every boot logs the gate values so a silent null is diagnosable from the
// log alone (TERM, socket, tty resolution, fallback outcome).
export const startGpmInput = (opts: GpmInputOptions): { stop(): void } | null => {
  const log = opts.log ?? (() => {});
  const term = opts.term ?? process.env.TERM ?? "";
  const exists = opts.envExists ?? existsSync;
  const hasCtl = exists(GPM_NODE_CTL);
  const ttyName = opts.ttyName ?? procTtyName;
  const ownTty = ttyName();
  log(`gpm: term=${term} gpmctl=${hasCtl ? "yes" : "no"} tty=${ownTty ?? "none"}`);
  if (!term.startsWith("linux")) {
    log("gpm: inert (not a linux console)");
    return null;
  }
  if (!hasCtl) {
    log("gpm: inert (no /dev/gpmctl)");
    return null;
  }
  let vc = vcFromTty(ownTty);
  if (vc === null && ownTty !== null && /^\/dev\/pts\/\d+$/.test(ownTty)) {
    // Pty-fronted session on a Linux console (asciinema rec, script(1)):
    // gpm still serves the physical console behind the pty. Never over ssh
    // (that would inject the *server's* console mouse) and never off a real
    // serial/null tty — those stay inert exactly as before.
    const env = opts.env ?? process.env;
    if (env.SSH_CLIENT || env.SSH_CONNECTION || env.SSH_TTY) {
      log(`gpm: inert (pty ${ownTty} in ssh session; fallback skipped)`);
      return null;
    }
    const activeVc =
      opts.activeVc ??
      ((): number | null => {
        try {
          return vcFromActiveConsole(readFileSync(SYSFS_ACTIVE_CONSOLE, "utf8"));
        } catch {
          return null;
        }
      });
    vc = activeVc();
    log(`gpm: pty fallback: active=${vc === null ? "none" : `vc ${vc}`} (console behind pty ${ownTty})`);
  }
  if (vc === null) {
    log("gpm: inert (no console vc)");
    return null;
  }

  let sock: GpmSocket;
  try {
    sock = (opts.connect ?? ((p: string): GpmSocket => netConnect(p) as unknown as Socket))(GPM_NODE_CTL);
  } catch (err) {
    log(`gpm: connect failed: ${err}`);
    return null;
  }

  // gpm may emit a partial frame then stall; keep the tail for the next chunk.
  let pending: Buffer = Buffer.alloc(0);
  let last = "";
  let stopped = false;
  const translate = makeGpmTranslator();

  const onData = (chunk: Buffer | Uint8Array): void => {
    if (stopped) return;
    const buf = Buffer.concat([pending, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
    let off = 0;
    while (buf.byteLength - off >= GPM_EVENT_SIZE) {
      const ev = parseGpmEvent(buf, off);
      off += GPM_EVENT_SIZE;
      if (!ev) continue;
      if (ev.vc !== vc) continue;
      // gpm re-sends an idle MOVE once a second — replaying it as hover would
      // repaint under a stationary cursor, so collapse exact duplicates.
      // ponytail: drops a genuine double-click's identical reposition too;
      // harmless for hover, add a timestamp window if that proves wrong.
      const sgr = translate(ev);
      if (!sgr) continue;
      if (sgr === last) continue;
      last = sgr;
      // button traffic is rare (motion stays quiet): log it so --debug shows
      // exactly what the daemon delivered vs what tfm consumed.
      if (ev.type & (GPM_DOWN | GPM_UP)) log(`gpm: ${sgr}`);
      try {
        opts.onBytes(sgr);
      } catch (err) {
        log(`gpm: onBytes failed: ${err}`);
      }
    }
    pending = buf.subarray(off);
  };

  sock.on("error", (err) => log(`gpm: socket error: ${err.message}`));
  (sock as unknown as { on(e: "data", cb: (c: Buffer) => void): unknown }).on("data", onData);

  try {
    sock.write(gpmConnectFrame(vc, process.pid));
  } catch (err) {
    log(`gpm: connect frame failed: ${err}`);
  }
  log(`gpm: attached on vc ${vc}`);

  return {
    stop: (): void => {
      if (stopped) return;
      stopped = true;
      try {
        sock.destroy();
      } catch {}
      pending = Buffer.alloc(0);
    },
  };
};
