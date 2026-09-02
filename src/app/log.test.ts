import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// log.ts bakes isDebug from argv and the paths from env AT IMPORT, and other
// test files (nav.test.ts -> nav.ts -> ./log) cache the module first — so
// every assertion here runs in a fresh subprocess against env-redirected
// logs (never the real /tmp files; AGENTS.md: no hardcoded tmp paths).

const dir = mkdtempSync(path.join(os.tmpdir(), "tfm-log-"));
const logUrl = new URL("./log.ts", import.meta.url).href;
const script = path.join(dir, "probe.ts");
writeFileSync(
  script,
  `const l = await import(${JSON.stringify(logUrl)});
if (process.argv[2] === "paths") {
  process.stdout.write(JSON.stringify({ isDebug: l.isDebug, DEBUG_LOG: l.DEBUG_LOG, DND_LOG: l.DND_LOG }));
} else {
  l.appendLog("first");
  l.appendLog("second");
  l.debugLog("dbg line");
  l.dlog("dnd line");
  process.stdout.write(String(l.isDebug));
}`,
);

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

const run = (tag: string, mode: string, args: string[], redirect = true) => {
  const env: Record<string, string | undefined> = { ...process.env };
  if (redirect) {
    env.TFM_DEBUG_LOG = path.join(dir, `${tag}-debug.log`);
    env.TFM_DND_LOG = path.join(dir, `${tag}-dnd.log`);
  } else {
    delete env.TFM_DEBUG_LOG;
    delete env.TFM_DND_LOG;
  }
  const out = Bun.spawnSync([process.execPath, script, mode, ...args], { env });
  return {
    text: out.stdout.toString(),
    dbg: path.join(dir, `${tag}-debug.log`),
    dnd: path.join(dir, `${tag}-dnd.log`),
  };
};

const lines = (f: string): string[] => (existsSync(f) ? readFileSync(f, "utf8").split("\n").filter(Boolean) : []);

describe("paths", () => {
  test("TFM_DEBUG_LOG / TFM_DND_LOG override the /tmp defaults", () => {
    const p = JSON.parse(run("paths", "paths", []).text);
    expect(p.DEBUG_LOG).toBe(path.join(dir, "paths-debug.log"));
    expect(p.DND_LOG).toBe(path.join(dir, "paths-dnd.log"));
  });

  test("without the env, the documented /tmp paths are used", () => {
    const p = JSON.parse(run("defaults", "paths", [], false).text);
    expect(p.DEBUG_LOG).toBe("/tmp/tfm-debug.log");
    expect(p.DND_LOG).toBe("/tmp/tfm-dnd.log");
  });
});

describe("without --debug", () => {
  test("appendLog writes ISO-timestamped lines; dlog writes; debugLog is silent", () => {
    expect(run("plain", "write", []).text).toBe("false");
    const dbg = lines(path.join(dir, "plain-debug.log"));
    expect(dbg.length).toBe(2);
    expect(dbg[0]).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z first$/);
    expect(dbg[1]).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z second$/);
    const dnd = lines(path.join(dir, "plain-dnd.log"));
    expect(dnd.length).toBe(1);
    expect(dnd[0]).toContain("dnd line");
  });
});

describe("with --debug / -d", () => {
  test("--debug: debugLog writes and dlog mirrors into the debug log", () => {
    const r = run("dbg", "write", ["--debug"]);
    expect(r.text).toBe("true");
    const dbg = lines(r.dbg);
    expect(dbg.some((l) => l.includes("dbg line"))).toBe(true);
    expect(dbg.some((l) => l.includes("[dnd] dnd line"))).toBe(true);
  });

  test("-d short flag: same behavior", () => {
    const r = run("d", "write", ["-d"]);
    expect(r.text).toBe("true");
    expect(lines(r.dbg).length).toBeGreaterThan(0);
  });
});
