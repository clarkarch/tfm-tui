import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Entry } from "../fs/listing";
import { thumbPlanFor } from "./ui-grid-rows";

// The listings cache hands out stats that may LAG a live edit (an in-place
// edit moves no dir mtime → the cache's signature cannot see it). The raster
// key is built from size+mtime, so a stale stat would hit the OLD thumbnail
// in the disk cache → a stale picture. The plan must not trust a stat that
// says it is stale.
describe("thumbPlanFor", () => {
  test("a STALE stat never keys the raster (the file is re-stat'ed instead)", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "tfm-thumbplan-"));
    try {
      const f = path.join(dir, "a.jpg");
      writeFileSync(f, "x".repeat(900));
      const stale: Entry = { name: "a.jpg", isDir: false, size: 500, mtimeMs: 1, statsState: "stale-stats" };
      const plan = thumbPlanFor(stale, f);
      expect(plan.useThumb).toBe(true);
      expect(plan.stat?.size).toBe(900); // the LIVE size, not the cached one
      const fresh: Entry = { ...stale, statsState: "fresh" };
      expect(thumbPlanFor(fresh, f).stat?.size).toBe(500); // a fresh stat is reused
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
