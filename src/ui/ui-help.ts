// --- Help view: the esc menu's "Help" panel. A static,
// cursorless cheat sheet (hero + 4 titled columns + mouse strip + tips) —
// deliberately NOT the settings two-pane UI: no rows, no cursor, no arrows,
// no toggles. esc / F1 / X / click-away closes (see the shell + keymap).
// Widget-extraction seam (see ui-dialogs.ts): renderer/keybinds arrive via deps. ---
import { ASCIIFont, Box, type CliRenderer, ScrollBoxRenderable, Text, bold, fg, t } from "@opentui/core";
import { defaultConfig, type KeyAction } from "../config/config-schema";
import type { Theme } from "../config/config";
import type { NodeLike } from "../lib/node-like";

export type HelpDeps = {
  keybinds(a: KeyAction): string[];
  renderer(): CliRenderer;
  termH(): number;
};

// wide poster width, clamped to the terminal by the shell
export const HELP_W = 96;
export const helpPanelWidth = (termW: number): number => Math.min(HELP_W, Math.max(48, termW - 4));

// live binds with a defaults fallback (the shell passes real remaps; the
// fallback keeps the panel renderable without wiring)
export const liveBinds =
  (fn?: (a: KeyAction) => string[]) =>
  (a: KeyAction): string[] => {
    try {
      const b = fn?.(a);
      if (b?.length) return b;
    } catch {}
    return defaultConfig.keys[a] ?? [];
  };

// pretty, non-techy key names: ctrl+c -> Ctrl+C, return -> Enter, up -> ↑
export const prettyKey = (spec: string): string =>
  spec
    .split("+")
    .map((p) => {
      if (/^f\d+$/i.test(p)) return p.toUpperCase();
      const l = p.toLowerCase();
      if (l === "ctrl" || l === "control") return "Ctrl";
      if (l === "shift") return "Shift";
      if (l === "alt" || l === "meta") return "Alt";
      const map: Record<string, string> = {
        return: "Enter",
        enter: "Enter",
        backspace: "Backspace",
        escape: "Esc",
        delete: "Del",
        space: "Space",
        tab: "Tab",
        pageup: "PgUp",
        pagedown: "PgDn",
        home: "Home",
        end: "End",
        up: "↑",
        down: "↓",
        left: "←",
        right: "→",
      };
      return map[l] ?? (p.length === 1 ? p.toUpperCase() : p);
    })
    .join("+");

const prettyBinds = (binds: string[]): string => (binds.length ? binds.slice(0, 2).map(prettyKey).join(" / ") : "—");
// narrow columns take the first bind only, never a wrapped pair
const prettyFirst = (binds: string[]): string => (binds.length ? prettyKey(binds[0] as string) : "—");

type HelpEntry = { action?: KeyAction; keys?: string; verb: string };
type HelpCard = { title: string; entries: HelpEntry[] };

// --- content (curated subset, never the full key table) ---

const NAV_WALK: HelpEntry = { keys: "walk", verb: "Walk around" };
const NAV_OPEN: HelpEntry = { action: "openSelected", verb: "Open" };
const NAV_UP: HelpEntry = { action: "parentDir", verb: "Up a folder" };
const NAV_FIND: HelpEntry = { keys: "just type", verb: "Find it" };

const EDIT_ENTRIES: HelpEntry[] = [
  { action: "copy", verb: "Copy" },
  { action: "cut", verb: "Cut" },
  { action: "paste", verb: "Paste here" },
  { action: "duplicate", verb: "Copy in place" },
  { action: "trash", verb: "Trash" },
  { action: "renameOrRestore", verb: "Rename" },
  { action: "undo", verb: "Undo" },
  { action: "redo", verb: "Redo" },
];

const VIEW_ENTRIES: HelpEntry[] = [
  { action: "toggleHidden", verb: "Hidden files" },
  { action: "toggleView", verb: "Grid or list" },
  { action: "togglePreview", verb: "Preview" },
  { action: "zoomIn", verb: "Bigger" },
  { action: "zoomOut", verb: "Smaller" },
];

