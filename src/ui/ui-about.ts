// --- About view: the esc menu's "About" panel. A static, cursorless brand
// block with category rows (label left, preview value right). Rows that name
// a URL open it in the browser; the one Credits row drills into a detail
// view (same panel, ← Back returns) because its text never fits one line.
// No keyboard cursor anywhere — mouse only, like the help view.
// Portrait: one narrow centered column under a faithful (untinted) brand
// raster. Widget-extraction seam (see ui-dialogs.ts): slots/links arrive via
// deps. ---
import { Box, Text, bold, t, type CliRenderer, type MouseEvent } from "@opentui/core";
import pkg from "../../package.json";
import { PLUGIN_API_VERSION } from "../plugins/plugin-api";
import type { Theme } from "../config/config";
import { hoverEvents, type IconSlotHandle, type IconState } from "./ui-slots";
import { truncateToastText } from "./notify";
import type { NodeLike } from "../lib/node-like";
import type { PointerStyle } from "../lib/pointer";

export type AboutDetail = "credits" | null;

export type AboutDeps = {
  renderer(): CliRenderer;
  makeIconSlot(
    name: string,
    states: IconState[],
    heightCells?: number,
    initialState?: number,
    onMouseDown?: (ev: MouseEvent) => void,
    statesFactory?: () => IconState[],
    opts?: { faithful?: boolean },
  ): IconSlotHandle;
  onOpenUrl(url: string): void;
  detail: AboutDetail;
  onOpenDetail(key: Exclude<AboutDetail, null>): void;
  onBack(): void;
  setPointer?(style: PointerStyle): void;
};

export type AboutRow = { key: string; label: string; value: string; url?: string };

// narrow portrait width, clamped to the terminal by the shell. 40 is the
// floor: below it even the value room can't hold a recognizable link.
// Links may truncate here (… marker) — clicks still open the full URL.
export const ABOUT_W = 40;
export const aboutPanelWidth = (termW: number): number => Math.min(ABOUT_W, Math.max(40, termW - 4));

// label column copies the properties row SHAPE (leading space, fixed cell)
// but runs wider: properties labels are short, so padEnd(12) always leaves
// big air there — about's 10-char labels would sit 1 cell off their values.
// Every label keeps >= 3 cells of air (pinned below); the panel pays for it
// instead of the value room. Value room = panel minus label, row pad,
// right margin.
export const ABOUT_LABEL_W = 14;
export const aboutValueRoom = (panelW: number): number => Math.max(10, panelW - 16);

export const ABOUT_ROWS: AboutRow[] = [
  {
    key: "website",
    label: "Website",
    value: "clarkarch.github.io/tfm-tui",
    url: "https://clarkarch.github.io/tfm-tui",
  },
  {
    key: "github",
    label: "GitHub",
    value: "github.com/clarkarch/tfm-tui",
    url: "https://github.com/clarkarch/tfm-tui",
  },
  {
    key: "credits",
    label: "Credits",
    value: "OpenTUI, Bun, Nerd Fonts + Material Design Icons, opencode themes, Nautilus",
  },
  { key: "api", label: "Plugin API", value: `v${PLUGIN_API_VERSION}` },
  { key: "license", label: "License", value: "MIT" },
];

export const CREDITS_DETAIL: AboutRow[] = [
  { key: "d-opentui", label: "OpenTUI", value: "opentui.com", url: "https://opentui.com" },
  { key: "d-bun", label: "Bun", value: "bun.sh", url: "https://bun.sh" },
  { key: "d-nerdfonts", label: "Nerd Fonts", value: "nerdfonts.com", url: "https://www.nerdfonts.com" },
  {
    key: "d-mdi",
    label: "MDI",
    value: "pictogrammers.com/library/mdi/",
    url: "https://pictogrammers.com/library/mdi/",
  },
  { key: "d-themes", label: "Themes", value: "from opencode assets", url: "https://github.com/sst/opencode" },
  { key: "d-inspired", label: "Inspired", value: "Nautilus", url: "https://apps.gnome.org/Nautilus/" },
];

// the brand mark at hero size: faithful keeps the asset palette instead of
// tinting to the slot fg like every other icon
export const ABOUT_LOGO_CELLS = 8;

export const aboutTruncates = (row: AboutRow, room: number): boolean => row.value.length > room;

export const aboutValueFor = (row: AboutRow, room: number): string =>
  aboutTruncates(row, room) ? truncateToastText(row.value, room) : row.value;

const center = (...children: Parameters<typeof Box>[1][]) =>
  Box({ width: "100%", flexDirection: "row", justifyContent: "center" }, ...children);

