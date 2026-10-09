// --- Wiring-level test for grid-foundation: the decisions this composition
// adds ON TOP of its collaborators (each of which has its own unit tests).
// Both live at the CALL SITE, so no widget test can cover them:
//   1. the bulk-rename guard (virtual views span directories, so one typed stem
//      is ambiguous; the trash view restores instead of renaming)
//   2. the active-pane facades — `selection.tileRefs` is a live VIEW over
//      whichever pane is active, because ui-rename/ui-preview/the menu capture
//      that map ONCE at construction and a per-pane map would desync them
// No renderer is needed: both decisions land before any node is built. ---
import { describe, expect, test } from "bun:test";
import { wireGridFoundation } from "./grid-foundation";

type HarnessOver = { virtual?: boolean; trash?: boolean; active?: 0 | 1 };

const harness = (over: HarnessOver = {}) => {
  const calls: string[] = [];
  const core = {
    themeGet: () => ({ accent: "#000000" }),
    config: { ui: { uiStyle: "solid" } },
    lookup: { byId: () => null, setTextOnId: () => {}, stripSelectable: () => {} },
    slots: { setIconState: () => {}, escHintBtn: () => ({}), drainIconQueue: () => {} },
    isCutKey: () => false,
    scrollerRefs: [{ current: null }, { current: null }],
    geometry: { tileH: 3, tileW: 8 },
    panes: { active: over.active ?? 0 },
    isVirtualCwd: () => !!over.virtual,
    inTrashView: () => !!over.trash,
    state: { cwd: "/tmp" },
    floats: { open: (kind: string) => calls.push(`float:${kind}`) },
  };
  const found = wireGridFoundation({
    core: core as never,
    nav: { renderAll: () => {} } as never,
    chrome: {
      renderer: { root: { findDescendantById: () => null } },
      notify: (msg: string, title?: string, level?: string) => calls.push(`notify:${title}:${level}:${msg}`),
    } as never,
    getGrid: () => ({ renderPreview: () => {}, renderGrid: () => {} }) as never,
    getFileops: () =>
      ({
        fileops: { performRename: () => {}, performBulkRename: () => {} },
        undo: { pushUndoBatch: () => {} },
      }) as never,
  });
  return { found, calls, core };
};

describe("grid-foundation wiring: bulk-rename guard", () => {
  test("a virtual cwd is refused with a warn toast and NO modal", () => {
    const h = harness({ virtual: true });
    h.found.startBulkRename(["/a/one", "/b/two"]);
    expect(h.calls).toContain("notify:rename:error:Can't rename here");
    // the widget must never be reached — no float was opened
    expect(h.calls.some((c) => c.startsWith("float:"))).toBe(false);
  });

  test("the trash view is refused too (restore, not rename)", () => {
    const h = harness({ trash: true });
    h.found.startBulkRename(["/a/one"]);
    expect(h.calls).toContain("notify:rename:error:Can't rename here");
    expect(h.calls.some((c) => c.startsWith("float:"))).toBe(false);
  });
});

describe("grid-foundation wiring: active-pane facades", () => {
  test("selection.tileRefs is a live view over the ACTIVE pane's map", () => {
    const h = harness({ active: 0 });
    h.found.selections[0].tileRefs.set("pane0-key", {} as never);
    h.found.selections[1].tileRefs.set("pane1-key", {} as never);

    expect(h.found.selection.tileRefs.has("pane0-key")).toBe(true);
    // flipping the pane re-points the SAME facade object (captured once by
    // ui-rename/preview) at the other pane's map
    h.core.panes.active = 1;
    expect(h.found.selection.tileRefs.has("pane0-key")).toBe(false);
    expect(h.found.selection.tileRefs.has("pane1-key")).toBe(true);
  });
});
