# Performance & Memory Review — tfm-tui

**Date:** 2026-09-26 · **Branch:** `dev` · **Lens:** performance & memory · **Deliverable:** report only (no code changes).

Scope: deep review of the perf/memory-critical core — `fs/`, `app/`, `plugins/`, `dnd/`, `ui/` — with the installer (`install.sh`) sampled. 213 source files, 98 test files.

**Baseline (recorded, not changed):** `bun run check` (biome + `tsc --noEmit`, strict) is clean across 225 files; `bun test` green. `any`/casts/non-null assertions are confined to test files. No shell interpolation exists anywhere (every child is spawned with an argv array).

This review found **no P0** (nothing leaks permanently on an idle TUI — the `Bun.gc(false)` poke every 10 s eventually drains everything). The real risk is **native/JS memory growing faster than the 10 s poke under sustained churn**, which is exactly the documented crash mode in `app/mem-hygiene.ts` ("Failed to create TextBuffer" / floating UI vanishes). Findings are ranked by how easily normal use outpaces that drain.

---

## Summary

| # | Sev | Area | One-line |
|---|-----|------|----------|
| 1 | P1 | `lib/uiutil.ts` + teardown sites | Bulk teardown detaches native renderables **without `destroy()`**; frees fall to GC |
| 2 | P1 | `ui/ui-slots.ts` | Overlapping `drainThumbs` attaches a duplicate image and leaks the first |
| 3 | P1 | `fs/listing.ts` | `fillInto` runs **N synchronous `statSync`** calls on the render path (UI freeze) |
| 4 | P2 | `ui/ui-slots.ts` | `drainIconQueue` re-rasters every slot uncapped and removes old rasters without destroy |
| 5 | P2 | `ui/icons.ts` | `svgSourceMtime()` does a `statSync` before **every** icon cache lookup |
| 6 | P2 | `ui/icons.ts`, `fs/listing.ts` | Caches are capped by **entry count, not bytes** → worst-case footprint unbounded |
| 7 | P2 | `ui/icons.ts` | Icon/thumb disk caches grow without bound (no eviction) |
| 8 | P2 | `ui/ui-preview.ts` | Preview cache replacement drops the previous native node without destroy |
| 9 | P2 | `ui/ui-progress.ts` | Progress spinner interval is cleared only on the normal finish path |

---

## P1-1 — Detach-without-destroy leaks OpenTUI native buffers

**Where:** `src/lib/uiutil.ts:17` (`clearChildren`) and its teardown call sites:
`src/ui/ui-grid.ts:254` (`clearGrid`), `src/ui/ui-grid.ts:845` (`syncWindow` slide),
`src/ui/ui-preview.ts:109`, `src/ui/ui-chrome.ts:256,291`, `src/ui/ui-menu.ts:214`,
`src/ui/ui-settings.ts:427`, `src/ui/ui-pick.ts:108`, `src/ui/ui-term.ts:330`,
`src/ui/ui-toolbar.ts:218,277`, `src/ui/ui-bulk-rename.ts:56`.
Also `src/ui/ui-slots.ts:416` (`drainIconQueue` old-raster removal).

**Mechanism.** `clearChildren` only calls `node.remove(c)` — it never calls `destroy()`:

```ts
export const clearChildren = (node: unknown): void => {
  ...
  const kids = [...node.getChildren()];
  for (const c of kids) { try { node.remove(c); } catch {} }
};
```

OpenTUI renderables (text buffers, images) own **native** memory released by a bun *finalizer*, and bun only runs GC on JS-heap pressure — never on native pressure (this is the stated premise of `app/mem-hygiene.ts`). So every teardown path that removes without destroying defers the native free to the next 10 s `pokeGc`.

The codebase already knows this, which is what makes it inconsistent rather than wrong:
- `drainThumbs` explicitly calls `img.destroy?.()` when the slot is gone (`ui-slots.ts:317` region).
- `ui-preview.ts:81` destroys the cached node explicitly.
- `wiring/io.ts` pokes GC after a hover-drawer settle with the comment *"reclaim the old tiles' native buffers now instead of waiting for the 10s mem-hygiene poke (same mitigation as a theme flip)"*.
- Yet the grid comment at `ui-grid.ts` says *"stop it BEFORE **destroying** them (same use-after-destroy path as clearGrid)"* — while the code calls `clearChildren`, which does not destroy. The comment is aspirational; the nodes are only collectable, not destroyed.

