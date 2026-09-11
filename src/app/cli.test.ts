import { describe, expect, test } from "bun:test";
import { parseArgs, usageText } from "./cli";

// CLI grammar: `tfm [OPTIONS] [PATH]`. GNU-style permutation (flags anywhere),
// `--` ends option parsing, `--config` takes a value in all the usual spellings.

describe("parseArgs", () => {
  test("skips the script token in the bun layout, not the compiled one", () => {
    expect(parseArgs(["bun", "src/index.ts", "/tmp/x"]).paths).toEqual(["/tmp/x"]);
    expect(parseArgs(["bun", "src/index.ts"]).paths).toEqual([]);
    expect(parseArgs(["/home/u/.local/bin/tfm", "/tmp/x"]).paths).toEqual(["/tmp/x"]);
  });

  test("the compiled binary keeps a path named index.js", () => {
    expect(parseArgs(["/home/u/.local/bin/tfm", "index.js"]).paths).toEqual(["index.js"]);
    expect(parseArgs(["/home/u/.local/bin/tfm", "sub/index.ts"]).paths).toEqual(["sub/index.ts"]);
    // under bun it IS the script token, so it is stripped
    expect(parseArgs(["bun", "src/index.ts", "index.js"]).paths).toEqual(["index.js"]);
  });

  test("flags may come before or after the path (permutation)", () => {
    expect(parseArgs(["tfm", "--debug", "/tmp/x"]).paths).toEqual(["/tmp/x"]);
    expect(parseArgs(["tfm", "/tmp/x", "--debug"]).paths).toEqual(["/tmp/x"]);
    expect(parseArgs(["tfm", "--debug"]).paths).toEqual([]);
  });

  test("help/version/debug recognized in long and short form", () => {
    expect(parseArgs(["tfm", "--help"]).help).toBe(true);
    expect(parseArgs(["tfm", "-h"]).help).toBe(true);
    expect(parseArgs(["tfm", "--version"]).version).toBe(true);
    expect(parseArgs(["tfm", "-v"]).version).toBe(true);
    expect(parseArgs(["tfm", "--debug"]).error).toBeNull();
    expect(parseArgs(["tfm", "-d"]).error).toBeNull();
  });

  test("--config value: separate, =, and attached short forms", () => {
    expect(parseArgs(["tfm", "--config", "a.toml"]).config).toBe("a.toml");
    expect(parseArgs(["tfm", "--config=a.toml"]).config).toBe("a.toml");
    expect(parseArgs(["tfm", "-c", "a.toml"]).config).toBe("a.toml");
    expect(parseArgs(["tfm", "-ca.toml"]).config).toBe("a.toml");
    expect(parseArgs(["tfm", "dir", "--config", "a.toml"]).config).toBe("a.toml");
  });

  test("-- ends option parsing; later tokens are paths even with a dash", () => {
    const r = parseArgs(["tfm", "--", "-weird-dir", "--help"]);
    expect(r.error).toBeNull();
    expect(r.help).toBe(false);
    expect(r.paths).toEqual(["-weird-dir", "--help"]);
  });

  test("a lone dash is a path, not an option", () => {
    expect(parseArgs(["tfm", "-"]).error).toBeNull();
    expect(parseArgs(["tfm", "-"]).paths).toEqual(["-"]);
  });

  test("unknown option is an error", () => {
    expect(parseArgs(["tfm", "--deubg"]).error).toBe("unknown option '--deubg'");
    expect(parseArgs(["tfm", "-x"]).error).toBe("unknown option '-x'");
  });

  test("missing or empty --config value is an error", () => {
    expect(parseArgs(["tfm", "--config"]).error).toBe("option '--config' needs a value");
    expect(parseArgs(["tfm", "-c"]).error).toBe("option '-c' needs a value");
    expect(parseArgs(["tfm", "--config="]).error).toBe("option '--config' needs a value");
  });
});

describe("usageText", () => {
  test("documents the synopsis, PATH and every flag", () => {
    const u = usageText();
    expect(u).toContain("Usage: tfm [OPTIONS] [PATH]");
    expect(u).toContain("--help");
    expect(u).toContain("--version");
    expect(u).toContain("--debug");
    expect(u).toContain("--config");
    expect(u).toContain("PATH");
  });
});
