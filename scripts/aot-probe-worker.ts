// Asks a compiled tfm what kinds of Worker it can start.
//
//   bun scripts/aot-probe-worker.ts <variant> [outfile]
//
// The variants are the ones scripts/aot-build.ts knows: jit, aot, aot-disk, …
//
// Bun's AOT compiler TRACKS the code a Worker runs: "code that the program
// starts a Worker with: a file that it embeds with the `file` loader, a
// file that it names by a path, or a text that it holds"
// (src/aot/load/worker_files.rs:34). The shapes it can follow are listed
// at worker_files.rs:267 — `import path from "./worker.js" with { type:
// "file" }; new Worker(path)`, `new Worker("./worker.js")` and
// `new Worker("data:text/javascript,..")` — plus the dynamic form
// `(await import("./worker.js", { with: { type: "file" } })).default`
// (worker_files.rs:1125). A Worker whose code the compiler cannot see is
// not registered, and the runtime then refuses to run it.
//
// The matrix:
//
//   worker-static-file   a file embedded with the import attribute
//                        `with { type: "file" }` — the shape opentui's
//                        tree-sitter worker has
//   worker-dynamic-file  the same file, reached through the dynamic import
//   worker-entry         a file that is an ENTRY POINT of the build, named
//                        by a literal relative path
//   worker-named         a file on disk that the build has never seen, named
//                        by a path the program computes (needs
//                        --aot-allow-code-from-disk)
//   worker-blob          a Blob URL
//   worker-data          a data: URL
//
// Every check prints one line: "<name>: ok" or "<name>: FAILED — <reason>".

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
const outfile = path.resolve(root, process.argv[3] ?? `dist/probe/probe-worker-${variantName}`);
const probeDir = path.join(root, "dist", "probe");
mkdirSync(probeDir, { recursive: true });

// the program's own path is asked at run time (the entry point's directory),
// so the fixture next to it can be named without the compiler folding it
const entry = path.join(probeDir, "probe-worker-program.ts");
writeFileSync(
  entry,
  `import workerPath from "./probe-worker-file.js" with { type: "file" };
import { tmpdir } from "node:os";
import { unlinkSync } from "node:fs";

const check = async (name: string, fn: () => Promise<string>) => {
  try {
    const detail = await fn();
    console.log(\`\${name}: ok\${detail ? \` (\${detail})\` : ""}\`);
  } catch (err) {
    console.log(\`\${name}: FAILED — \${String((err as Error)?.message ?? err).slice(0, 160)}\`);
  }
};

const ask = async (worker: Worker, label: string): Promise<string> => {
  const reply = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("no answer in 20s")), 20000);
    worker.onmessage = (event: MessageEvent) => { clearTimeout(timer); resolve(String(event.data)); };
    worker.onerror = (event: ErrorEvent) => { clearTimeout(timer); reject(new Error(event.message ?? "worker error")); };
    worker.postMessage("ping");
  });
  await worker.terminate();
  if (!reply.includes("worker-ok")) throw new Error(\`got \${JSON.stringify(reply)}\`);
  return label;
};

// 1. the shape opentui's tree-sitter worker has: a static import with the
//    "file" attribute — its default export is the path of the copy of the
//    file inside the executable
await check("worker-static-file", async () => {
  return ask(new Worker(workerPath), "static file import");
});

// 2. the dynamic form of the same thing
await check("worker-dynamic-file", async () => {
  const mod = (await import("./probe-worker-file.js", { with: { type: "file" } })) as { default: string };
  return ask(new Worker(mod.default), "dynamic file import");
});

// 3. a file that is an ENTRY POINT of the build, named by a literal
//    relative path — bun's docs: "only an entry point of the build can run
//    as a worker"
await check("worker-entry", async () => {
  return ask(new Worker("./probe-worker-entry.js"), "entry point");
});

// 4. a file on disk the build has never seen, named by a computed path
await check("worker-named", async () => {
  const file = \`\${tmpdir()}/probe-worker-on-disk-\${process.pid}-\${Date.now()}.js\`;
  await Bun.write(file, 'self.onmessage = () => { self.postMessage("worker-ok"); };');
  try {
    return await ask(new Worker(file), "named path");
  } finally {
    try { unlinkSync(file); } catch {}
  }
});

// 5. a Blob URL
await check("worker-blob", async () => {
  const text = 'self.onmessage = () => { self.postMessage("worker-ok"); };';
  const url = URL.createObjectURL(new Blob([text], { type: "application/javascript" }));
  return ask(new Worker(url), "blob url");
});

// 6. a data: URL
await check("worker-data", async () => {
  const text = 'self.onmessage = () => { self.postMessage("worker-ok"); };';
  const url = "data:application/javascript," + encodeURIComponent(text);
  return ask(new Worker(url), "data url");
});
`,
);

// the worker fixtures: the same text in both files — the difference is
// WHERE the file lives in the executable (an embedded asset vs an entry
// point of the build)
const fixture = (): string =>
  `self.onmessage = () => {
  self.postMessage("worker-ok");
};
`;
writeFileSync(path.join(probeDir, "probe-worker-file.js"), fixture());
writeFileSync(path.join(probeDir, "probe-worker-entry.js"), fixture());

const result = await Bun.build({
  // the entry-point fixture travels as CODE (no file loader): that is what
  // makes it an entry point the runtime may run as a worker
  entrypoints: [entry, path.join(probeDir, "probe-worker-entry.js")],
  tsconfig: path.join(root, "tsconfig.json"),
  compile: {
    outfile,
    aot: variant.aot,
    ...(variant.allowCodeFromDisk ? { allowCodeFromDisk: true } : {}),
  } as CompileOptions,
});

if (!result.success) {
  for (const log of result.logs) console.error(String(log));
  console.error(`the ${variantName} worker probe failed to build`);
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