**Impact.** Bulk teardown is the highest-volume allocation churn in the app. A rebuild of a 5 000-file folder, a window drag-resize, or a theme flip detaches thousands of tiles without destroying them. If churn between two 10 s pokes exceeds what one GC sweep reclaims, the native allocator grows monotonically and small native allocations begin to fail — the floating-UI-vanishes crash.

**Fix.** Add a sibling `destroyChildren(node)` that calls `child.destroy?.()` before/after `remove`, and use it on the paths whose removed nodes are *not* going to be re-added: `clearGrid`, the `syncWindow` full rebuild, the icon state re-raster removal (`ui-slots.ts:416`), and the preview replacement. Keep the plain `clearChildren` only where a node is immediately re-added (e.g. the preview cache-hit path re-adds `previewCodeCache.node`).

---

## P1-2 — Rebuild-during-raster leaks the replaced thumbnail image

**Where:** `src/ui/ui-slots.ts`, `drainThumbs` worker (the `ctx.clearChildren(slot); slot.add(img)` pair, `ui-slots.ts:317`).

**Mechanism.** `drainThumbs` is fired fire-and-forget (`void ctx.drainThumbs()` — `ui-grid.ts:693,975`, `ui-preview.ts:215`, `ui-props.ts:358`) and takes a snapshot of `thumbJobs` at entry. A second drain can start while the first is still `await`ing `thumbPng`. Both drains then resolve the *same* `slotId` and each does:

```ts
slot = ctx.byId(j.slotId);
...
ctx.clearChildren(slot);   // detaches (does NOT destroy) the other drain's image
slot.add(img);
```

`thumbPng` dedupes identical keys by returning the same promise, so both workers succeed and both build an `ImageRenderable`. Drain A's image is detached by drain B's `clearChildren` and never destroyed → a native image buffer leak per overlapping job. This is realistic on image-heavy folders with the 200 ms watcher debounce (`fs/watcher.ts`) firing an external-change rebuild mid-raster.

**Fix.** Add a monotonic `thumbGen` token; a drain captures the generation at entry and abandons its jobs when a newer drain has superseded it (or destroys the image it was about to replace). This also removes the redundant re-raster work.

---

## P1-3 — `fillInto` blocks the event loop with synchronous stats

**Where:** `src/fs/listing.ts` — `fillInto()` (called from `loadEntries` on both cache hit and miss when `fillStats` is on), and `statEntries()` for Recent/Starred.

**Mechanism.** `fillInto` loops over every entry calling `statEntry` → `statSync`:

```ts
const fillInto = (entries: Entry[], dir: string): void => {
  for (const e of entries) {
    if (e.size !== undefined && e.mtimeMs !== undefined) continue;
    const got = statEntry(e.abs ?? path.join(dir, e.name)); // statSync
    ...
  }
};
```

The file itself contains the counter-proof: `fillStatsInto` exists specifically because *"the blocking statSync loop it used to run froze the whole app (this render, the frame loop, the toast spinner) for tens to hundreds of ms on a big folder"*. That async, 32-worker version is used by the grid's list view — but `loadEntries` (the listings-cache path, exercised for **every** `renderAll` under size/mtime sort) still calls the synchronous `fillInto`.

**Impact.** P1 UI stall (tens to hundreds of ms) on large directories under `size`/`mtime` sort with `listings-cache-stats` on (default per `config-schema.ts`). Also `statSync(dir)` per `loadEntries` call is a second blocking syscall on the hot path.

**Fix.** Make the cache fill go through `fillStatsInto` (await it inside `loadEntries`), so the stats fill yields between batches exactly like the list-view path. Cache the dir `statSync` result for the TTL window.

---

## P2-1 — `drainIconQueue` re-rasters every slot uncapped, removing old rasters without destroy

**Where:** `src/ui/ui-slots.ts` `drainIconQueue` — `await Promise.all(pending.map(async (spec) => { ... }))`, and the old-raster removal at `ui-slots.ts:416`.

