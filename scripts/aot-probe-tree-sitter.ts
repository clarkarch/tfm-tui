// Asks a compiled tfm whether OpenTUI's tree-sitter worker starts.
//
//   bun scripts/aot-probe-tree-sitter.ts <variant> [outfile]
//
// The variants are the ones scripts/aot-build.ts knows: jit, aot, aot-disk, …
//
// tfm's preview pane highlights code with OpenTUI's CodeRenderable, and
// OpenTUI parses in a Worker. The worker is EMBEDDED in the package:
//
//   await import("./parser.worker.js", { with: { type: "file" } })
//
// (opentui-fork packages/core/src/lib/tree-sitter/client.ts, and the
// published dist/chunk-bun-*.js) — the executable carries the file and the
// Worker is started from its path inside the executable. That is the case
// the docs call a landmine.
//
// The probe asks the REAL client (opentui's getTreeSitterClient, the same
// singleton the preview pane uses) to initialize, and reports what
// happened. OpenTUI's client gives up after 10 seconds
// (initTimeout ?? 10000 in client.ts), so the probe waits a little longer
// than that: the answer must be the client's own, not the probe's timeout.

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

type CompileOptions = Exclude<Parameters<typeof Bun.build>[0]["compile"], boolean | string> & {
  aot?: boolean;
  allowCodeFromDisk?: boolean;
};

type Variant = { aot: boolean; allowCodeFromDisk: boolean; trim: boolean };

const VARIANTS: Record<string, Variant> = {
  jit: { aot: false, allowCodeFromDisk: false, trim: false },
  aot: { aot: true, allowCodeFromDisk: false, trim: false },
  "aot-trim": { aot: true, allowCodeFromDisk: false, trim: true },
  "aot-disk": { aot: true, allowCodeFromDisk: true, trim: false },
  "aot-disk-trim": { aot: true, allowCodeFromDisk: true, trim: true },
};

const root = path.resolve(import.meta.dir, "..");
const variantName = process.argv[2] ?? "jit";
const variant = VARIANTS[variantName];
if (!variant) {
  console.error(`unknown variant ${JSON.stringify(variantName)}`);
  console.error(`known variants: ${Object.keys(VARIANTS).join(", ")}`);
  process.exit(2);
}
const outfile = path.resolve(root, process.argv[3] ?? `dist/probe/probe-tree-sitter-${variantName}`);
const probeDir = path.join(root, "dist", "probe");
mkdirSync(probeDir, { recursive: true });

const entry = path.join(probeDir, "probe-tree-sitter-entry.ts");
writeFileSync(
  entry,
  `import * as opentui from "@opentui/core";

const getTreeSitterClient = (opentui as unknown as {
  getTreeSitterClient?: () => {
    initialize(): Promise<void>;
    highlightOnce(
      content: string,
      filetype: string,
    ): Promise<{ highlights?: unknown[]; warning?: string; error?: string }>;
    isInitialized(): boolean;
    destroy(): Promise<void>;
  };
}).getTreeSitterClient;

if (typeof getTreeSitterClient !== "function") {
  console.log("tree-sitter client: FAILED — @opentui/core does not export getTreeSitterClient");
  process.exit(1);
}

const client = getTreeSitterClient();
const started = Date.now();
try {
  // opentui's own init timeout is 10s; wait longer so the answer is the
  // client's, not the probe's
  await client.initialize();
  console.log(\`tree-sitter client: ok (initialized in \${Date.now() - started}ms)\`);
} catch (err) {
  console.log(\`tree-sitter client: FAILED — \${String((err as Error)?.message ?? err).slice(0, 200)}\`);
  process.exit(1);
}

// the PREVIEW's question: does it actually highlight? an initialized client
// whose worker cannot parse is not a preview.
try {
  const result = await client.highlightOnce("const x = 1;\\nfunction f() { return x; }\\n", "typescript");
  if (result.error) {
    console.log(\`tree-sitter highlight: FAILED — \${result.error.slice(0, 200)}\`);
    process.exit(1);
  }
  const count = result.highlights?.length ?? 0;
  console.log(\`tree-sitter highlight: ok (\${count} highlight ranges)\`);
  if (count === 0) {
    console.log("tree-sitter highlight: FAILED — no highlight ranges at all");
    process.exit(1);
  }
} catch (err) {
  console.log(\`tree-sitter highlight: FAILED — \${String((err as Error)?.message ?? err).slice(0, 200)}\`);
  process.exit(1);
}
await client.destroy();

`,
);

const result = await Bun.build({
  entrypoints: [entry],
  loader: { ".svg": "file" },
  tsconfig: path.join(root, "tsconfig.json"),
  compile: {
    outfile,
    aot: variant.aot,
    ...(variant.allowCodeFromDisk ? { allowCodeFromDisk: true } : {}),
  } as CompileOptions,
});

if (!result.success) {
  for (const log of result.logs) console.error(String(log));
  console.error(`the ${variantName} tree-sitter probe failed to build`);
  process.exit(1);
}
for (const log of result.logs) console.error(String(log));

const probe = Bun.spawn([outfile], { stdout: "pipe", stderr: "pipe" });
const [stdout, stderr, code] = await Promise.all([
  new Response(probe.stdout).text(),
  new Response(probe.stderr).text(),
  probe.exited,
]);
if (stderr) console.error(stderr.trim());
if (stdout) console.log(stdout.trim());
process.exit(code);
