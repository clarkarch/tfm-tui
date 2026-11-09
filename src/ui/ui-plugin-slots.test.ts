import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Box, TextRenderable } from "@opentui/core";
import { createTestRenderer, type TestRendererSetup } from "@opentui/core/testing";
import { makePluginSlots } from "./ui-plugin-slots";

// Real renderer + real SlotRenderable: pins that a registered plugin's
// contribution actually paints into a host-defined region, and that dispose
// tears the mount down. (The registry itself is OpenTUI's; this guards tfm's
// host wiring and slot layout.)

let t: TestRendererSetup;

beforeAll(async () => {
  t = await createTestRenderer({ width: 60, height: 8 });
  // The host mounts into FIXED ids and OpenTUI's slot registry is keyed by
  // renderer AND by context — so the whole file shares ONE host context and
  // ONE pair of host boxes (a second "tfm-status" box would make
  // findDescendantById ambiguous).
  t.renderer.root.add(Box({ id: "tfm-status", width: "100%", height: 1, flexDirection: "row" }));
  t.renderer.root.add(Box({ id: "tfm-sidebar-root", width: "100%", flexDirection: "column" }));
  await t.renderOnce();
});
afterAll(() => t.dispose()); // 0.6.0: destroy + await closed

// Mutable so a test can move the selection WITHOUT a host refresh (a plain
// selection change does not run a renderAll — the host only hears about it on
// the next refresh).
let selection: string[] = [];

const context = {
  app: "tfm",
  version: "0.0.0",
  renderer: () => t.renderer,
  colors: () => ({ accent: "#7aa2f7" }) as never,
  cwd: () => "/x",
  selection: () => selection,
};

describe("plugin slots host", () => {
  test("a statusbar contribution paints; refresh + dispose are safe", async () => {
    const slots = makePluginSlots({ renderer: t.renderer, context });
    let renders = 0;
    const unreg = slots.register({
      id: "clock",
      slots: {
        statusbar: () => {
          renders++;
          return new TextRenderable(t.renderer, { content: "CLOCK" });
        },
      },
    });
    try {
      slots.mount((id) => t.renderer.root.findDescendantById(id));
      await t.renderOnce();
      expect(t.captureCharFrame()).toContain("CLOCK");
      // ONE render per data change: the mount hands the slot the very object
      // it pushes, so the contribution is not rebuilt a second time (native
      // node churn is this app's OOM pressure).
      expect(renders).toBe(1);

      slots.refresh();
      await t.renderOnce();
      expect(t.captureCharFrame()).toContain("CLOCK");
      // nothing a contribution reads changed → the cache skips the push → no
      // re-render
      expect(renders).toBe(1);
    } finally {
      unreg();
      slots.dispose();
    }
    await t.renderOnce();
    expect(t.captureCharFrame()).not.toContain("CLOCK");
  });

  test("sidebar-footer contributions mount under the places list", async () => {
    const slots = makePluginSlots({ renderer: t.renderer, context });
    slots.register({
      id: "foot",
      slots: { "sidebar-footer": () => new TextRenderable(t.renderer, { content: "FOOTERX" }) },
    });
    try {
      slots.mount((id) => t.renderer.root.findDescendantById(id));
      await t.renderOnce();
      expect(t.captureCharFrame()).toContain("FOOTERX");
    } finally {
      slots.dispose();
    }
  });
});

describe("host state", () => {
  test("a host without a live slot registry says it is disabled", () => {
    // A headless/fake renderer has no slot-registry store: the host degrades
    // to a no-op. It must SAY so — "disabled" is not the same state as "live
    // but not mounted", and a consumer cannot tell them apart by looking at
    // the methods (they are all no-ops either way).
    const slots = makePluginSlots({ renderer: {} as never, context });
    expect(slots.status).toBe("disabled");
    expect(slots.mounted).toBe(false);

    // the degraded host is SAFE: every operation is a no-op, never a throw
    const unreg = slots.register({
      id: "x",
      slots: { statusbar: () => new TextRenderable(t.renderer, { content: "NOPE" }) },
    });
    slots.mount((id) => t.renderer.root.findDescendantById(id));
    slots.refresh();
    unreg();
    slots.dispose();
    expect(slots.mounted).toBe(false);
  });

  test("a live host reports mounted only while its regions are mounted", () => {
    const slots = makePluginSlots({ renderer: t.renderer, context });
    expect(slots.status).toBe("live");
    expect(slots.mounted).toBe(false);
    slots.mount((id) => t.renderer.root.findDescendantById(id));
    expect(slots.mounted).toBe(true);
    slots.dispose();
    expect(slots.mounted).toBe(false);
  });
});

describe("hot-reload overlap (regression)", () => {
  test("a newly registered contribution is handed the CURRENT data", async () => {
    // The contribution renders the DATA it was handed: after a reload the new
    // generation must get the CURRENT cwd+selection, even when the host's
    // cache says "nothing changed" (a selection change does not run a
    // renderAll, so the host's last push can be stale). The new contribution
    // must not inherit the object the previous generation left behind.
    selection = ["/x/a"];
    const slots = makePluginSlots({ renderer: t.renderer, context });
    const unreg1 = slots.register({
      id: "reload-clock",
      slots: {
        statusbar: (_ctx, d) => new TextRenderable(t.renderer, { content: `GEN1:${d.selection.join(",")}` }),
      },
    });
    let unreg2: (() => void) | null = null;
    try {
      slots.mount((id) => t.renderer.root.findDescendantById(id));
      await t.renderOnce();
      expect(t.captureCharFrame()).toContain("GEN1:/x/a");

      // the loader loads the new generation FIRST, then tears the old one down
      selection = ["/x/b"]; // the selection moved; the host has not pushed yet
      unreg2 = slots.register({
        id: "reload-clock",
        slots: {
          statusbar: (_ctx, d) => new TextRenderable(t.renderer, { content: `GEN2:${d.selection.join(",")}` }),
        },
      });
      unreg1();
      await t.renderOnce();
      expect(t.captureCharFrame()).toContain("GEN2:/x/b");
    } finally {
      unreg2?.();
      slots.dispose();
      selection = [];
    }
  });

  test("registering a new generation before the old is disposed keeps the new slots", async () => {
    const slots = makePluginSlots({ renderer: t.renderer, context });
    // the loader loads the NEW generation first, then disposes the old — the
    // registry rejects duplicate ids, so the host must assign unique ones
    const unreg1 = slots.register({
      id: "overlap-clock",
      slots: { statusbar: () => new TextRenderable(t.renderer, { content: "GEN1" }) },
    });
    const unreg2 = slots.register({
      id: "overlap-clock",
      slots: { statusbar: () => new TextRenderable(t.renderer, { content: "GEN2" }) },
    });
    try {
      slots.mount((id) => t.renderer.root.findDescendantById(id));
      await t.renderOnce();
      expect(t.captureCharFrame()).toContain("GEN2");

      unreg1(); // old generation torn down
      slots.refresh();
      await t.renderOnce();
      expect(t.captureCharFrame()).toContain("GEN2"); // survives
    } finally {
      unreg2();
      slots.dispose();
    }
  });
});