**Mechanism.** Unlike `drainThumbs` (capped at `THUMB_WORKERS = 8`), `drainIconQueue` starts a job for **every** pending spec at once. Only the process-level gate (`RASTER_CONCURRENCY = 12`, `ui/icons.ts`) bounds spawned rasterizers — not the live JS promises, `ImageRenderable` allocations, or native buffers held until the whole `Promise.all` settles. `resetIconQueue()` marks **all** registered specs for re-raster and is invoked on every resize (`wiring/io.ts:272`, debounced 150 ms) and every theme flip (`ui-retheme.ts:311`). Each re-raster removes the previous state rasters via `slot.remove(k)` (`ui-slots.ts:416`) **without** `destroy()` (P1-1).

**Impact.** A window drag-resize re-rasterizes chrome + visible tiles repeatedly; each pass detaches the previous rasters un-destroyed. On large grids this is both a compute spike and a native-buffer leak, the same failure class as P1-1.

**Fix.** Apply the `drainThumbs` worker pattern (bounded concurrency) to `drainIconQueue`, and destroy the removed `-s*` rasters.

---

## P2-2 — `svgSourceMtime()` stats the asset before every icon cache lookup

**Where:** `src/ui/icons.ts` — `iconPng`:

```ts
const key = iconCacheKey(name, fg, bg, pxW, pxH, svgSourceMtime(name), transparent);
const hit = lruGet(iconCache, key);
```

`svgSourceMtime` is a `statSync` on the asset path, computed *before* the in-memory lookup, so **every** icon request performs a synchronous filesystem stat even on a memory hit — once per state per slot per drain/rebuild.

**Impact.** Hundreds of blocking `statSync` calls per rebuild. Stat is OS-cached so each is cheap, but it is still a syscall on the hot render path, and it exists only to invalidate on asset edits (which are impossible in the shipped `--compile` binary, where assets are embedded and fixed at build time).

**Fix.** Memoize the mtime per icon name for the process lifetime (assets are immutable at runtime), or only stat in dev (`Bun.embeddedFiles.length === 0`).

---

## P2-3 — Caches are capped by entry count, not bytes

**Where:** `src/ui/icons.ts` (`THUMB_CACHE_MAX = 200`, resolved `Uint8Array` PNGs) and `src/fs/listing.ts` (`LISTINGS_CAP = 64`).

**Mechanism.** `thumbCache` holds up to 200 **resolved** thumbnails; thumb pixel dimensions are `cells × cellW/pxH` with a 2 px inset (`drainIconQueue`), so bytes-per-entry scales with terminal size and zoom level, not a constant. `listings` holds up to 64 directories' full entry arrays, and `loadEntries` additionally **clones** every entry per call (`entries.map((e) => ({ ...e }))`) for cache safety — a 10 000-entry directory means 10 000 object allocations per `listDir`, on top of the retained cache copy.

**Impact.** Worst-case retained bytes are unbounded by the caps: 64 large dirs × entries (~100 B each) plus 200 large thumbnails can reach tens to hundreds of MB, and the per-read cloning adds steady GC pressure. Nothing here is a permanent leak, but the ceilings are much higher than the small numbers suggest.

**Fix.** Budget the LRUs by bytes (accumulate `byteLength`/entry count and evict to a target) rather than by entry count. For listings, consider returning shared immutable entries plus a per-call sort view instead of a deep-ish clone of every entry.

---

## P2-4 — Disk caches grow without bound

**Where:** `src/ui/icons.ts` — `iconDiskDir()` and `thumbDiskDir()` (`~/.cache/tfm/icons`, `~/.cache/tfm/thumbs`), documented as "unbounded on purpose".

**Mechanism.** Keys include path, mtime, size, pixel size, **bg**, and mode, so theme flips and resizes mint new keys; nothing ever evicts. Over a long session browsing images and switching themes, both directories grow without limit.

**Impact.** Disk, not RAM, but a real resource leak with no user-visible cap or cleanup.

**Fix.** Cap total directory size and sweep oldest entries on write (or on boot); expose a "clear caches" action.

---

## P2-5 — Preview cache replacement drops the previous node without destroy

**Where:** `src/ui/ui-preview.ts` — `renderPreviewNow`: `clearChildren(pane)` at entry, then on a key/mtime/size mismatch a new `node` is built and `previewCodeCache = { ..., node }`.

**Mechanism.** `clearChildren(pane)` detaches the previously cached node (still referenced by `previewCodeCache`) but does not destroy it. When a *different* file is previewed, `previewCodeCache` is reassigned, the old node becomes unreferenced garbage, and its native `TextBuffer`/`CodeRenderable` buffer is freed only by the next GC poke. Only the theme-signature path (`ui-preview.ts:81`) explicitly destroys.