const GO_ENTRIES: HelpEntry[] = [
  { action: "newTab", verb: "New tab" },
  { action: "closeTab", verb: "Close tab" },
  { action: "nextTab", verb: "Next tab" },
  { action: "switchPane", verb: "Other pane" },
  { action: "openTerminal", verb: "Terminal here" },
];

const CARDS: HelpCard[] = [
  { title: "MOVE", entries: [NAV_WALK, NAV_OPEN, NAV_UP, NAV_FIND] },
  { title: "EDIT", entries: EDIT_ENTRIES },
  { title: "VIEW", entries: VIEW_ENTRIES },
  { title: "GO", entries: GO_ENTRIES },
];

const MOUSE_COLS: { keys: string; verb: string }[][] = [
  [
    { keys: "Click", verb: "Select" },
    { keys: "Double-click", verb: "Open" },
    { keys: "Right-click", verb: "More actions" },
  ],
  [
    { keys: "Drag select", verb: "Select multiple" },
    { keys: "Drag", verb: "To other apps" },
    { keys: "Ctrl+Drag", verb: "Drop onto folder" },
  ],
  [
    { keys: "Wheel", verb: "Scroll" },
    { keys: "Wheel-click", verb: "Close tab" },
  ],
];

const FOOTER = "F1 opens or closes this";

// --- quick tips: problem-first diagnostics, never another key list.
// Pairs (no emdash, arrow or comma only); the problem paints accent-bold
// exactly like the key column, the fix in white. The whole pool renders —
// no rotation, the body below scrolls instead of hiding tips.
export type QuickTip = { problem: string; fix: string };
export const QUICK_TIPS: QuickTip[] = [
  { problem: "icons artifacting/buggy?", fix: "turn on force glyph, Settings -> appearance" },
  { problem: "shift+clicks highlights tui not files?", fix: "do alt+click or edit your terminal config" },
  { problem: "ghostty eats shift+click?", fix: "set mouse-shift-capture to true" },
  { problem: "ctrl+tab dead in kitty?", fix: "set ctrl+tab to no_op in kitty.conf" },
  { problem: "kitty drag escapes?", fix: "ctrl+drag stays inside tfm" },
  { problem: "icons are boxes?", fix: "install Nerd Font, Meslo works" },
  { problem: "scrolling on big folders stutter?", fix: "increase reveal delay (animations)" },
  { problem: "no zip or 7z offered?", fix: "install that tool, absent ones hide" },
  { problem: "network trash refused?", fix: "trash stays local, copy it over instead" },
  { problem: "mouse doesnt work on tty?", fix: "enable gpm" },
];

// viewport height for the scrollable body: panel chrome (header 1 +
// divider 1 + panel padding 2) plus scrim breathing room; min 8 so the
// scroller never collapses on short terminals
export const helpBodyHeight = (termH: number): number => Math.max(8, termH - 8);

// --- small builders (no borders, no bg chips — typography groups, not boxes) ---

// the shell already prints the menu header + X; the panel only needs air + footer
const shell = (...children: Parameters<typeof Box>[1][]) =>
  Box(
    { width: "100%", flexDirection: "column", paddingLeft: 2, paddingRight: 2, paddingTop: 1, paddingBottom: 1 },
    ...children,
  );

const footerNote = (c: Theme) =>
  Box(
    { width: "100%", flexDirection: "row", justifyContent: "center", paddingTop: 1 },
    Text({ content: FOOTER, fg: c.sidebarFgMuted }),
  );

const hero = (c: Theme) =>
  Box(
    { width: "100%", flexDirection: "row", justifyContent: "center" },
    Box(
      { flexDirection: "row", columnGap: 2, alignItems: "center" },
      ASCIIFont({ text: "?", font: "block", color: c.accent }),
      Box(
        { flexDirection: "column" },
        Text({ content: t`${bold("Lost? Start here.")}`, fg: c.white }),
        Text({ content: "The only ones you need to get started.", fg: c.sidebarFgMuted }),
      ),
    ),
  );

const groupHeader = (c: Theme, title: string) =>
  Box(
    { width: "100%", flexDirection: "column" },
    Text({ content: t`${bold(fg(c.accent)(title))}`, fg: c.white }),
    Text({ content: "────────", fg: c.divider }),
  );

