import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Box } from "@opentui/core";
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
let sandbox: string;
let saved: Record<string, string | undefined>;
let floats: ReturnType<typeof makeFloats>;
let props: ReturnType<typeof makeProps>;
let iconStates: Array<{ spec: any; idx: number }>;
let contextMenus: Array<{ title: string; entries: ListEntry[] }>;
let statusMsgs: string[];
let renderAllCount: number;
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
  renderAllCount = 0;
  floats = makeFloats();

  const dialogs = makeDialogs({
    byId,
    rootAdd: (node) => t.renderer.root.add(node),
    stripSelectable: () => {},
    termH: () => 24,
    uiStyle: () => "solid",
    colors: () => colors,
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
    pushThumbJob: () => {},
    nextIconId: () => `icon-${Math.random()}`,
    escHintBtn: (id) => Box({ id, width: 3, height: 1 }),
    closeFileMenu: () => {},
    openContextMenu: (_x, _y, title, entries) => {
      contextMenus.push({ title, entries });
    },
    floats,
    renderAll: () => {
      renderAllCount++;
    },
    setStatusMsg: (msg) => {
      statusMsgs.push(msg);
    },
    uiStyle: () => "solid",
    colors: () => colors,
    home: os.homedir(),
    makeIconSlot: (
      name: string,
      states: any,
      heightCells?: number,
      initialState?: number,
      onMouseDown?: (ev: any) => void,
    ) => ({
      // mirrors ui-slots: a fixed-size Box hit area carrying the id + handler
      el: Box({ id: `slot-${name}`, width: 2, height: heightCells ?? 1, onMouseDown }),
      slotId: `slot-${name}`,
      spec: { slotId: `slot-${name}`, name, heightCells: heightCells ?? 1, states, initialState: initialState ?? 0 },
    }),
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