**Impact.** One native text/code buffer retained per distinct previewed file until the next poke — and preview navigates rapidly (arrow keys), which is precisely why the 60 ms debounce exists.

**Fix.** Destroy `previewCodeCache.node` when replacing it on a key mismatch (mirroring the theme-signature path).

---

## P2-6 — Progress spinner interval only cleared on the normal finish path

**Where:** `src/ui/ui-progress.ts:243` — `progSpinTimer = setInterval(() => { ... paintProgress(true); }, 100)`. The only `clearInterval` is at `ui-progress.ts:255`, inside `finishProgressToast`.

**Mechanism.** Any close path that does not run `finishProgressToast` (toast replaced/closed elsewhere, restart teardown, an operation superseded by a new one) leaves a live 100 ms interval repainting a detached node indefinitely.

**Impact.** A leaked timer plus repeated writes to a dead renderable; grows with every abandoned progress toast in a session.

**Fix.** Clear `progSpinTimer` in the toast's close/dispose path as well, not only in `finishProgressToast`.

---

## Watch list (unproven / lower confidence)

- **`clearIconCaches` does not clear `inflightIcons`** (`ui/icons.ts`): an in-flight old-theme render resolves after the clear and re-inserts an old-theme entry. Bounded and key-correct, but retains extra entries and delays the theme swap's memory benefit.
- **`startMemHygiene`'s returned stop is discarded** (`wiring/io.ts`): the interval is `unref`'d and process-lifetime, which is fine today, but it is not teardownable if boot ever re-runs.
- **`statEntries` sync loop for Recent/Starred** (`fs/listing.ts`): a `statSync` per item; Recent lists can be long.
- **`thumbCooloffMs` sleeps a worker** for up to 3 s (`ui-slots.ts`): with only 8 workers, a freshly-extracted folder can park several workers; documented and self-healing, but worth watching if a lower worker count is ever considered.
- **`lib/op-queue.ts`**: examined — the `tail` chain replaces its reference each enqueue and `active` is decremented on both settle paths, so settled closures are not retained. No finding.

---

## Recommended fixes, in order

1. Introduce `destroyChildren` and destroy on the non-re-add teardown paths (grid clear/rebuild, icon re-rasters, preview replacement) — closes P1-1, P2-1 (partly), P2-5.
2. Add a drain generation guard to `drainThumbs` — closes P1-2.
3. Route the listings-cache stats fill through the async `fillStatsInto` — closes P1-3.
4. Cap `drainIconQueue` concurrency like `drainThumbs` — closes P2-1.
5. Memoize `svgSourceMtime` for the process — closes P2-2.
6. Byte-budget the icon/thumb/listing LRUs and add disk-cache eviction — closes P2-3, P2-4.
7. Clear `progSpinTimer` on every close path — closes P2-6.

## Fixes applied (follow-up, same date)

The three P1s and the directly-coupled P2s were fixed after the review:

- **P1-1** — added `destroyChildren` (`lib/uiutil.ts`) and switched the non-re-add teardown paths to it: grid `clearGrid` / `syncWindow` (including the windowed-slide row recycle), `drainThumbs` slot replacement, and the icon re-raster removal (`ui-slots.ts`); plus the menu and chrome rebuild paths.
- **P1-2** — added `thumbGen` / `iconGen` supersession tokens so an overlapping drain abandons its job (destroying what it built) instead of detaching the winner's image.
- **P1-3** — `loadEntries` now `await`s the async `fillStatsInto` (moved above it) instead of the blocking `fillInto`, which was deleted.
- **P2-1** — `drainIconQueue` now runs a bounded `ICON_WORKERS = 8` pool like `drainThumbs`.
- **P2-5** — the preview pane uses `destroyChildren(pane, previewCodeCache?.node)` and destroys the old cached node on a key-mismatch replacement.
- **P2-6** — `showProgressToast` clears a lingering `progSpinTimer` before showing a new toast.

Still open (not in this pass): P2-2 (`svgSourceMtime` memoization), P2-3/P2-4 (byte-budgeted LRUs and disk-cache eviction).

## Verification

Baseline before the fixes: `bun run check` clean (225 files), `bun test` 1633 pass / 1 skip / 0 fail.
After the fixes: `bun run check` clean, `bun test` **1636 pass / 1 skip / 0 fail** (3 new `destroyChildren` tests).
