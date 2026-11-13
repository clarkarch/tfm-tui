import { Box, createTextAttributes, type MouseEvent, Text } from "@opentui/core";
import type { VChild } from "@opentui/core";
import path from "node:path";
import { applySurface, btnSurface, floatSurface, isFloatingOutline, type UiStyle } from "./style";
import type { Theme } from "../config/config";
import { FLOAT_Z, type Floats } from "./floats";
import type { MaybeNode } from "../lib/node-like";
import type { PointerStyle } from "../lib/pointer";
import type { ConfirmOutcome, ConfirmRequest } from "../lib/confirm-outcome";
import type { NotifyLevel } from "../lib/notify-level";
import { hoverEvents, type SlotElement } from "./ui-slots";
import type { ConflictAnswer, ConflictChoice } from "../lib/file-op-protocol";

// --- Shared skeleton for the centered floating dialogs (conflict / props /
// yesno): full-screen transparent click-catcher + a chrome panel that swallows
// clicks, teardown is one scrim removal. Callers supply id/zIndex/width and
// build their panel rows fresh (they close over live state). Theme and
// renderer access arrive through ctx. ---

type DialogsCtx = {
  byId(id: string): MaybeNode;
  rootAdd(node: unknown): void;
  stripSelectable(): void;
  termH(): number;
  uiStyle(): UiStyle;
  colors(): Theme;
  // skeleton baseline for ANY future dialog: the context menu floats above
  // every modal, so a scrim must never come up under an open menu. The real
  // dismiss-others policy lives in ./floats (modal open clears the desktop);
  // conflict/yesno/props route their opens through floats — this call is the
  // safety net for dialogs that don't.
  closeFileMenu(): void;
  // mouse pointer shape (OSC 22 via the wiring's tty-guarded setter).
  // Absent = no pointer changes (old fakes keep working).
  setPointer?(style: PointerStyle): void;
};

// The modal-scrim skeleton every floating panel opens with (pick/prompt/
// bulk-rename/esc-menu): absolute scrim + floatSurface panel that stops click
// propagation so an inside click never dismisses. Deps arrive directly (same
// seam as the widgets' ctx) — no ctx-type plumbing. ids must stay byte-
// identical (rethemeChrome repaints them by id). The scrim Box itself is a
// transparent click-catcher, never a fill — a fill makes OpenTUI delete the
// rasters it covers, which is why [ui] scrim dims via the content node's
// opacity instead of an overlay.
export const makeModalScrim = (
  deps: {
    uiStyle: () => UiStyle;
    colors: () => Theme;
  },
  opts: {
    id: string;
    zIndex: number;
    panelWidth: number;
    onClose: () => void;
    // extra panel mousedown (esc-menu's capture cancel) — runs after the
    // stopPropagation, so the scrim handler never sees it
    panelMouseDown?: (ev: MouseEvent) => void;
  },
  ...children: VChild[]
): unknown =>
  Box(
    {
      id: opts.id,
      position: "absolute",
      left: 0,
      top: 0,
      width: "100%",
      height: "100%",
      alignItems: "center",
      justifyContent: "center",
      zIndex: opts.zIndex,
      // transparent click-catcher (see the scrim note above)
      onMouseDown: () => opts.onClose(),
    },
    Box(
      {
        id: `${opts.id}-panel`,
        width: opts.panelWidth,
        ...floatSurface(deps.uiStyle(), deps.colors(), deps.colors().sidebarBg),
        paddingTop: 1,
        paddingBottom: 1,
        flexDirection: "column",
        onMouseDown: (ev: MouseEvent) => {
          try {
            ev.stopPropagation?.();
          } catch {}
          opts.panelMouseDown?.(ev);
        },
      },
      ...children,
    ),
  );

