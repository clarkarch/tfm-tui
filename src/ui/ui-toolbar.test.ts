import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { isNavigableTarget } from "./ui-toolbar";
import { RECENT_URI } from "../fs/uri";

describe("isNavigableTarget", () => {
  test("real dirs pass, files and missing paths fail", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "tfm-toolbar-"));
    try {
      const file = path.join(dir, "f.txt");
      writeFileSync(file, "x");
      expect(isNavigableTarget(dir)).toBe(true);
      expect(isNavigableTarget(file)).toBe(false);
      expect(isNavigableTarget(path.join(dir, "nope"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("virtual places always navigate", () => {
    expect(isNavigableTarget(RECENT_URI)).toBe(true);
  });
});
