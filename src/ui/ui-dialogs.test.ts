import { describe, expect, test } from "bun:test";
import { createTestRenderer, type TestRendererSetup } from "@opentui/core/testing";
import { makeDialogs, makeConflict, makeYesNo } from "./ui-dialogs";
import { makeFloats, type Floats } from "./floats";

// Floating-layer state lives in ./floats (single source of truth): the
// conflict/yesno prompts register through it, so opening one dismisses the
// context menu + any other layer by POLICY. openDialog additionally keeps a
// closeFileMenu baseline for future dialogs. The regression this pins:
// select-all → Properties… used to leave the menu floating over the dialog.
const makeCtx = () => {
  const calls: string[] = [];
  let lastAdded: any = null;
  const floats: Floats = makeFloats();
  const ctx = {
    byId: () => null,
    rootAdd: (node: any) => {
      lastAdded = node;
      calls.push("add-scrim");
    },
    stripSelectable: () => {},
    termH: () => 24,
    uiStyle: () => "solid" as const,
    colors: () =>
      ({
        sidebarBg: "#000000",
        accent: "#ffffff",
        accentBg: "#111111",
        divider: "#333333",
        sidebarFg: "#ffffff",
        sidebarFgMuted: "#888888",
        white: "#ffffff",
        ansi1: "#ff0000",
        hoverBg: "#222222",
      }) as any,
    closeFileMenu: () => calls.push("close-menu"),
    floats,
  };
  return { ctx, calls, lastAdded: () => lastAdded, floats };
};

describe("openDialog chokepoint", () => {
  test("closes the context menu BEFORE the scrim is added", () => {
    const { ctx, calls } = makeCtx();
    const { openDialog } = makeDialogs(ctx);
    openDialog({ id: "tfm-test", zIndex: 3300, width: 20, rows: () => [], onClose: () => {} });
    const closeIdx = calls.indexOf("close-menu");
    const addIdx = calls.indexOf("add-scrim");
    expect(closeIdx).toBeGreaterThanOrEqual(0);
    expect(addIdx).toBeGreaterThanOrEqual(0);
    expect(closeIdx).toBeLessThan(addIdx);
  });

  test("conflict prompt opens through floats: menu dismissed, conflict tracked", () => {
    const { ctx, calls, floats } = makeCtx();
    // simulate a menu popup being open
    floats.open("filemenu", () => {});
    const dialogs = makeDialogs(ctx);
    const conflict = makeConflict(dialogs, {
      colors: ctx.colors,
      uiStyle: ctx.uiStyle,
      byId: () => null,
      drainIconQueue: () => {},
      floats,
    });
    void conflict.promptConflict("/a/b.txt", 0);
    expect(floats.isOpen("filemenu")).toBe(false);
    expect(floats.top()).toBe("conflict");
    expect(calls.indexOf("close-menu")).toBe(calls.indexOf("add-scrim") - 1);

    // picking a choice closes through floats
    conflict.closeConflict("replace");
    expect(floats.isOpen("conflict")).toBe(false);
    expect(floats.depth()).toBe(0);
  });

  test("pending conflict resolves 'skip' when floats dismisses it (policy close)", () => {
    const { ctx, floats } = makeCtx();
    const dialogs = makeDialogs(ctx);
    const conflict = makeConflict(dialogs, {
      colors: ctx.colors,
      uiStyle: ctx.uiStyle,
      byId: () => null,
      drainIconQueue: () => {},
      floats,
    });
    void conflict.promptConflict("/a/b.txt", 0);
    // a props dialog opens afterwards — floats clears the desktop, the
    // pending prompt must not hang forever
    floats.open("props", () => {});
    expect(conflict.isOpen()).toBe(false);
    expect(floats.top()).toBe("props");
  });

  test("yesno opens through floats; No routes back through floats", () => {
    const { ctx, floats } = makeCtx();
    const dialogs = makeDialogs(ctx);
    const yesNo = makeYesNo(dialogs, {
      colors: ctx.colors,
      uiStyle: ctx.uiStyle,
      byId: ctx.byId,
      canOpen: () => true,
      floats,
    });
    let confirmed = false;
    yesNo.confirm("Empty Trash?", "Empty", () => {
      confirmed = true;
    });
    expect(floats.top()).toBe("yesno");
    yesNo.close();
    expect(floats.isOpen("yesno")).toBe(false);
    expect(confirmed).toBe(false);
  });

  test("keyboard: focus defaults to No, arrows move, submit activates", () => {
    const { ctx, floats } = makeCtx();
    const dialogs = makeDialogs(ctx);
    const yesNo = makeYesNo(dialogs, {
      colors: ctx.colors,
      uiStyle: ctx.uiStyle,
      byId: ctx.byId,
      canOpen: () => true,
      floats,
    });
    let confirmed = false;
    yesNo.confirm("Empty Trash?", "Empty", () => {
      confirmed = true;
    });
    yesNo.submit(); // No focused → closes as No
    expect(confirmed).toBe(false);
    expect(floats.isOpen("yesno")).toBe(false);

    yesNo.confirm("Empty Trash?", "Empty", () => {
      confirmed = true;
    });
    yesNo.moveFocus(1); // → Yes
    yesNo.submit();
    expect(confirmed).toBe(true);
    expect(floats.isOpen("yesno")).toBe(false);
  });

  test("moveFocus wraps and is a no-op while closed", () => {
    const { ctx, floats } = makeCtx();
    const dialogs = makeDialogs(ctx);
    const yesNo = makeYesNo(dialogs, {
      colors: ctx.colors,
      uiStyle: ctx.uiStyle,
      byId: ctx.byId,
      canOpen: () => true,
      floats,
    });
    expect(() => yesNo.moveFocus(1)).not.toThrow();
    expect(() => yesNo.submit()).not.toThrow();
    let confirmed = false;
    yesNo.confirm("Sure?", "Yes", () => {
      confirmed = true;
    });
    yesNo.moveFocus(-1); // wraps No → Yes
    yesNo.submit();
    expect(confirmed).toBe(true);
  });

  test("scrim click routes to onClose (dismiss-by-click-away still works)", () => {
    const { ctx, lastAdded } = makeCtx();
    const { openDialog } = makeDialogs(ctx);
    let closed = false;
    openDialog({
      id: "tfm-test",
      zIndex: 3300,
      width: 20,
      rows: () => [],
      onClose: () => {
        closed = true;
      },
    });
    const scrim = lastAdded();
    expect(typeof scrim.props.onMouseDown).toBe("function");
    scrim.props.onMouseDown({});
    expect(closed).toBe(true);
  });
});

