import { SyntaxStyle, addDefaultParsers } from "@opentui/core";
import type { Theme } from "./config";
import { FILE_ICON_BY_EXT, mimeForExt } from "./filetype";

// --- Tree-sitter syntax machinery for the preview pane (via @opentui/core).
// Bundled grammars: js/ts/jsx/tsx, markdown, zig. Extra languages are
// registered opencode-style: wasm + query URLs, downloaded once and
// disk-cached by the client's download utils. Also owns the preview syntax
// style builder. Pure module — no renderer/state imports; the theme arrives
// as a parameter. ---

export const EXTRA_PARSERS = [
  {
    filetype: "json",
    wasm: "https://github.com/tree-sitter/tree-sitter-json/releases/download/v0.24.8/tree-sitter-json.wasm",
    queries: {
      highlights: [
        "https://raw.githubusercontent.com/nvim-treesitter/nvim-treesitter/refs/heads/master/queries/json/highlights.scm",
      ],
    },
  },
  {
    filetype: "bash",
    wasm: "https://github.com/tree-sitter/tree-sitter-bash/releases/download/v0.25.0/tree-sitter-bash.wasm",
    queries: {
      highlights: [
        "https://raw.githubusercontent.com/nvim-treesitter/nvim-treesitter/refs/heads/master/queries/bash/highlights.scm",
      ],
    },
  },
  {
    filetype: "python",
    wasm: "https://github.com/tree-sitter/tree-sitter-python/releases/download/v0.23.6/tree-sitter-python.wasm",
    queries: {
      highlights: ["https://github.com/tree-sitter/tree-sitter-python/raw/refs/heads/master/queries/highlights.scm"],
    },
  },
  {
    filetype: "rust",
    wasm: "https://github.com/tree-sitter/tree-sitter-rust/releases/download/v0.24.0/tree-sitter-rust.wasm",
    queries: {
      highlights: [
        "https://raw.githubusercontent.com/nvim-treesitter/nvim-treesitter/refs/heads/master/queries/rust/highlights.scm",
      ],
    },
  },
  {
    filetype: "go",
    wasm: "https://github.com/tree-sitter/tree-sitter-go/releases/download/v0.25.0/tree-sitter-go.wasm",
    queries: {
      highlights: [
        "https://raw.githubusercontent.com/nvim-treesitter/nvim-treesitter/refs/heads/master/queries/go/highlights.scm",
      ],
    },
  },
  {
    filetype: "css",
    wasm: "https://github.com/tree-sitter/tree-sitter-css/releases/download/v0.25.0/tree-sitter-css.wasm",
    queries: {
      highlights: [
        "https://raw.githubusercontent.com/nvim-treesitter/nvim-treesitter/refs/heads/master/queries/css/highlights.scm",
      ],
    },
  },
  {
    filetype: "yaml",
    wasm: "https://github.com/tree-sitter-grammars/tree-sitter-yaml/releases/download/v0.7.2/tree-sitter-yaml.wasm",
    queries: {
      highlights: [
        "https://raw.githubusercontent.com/nvim-treesitter/nvim-treesitter/refs/heads/master/queries/yaml/highlights.scm",
      ],
    },
  },
  {
    filetype: "toml",
    wasm: "https://github.com/tree-sitter-grammars/tree-sitter-toml/releases/download/v0.7.0/tree-sitter-toml.wasm",
    queries: {
      highlights: [
        "https://raw.githubusercontent.com/nvim-treesitter/nvim-treesitter/master/queries/toml/highlights.scm",
      ],
    },
  },
];

export const registerSyntaxParsers = (): void => {
  addDefaultParsers(EXTRA_PARSERS);
};

export const PREVIEW_FT_BY_EXT: Record<string, string> = {
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsx: "javascriptreact",
  ts: "typescript",
  mts: "typescript",
  cts: "typescript",
  tsx: "typescriptreact",
  md: "markdown",
  markdown: "markdown",
  mdx: "markdown",
  zig: "zig",
  json: "json",
  jsonc: "json",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  py: "python",
  rs: "rust",
  go: "go",
  css: "css",
  scss: "css",
  yml: "yaml",
  yaml: "yaml",
  toml: "toml",
};

export const isTextLike = (name: string): boolean => {
  const ext = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1).toLowerCase() : "";
  if (FILE_ICON_BY_EXT[ext] === "file-image" || FILE_ICON_BY_EXT[ext] === "file-video") return false;
  // known-text extensions win even when globs2 reports an odd mime
  // (e.g. toml → application/toml used to fall through the cracks)
  if (
    [
      "md",
      "markdown",
      "txt",
      "log",
      "json",
      "yaml",
      "yml",
      "toml",
      "ini",
      "conf",
      "cfg",
      "html",
      "css",
      "csv",
      "lock",
      "env",
    ].includes(ext) ||
    FILE_ICON_BY_EXT[ext] === "file-code" ||
    FILE_ICON_BY_EXT[ext] === "file-document"
  )
    return true;
  const mime = mimeForExt(ext);
  if (!mime) return false;
  return (
    mime.startsWith("text/") ||
    /^(application\/(json|xml|javascript|x-yaml|x-sh|toml))/.test(mime) ||
    mime.endsWith("+xml")
  );
};

export const syntaxStyleSig = (t: Theme): string =>
  [
    t.accent,
    t.white,
    t.sidebarFg,
    t.sidebarFgMuted,
    t.syntaxString,
    t.syntaxNumber,
    t.syntaxType,
    t.syntaxFunction,
    t.syntaxOperator,
    t.syntaxProperty,
  ].join("|");

export const buildSyntaxStyle = (t: Theme) =>
  SyntaxStyle.fromStyles({
    keyword: { fg: t.accent, bold: true },
    string: { fg: t.syntaxString ?? "#9ece6a" },
    comment: { fg: t.sidebarFgMuted, italic: true },
    function: { fg: t.syntaxFunction ?? "#7aa2f7" },
    method: { fg: t.syntaxFunction ?? "#7aa2f7" },
    type: { fg: t.syntaxType ?? "#2ac3de" },
    "type.builtin": { fg: t.syntaxType ?? "#2ac3de" },
    number: { fg: t.syntaxNumber ?? "#ff9e64" },
    constant: { fg: t.syntaxNumber ?? "#ff9e64" },
    "constant.builtin": { fg: t.syntaxNumber ?? "#bb9af7" },
    operator: { fg: t.syntaxOperator ?? t.white },
    punctuation: { fg: t.sidebarFgMuted },
    property: { fg: t.syntaxProperty ?? "#73daca" },
    variable: { fg: t.sidebarFg },
  });
