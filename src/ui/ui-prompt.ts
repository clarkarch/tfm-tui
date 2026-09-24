// --- Single-line text prompt overlay: the plugin git-URL entry field. A
// centered floating panel with a title + X close button, one Input, and
// Cancel/OK buttons (mouse-first like every dialog). The X is the shared
// icon-slot close button, so the open drains the icon queue like esc-menu.
// Promise-based: open() resolves to the trimmed input on submit, null on
// cancel/close. A floats-initiated close settles pending as null (like the
// conflict prompt resolving "skip") so no promise dangles. Opening replaces
// pick via the floats modal policy (depth stays 1).
// Widget-extraction seam (see ui-dialogs.ts): all live deps arrive via ctx. ---

import { Box, type CliRenderer, Input, type MouseEvent, RGBA, Text } from "@opentui/core";
import { floatSurface } from "./style";
import type { Theme } from "../config/config";
import type { UiStyle } from "../config/config-schema";
import type { Floats } from "./floats";
import type { MaybeNode } from "../lib/node-like";
import type { SlotElement } from "./ui-slots";

type PromptCtx = {
  renderer(): CliRenderer;
  byId(id: string): MaybeNode;
  rootAdd(node: unknown): void;
  stripSelectable(): void;
  escHintBtn(id: string, onClose: () => void): SlotElement;
  drainIconQueue(): void | Promise<void>;
  colors(): Theme;
  uiStyle(): UiStyle;
  floats: Floats;
};

const PANEL_W = 62;

