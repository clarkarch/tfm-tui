#!/usr/bin/env bun
// --- Frame-cost benchmark: what does an OpenTUI frame cost, and does it fit 60fps?
//
// A 60fps budget is 16.67ms per frame. This measures the COST of a frame (not
// the pacing) for a tfm-shaped scene: a toolbar, a sidebar, and a grid of
// tiles, at 200x50.
//
//   cursor   ONE tile changes per frame (selection move) — the common
//            interaction. This is what tfm does per keystroke/click.
//   fade     EVERY tile changes per frame (a per-tile opacity cascade) — the
//            heavy animation path.
//   rebuild  The grid is destroyed and rebuilt every frame — what an
//            "immediate mode" app layer would cost on top of the renderer.
//   full     Like `cursor`, but the native renderer is forced onto its full
//            repaint path every frame (OT_SCENE_DEBUG_FULL_FRAME) — the cost
//            of redrawing the whole screen instead of the damaged rows.
//
// The renderer runs headless (createTestRenderer), so these numbers are the
// LAYOUT + PAINT + ENCODE cost. They exclude writing bytes to a real
// terminal, which both OpenTUI and ratatui diff down to changed cells.
//
// Usage: bun scripts/bench-render-60fps.ts [--frames 200]

import { BoxRenderable, type CliRenderer, TextRenderable } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";

const WIDTH = 200;
const HEIGHT = 50;
const TILE_W = 14;
const TILE_H = 4;
const SIDEBAR_W = 22;
const TOOLBAR_H = 1;
const SIDEBAR_ROWS = 20;

const FRAMES = Number(process.env.FRAMES ?? 200);
const WARMUP = 20;

const BUDGET_MS = 1000 / 60;

type Tile = {
  box: BoxRenderable;
  label: TextRenderable;
  icon: BoxRenderable;
};

type Scene = {
  root: BoxRenderable;
  grid: BoxRenderable;
  tiles: Tile[];
  rows: BoxRenderable[];
};

const gridCols = Math.floor((WIDTH - SIDEBAR_W) / TILE_W);
const gridRows = Math.floor((HEIGHT - TOOLBAR_H) / TILE_H);
const TILE_COUNT = gridCols * gridRows;

const buildScene = (renderer: CliRenderer): Scene => {
  const root = new BoxRenderable(renderer, { width: WIDTH, height: HEIGHT, flexDirection: "column" });
  renderer.root.add(root);

  const toolbar = new BoxRenderable(renderer, { width: WIDTH, height: TOOLBAR_H });
  toolbar.add(new TextRenderable(renderer, { content: "/home/clark/projects/tfm" }));
  root.add(toolbar);

  const body = new BoxRenderable(renderer, {
    width: WIDTH,
    height: HEIGHT - TOOLBAR_H,
    flexDirection: "row",
  });
  root.add(body);

  const sidebar = new BoxRenderable(renderer, {
    width: SIDEBAR_W,
    height: HEIGHT - TOOLBAR_H,
    flexDirection: "column",
  });
  body.add(sidebar);
  for (let i = 0; i < SIDEBAR_ROWS; i++) {
    sidebar.add(new TextRenderable(renderer, { content: `Place ${i}` }));
  }

  const grid = new BoxRenderable(renderer, {
    width: WIDTH - SIDEBAR_W,
    height: HEIGHT - TOOLBAR_H,
    flexDirection: "column",
  });
  body.add(grid);

  const rows: BoxRenderable[] = [];
  const tiles: Tile[] = [];
  for (let r = 0; r < gridRows; r++) {
    const row = new BoxRenderable(renderer, { width: WIDTH - SIDEBAR_W, height: TILE_H, flexDirection: "row" });
    grid.add(row);
    rows.push(row);
    for (let c = 0; c < gridCols; c++) {
      const i = r * gridCols + c;
      const box = new BoxRenderable(renderer, {
        width: TILE_W,
        height: TILE_H,
        flexDirection: "column",
        backgroundColor: "#1c1c1c",
      });
      const icon = new BoxRenderable(renderer, { width: 2, height: 2, marginLeft: 1 });
      const label = new TextRenderable(renderer, { content: `file-${i}.txt` });
      box.add(icon);
      box.add(label);
      row.add(box);
      tiles.push({ box, label, icon });
    }
  }

  return { root, grid, tiles, rows };
};

const destroyGrid = (scene: Scene): void => {
  for (const row of scene.rows) {
    for (const child of [...row.getChildren()]) {
      row.remove(child);
      child.destroy();
    }
    scene.grid.remove(row);
    row.destroy();
  }
  scene.rows.length = 0;
  scene.tiles.length = 0;
};

