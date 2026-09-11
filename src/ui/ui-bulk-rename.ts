// --- Bulk-rename modal: F2 on a multi-selection. ONE stem input + a
// numbering-style picker, with a live preview of every old -> new name
// (extensions preserved in ../fs/bulk-rename). enter applies, esc/scrim/X
// cancels, validation errors render in the footer and keep the modal open.
// Widget-extraction seam (see ui-dialogs.ts): all live deps arrive via ctx. ---

import { Box, Input, RGBA, Text } from "@opentui/core";
import path from "node:path";
import { applySurface, btnSurface, floatSurface } from "./style";
import { bulkRenameNames, planBulkRename, type BulkRenamePair, type BulkRenameStyle } from "../fs/bulk-rename";
import type { Theme } from "../config/config";
import type { UiStyle } from "../config/config-schema";
import { FLOAT_Z, type Floats } from "./floats";

type BulkRenameCtx = {
  renderer(): any;
  byId(id: string): any;
  rootAdd(node: any): void;
  clearChildren(node: any): void;
  stripSelectable(): void;
  escHintBtn(id: string, onClose: () => void): any;
  drainIconQueue(): void | Promise<void>;
  colors(): Theme;
  uiStyle(): UiStyle;
  floats: Floats;
  performBulkRename(pairs: BulkRenamePair[]): void | Promise<void>;
  setStatusMsg(msg: string): void;
};

const PANEL_W = 76;
const LABEL_W = 9;
const MAX_PREVIEW = 14;
const EMPTY_ERROR = "\u00A0";
const STYLES: BulkRenameStyle[] = ["plain", "pad", "paren"];
const STYLE_LABELS: Record<BulkRenameStyle, string> = { plain: "1", pad: "01", paren: "(1)" };

const trunc = (s: string, w: number): string => (s.length > w ? `${s.slice(0, w - 1)}…` : s);

