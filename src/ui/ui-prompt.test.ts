import { describe, expect, test } from "bun:test";
import { Box } from "@opentui/core";
import { createTestRenderer, type TestRendererSetup } from "@opentui/core/testing";
import { makePrompt } from "./ui-prompt";
import { makeFloats } from "./floats";
import { defaultConfig } from "../config/config-schema";
import type { Theme } from "../config/config";

// Headless tests for the single-line prompt overlay (plugin git-URL entry).
// Pinned through the PUBLIC surface (open/handleKey/close/isOpen) plus
// painted frames — the Input node itself is the seam, not fake bookkeeping.

const colors = defaultConfig.theme as Theme;

const mkPrompt = (t: TestRendererSetup, floats: ReturnType<typeof makeFloats>) =>
  makePrompt({
    renderer: () => t.renderer,
    byId: (id: string) => t.renderer.root.findDescendantById(id),
    rootAdd: (n: unknown) => t.renderer.root.add(n as never),
    stripSelectable: () => {},
    escHintBtn: (id: string) => Box({ id, width: 3, height: 1 }),
    drainIconQueue: () => {},
    colors: () => colors,
    uiStyle: () => "solid",
    floats,
  });

describe("prompt widget", () => {
  test("open mounts scrim + input + buttons; esc resolves null", async () => {
    const t: TestRendererSetup = await createTestRenderer({ width: 90, height: 24 });
    try {
      const floats = makeFloats();
      const prompt = mkPrompt(t, floats);
      const pending = prompt.open({ title: "Add plugin", placeholder: "https://…", okLabel: "Clone" });
      await t.renderOnce();
      expect(t.renderer.root.findDescendantById("tfm-prompt")).toBeTruthy();
      expect(t.renderer.root.findDescendantById("tfm-prompt-input")).toBeTruthy();
      expect(t.renderer.root.findDescendantById("tfm-prompt-esc")).toBeTruthy();
      expect(floats.isOpen("prompt")).toBe(true);
      const frame = t.captureCharFrame();
      expect(frame).toContain("Add plugin");
      expect(frame).toContain("Clone");
      // the header closes via the X icon button, not a text "esc" hint
      expect(frame).not.toContain("esc");
      // breathing room: at least one blank row between input and buttons
      const lines = frame.split("\n");
      const inputLine = lines.findIndex((l) => l.includes("https://"));
      const btnLine = lines.findIndex((l) => l.includes("[ Cancel ]"));
      expect(inputLine).toBeGreaterThanOrEqual(0);
      expect(btnLine - inputLine).toBeGreaterThanOrEqual(2);
      prompt.handleKey({ name: "escape" });
      await expect(pending).resolves.toBeNull();
      expect(floats.isOpen("prompt")).toBe(false);
      expect(t.renderer.root.findDescendantById("tfm-prompt")).toBeFalsy();
    } finally {
      t.renderer.destroy();
    }
  });

  test("typed value + return resolves the value; empty return keeps it open", async () => {
    const t: TestRendererSetup = await createTestRenderer({ width: 90, height: 24 });
    try {
      const floats = makeFloats();
      const prompt = mkPrompt(t, floats);
      const pending = prompt.open({ title: "Add plugin", okLabel: "Clone" });
      await t.renderOnce();
      // empty submit must not settle (stays open for a real URL)
      prompt.handleKey({ name: "return" });
      expect(floats.isOpen("prompt")).toBe(true);
      prompt.setValue("https://github.com/u/repo");
      prompt.handleKey({ name: "return" });
      await expect(pending).resolves.toBe("https://github.com/u/repo");
      expect(floats.isOpen("prompt")).toBe(false);
    } finally {
      t.renderer.destroy();
    }
  });

  test("initial prefill paints and submits without typing (value prop, not initialValue)", async () => {
    // initialValue is silently dropped by @opentui/core's Input (it reads
    // options.value) — this test pins the working prop
    const t: TestRendererSetup = await createTestRenderer({ width: 90, height: 24 });
    try {
      const floats = makeFloats();
      const prompt = mkPrompt(t, floats);
      const pending = prompt.open({ title: "Add plugin", okLabel: "Clone", initial: "https://github.com/u/seed" });
      await t.renderOnce();
      expect(t.captureCharFrame()).toContain("https://github.com/u/seed");
      prompt.handleKey({ name: "return" });
      await expect(pending).resolves.toBe("https://github.com/u/seed");
    } finally {
      t.renderer.destroy();
    }
  });

  test("floats-initiated close resolves pending as null (no dangling promise)", async () => {
    const t: TestRendererSetup = await createTestRenderer({ width: 90, height: 24 });
    try {
      const floats = makeFloats();
      const prompt = mkPrompt(t, floats);
      const pending = prompt.open({ title: "Add plugin", okLabel: "Clone" });
      await t.renderOnce();
      floats.close("prompt");
      await expect(pending).resolves.toBeNull();
      expect(t.renderer.root.findDescendantById("tfm-prompt")).toBeFalsy();
    } finally {
      t.renderer.destroy();
    }
  });

  test("reopen replaces: first pending resolves null, second stays live", async () => {
    const t: TestRendererSetup = await createTestRenderer({ width: 90, height: 24 });
    try {
      const floats = makeFloats();
      const prompt = mkPrompt(t, floats);
      const first = prompt.open({ title: "First", okLabel: "Clone" });
      await t.renderOnce();
      const second = prompt.open({ title: "Second", okLabel: "Clone" });
      await t.renderOnce();
      await expect(first).resolves.toBeNull();
      expect(floats.isOpen("prompt")).toBe(true);
      expect(t.captureCharFrame()).toContain("Second");
      prompt.setValue("https://github.com/u/other");
      prompt.handleKey({ name: "return" });
      await expect(second).resolves.toBe("https://github.com/u/other");
    } finally {
      t.renderer.destroy();
    }
  });
});
