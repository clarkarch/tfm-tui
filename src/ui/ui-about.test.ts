import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Box, Text } from "@opentui/core";
import { createTestRenderer, type TestRendererSetup } from "@opentui/core/testing";
import { defaultConfig } from "../config/config-schema";
import type { Theme } from "../config/config";
import pkg from "../../package.json";
import { PLUGIN_API_VERSION } from "../plugins/plugin-api";
import {
  ABOUT_LABEL_W,
  ABOUT_LOGO_CELLS,
  ABOUT_ROWS,
  ABOUT_W,
  CREDITS_DETAIL,
  aboutPanelWidth,
  aboutTruncates,
  aboutValueFor,
  aboutValueRoom,
  renderAboutPanel,
  type AboutDeps,
  type AboutRow,
} from "./ui-about";

const colors = defaultConfig.theme as Theme;

describe("about rows (pure)", () => {
  test("portrait width clamps to the terminal like the help view", () => {
    expect(ABOUT_W).toBe(40);
    expect(aboutPanelWidth(100)).toBe(ABOUT_W);
    expect(aboutPanelWidth(30)).toBe(40);
  });

  test("value room is the panel minus label, row pad and margin", () => {
    expect(ABOUT_LABEL_W).toBe(14);
    expect(aboutValueRoom(ABOUT_W)).toBe(24);
  });

  test("long links truncate with … but still open (short links fit)", () => {
    // at portrait width the room can't hold full domains — the … marks
    // truncated rows, clicks still carry the full URL (pinned below)
    const room = aboutValueRoom(ABOUT_W);
    for (const key of ["website", "github"]) {
      const row = ABOUT_ROWS.find((r) => r.key === key)!;
      expect(aboutTruncates(row, room)).toBe(true);
      expect(aboutValueFor(row, room)).toEndWith("…");
    }
    const credits = ABOUT_ROWS.find((r) => r.key === "credits")!;
    expect(aboutTruncates(credits, room)).toBe(true);
  });

  test("api row tracks the plugin api version, never a literal", () => {
    expect(ABOUT_ROWS.find((r) => r.key === "api")?.value).toBe(`v${PLUGIN_API_VERSION}`);
  });

  test("every label keeps properties-like air before its value", () => {
    // the properties dialog's short labels always leave big air; about's
    // 10-char labels sat 1 cell off their values at padEnd(12) — the column
    // now guarantees >= 3 cells everywhere, in both views
    for (const row of [...ABOUT_ROWS, ...CREDITS_DETAIL]) {
      expect(` ${row.label}`.padEnd(ABOUT_LABEL_W).endsWith(" ")).toBe(true);
      expect(ABOUT_LABEL_W - ` ${row.label}`.length).toBeGreaterThanOrEqual(3);
    }
  });
});

