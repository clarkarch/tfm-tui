import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Box, Yoga } from "@opentui/core";
import { createTestRenderer, type TestRendererSetup } from "@opentui/core/testing";
import { makeProps } from "./ui-props";
import { makeDialogs } from "./ui-dialogs";
import { makeFloats } from "./floats";
import { defaultConfig } from "../config/config-schema";
import type { Theme } from "../config/config";
import type { ListEntry } from "./ui-menu";

// Headless widget test (createTestRenderer pilot: ui-menu.test.ts). Pins the
// properties dialog through the PUBLIC makeProps surface: single-file layout
// (name/size/perms rows), the nautilus-style permissions editor driving REAL
// chmods on a sandboxed file, exec-capable detection + the execute toggle,
// star/bookmark persistence (sandboxed $XDG_* registries), and the
// multi-selection aggregate. Dialog skeleton + floats are the REAL modules
// (fake-guard rule: mirror the collaborators).

const colors = defaultConfig.theme as Theme & Record<string, any>;

let t: TestRendererSetup;
let liveColors: Theme & Record<string, any>;
let liveStyle: "solid" | "outline" | "outline-partial";
// every makeIconSlot call's states, in order — the ONLY way to see what bg a
// raster will flatten onto (the handle's spec is not mounted)
let slotStates: Array<{ name: string; states: any[] }>;
let sandbox: string;
let saved: Record<string, string | undefined>;
let floats: ReturnType<typeof makeFloats>;
let props: ReturnType<typeof makeProps>;
let iconStates: Array<{ spec: any; idx: number }>;
let contextMenus: Array<{ title: string; entries: ListEntry[] }>;
let statusMsgs: string[];
let renderAllCount: number;
let thumbJobs: Array<{ slotId: string; [k: string]: unknown }> = [];
let iconIdSeq = 0;
let fileA: string;
let fileSh: string;
let dirD: string;

const byId = (id: string) => t.renderer.root.findDescendantById(id);
const text = (id: string): string => {
  const n: any = byId(id);
  const c = n?.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c?.chunks)) return c.chunks.map((x: any) => x?.text ?? "").join("");
  return c?.text ?? "";
};
const hexInts = (hex: string): number[] => {
  const h = hex.replace("#", "");
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16), 255];
};
const bgInts = (id: string): number[] => {
  const n: any = byId(id);
  return n?.backgroundColor ? [...n.backgroundColor.toInts()] : [0, 0, 0, 0];
};
const fire = (id: string, type: string) =>
  (byId(id) as any).processMouseEvent({
    type,
    button: 0,
    x: 0,
    y: 0,
    modifiers: { shift: false, alt: false, ctrl: false },
  });
