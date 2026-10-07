import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Box, type CliRenderer, CodeRenderable, LineNumberRenderable, MarkdownRenderable } from "@opentui/core";
import { createTestRenderer, type TestRendererSetup } from "@opentui/core/testing";
import type { MaybeNode } from "../lib/node-like";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { defaultConfig, type Theme } from "../config/config";
import type { WrapMode } from "../config/config-schema";
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
// recursive descendant walk: bodies nest inside gutter (and clip) wrappers,
// so direct-children filters would miss them after a structural change
const walkKids = (node: any): any[] => {
  const out: any[] = [];
  for (const k of node.getChildren?.() ?? []) {
    out.push(k);
    out.push(...walkKids(k));
  }
  return out;
};
const mkLivePreview = (file: string, wrap: WrapMode = "none") => {
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
    wrapMode: () => wrap,
  });
  const realPane = () => t.renderer.root.findDescendantById(id) as any;
  // bodies nest inside gutter/clip wrappers — walk the whole subtree
  const codeNodes = () => walkKids(realPane()).filter((c: any) => c instanceof CodeRenderable);
  return { live, clock, p, codeNodes, realPane, paneId: id };
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

  test("a no-filetype text file renders as a theme-colored Code node, not a bare Text node", async () => {
    const file = path.join(tmpDir, "c.txt");
    writeFileSync(file, "hello preview\n");
    const { live, clock, p, codeNodes } = mkLivePreview(file);
    Object.assign(live, { sidebarFg: "#aabbcc" });
    p.renderPreview();
    clock.flush();
    // settle ON the body node itself: the header Textes paint synchronously,
    // the file content only after the async readFile resolves. The body
    // nests inside the gutter — codeNodes() walks the whole subtree.
    const bodyOf = () => codeNodes().find((c: any) => String(c.content).includes("hello preview"));
    expect(await settleUntil(t, () => !!bodyOf())).toBe(true);
    const body = bodyOf() as any;
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
    expect(await settleUntil(t, () => bodyOf() === body)).toBe(true);
    // ... and a theme flip must evict it too (sig carries white + sidebarFg)
    Object.assign(live, { white: "#112233" });
    p.renderPreview();
    clock.flush();
    expect(await settleUntil(t, () => !!bodyOf() && bodyOf() !== body)).toBe(true);
    expect([...(bodyOf() as any).fg.toInts()]).toEqual([0x11, 0x22, 0x33, 0xff]);
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
      const ok = await settleUntil(
        t,
        () =>
          walkKids(t.renderer.root.findDescendantById(id)).filter(
            (c: any) => c instanceof CodeRenderable && String(c.content).includes("secret-bytes"),
          ).length > 0,
      );
      expect(seen).toEqual([file]);
      expect(ok).toBe(true);
    } finally {
      chmodSync(file, 0o644);
    }
  });
});

// --- rich preview: markdown renders through MarkdownRenderable (headings,
// lists, links — not a monochrome code dump), every text body (code or not)
// rides inside a LineNumberRenderable gutter, and code
// bodies linkify bare URLs via
// detectLinks (OSC-8, terminal-native ctrl+click). ---
const mdNodes = (id: string) =>
  walkKids(t.renderer.root.findDescendantById(id)).filter((c: any) => c instanceof MarkdownRenderable);
const gutterNodes = (id: string) =>
  walkKids(t.renderer.root.findDescendantById(id)).filter((c: any) => c instanceof LineNumberRenderable);