const rebuildGrid = (scene: Scene, renderer: CliRenderer): void => {
  destroyGrid(scene);
  for (let r = 0; r < gridRows; r++) {
    const row = new BoxRenderable(renderer, { width: WIDTH - SIDEBAR_W, height: TILE_H, flexDirection: "row" });
    scene.grid.add(row);
    scene.rows.push(row);
    for (let c = 0; c < gridCols; c++) {
      const i = r * gridCols + c;
      const box = new BoxRenderable(renderer, {
        width: TILE_W,
        height: TILE_H,
        flexDirection: "column",
        backgroundColor: "#1c1c1c",
      });
      const icon = new BoxRenderable(renderer, { width: 2, height: 2, marginLeft: 1 });
      const label = new TextRenderable(renderer, { content: `file-${i}.txt` });
      box.add(icon);
      box.add(label);
      row.add(box);
      scene.tiles.push({ box, label, icon });
    }
  }
};

type Variant = {
  name: string;
  fullFrame?: boolean;
  mutate: (scene: Scene, renderer: CliRenderer, frame: number) => void;
};

const variants: Variant[] = [
  {
    name: "opentui/baseline (no change)",
    mutate: () => {},
  },
  {
    name: "opentui/retained/cursor",
    mutate: (scene, _renderer, frame) => {
      const prev = scene.tiles[frame % scene.tiles.length];
      const next = scene.tiles[(frame + 1) % scene.tiles.length];
      if (prev) prev.box.backgroundColor = "#1c1c1c";
      if (next) next.box.backgroundColor = "#3a5fcd";
    },
  },
  {
    // Same work, but a forced GC before every frame: if the tail collapses,
    // the spikes are the JS heap collector, not the renderer.
    name: "opentui/retained/cursor (gc each frame)",
    mutate: (scene, _renderer, frame) => {
      const prev = scene.tiles[frame % scene.tiles.length];
      const next = scene.tiles[(frame + 1) % scene.tiles.length];
      if (prev) prev.box.backgroundColor = "#1c1c1c";
      if (next) next.box.backgroundColor = "#3a5fcd";
      Bun.gc(false);
    },
  },
  {
    name: "opentui/retained/fade",
    mutate: (scene, _renderer, frame) => {
      const phase = (frame % 60) / 60;
      for (let i = 0; i < scene.tiles.length; i++) {
        const t = (i / scene.tiles.length + phase) % 1;
        const tile = scene.tiles[i];
        if (tile) tile.box.opacity = 0.2 + 0.8 * t;
      }
    },
  },
  {
    name: "opentui/rebuild/grid",
    mutate: (scene, renderer) => {
      rebuildGrid(scene, renderer);
    },
  },
  {
    name: "opentui/retained/cursor (full-frame native)",
    fullFrame: true,
    mutate: (scene, _renderer, frame) => {
      const prev = scene.tiles[frame % scene.tiles.length];
      const next = scene.tiles[(frame + 1) % scene.tiles.length];
      if (prev) prev.box.backgroundColor = "#1c1c1c";
      if (next) next.box.backgroundColor = "#3a5fcd";
    },
  },
];

const pct = (sorted: number[], p: number): number =>
  sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] ?? 0;

const report = (name: string, samples: number[]): void => {
  const sorted = [...samples].sort((a, b) => a - b);
  const p50 = pct(sorted, 50);
  const p95 = pct(sorted, 95);
  const p99 = pct(sorted, 99);
  const max = sorted[sorted.length - 1] ?? 0;
  const fps = p50 > 0 ? 1000 / p50 : 0;
  const verdict = p95 <= BUDGET_MS ? "OK" : p50 <= BUDGET_MS ? "TIGHT" : "OVER";
  process.stdout.write(
    `${name.padEnd(38)} p50=${p50.toFixed(2)}ms p95=${p95.toFixed(2)}ms p99=${p99.toFixed(2)}ms max=${max.toFixed(2)}ms ` +
      `fps@60budget=${fps.toFixed(0)} ${verdict}\n`,
  );
};

const run = async (variant: Variant): Promise<void> => {
  const t = await createTestRenderer({
    width: WIDTH,
    height: HEIGHT,
    nativeSceneVerify: false,
    nativeSceneFullFrame: variant.fullFrame ?? false,
  });
  const scene = buildScene(t.renderer);
  await t.renderOnce();

  for (let i = 0; i < WARMUP; i++) {
    variant.mutate(scene, t.renderer, i);
    await t.renderOnce();
  }

  const samples: number[] = [];
  for (let i = 0; i < FRAMES; i++) {
    variant.mutate(scene, t.renderer, i);
    const start = performance.now();
    await t.renderOnce();
    samples.push(performance.now() - start);
  }

  await t.dispose();
  report(variant.name, samples);
};

process.stdout.write(
  `OpenTUI frame cost — ${WIDTH}x${HEIGHT}, ${TILE_COUNT} tiles (${gridCols}x${gridRows}) + ${SIDEBAR_ROWS} sidebar rows\n` +
    `budget @60fps = ${BUDGET_MS.toFixed(2)}ms/frame, ${FRAMES} frames after ${WARMUP} warmup\n\n`,
);

for (const variant of variants) {
  await run(variant);
}
