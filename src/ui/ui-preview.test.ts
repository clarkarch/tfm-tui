import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Box, type CliRenderer, CodeRenderable, TextRenderable } from "@opentui/core";
import { createTestRenderer, type TestRendererSetup } from "@opentui/core/testing";
import type { MaybeNode } from "../lib/node-like";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { defaultConfig, type Theme } from "../config/config";
import { makePreview } from "./ui-preview";
import type { Scheduler } from "../lib/uiutil";

// Manual clock: debounced clears its pending handle, so a coalescing test can
// assert "N calls, one render" by flushing only what is still queued.
const mkClock = (): { sched: Scheduler; flush: () => void } => {
  let seq = 0;
  const timers = new Map<number, () => void>();
  return {
    sched: {
      setTimeout: (cb) => {
        const id = ++seq;
        timers.set(id, cb);
        return id;
      },
      clearTimeout: (h) => {
        timers.delete(h as number);
      },
    },
    flush: () => {
      const cbs = [...timers.values()];
      timers.clear();
      for (const cb of cbs) cb();
    },
  };
};

const mkPane = () => {
  const kids: any[] = [];
  return {
    node: {
      getChildren: () => kids,
      remove: (c: any) => {
        const i = kids.indexOf(c);
        if (i >= 0) kids.splice(i, 1);
      },
      add: (c: any) => {
        kids.push(c);
      },
    },
    childCount: () => kids.length,
  };
};

const COLORS: any = { sidebarFg: "#aaa", sidebarFgMuted: "#666", divider: "#333", white: "#fff", sidebarBg: "#000" };

const mkPreview = (opts: { visible: boolean; clock: ReturnType<typeof mkClock>; pane: ReturnType<typeof mkPane> }) =>
  makePreview({
    renderer: null as unknown as CliRenderer,
    byId: () => opts.pane.node as unknown as MaybeNode,
    colors: () => COLORS,
    uiStyle: () => "solid",
    previewEnabled: () => true,
    previewWidth: () => 40,
    visible: () => opts.visible,
    sched: opts.clock.sched,
    termH: () => 24,
    cellMetrics: () => ({ cellW: 10, cellH: 20, aspect: 0.5 }),
    focusKey: () => null,
    tileRefs: new Map(),
    pushThumbJob: () => {},
    drainThumbs: () => {},
    drainIconQueue: () => {},
    nextIconId: () => "slot",
    fallbackGlyphFor: () => "?",
  });

describe("preview visibility guard", () => {
  test("rebuilds nothing while the pane is hidden/collapsed", () => {
    const clock = mkClock();
    const pane = mkPane();
    const p = mkPreview({ visible: false, clock, pane });
    p.renderPreview();
    clock.flush();
    expect(pane.childCount()).toBe(0);
  });

  test("renders the no-selection state when visible", () => {
    const clock = mkClock();
    const pane = mkPane();
    const p = mkPreview({ visible: true, clock, pane });
    p.renderPreview();
    clock.flush();
    expect(pane.childCount()).toBeGreaterThan(0);
  });

  test("coalesces a burst into a single rebuild", () => {
    const clock = mkClock();
    const pane = mkPane();
    const p = mkPreview({ visible: true, clock, pane });
    for (let i = 0; i < 5; i++) p.renderPreview();
    clock.flush();
    const once = pane.childCount();
    // the trailing call is the only one that ran; without debounce the 5th
    // would still be queued and flush would render twice
    expect(once).toBeGreaterThan(0);
    expect(once).toBe(2); // the "no selection" Box + Text pair, exactly once
  });
});

// --- theme awareness (renderer-coupled, createTestRenderer pilot): the code
// node must NOT survive a theme flip, and files without a tree-sitter
// filetype must paint with the theme fg, not the terminal default. ---

let t: TestRendererSetup;
let tmpDir: string;

beforeAll(async () => {
  t = await createTestRenderer({ width: 100, height: 30 });
  tmpDir = mkdtempSync(path.join(os.tmpdir(), "tfm-preview-"));
});

afterAll(() => t.renderer.destroy());

const settleUntil = async (t: TestRendererSetup, cond: () => boolean): Promise<boolean> => {
  // renderOnce per poll: Text()/Box() children are lazy VNode proxies until a
  // frame is presented, so instanceof checks only pass post-render.
  const deadline = Date.now() + 3000;
  while (!cond() && Date.now() < deadline) {
    await t.renderOnce();
    await Bun.sleep(10);
  }
  return cond();
};

let paneSeq = 0;
const mkLivePreview = (file: string) => {
  const live: Theme = { ...defaultConfig.theme };
  const clock = mkClock();
  const id = `tfm-preview-${paneSeq++}`;
  const pane = Box({ id, width: 40, height: 20 });
  t.renderer.root.add(pane);
  const p = makePreview({
    renderer: t.renderer,
    byId: () => t.renderer.root.findDescendantById(id),
    colors: () => live,
    uiStyle: () => "solid",
    previewEnabled: () => true,
    previewWidth: () => 40,
    termH: () => 24,
    cellMetrics: () => ({ cellW: 10, cellH: 20, aspect: 0.5 }),
    focusKey: () => file,
    tileRefs: new Map(),
    pushThumbJob: () => {},
    drainThumbs: () => {},
    drainIconQueue: () => {},
    nextIconId: () => "slot",
    fallbackGlyphFor: () => "?",
    sched: clock.sched,
  });
  const realPane = () => t.renderer.root.findDescendantById(id) as any;
  const codeNodes = () =>
    realPane()
      .getChildren()
      .filter((c: any) => c instanceof CodeRenderable);
  return { live, clock, p, codeNodes, realPane };
};

