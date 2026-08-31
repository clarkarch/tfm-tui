import { Box, EmbeddedTerminalRenderable, Text } from "@opentui/core";
import { clearChildren } from "./uiutil";
import { fsErrText } from "./fsutil";
import { applySurface } from "./style";
import { gridDrag } from "./grid-input";
import type { Theme } from "./config";

// --- Embedded terminal pane ("Open Terminal Here") ---
// OpenTUI's EmbeddedTerminalRenderable draws the VT stream; the PTY belongs to
// Bun.spawn({ terminal }). Keys route to the shell while focused; clicking the
// grid or sidebar hands focus back to tfm. Theme + renderer arrive via ctx;
// ids (tfm-term-host / tfm-term-header / tfm-term) stay byte-identical for
// index.ts's layout host box and rethemeChrome. The host box is also the
// internal-drop target: ctrl+dragging files here pastes shell-quoted paths
// into the PTY (the VT never registers a "drop" mouse listener, so the event
// bubbles up to the host).

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
  finishDrag(): void;                 // ends an internal drag (finishDragState)
  dlog(msg: string): void;
};

export const TERM_H = 12;

// "#rrggbb" -> xterm "rgb:RRRR/GGGG/BBBB" (8-bit channel doubled to 16-bit)
export const hexToRgb16 = (hex: string): string => {
  const b = (/^#?([0-9a-f]{6})$/i.exec(hex.trim()) ?? ["", "ffffff"])[1];
  const ch = (i: number) => `${b.slice(i, i + 2)}${b.slice(i, i + 2)}`;
  return `${ch(0)}/${ch(2)}/${ch(4)}`;
};

// fish waits up to 10s for a Primary Device Attribute reply the embedded VT
// never sends (boot stalls with a "could not read response" warning). Answer
// the common probes inline; sequences may split across chunks, hence the tail.
export const terminalProbeReply = (buf: string): { resp: string; tail: string } => {
  let resp = "";
  // VT probe sequences are literal control bytes by nature (biome-ignore below)
  // biome-ignore lint/suspicious/noControlCharactersInRegex: ESC is the byte terminals send
  if (/\x1b\[[0-9]*c/.test(buf)) resp += "\x1b[?62;1;2;6;9;15;22c"; // DA1 (tmux-style vt320)
  // biome-ignore lint/suspicious/noControlCharactersInRegex: ESC is the byte terminals send
  if (/\x1b\[>[0-9]*c/.test(buf)) resp += "\x1b[>0;0;0c";           // secondary DA
  // biome-ignore lint/suspicious/noControlCharactersInRegex: ESC is the byte terminals send
  if (/\x1b\[5n/.test(buf)) resp += "\x1b[0n";                      // device status OK
  // biome-ignore lint/suspicious/noControlCharactersInRegex: partial-ESC tail detection
  const tail = /(?:\x1b|\x1b\[|\x1b\[>)[0-9=>]*$/.test(buf) ? buf.slice(-8) : "";
  return { resp, tail };
};

// XTSHIFTESCAPE (CSI > Ps s): ask the terminal (kitty, ghostty, xterm) to
// forward shift+click while tfm owns the mouse, release on quit. The final
// byte MUST be `s` — `n` is silently ignored. Terminals that don't know the
// sequence ignore it; alt+click is the universal fallback.
export const xtShiftEscapeFrame = (enable: boolean): string => (enable ? "\x1b[>1s" : "\x1b[>0s");

// single-quote a path for shell input; embedded quotes use the '\'' idiom,
// which survives every POSIX shell
export const shellQuotePath = (p: string): string => `'${p.replace(/'/g, `'\\''`)}'`;
export const shellQuotePaths = (paths: string[]): string => paths.map(shellQuotePath).join(" ");

export type TermDropSink = {
  ptyWrite(s: string): void;
  focusTerm(): void;
  finishDrag(): void;
  paintCue(hot: boolean): void;
  log(msg: string): void;
};

// drop→terminal semantics: paste shell-quoted paths with a trailing space (no
// newline — the command stays editable, like GNOME Terminal's file drop) and
// focus the pane. Drag cleanup + cue reset run even on an empty payload so a
// stray release never leaves stale drag state behind. Returns true when text
// actually reached the PTY.
export const pasteDroppedPaths = (paths: string[] | null | undefined, sink: TermDropSink): boolean => {
  sink.finishDrag();
  sink.paintCue(false);
  if (!paths?.length) return false;
  sink.ptyWrite(`${shellQuotePaths(paths)} `);
  sink.focusTerm();
  sink.log(`term drop n=${paths.length}`);
  return true;
};

// --- Prompt-click bridge ---
// fish never enables mouse reporting; prompt clicks only work in terminals
// that implement kitty's OSC 133 click_events (which OpenTUI's VT does not).
// tfm bridges the common case itself: a left click on the cursor's row is
// translated into forward/backward-char arrows, clamped to the line text.
// Only valid while the inner program has NO mouse mode and NO alt screen —
// those apps receive real mouse bytes instead.

export type PtyScreenState = { mouse: boolean; alt: boolean };

// scan PTY output for DECSET/DECRST 1000/1002/1003 (mouse reporting) and 1049
// (alt screen). Sequences may split across chunks — the caller carries `tail`.
export const ptyScreenState = (
  chunk: string,
  prev: PtyScreenState,
): { state: PtyScreenState; tail: string } => {
  const state = { ...prev };
  // biome-ignore lint/suspicious/noControlCharactersInRegex: DECSET sequences are literal control bytes
  const re = /\x1b\[\?(1000|1002|1003|1049)(h|l)/g;
  let m: RegExpExecArray | null;
  // biome-ignore lint/suspicious/noAssignInExpressions: classic exec-loop idiom
  while ((m = re.exec(chunk))) {
    const on = m[2] === "h";
    if (m[1] === "1049") state.alt = on;
    else state.mouse = on;
  }
  return { state, tail: chunk.slice(-8) };
};

// same-row prompt click → arrow bytes; null when the click lands on another
// row (fish can't move between lines either), on the cursor cell, or past the
// line end (that would accept autosuggestion characters)
export const promptClickArrows = (
  cursorX: number,
  cursorRow: number,
  clickX: number,
  clickRow: number,
  lineText: string,
): string | null => {
  if (clickRow !== cursorRow || clickX === cursorX) return null;
  const lastTextCol = Math.max(0, lineText.trimEnd().length - 1);
  const target = Math.min(clickX, lastTextCol);
  const dx = target - cursorX;
  if (dx === 0) return null;
  return (dx > 0 ? "\x1b[C" : "\x1b[D").repeat(Math.min(Math.abs(dx), 200));
};

export const makeTerminal = (ctx: TermCtx) => {
  let term: EmbeddedTerminalRenderable | null = null;
  let termChild: ReturnType<typeof Bun.spawn> | null = null;
  let termFocused = false;
  let headerHot = false; // drag-hover cue latched — avoids redundant repaints
  let ptyScreen: PtyScreenState = { mouse: false, alt: false };
  let ptyScanTail = ""; // DECSET sequences can split across PTY chunks
  let downCell: { x: number; y: number } | null = null; // click vs drag for the prompt bridge

  // the flag can lag reality (click-refocus inside the pane bypasses our focus()
  // call) — ask the renderer who owns the keyboard before acting on keys
  const termHasFocus = (): boolean =>
    !!term && ctx.renderer.currentFocusedRenderable === (term as any);

  // drop-target cue: light the header while an internal drag hovers the pane
  // (rest fill follows the ui-style seam — none in outline mode)
  const paintHeaderCue = (hot: boolean): void => {
    if (hot === headerHot) return;
    headerHot = hot;
    const header: any = ctx.byId("tfm-term-header");
    if (!header) return;
    try {
      const colors = ctx.colors();
      applySurface(header, hot
        ? { backgroundColor: colors.hoverBg }
        : ctx.uiStyle() === "solid" ? { backgroundColor: colors.sidebarBg } : {});
    } catch {}
  };

  // release over the pane: paste the drag payload as quoted paths into the
  // shell. Payload is read from the shared gridDrag singleton BEFORE cleanup
  // (finishDragState nulls it), same order as the place/tab drop handlers.
  const handleTermDrop = (): void => {
    const keys = gridDrag.keys;
    const pty: any = termChild ? (termChild as any)?.terminal ?? null : null;
    pasteDroppedPaths(pty ? keys?.map((k) => k.path) ?? null : null, {
      ptyWrite: (s) => { try { pty.write(new TextEncoder().encode(s)); } catch {} },
      focusTerm: () => { try { term?.focus(); termFocused = true; } catch {} },
      finishDrag: ctx.finishDrag,
      paintCue: paintHeaderCue,
      log: (m) => ctx.dlog(m),
    });
  };

  // prompt-click bridge: fish/bash don't use mouse reporting, so a left click
  // at the prompt reaches no one. Translate same-row clicks into char-movement
  // arrows (what kitty's OSC 133 click_events does for fish). Skipped while a
  // mouse-aware program owns the input — those get real mouse bytes from the VT.
  const bridgePromptClick = (ev: any): void => {
    if (!term || !termChild || ev.button !== 0) return;
    if (ptyScreen.mouse || ptyScreen.alt) return;
    const screen = term.screen();
    if (!screen.cursor.visible) return;
    const clickX = ev.x - (term as any).screenX;
    const clickRow = ev.y - (term as any).screenY;
    const bytes = promptClickArrows(
      screen.cursor.x,
      screen.cursor.y,
      clickX,
      clickRow,
      screen.lines[screen.cursor.y] ?? "",
    );
    if (!bytes) return;
    try { (termChild as any)?.terminal?.write(new TextEncoder().encode(bytes)); } catch {}
  };

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
    headerHot = false;
    ptyScreen = { mouse: false, alt: false };
    ptyScanTail = "";
    downCell = null;
    const host: any = ctx.byId("tfm-term-host");
    if (host) {
      clearChildren(host);
      host.height = 0;
      // the pane is gone — the host must stop acting as a drop target
      try { host.onMouseOver = undefined; } catch {}
      try { host.onMouseOut = undefined; } catch {}
      try { host.onMouseDrop = undefined; } catch {}
    }
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
    // the host box is the pane's drop target: over/out give the drag-hover cue,
    // drop pastes the payload into the PTY (see handleTermDrop)
    host.onMouseOver = () => { if (gridDrag.active) paintHeaderCue(true); };
    host.onMouseOut = () => { paintHeaderCue(false); };
    host.onMouseDrop = handleTermDrop;
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
      // the bridge tracks press→release movement itself (a plain click still
      // reports isDragging on up — Selection defaults it to true)
      onMouseDown: (ev: any) => { downCell = { x: ev.x, y: ev.y }; },
      onMouseUp: (ev: any) => {
        const wasClick = !!downCell && downCell.x === ev.x && downCell.y === ev.y;
        downCell = null;
        if (wasClick) bridgePromptClick(ev);
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
            // sniff mouse-mode/alt-screen DECSETs (split-safe) for the bridge
            const scan = ptyScreenState(ptyScanTail + new TextDecoder().decode(data), ptyScreen);
            ptyScreen = scan.state;
            ptyScanTail = scan.tail;
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