export const makePrompt = (ctx: PromptCtx) => {
  let opened = false;
  let resolveFn: ((v: string | null) => void) | null = null;
  let focusTimer: ReturnType<typeof setTimeout> | null = null;
  // password mode: no Input (OpenTUI can't mask one); the router feeds keys to
  // handleKey, which keeps the secret private and paints bullets instead
  let passwordMode = false;
  let secret = "";

  const paintMask = (): void => {
    try {
      const node = ctx.byId("tfm-prompt-mask");
      if (!node) return;
      node.content = secret ? "•".repeat(secret.length) : "Password";
      node.fg = secret ? ctx.colors().white : ctx.colors().sidebarFgMuted;
    } catch {}
  };

  const readValue = (): string => {
    if (passwordMode) return secret;
    try {
      return String(ctx.byId("tfm-prompt-input")?.value ?? "").trim();
    } catch {
      return "";
    }
  };

  const rawClose = (): void => {
    opened = false;
    passwordMode = false;
    secret = "";
    if (focusTimer !== null) {
      clearTimeout(focusTimer);
      focusTimer = null;
    }
    try {
      ctx.byId("tfm-prompt-input")?.blur?.();
    } catch {}
    const scrim = ctx.byId("tfm-prompt");
    scrim?.parent?.remove(scrim);
    // floats-initiated teardown (policy dismissal / replace) settles a
    // pending open as cancel — never leave the awaiter hanging
    const r = resolveFn;
    resolveFn = null;
    r?.(null);
  };

  const close = (): void => {
    ctx.floats.close("prompt");
  };

  const submit = (): void => {
    const v = readValue();
    // empty submit keeps the prompt open (the caller re-prompts with a
    // validation toast instead of installing nothing)
    if (!v) return;
    const r = resolveFn;
    resolveFn = null;
    r?.(v);
    close();
  };

  const cancel = (): void => {
    const r = resolveFn;
    resolveFn = null;
    r?.(null);
    close();
  };

  const open = (opts: {
    title: string;
    placeholder?: string;
    okLabel?: string;
    initial?: string;
    password?: boolean;
  }): Promise<string | null> =>
    new Promise<string | null>((resolve) => {
      // re-invoking while open replaces (same rule as pick): the stale
      // pending settles as cancel so floats depth never exceeds 1
      if (opened) close();
      ctx.floats.open("prompt", rawClose);
      opened = true;
      passwordMode = !!opts.password;
      secret = "";
      resolveFn = resolve;
      const c = ctx.colors();
      const okLabel = opts.okLabel ?? "OK";
      const btn = (id: string, label: string, fg: string, onPick: () => void): ReturnType<typeof Box> =>
        Box(
          {
            id,
            height: 1,
            flexGrow: 1,
            flexDirection: "row",
            justifyContent: "center",
            onMouseDown: (ev: MouseEvent) => {
              try {
                ev.stopPropagation?.();
              } catch {}
              onPick();
            },
          },
          Text({ content: label, fg }),
        );
      const scrim = Box(
        {
          id: "tfm-prompt",
          position: "absolute",
          left: 0,
          top: 0,
          width: "100%",
          height: "100%",
          alignItems: "center",
          justifyContent: "center",
          zIndex: 3750,
          backgroundColor: RGBA.fromInts(0, 0, 0, 150),
          onMouseDown: () => cancel(),
        },
        Box(
          {
            id: "tfm-prompt-panel",
            width: PANEL_W,
            ...floatSurface(ctx.uiStyle(), ctx.colors(), ctx.colors().sidebarBg),
            paddingTop: 1,
            paddingBottom: 1,
            flexDirection: "column",
            onMouseDown: (ev: MouseEvent) => {
              try {
                ev.stopPropagation?.();
              } catch {}
            },
          },
          Box(
            { width: "100%", height: 1, flexDirection: "row", alignItems: "center", paddingLeft: 2, paddingRight: 1 },
            Text({ content: opts.title.slice(0, PANEL_W - 8), fg: c.accent }),
            Box({ flexGrow: 1 }),
            ctx.escHintBtn("tfm-prompt-esc", () => cancel()),
          ),
          Box(
            // no fixed height: height 1 + paddingTop 1 overflows a 1-row box
            // and the input paints underneath the next sibling (invisible
            // whenever that row paints anything) — auto height fits both
            { width: "100%", paddingLeft: 2, paddingRight: 2, paddingTop: 1 },
            opts.password
              ? Text({ id: "tfm-prompt-mask", content: "Password", fg: c.sidebarFgMuted })
              : Input({
                  id: "tfm-prompt-input",
                  width: PANEL_W - 6,
                  placeholder: opts.placeholder ?? "",
                  backgroundColor: c.accentBg,
                  focusedBackgroundColor: c.accentBg,
                  textColor: c.white,
                  ...(opts.initial ? { value: opts.initial } : {}),
                }),
          ),
          // breathing room above the buttons: fixed height + padding OVERFLOWS
          // a 1-row box in @opentui/core 0.5.9 (the input painted underneath
          // the next sibling and vanished whenever that row painted), so the
          // input wrapper above uses auto height — and a childless spacer box
          // collapses to zero rows while a plain " " measures empty, so a
          // non-breaking space forces this row to lay out while painting blank
          Box({ width: "100%", height: 1 }, Text({ content: "\u00A0", fg: c.sidebarFgMuted })),
          Box(
            {
              width: "100%",
              height: 1,
              flexDirection: "row",
              columnGap: 2,
              paddingLeft: 2,
              paddingRight: 2,
            },
            btn("tfm-prompt-cancel", "[ Cancel ]", c.white, () => cancel()),
            btn("tfm-prompt-ok", `[ ${okLabel} ]`, c.accent, () => submit()),
          ),
        ),
      );
      ctx.rootAdd(scrim);
      ctx.stripSelectable();
      void ctx.drainIconQueue();
      // focus after mount (same deferred pattern as pick: focusing a
      // pre-mount node is a silent no-op); the timer dies with the prompt
      // (hidden inputs keep renderer focus — see the clearSearch lesson).
      // Password mode has no Input to focus — the router feeds it keys.
      if (!passwordMode) {
        focusTimer = setTimeout(() => {
          focusTimer = null;
          try {
            ctx.byId("tfm-prompt-input")?.focus?.();
          } catch {}
        }, 10);
      }
    });

  const handleKey = (ev: {
    name?: string;
    sequence?: unknown;
    ctrl?: boolean;
    control?: boolean;
    meta?: boolean;
  }): boolean => {
    if (ev.name === "escape") cancel();
    else if (ev.name === "return") submit();
    else if (passwordMode) {
      // no Input in password mode — collect the masked secret here
      if (ev.name === "backspace" || ev.name === "delete") {
        secret = secret.slice(0, -1);
        paintMask();
      } else {
        const ctrl = !!ev.ctrl || !!ev.control;
        const seq = typeof ev.sequence === "string" ? ev.sequence : "";
        const ch = seq.length === 1 && seq.charCodeAt(0) >= 0x20 ? seq : "";
        if (ch && !ctrl && !ev.meta) {
          secret += ch;
          paintMask();
        }
      }
    }
    // everything else (typing) reaches the focused Input natively in normal
    // mode — the keymap swallows the event around us either way (same as pick)
    return true;
  };

  return {
    open,
    close,
    handleKey,
    isOpen: (): boolean => opened,
    // test seam: drive the value without Input events
    setValue: (v: string): void => {
      if (passwordMode) {
        secret = v;
        paintMask();
        return;
      }
      try {
        const input = ctx.byId("tfm-prompt-input");
        if (input) input.value = v;
      } catch {}
    },
  };
};