describe("preview rich rendering", () => {
  test("a .md file mounts MarkdownRenderable, not CodeRenderable", async () => {
    const file = path.join(tmpDir, "doc.md");
    writeFileSync(file, "# Hello\n\n- one\n- two\n");
    const clock = mkClock();
    const id = `tfm-preview-${paneSeq++}`;
    const pane = Box({ id, width: 40, height: 20 });
    t.renderer.root.add(pane);
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
    });
    p.renderPreview();
    clock.flush();
    expect(await settleUntil(t, () => mdNodes(id).length === 1)).toBe(true);
    const kids = (t.renderer.root.findDescendantById(id) as any).getChildren();
    expect(kids.filter((c: any) => c instanceof CodeRenderable).length).toBe(0);
    // the heading text survives the markdown render (conceal hides the `#`)
    expect(String((mdNodes(id)[0] as any).content ?? "")).toContain("Hello");
  });

  test("a code file body rides inside a LineNumberRenderable gutter", async () => {
    const file = path.join(tmpDir, "g.js");
    writeFileSync(file, "const a = 1;\nconst b = 2;\n");
    const { clock, p, paneId } = mkLivePreview(file);
    p.renderPreview();
    clock.flush();
    expect(await settleUntil(t, () => gutterNodes(paneId).length === 1)).toBe(true);
    // the gutter wraps the real code body (not an empty shell)
    const textOf = (c: any) => {
      if (typeof c.content === "string") return c.content;
      const ch = c.content?.chunks ?? c.chunks;
      return Array.isArray(ch) ? ch.map((x: any) => x.text).join("") : "";
    };
    const body = (gutterNodes(paneId)[0] as any).getChildren().find((c: any) => c instanceof CodeRenderable);
    expect(body).toBeTruthy();
    expect(textOf(body)).toContain("const a = 1;");
  });

  test("a code body carries the linkify onChunks hook (bare URLs become OSC-8)", async () => {
    const file = path.join(tmpDir, "u.js");
    writeFileSync(file, "// see https://example.com/docs\nconst z = 9;\n");
    const { clock, p, realPane } = mkLivePreview(file);
    p.renderPreview();
    clock.flush();
    const ok = await settleUntil(
      t,
      () =>
        walkKids(realPane()).filter((c: any) => c instanceof CodeRenderable && typeof c.onChunks === "function")
          .length > 0,
    );
    expect(ok).toBe(true);
  });

  test("wrap mode drives code bodies (char wraps, none clips)", async () => {
    const file = path.join(tmpDir, "w.js");
    writeFileSync(file, "const wrap = true;\n");
    const on = mkLivePreview(file, "char");
    on.p.renderPreview();
    on.clock.flush();
    expect(await settleUntil(t, () => gutterNodes(on.paneId).length === 1)).toBe(true);
    const onBody = (gutterNodes(on.paneId)[0] as any).getChildren().find((c: any) => c instanceof CodeRenderable);
    expect((onBody as any).wrapMode).toBe("char");

    const off = mkLivePreview(file, "none");
    off.p.renderPreview();
    off.clock.flush();
    expect(await settleUntil(t, () => gutterNodes(off.paneId).length === 1)).toBe(true);
    const offBody = (gutterNodes(off.paneId)[0] as any).getChildren().find((c: any) => c instanceof CodeRenderable);
    // off clips (none), it must NOT fall back to word: word mode still
    // hard-slices spaceless code runs by character (consumePendingWordPrefix)
    expect((offBody as any).wrapMode).toBe("none");
  });

  test("a wrap toggle rebuilds the cached node instead of serving stale wrap", async () => {
    const file = path.join(tmpDir, "wt.js");
    writeFileSync(file, "const t = 1;\n");
    const first = mkLivePreview(file, "char");
    first.p.renderPreview();
    first.clock.flush();
    expect(await settleUntil(t, () => gutterNodes(first.paneId).length === 1)).toBe(true);
    const firstNode = gutterNodes(first.paneId)[0];
    // same file re-previewed with the toggle flipped: key/mtime/size match,
    // so only the wrap key can force the rebuild
    const flipClock = mkClock();
    const flip = makePreview({
      renderer: t.renderer,
      byId: () => t.renderer.root.findDescendantById(first.paneId),
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
      sched: flipClock.sched,
      wrapMode: () => "none" as WrapMode,
    });
    flip.renderPreview();
    flipClock.flush();
    expect(
      await settleUntil(t, () => gutterNodes(first.paneId).length === 1 && gutterNodes(first.paneId)[0] !== firstNode),
    ).toBe(true);
  });

  test("none clips wide lines without spill and the body scrolls to deep lines", async () => {
    // isolated renderer: the shared one accumulates 20-row panes and pushes
    // later panes off its 30-row viewport, so frame asserts would be
    // meaningless there.
    const solo = await createTestRenderer({ width: 60, height: 20 });
    try {
      const file = path.join(tmpDir, "tallwide.js");
      const lines = [`${"Q".repeat(60)}`, ...Array.from({ length: 59 }, (_, i) => `const w${i}marker = ${i};`)];
      writeFileSync(file, `${lines.join("\n")}\n`);
      const clock = mkClock();
      const id = "tfm-preview-solo";
      solo.renderer.root.add(Box({ id, width: 40, height: 18 }));
      const p = makePreview({
        renderer: solo.renderer,
        byId: () => solo.renderer.root.findDescendantById(id),
        colors: () => ({ ...defaultConfig.theme }) as Theme,
        uiStyle: () => "solid",
        previewEnabled: () => true,
        previewWidth: () => 40,
        termH: () => 18,
        cellMetrics: () => ({ cellW: 10, cellH: 20, aspect: 0.5 }),
        focusKey: () => file,
        tileRefs: new Map(),
        pushThumbJob: () => {},
        drainThumbs: () => {},
        drainIconQueue: () => {},
        nextIconId: () => "slot",
        fallbackGlyphFor: () => "?",
        sched: clock.sched,
        wrapMode: () => "none" as WrapMode,
      });
      p.renderPreview();
      clock.flush();
      const settled = async (): Promise<boolean> => {
        const deadline = Date.now() + 3000;
        const has = () =>
          walkKids(solo.renderer.root.findDescendantById(id)).filter((c: any) => c instanceof LineNumberRenderable)
            .length === 1;
        while (!has() && Date.now() < deadline) {
          await solo.renderOnce();
          await Bun.sleep(10);
        }
        return has();
      };
      expect(await settled()).toBe(true);
      await solo.renderOnce();
      // the 60-Q line is cut at the body width: no visual row carries the
      // 26-Q continuation a wrap would paint
      const frame0 = await solo.captureCharFrame();
      expect(/Q{30,}/.test(frame0)).toBe(true); // head visible
      expect(/Q{35,}/.test(frame0)).toBe(false); // clipped, not wrapped
      expect(frame0.includes("w40marker")).toBe(false); // deep lines below the fold
      // exactly one scrollbox per pane; scrolling it reveals deep lines
      const scrollers = walkKids(solo.renderer.root.findDescendantById(id)).filter(
        (c: any) => typeof c.scrollTo === "function",
      );
      expect(scrollers.length).toBe(1);
      const sc = scrollers[0] as any;
      sc.scrollTo({ y: 30 });
      await solo.renderOnce();
      expect(sc.scrollTop).toBe(30);
      // w-markers are unique to this file, so the frame assert is exact
      expect((await solo.captureCharFrame()).includes("w40marker")).toBe(true);
    } finally {
      solo.renderer.destroy();
    }
  });

  test("markdown fences follow the mode, prose and tables stay word", async () => {
    // Fence blocks carry their info-string filetype (e.g. javascript);
    // prose blocks stay filetype markdown. Only fences take the mode.
    const file = path.join(tmpDir, "fence.md");
    writeFileSync(file, "# T\n\nSome paragraph prose here.\n\n```js\nconst fence = true;\n```\n");
    const findCode = (id: string): any[] =>
      walkKids(t.renderer.root.findDescendantById(id)).filter((k: any) => k instanceof CodeRenderable);
    for (const mode of ["char", "none", "word"] as WrapMode[]) {
      const pv = mkLivePreview(file, mode);
      pv.p.renderPreview();
      pv.clock.flush();
      expect(await settleUntil(t, () => findCode(pv.paneId).length > 0)).toBe(true);
      await t.renderOnce();
      const codes = findCode(pv.paneId);
      const fences = codes.filter((c: any) => c.filetype !== "markdown");
      const prose = codes.filter((c: any) => c.filetype === "markdown");
      expect(fences.length).toBeGreaterThan(0);
      expect(prose.length).toBeGreaterThan(0);
      for (const c of fences) expect(c.wrapMode).toBe(mode);
      for (const c of prose) expect(c.wrapMode).toBe("word");
    }
  });

  test("no-filetype files follow the wrap mode and get the gutter", async () => {
    // The old "prose" branch forced word wrap on every grammarless file,
    // which char-sliced long spaceless key=value lines mid-word even with
    // wrap-mode=none (the reported .conf preview bug). Mode now governs
    // them like any other code body, gutter included.
    const conf = path.join(tmpDir, "app.conf");
    writeFileSync(conf, "averyveryverylongkeyvaluewithoutanyspacesatallhere=1\n");
    for (const mode of ["char", "none", "word"] as WrapMode[]) {
      const pv = mkLivePreview(conf, mode);
      pv.p.renderPreview();
      pv.clock.flush();
      expect(await settleUntil(t, () => gutterNodes(pv.paneId).length === 1)).toBe(true);
      const body = (gutterNodes(pv.paneId)[0] as any).getChildren().find((c: any) => c instanceof CodeRenderable);
      expect(body).toBeTruthy();
      expect(body.wrapMode).toBe(mode);
    }
  });
});
