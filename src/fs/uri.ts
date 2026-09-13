import os from "node:os";
import path from "node:path";

// --- Pure path/URI/XDG primitives shared by the sidebar places, recent/starred
// registries and the clipboard bridge. No state, no UI. ---

export const RECENT_URI = "recent://";
export const STARRED_URI = "starred://";

export const isVirtualUri = (p: string): boolean => p === RECENT_URI || p === STARRED_URI;

export const xdgDataHome = (): string => process.env.XDG_DATA_HOME ?? path.join(os.homedir(), ".local/share");

export const xdgStateHome = (): string => process.env.XDG_STATE_HOME ?? path.join(os.homedir(), ".local/state");

// XBEL timestamps are ISO-8601; Date.parse handles them
export const parseIso = (s: string): number => {
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : 0;
};

export const uriToPath = (uri: string): string | null => {
  if (!uri.startsWith("file://")) return null;
  try {
    return decodeURIComponent(uri.slice(7));
  } catch {
    return null;
  }
};

// lenient file:// -> path decode for external payloads (kitty/yazi drops,
// gnome-clipboard payloads): strips an optional authority part with the first
// slash and swallows malformed percent escapes instead of dropping the line.
export const fileUriToPath = (uri: string): string => {
  let u = uri.slice(7);
  // file://host/path → /path (keep the slash: a host-strip that drops it turns
  // an absolute path into a cwd-relative one that ENOENTs or copies wrongly)
  if (!u.startsWith("/")) {
    const slash = u.indexOf("/");
    if (slash >= 0) u = u.slice(slash);
  }
  try {
    u = decodeURIComponent(u);
  } catch {}
  return u;
};

// path -> file:// URI, percent-encoding every segment except the root slash.
// (Named xmlEscapeUri in the monolith days — it escapes for URIs, not XML.)
export const pathToUri = (p: string): string =>
  `file://${p
    .split("/")
    .map((seg, i) => (i === 0 ? seg : encodeURIComponent(seg)))
    .join("/")}`;
