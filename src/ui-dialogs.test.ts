import { describe, expect, test } from "bun:test";
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
    const conflict = makeConflict(dialogs, { colors: ctx.colors, drainIconQueue: () => {}, floats });
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
    const conflict = makeConflict(dialogs, { colors: ctx.colors, drainIconQueue: () => {}, floats });
    const _p = conflict.promptConflict("/a/b.txt", 0);
    // a props dialog opens afterwards — floats clears the desktop, the
    // pending prompt must not hang forever
    floats.open("props", () => {});
    expect(conflict.isOpen()).toBe(false);
    expect(floats.top()).toBe("props");
  });

  test("yesno opens through floats; No routes back through floats", () => {
    const { ctx, floats } = makeCtx();
    const dialogs = makeDialogs(ctx);
    const yesNo = makeYesNo(dialogs, { colors: ctx.colors, canOpen: () => true, floats });
    let confirmed = false;
    yesNo.confirm("Empty Trash?", "Empty", () => {
      confirmed = true;
    });
    expect(floats.top()).toBe("yesno");
    yesNo.close();
    expect(floats.isOpen("yesno")).toBe(false);
    expect(confirmed).toBe(false);
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