const settle = async (cond: () => boolean, ms = 3000): Promise<void> => {
  const deadline = Date.now() + ms;
  while (!cond() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
  expect(cond()).toBe(true);
};

beforeAll(async () => {
  // 32 rows: the multi dialog's name list + "…and N more" row must fit
  t = await createTestRenderer({ width: 90, height: 32 });
  saved = {
    XDG_DATA_HOME: process.env.XDG_DATA_HOME,
    XDG_STATE_HOME: process.env.XDG_STATE_HOME,
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
  };
  sandbox = mkdtempSync(path.join(os.tmpdir(), "tfm-props-test-"));
  // starred.list -> XDG_STATE_HOME/tfm; gtk bookmarks -> XDG_CONFIG_HOME/gtk-3.0
  process.env.XDG_STATE_HOME = path.join(sandbox, "state");
  process.env.XDG_CONFIG_HOME = path.join(sandbox, "config");
  mkdirSync(path.join(sandbox, "state"), { recursive: true });
  mkdirSync(path.join(sandbox, "config"), { recursive: true });

  fileA = path.join(sandbox, "f.txt");
  writeFileSync(fileA, "hello");
  chmodSync(fileA, 0o644);
  fileSh = path.join(sandbox, "tool.sh");
  writeFileSync(fileSh, "#!/bin/sh\necho hi\n");
  chmodSync(fileSh, 0o755);
  dirD = path.join(sandbox, "d");
  mkdirSync(dirD);

  iconStates = [];
  contextMenus = [];
  statusMsgs = [];
  slotStates = [];
  renderAllCount = 0;
  floats = makeFloats();
  liveColors = colors;
  liveStyle = "solid";

  const dialogs = makeDialogs({
    byId,
    rootAdd: (node) => t.renderer.root.add(node),
    stripSelectable: () => {},
    termH: () => 24,
    uiStyle: () => liveStyle,
    colors: () => liveColors,
    closeFileMenu: () => {},
  });

  props = makeProps({
    byId,
    openDialog: dialogs.openDialog,
    closeDialog: dialogs.closeDialog,
    setTextOnId: (id, s) => {
      const n: any = byId(id);
      if (n) {
        try {
          n.content = s;
        } catch {}
      }
    },
    setOnId: (id, fn) => {
      const n: any = byId(id);
      if (n) {
        try {
          fn(n);
        } catch {}
      }
    },
    stripSelectable: () => {},
    drainIconQueue: () => {},
    drainThumbs: () => {},
    pushThumbJob: (job) => {
      thumbJobs.push(job);
    },
    nextIconId: () => `icon-${++iconIdSeq}`,
    escHintBtn: (id) => Box({ id, width: 3, height: 1 }),
    closeFileMenu: () => {},
    openContextMenu: (_x, _y, title, entries) => {
      contextMenus.push({ title, entries });
    },
    floats,
    renderAll: () => {
      renderAllCount++;
    },
    notify: (msg, title, level) => {
      statusMsgs.push(`${title}:${level}:${msg}`);
    },
    uiStyle: () => liveStyle,
    colors: () => liveColors,
    home: os.homedir(),
    makeIconSlot: (
      name: string,
      states: any,
      heightCells?: number,
      initialState?: number,
      onMouseDown?: (ev: any) => void,
    ) => {
      // recorded before the fake handle: `states` is exactly what a real drain
      // flattens each raster onto (bg included)
      slotStates.push({ name, states });
      // mirrors ui-slots: a fixed-size Box hit area carrying the id + handler
      return {
        el: Box({ id: `slot-${name}`, width: 2, height: heightCells ?? 1, onMouseDown }),
        slotId: `slot-${name}`,
        spec: { slotId: `slot-${name}`, name, heightCells: heightCells ?? 1, states, initialState: initialState ?? 0 },
      };
    },
    setIconState: (spec, idx) => {
      iconStates.push({ spec, idx });
      return true;
    },
    fallbackGlyphFor: () => "file",
    cellMetrics: () => ({ aspect: 0.5 }),
  });
});

afterAll(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(sandbox, { recursive: true, force: true });
  t.renderer.destroy();
});

const down = (id: string) => {
  // mirrors the real MouseEvent contract: stopPropagation flips the flag the
  // bubble walk reads — otherwise the click reaches the dialog scrim and
  // closes it mid-test
  let stopped = false;
  (byId(id) as any).processMouseEvent({
    type: "down",
    button: 0,
    x: 0,
    y: 0,
    modifiers: { shift: false, alt: false, ctrl: false },
    stopPropagation: () => {
      stopped = true;
    },
    get propagationStopped() {
      return stopped;
    },
  });
};

