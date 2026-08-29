import { describe, expect, test } from "bun:test";
import { makeLookup, waitForResolution } from "./ui-lookup";

// fake renderable tree: nodes expose getChildren() like the real renderer
const leaf = (id: string, extra: any = {}): any => ({ id, children: [], getChildren() { return this.children; }, ...extra });
const branch = (id: string | undefined, ...children: any[]): any => ({
  id,
  children,
  getChildren() { return this.children; },
});

const find = (node: any, id: string): any => {
  if (node?.id === id) return node;
  for (const c of node?.children ?? []) {
    const hit = find(c, id);
    if (hit) return hit;
  }
  return null;
};

// fake root: like the real renderer.root it IS a renderable (getChildren)
// that also carries findDescendantById
const mkRoot = (tree: any): any => ({
  ...tree,
  findDescendantById: (id: string) => find(tree, id),
});

describe("makeLookup", () => {
  test("byId finds nested nodes post-mount", () => {
    const tree = branch(undefined, branch("tfm-panel", leaf("tfm-label")));
    const { byId } = makeLookup({ root: () => mkRoot(tree) });
    expect(byId("tfm-label").id).toBe("tfm-label");
  });

  test("byId tolerates a miss (nodes die on every rebuild)", () => {
    const tree = branch(undefined);
    const { byId } = makeLookup({ root: () => mkRoot(tree) });
    expect(byId("nope")).toBeNull();
  });

  test("byId survives a throwing root (pre-mount)", () => {
    const { byId } = makeLookup({
      root: () => { throw new Error("not mounted"); },
    });
    expect(byId("x")).toBeNull();
  });

  test("setTextOnId writes text content on the node", () => {
    const label = leaf("tfm-status-label", { content: "old" });
    const tree = branch(undefined, label);
    const { setTextOnId } = makeLookup({ root: () => mkRoot(tree) });
    setTextOnId("tfm-status-label", "hello");
    expect(label.content).toBe("hello");
  });

  test("setTextOnId no-ops on a missing node", () => {
    const tree = branch(undefined);
    const { setTextOnId } = makeLookup({ root: () => mkRoot(tree) });
    expect(() => setTextOnId("ghost", "x")).not.toThrow();
  });

  test("setOnId applies a mutation fn; missing node skips it", () => {
    const box = leaf("tfm-x", { visible: false });
    const tree = branch(undefined, box);
    const { setOnId } = makeLookup({ root: () => mkRoot(tree) });
    const seen: any[] = [];
    setOnId("tfm-x", (n: any) => { seen.push(n); n.visible = true; });
    setOnId("ghost", (n: any) => { seen.push(n); });
    expect(seen.length).toBe(1);
    expect(box.visible).toBe(true);
  });

  test("stripSelectable clears selectable on the whole subtree", () => {
    const a = leaf("a", { selectable: true });
    const b = leaf("b", { selectable: false });
    const tree = branch("root", a, b);
    const { stripSelectable } = makeLookup({ root: () => mkRoot(tree) });
    stripSelectable();
    expect(a.selectable).toBe(false);
    expect(b.selectable).toBe(false);
  });

  test("stripSelectable starts from an explicit node and skips destroyed", () => {
    const child = leaf("c", { selectable: true });
    const other = leaf("o", { selectable: true });
    const subtree = branch("sub", child);
    const tree = branch("root", subtree, other);
    const { stripSelectable } = makeLookup({ root: () => mkRoot(tree) });
    stripSelectable(subtree);
    expect(child.selectable).toBe(false);
    expect(other.selectable).toBe(true);
    const destroyed: any = { isDestroyed: true, selectable: true, children: [leaf("d", { selectable: true })] };
    expect(() => stripSelectable(destroyed)).not.toThrow();
    expect(destroyed.children[0].selectable).toBe(true);
  });
});

describe("waitForResolution", () => {
  test("returns immediately when resolution is already set", async () => {
    await waitForResolution({ resolution: { width: 80 } });
  });

  test("gives up after the poll budget when resolution never lands", async () => {
    let polls = 0;
    // 40 polls x 50ms real sleep is 2s — shrink by observing the loop bounds
    // indirectly: resolution never set -> resolves (not hangs) after ~2s
    const start = Date.now();
    await waitForResolution({ get resolution() { polls++; return null; } });
    expect(polls).toBe(40);
    expect(Date.now() - start).toBeGreaterThanOrEqual(1900);
  });
});
