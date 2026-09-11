import { describe, expect, test } from "bun:test";
import path from "node:path";
import { bulkRenameNames, planBulkRename } from "./bulk-rename";

// Pure planner + name generator for the bulk-rename modal: one typed stem,
// per-file extensions preserved, numbered in selection order. `exists` is
// injectable so tests stay fs-free.

const items = (names: string[], dir = "/d") => names.map((n) => ({ path: path.join(dir, n) }));
const none = () => false;

describe("bulkRenameNames", () => {
  test("plain: stem + N, each file keeps its own extension", () => {
    expect(bulkRenameNames(items(["a.jpg", "b.png", "notes"]), "vacation", "plain")).toEqual([
      "vacation 1.jpg",
      "vacation 2.png",
      "vacation 3",
    ]);
  });

  test("pad: at least two digits, wider when the count needs it", () => {
    const twelve = items(Array.from({ length: 12 }, (_, i) => `f${i}.txt`));
    const names = bulkRenameNames(twelve, "pic", "pad");
    expect(names[0]).toBe("pic 01.txt");
    expect(names[11]).toBe("pic 12.txt");
    // below ten the "01" style must still be visible — min width is 2
    expect(bulkRenameNames(items(["a.jpg", "b.jpg"]), "pic", "pad")).toEqual(["pic 01.jpg", "pic 02.jpg"]);
    // 100+ items widen past two digits
    const hundred = items(Array.from({ length: 100 }, (_, i) => `f${i}`));
    expect(bulkRenameNames(hundred, "pic", "pad")[99]).toBe("pic 100");
  });

  test("paren: parenthesized token", () => {
    expect(bulkRenameNames(items(["a.jpg", "b.jpg"]), "pic", "paren")).toEqual(["pic (1).jpg", "pic (2).jpg"]);
  });

  test("dotfiles and extensionless names stay extensionless", () => {
    expect(bulkRenameNames(items([".bashrc", "README"]), "file", "plain")).toEqual(["file 1", "file 2"]);
  });
});

describe("planBulkRename", () => {
  test("pairs changed names, skips unchanged", () => {
    const plan = planBulkRename(items(["vacation 1.jpg", "b.jpg"]), "vacation", "plain", none);
    expect(plan).toEqual({ ok: true, pairs: [{ from: "/d/b.jpg", to: "/d/vacation 2.jpg" }] });
  });

  test("all unchanged is ok with no pairs", () => {
    expect(planBulkRename(items(["vacation 1.jpg", "vacation 2.jpg"]), "vacation", "plain", none)).toEqual({
      ok: true,
      pairs: [],
    });
  });

  test("empty or path-y stems are rejected", () => {
    for (const bad of ["", "   ", ".", "..", "sub/name", "a\u0000b"]) {
      expect(planBulkRename(items(["a.txt"]), bad, "plain", none).ok).toBe(false);
    }
  });

  test("an existing target is rejected through the injected exists", () => {
    const exists = (p: string) => p === "/d/vacation 1.jpg";
    const plan = planBulkRename(items(["a.jpg"]), "vacation", "plain", exists);
    expect(plan.ok).toBe(false);
    if (!plan.ok) expect(plan.error).toContain("vacation 1.jpg");
  });

  test("a generated name owned by another selected item (swap/chain) is rejected", () => {
    const plan = planBulkRename(items(["vacation 2.jpg", "vacation 1.jpg"]), "vacation", "plain", none);
    expect(plan.ok).toBe(false);
    if (!plan.ok) expect(plan.error).toContain("another selected");
  });

  test("each pair lands in the item's own directory", () => {
    const plan = planBulkRename([{ path: "/one/a" }, { path: "/two/b" }], "x", "plain", none);
    expect(plan).toEqual({
      ok: true,
      pairs: [
        { from: "/one/a", to: "/one/x 1" },
        { from: "/two/b", to: "/two/x 2" },
      ],
    });
  });
});