export const renderAboutPanel = (c: Theme, panel: NodeLike, deps: AboutDeps): void => {
  const room = aboutValueRoom(aboutPanelWidth(deps.renderer().terminalWidth));
  // single rest state, no hover flip: the view is cursorless. The slot keeps
  // its palette in every ui-style (brand art, not a theme glyph).
  const logo = deps.makeIconSlot("tfm", [{ fg: c.white, bg: c.sidebarBg }], ABOUT_LOGO_CELLS, 0, undefined, undefined, {
    faithful: true,
  });

  // one category row: label + preview value. Links open; the credits summary
  // drills (it never fits); everything else is inert text. Only actionable
  // rows take hover/click — position truth (pointer) before change truth.
  const urlAction =
    (url: string): ((ev?: MouseEvent) => void) =>
    (ev?: MouseEvent) => {
      try {
        ev?.stopPropagation?.();
      } catch {}
      deps.onOpenUrl(url);
    };
  const actionOf = (row: AboutRow): ((ev?: MouseEvent) => void) | undefined => {
    if (row.url !== undefined) return urlAction(row.url);
    if (aboutTruncates(row, room)) {
      return (ev?: MouseEvent) => {
        try {
          ev?.stopPropagation?.();
        } catch {}
        deps.onOpenDetail("credits");
      };
    }
    return undefined;
  };
  const paintRow = (id: string, on: boolean): void => {
    const n = deps.renderer().root.findDescendantById(id);
    if (!n) return;
    try {
      (n as { backgroundColor?: unknown }).backgroundColor = on ? c.accentBg : undefined;
    } catch {}
  };
  // fixed-width label cell shared by both views: trailing spaces inside a
  // Text collapse in the production renderer (headless frames preserve
  // them, so frame asserts can't see the drift) — the Box width enforces
  // the value column structurally. padEnd stays for measurers that use
  // string length instead of layout.
  const labelCell = (label: string) =>
    Box({ width: ABOUT_LABEL_W }, Text({ content: ` ${label}`.padEnd(ABOUT_LABEL_W), fg: c.sidebarFgMuted }));
  // properties-dialog rows, verbatim idiom (ui-props.ts): tight height:1
  // stack, NO gaps. Links open; the credits summary drills (it never fits);
  // everything else is inert text. Only actionable rows take hover/click —
  // position truth (pointer) before change truth.
  const catRow = (row: AboutRow) => {
    const go = actionOf(row);
    const id = `tfm-about-row-${row.key}`;
    const paint = (on: boolean): void => paintRow(id, on);
    return Box(
      {
        id,
        width: "100%",
        height: 1,
        flexDirection: "row",
        paddingLeft: 1,
        ...(go
          ? {
              onMouseDown: go,
              // guarded move/out pair (same rule as menu rows): the first
              // move paints + sets the shape, out restores the default
              ...hoverEvents(paint, deps.setPointer),
            }
          : {}),
      },
      labelCell(row.label),
      Text({ content: aboutValueFor(row, room), fg: row.url !== undefined ? c.accent : c.white }),
    );
  };

  const hero = Box(
    {
      width: "100%",
      flexDirection: "column",
      alignItems: "center",
    },
    center(logo.el),
    center(Text({ content: t`${bold("tfm")}`, fg: c.white })),
    center(Text({ content: "terminal file manager", fg: c.sidebarFgMuted })),
  );

  // detail rows are the same properties shape with full text, plus the
  // verified project links (every credit names its own page — no shared
  // targets). Values wrap inside the room instead of overflowing: an
  // over-wide row makes yoga shrink the LABEL and the value column drifts
  // left (that exact regression is pinned in the shell drill test).
  // Height stays auto (no height: 1) so wrapped rows grow.
  const detailRow = (row: AboutRow) => {
    const id = `tfm-about-row-${row.key}`;
    const go = row.url !== undefined ? urlAction(row.url) : undefined;
    return Box(
      {
        id,
        width: "100%",
        flexDirection: "row",
        paddingLeft: 1,
        ...(go
          ? {
              onMouseDown: go,
              ...hoverEvents((on: boolean) => paintRow(id, on), deps.setPointer),
            }
          : {}),
      },
      labelCell(row.label),
      Text({
        content: row.value,
        fg: row.url !== undefined ? c.accent : c.white,
        wrapMode: "word",
        width: room,
      }),
    );
  };

  const backRow = Box(
    {
      id: "tfm-about-back",
      width: "100%",
      height: 1,
      flexDirection: "row",
      paddingLeft: 1,
      onMouseDown: (ev?: MouseEvent) => {
        try {
          ev?.stopPropagation?.();
        } catch {}
        deps.onBack();
      },
      ...hoverEvents((on: boolean) => paintRow("tfm-about-back", on), deps.setPointer),
    },
    Text({ content: " ← Back", fg: c.accent }),
  );

  // fixed short content (hero + a handful of rows), so the body rides
  // auto-height with NO scroller: a termH-bounded box here reserved dead
  // rows and dangled the version footer far below the content. Sections
  // split with the properties nbsp spacer (a plain " " measures empty).
  const spacer = () => Box({ width: "100%", height: 1 }, Text({ content: " " }));
  const body = Box(
    { width: "100%", flexDirection: "column", paddingTop: 1 },
    hero,
    spacer(),
    ...(deps.detail === "credits" ? [backRow, ...CREDITS_DETAIL.map(detailRow)] : ABOUT_ROWS.map(catRow)),
  );
  panel.add(body);
  panel.add(
    Box(
      {
        width: "100%",
        flexDirection: "row",
        justifyContent: "flex-end",
        paddingRight: 2,
        // no bottom pad: the version rides the panel's bottom edge
        paddingBottom: 0,
      },
      Text({ id: "tfm-about-version", content: `v${pkg.version}`, fg: c.sidebarFgMuted }),
    ),
  );
};
