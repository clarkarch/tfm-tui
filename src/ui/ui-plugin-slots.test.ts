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
});
afterAll(() => {
  t.renderer.destroy();
});

const context = {
  app: "tfm",
  version: "0.0.0",
  renderer: () => t.renderer,
  colors: () => ({ accent: "#7aa2f7" }) as never,
  cwd: () => "/x",
  selection: () => [] as string[],
};

describe("plugin slots host", () => {
  test("a statusbar contribution paints; refresh + dispose are safe", async () => {
    const status = Box({ id: "tfm-status", width: "100%", height: 1, flexDirection: "row" });
    t.renderer.root.add(status);
    await t.renderOnce();
    const slots = makePluginSlots({ renderer: t.renderer, context });
    const unreg = slots.register({
      id: "clock",
      slots: { statusbar: () => new TextRenderable(t.renderer, { content: "CLOCK" }) },
    });
    slots.mount((id) => t.renderer.root.findDescendantById(id));
    await t.renderOnce();
    expect(t.captureCharFrame()).toContain("CLOCK");

    slots.refresh();
    await t.renderOnce();
    expect(t.captureCharFrame()).toContain("CLOCK");

    unreg();
    slots.dispose();
    await t.renderOnce();
    expect(t.captureCharFrame()).not.toContain("CLOCK");
  });

  test("sidebar-footer contributions mount under the places list", async () => {
    const sidebar = Box({ id: "tfm-sidebar-root", width: "100%", flexDirection: "column" });
    t.renderer.root.add(sidebar);
    await t.renderOnce();
    const slots = makePluginSlots({ renderer: t.renderer, context });
    slots.register({
      id: "foot",
      slots: { "sidebar-footer": () => new TextRenderable(t.renderer, { content: "FOOTERX" }) },
    });
    slots.mount((id) => t.renderer.root.findDescendantById(id));
    await t.renderOnce();
    expect(t.captureCharFrame()).toContain("FOOTERX");
    slots.dispose();
  });
});

describe("hot-reload overlap (regression)", () => {
  test("registering a new generation before the old is disposed keeps the new slots", async () => {
    const status = Box({ id: "tfm-status-ovl", width: "100%", height: 1, flexDirection: "row" });
    t.renderer.root.add(status);
    await t.renderOnce();
    const slots = makePluginSlots({ renderer: t.renderer, context });
    // the loader loads the NEW generation first, then disposes the old — the
    // registry rejects duplicate ids, so the host must assign unique ones
    const unreg1 = slots.register({
      id: "clock",
      slots: { statusbar: () => new TextRenderable(t.renderer, { content: "GEN1" }) },
    });
    const unreg2 = slots.register({
      id: "clock",
      slots: { statusbar: () => new TextRenderable(t.renderer, { content: "GEN2" }) },
    });
    slots.mount((id) => t.renderer.root.findDescendantById(id));
    await t.renderOnce();
    expect(t.captureCharFrame()).toContain("GEN2");

    unreg1(); // old generation torn down
    slots.refresh();
    await t.renderOnce();
    expect(t.captureCharFrame()).toContain("GEN2"); // survives
    unreg2();
    slots.dispose();
  });
});
