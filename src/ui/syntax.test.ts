import { describe, expect, test } from "bun:test";
import { defaultConfig, type Theme } from "../config/config";
import { buildSyntaxStyle, EXTRA_PARSERS, isTextLike, PREVIEW_FT_BY_EXT, syntaxStyleSig } from "./syntax";

describe("EXTRA_PARSERS", () => {
  test("registers 8 extra languages with unique filetypes", () => {
    expect(EXTRA_PARSERS.length).toBe(8);
    const filetypes = EXTRA_PARSERS.map((p) => p.filetype);
    expect(new Set(filetypes).size).toBe(8);
    expect(filetypes).toEqual(["json", "bash", "python", "rust", "go", "css", "yaml", "toml"]);
  });

  test("every wasm + query URL is https", () => {
    for (const p of EXTRA_PARSERS) {
      expect(p.wasm.startsWith("https://")).toBe(true);
      for (const url of p.queries.highlights) {
        expect(url.startsWith("https://")).toBe(true);
      }
    }
  });
});

describe("PREVIEW_FT_BY_EXT", () => {
  test("maps extensions to tree-sitter filetypes", () => {
    expect(PREVIEW_FT_BY_EXT.js).toBe("javascript");
    expect(PREVIEW_FT_BY_EXT.tsx).toBe("typescriptreact");
    expect(PREVIEW_FT_BY_EXT.md).toBe("markdown");
    expect(PREVIEW_FT_BY_EXT.toml).toBe("toml");
    expect(PREVIEW_FT_BY_EXT.zsh).toBe("bash");
  });
});

describe("isTextLike", () => {
  test("known-text extensions are text", () => {
    expect(isTextLike("notes.md")).toBe(true);
    expect(isTextLike("config.toml")).toBe(true);
    expect(isTextLike("x.ini")).toBe(true);
    expect(isTextLike("data.csv")).toBe(true);
    expect(isTextLike("app.lock")).toBe(true);
    expect(isTextLike(".env")).toBe(true);
  });

  test("file-code extensions are text", () => {
    expect(isTextLike("script.ts")).toBe(true);
    expect(isTextLike("main.rs")).toBe(true);
  });

  test("image/video extensions are not text", () => {
    expect(isTextLike("photo.png")).toBe(false);
    expect(isTextLike("clip.mp4")).toBe(false);
  });

  test("unknown extension is not text", () => {
    expect(isTextLike("x.xyz123")).toBe(false);
  });
});

describe("syntaxStyleSig", () => {
  const base: Theme = { ...defaultConfig.theme };

  test("differs when only a syntax key differs", () => {
    const other: Theme = { ...base, syntaxString: "#000000" };
    expect(syntaxStyleSig(other)).not.toBe(syntaxStyleSig(base));
  });

  test("is stable for the same theme", () => {
    expect(syntaxStyleSig(base)).toBe(syntaxStyleSig({ ...base }));
  });
});

describe("buildSyntaxStyle", () => {
  test("builds a style from a Theme without throwing", () => {
    const style = buildSyntaxStyle({ ...defaultConfig.theme });
    expect(style).toBeTruthy();
  });
});
