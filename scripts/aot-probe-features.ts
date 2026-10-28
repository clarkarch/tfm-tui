// Exercises the runtime features tfm leans on, inside a compiled executable.
//
//   bun scripts/aot-probe-features.ts aot [outfile]
//   bun scripts/aot-probe-features.ts jit [outfile]
//
// Why: the trimmed AOT build removes the Bun and Node.js APIs the program
// never calls — statically. An API the program reaches through a dynamic
// path is removed too, and the executable then fails at run time, in a place
// the boot smoke test never touches (the boot only paints a grid). This
// probe touches those places on purpose:
//
//   * the file system   — the file manager is nothing but file system calls
//   * a child process  — the file manager shells out (fd, du, …)
//   * a PTY             — the embedded terminal
//   * a worker          — opentui's parser runs in one
//   * a timer           — the render loop
//
// Every check prints one line: "<name>: ok" or "<name>: FAILED — <reason>".
// The lines of the AOT build and of the JIT baseline have to be the same —
// that is the control. A line that differs is a feature the AOT build lost.

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

type CompileOptions = Exclude<Parameters<typeof Bun.build>[0]["compile"], boolean | string> & {
  aot?: boolean;
};

const root = path.resolve(import.meta.dir, "..");
const mode = process.argv[2] === "jit" ? "jit" : "aot";
const outfile = path.resolve(root, process.argv[3] ?? `dist/probe/probe-features-${mode}`);

// the program that does the asking
const entry = path.resolve(root, "dist/probe/probe-features-entry.ts");
mkdirSync(path.dirname(entry), { recursive: true });
writeFileSync(
  entry,
  `import { readdirSync } from "node:fs";

const check = async (name: string, fn: () => Promise<string> | string) => {
  try {
    const detail = await fn();
    console.log(\`\${name}: ok\${detail ? \` (\${detail})\` : ""}\`);
  } catch (err) {
    console.log(\`\${name}: FAILED — \${String((err as Error)?.message ?? err).slice(0, 140)}\`);
  }
};

await check("file-write-read", async () => {
  const file = \`/tmp/aot-feature-probe-\${process.pid}.txt\`;
  await Bun.write(file, "hello");
  const text = await Bun.file(file).text();
  if (text !== "hello") throw new Error(\`read back \${JSON.stringify(text)}\`);
  return text;
});

await check("dir-read", () => {
  const names = readdirSync("/tmp");
  if (!names.length) throw new Error("no entries");
  return \`\${names.length} entries\`;
});

await check("spawn", async () => {
  const proc = Bun.spawn(["echo", "spawn-ok"], { stdout: "pipe" });
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  if (!out.includes("spawn-ok")) throw new Error(\`got \${JSON.stringify(out)}\`);
  return out.trim();
});

await check("pty", async () => {
  let seen = "";
  const proc = Bun.spawn(["echo", "pty-ok"], {
    terminal: { cols: 80, rows: 24, data(_t: unknown, d: Uint8Array) { seen += new TextDecoder().decode(d); } },
    stdout: "pipe",
    stderr: "pipe",
  });
  await proc.exited;
  if (!seen.includes("pty-ok")) throw new Error(\`got \${JSON.stringify(seen)}\`);
  return "pty-ok";
});

await check("worker", async () => {
  // the fixture is embedded as a file (the loader map below says so), so the
  // worker runs from the executable itself — the way opentui's parser does
  const mod = (await import("./probe-worker-fixture.js", { with: { type: "file" } })) as { default: string };
  const worker = new Worker(mod.default);
  const reply = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("no answer in 5s")), 5000);
    worker.onmessage = (event: MessageEvent) => { clearTimeout(timer); resolve(String(event.data)); };
    worker.onerror = (event: ErrorEvent) => { clearTimeout(timer); reject(new Error(event.message ?? "worker error")); };
    worker.postMessage("ping");
  });
  await worker.terminate();
  if (!reply.includes("worker-ok")) throw new Error(\`got \${JSON.stringify(reply)}\`);
  return reply;
});

await check("timer", async () => {
  await Bun.sleep(5);
  return "slept";
});
`,
);

// the worker's code: it travels with the executable as a file
const fixture = path.resolve(root, "dist/probe/probe-worker-fixture.js");
writeFileSync(
  fixture,
  `self.onmessage = () => {
  self.postMessage("worker-ok");
};
`,
);

const result = await Bun.build({
  entrypoints: [entry, fixture],
  // the worker fixture is CODE, but it has to travel as a FILE: the worker
  // is started from a path, and the executable reads it from itself. The
  // probe imports nothing else from disk, so the .js loader map is safe
  // here (the app's build uses .svg for the same reason).
  loader: { ".js": "file" },
  tsconfig: path.join(root, "tsconfig.json"),
  compile: { outfile, aot: mode === "aot" } as CompileOptions,
});

if (!result.success) {
  for (const log of result.logs) console.error(String(log));
  console.log(`the ${mode} feature probe failed to build`);
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
