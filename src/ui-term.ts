import { Box, EmbeddedTerminalRenderable, Text } from "@opentui/core";
import { clearChildren } from "./uiutil";
import { fsErrText } from "./fsutil";
import type { Theme } from "./config";

// --- Embedded terminal pane ("Open Terminal Here") ---
// OpenTUI's EmbeddedTerminalRenderable draws the VT stream; the PTY belongs to
// Bun.spawn({ terminal }). Keys route to the shell while focused; clicking the
// grid or sidebar hands focus back to tfm. Theme + renderer arrive via ctx;
// ids (tfm-term-host / tfm-term-header / tfm-term) stay byte-identical for
// index.ts's layout host box and rethemeChrome. ---

export type TermCtx = {
  renderer: any;
  byId(id: string): any;
  uiStyle(): "solid" | "outline";
  colors(): Theme & Record<string, any>;
  sw(): number;
  escHintBtn(id: string, onClose: () => void): any;
  stripSelectable(): void;
  drainIconQueue(): void;
  notify(message: string, title?: string): void;
  renderAll(): void;
  cwd(): string;
  virtualCwd(): boolean;
  home: string;
};

export const TERM_H = 12;

// "#rrggbb" -> xterm "rgb:RRRR/GGGG/BBBB" (8-bit channel doubled to 16-bit)
export const hexToRgb16 = (hex: string): string => {
  const b = (/^#?([0-9a-f]{6})$/i.exec(hex.trim()) ?? [, "ffffff"])[1];
  const ch = (i: number) => `${b.slice(i, i + 2)}${b.slice(i, i + 2)}`;
  return `${ch(0)}/${ch(2)}/${ch(4)}`;
};

// fish waits up to 10s for a Primary Device Attribute reply the embedded VT
// never sends (boot stalls with a "could not read response" warning). Answer
// the common probes inline; sequences may split across chunks, hence the tail.
export const terminalProbeReply = (buf: string): { resp: string; tail: string } => {
  let resp = "";
  if (/\x1b\[[0-9]*c/.test(buf)) resp += "\x1b[?62;1;2;6;9;15;22c"; // DA1 (tmux-style vt320)
  if (/\x1b\[>[0-9]*c/.test(buf)) resp += "\x1b[>0;0;0c";           // secondary DA
  if (/\x1b\[5n/.test(buf)) resp += "\x1b[0n";                      // device status OK
  const tail = /(?:\x1b|\x1b\[|\x1b\[>)[0-9=>]*$/.test(buf) ? buf.slice(-8) : "";
  return { resp, tail };
};

// XTSHIFTESCAPE (CSI > Ps s): ask the terminal (kitty, ghostty, xterm) to
// forward shift+click while tfm owns the mouse, release on quit. The final
// byte MUST be `s` — `n` is silently ignored. Terminals that don't know the
// sequence ignore it; alt+click is the universal fallback.
export const xtShiftEscapeFrame = (enable: boolean): string => (enable ? "\x1b[>1s" : "\x1b[>0s");

export const makeTerminal = (ctx: TermCtx) => {
  let term: EmbeddedTerminalRenderable | null = null;
  let termChild: ReturnType<typeof Bun.spawn> | null = null;
  let termFocused = false;

  // the flag can lag reality (click-refocus inside the pane bypasses our focus()
  // call) — ask the renderer who owns the keyboard before acting on keys
  const termHasFocus = (): boolean =>
    !!term && ctx.renderer.currentFocusedRenderable === (term as any);

  const blurTerminal = (): void => {
    if (!termFocused) return;
    try { term?.blur(); } catch {}
    termFocused = false;
  };

  // make the embedded terminal match the tfm theme: OSC 4 sets the 16-color
  // palette (so ls/vim/prompts stop floating on stock xterm hues) and
  // OSC 10/11/12 set the default fg/bg/cursor
  const syncTerminalTheme = (): void => {
    if (!term) return;
    const colors = ctx.colors();
    try {
      const enc = new TextEncoder();
      const spec = (hex: string) => `rgb:${hexToRgb16(hex)}`;
      const osc4 = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]
        .map((i) => `${i};${spec((colors as any)[`ansi${i}`] ?? colors.white)}`)
        .join(";");
      term.write(new Uint8Array([
        ...enc.encode(`\x1b]4;${osc4}\x1b\\`),
        ...enc.encode(`\x1b]10;${spec(colors.white)}\x1b\\`),
        ...enc.encode(`\x1b]11;${spec(colors.bg)}\x1b\\`),
        ...enc.encode(`\x1b]12;${spec(colors.accent)}\x1b\\`),
      ]));
    } catch {}
  };

  const closeTerminalPane = (): void => {
    try { term?.blur(); } catch {};
    try { termChild?.kill(); } catch {};
    try { (termChild as any)?.terminal?.close(); } catch {};
    termChild = null;
    try { term?.destroy(); } catch {};
    term = null;
    termFocused = false;
    const host: any = ctx.byId("tfm-term-host");
    if (host) { clearChildren(host); host.height = 0; }
    ctx.renderAll();
  };

  const termProbeEnc = new TextEncoder();
  let termProbeTail = "";
  const answerTerminalProbes = (data: Uint8Array): void => {
    try {
      const pty = (termChild as any)?.terminal;
      if (!pty) return;
      const buf = termProbeTail + new TextDecoder().decode(data);
      const { resp, tail } = terminalProbeReply(buf);
      if (resp) pty.write(termProbeEnc.encode(resp));
      termProbeTail = tail;
    } catch {}
  };

  const openTerminalHere = (dir?: string): void => {
    if (!ctx.renderer.resolution) return;
    if (term) { try { term.focus(); } catch {}; termFocused = true; return; }
    const host: any = ctx.byId("tfm-term-host");
    if (!host) return;
    const colors = ctx.colors();
    const cwd = dir ?? (ctx.virtualCwd() ? ctx.home : ctx.cwd());
    host.height = TERM_H + 1;
    const header = Box(
      { id: "tfm-term-header", width: "100%", height: 1, flexDirection: "row", paddingLeft: 1, ...(ctx.uiStyle() === "outline" ? {} : { backgroundColor: colors.sidebarBg }) },
      Text({ content: ` terminal · ${cwd}`, fg: colors.sidebarFgMuted }),
      Box({ flexGrow: 1 }),
      ctx.escHintBtn("tfm-esc-term", closeTerminalPane),
    );
    term = new EmbeddedTerminalRenderable(ctx.renderer, {
      id: "tfm-term",
      width: "100%",
      height: TERM_H,
      cols: Math.max(20, ctx.renderer.terminalWidth - ctx.sw()),
      rows: TERM_H,
      maxScrollback: 20_000,
      onData: (data: Uint8Array) => {
        (termChild as any)?.terminal?.write(data);
      },
      onTerminalResize: (cols: number, rows: number) => {
        try { (termChild as any)?.terminal?.resize(cols, rows); } catch {}
      },
    });
    host.add(header);
    host.add(term);
    ctx.stripSelectable();
    const shell = process.env.SHELL || "/bin/bash";
    try {
      termChild = Bun.spawn([shell], {
        cwd,
        env: { ...process.env, TERM: "xterm-256color", COLORTERM: "truecolor" },
        terminal: {
          cols: Math.max(20, ctx.renderer.terminalWidth - ctx.sw()),
          rows: TERM_H,
          data(_pty: any, data: Uint8Array) {
            answerTerminalProbes(data);
            try { term?.write(data); } catch {}
          },
        },
      } as any);
    } catch (err) {
      ctx.notify(`terminal failed (${fsErrText(err)})`, "terminal");
      closeTerminalPane();
      return;
    }
    termChild.exited.then(() => { if (termChild) closeTerminalPane(); }).catch(() => {});
    syncTerminalTheme();
    void ctx.drainIconQueue();
    ctx.renderAll();
    setTimeout(() => {
      try { term?.focus(); termFocused = true; } catch {}
      // early prompt bytes can compose before first layout — force a full redraw
      try { term?.invalidate(); } catch {}
    }, 30);
  };

  return { openTerminalHere, closeTerminalPane, syncTerminalTheme, termHasFocus, blurTerminal, ownsKeyboard: () => termFocused || termHasFocus() };
};
