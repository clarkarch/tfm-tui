import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Box, Text } from "@opentui/core";
import { createTestRenderer, type TestRendererSetup } from "@opentui/core/testing";
import { makeRename, tileLabelFor, uniqueUntitledName, type RenameCtx } from "./ui-rename";

// mkdtemp only creates the last segment — the parent must be a dir that
// exists everywhere (CI runners choke on a hardcoded /tmp/opencode)
const mktmp = (prefix: string): string => mkdtempSync(path.join(os.tmpdir(), prefix));
const dir = mktmp("tfm-rename-");
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("uniqueUntitledName", () => {
  test("base name is free -> returned as-is", () => {
    expect(uniqueUntitledName(dir, "Untitled folder")).toBe("Untitled folder");
  });

  test("collision bumps to 'Untitled folder 2', ' 3'… keeping the space in the stem", () => {
    mkdirSync(path.join(dir, "Untitled folder"));
    expect(uniqueUntitledName(dir, "Untitled folder")).toBe("Untitled folder 2");
    mkdirSync(path.join(dir, "Untitled folder 2"));
    expect(uniqueUntitledName(dir, "Untitled folder")).toBe("Untitled folder 3");
  });

  test("extension split: 'Untitled 2.txt', not 'Untitled.txt 2'", () => {
    writeFileSync(path.join(dir, "Untitled.txt"), "");
    expect(uniqueUntitledName(dir, "Untitled.txt")).toBe("Untitled 2.txt");
    writeFileSync(path.join(dir, "Untitled 2.txt"), "");
    expect(uniqueUntitledName(dir, "Untitled.txt")).toBe("Untitled 3.txt");
  });

  test("dotfile names never split the leading dot", () => {
    writeFileSync(path.join(dir, ".tmp"), "");
    expect(uniqueUntitledName(dir, ".tmp")).toBe(".tmp 2");
  });
});

describe("tileLabelFor", () => {
  test("fits inside maxW-2 untouched", () => {
    expect(tileLabelFor("notes.txt", 20)).toBe("notes.txt");
  });

  test("long names truncate to maxW-5 chars + ellipsis", () => {
    const out = tileLabelFor("a-very-long-filename-indeed.txt", 20);
    expect(out.length).toBe(16); // 15 chars + "…"
    expect(out.endsWith("…")).toBe(true);
  });

  test("boundary: exactly maxW-2 fits, maxW-1 truncates", () => {
    expect(tileLabelFor("x".repeat(18), 20)).toBe("x".repeat(18));
    expect(tileLabelFor("x".repeat(19), 20).length).toBe(16);
  });
});

// --- makeRename under the real renderer: pins the list-row label restore
// position and the single-batch create flow ---

describe("makeRename (renderer)", () => {
  let t: TestRendererSetup;
  let dir: string;
  let calls: string[];
  let ctx: RenameCtx;
  let rename: ReturnType<typeof makeRename>;
  let rowSeq = 0;

  const mountRow = async (key: string): Promise<void> => {
    const id = `tfm-tile-${rowSeq++}`;
    const labelId = `${id}-label`;
    writeFileSync(key, "");
    const row = Box({
      id,
      width: 70,
      height: 2,
      flexDirection: "row",
      alignItems: "center",
      columnGap: 1,
      paddingLeft: 1,
    });
    row.add(Box({ id: `${id}-icon`, width: 3, height: 1 }));
    row.add(Text({ id: labelId, content: path.basename(key) }));
    row.add(Box({ flexGrow: 1 }));
    row.add(Text({ content: "     0 B" }));
    row.add(Text({ content: "2026-09-04 09:00" }));
    t.renderer.root.add(row);
    ctx.tileRefs.set(key, { tileId: id, labelId, baseFg: "#fff" });
    await t.renderOnce();
  };

  beforeAll(async () => {
    t = await createTestRenderer({ width: 80, height: 12 });
    dir = mkdtempSync(path.join(os.tmpdir(), "tfm-rename-widget-"));
    calls = [];

    ctx = {
      renderer: () => t.renderer,
      byId: (id) => t.renderer.root.findDescendantById(id),
      colors: () => defaultTheme,
      tileW: () => 20,
      tileRefs: new Map(),
      stripSelectable: () => {},
      renderAll: () => calls.push("renderAll"),
      renderGrid: () => {
        calls.push("renderGrid");
        return Promise.resolve();
      },
      performRename: (p, name) => {
        calls.push(`rename:${path.basename(p)}->${name}`);
        return Promise.resolve();
      },
      pushUndoBatch: (label, undos, redos) => calls.push(`undo:${label}:${undos.length}:${redos.length}`),
      notify: (msg, title, level) => calls.push(`notify:${title}:${level}:${msg}`),
      isVirtualCwd: () => false,
      inTrashView: () => false,
      cwd: () => dir,
      focusKeys: () => [path.join(dir, "Untitled.txt")],
      selectTileAt: () => true,
    };
    rename = makeRename(ctx);
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
    t.renderer.destroy();
  });

  test("committing a create keeps ONE undo batch and reports Created, not Renamed", async () => {
    calls.length = 0;
    await mountRow(path.join(dir, "Untitled.txt"));
    rename.startInlineCreate("file"); // makes "Untitled 2.txt" (Untitled.txt taken)
    ctx.tileRefs.set(path.join(dir, "Untitled 2.txt"), ctx.tileRefs.get(path.join(dir, "Untitled.txt"))!);
    // the create → renderGrid → rename chain is fire-and-forget: poll for
    // the edit input instead of assuming a tick
    const deadline = Date.now() + 2000;
    while (!t.renderer.root.findDescendantById("tfm-rename-input") && Date.now() < deadline) await Bun.sleep(5);
    await t.renderOnce();
    const input = t.renderer.root.findDescendantById("tfm-rename-input") as any;
    input.value = "notes.txt";
    rename.finishInlineRename(true);
    await Bun.sleep(30);
    await t.renderOnce();
    const undoCalls = calls.filter((c) => c.startsWith("undo:"));
    expect(undoCalls).toEqual(["undo:new file notes.txt:1:1"]); // single batch, final name
    expect(calls).toContain("notify:create:success:Created notes.txt · ctrl+z to undo");
    expect(calls.some((c) => c.startsWith("rename:"))).toBe(false); // no rename detour
    expect(calls).toContain("renderAll");
    // the file landed under the typed name; no placeholder left behind
    expect(existsSync(path.join(dir, "notes.txt"))).toBe(true);
    expect(existsSync(path.join(dir, "Untitled 2.txt"))).toBe(false);
  });

  test("cancelling a rename restores the label at its ORIGINAL row index (not the end)", async () => {
    calls.length = 0;
    const key = path.join(dir, "second.txt");
    await mountRow(key);
    rename.startInlineRename(key);
    await t.renderOnce();
    rename.finishInlineRename(false); // esc/empty: no commit
    await t.renderOnce();
    const row = ctx.byId(ctx.tileRefs.get(key)!.tileId) as any;
    const ids = row.getChildren().map((c: any) => c.id ?? "?");
    expect(ids.indexOf(ctx.tileRefs.get(key)!.labelId)).toBe(1); // after the icon, before spacer/size/date
    expect(ids[ids.length - 1]).not.toBe(ctx.tileRefs.get(key)!.labelId);
  });
});

const defaultTheme = {
  hoverBg: "#000",
  accentBg: "#111",
  white: "#fff",
} as any;