describe("single-file properties", () => {
  test("mounts the dialog: name, size, perm rows paint; floats owns the layer", async () => {
    props.openProperties(fileA);
    await t.renderOnce();
    expect(byId("tfm-props")).toBeTruthy();
    expect(byId("tfm-props-panel")).toBeTruthy();
    expect(props.isOpen()).toBe(true);
    expect(floats.isOpen("props")).toBe(true);
    const frame = t.captureCharFrame();
    expect(frame).toContain("f.txt");
    expect(frame).toContain("5 B (5 bytes)");
    expect(frame).toContain("read, write"); // 0o644 owner
  });

  test("closeProps tears the dialog down through floats", async () => {
    props.closeProps();
    await t.renderOnce();
    expect(byId("tfm-props")).toBeFalsy();
    expect(props.isOpen()).toBe(false);
    expect(floats.isOpen("props")).toBe(false);
  });

  test("source-gone target toasts instead of blinking", async () => {
    statusMsgs.length = 0;
    props.openProperties(path.join(sandbox, "vanished.txt"));
    await t.renderOnce();
    expect(props.isOpen()).toBe(false);
    expect(statusMsgs).toContain("properties:error:Can't show properties (source gone)");
  });

  test("exec checkbox only exists for exec-capable files (shebang/ext/mode)", async () => {
    props.openProperties(fileA);
    await t.renderOnce();
    expect(byId("tfm-props-exec")).toBeFalsy(); // .txt, 644, no shebang
    props.closeProps();
    await t.renderOnce();

    props.openProperties(fileSh);
    await t.renderOnce();
    expect(byId("tfm-props-exec")).toBeTruthy();
  });

  test("clicking the execute row chmods the real file and repaints the perm words", async () => {
    props.openProperties(fileSh);
    await t.renderOnce();
    down("tfm-props-exec"); // 0o755 -> strips all exec bits
    // settle on the UI repaint, not the disk: the chmod syscall lands before
    // the promise continuation refreshes the perm words
    await settle(() => text("tfm-props-perm-owner-words") === "read, write");
    await t.renderOnce();
    expect(text("tfm-props-perm-owner-words")).toBe("read, write"); // "run" gone
    // click again: exec-capable via shebang -> re-adds u+x (go+x follow r)
    down("tfm-props-exec");
    await settle(() => text("tfm-props-perm-owner-words") === "read, write, run");
    props.closeProps();
    await t.renderOnce();
  });

  test("perm class menu opens with the three access options and applies them", async () => {
    props.openProperties(fileA);
    await t.renderOnce();
    down("tfm-props-perm-owner");
    expect(contextMenus.length).toBe(1);
    const labels = contextMenus[0]!.entries.map((e) => e.label);
    expect(labels.some((l) => l!.includes("read & write"))).toBe(true);
    expect(labels.some((l) => l!.includes("read-only"))).toBe(true);
    expect(labels.some((l) => l!.includes("none"))).toBe(true);

    contextMenus[0]!.entries.find((e) => e.label!.includes("none"))!.action();
    await settle(() => text("tfm-props-perm-owner-words") === "no access");
    // restore
    contextMenus[0]!.entries.find((e) => e.label!.includes("read & write"))!.action();
    await settle(() => text("tfm-props-perm-owner-words") === "read, write");
    props.closeProps();
    await t.renderOnce();
  });

  test("starring toggles the registry (sandboxed $XDG_STATE_HOME)", async () => {
    props.openProperties(fileA);
    await t.renderOnce();
    down("slot-star");
    const listPath = path.join(sandbox, "state", "tfm", "starred.list");
    await settle(() => existsSync(listPath) && readFileSync(listPath, "utf8").includes(fileA));
    down("slot-star"); // unstar
    await settle(() => !readFileSync(listPath, "utf8").includes(fileA));
    props.closeProps();
    await t.renderOnce();
  });

  test("directories get a bookmark toggle that writes the gtk bookmarks file", async () => {
    props.openProperties(dirD);
    await t.renderOnce();
    expect(byId("tfm-props-bm")).toBeTruthy(); // dirs only
    const bmPath = path.join(sandbox, "config", "gtk-3.0", "bookmarks");
    down("slot-bookmark");
    await settle(() => existsSync(bmPath) && readFileSync(bmPath, "utf8").includes(dirD));
    // renderAll fires after setBookmarked -> loadSystemPlaces (spawns lsblk)
    await settle(() => renderAllCount > 0);
    props.closeProps();
    await t.renderOnce();
  });

  test("hovering star/bookmark flips the raster state AND the wrapper surface", async () => {
    props.openProperties(dirD);
    await t.renderOnce();
    // the raster bakes its bg, so a wrapper that only swapped the raster would
    // leave a stale square; the hover bit is the top half of the toggle index
    // (idx = on*1 + hover*2 — see ui-slots.toggleIconState)
    const hoverIdx = () => iconStates.filter((s) => s.spec?.slotId === "slot-star").at(-1)?.idx;
    const bmHoverIdx = () => iconStates.filter((s) => s.spec?.slotId === "slot-bookmark").at(-1)?.idx;
    iconStates.length = 0;
    expect(bgInts("tfm-props-star")).toEqual(hexInts(colors.sidebarBg));
    fire("tfm-props-star", "move");
    expect(bgInts("tfm-props-star")).toEqual(hexInts(colors.hoverBg));
    expect(hoverIdx()).toBeGreaterThanOrEqual(2);
    fire("tfm-props-star", "out");
    expect(bgInts("tfm-props-star")).toEqual(hexInts(colors.sidebarBg));
    expect(hoverIdx()).toBeLessThan(2);

    // dirs also get the bookmark toggle, wired through the same helper
    iconStates.length = 0;
    fire("tfm-props-bm", "move");
    expect(bgInts("tfm-props-bm")).toEqual(hexInts(colors.hoverBg));
    expect(bmHoverIdx()).toBeGreaterThanOrEqual(2);
    fire("tfm-props-bm", "out");
    expect(bgInts("tfm-props-bm")).toEqual(hexInts(colors.sidebarBg));
    props.closeProps();
    await t.renderOnce();
  });

  test("dialog rasters flatten onto the dialog fill, never the canvas (outline-partial)", async () => {
    // The dialog is FILLED in outline-partial (floatSurface), while chrome has
    // no rest fill there — so the chrome flatten target (canvas bg) baked a
    // visible square behind every icon in this dialog. Role "float" is the fix;
    // the check is that no dialog raster targets the canvas bg.
    liveStyle = "outline-partial";
    try {
      const restBg = (name: string) =>
        slotStates.filter((s) => s.name === name).at(-1)?.states[0]?.bg as string | undefined;
      const lastStates = (name: string) => slotStates.filter((s) => s.name === name).at(-1)?.states ?? [];
      const noCanvasRasters = () => {
        for (const { name, states } of slotStates) {
          for (const st of states) expect([name, st.bg]).not.toEqual([name, colors.bg]);
        }
      };

      slotStates.length = 0;
      props.openProperties(dirD);
      await t.renderOnce();
      expect(restBg("star")).toBe(colors.sidebarBg);
      expect(restBg("bookmark")).toBe(colors.sidebarBg);
      expect(restBg("folder")).toBe(colors.sidebarBg); // the big hero raster
      noCanvasRasters();
      // hover states keep the shared cue in every style
      expect(lastStates("star")[2]?.bg).toBe(colors.hoverBg);
      props.closeProps();
      await t.renderOnce();

      // the perms editor's raster checkboxes (exec-capable file only) too
      slotStates.length = 0;
      props.openProperties(fileSh);
      await t.renderOnce();
      expect(restBg("checkbox-blank")).toBe(colors.sidebarBg);
      expect(restBg("checkbox-marked")).toBe(colors.sidebarBg);
      noCanvasRasters();
      props.closeProps();
      await t.renderOnce();
    } finally {
      liveStyle = "solid";
    }
  });

  test("directory size resolves async from the dir walk", async () => {
    writeFileSync(path.join(dirD, "blob"), "x".repeat(2048));
    props.openProperties(dirD);
    await t.renderOnce();
    await settle(() => text("tfm-props-size").includes("2.0 KB"));
    props.closeProps();
    await t.renderOnce();
  });
});

