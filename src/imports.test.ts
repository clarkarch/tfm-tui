// --- Import-graph guard: the src/ module graph must stay ACYCLIC. A cycle —
// even a type-only one (they erase at runtime, so tsc won't complain) — means
// the layering is mushy: shared types belong in a leaf module instead (the
// pattern: src/wiring/types.ts for wiring cluster types, config-schema.ts for
// config value types). Pinned after the wiring split left
// chrome ↔ grid ↔ grid-foundation and style → config → config-schema → style
// type cycles behind. ---
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
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
// string literals inside function bodies. Dynamic `import("./x")` calls are
// matched separately (the lazy app graph + plugins-cli route through them).
// Comments are STRIPPED first: a file-header `// ---` block sits in the same
// `;`-chunk as the first import, so the anchor `^\s*(import|export)` failed and
// the edge was silently dropped (21 real edges were invisible to this guard).
export const relativeSpecifiersOf = (file: string): string[] => {
  const content = readFileSync(file, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "");
  const specs: string[] = [];
  for (const stmt of content.split(";")) {
    if (!/^\s*(import|export)\b/.test(stmt)) continue;
    const from = stmt.match(/\bfrom\s+["'](\.[^"']+)["']/);
    if (from) {
      specs.push(from[1]!);
      continue;
    }
    const bare = stmt.match(/^\s*import\s+["'](\.[^"']+)["']/);
    if (bare) specs.push(bare[1]!);
  }
  for (const m of content.matchAll(/import\(["'](\.[^"']+)["']\)/g)) {
    specs.push(m[1]!);
  }
  return specs;
};

const tsFiles = collectTsFiles(SRC_ROOT);

const depsOf = new Map<string, string[]>(
  tsFiles.map((file) => [
    file,
    relativeSpecifiersOf(file)
      // normalize an explicit extension before appending `.ts` (a spec of
      // "./helper.ts" used to become "helper.ts.ts" and vanish)
      .map((spec) => join(dirname(file), `${spec.replace(/\.tsx?$/, "")}.ts`))
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
  test("a header comment before the first import does not hide the edge", () => {
    // regression: splitting on ';' left the comment glued to the first import,
    // so `^\s*(import|export)` never matched and the edge was dropped
    const tmp = join(mkdtempSync(join(os.tmpdir(), "tfm-imports-")), "x.ts");
    writeFileSync(
      tmp,
      [
        "// --- a header block ---",
        "// more header",
        'import { a } from "./alpha";',
        'export { b } from "./beta";',
        `const s = "import fake from './nope'";`,
      ].join("\n"),
    );
    try {
      expect(relativeSpecifiersOf(tmp)).toEqual(["./alpha", "./beta"]);
    } finally {
      rmSync(dirname(tmp), { recursive: true, force: true });
    }
  });

  test("src/ modules have no import cycles (shared types live in leaf modules)", () => {
    const cycle = findCycle();
    const rendered = cycle ? `import cycle: ${cycle.map((f) => relative(SRC_ROOT, f)).join(" -> ")}` : undefined;
    expect(cycle, rendered).toBeNull();
  });
});
