import { describe, expect, test } from "bun:test";
import { makeDialogs, makeConflict, makeYesNo } from "./ui-dialogs";

// The floating context menu sits at zIndex 3600 — ABOVE every dialog — so any
// dialog open path that forgets to dismiss it leaves it stuck on screen
// (regression: select-all → Properties… kept the menu over the multi dialog).
// The close must happen in openDialog itself, not per call site.
const makeCtx = () => {
  const calls: string[] = [];
  let lastAdded: any = null;
  const ctx = {
    byId: () => null,
    rootAdd: (node: any) => { lastAdded = node; calls.push("add-scrim"); },
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
  };
  return { ctx, calls, lastAdded: () => lastAdded };
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

  test("conflict + yesno prompts inherit the guarantee (both route through openDialog)", () => {
    const { ctx, calls } = makeCtx();
    const dialogs = makeDialogs(ctx);
    const conflict = makeConflict(dialogs, { colors: ctx.colors, drainIconQueue: () => {}, closeTransients: () => {} });
    void conflict.promptConflict("/a/b.txt", 0);
    expect(calls.indexOf("close-menu")).toBe(calls.indexOf("add-scrim") - 1);

    calls.length = 0;
    const yesNo = makeYesNo(dialogs, { colors: ctx.colors, canOpen: () => true });
    yesNo.confirm("Empty Trash?", "Empty", () => {});
    expect(calls.indexOf("close-menu")).toBe(calls.indexOf("add-scrim") - 1);
  });

  test("scrim click routes to onClose (dismiss-by-click-away still works)", () => {
    const { ctx, lastAdded } = makeCtx();
    const { openDialog } = makeDialogs(ctx);
    let closed = false;
    openDialog({ id: "tfm-test", zIndex: 3300, width: 20, rows: () => [], onClose: () => { closed = true; } });
    const scrim = lastAdded();
    expect(typeof scrim.props.onMouseDown).toBe("function");
    scrim.props.onMouseDown({});
    expect(closed).toBe(true);
  });
});
