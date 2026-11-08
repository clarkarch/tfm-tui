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

// mouse pointer shapes requested through the ctx seam (OSC 22 sink)
const pointers: string[] = [];

const mkPrompt = (t: TestRendererSetup, floats: ReturnType<typeof makeFloats>) =>
  makePrompt({
    byId: (id: string) => t.renderer.root.findDescendantById(id),
    rootAdd: (n: unknown) => t.renderer.root.add(n as never),
    stripSelectable: () => {},
    escHintBtn: (id: string) => Box({ id, width: 3, height: 1 }),
    drainIconQueue: () => {},
    colors: () => colors,
    uiStyle: () => "solid",
    floats,
    setPointer: (s) => void pointers.push(s),
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
      await t.dispose(); // 0.6.0: destroy + await closed
    }
  });

  test("open sets the text pointer, esc restores default", async () => {
    const t: TestRendererSetup = await createTestRenderer({ width: 90, height: 24 });
    try {
      pointers.length = 0;
      const floats = makeFloats();
      const prompt = mkPrompt(t, floats);
      const pending = prompt.open({ title: "Add plugin", okLabel: "Clone" });
      await t.renderOnce();
      expect(pointers).toEqual(["text"]);
      prompt.handleKey({ name: "escape" });
      await expect(pending).resolves.toBeNull();
      expect(pointers).toEqual(["text", "default"]);
    } finally {
      await t.dispose(); // 0.6.0: destroy + await closed
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
      await t.dispose(); // 0.6.0: destroy + await closed
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
      await t.dispose(); // 0.6.0: destroy + await closed
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
      await t.dispose(); // 0.6.0: destroy + await closed
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
      await t.dispose(); // 0.6.0: destroy + await closed
    }
  });

  test("password mode masks keystrokes and never mounts an Input", async () => {
    const t: TestRendererSetup = await createTestRenderer({ width: 90, height: 24 });
    try {
      const floats = makeFloats();
      const prompt = mkPrompt(t, floats);
      const pending = prompt.open({ title: "Password", okLabel: "OK", password: true });
      await t.renderOnce();
      // no Input node — the router feeds handleKey so the secret is never rendered
      expect(t.renderer.root.findDescendantById("tfm-prompt-input")).toBeFalsy();
      expect(t.renderer.root.findDescendantById("tfm-prompt-mask")).toBeTruthy();
      prompt.handleKey({ name: "p", sequence: "p" });
      prompt.handleKey({ name: "w", sequence: "w" });
      await t.renderOnce();
      const frame = t.captureCharFrame();
      expect(frame).not.toContain("pw");
      expect(frame).toContain("••");
      prompt.handleKey({ name: "return" });
      await expect(pending).resolves.toBe("pw");
    } finally {
      await t.dispose(); // 0.6.0: destroy + await closed
    }
  });

  test("a pasted password is accepted", async () => {
    // A bracketed PASTE arrives as a PASTE EVENT, not as key presses: in
    // password mode there is no Input to receive it, so the router hands the
    // whole text here. A pasted password MUST land (the sudo prompt's users
    // paste — typing a password char by char is the alternative).
    const t: TestRendererSetup = await createTestRenderer({ width: 90, height: 24 });
    try {
      const floats = makeFloats();
      const prompt = mkPrompt(t, floats);
      const pending = prompt.open({ title: "Password", okLabel: "OK", password: true });
      await t.renderOnce();
      prompt.handlePaste("s3cret");
      await t.renderOnce();
      const frame = t.captureCharFrame();
      expect(frame).not.toContain("s3cret");
      expect(frame).toContain("••••••");
      prompt.handleKey({ name: "return" });
      await expect(pending).resolves.toBe("s3cret");
    } finally {
      await t.dispose(); // 0.6.0: destroy + await closed
    }
  });

  test("the secret takes a whole sequence, not one char", async () => {
    // The old rule accepted a SINGLE char per key event — a multi-char
    // sequence (a paste delivered as keys, an emoji) was dropped whole.
    const t: TestRendererSetup = await createTestRenderer({ width: 90, height: 24 });
    try {
      const floats = makeFloats();
      const prompt = mkPrompt(t, floats);
      const pending = prompt.open({ title: "Password", okLabel: "OK", password: true });
      await t.renderOnce();
      prompt.handleKey({ name: "p", sequence: "🔑" });
      await t.renderOnce();
      expect(t.captureCharFrame()).toContain("•"); // the char landed
      prompt.handleKey({ name: "return" });
      await expect(pending).resolves.toBe("🔑");
    } finally {
      await t.dispose(); // 0.6.0: destroy + await closed
    }
  });

  test("a whitespace-only secret submits like a whitespace-only text value", async () => {
    // ONE trimming rule: a whitespace-only value is EMPTY in BOTH modes — the
    // text branch refuses it (the prompt stays open for a real value), so the
    // password branch must refuse it too.
    const t: TestRendererSetup = await createTestRenderer({ width: 90, height: 24 });
    try {
      const floats = makeFloats();
      const prompt = mkPrompt(t, floats);
      // the text branch
      const textPending = prompt.open({ title: "Add plugin", okLabel: "Clone" });
      await t.renderOnce();
      prompt.setValue("   ");
      prompt.handleKey({ name: "return" });
      expect(floats.isOpen("prompt")).toBe(true);
      prompt.handleKey({ name: "escape" });
      await expect(textPending).resolves.toBeNull();
      // the password branch
      const secretPending = prompt.open({ title: "Password", okLabel: "OK", password: true });
      await t.renderOnce();
      prompt.setValue("   ");
      prompt.handleKey({ name: "return" });
      expect(floats.isOpen("prompt")).toBe(true);
      prompt.handleKey({ name: "escape" });
      await expect(secretPending).resolves.toBeNull();
    } finally {
      await t.dispose(); // 0.6.0: destroy + await closed
    }
  });
});

describe("no-drift rule", () => {
  test("the prompt mode is ONE tag (no parallel boolean or secret field)", async () => {
    // The old state spread the widget SHAPE over a `passwordMode` boolean
    // and the VALUE over a separate `secret` string — so "the shape is a
    // masked Text but the value comes from the Input" was representable.
    // The mode tag carries both now; the old fields may not come back.
    const src = (await Bun.file(`${import.meta.dir}/ui-prompt.ts`).text())
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "");
    // (assert on the booleans, not the source: a failed match would dump
    // the whole module into the test output)
    expect(/passwordMode/.test(src)).toBe(false);
    expect(/let secret\b/.test(src)).toBe(false);
    // ... and the replacement is there
    expect(/kind:\s*"password";\s*secret:\s*string/.test(src)).toBe(true);
  });
});