// one key→verb row, no chips: bold accent key, white verb
const keyVerb = (c: Theme, keys: string, verb: string) =>
  Box({ width: "100%", height: 1 }, Text({ content: t`${bold(fg(c.accent)(keys))}  ${fg(c.white)(verb)}` }));

const keysTextOf = (bindsOf: (a: KeyAction) => string[], e: HelpEntry): string => {
  if (e.keys === "walk") {
    // one live "walk" row: first bind of each direction (↑↓←→ by default)
    const dirs: KeyAction[] = ["moveUp", "moveDown", "moveLeft", "moveRight"];
    return dirs
      .map((a) => bindsOf(a)[0])
      .filter(Boolean)
      .map((s) => prettyKey(s as string))
      .join("");
  }
  if (e.keys) return e.keys;
  if (e.action) return prettyBinds(bindsOf(e.action));
  return "—";
};

// narrow-column variant: first bind only, never a wrapped pair
const keysShortOf = (bindsOf: (a: KeyAction) => string[], e: HelpEntry): string => {
  if (e.keys === "walk") return keysTextOf(bindsOf, e);
  if (e.keys) return e.keys;
  if (e.action) return prettyFirst(bindsOf(e.action));
  return "—";
};

const mouseStrip = (c: Theme) =>
  Box(
    { width: "100%", flexDirection: "column", paddingTop: 1 },
    Text({ content: t`${bold(fg(c.accent)("MOUSE"))}`, fg: c.white }),
    Text({ content: "────────", fg: c.divider }),
    Box(
      { width: "100%", flexDirection: "row", columnGap: 3 },
      ...MOUSE_COLS.map((rows) => {
        const w = Math.max(...rows.map((r) => r.keys.length), 0);
        return Box({ flexGrow: 1, flexDirection: "column" }, ...rows.map((r) => keyVerb(c, r.keys.padEnd(w), r.verb)));
      }),
    ),
  );

const tipsStrip = (c: Theme, tips: QuickTip[]) => {
  // pad the bulleted problem column to the widest problem so every fix
  // starts at the same cell (same trick the key cards use for live remaps)
  const w = Math.max(...tips.map((tip) => tip.problem.length), 0);
  return Box(
    { width: "100%", flexDirection: "column", paddingTop: 1 },
    Text({ content: t`${bold(fg(c.accent)("TIPS"))}`, fg: c.white }),
    Text({ content: "────────", fg: c.divider }),
    ...tips.map((tip) => keyVerb(c, `? ${tip.problem}`.padEnd(w + 2), tip.fix)),
  );
};

export const renderHelpPanel = (c: Theme, panel: NodeLike, deps: HelpDeps): void => {
  const bindsOf = liveBinds(deps.keybinds);
  const cards = Box(
    { width: "100%", flexDirection: "row", columnGap: 3, paddingTop: 1 },
    ...CARDS.map((card) => {
      // pad the key column to the card's widest key so every verb starts
      // at the same cell (keys are live remaps, so measure per render)
      const keys = card.entries.map((e) => keysShortOf(bindsOf, e));
      const w = Math.max(...keys.map((k) => k.length), 0);
      return Box(
        { flexGrow: 1, flexDirection: "column" },
        groupHeader(c, card.title),
        ...card.entries.map((e, i) => keyVerb(c, (keys[i] ?? "").padEnd(w), e.verb)),
      );
    }),
  );
  // the full pool no longer fits short terminals: the body rides in a
  // bounded scroller (wheel scrolls natively, arrows drive it from moveMenu)
  // while the shell header above stays fixed
  const scroller = new ScrollBoxRenderable(deps.renderer(), {
    id: "tfm-help-scroll",
    width: "100%",
    height: helpBodyHeight(deps.termH()),
    scrollY: true,
    viewportCulling: true,
  });
  scroller.add(shell(hero(c), cards, mouseStrip(c), tipsStrip(c, QUICK_TIPS)));
  panel.add(scroller);
  // pinned below the scroller: always visible, never scrolls away
  panel.add(footerNote(c));
};
