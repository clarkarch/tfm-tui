import { describe, expect, test } from "bun:test";
import { FLOAT_Z, makeFloats, type FloatKind } from "./floats";

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
    f.open("filemenu", closer("perm-menu")); // popup inside props
    expect(f.depth()).toBe(2);
    f.open("conflict", closer("conflict"));
    // both dismissed top-down, conflict is the only layer left
    expect(f.top()).toBe("conflict");
    expect(f.depth()).toBe(1);
    expect(closed).toEqual(["perm-menu", "props"]);
    expect(f.isOpen("props")).toBe(false);
    expect(f.isOpen("filemenu")).toBe(false);
  });

  test("opening the popup keeps the modal below and replaces an existing popup", () => {
    const f = makeFloats();
    const { closed, closer } = makeTracked();
    f.open("props", closer("props1"));
    f.open("filemenu", closer("menu1"));
    f.open("filemenu", closer("menu2")); // re-right-click: old popup replaced
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
    f.open("filemenu", closer("perm-menu"));
    f.close("props");
    // the permission popup must not outlive its dialog (the stuck-menu leak)
    expect(closed).toEqual(["perm-menu", "props"]);
    expect(f.depth()).toBe(0);
  });

  test("closing the popup leaves the modal; closing an unopened kind is a no-op", () => {
    const f = makeFloats();
    const { closed, closer } = makeTracked();
    f.open("props", closer("props"));
    f.open("filemenu", closer("perm-menu"));
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
    f.open("filemenu", closer("menu"));
    f.closeAll();
    expect(closed).toEqual(["menu", "yesno"]);
    expect(f.depth()).toBe(0);
    expect(f.top()).toBeNull();
  });

  test("FLOAT_Z documents the render order (popup above every modal)", () => {
    const kinds: FloatKind[] = ["escmenu", "props", "conflict", "yesno", "filemenu"];
    expect(kinds.every((k, i) => kinds.slice(i + 1).every((j) => FLOAT_Z[k]! < FLOAT_Z[j]!))).toBe(true);
  });
});
