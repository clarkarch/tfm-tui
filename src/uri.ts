import os from "node:os";
import path from "node:path";

// --- Pure path/URI/XDG primitives shared by the sidebar places, recent/starred
// registries and the clipboard bridge. No state, no UI. ---

export const RECENT_URI = "recent://";
export const STARRED_URI = "starred://";

export const isVirtualUri = (p: string): boolean => p === RECENT_URI || p === STARRED_URI;

export const xdgDataHome = (): string =>
  process.env.XDG_DATA_HOME ?? path.join(os.homedir(), ".local/share");

export const xdgStateHome = (): string =>
  process.env.XDG_STATE_HOME ?? path.join(os.homedir(), ".local/state");

// XBEL timestamps are ISO-8601; Date.parse handles them
export const parseIso = (s: string): number => {
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : 0;
};

export const uriToPath = (uri: string): string | null => {
  if (!uri.startsWith("file://")) return null;
  try { return decodeURIComponent(uri.slice(7)); } catch { return null; }
};

// path -> file:// URI, percent-encoding every segment except the root slash.
// (Named xmlEscapeUri in the monolith days — it escapes for URIs, not XML.)
export const pathToUri = (p: string): string =>
  "file://" + p.split("/").map((seg, i) => (i === 0 ? seg : encodeURIComponent(seg))).join("/");
