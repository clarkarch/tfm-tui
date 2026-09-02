// --- Import-graph guard: the src/ module graph must stay ACYCLIC. A cycle —
// even a type-only one (they erase at runtime, so tsc won't complain) — means
// the layering is mushy: shared types belong in a leaf module instead (the
// pattern: src/wiring/types.ts for wiring cluster types, config-schema.ts for
// config value types). Pinned after the wiring split left
// chrome ↔ grid ↔ grid-foundation and style → config → config-schema → style
// type cycles behind. ---
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const SRC_ROOT = resolve(import.meta.dir);

const collectTsFiles = (dir: string): string[] => {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...collectTsFiles(p));
    else if (name.endsWith(".ts")) out.push(p);
  }
  return out;
};

// biome format terminates every import/export statement with ';' — statement
// splitting survives multi-line import lists and ignores relative-looking
// string literals inside function bodies.
const relativeSpecifiersOf = (file: string): string[] => {
  const specs: string[] = [];
  for (const stmt of readFileSync(file, "utf8").split(";")) {
    if (!/^\s*(import|export)\b/.test(stmt)) continue;
    const from = stmt.match(/\bfrom\s+["'](\.[^"']+)["']/);
    if (from) {
      specs.push(from[1]!);
      continue;
    }
    const bare = stmt.match(/^\s*import\s+["'](\.[^"']+)["']/);
    if (bare) specs.push(bare[1]!);
  }
  return specs;
};

const tsFiles = collectTsFiles(SRC_ROOT);

const depsOf = new Map<string, string[]>(
  tsFiles.map((file) => [
    file,
    relativeSpecifiersOf(file)
      .map((spec) => join(dirname(file), `${spec}.ts`))
      .filter((target) => tsFiles.includes(target)),
  ]),
);

const findCycle = (): string[] | null => {
  const done = new Set<string>();
  for (const start of tsFiles) {
    const path: string[] = [];
    const onPath = new Set<string>();
    const visit = (node: string): string[] | null => {
      if (onPath.has(node)) return [...path.slice(path.indexOf(node)), node];
      if (done.has(node)) return null;
      onPath.add(node);
      path.push(node);
      for (const next of depsOf.get(node) ?? []) {
        const cycle = visit(next);
        if (cycle) return cycle;
      }
      path.pop();
      onPath.delete(node);
      done.add(node);
      return null;
    };
    const cycle = visit(start);
    if (cycle) return cycle;
  }
  return null;
};

describe("import graph", () => {
  test("src/ modules have no import cycles (shared types live in leaf modules)", () => {
    const cycle = findCycle();
    const rendered = cycle ? `import cycle: ${cycle.map((f) => relative(SRC_ROOT, f)).join(" -> ")}` : undefined;
    expect(cycle, rendered).toBeNull();
  });
});