export const makeDialogs = (ctx: DialogsCtx) => {
  const openDialog = (opts: {
    id: string;
    zIndex: number;
    width: number;
    paddingDiv?: number; // vertical centering divisor: terminalHeight / this (3, props uses 4)
    rows: () => SlotElement[];
    onClose: () => void;
  }): void => {
    ctx.closeFileMenu();
    const scrim = Box(
      {
        id: opts.id,
        position: "absolute",
        left: 0,
        top: 0,
        width: "100%",
        height: "100%",
        alignItems: "center",
        paddingTop: Math.max(2, Math.round(ctx.termH() / (opts.paddingDiv ?? 3))),
        zIndex: opts.zIndex,
        // transparent click-catcher (see the scrim note above)
        onMouseDown: () => opts.onClose(),
      },
      Box(
        {
          id: `${opts.id}-panel`,
          width: opts.width,
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
        ...opts.rows(),
      ),
    );
    ctx.rootAdd(scrim);
    ctx.stripSelectable();
  };

  const closeDialog = (id: string): void => {
    const scrim = ctx.byId(id);
    scrim?.parent?.remove(scrim);
  };

  return { openDialog, closeDialog };
};

// --- Override/conflict prompt ("Replace …?") for transfer/rename collisions ---
// State + promise plumbing live here. The "…all" choice (apply this answer to
// the whole remaining batch) rides in the ANSWER — the CALLER owns the batch
// policy, so it can never outlive the operation (the old module-level policy
// needed three manual resetPolicy() calls, and a path that forgot one made
// the next unrelated collision auto-resolve as "replace").

type ConflictCtx = {
  colors(): Theme;
  uiStyle(): UiStyle;
  byId(id: string): MaybeNode;
  drainIconQueue(): void | Promise<void>;
  // open/close orchestration + the dismiss-others policy live in ./floats
  floats: Floats;
  // mouse pointer shape (OSC 22 via the wiring's tty-guarded setter).
  // Absent = no pointer changes (old fakes keep working).
  setPointer?(style: PointerStyle): void;
};

// ONE explicit phase. The old state was three parallel fields
// (`conflictPolicy`, `conflictOpen`, `conflictResolveFn`): `conflictOpen` was
// cleared only INDIRECTLY (via floats.close → the raw teardown), so a
// teardown that never ran — or one that threw halfway — left the prompt
// "open" while its layer was gone. isOpen() gates the key router, so a stuck
// true swallows EVERY key (a permanent keyboard deadlock).
type ConflictState = { kind: "closed" } | { kind: "open"; resolve: (answer: ConflictAnswer) => void };

export const makeConflict = (dialogs: ReturnType<typeof makeDialogs>, ctx: ConflictCtx) => {
  const { openDialog, closeDialog } = dialogs;

  // The conflict prompt's options: bracketed, one row per choice, a HOVER
  // fill and no keyboard cursor. They are NOT the yes/no dialog's cursor
  // options (a different widget — a bare word in an accent block), so they
  // live here rather than in the shared skeleton.
  const dialogBtn = (id: string, label: string, fg: string, onPick: () => void): ReturnType<typeof Box> => {
    const setBg = (on: boolean) => {
      const n = ctx.byId(id);
      if (n) applySurface(n, btnSurface(ctx.uiStyle(), ctx.colors(), on, ctx.colors().sidebarBg));
    };
    return Box(
      {
        id,
        height: 1,
        flexGrow: 1,
        flexDirection: "row",
        justifyContent: "center",
        ...btnSurface(ctx.uiStyle(), ctx.colors(), false, ctx.colors().sidebarBg),
        onMouseDown: (ev: MouseEvent) => {
          try {
            ev.stopPropagation?.();
          } catch {}
          onPick();
        },
        // the one hover wiring (see ui-slots.hoverEvents) — move, not over
        ...hoverEvents(setBg, ctx.setPointer),
      },
      Text({ content: label, fg }),
    );
  };

  const CONFLICT_W = 48;
  let state: ConflictState = { kind: "closed" };

  // raw teardown — registered with floats at open time; a floats-initiated
  // close (policy dismissal / replace) resolves a pending prompt as "skip".
  // The state is cleared FIRST and the pending prompt is resolved BEFORE the
  // best-effort teardown work: a failing native remove must never leave the
  // prompt "open" (isOpen() gates the key router — a stuck true swallows
  // EVERY key) nor strand the pending op.
  const rawTeardown = (): void => {
    const r = state.kind === "open" ? state.resolve : null;
    state = { kind: "closed" };
    r?.({ choice: "skip" });
    try {
      closeDialog("tfm-conflict");
    } catch {}
    // hovered buttons have no out (their nodes are gone) — restore here
    try {
      ctx.setPointer?.("default");
    } catch {}
  };

  // settle the prompt with an answer and take the layer down. The state is
  // cleared directly (not via the floats teardown) — closing a prompt whose
  // layer is no longer on the stack must still clear it.
  const settle = (answer: ConflictAnswer): void => {
    const r = state.kind === "open" ? state.resolve : null;
    state = { kind: "closed" };
    r?.(answer);
    ctx.floats.close("conflict");
  };

  const closeConflict = (choice: ConflictChoice, applyToRest?: ConflictChoice): void => {
    settle(applyToRest ? { choice, applyToRest } : { choice });
  };

  const promptConflict = (destPath: string, remaining: number): Promise<ConflictAnswer> =>
    new Promise<ConflictAnswer>((resolve) => {
      // floats.open dismisses every other floating layer (menu, props, …) —
      // the prompt must be the only thing on screen
      ctx.floats.open("conflict", rawTeardown);
      state = { kind: "open", resolve };
      const c = ctx.colors();
      const name = path.basename(destPath);
      const parentName = path.basename(path.dirname(destPath)) || "/";
      let bseq = 0;
      const mkBtn = (label: string, onPick: () => void): ReturnType<typeof Box> =>
        dialogBtn(`tfm-conflict-b${bseq++}`, label, c.white, onPick);
      const pick = (choice: ConflictChoice, all?: ConflictChoice) => {
        closeConflict(choice, all);
      };
      // hard-sliced names used to truncate silently — same-prefix files in
      // one folder were indistinguishable at the exact moment of choice
      const ellipsize = (s: string, max: number): string =>
        s.length > max ? `${s.slice(0, Math.max(0, max - 1))}…` : s;
      const locationLine = ` an item called "${name}" already exists in ${parentName}`;
      const rows: ReturnType<typeof Box>[] = [
        Box(
          { width: "100%", height: 1, paddingLeft: 1, paddingRight: 1 },
          Text({ id: "tfm-conflict-title", content: ` Replace "${ellipsize(name, CONFLICT_W - 14)}"?`, fg: c.accent }),
        ),
        Box(
          { width: "100%", height: 1, paddingLeft: 1, paddingRight: 1 },
          Text({ id: "tfm-conflict-div", content: ` ${"~".repeat(CONFLICT_W - 2)}`, fg: c.divider }),
        ),
        Box(
          { width: "100%", height: 1, paddingLeft: 1, paddingRight: 1 },
          Text({
            id: "tfm-conflict-loc",
            content: ellipsize(locationLine, CONFLICT_W - 1),
            fg: c.sidebarFgMuted,
          }),
        ),
        Box({ height: 1 }),
        Box(
          { width: "100%", height: 1, flexDirection: "row", columnGap: 1, paddingLeft: 1, paddingRight: 1 },
          mkBtn("[ Replace ]", () => pick("replace")),
          mkBtn("[ Keep both ]", () => pick("keepBoth")),
          mkBtn("[ Skip ]", () => pick("skip")),
        ),
      ];
      if (remaining > 0) {
        rows.push(
          Box({ height: 1 }),
          Box(
            { width: "100%", height: 1, flexDirection: "row", columnGap: 1, paddingLeft: 1, paddingRight: 1 },
            mkBtn("[ Replace all ]", () => pick("replace", "replace")),
            mkBtn("[ Keep both all ]", () => pick("keepBoth", "keepBoth")),
            mkBtn("[ Skip rest ]", () => pick("skip", "skip")),
          ),
        );
      }
      openDialog({
        id: "tfm-conflict",
        zIndex: FLOAT_Z.conflict,
        width: CONFLICT_W,
        rows: () => rows,
        onClose: () => closeConflict("skip"),
      });
      void ctx.drainIconQueue();
    });

  // theme-switch repaint while open: panel + texts by id, buttons back to
  // rest (hover repaints live on the next mouse move). No rebuild — the
  // pending promise survives.
  const repaintConflict = (): void => {
    if (state.kind !== "open") return;
    const c = ctx.colors();
    try {
      const panel = ctx.byId("tfm-conflict");
      if (panel) applySurface(panel, floatSurface(ctx.uiStyle(), c, c.sidebarBg));
    } catch {}
    const setFg = (id: string, fg: string): void => {
      try {
        const n = ctx.byId(id);
        if (n) n.fg = fg;
      } catch {}
    };
    setFg("tfm-conflict-title", c.accent);
    setFg("tfm-conflict-div", c.divider);
    setFg("tfm-conflict-loc", c.sidebarFgMuted);
    // 3 buttons, 6 with the …all row — loop the id space, skip the missing
    for (let i = 0; i < 8; i++) {
      try {
        const btn = ctx.byId(`tfm-conflict-b${i}`);
        if (!btn) continue;
        applySurface(btn, btnSurface(ctx.uiStyle(), c, false, c.sidebarBg));
        const label = btn.getChildren?.()?.[0];
        if (label) label.fg = c.white;
      } catch {}
    }
  };

  return {
    promptConflict,
    closeConflict,
    isOpen: (): boolean => state.kind === "open",
    repaint: repaintConflict,
  };
};

// --- Floating Yes/No confirmation ("Empty Trash?", "Permanently delete …?").
// State lives here; the trash-bound wrappers (confirmEmptyTrash /
// confirmDeleteForever) live in ./trashops. ---

type YesNoCtx = {
  colors(): Theme;
  uiStyle(): UiStyle;
  byId(id: string): MaybeNode;
  // NO readiness gate: a dialog mounts on the renderer root, which exists for
  // the renderer's whole life. The old `canOpen: () => !!renderer.resolution`
  // wiring only became true once the terminal answered OpenTUI's pixel-size
  // query — never on the Linux console or tmux, where Empty Trash / Delete
  // Forever then silently no-op'd. makeConflict opens ungated for the same
  // reason; callers reach confirm() only after boot (keymap/menu).
  //
  // open/close orchestration + the dismiss-others policy live in ./floats
  floats: Floats;
  // the refusal notice. A request that arrives while another question is up
  // is REFUSED, not declined — the dialog says so ONCE, here: it is the only
  // chokepoint every caller goes through, so a caller that ignores the
  // outcome can never leave the user with a request that silently did
  // nothing. Absent = no notice (old fakes keep working).
  notify?(message: string, title?: string, level?: NotifyLevel): void;
  // mouse pointer shape (OSC 22 via the wiring's tty-guarded setter).
  // Absent = no pointer changes (old fakes keep working).
  setPointer?(style: PointerStyle): void;
};

// The affirmative option carries the ACTION ("empty trash", "update"); the
// negative option is always "no". The request's title says what the question
// is about and its body says what the answer does. The UI title-cases the
// action label, so the same request vocabulary renders as "Empty Trash".
type YesNoOption = "yes" | "no";

// The visual order is safety-first: No on the left, the affirmative action on
// the right. The cursor's index follows the VISUAL order, so the arrow keys
// move the highlight the way the eye expects.
const YESNO_ORDER: readonly YesNoOption[] = ["no", "yes"];

// ONE explicit phase for the whole dialog. The old state was four parallel
// fields (`open`, `lastDanger`, `focusIdx`, `pendingYes`), so "a question is
// up but nothing is pending" was representable — and the request outcome was
// a bare boolean, which made "another question is already up" look exactly
// like "the user pressed No".
//
// The request rides on the state, including the ANSWER callbacks: `onNo` is
// "the user declined". A dismissal fires neither callback.
type YesNoState = { kind: "closed" } | { kind: "open"; request: ConfirmRequest; focus: YesNoOption };

// The ONE transition for a confirm REQUEST: a question can only be asked
// while none is up. The refusal is explicit — "busy" is not "declined".
const askYesNo = (state: YesNoState, request: ConfirmRequest): { state: YesNoState; outcome: ConfirmOutcome } => {
  if (state.kind === "open") return { state, outcome: { kind: "busy" } };
  return {
    // The affirmative action is the default focus for every question. A
    // destructive prompt carries an explicit warning and a separated action,
    // so its focus never needs to default to No.
    state: {
      kind: "open",
      request,
      focus: "yes",
    },
    outcome: { kind: "opened" },
  };
};

const YESNO_W = 40;
const YESNO_WARNING = "This cannot be undone.";

// The body reserves two cells on each side.
const YESNO_BODY_GUTTER = 4;

const YESNO_FOCUS_ATTRIBUTES = createTextAttributes({ bold: true, underline: true });
const YESNO_WARNING_ATTRIBUTES = createTextAttributes({ bold: true });

type YesNoBodyLine = { text: string; tone: "accent" | "danger" | "warning" };

// Actions read as labels, not commands shouted in lowercase. Keep minor words
// lowercase inside a multi-word label ("Set as Default"), while capitalizing
// the significant words ("Empty Trash", "Delete Permanently").
const YESNO_MINOR_WORDS = new Set([
  "a",
  "an",
  "and",
  "as",
  "at",
  "but",
  "by",
  "for",
  "in",
  "nor",
  "of",
  "on",
  "or",
  "per",
  "the",
  "to",
  "via",
  "vs",
]);

const titleCaseYesNoLabel = (text: string): string => {
  const words = text.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return "Yes";
  return words
    .map((word, index) => {
      const minor = YESNO_MINOR_WORDS.has(word) && index > 0 && index < words.length - 1;
      if (minor) return word;
      return `${word.charAt(0).toUpperCase()}${word.slice(1)}`;
    })
    .join(" ");
};

const ellipsizeYesNo = (text: string, max: number): string => {
  const width = Math.max(1, max);
  return text.length > width ? `${text.slice(0, width - 1)}…` : text;
};

// A title occupies one physical row. Flatten every control/line separator to
// a space before measuring it, or a plugin title containing a newline would
// silently lose everything after the first row.
const oneLineYesNoText = (text: string): string =>
  Array.from(text, (char) => {
    const code = char.codePointAt(0) ?? 0;
    return code <= 0x1f || code === 0x7f ? " " : char;
  })
    .join("")
    .replace(/\s+/g, " ")
    .trim();

// Fit one line on a word boundary when possible. The ellipsis is part of the
// budget, so the visible result never crosses the panel edge.
const fitYesNoLine = (text: string, max: number): string => {
  const width = Math.max(1, max);
  if (text.length <= width) return text;
  if (width === 1) return text.slice(0, 1);
  const cut = text.slice(0, width - 1);
  const at = cut.lastIndexOf(" ");
  if (at >= Math.floor(width / 2)) return `${cut.slice(0, at).trimEnd()}…`;
  return `${cut}…`;
};

// Word-wrap a confirm body into at most two lines. `maxWidth` is the content
// budget, not the panel width; callers account for padding and outline rings.
export const wrapYesNoMessage = (message: string, maxWidth: number = YESNO_W - YESNO_BODY_GUTTER): string[] => {
  const width = Math.max(1, maxWidth);
  const words = message.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let current = "";

  const push = (word: string): void => {
    const next = current ? `${current} ${word}` : word;
    if (next.length <= width) {
      current = next;
      return;
    }
    if (current) lines.push(current);
    current = word;
  };

  for (const word of words) {
    if (word.length <= width) {
      push(word);
      continue;
    }
    // A space-less run cannot wrap on a boundary. Cut it explicitly so the
    // reader sees that content was omitted.
    let rest = word;
    while (rest.length > width) {
      const take = width > 1 ? width - 1 : 1;
      const chunk = width > 1 ? `${rest.slice(0, take)}…` : rest.slice(0, 1);
      push(chunk);
      rest = rest.slice(chunk.length - (width > 1 ? 1 : 0));
    }
    if (rest) push(rest);
  }
  if (current) lines.push(current);

  if (lines.length <= 2) return lines.length ? lines : [""];
  const first = lines[0] ?? "";
  const folded = lines.slice(1).join(" ");
  return [first, ellipsizeYesNo(folded, width)];
};

// A destructive prompt always keeps the irreversibility warning. The body is
// split from the warning so the warning can occupy the final line intact —
// a long explanation may be cut, but "This cannot be undone." may not.
const splitDangerWarning = (body: string): { base: string; warning: string } => {
  const lower = body.toLowerCase();
  const at = lower.lastIndexOf(YESNO_WARNING.toLowerCase());
  if (at < 0) return { base: body, warning: YESNO_WARNING };
  const before = body.slice(0, at).trim();
  const after = body.slice(at + YESNO_WARNING.length).trim();
  return { base: `${before} ${after}`.trim(), warning: YESNO_WARNING };
};

const yesNoBodyLines = (request: ConfirmRequest, budget: number): YesNoBodyLine[] => {
  // The dedicated title row is gone. A body is the visible explanation; when
  // the caller has no body, the title becomes that explanation rather than
  // leaving the user with two unexplained actions.
  const body = request.body?.trim() || oneLineYesNoText(request.title);
  if (!request.danger) return wrapYesNoMessage(body, budget).map((text) => ({ text, tone: "accent" }));

  const { base, warning } = splitDangerWarning(body);
  if (!base) return [{ text: warning, tone: "warning" }];
  return [
    { text: fitYesNoLine(base, budget), tone: "danger" },
    { text: warning, tone: "warning" },
  ];
};

export const makeYesNo = (dialogs: ReturnType<typeof makeDialogs>, ctx: YesNoCtx) => {
  const { openDialog, closeDialog } = dialogs;

  let state: YesNoState = { kind: "closed" };

  // raw teardown — registered with floats at open time. The state is cleared
  // FIRST: isOpen() gates the key router, so a failing native remove must
  // never leave a question marked open after its float layer has gone.
  const rawClose = (): void => {
    state = { kind: "closed" };
    try {
      closeDialog("tfm-yesno");
    } catch {}
    // hovered buttons have no out (their nodes are gone) — restore here
    try {
      ctx.setPointer?.("default");
    } catch {}
  };

  const close = (): void => {
    ctx.floats.close("yesno");
  };

  // the cursor's index in the VISUAL order (0 = No on the left, 1 = action on the right)
  const focusIndex = (): number => (state.kind === "open" && state.focus === "no" ? 0 : 1);

  const optionId = (which: YesNoOption): string => (which === "yes" ? "tfm-yesno-b0" : "tfm-yesno-b1");

  // The cursor is carried by the action's own type treatment: accent color
  // for a normal prompt, danger red for a destructive one, plus bold and
  // underline. There is no glyph and no filled slab competing with the copy.
  const focusColor = (c: Theme): string => (state.kind === "open" && state.request.danger ? c.ansi1 : c.accent);

  const paintFocus = (): void => {
    const c = ctx.colors();
    const focused = focusIndex();
    for (const [which, index] of [
      ["no", 0],
      ["yes", 1],
    ] as const) {
      try {
        const label = ctx.byId(`${optionId(which)}-label`);
        if (!label) continue;
        const active = index === focused;
        label.fg = active ? focusColor(c) : c.white;
        label.attributes = active ? YESNO_FOCUS_ATTRIBUTES : 0;
      } catch {}
    }
  };

  // the ONE cursor: the keyboard's arrows and the mouse's hover both move
  // it, so there is never a second highlight to disagree with.
  const focusOption = (which: YesNoOption): void => {
    if (state.kind !== "open") return;
    if (state.focus === which) return;
    state = { ...state, focus: which };
    paintFocus();
  };

  // the ONE affirmative answer path: the option click and the keyboard's
  // submit both route through it.
  const answerYes = (): void => {
    const onYes = state.kind === "open" ? state.request.onYes : undefined;
    close();
    onYes?.();
  };

  // the ONE "no" answer path: the No option and the keyboard's No submit
  // both route through it, so a click and a keypress cannot drift. A
  // DISMISSAL (esc / click-away) is not an answer and never lands here.
  const answerNo = (): void => {
    const onNo = state.kind === "open" ? state.request.onNo : undefined;
    close();
    onNo?.();
  };

  // arrows move the cursor between the two options; submit activates the
  // focused one.
  const moveFocus = (delta: number): void => {
    if (state.kind !== "open") return;
    const next = (focusIndex() + delta + 2) % 2;
    focusOption(YESNO_ORDER[next] ?? "yes");
  };

  const submit = (): void => {
    if (state.kind !== "open") return;
    if (state.focus === "yes") answerYes();
    else answerNo();
  };

  // One option occupies one half of the action row, with its label centered
  // in that half. The clickable target stays close to the text instead of
  // making the whole half a button. A REAL mouse move always reasserts the
  // option under the pointer, even if the keyboard moved the shared cursor
  // since the last hover event.
  const yesNoOption = (id: string, label: string, which: YesNoOption, onPick: () => void): ReturnType<typeof Box> => {
    const c = ctx.colors();
    const active = state.kind === "open" && state.focus === which;
    return Box(
      {
        id: `${id}-slot`,
        width: "50%",
        height: 1,
        flexDirection: "row",
        justifyContent: "center",
      },
      Box(
        {
          id,
          width: label.length + 1,
          height: 1,
          flexDirection: "row",
          justifyContent: "flex-start",
          onMouseDown: (ev: MouseEvent) => {
            try {
              ev.stopPropagation?.();
            } catch {}
            onPick();
          },
          onMouseMove: () => {
            focusOption(which);
            ctx.setPointer?.("pointer");
          },
          onMouseOut: () => {
            ctx.setPointer?.("default");
          },
        },
        Text({
          id: `${id}-label`,
          content: label,
          fg: active ? focusColor(c) : c.white,
          attributes: active ? YESNO_FOCUS_ATTRIBUTES : 0,
        }),
      ),
    );
  };

  const confirm = (request: ConfirmRequest): ConfirmOutcome => {
    const next = askYesNo(state, request);
    if (next.outcome.kind === "busy") {
      // The refusal is SURFACED here, once: the dialog is the only
      // chokepoint every caller goes through, so a caller that ignores the
      // outcome can never swallow the request in silence.
      ctx.notify?.("A confirmation is already open · answer it first");
      return next.outcome;
    }

    const c = ctx.colors();
    // Outline floats reserve one cell for each border ring. The width budget
    // must follow the LIVE style, or the ellipsis lands outside the clip.
    const innerWidth = isFloatingOutline(ctx.uiStyle()) ? YESNO_W - 2 : YESNO_W;
    const bodyLines = yesNoBodyLines(request, innerWidth - YESNO_BODY_GUTTER);
    const yesLabel = titleCaseYesNoLabel(request.yesLabel || "yes");

    ctx.floats.open("yesno", rawClose);
    state = next.state;
    try {
      openDialog({
        id: "tfm-yesno",
        zIndex: FLOAT_Z.yesno,
        width: YESNO_W,
        rows: () => [
          // No title row and no close X: the body is the explanation, the
          // separated action row is the answer.
          ...bodyLines.flatMap((line, index) => [
            ...(index === 1 && line.tone === "warning"
              ? [Box({ width: "100%", height: 1 }, Text({ content: "\u00A0", fg: c.sidebarBg }))]
              : []),
            Box(
              { width: "100%", height: 1, paddingLeft: 2, paddingRight: 2 },
              Text({
                id: index === 0 ? "tfm-yesno-body" : "tfm-yesno-body-2",
                content: line.text,
                fg: line.tone === "accent" ? c.accent : c.ansi1,
                attributes: line.tone === "warning" ? YESNO_WARNING_ATTRIBUTES : 0,
              }),
            ),
          ]),
          Box({ width: "100%", height: 1 }, Text({ content: "\u00A0", fg: c.sidebarBg })),
          Box(
            {
              id: "tfm-yesno-actions",
              width: "100%",
              height: 1,
              flexDirection: "row",
            },
            // No and the affirmative action occupy equal halves; each label
            // is centered inside its own half.
            yesNoOption("tfm-yesno-b1", "No", "no", answerNo),
            yesNoOption("tfm-yesno-b0", yesLabel, "yes", answerYes),
          ),
        ],
        onClose: () => close(),
      });
    } catch (err) {
      // A failed native mount must not leave a question marked open after its
      // float layer is gone: isOpen() gates the key router.
      state = { kind: "closed" };
      try {
        ctx.floats.close("yesno");
      } catch {}
      throw err;
    }
    return next.outcome;
  };

  // theme-switch repaint while open: panel + texts by id, the options
  // through the live focus paint. No rebuild — the pending confirm + cursor
  // survive. The PANEL carries the fill; the full-screen scrim stays
  // transparent (a fill there would delete every raster under the dialog).
  const repaintYesNo = (): void => {
    if (state.kind !== "open") return;
    const c = ctx.colors();
    try {
      const panel = ctx.byId("tfm-yesno-panel");
      if (panel) applySurface(panel, floatSurface(ctx.uiStyle(), c, c.sidebarBg));
    } catch {}
    const innerWidth = isFloatingOutline(ctx.uiStyle()) ? YESNO_W - 2 : YESNO_W;
    const bodyLines = yesNoBodyLines(state.request, innerWidth - YESNO_BODY_GUTTER);
    for (const [index, line] of bodyLines.entries()) {
      try {
        const body = ctx.byId(index === 0 ? "tfm-yesno-body" : "tfm-yesno-body-2");
        if (body) {
          body.content = line.text;
          body.fg = line.tone === "accent" ? c.accent : c.ansi1;
          body.attributes = line.tone === "warning" ? YESNO_WARNING_ATTRIBUTES : 0;
        }
      } catch {}
    }
    try {
      paintFocus();
    } catch {}
  };

  return { confirm, close, isOpen: (): boolean => state.kind === "open", repaint: repaintYesNo, moveFocus, submit };
};
