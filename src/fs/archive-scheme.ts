// --- Archive-as-directory address: `archive://<percent-encoded absolute path>`
// with an optional `!/<inner/dir>` for a directory INSIDE the archive. Kept a
// leaf (no listing/fileops imports) so both listing and the menu/keymap open
// paths can share it without an import cycle. ---

import { ARCHIVE_URI } from "./uri";
import { detectArchiveFormat } from "./archive";

export const isArchiveUri = (p: string): boolean => p.startsWith(ARCHIVE_URI);

// encodeURIComponent leaves "!" unescaped but always escapes "/", so the only
// literal "!/" in the encoded file part is our inner-path separator.
export const archiveUri = (file: string, inner?: string): string => {
  const base = `${ARCHIVE_URI}${encodeURIComponent(file)}`;
  const clean = inner?.replace(/^\/+|\/+$/g, "");
  return clean ? `${base}!/${clean.split("/").map(encodeURIComponent).join("/")}` : base;
};

export const parseArchiveUri = (uri: string): { file: string; inner: string } | null => {
  if (!isArchiveUri(uri)) return null;
  const rest = uri.slice(ARCHIVE_URI.length);
  const bang = rest.indexOf("!/");
  const encFile = bang >= 0 ? rest.slice(0, bang) : rest;
  const encInner = bang >= 0 ? rest.slice(bang + 2) : "";
  try {
    const file = decodeURIComponent(encFile);
    if (!file) return null;
    const inner = encInner.split("/").map(decodeURIComponent).join("/");
    return { file, inner };
  } catch {
    return null;
  }
};

// The one open-routing rule shared by Enter, double-click and the context menu:
// a recognized archive enters its virtual cwd, a directory/other file does not
// (null → caller keeps its normal navigate/open behavior).
export const archiveBrowseUri = (file: string, isDir: boolean): string | null =>
  !isDir && detectArchiveFormat(file) ? archiveUri(file) : null;
