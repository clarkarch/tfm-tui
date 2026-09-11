import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parsePluginsArgs, runPluginsCli } from "./plugins-cli";
import { parseArgs } from "./cli";

describe("tfm plugins CLI", () => {
  test("cli.ts routes `plugins …` to a headless command", () => {
    const opts = parseArgs(["tfm", "plugins", "add", "https://github.com/u/repo"]);
    expect(opts.command).toEqual({ name: "plugins", args: ["add", "https://github.com/u/repo"] });
  });

  test("parsePluginsArgs dispatches and validates", () => {
    expect(parsePluginsArgs([])).toEqual({ cmd: "list", target: null, error: null });
    expect(parsePluginsArgs(["add", "https://x/y"]).cmd).toBe("add");
    expect(parsePluginsArgs(["add"]).error).toContain("git URL");
    expect(parsePluginsArgs(["remove", "cool"]).target).toBe("cool");
    expect(parsePluginsArgs(["update"]).cmd).toBe("update");
    expect(parsePluginsArgs(["new", "cool"]).cmd).toBe("new");
    expect(parsePluginsArgs(["wat"]).error).toContain("unknown");
  });

  describe("runPluginsCli", () => {
    const dirs: string[] = [];
    const tmp = (): string => {
      const d = mkdtempSync(path.join(os.tmpdir(), "tfm-pcli-"));
      dirs.push(d);
      return d;
    };
    afterEach(() => {
      for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
    });

    test("list on an empty dir reports none", async () => {
      const lines: string[] = [];
      const code = await runPluginsCli([], { dir: tmp(), out: (s) => lines.push(s), err: () => {} });
      expect(code).toBe(0);
      expect(lines.join("\n")).toContain("no plugins installed");
    });

    test("new scaffolds a plugin file", async () => {
      const dir = tmp();
      const lines: string[] = [];
      const code = await runPluginsCli(["new", "cool"], { dir, out: (s) => lines.push(s), err: () => {} });
      expect(code).toBe(0);
      const body = readFileSync(path.join(dir, "cool", "cool.ts"), "utf8");
      expect(body).toContain('name: "cool"');
      expect(body).toContain("apiVersion: 3");
      // second run refuses to clobber
      const errs: string[] = [];
      expect(await runPluginsCli(["new", "cool"], { dir, out: () => {}, err: (s) => errs.push(s) })).toBe(1);
      expect(errs.join("")).toContain("already exists");
    });

    test("new rejects an unsafe name", async () => {
      const errs: string[] = [];
      const code = await runPluginsCli(["new", "../evil"], { dir: tmp(), out: () => {}, err: (s) => errs.push(s) });
      expect(code).toBe(2);
      expect(errs.join("")).toContain("unsafe plugin name");
    });
  });
});

describe("plugin index", () => {
  test("parse drops malformed/unsafe entries", async () => {
    const { parsePluginIndex, indexEntryToRaw, findIndexEntry, searchIndex } = await import("../plugins/plugin-index");
    const idx = parsePluginIndex({
      plugins: [
        { id: "cool", name: "Cool", description: "does cool", url: "https://github.com/u/cool", ref: "dev" },
        { id: "evil", url: "file:///etc/passwd" },
        { id: "", url: "https://github.com/u/x" },
        { id: "bare", url: "/tmp/local" },
      ],
    });
    expect(idx.map((e) => e.id)).toEqual(["cool"]);
    expect(indexEntryToRaw(idx[0]!)).toBe("https://github.com/u/cool#dev");
    expect(findIndexEntry(idx, "cool")?.name).toBe("Cool");
    expect(searchIndex(idx, "COOL").length).toBe(1);
    expect(searchIndex(idx, "nope")).toEqual([]);
  });

  test("add resolves an index id; search lists matches", async () => {
    const fetchIndex = async () => ({
      plugins: [{ id: "cool", name: "Cool", description: "does cool", url: "https://github.com/u/cool" }],
    });
    const dir = mkdtempSync(path.join(os.tmpdir(), "tfm-pcli-idx-"));
    try {
      const lines: string[] = [];
      expect(
        await runPluginsCli(["search", "cool"], { dir, fetchIndex, out: (s) => lines.push(s), err: () => {} }),
      ).toBe(0);
      expect(lines.join("\n")).toContain("cool");
      // an unknown id errors instead of silently doing nothing
      const errs: string[] = [];
      expect(await runPluginsCli(["add", "nope"], { dir, fetchIndex, out: () => {}, err: (s) => errs.push(s) })).toBe(
        1,
      );
      expect(errs.join("")).toContain("no plugin 'nope'");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("tfm plugins add", () => {
  test("installs from a git URL through the injected exec", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "tfm-pcli-add-"));
    try {
      const exec = async (_cmd: string, args: string[]) => {
        const dest = args[args.length - 1]!;
        mkdirSync(dest, { recursive: true });
        writeFileSync(path.join(dest, "cool.ts"), `export default { name: "cool", activate: () => ({}) };\n`);
        return { exit: 0, output: "" };
      };
      const lines: string[] = [];
      const code = await runPluginsCli(["add", "https://github.com/u/cool"], {
        dir,
        exec,
        out: (s) => lines.push(s),
        err: () => {},
      });
      expect(code).toBe(0);
      expect(lines.join("\n")).toContain("installed cool");
      expect(readFileSync(path.join(dir, "cool", "cool.ts"), "utf8")).toContain('name: "cool"');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