// Theme-switch repaints: conflict/yesno persist while open (batch ops), so a
// palette landing mid-dialog must repaint them — by id, no rebuild (the
// pending promise + focus state survive).
const hexInts = (hex: string): [number, number, number, number] => {
  const n = Number.parseInt(hex.slice(1), 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff, 255];
};

// post-mount fg is a parsed RGBA object, never the assigned hex string
const fgInts = (n: any): [number, number, number, number] =>
  typeof n.fg === "string" ? hexInts(n.fg) : (n.fg.toInts() as [number, number, number, number]);

const mkLive = (t: TestRendererSetup, floats: Floats, getColors: () => any) => {
  const ctx = {
    byId: (id: string) => t.renderer.root.findDescendantById(id),
    rootAdd: (n: any) => t.renderer.root.add(n),
    stripSelectable: () => {},
    termH: () => 24,
    uiStyle: () => "solid" as const,
    colors: getColors,
    closeFileMenu: () => {},
    floats,
  };
  const dialogs = makeDialogs(ctx);
  return {
    conflict: makeConflict(dialogs, {
      colors: getColors,
      uiStyle: () => "solid" as const,
      byId: (id: string) => t.renderer.root.findDescendantById(id),
      drainIconQueue: () => {},
      floats,
    }),
    yesNo: makeYesNo(dialogs, {
      colors: getColors,
      uiStyle: () => "solid" as const,
      byId: (id: string) => t.renderer.root.findDescendantById(id),
      floats,
      canOpen: () => true,
    }),
  };
};

describe("dialog repaints", () => {
  test("conflict repaint() repaints panel + buttons + texts, keeps the pending choice", async () => {
    const t = await createTestRenderer({ width: 90, height: 24 });
    try {
      const floats = makeFloats();
      let live: any = { ...makeCtx().ctx.colors() };
      const { conflict } = mkLive(t, floats, () => live);
      let choice = "";
      const p = conflict.promptConflict("/a/b.txt", 1).then((c) => (choice = c));
      await t.renderOnce();
      expect(floats.isOpen("conflict")).toBe(true);
      live = { ...live, sidebarBg: "#101020", accentBg: "#303040", accent: "#ff0000", sidebarFg: "#f0f0f0" };
      conflict.repaint();
      await t.renderOnce();
      const panel = t.renderer.root.findDescendantById("tfm-conflict") as any;
      expect([...panel.backgroundColor.toInts()]).toEqual(hexInts("#101020"));
      const btn = t.renderer.root.findDescendantById("tfm-conflict-b0") as any;
      expect([...btn.backgroundColor.toInts()]).toEqual(hexInts("#101020"));
      const title = t.renderer.root.findDescendantById("tfm-conflict-title") as any;
      expect(fgInts(title)).toEqual(hexInts("#ff0000"));
      // the pending prompt still resolves (no rebuild swallowed it)
      conflict.closeConflict("keepBoth");
      await p;
      expect(choice).toBe("keepBoth");
    } finally {
      t.renderer.destroy();
    }
  });

  test("yesno repaint() repaints panel + texts + focus, keeps the pending confirm", async () => {
    const t = await createTestRenderer({ width: 90, height: 24 });
    try {
      const floats = makeFloats();
      let live: any = { ...makeCtx().ctx.colors() };
      const { yesNo } = mkLive(t, floats, () => live);
      let confirmed = false;
      yesNo.confirm("Empty Trash?", "Empty", () => (confirmed = true), true);
      await t.renderOnce();
      expect(floats.isOpen("yesno")).toBe(true);
      live = { ...live, sidebarBg: "#101020", ansi1: "#00ff00" };
      yesNo.repaint();
      await t.renderOnce();
      const panel = t.renderer.root.findDescendantById("tfm-yesno") as any;
      expect([...panel.backgroundColor.toInts()]).toEqual(hexInts("#101020"));
      const msg = t.renderer.root.findDescendantById("tfm-yesno-msg") as any;
      expect(fgInts(msg)).toEqual(hexInts("#00ff00"));
      yesNo.moveFocus(1);
      yesNo.submit();
      expect(confirmed).toBe(true);
    } finally {
      t.renderer.destroy();
    }
  });

  test("dialog repaints no-op when closed", async () => {
    const t = await createTestRenderer({ width: 90, height: 24 });
    try {
      const floats = makeFloats();
      const { conflict, yesNo } = mkLive(t, floats, makeCtx().ctx.colors);
      expect(() => conflict.repaint()).not.toThrow();
      expect(() => yesNo.repaint()).not.toThrow();
    } finally {
      t.renderer.destroy();
    }
  });
});
