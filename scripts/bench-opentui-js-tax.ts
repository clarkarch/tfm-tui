#!/usr/bin/env bun
// --- The JS tax on an OpenTUI frame.
//
// The fork's native bench (packages/native/src/bench/scene-frame_bench.zig)
// measures the SAME scene in pure Zig: layout + paint + encode + present, with
// no JS in the loop. This script builds that scene through the JS layer
// (renderable objects, setter staging, flush, hooks) and measures the same
// frame kinds, so the difference between the two is what the JS binding costs.
//
// The scene mirrors buildUi() exactly — 87 nodes:
//   root, header box + text, body box, 40 row boxes each with a 70-column
//   text, footer box + "> prompt" + a one-cell spinner target.
//
// Frame kinds mirror the native bench's Change enum:
//   unchanged   nothing changes
//   glyph       the target's text flips "/" <-> "|"
//   background  the target's background color changes
//
// Usage: bun scripts/bench-opentui-js-tax.ts [--frames 200]

import { BoxRenderable, type CliRenderer, TextRenderable } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";

const WIDTH = 200;
const HEIGHT = 50;
const FRAMES = Number(process.env.FRAMES ?? 200);
const WARMUP = 20;
const BUDGET_MS = 1000 / 60;

type Target = { spinner: TextRenderable; footer: BoxRenderable };

const buildUi = (renderer: CliRenderer): Target => {
  const root = new BoxRenderable(renderer, { width: WIDTH, height: HEIGHT, flexDirection: "column" });
  renderer.root.add(root);

  const header = new BoxRenderable(renderer, { width: WIDTH, height: 1, backgroundColor: "#1e1e3c" });
  header.add(new TextRenderable(renderer, { content: "session: native scene frame bench" }));
  root.add(header);

  const body = new BoxRenderable(renderer, { flexGrow: 1, flexDirection: "column" });
  root.add(body);
  for (let i = 0; i < 40; i++) {
    const row = new BoxRenderable(renderer, { flexDirection: "column" });
    row.add(new TextRenderable(renderer, { content: "a".repeat(70) }));
    body.add(row);
  }

  const footer = new BoxRenderable(renderer, {
    width: WIDTH,
    height: 3,
    flexDirection: "row",
    backgroundColor: "#141414",
    border: true,
  });
  footer.add(new TextRenderable(renderer, { content: "> prompt" }));
  const spinner = new TextRenderable(renderer, { content: "|" });
  footer.add(spinner);
  root.add(footer);

  return { spinner, footer };
};

type Kind = "unchanged" | "glyph" | "background";

const mutate = (target: Target, kind: Kind, frame: number): void => {
  const odd = frame % 2 === 1;
  if (kind === "glyph") target.spinner.content = odd ? "/" : "|";
  // a TextRenderable has no backgroundColor — its own cell background is `bg`
  if (kind === "background") target.spinner.bg = odd ? "#640000" : "#c80000";
};

const pct = (sorted: number[], p: number): number =>
  sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] ?? 0;

const run = async (kind: Kind): Promise<void> => {
  const t = await createTestRenderer({ width: WIDTH, height: HEIGHT, nativeSceneVerify: false });
  const target = buildUi(t.renderer);
  await t.renderOnce();

  for (let i = 0; i < WARMUP; i++) {
    mutate(target, kind, i);
    await t.renderOnce();
  }

  const samples: number[] = [];
  for (let i = 0; i < FRAMES; i++) {
    mutate(target, kind, i);
    const start = performance.now();
    await t.renderOnce();
    samples.push(performance.now() - start);
  }
  await t.dispose();

  const sorted = [...samples].sort((a, b) => a - b);
  const p50 = pct(sorted, 50);
  const p95 = pct(sorted, 95);
  const max = sorted[sorted.length - 1] ?? 0;
  process.stdout.write(
    `opentui-js/ui-90 ${kind.padEnd(11)} p50=${p50.toFixed(3)}ms p95=${p95.toFixed(3)}ms max=${max.toFixed(3)}ms ` +
      `fps@60budget=${(1000 / Math.max(p50, 0.001)).toFixed(0)}\n`,
  );
};

process.stdout.write(
  `OpenTUI through the JS layer — scene ui-90 (87 nodes), ${WIDTH}x${HEIGHT}\n` +
    `budget @60fps = ${BUDGET_MS.toFixed(2)}ms/frame\n\n`,
);

for (const kind of ["unchanged", "glyph", "background"] as const) {
  await run(kind);
}