describe("multi-selection properties", () => {
  test("aggregates count + size, caps the name list at 6", async () => {
    const many = Array.from({ length: 8 }, (_, i) => {
      const p = path.join(sandbox, `m${i}.dat`);
      writeFileSync(p, "z".repeat(1024));
      return p;
    });
    props.openProperties(many);
    await t.renderOnce();
    const frame = t.captureCharFrame();
    expect(frame).toContain("8 items selected");
    expect(frame).toContain("8.0 KB");
    expect(frame).toContain("m5.dat");
    expect(frame).not.toContain("m6.dat");
    expect(frame).toContain("…and 2 more");
    props.closeProps();
    await t.renderOnce();
  });

  test("a single surviving path falls back to the single dialog", async () => {
    props.openProperties([fileA]);
    await t.renderOnce();
    const frame = t.captureCharFrame();
    expect(frame).toContain("f.txt");
    expect(frame).not.toContain("items selected");
    props.closeProps();
    await t.renderOnce();
  });
});

describe("image hero centering", () => {
  test("the thumbnail slot centers its raster (parity with grid/list slots)", async () => {
    const img = path.join(sandbox, "pic.png");
    writeFileSync(img, "x");
    thumbJobs = [];
    props.openProperties(img);
    await settle(() => thumbJobs.length > 0);
    const job = thumbJobs.at(-1)!;
    const slot: any = byId(job.slotId);
    expect(slot).toBeTruthy();
    // a raster narrower than the slot must center, not hug the left edge
    expect(slot.yogaNode.getFlexDirection()).toBe(Yoga.FLEX_DIRECTION_ROW);
    expect(slot.yogaNode.getJustifyContent()).toBe(Yoga.JUSTIFY_CENTER);
    props.closeProps();
  });

  test("the hero row shifts thumbnails one cell left (image width lands centered)", async () => {
    const img = path.join(sandbox, "pic2.png");
    writeFileSync(img, "x");
    thumbJobs = [];
    props.openProperties(img);
    await settle(() => thumbJobs.length > 0);
    const slot: any = byId(thumbJobs.at(-1)!.slotId);
    const heroRow: any = slot?.parent;
    expect(heroRow?.yogaNode?.getPadding?.(Yoga.EDGE_RIGHT)?.value ?? 0).toBe(2);
    props.closeProps();
  });

  test("the icon hero shifts the same cell (same raster anchoring)", async () => {
    props.openProperties(fileA);
    await t.renderOnce();
    const slot: any = byId("slot-file-document");
    const heroRow: any = slot?.parent;
    expect(slot).toBeTruthy();
    expect(heroRow?.yogaNode?.getPadding?.(Yoga.EDGE_RIGHT)?.value ?? 0).toBe(2);
    props.closeProps();
  });

  test("the multi-select hero shifts the same cell", async () => {
    props.openProperties([fileA, fileSh]);
    await t.renderOnce();
    const slot: any = byId("slot-select-all");
    const heroRow: any = slot?.parent;
    expect(slot).toBeTruthy();
    expect(heroRow?.yogaNode?.getPadding?.(Yoga.EDGE_RIGHT)?.value ?? 0).toBe(2);
    props.closeProps();
  });

  test("repaint() rebuilds the open dialog with live colors", async () => {
    props.openProperties(fileA);
    await t.renderOnce();
    expect(props.isOpen()).toBe(true);
    const prev = liveColors;
    liveColors = { ...colors, sidebarBg: "#101020" } as Theme & Record<string, any>;
    try {
      props.repaint();
      await t.renderOnce();
      // still open on the same file, panel carries the new palette
      expect(props.isOpen()).toBe(true);
      expect(floats.isOpen("props")).toBe(true);
      const panel = byId("tfm-props-panel") as any;
      const bg = panel.backgroundColor;
      const ints = typeof bg === "string" ? bg : [...bg.toInts()];
      expect(ints).toEqual([0x10, 0x10, 0x20, 255]);
      expect(t.captureCharFrame()).toContain("f.txt");
    } finally {
      liveColors = prev;
      props.closeProps();
    }
  });

  test("repaint() is a no-op when closed", async () => {
    props.closeProps();
    expect(() => props.repaint()).not.toThrow();
    expect(byId("tfm-props")).toBeFalsy();
  });
});
