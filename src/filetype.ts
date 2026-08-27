import { readFile } from "node:fs/promises";

// --- File type classification (extension -> icon-name category), shared by
// grid tiles, preview gating and the properties dialog. Returns icon NAMES
// only ("file-code", "zip-box", …); resolving names to glyphs stays in
// index.ts so this module never touches UI state. ---

// generic `file` is the fallback, mirroring nautilus's themed-icon fallback
// chain in spirit
export const FILE_ICON_BY_EXT: Record<string, string> = {
  js: "file-code", jsx: "file-code", mjs: "file-code", cjs: "file-code",
  ts: "file-code", tsx: "file-code", py: "file-code", rb: "file-code",
  rs: "file-code", go: "file-code", c: "file-code", h: "file-code",
  cpp: "file-code", cc: "file-code", hpp: "file-code", java: "file-code",
  kt: "file-code", swift: "file-code", cs: "file-code", php: "file-code",
  lua: "file-code", pl: "file-code", sh: "file-code", bash: "file-code",
  zsh: "file-code", fish: "file-code", ps1: "file-code", vue: "file-code",
  svelte: "file-code", html: "file-code", css: "file-code", scss: "file-code",
  sql: "file-code", json: "file-code", yaml: "file-code", yml: "file-code",
  toml: "file-code", xml: "file-code", ini: "file-code", conf: "file-code",
  zig: "file-code", nim: "file-code", ex: "file-code", exs: "file-code",
  hs: "file-code", ml: "file-code", r: "file-code", dart: "file-code",
  md: "file-document", markdown: "file-document", txt: "file-document",
  doc: "file-document", docx: "file-document", odt: "file-document",
  rtf: "file-document", log: "file-document", eps: "file-document",
  png: "file-image", jpg: "file-image", jpeg: "file-image", gif: "file-image",
  webp: "file-image", svg: "file-image", bmp: "file-image", ico: "file-image",
  tiff: "file-image", avif: "file-image", heic: "file-image", xcf: "file-image",
  mp4: "file-video", mkv: "file-video", avi: "file-video", mov: "file-video",
  webm: "file-video", wmv: "file-video", flv: "file-video", m4v: "file-video",
  mp3: "file-music", flac: "file-music", wav: "file-music", ogg: "file-music",
  oga: "file-music", m4a: "file-music", opus: "file-music", aac: "file-music",
  zip: "zip-box", tar: "zip-box", gz: "zip-box", bz2: "zip-box", xz: "zip-box",
  zst: "zip-box", "7z": "zip-box", rar: "zip-box", apk: "zip-box", jar: "zip-box",
  pdf: "file-pdf-box",
};

// shared-mime-info database (same data nautilus's GIO consults): ext -> mime,
// highest-weight glob wins. Loaded once at boot; absent file degrades silently.
let globs2ByExt: Map<string, string> | null = null;
const globs2Weight = new Map<string, number>();

export async function loadGlobs2(): Promise<void> {
  try {
    const text = await readFile("/usr/share/mime/globs2", "utf8");
    for (const line of text.split("\n")) {
      if (!line || line.startsWith("#")) continue;
      const parts = line.split(":");
      if (parts.length < 3 || !parts[0] || !parts[1] || !parts[2]) continue;
      const weight = parseInt(parts[0], 10);
      const mime = parts[1];
      const glob = parts[2];
      if (!Number.isFinite(weight) || !glob.startsWith("*.")) continue;
      const ext = glob.slice(2).toLowerCase();
      if (!ext || ext.includes("*") || ext.includes("?") || ext.includes("[")) continue;
      const prevW = globs2Weight.get(ext);
      if (prevW === undefined || weight > prevW) {
        globs2ByExt ??= new Map();
        globs2ByExt.set(ext, mime);
        globs2Weight.set(ext, weight);
      }
    }
  } catch {}
}

export const mimeForExt = (ext: string): string | undefined =>
  globs2ByExt?.get(ext.toLowerCase());

const ARCHIVE_MIMES = new Set([
  "application/zip", "application/gzip", "application/x-gzip", "application/bzip2",
  "application/x-bzip2", "application/x-xz", "application/x-7z-compressed",
  "application/vnd.rar", "application/x-rar-compressed", "application/zstd",
  "application/x-tar", "application/java-archive", "application/vnd.android.package-archive",
]);

export const mimeCategory = (mime: string): string => {
  const media = mime.split("/")[0] ?? "";
  if (media === "image") return "file-image";
  if (media === "video") return "file-video";
  if (media === "audio") return "file-music";
  if (ARCHIVE_MIMES.has(mime)) return "zip-box";
  if (mime === "application/pdf") return "file-pdf-box";
  if (
    /^text\/x-/.test(mime) ||
    ["text/html", "text/css", "application/javascript", "application/json", "application/xml", "application/yaml"].includes(mime) ||
    mime.endsWith("+xml") || mime.endsWith("+json")
  ) return "file-code";
  if (media === "text" || /^(application\/msword|application\/rtf|application\/vnd\.oasis\.opendocument\.text)/.test(mime)) return "file-document";
  return "file";
};

export const fileIconFor = (name: string): string => {
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return "file";
  const ext = name.slice(dot + 1).toLowerCase();
  return FILE_ICON_BY_EXT[ext]
    ?? (globs2ByExt?.get(ext) ? mimeCategory(globs2ByExt.get(ext)!) : undefined)
    ?? "file";
};

export const fileIsImage = (name: string): boolean => {
  const dot = name.lastIndexOf(".");
  const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
  if (FILE_ICON_BY_EXT[ext] === "file-image") return true;
  const mime = globs2ByExt?.get(ext);
  return !!mime && mime.startsWith("image/");
};
