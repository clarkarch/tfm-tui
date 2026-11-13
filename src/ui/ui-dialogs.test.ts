import { describe, expect, test } from "bun:test";
import { createTextAttributes } from "@opentui/core";
import { createTestRenderer, type TestRendererSetup } from "@opentui/core/testing";
import { makeDialogs, makeConflict, makeModalScrim, makeYesNo } from "./ui-dialogs";
import { makeFloats, type Floats } from "./floats";
import type { ConflictAnswer } from "../lib/file-op-protocol";

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
        bg: "#0a0a0a",
        sidebarBg: "#000000",
        accent: "#00ff00",
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

const ask = (
  yesNo: ReturnType<typeof makeYesNo>,
  title: string,
  onYes: () => void,
  opts: { body?: string; yesLabel?: string; danger?: boolean; onNo?: () => void } = {},
) => yesNo.confirm({ title, onYes, ...opts });

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

  // Contract this pins: confirm() has NO readiness gate. Its old wiring keyed
  // off `renderer.resolution`, which never lands on the Linux console or tmux
  // (no pixel-size reply), so Empty Trash / Delete Forever silently no-op'd
  // there. makeConflict already opens ungated; re-adding any gate defaulting
  // closed breaks this test (and the floats/traversal tests above).
  test("confirm opens with no readiness gate and the pending Yes still fires", () => {
    const { ctx, floats } = makeCtx();
    const dialogs = makeDialogs(ctx);
    const yesNo = makeYesNo(dialogs, {
      colors: ctx.colors,
      uiStyle: ctx.uiStyle,
      byId: ctx.byId,
      floats,
    });
    let confirmed = false;
    expect(
      ask(yesNo, "Empty Trash?", () => {
        confirmed = true;
      }),
    ).toEqual({ kind: "opened" });
    expect(floats.top()).toBe("yesno");
    yesNo.submit(); // the cursor starts on Yes → the pending Yes fires
    expect(confirmed).toBe(true);
  });

  test("yesno opens through floats; No routes back through floats", () => {
    const { ctx, floats } = makeCtx();
    const dialogs = makeDialogs(ctx);
    const yesNo = makeYesNo(dialogs, {
      colors: ctx.colors,
      uiStyle: ctx.uiStyle,
      byId: ctx.byId,
      floats,
    });
    let confirmed = false;
    ask(yesNo, "Empty Trash?", () => {
      confirmed = true;
    });
    expect(floats.top()).toBe("yesno");
    yesNo.close();
    expect(floats.isOpen("yesno")).toBe(false);
    expect(confirmed).toBe(false);
  });

  test("confirm force-opens over the esc-menu (settings toggle must surface the question)", () => {
    // the default-file-manager toggle lives INSIDE the esc-menu: opening the
    // confirm through the floats modal policy would dismiss the menu first
    // and then die with it — the user flips the toggle and nothing happens.
    // The floats modal policy closes the menu, THEN the confirm opens, so the
    // pending Yes still fires on a live dialog.
    const { ctx, floats } = makeCtx();
    floats.open("escmenu", () => {});
    const dialogs = makeDialogs(ctx);
    const yesNo = makeYesNo(dialogs, {
      colors: ctx.colors,
      uiStyle: ctx.uiStyle,
      byId: ctx.byId,
      floats,
    });
    let confirmed = false;
    expect(
      ask(yesNo, "Make tfm the default file manager?", () => {
        confirmed = true;
      }),
    ).toEqual({ kind: "opened" });
    expect(floats.isOpen("escmenu")).toBe(false);
    expect(floats.top()).toBe("yesno");
    yesNo.submit(); // the cursor starts on Yes → the pending Yes fires
    expect(confirmed).toBe(true);
    expect(floats.isOpen("yesno")).toBe(false);
  });

  test("keyboard: the cursor starts on the affirmative action for every prompt", () => {
    // The affirmative action is the default focus even for a destructive
    // prompt. The warning and the separated action make the consequence
    // explicit; No is never the initial focus.
    const { ctx, floats } = makeCtx();
    const dialogs = makeDialogs(ctx);
    const yesNo = makeYesNo(dialogs, {
      colors: ctx.colors,
      uiStyle: ctx.uiStyle,
      byId: ctx.byId,
      floats,
    });
    let confirmed = false;
    let refused = 0;
    ask(
      yesNo,
      "Make tfm the default file manager?",
      () => {
        confirmed = true;
      },
      {
        onNo: () => {
          refused++;
        },
      },
    );
    yesNo.submit(); // Yes is focused → the pending Yes fires
    expect(confirmed).toBe(true);
    expect(refused).toBe(0);

    confirmed = false;
    refused = 0;
    ask(
      yesNo,
      "Permanently delete 3 items? This cannot be undone.",
      () => {
        confirmed = true;
      },
      {
        danger: true,
        onNo: () => {
          refused++;
        },
      },
    );
    yesNo.submit(); // the affirmative action is focused, including for danger
    expect(confirmed).toBe(true);
    expect(refused).toBe(0);
    expect(floats.isOpen("yesno")).toBe(false);
  });

  test("moveFocus wraps and is a no-op while closed", () => {
    const { ctx, floats } = makeCtx();
    const dialogs = makeDialogs(ctx);
    const yesNo = makeYesNo(dialogs, {
      colors: ctx.colors,
      uiStyle: ctx.uiStyle,
      byId: ctx.byId,
      floats,
    });
    expect(() => yesNo.moveFocus(1)).not.toThrow();
    expect(() => yesNo.submit()).not.toThrow();
    let confirmed = false;
    ask(yesNo, "Sure?", () => {
      confirmed = true;
    });
    yesNo.moveFocus(1); // Yes → No
    yesNo.moveFocus(1); // wraps No → Yes
    yesNo.submit();
    expect(confirmed).toBe(true);
  });

  test("the No answer is reported (a refusal is not a dismissal)", () => {
    // The dialog only ever fired onYes, so a caller could never learn that
    // the user DECLINED: the default-file-manager prompt had no way to
    // record "no", and the question came back on every boot.
    const { ctx, floats } = makeCtx();
    const dialogs = makeDialogs(ctx);
    const yesNo = makeYesNo(dialogs, {
      colors: ctx.colors,
      uiStyle: ctx.uiStyle,
      byId: ctx.byId,
      floats,
    });
    let confirmed = false;
    let refused = 0;
    ask(
      yesNo,
      "Make tfm the default file manager?",
      () => {
        confirmed = true;
      },
      {
        onNo: () => {
          refused++;
        },
      },
    );
    // the cursor starts on Yes — moving it to No and submitting there IS the
    // No answer
    yesNo.moveFocus(1);
    yesNo.submit();
    expect(refused).toBe(1);
    expect(confirmed).toBe(false);
    expect(floats.isOpen("yesno")).toBe(false);
  });

  test("a dismissal is not an answer (esc/click-away never reports No)", () => {
    const { ctx, floats } = makeCtx();
    const dialogs = makeDialogs(ctx);
    const yesNo = makeYesNo(dialogs, {
      colors: ctx.colors,
      uiStyle: ctx.uiStyle,
      byId: ctx.byId,
      floats,
    });
    let refused = 0;
    ask(yesNo, "Make tfm the default file manager?", () => {}, {
      onNo: () => {
        refused++;
      },
    });
    yesNo.close(); // the esc path
    expect(refused).toBe(0);
    expect(floats.isOpen("yesno")).toBe(false);
  });

  test("a second confirm while one is open reports busy (not declined)", () => {
    // The old confirm() answered a bare boolean, so "another question is
    // already up" was indistinguishable from "the user pressed No": the
    // trash + update callers dropped the boolean and the request vanished
    // in silence while the first dialog stayed up.
    const { ctx, floats } = makeCtx();
    const dialogs = makeDialogs(ctx);
    const yesNo = makeYesNo(dialogs, {
      colors: ctx.colors,
      uiStyle: ctx.uiStyle,
      byId: ctx.byId,
      floats,
    });
    let answered = false;
    expect(
      ask(yesNo, "Empty Trash?", () => {
        answered = true;
      }),
    ).toEqual({ kind: "opened" });
    // the SECOND request is refused — it is NOT a decline
    expect(
      ask(yesNo, "Delete forever?", () => {
        answered = true;
      }),
    ).toEqual({ kind: "busy" });
    // the live question is still the FIRST one, and it is still answerable
    expect(floats.top()).toBe("yesno");
    yesNo.submit(); // the cursor starts on Yes → the first question is answered
    expect(answered).toBe(true);
  });

  test("a refused confirm surfaces the refusal (the request is never swallowed in silence)", () => {
    // The dialog is the ONE chokepoint every caller goes through, so it
    // owns the refusal notice: a caller that ignores the outcome can never
    // leave the user with a request that silently did nothing.
    const notes: string[] = [];
    const { ctx, floats } = makeCtx();
    const dialogs = makeDialogs(ctx);
    const yesNo = makeYesNo(dialogs, {
      colors: ctx.colors,
      uiStyle: ctx.uiStyle,
      byId: ctx.byId,
      floats,
      notify: (message) => {
        notes.push(message);
      },
    });
    ask(yesNo, "Empty Trash?", () => {});
    expect(notes).toEqual([]); // the question that OPENED says nothing
    ask(yesNo, "Delete forever?", () => {});
    expect(notes).toEqual(["A confirmation is already open · answer it first"]);
  });

  test("yesno shows the full delete message without slicing (two lines, options intact)", async () => {
    const t = await createTestRenderer({ width: 90, height: 24 });
    try {
      const floats = makeFloats();
      const { yesNo } = mkLive(t, floats, makeCtx().ctx.colors);
      ask(yesNo, "Delete permanently", () => {}, {
        body: "3 items will be removed. This cannot be undone.",
        yesLabel: "delete permanently",
        danger: true,
      });
      await t.renderOnce();
      const frame = t.captureCharFrame();
      // the irreversibility warning must survive — the old 36-wide slice cut it
      // (wrapped over two lines, so assert the words, not one contiguous span)
      expect(frame).toContain("cannot be");
      expect(frame).toContain("undone");
      expect(frame).toContain("Delete Permanently");
      expect(frame).toContain("3 items will be removed.");
      // the options are bare words — no brackets anywhere in the dialog
      expect(frame).not.toContain("[");
      const row = frame.split("\n").find((l) => l.includes("Delete Permanently"));
      expect(row).toBeDefined();
      // No is on the left; the affirmative action is on the right. There is
      // no chevron cursor.
      expect(row).toMatch(/No\s+Delete Permanently/);
      expect(frame).not.toContain("›");
    } finally {
      await t.dispose(); // 0.6.0: destroy + await closed
    }
  });

  test("a conflict whose teardown throws still clears isOpen (a stuck true swallows every key)", async () => {
    // isOpen() gates the key router: a conflict that stays "open" after its
    // layer left the float stack swallows EVERY key (a permanent keyboard
    // deadlock). The teardown is best-effort cleanup — a failing native
    // remove must not leave the state stuck, nor strand the pending op.
    const base = makeCtx();
    const ctx = {
      ...base.ctx,
      byId: (): never => {
        throw new Error("native remove failed");
      },
    };
    const dialogs = makeDialogs(ctx);
    const conflict = makeConflict(dialogs, {
      colors: ctx.colors,
      uiStyle: ctx.uiStyle,
      byId: () => null,
      drainIconQueue: () => {},
      floats: base.floats,
    });
    const answers: ConflictAnswer[] = [];
    const p = conflict.promptConflict("/a/b.txt", 0).then((a) => {
      answers.push(a);
    });
    expect(conflict.isOpen()).toBe(true);
    expect(() => conflict.closeConflict("skip")).not.toThrow();
    expect(conflict.isOpen()).toBe(false);
    // the pending op must not hang on the failing teardown
    await p;
    expect(answers).toEqual([{ choice: "skip" }]);
  });

  test("a yes/no teardown that throws still clears its state", () => {
    // The key router checks isOpen(). A native teardown failure must not leave
    // the question marked open after its float layer has already left the
    // stack, or every subsequent key is swallowed by a prompt that is gone.
    const base = makeCtx();
    const dialogs = makeDialogs({
      ...base.ctx,
      byId: (): never => {
        throw new Error("native remove failed");
      },
    });
    const yesNo = makeYesNo(dialogs, {
      colors: base.ctx.colors,
      uiStyle: base.ctx.uiStyle,
      byId: (): never => {
        throw new Error("native remove failed");
      },
      floats: base.floats,
    });
    ask(yesNo, "Remove everything", () => {});
    expect(yesNo.isOpen()).toBe(true);
    expect(() => yesNo.close()).not.toThrow();
    expect(yesNo.isOpen()).toBe(false);
    expect(base.floats.isOpen("yesno")).toBe(false);
  });

  test("a failed mount rolls back the yes/no state and float layer", () => {
    // A failed native mount must not leave a question marked open after its
    // layer is gone: isOpen() gates the key router, so that stale state would
    // swallow every key in the session.
    const base = makeCtx();
    const dialogs = makeDialogs({
      ...base.ctx,
      rootAdd: () => {
        throw new Error("mount failed");
      },
    });
    const yesNo = makeYesNo(dialogs, {
      colors: base.ctx.colors,
      uiStyle: base.ctx.uiStyle,
      byId: base.ctx.byId,
      floats: base.floats,
    });
    expect(() => ask(yesNo, "Remove everything", () => {})).toThrow("mount failed");
    expect(yesNo.isOpen()).toBe(false);
    expect(base.floats.isOpen("yesno")).toBe(false);
  });

  test("the '…all' choice rides in the answer (the dialog remembers no policy)", async () => {
    // The old dialog kept a module-level policy that only THREE explicit
    // resetPolicy() calls cleared — a path that forgot the reset made the
    // NEXT unrelated collision auto-resolve as "replace" (data loss). The
    // answer now carries "apply to the rest", so the CALLER owns the batch
    // policy and it cannot outlive the operation.
    const { ctx, floats } = makeCtx();
    const dialogs = makeDialogs(ctx);
    const conflict = makeConflict(dialogs, {
      colors: ctx.colors,
      uiStyle: ctx.uiStyle,
      byId: () => null,
      drainIconQueue: () => {},
      floats,
    });
    const answers: ConflictAnswer[] = [];
    const p = conflict.promptConflict("/a/b.txt", 3).then((a) => {
      answers.push(a);
    });
    conflict.closeConflict("replace", "replace");
    await p;
    expect(answers).toEqual([{ choice: "replace", applyToRest: "replace" }]);
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

  test("the scrim carries NO background fill (a fill makes OpenTUI delete every raster under it)", () => {
    // The old `RGBA(0,0,0,150)` fill made 0.6.0 unreserve every kitty placement
    // it covered, so thumbnails vanished under any modal (the glyph-fallback
    // hack existed only to mask that). The dim now rides tfm-content opacity.
    const { ctx, lastAdded } = makeCtx();
    const { openDialog } = makeDialogs(ctx);
    openDialog({ id: "tfm-nofill", zIndex: 3300, width: 20, rows: () => [], onClose: () => {} });
    expect(lastAdded().props.backgroundColor).toBeUndefined();
  });

  test("makeModalScrim (esc menu / pick / prompt path) is fill-less too", () => {
    const node: any = makeModalScrim(
      { uiStyle: () => "solid" as const, colors: () => ({ sidebarBg: "#000000" }) as any },
      { id: "tfm-x", zIndex: 1, panelWidth: 10, onClose: () => {} },
    );
    expect(node.props.backgroundColor).toBeUndefined();
    expect(typeof node.props.onMouseDown).toBe("function");
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

// mouse pointer shapes requested through the ctx seam (OSC 22 sink)
const pointers: string[] = [];

const mkLive = (
  t: TestRendererSetup,
  floats: Floats,
  getColors: () => any,
  uiStyle: () => "solid" | "outline" = () => "solid",
) => {
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
      uiStyle,
      byId: (id: string) => t.renderer.root.findDescendantById(id),
      drainIconQueue: () => {},
      floats,
      setPointer: (s) => void pointers.push(s),
    }),
    yesNo: makeYesNo(dialogs, {
      colors: getColors,
      uiStyle,
      byId: (id: string) => t.renderer.root.findDescendantById(id),
      floats,
      setPointer: (s) => void pointers.push(s),
    }),
  };
};

describe("the yes/no answer", () => {
  test("a request renders only its body, warning, and title-cased actions", async () => {
    // The dedicated title row and close X are gone. The body carries the
    // question's consequence; the actions carry the answer.
    const t = await createTestRenderer({ width: 90, height: 24 });
    try {
      const floats = makeFloats();
      const colors = makeCtx().ctx.colors();
      const { yesNo } = mkLive(t, floats, makeCtx().ctx.colors);
      yesNo.confirm({
        title: "Never render this heading",
        body: "3 items will be removed.",
        yesLabel: "empty trash",
        danger: true,
        onYes: () => {},
      });
      await t.renderOnce();
      const frame = t.captureCharFrame();
      expect(frame).not.toContain("Never render this heading");
      expect(frame).toContain("3 items will be removed.");
      expect(frame).toContain("This cannot be undone.");
      expect(frame).toContain("No");
      expect(frame).toContain("Empty Trash");
      expect(frame).not.toContain("›");
      expect(frame).not.toContain("×");
      expect(t.renderer.root.findDescendantById("tfm-yesno-title")).toBeFalsy();
      expect(t.renderer.root.findDescendantById("tfm-yesno-close")).toBeFalsy();
      const body = t.renderer.root.findDescendantById("tfm-yesno-body") as any;
      const warning = t.renderer.root.findDescendantById("tfm-yesno-body-2") as any;
      expect(fgInts(body)).toEqual(hexInts(colors.ansi1));
      expect(fgInts(warning)).toEqual(hexInts(colors.ansi1));
      // Every prompt starts on the affirmative action, including danger. A
      // destructive affirmative action carries the red highlight, not blue.
      const yesLabel = t.renderer.root.findDescendantById("tfm-yesno-b0-label") as any;
      const noLabel = t.renderer.root.findDescendantById("tfm-yesno-b1-label") as any;
      expect(fgInts(yesLabel)).toEqual(hexInts(colors.ansi1));
      expect(fgInts(noLabel)).toEqual(hexInts(colors.white));
    } finally {
      await t.dispose(); // 0.6.0: destroy + await closed
    }
  });

  test("No and the title-cased action occupy equal, centered halves", async () => {
    const t = await createTestRenderer({ width: 90, height: 24 });
    try {
      const floats = makeFloats();
      const { yesNo } = mkLive(t, floats, makeCtx().ctx.colors);
      ask(yesNo, "Empty trash", () => {}, {
        body: "3 items will be removed.",
        yesLabel: "empty trash",
      });
      await t.renderOnce();
      const frame = t.captureCharFrame();
      const row = frame.split("\n").find((line) => line.includes("Empty Trash") && line.includes("No"));
      expect(row).toBeDefined();
      expect(row).toMatch(/No\s+Empty Trash/);
      // The choices split the action row into equal halves. Each label is
      // centered in its own half rather than stranded at an outer edge.
      const no = t.renderer.root.findDescendantById("tfm-yesno-b1-slot") as any;
      const yes = t.renderer.root.findDescendantById("tfm-yesno-b0-slot") as any;
      const noLayout = no.getLayout();
      const yesLayout = yes.getLayout();
      expect(noLayout.width).toBe(yesLayout.width);
      expect(noLayout.left).toBeLessThan(yesLayout.left);
      const noAt = row!.indexOf("No");
      const actionAt = row!.indexOf("Empty Trash");
      expect(actionAt - noAt).toBeGreaterThanOrEqual(12);
      expect(frame).not.toContain("›");
    } finally {
      await t.dispose(); // 0.6.0: destroy + await closed
    }
  });

  test("the body and irreversible warning have a blank row between them", async () => {
    const t = await createTestRenderer({ width: 90, height: 24 });
    try {
      const floats = makeFloats();
      const { yesNo } = mkLive(t, floats, makeCtx().ctx.colors);
      ask(yesNo, "Empty trash", () => {}, {
        body: "3 items will be removed.",
        yesLabel: "empty trash",
        danger: true,
      });
      await t.renderOnce();
      const rows = t.captureCharFrame().split("\n");
      const bodyRow = rows.findIndex((line) => line.includes("3 items will be removed."));
      const warningRow = rows.findIndex((line) => line.includes("This cannot be undone."));
      expect(bodyRow).toBeGreaterThanOrEqual(0);
      expect(warningRow).toBeGreaterThan(bodyRow);
      expect(warningRow - bodyRow).toBeGreaterThanOrEqual(2);
      expect(rows.slice(bodyRow + 1, warningRow).every((line) => line.trim() === "")).toBe(true);
    } finally {
      await t.dispose(); // 0.6.0: destroy + await closed
    }
  });

  test("the affirmative option defaults to yes and a normal prompt starts there", async () => {
    const t = await createTestRenderer({ width: 90, height: 24 });
    try {
      const floats = makeFloats();
      const colors = makeCtx().ctx.colors();
      const { yesNo } = mkLive(t, floats, makeCtx().ctx.colors);
      yesNo.confirm({ title: "Continue?", body: "The plugin wants to continue.", onYes: () => {} });
      await t.renderOnce();
      const frame = t.captureCharFrame();
      expect(frame).toContain("Yes");
      expect(frame).toContain("No");
      const yes = t.renderer.root.findDescendantById("tfm-yesno-b0") as any;
      const no = t.renderer.root.findDescendantById("tfm-yesno-b1") as any;
      const yesLabel = t.renderer.root.findDescendantById("tfm-yesno-b0-label") as any;
      const noLabel = t.renderer.root.findDescendantById("tfm-yesno-b1-label") as any;
      const body = t.renderer.root.findDescendantById("tfm-yesno-body") as any;
      expect(fgInts(body)).toEqual(hexInts(colors.accent));
      expect(fgInts(yesLabel)).toEqual(hexInts(colors.accent));
      expect(fgInts(noLabel)).toEqual(hexInts(colors.white));
      expect([...yes.backgroundColor.toInts()]).not.toEqual(hexInts(colors.accent));
      expect([...no.backgroundColor.toInts()]).not.toEqual(hexInts(colors.accent));
    } finally {
      await t.dispose(); // 0.6.0: destroy + await closed
    }
  });

  test("a long body never grows past two lines", async () => {
    const t = await createTestRenderer({ width: 90, height: 24 });
    try {
      const floats = makeFloats();
      const { yesNo } = mkLive(t, floats, makeCtx().ctx.colors);
      yesNo.confirm({
        title: "This title is hidden",
        body: "A long explanation with many words that must be folded into the dialog without creating a third body row.",
        onYes: () => {},
      });
      await t.renderOnce();
      const frame = t.captureCharFrame();
      expect(frame).toContain("…");
      expect(frame).not.toContain("This title is hidden");
      expect(t.renderer.root.findDescendantById("tfm-yesno-body")).toBeTruthy();
      expect(t.renderer.root.findDescendantById("tfm-yesno-body-2")).toBeTruthy();
      expect(t.renderer.root.findDescendantById("tfm-yesno-body-3")).toBeFalsy();
    } finally {
      await t.dispose(); // 0.6.0: destroy + await closed
    }
  });

  test("an outline panel reserves its border before wrapping the body", async () => {
    const t = await createTestRenderer({ width: 90, height: 24 });
    try {
      const floats = makeFloats();
      const { yesNo } = mkLive(t, floats, makeCtx().ctx.colors, () => "outline");
      yesNo.confirm({
        title: "This title is hidden",
        body: "A body that is deliberately much longer than the outlined dialog panel and must stay inside its border.",
        onYes: () => {},
      });
      await t.renderOnce();
      // The visible body ends in an ellipsis. A raw length budget that ignores
      // the border would put the ellipsis outside the clipped content.
      expect(t.captureCharFrame()).toContain("…");
    } finally {
      await t.dispose(); // 0.6.0: destroy + await closed
    }
  });

  test("a title is hidden when a body exists and becomes the body when it does not", async () => {
    const t = await createTestRenderer({ width: 90, height: 24 });
    try {
      const floats = makeFloats();
      const { yesNo } = mkLive(t, floats, makeCtx().ctx.colors);
      yesNo.confirm({ title: "First line\nSecond line", body: "Body", onYes: () => {} });
      await t.renderOnce();
      let frame = t.captureCharFrame();
      expect(frame).toContain("Body");
      expect(frame).not.toContain("First line");
      yesNo.close();

      yesNo.confirm({ title: "First line\nSecond line", onYes: () => {} });
      await t.renderOnce();
      frame = t.captureCharFrame();
      expect(frame).toContain("First line Second line");
      expect(frame).not.toContain("Second line\n");
    } finally {
      await t.dispose(); // 0.6.0: destroy + await closed
    }
  });

  test("a danger prompt always keeps the irreversibility warning", async () => {
    const t = await createTestRenderer({ width: 90, height: 24 });
    try {
      const floats = makeFloats();
      const { yesNo } = mkLive(t, floats, makeCtx().ctx.colors);
      yesNo.confirm({
        title: "Remove everything",
        body: "This removes the selected items.",
        yesLabel: "remove",
        danger: true,
        onYes: () => {},
      });
      await t.renderOnce();
      expect(t.captureCharFrame()).toContain("This cannot be undone.");
    } finally {
      await t.dispose(); // 0.6.0: destroy + await closed
    }
  });

  test("a danger prompt with no body still keeps the irreversibility warning", async () => {
    const t = await createTestRenderer({ width: 90, height: 24 });
    try {
      const floats = makeFloats();
      const { yesNo } = mkLive(t, floats, makeCtx().ctx.colors);
      yesNo.confirm({
        title: "Remove everything",
        yesLabel: "remove",
        danger: true,
        onYes: () => {},
      });
      await t.renderOnce();
      expect(t.captureCharFrame()).toContain("This cannot be undone.");
    } finally {
      await t.dispose(); // 0.6.0: destroy + await closed
    }
  });

  test("the No OPTION reports the answer (a click is an answer, not a dismissal)", async () => {
    // the mouse path and the keyboard path both route through ONE owner
    // (answerNo) — a click must not skip the record the keyboard records.
    const t = await createTestRenderer({ width: 90, height: 24 });
    try {
      const floats = makeFloats();
      const { yesNo } = mkLive(t, floats, makeCtx().ctx.colors);
      let refused = 0;
      ask(yesNo, "Make tfm the default file manager?", () => {}, {
        onNo: () => {
          refused++;
        },
      });
      await t.renderOnce();
      // b1 is the NO option (b0 is the affirmative action)
      const btn: any = t.renderer.root.findDescendantById("tfm-yesno-b1");
      // getLayout() is PARENT-relative; the click needs screen coordinates
      await t.mockMouse.click(Math.round(btn.screenX) + 1, Math.round(btn.screenY));
      await t.renderOnce();
      expect(refused).toBe(1);
      expect(floats.isOpen("yesno")).toBe(false);
    } finally {
      await t.dispose(); // 0.6.0: destroy + await closed
    }
  });

  test("the focused option uses accent, bold, and underline without a glyph", async () => {
    const t = await createTestRenderer({ width: 90, height: 24 });
    try {
      const floats = makeFloats();
      const colors = makeCtx().ctx.colors();
      const { yesNo } = mkLive(t, floats, makeCtx().ctx.colors);
      ask(yesNo, "Sure?", () => {});
      await t.renderOnce();
      const yes: any = t.renderer.root.findDescendantById("tfm-yesno-b0");
      expect(t.captureCharFrame()).not.toContain("›");
      const label = t.renderer.root.findDescendantById("tfm-yesno-b0-label") as any;
      expect(fgInts(label)).toEqual(hexInts(colors.accent));
      expect(label.attributes).toBe(createTextAttributes({ bold: true, underline: true }));
      // No heavy fill competes with the copy.
      expect([...yes.backgroundColor.toInts()]).not.toEqual(hexInts(colors.accent));
      const noLabel = t.renderer.root.findDescendantById("tfm-yesno-b1-label") as any;
      expect(fgInts(noLabel)).not.toEqual(hexInts(colors.accent));
      expect(noLabel.attributes).toBe(0);
    } finally {
      await t.dispose(); // 0.6.0: destroy + await closed
    }
  });

  test("the mouse hover moves the SAME cursor (one highlight, not two)", async () => {
    // The keyboard and the mouse share ONE cursor: hovering an option moves
    // the accent block there, so Enter answers what the pointer is on.
    const t = await createTestRenderer({ width: 90, height: 24 });
    try {
      const floats = makeFloats();
      const colors = makeCtx().ctx.colors();
      const { yesNo } = mkLive(t, floats, makeCtx().ctx.colors);
      let confirmed = false;
      let refused = 0;
      ask(
        yesNo,
        "Make tfm the default file manager?",
        () => {
          confirmed = true;
        },
        {
          onNo: () => {
            refused++;
          },
        },
      );
      await t.renderOnce();
      const no: any = t.renderer.root.findDescendantById("tfm-yesno-b1");
      await t.mockMouse.moveTo(Math.round(no.screenX) + 1, Math.round(no.screenY));
      await t.renderOnce();
      // the cursor MOVED: the accent word is now on the hovered option
      expect(t.captureCharFrame()).not.toContain("›");
      expect(fgInts(t.renderer.root.findDescendantById("tfm-yesno-b1-label"))).toEqual(hexInts(colors.accent));
      expect(fgInts(t.renderer.root.findDescendantById("tfm-yesno-b0-label"))).not.toEqual(hexInts(colors.accent));
      // ...and the keyboard agrees with the mouse: Enter answers the hovered one
      yesNo.submit();
      expect(refused).toBe(1);
      expect(confirmed).toBe(false);
    } finally {
      await t.dispose(); // 0.6.0: destroy + await closed
    }
  });

  test("a real mouse move reasserts the hovered option after a keyboard move", async () => {
    // The cursor is ONE truth. A keyboard move may move it away while the
    // pointer remains over an option, but the next REAL mouse move must put
    // it back on the option under the pointer before Enter answers.
    const t = await createTestRenderer({ width: 90, height: 24 });
    try {
      const floats = makeFloats();
      const { yesNo } = mkLive(t, floats, makeCtx().ctx.colors);
      let confirmed = 0;
      let refused = 0;
      ask(
        yesNo,
        "Make tfm the default file manager?",
        () => {
          confirmed++;
        },
        {
          onNo: () => {
            refused++;
          },
        },
      );
      await t.renderOnce();
      const no: any = t.renderer.root.findDescendantById("tfm-yesno-b1");
      await t.mockMouse.moveTo(Math.round(no.screenX) + 1, Math.round(no.screenY));
      await t.renderOnce();
      // Move the keyboard cursor away, then move the pointer by one cell
      // without leaving the option.
      yesNo.moveFocus(1);
      await t.mockMouse.moveTo(Math.round(no.screenX) + 2, Math.round(no.screenY));
      await t.renderOnce();
      yesNo.submit();
      expect(refused).toBe(1);
      expect(confirmed).toBe(0);
    } finally {
      await t.dispose(); // 0.6.0: destroy + await closed
    }
  });
});

describe("dialog repaints", () => {
  test("conflict repaint() repaints panel + buttons + texts, keeps the pending choice", async () => {
    const t = await createTestRenderer({ width: 90, height: 24 });
    try {
      const floats = makeFloats();
      let live: any = { ...makeCtx().ctx.colors() };
      const { conflict } = mkLive(t, floats, () => live);
      const answers: ConflictAnswer[] = [];
      const p = conflict.promptConflict("/a/b.txt", 1).then((c) => answers.push(c));
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
      expect(answers).toEqual([{ choice: "keepBoth" }]);
    } finally {
      await t.dispose(); // 0.6.0: destroy + await closed
    }
  });

  test("yesno repaint() repaints panel + texts + focus, keeps the pending confirm", async () => {
    const t = await createTestRenderer({ width: 90, height: 24 });
    try {
      const floats = makeFloats();
      let live: any = { ...makeCtx().ctx.colors() };
      const { yesNo } = mkLive(t, floats, () => live);
      let confirmed = false;
      ask(yesNo, "Delete permanently", () => (confirmed = true), { danger: true });
      await t.renderOnce();
      expect(floats.isOpen("yesno")).toBe(true);
      live = { ...live, sidebarBg: "#101020", accent: "#0000ff", ansi1: "#00ff00" };
      yesNo.repaint();
      await t.renderOnce();
      const panel = t.renderer.root.findDescendantById("tfm-yesno-panel") as any;
      expect([...panel.backgroundColor.toInts()]).toEqual(hexInts("#101020"));
      const body = t.renderer.root.findDescendantById("tfm-yesno-body") as any;
      expect(fgInts(body)).toEqual(hexInts("#00ff00"));
      const warning = t.renderer.root.findDescendantById("tfm-yesno-body-2") as any;
      expect(fgInts(warning)).toEqual(hexInts("#00ff00"));
      const focused = t.renderer.root.findDescendantById("tfm-yesno-b0-label") as any;
      expect(fgInts(focused)).toEqual(hexInts("#00ff00"));
      // the full-screen scrim stays transparent: a fill would delete every
      // raster under the dialog
      const scrim = t.renderer.root.findDescendantById("tfm-yesno") as any;
      expect(scrim.backgroundColor.toInts()[3]).toBe(0);
      yesNo.submit();
      expect(confirmed).toBe(true);
    } finally {
      await t.dispose(); // 0.6.0: destroy + await closed
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
      await t.dispose(); // 0.6.0: destroy + await closed
    }
  });

  test("teardowns restore default (hovered buttons have no out)", async () => {
    const t = await createTestRenderer({ width: 90, height: 24 });
    try {
      const floats = makeFloats();
      const { conflict, yesNo } = mkLive(t, floats, makeCtx().ctx.colors);
      pointers.length = 0;
      // conflict: policy dismissal routes through the raw teardown
      void conflict.promptConflict("/a/b.txt", 0);
      await t.renderOnce();
      floats.open("props", () => {});
      expect(conflict.isOpen()).toBe(false);
      expect(pointers).toEqual(["default"]);
      // yesno: submit closes through floats the same way
      pointers.length = 0;
      let confirmed = false;
      expect(
        ask(yesNo, "Empty Trash?", () => {
          confirmed = true;
        }),
      ).toEqual({ kind: "opened" });
      yesNo.submit(); // the cursor starts on Yes → the pending Yes fires
      expect(confirmed).toBe(true);
      expect(pointers).toEqual(["default"]);
    } finally {
      await t.dispose(); // 0.6.0: destroy + await closed
    }
  });
});

describe("no-drift rule", () => {
  test("the yes/no dialog is ONE explicit phase, not four parallel fields", async () => {
    // The old state was four independent fields (`open`, `lastDanger`,
    // `focusIdx`, `pendingYes`), so "a question is up but nothing is
    // pending" was representable — and confirm() answered a bare boolean,
    // which made "busy" look exactly like "declined". The four fields may
    // not come back.
    const src = (await Bun.file(`${import.meta.dir}/ui-dialogs.ts`).text())
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "");
    // (assert on the booleans, not the source: a failed match would dump
    // the whole module into the test output)
    expect(/lastDanger/.test(src)).toBe(false);
    expect(/pendingYes/.test(src)).toBe(false);
    expect(/focusIdx/.test(src)).toBe(false);
    // ... and the refusal has its own name
    expect(/kind:\s*"busy"/.test(src)).toBe(true);
  });
});