describe("about panel rendering", () => {
  let t: TestRendererSetup;
  beforeAll(async () => {
    t = await createTestRenderer({ width: 100, height: 30 });
  });
  afterAll(() => {
    t.renderer.destroy();
  });

  const pointers: string[] = [];
  const opened: string[] = [];
  const details: string[] = [];
  const logoReqs: Array<{ name: string; heightCells: number; faithful: boolean }> = [];
  let backed = 0;
  let detail: AboutDeps["detail"] = null;
  let openPanelSeq = 0;

  const openPanel = async (id: string, which: AboutDeps["detail"]) => {
    detail = which;
    const panel: any = Box({ id, width: "100%" });
    t.renderer.root.add(panel);
    await t.renderOnce();
    const mounted = t.renderer.root.findDescendantById(id) as any;
    renderAboutPanel(colors, mounted, {
      renderer: () => t.renderer as never,
      makeIconSlot: ((
        name: string,
        _s: unknown,
        heightCells?: number,
        _i?: number,
        _d?: unknown,
        _f?: unknown,
        opts?: { faithful?: boolean },
      ) => {
        logoReqs.push({ name, heightCells: heightCells ?? 1, faithful: opts?.faithful ?? false });
        return {
          el: Box({ width: 4, height: 2 }, Text({ content: `logo:${name}` })),
          slotId: "about-logo",
          spec: undefined as never,
        };
      }) as never,
      onOpenUrl: (url: string) => void opened.push(url),
      detail,
      onOpenDetail: (key: string) => void details.push(key),
      onBack: () => void backed++,
      setPointer: (s) => void pointers.push(s as string),
    });
    await t.renderOnce();
    return id;
  };
  const openMain = () => openPanel(`about-main-${openPanelSeq++}`, null);
  // remove via the MOUNTED node: the pre-mount proxy's parent never resolves
  // after mount, so proxy-removes silently leak panels into later tests
  const closePanel = async (id: string) => {
    const mounted = t.renderer.root.findDescendantById(id) as any;
    mounted?.parent?.remove(mounted);
    await t.renderOnce();
    expect(t.renderer.root.findDescendantById(id)).toBeFalsy();
  };

  const fire = (id: string, type: string) => {
    // same propagation protocol as the shell tests: handlers stop the event
    // so it never bubbles past the row (no scrim here, but stay faithful)
    const ev = {
      type,
      button: 0,
      x: 0,
      y: 0,
      modifiers: { shift: false, alt: false, ctrl: false },
      propagationStopped: false,
      stopPropagation() {
        ev.propagationStopped = true;
      },
    };
    return (t.renderer.root.findDescendantById(id) as any)?.processMouseEvent(ev);
  };
  const reset = () => {
    opened.length = 0;
    details.length = 0;
    backed = 0;
    pointers.length = 0;
  };

  test("hero, rows and logo slot request", async () => {
    logoReqs.length = 0;
    const id = await openMain();
    // hero-size faithful brand slot (a tinted drain would flatten the mark)
    expect(logoReqs).toEqual([{ name: "tfm", heightCells: ABOUT_LOGO_CELLS, faithful: true }]);
    expect(ABOUT_LOGO_CELLS).toBe(8);
    const frame = t.captureCharFrame();
    expect(frame).toContain("tfm");
    expect(frame).toContain("terminal file manager");
    expect(frame).toContain("github.com/clarkarch/tf…");
    expect(frame).toContain("MIT");
    expect(frame).toContain(`v${pkg.version}`);
    // the cut copy must stay out: no help-style footer
    expect(frame).not.toContain("F1");
    // version rides the bottom-right corner: painted in the right half
    const versionLine = frame.split("\n").find((line) => line.includes(`v${pkg.version}`));
    expect(versionLine).toBeTruthy();
    expect(versionLine!.indexOf(`v${pkg.version}`)).toBeGreaterThan(versionLine!.length / 2);
    await closePanel(id);
  });

  test("panel is compact: no scroller, tight properties rows, version below", async () => {
    // regression 1: a termH-bounded scroller reserved dead rows and dangled
    // the version far below the content — fixed content rides auto-height.
    // regression 2 (properties idiom): rows stack tight with zero air, split
    // from the hero by one nbsp spacer — never a gap column, never stuck.
    const id = await openMain();
    expect(t.renderer.root.findDescendantById("tfm-about-scroll")).toBeFalsy();
    const lines = t.captureCharFrame().split("\n");
    const heroIdx = lines.findIndex((line) => line.includes("terminal file manager"));
    const versionIdx = lines.findIndex((line) => line.includes(`v${pkg.version}`));
    expect(heroIdx).toBeGreaterThanOrEqual(0);
    expect(versionIdx).toBeGreaterThan(heroIdx);
    // spacer after the subtitle, then five contiguous rows, a divider,
    // then the version — tight properties rhythm, portrait-tall overall
    expect(lines[heroIdx + 1]?.trim()).toBe("");
    for (const [off, label] of ["Website", "GitHub", "Credits", "Plugin API", "License"].entries()) {
      expect(lines[heroIdx + 2 + off]).toContain(label);
    }
    expect(versionIdx - heroIdx).toBe(7);
    await closePanel(id);
  });

  test("label cells enforce the value column structurally (not via string padding)", async () => {
    // trailing spaces inside a Text collapse in production (headless frames
    // preserve them), so the gap must come from layout: every row's first
    // child is a fixed-width cell, in both views
    const id = await openMain();
    for (const row of ABOUT_ROWS) {
      const node = t.renderer.root.findDescendantById(`tfm-about-row-${row.key}`) as any;
      expect(node?.getChildren?.()[0]?.width).toBe(ABOUT_LABEL_W);
    }
    await closePanel(id);
    const did = await openPanel(`about-cell-${openPanelSeq++}`, "credits");
    for (const row of CREDITS_DETAIL) {
      const node = t.renderer.root.findDescendantById(`tfm-about-row-${row.key}`) as any;
      expect(node?.getChildren?.()[0]?.width).toBe(ABOUT_LABEL_W);
    }
    await closePanel(did);
    detail = null;
  });

  test("link rows open their exact URL on click", async () => {
    const id = await openMain();
    reset();
    fire("tfm-about-row-website", "down");
    fire("tfm-about-row-github", "down");
    expect(opened).toEqual(["https://clarkarch.github.io/tfm-tui", "https://github.com/clarkarch/tfm-tui"]);
    expect(details).toEqual([]);
    await closePanel(id);
  });

  test("the overloaded credits row drills instead of opening", async () => {
    const id = await openMain();
    reset();
    // preview shows the ellipsis affordance
    expect(t.captureCharFrame()).toContain("…");
    fire("tfm-about-row-credits", "down");
    expect(details).toEqual(["credits"]);
    expect(opened).toEqual([]);
    await closePanel(id);
  });

  test("fitting static rows are inert (no handlers fire)", async () => {
    const id = await openMain();
    reset();
    fire("tfm-about-row-license", "down");
    fire("tfm-about-row-api", "down");
    expect(opened).toEqual([]);
    expect(details).toEqual([]);
    await closePanel(id);
  });

  test("hover sets the pointer on actionable rows only", async () => {
    const id = await openMain();
    reset();
    fire("tfm-about-row-github", "move");
    fire("tfm-about-row-github", "out");
    expect(pointers).toEqual(["pointer", "default"]);
    reset();
    fire("tfm-about-row-license", "move");
    fire("tfm-about-row-license", "out");
    expect(pointers).toEqual([]);
    await closePanel(id);
  });

  test("detail view shows the full credits plus a working back row", async () => {
    const panel = await openPanel(`about-detail-${openPanelSeq++}`, "credits");
    // wrapped values split across frame lines (with the scroller's █ bar at
    // the fold, sometimes mid-word) — flatten and compare whitespace-free
    const flat = t
      .captureCharFrame()
      .split("\n")
      .map((line) => line.trimEnd())
      .join(" ")
      .replace(/█/g, "")
      .replace(/ {2,}/g, " ");
    const compact = flat.replace(/ /g, "");
    const noWs = (s: string): string => s.replace(/ /g, "");
    for (const row of CREDITS_DETAIL) {
      expect(compact).toContain(noWs(row.label));
      expect(compact).toContain(noWs(row.value));
    }
    expect(compact).toContain("←Back");
    reset();
    fire("tfm-about-back", "down");
    expect(backed).toBe(1);
    // back sits in the label column like every other row, not at col 0
    {
      const raw = t.captureCharFrame().split("\n");
      const colOf = (needle: string): number => {
        const line = raw.find((l) => l.includes(needle));
        return line?.indexOf(needle) ?? -1;
      };
      expect(colOf("← Back")).toBe(colOf("OpenTUI"));
    }
    await closePanel(panel);
    detail = null;
  });

  test("every credit with a site opens its exact URL on click", async () => {
    const panel = await openPanel(`about-links-${openPanelSeq++}`, "credits");
    reset();
    const linked = CREDITS_DETAIL.filter((r): r is AboutRow & { url: string } => r.url !== undefined);
    // each credit names its own project page — no shared/duplicate targets
    expect(linked.length).toBeGreaterThan(0);
    expect(new Set(linked.map((r) => r.url)).size).toBe(linked.length);
    for (const row of linked) {
      fire(`tfm-about-row-${row.key}`, "down");
    }
    // literals, not derived from the data: a URL edit must update this
    // list deliberately instead of passing against itself
    expect(opened).toEqual([
      "https://opentui.com",
      "https://bun.sh",
      "https://www.nerdfonts.com",
      "https://pictogrammers.com/library/mdi/",
      "https://github.com/sst/opencode",
      "https://apps.gnome.org/Nautilus/",
    ]);
    // hover sets the pointer on linked credit rows
    reset();
    fire(`tfm-about-row-${linked[0]!.key}`, "move");
    fire(`tfm-about-row-${linked[0]!.key}`, "out");
    expect(pointers).toEqual(["pointer", "default"]);
    await closePanel(panel);
    detail = null;
  });
});