export const makeBulkRename = (ctx: BulkRenameCtx) => {
  let opened = false;
  let items: Array<{ path: string }> = [];
  let value = "";
  let style: BulkRenameStyle = "plain";
  let focusTimer: ReturnType<typeof setTimeout> | null = null;

  const setError = (msg: string): void => {
    const el: any = ctx.byId("tfm-bulkrename-error");
    if (el) el.content = msg || EMPTY_ERROR;
  };

  const renderPreview = (): void => {
    const box: any = ctx.byId("tfm-bulkrename-preview");
    if (!box) return;
    const c = ctx.colors();
    ctx.clearChildren(box);
    const stem = value.trim();
    const names = stem ? bulkRenameNames(items, stem, style) : [];
    const nameW = Math.floor((PANEL_W - 4 - 3 - 2) / 2);
    items.slice(0, MAX_PREVIEW).forEach((it, i) => {
      const oldName = path.basename(it.path);
      // no stem yet: list the files being renamed, no arrow column
      if (!stem) {
        box.add(
          Box(
            { height: 1, flexDirection: "row", paddingLeft: 2, paddingRight: 2 },
            Text({ content: trunc(oldName, nameW * 2 + 3), fg: c.sidebarFgMuted }),
          ),
        );
        return;
      }
      const newName = names[i] ?? oldName;
      const changed = newName !== oldName;
      box.add(
        Box(
          { height: 1, flexDirection: "row", columnGap: 1, paddingLeft: 2, paddingRight: 2 },
          Text({ content: trunc(oldName, nameW), fg: c.sidebarFgMuted }),
          Text({ content: "→", fg: c.sidebarFgMuted }),
          Text({ content: trunc(newName, nameW), fg: changed ? c.accent : c.sidebarFgMuted }),
        ),
      );
    });
    if (items.length > MAX_PREVIEW) {
      box.add(
        Box(
          { height: 1, paddingLeft: 2 },
          Text({ content: `… ${items.length - MAX_PREVIEW} more`, fg: c.sidebarFgMuted }),
        ),
      );
    }
    if (!stem) setError("");
    else {
      const plan = planBulkRename(items, stem, style);
      setError(plan.ok ? "" : plan.error);
    }
  };

  const repaintStyles = (): void => {
    const c = ctx.colors();
    for (const s of STYLES) {
      const active = s === style;
      const chip: any = ctx.byId(`tfm-bulkrename-style-${s}`);
      if (chip) applySurface(chip, btnSurface(ctx.uiStyle(), c, active, c.sidebarBg));
      const label: any = ctx.byId(`tfm-bulkrename-style-label-${s}`);
      if (label) label.fg = active ? c.accent : c.sidebarFgMuted;
    }
  };

  const setStyle = (s: BulkRenameStyle): void => {
    style = s;
    repaintStyles();
    renderPreview();
  };

  const cycleStyle = (): void => {
    const i = STYLES.indexOf(style);
    setStyle(STYLES[(i + 1) % STYLES.length] ?? "plain");
  };

  const rawClose = (): void => {
    opened = false;
    items = [];
    value = "";
    if (focusTimer !== null) {
      clearTimeout(focusTimer);
      focusTimer = null;
    }
    try {
      ctx.byId("tfm-bulkrename-input")?.blur?.();
    } catch {}
    const scrim: any = ctx.byId("tfm-bulkrename");
    scrim?.parent?.remove(scrim);
  };

  const close = (): void => {
    ctx.floats.close("bulkrename");
  };

  const apply = (): void => {
    const plan = planBulkRename(items, value, style);
    if (!plan.ok) {
      setError(plan.error);
      return;
    }
    close();
    void ctx.performBulkRename(plan.pairs);
  };

  const handleKey = (ev: { name?: string }): boolean => {
    if (ev.name === "escape") close();
    else if (ev.name === "return") apply();
    else if (ev.name === "tab") cycleStyle();
    // everything else (typing) reaches the focused Input natively; the keymap
    // swallows the event around us either way (same rule as pick/prompt)
    return true;
  };

  const btn = (id: string, label: string, fg: string, onPick: () => void): any =>
    Box(
      {
        id,
        height: 1,
        flexGrow: 1,
        flexDirection: "row",
        justifyContent: "center",
        onMouseDown: (ev: any) => {
          try {
            ev.stopPropagation?.();
          } catch {}
          onPick();
        },
      },
      Text({ content: label, fg }),
    );

  const chip = (s: BulkRenameStyle): any =>
    Box(
      {
        id: `tfm-bulkrename-style-${s}`,
        height: 1,
        paddingLeft: 1,
        paddingRight: 1,
        onMouseDown: (ev: any) => {
          try {
            ev.stopPropagation?.();
          } catch {}
          setStyle(s);
        },
      },
      Text({ id: `tfm-bulkrename-style-label-${s}`, content: STYLE_LABELS[s], fg: ctx.colors().sidebarFg }),
    );

  const open = (paths: string[]): void => {
    if (!paths.length) return;
    if (opened) close();
    ctx.floats.open("bulkrename", rawClose);
    opened = true;
    items = paths.map((p) => ({ path: p }));
    value = "";
    style = "plain";
    const c = ctx.colors();
    const inputW = PANEL_W - 2 - 2 - LABEL_W - 1;
    const scrim = Box(
      {
        id: "tfm-bulkrename",
        position: "absolute",
        left: 0,
        top: 0,
        width: "100%",
        height: "100%",
        alignItems: "center",
        justifyContent: "center",
        zIndex: FLOAT_Z.bulkrename,
        backgroundColor: RGBA.fromInts(0, 0, 0, 150),
        onMouseDown: () => close(),
      },
      Box(
        {
          id: "tfm-bulkrename-panel",
          width: PANEL_W,
          ...floatSurface(ctx.uiStyle(), ctx.colors(), ctx.colors().sidebarBg),
          paddingTop: 1,
          paddingBottom: 1,
          flexDirection: "column",
          onMouseDown: (ev: any) => {
            try {
              ev.stopPropagation?.();
            } catch {}
          },
        },
        Box(
          { width: "100%", height: 1, flexDirection: "row", alignItems: "center", paddingLeft: 2, paddingRight: 1 },
          Text({ content: `Rename ${items.length} items`, fg: c.accent }),
          Box({ flexGrow: 1 }),
          ctx.escHintBtn("tfm-bulkrename-esc", () => close()),
        ),
        Box({ width: "100%", height: 1 }, Text({ content: "\u00A0", fg: c.sidebarFgMuted })),
        Box(
          { width: "100%", height: 1, flexDirection: "row", alignItems: "center", paddingLeft: 2, columnGap: 1 },
          Text({ content: "New name", width: LABEL_W, fg: c.sidebarFgMuted }),
          Input({
            id: "tfm-bulkrename-input",
            width: inputW,
            placeholder: "New name…",
            backgroundColor: c.accentBg,
            focusedBackgroundColor: c.accentBg,
            textColor: c.white,
          }),
        ),
        Box(
          { width: "100%", height: 1, flexDirection: "row", alignItems: "center", paddingLeft: 2, columnGap: 1 },
          Text({ content: "Number", width: LABEL_W, fg: c.sidebarFgMuted }),
          ...STYLES.map((s) => chip(s)),
        ),
        Box({ width: "100%", height: 1 }, Text({ content: "\u00A0", fg: c.sidebarFgMuted })),
        Box({ width: "100%", height: 1, paddingLeft: 2 }, Text({ content: "Preview", fg: c.sidebarFgMuted })),
        Box({ id: "tfm-bulkrename-preview", width: "100%", flexDirection: "column" }),
        Box(
          { width: "100%", height: 1, paddingLeft: 2, paddingRight: 2 },
          Text({ id: "tfm-bulkrename-error", content: EMPTY_ERROR, fg: c.ansi1 }),
        ),
        Box({ width: "100%", height: 1 }, Text({ content: "\u00A0", fg: c.sidebarFgMuted })),
        Box(
          { width: "100%", height: 1, flexDirection: "row", columnGap: 2, paddingLeft: 2, paddingRight: 2 },
          btn("tfm-bulkrename-cancel", "[ Cancel ]", c.sidebarFg, () => close()),
          btn("tfm-bulkrename-ok", "[ Rename ]", c.accent, () => apply()),
        ),
      ),
    );
    ctx.rootAdd(scrim);
    const input: any = ctx.byId("tfm-bulkrename-input");
    if (input?.on) {
      input.on("input", () => {
        try {
          value = String(input.value ?? "");
        } catch {}
        renderPreview();
      });
    }
    ctx.stripSelectable();
    void ctx.drainIconQueue();
    setError("");
    repaintStyles();
    renderPreview();
    focusTimer = setTimeout(() => {
      focusTimer = null;
      try {
        ctx.byId("tfm-bulkrename-input")?.focus?.();
      } catch {}
    }, 10);
  };

  return {
    open,
    close,
    apply,
    handleKey,
    isOpen: (): boolean => opened,
    // test seam: drive the input without native key events
    setValue: (v: string): void => {
      try {
        const input: any = ctx.byId("tfm-bulkrename-input");
        if (input) input.value = v;
      } catch {}
      value = v;
      renderPreview();
    },
  };
};
