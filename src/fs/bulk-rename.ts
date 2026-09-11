// --- Bulk rename planner: the type-one-name modal's pure core. The typed
// stem is applied to every selected item, numbered in selection order, with
// each file's own extension preserved. Pure + fs-free (exists injected).
//
// Style picks the number shape: "plain" (1), "pad" (01, width of the count)
// or "paren" ((1)). Swaps/chains are rejected (a generated name equal to
// another selected item's current name) so apply and undo stay single-phase
// and the persisted undo journal replays plain rename/rename-if steps. ---

import { existsSync } from "node:fs";
import path from "node:path";
import { splitStemExt } from "./fsutil";

export type BulkRenameItem = { path: string };
export type BulkRenamePair = { from: string; to: string };
export type BulkRenameStyle = "plain" | "pad" | "paren";
export type BulkRenamePlan = { ok: true; pairs: BulkRenamePair[] } | { ok: false; error: string };

const numberFor = (i: number, total: number, style: BulkRenameStyle): string => {
  const n = i + 1;
  // min 2 so the "01" style is visible below ten items; wider counts widen it
  if (style === "pad") return String(n).padStart(Math.max(2, String(total).length), "0");
  if (style === "paren") return `(${n})`;
  return String(n);
};

export const bulkRenameNames = (items: BulkRenameItem[], stem: string, style: BulkRenameStyle): string[] => {
  const base = stem.trim();
  return items.map((it, i) => {
    const { ext } = splitStemExt(path.basename(it.path));
    return `${base} ${numberFor(i, items.length, style)}${ext}`;
  });
};

export const planBulkRename = (
  items: BulkRenameItem[],
  stem: string,
  style: BulkRenameStyle,
  exists: (p: string) => boolean = existsSync,
): BulkRenamePlan => {
  const base = stem.trim();
  if (!base) return { ok: false, error: "Name can't be empty" };
  if (base === "." || base === "..") return { ok: false, error: `Invalid name: ${base}` };
  if (base.includes("/") || base.includes("\0")) return { ok: false, error: `Invalid name: ${base}` };
  const names = bulkRenameNames(items, base, style);
  // current basenames of the whole selection: a generated name landing on one
  // of them would clobber a sibling mid-batch (swap/chain) — reject up front
  const origins = new Set(items.map((it) => path.basename(it.path)));
  const seen = new Set<string>();
  const pairs: BulkRenamePair[] = [];
  for (let i = 0; i < items.length; i++) {
    const from = items[i]!.path;
    const name = names[i]!;
    if (name === path.basename(from)) continue;
    if (seen.has(name)) return { ok: false, error: `Duplicate name: ${name}` };
    seen.add(name);
    if (origins.has(name)) return { ok: false, error: `${name} collides with another selected item` };
    const to = path.join(path.dirname(from), name);
    if (exists(to)) return { ok: false, error: `Already exists: ${name}` };
    pairs.push({ from, to });
  }
  return { ok: true, pairs };
};
