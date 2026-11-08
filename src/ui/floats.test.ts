import { describe, expect, test } from "bun:test";
import { FLOAT_Z, makeFloats } from "./floats";
import type { FloatKind } from "../lib/float-kind";

const makeTracked = () => {
  const closed: string[] = [];
  const closer = (name: string) => () => closed.push(name);
  return { closed, closer };
};

describe("floats policy", () => {
  test("opening a modal clears the whole desktop (popup + other modals)", () => {
    const f = makeFloats();
    const { closed, closer } = makeTracked();
    f.open("props", closer("props"));
    f.open("filemenu", closer("perm-menu"), { keepModalBelow: true }); // popup inside props
    expect(f.depth()).toBe(2);
    f.open("conflict", closer("conflict"));
    // both dismissed top-down, conflict is the only layer left
    expect(f.top()).toBe("conflict");
    expect(f.depth()).toBe(1);
    expect(closed).toEqual(["perm-menu", "props"]);
    expect(f.isOpen("props")).toBe(false);
    expect(f.isOpen("filemenu")).toBe(false);
  });

  test("a DESKTOP popup clears the whole desktop — one floating UI at a time", () => {
    const f = makeFloats();
    const { closed, closer } = makeTracked();
    f.open("escmenu", closer("escmenu"));
    f.open("filemenu", closer("menu"));
    // the right-click context menu REPLACES the modal below it. A right-click
    // that lands in the same frame as the modal opens slips past the modal's
    // scrim (the scrim has no layout yet), and keeping the modal would leave
    // BOTH on screen — the esc menu with the context menu drawn over it.
    expect(closed).toEqual(["escmenu"]);
    expect(f.isOpen("escmenu")).toBe(false);
    expect(f.isOpen("filemenu")).toBe(true);
    expect(f.depth()).toBe(1);
    expect(f.top()).toBe("filemenu");
  });

  test("a NESTED popup keeps the modal below it and replaces an existing popup", () => {
    const f = makeFloats();
    const { closed, closer } = makeTracked();
    f.open("props", closer("props1"));
    // the properties dialog's permission menu is a popup INSIDE the dialog
    f.open("filemenu", closer("menu1"), { keepModalBelow: true });
    f.open("filemenu", closer("menu2"), { keepModalBelow: true }); // re-click: old popup replaced
    expect(closed).toEqual(["menu1"]);
    expect(f.depth()).toBe(2);
    expect(f.top()).toBe("filemenu");
    expect(f.isOpen("props")).toBe(true);
    f.close("filemenu");
    expect(f.isOpen("props")).toBe(true);
    expect(f.top()).toBe("props");
  });

  test("closing a layer takes everything opened above it with it", () => {
    const f = makeFloats();
    const { closed, closer } = makeTracked();
    f.open("props", closer("props"));
    f.open("filemenu", closer("perm-menu"), { keepModalBelow: true });
    f.close("props");
    // the permission popup must not outlive its dialog (the stuck-menu leak)
    expect(closed).toEqual(["perm-menu", "props"]);
    expect(f.depth()).toBe(0);
  });

  test("closing the popup leaves the modal; closing an unopened kind is a no-op", () => {
    const f = makeFloats();
    const { closed, closer } = makeTracked();
    f.open("props", closer("props"));
    f.open("filemenu", closer("perm-menu"), { keepModalBelow: true });
    f.close("yesno"); // never open
    f.close("escmenu"); // never open
    expect(closed).toEqual([]);
    f.close("filemenu");
    expect(closed).toEqual(["perm-menu"]);
    expect(f.isOpen("props")).toBe(true);
  });

  test("same-kind reopen replaces (props → props) with the old closer run", () => {
    const f = makeFloats();
    const { closed, closer } = makeTracked();
    f.open("props", closer("props1"));
    f.open("props", closer("props2"));
    expect(closed).toEqual(["props1"]);
    expect(f.depth()).toBe(1);
    f.close("props");
    expect(closed).toEqual(["props1", "props2"]);
  });

  test("closeAll closes top-down; empty closeAll is a no-op", () => {
    const f = makeFloats();
    f.closeAll();
    const { closed, closer } = makeTracked();
    f.open("yesno", closer("yesno"));
    f.open("filemenu", closer("menu"), { keepModalBelow: true });
    f.closeAll();
    expect(closed).toEqual(["menu", "yesno"]);
    expect(f.depth()).toBe(0);
    expect(f.top()).toBeNull();
  });

  test("FLOAT_Z documents the render order (popup above every modal)", () => {
    // prompt sits above pick: it opens over the palette without stacking
    // scrims (added with the plugin git-URL installer)
    const kinds: FloatKind[] = ["escmenu", "props", "conflict", "yesno", "filemenu", "pick", "prompt", "bulkrename"];
    expect(kinds.every((k, i) => kinds.slice(i + 1).every((j) => FLOAT_Z[k]! < FLOAT_Z[j]!))).toBe(true);
  });

  test("onModalChange fires on modal 0<->1 transposes only (not popup churn)", () => {
    const states: boolean[] = [];
    const f = makeFloats({ onModalChange: (open) => states.push(open) });
    const noop = () => {};
    f.open("filemenu", noop); // popup is not a modal — silent
    expect(states).toEqual([]);
    f.open("props", noop); // modal up
    expect(states).toEqual([true]);
    f.open("filemenu", noop, { keepModalBelow: true }); // popup INSIDE the modal — still modal, silent
    expect(states).toEqual([true]);
    f.close("filemenu");
    expect(states).toEqual([true]);
    f.close("props"); // last modal down
    expect(states).toEqual([true, false]);
  });

  test("hasModal() is false for a bare popup, true for any modal", () => {
    const f = makeFloats();
    expect(f.hasModal()).toBe(false);
    f.open("filemenu", () => {});
    expect(f.hasModal()).toBe(false);
    f.open("conflict", () => {});
    expect(f.hasModal()).toBe(true);
  });

  test("a modal replacing another keeps the dim — the modal state never changed", () => {
    // A confirm/prompt over the Plugins-view esc-menu REPLACES the modal
    // below it in ONE synchronous operation: the modal state goes true -> true,
    // so the dim must NOT churn. The old stack-emptied dip fired off-then-on,
    // which un-dimmed and re-dimmed the background and re-queued EVERY icon
    // raster for a re-raster — twice per replacement — for a state the user
    // never saw. (The dip's original reason — a closer that dimmed the
    // background itself — is gone: the closers no longer touch the scrim,
    // `applyModalDim` is the dim's only owner.)
    const states: boolean[] = [];
    const f = makeFloats({ onModalChange: (open) => states.push(open) });
    const noop = () => {};
    f.open("escmenu", noop);
    f.open("yesno", noop);
    expect(states).toEqual([true]);
    expect(f.hasModal()).toBe(true);
  });

  test("the modal change callback fires exactly once per transition", () => {
    const states: boolean[] = [];
    const f = makeFloats({ onModalChange: (open) => states.push(open) });
    const noop = () => {};
    f.open("filemenu", noop); // a popup is not a modal: silent
    expect(states).toEqual([]);
    f.open("props", noop); // modal up: ONE transition
    expect(states).toEqual([true]);
    f.open("filemenu", noop, { keepModalBelow: true }); // popup INSIDE the modal: silent
    expect(states).toEqual([true]);
    f.close("filemenu"); // the modal is still up: silent
    expect(states).toEqual([true]);
    f.open("yesno", noop); // a modal REPLACES a modal: the state never changed
    expect(states).toEqual([true]);
    f.close("yesno"); // modal down: ONE transition
    expect(states).toEqual([true, false]);
  });
});

describe("no-drift rule", () => {
  test("the modal state is DERIVED from the stack — no mirrored cache", async () => {
    // `modalLast` duplicated the stack's modal state in a variable that only
    // the discipline of four call sites kept fresh. The state is now derived
    // from the stack at the moment of the change, so no mirror can go stale.
    const src = (await Bun.file(`${import.meta.dir}/floats.ts`).text())
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "");
    // (assert on the booleans, not the source: a failed match would dump
    // the whole module into the test output)
    expect(/modalLast/.test(src)).toBe(false); // no mirrored modal flag
    expect(/hasModal\(\)/.test(src)).toBe(true); // the stack is the source of truth
  });
});