describe("preview theme awareness", () => {
  test("a theme flip evicts the cached code node (old colors must not survive)", async () => {
    const file = path.join(tmpDir, "a.js");
    writeFileSync(file, "const x = 1;\n");
    const { live, clock, p, codeNodes } = mkLivePreview(file);
    p.renderPreview();
    clock.flush();
    expect(await settleUntil(t, () => codeNodes().length === 1)).toBe(true);
    const oldNode = codeNodes()[0] as any;
    const oldStyle = oldNode.syntaxStyle;
    // mutate the SAME live object (applyConfig Object.assigns onto it)
    Object.assign(live, { accent: "#00ff00", syntaxString: "#ff00ff", sidebarFg: "#abcdef" });
    p.renderPreview();
    clock.flush();
    expect(await settleUntil(t, () => codeNodes().length === 1 && (codeNodes()[0] as any) !== oldNode)).toBe(true);
    expect((codeNodes()[0] as any).syntaxStyle).not.toBe(oldStyle);
    // the evicted node is destroyed (not just detached), so its native
    // buffers release and any in-flight highlight bails on isDestroyed
    expect(oldNode.isDestroyed).toBe(true);
  });

  test("a file with a tree-sitter filetype paints unstyled text via baseHighlight default", async () => {
    const file = path.join(tmpDir, "b.js");
    writeFileSync(file, "let y = 2;\n");
    const { clock, p, codeNodes } = mkLivePreview(file);
    p.renderPreview();
    clock.flush();
    expect(await settleUntil(t, () => codeNodes().length === 1)).toBe(true);
    expect((codeNodes()[0] as any).baseHighlight).toBe("default");
  });

  test("a no-filetype text file renders as theme-colored Text, not an unstyled Code node", async () => {
    const file = path.join(tmpDir, "c.txt");
    writeFileSync(file, "hello preview\n");
    const { live, clock, p, codeNodes, realPane } = mkLivePreview(file);
    Object.assign(live, { sidebarFg: "#aabbcc" });
    p.renderPreview();
    clock.flush();
    // settle ON the body node itself: the header Textes paint synchronously,
    // the file content only after the async readFile resolves.
    const textOf = (c: any) => (c.content?.chunks ?? c.chunks ?? []).map((ch: any) => ch.text).join("");
    const findBody = () =>
      realPane()
        .getChildren()
        .find((c: any) => c instanceof TextRenderable && textOf(c).includes("hello preview"));
    expect(await settleUntil(t, () => !!findBody())).toBe(true);
    expect(codeNodes().length).toBe(0);
    const body = findBody() as any;
    const hexInts = (h: string): [number, number, number, number] => [
      Number.parseInt(h.slice(1, 3), 16),
      Number.parseInt(h.slice(3, 5), 16),
      Number.parseInt(h.slice(5, 7), 16),
      255,
    ];
    expect([...body.fg.toInts()]).toEqual(hexInts(live.white)); // panel text role (white)

    // re-preview of the same unchanged file must REUSE the cached node
    // (no fresh native TextBuffer per selection) ...
    p.renderPreview();
    clock.flush();
    expect(await settleUntil(t, () => findBody() === body)).toBe(true);
    // ... and a theme flip must evict it too (sig carries white + sidebarFg)
    Object.assign(live, { white: "#112233" });
    p.renderPreview();
    clock.flush();
    expect(await settleUntil(t, () => !!findBody() && findBody() !== body)).toBe(true);
    expect([...(findBody() as any).fg.toInts()]).toEqual([0x11, 0x22, 0x33, 0xff]);
    expect(body.isDestroyed).toBe(true);
  });
});

// chmod-based permission tests never fail as uid 0 (root bypasses
// file perms), so the whole block is skipped there with a reason
const describeNonRoot = process.getuid?.() === 0 ? describe.skip : describe;
describeNonRoot("sudo preview", () => {
  test("unreadable file renders via sudoCat without prompting", async () => {
    const { chmodSync } = await import("node:fs");
    const file = path.join(tmpDir, "root-only.txt");
    writeFileSync(file, "secret-bytes");
    chmodSync(file, 0o000);
    try {
      const clock = mkClock();
      const id = `tfm-preview-${paneSeq++}`;
      const pane = Box({ id, width: 40, height: 20 });
      t.renderer.root.add(pane);
      const seen: string[] = [];
      const p = makePreview({
        renderer: t.renderer,
        byId: () => t.renderer.root.findDescendantById(id),
        colors: () => ({ ...defaultConfig.theme }) as Theme,
        uiStyle: () => "solid",
        previewEnabled: () => true,
        previewWidth: () => 40,
        termH: () => 24,
        cellMetrics: () => ({ cellW: 10, cellH: 20, aspect: 0.5 }),
        focusKey: () => file,
        tileRefs: new Map(),
        pushThumbJob: () => {},
        drainThumbs: () => {},
        drainIconQueue: () => {},
        nextIconId: () => "slot",
        fallbackGlyphFor: () => "?",
        sched: clock.sched,
        sudoCat: async (f) => {
          seen.push(f);
          return "secret-bytes";
        },
      });
      p.renderPreview();
      clock.flush();
      const textOf = (c: any) => (c.content?.chunks ?? c.chunks ?? []).map((ch: any) => ch.text).join("");
      const ok = await settleUntil(
        t,
        () =>
          (t.renderer.root.findDescendantById(id) as any)
            .getChildren()
            .filter((c: any) => c instanceof TextRenderable && textOf(c).includes("secret-bytes")).length > 0,
      );
      expect(seen).toEqual([file]);
      expect(ok).toBe(true);
    } finally {
      chmodSync(file, 0o644);
    }
  });
});
