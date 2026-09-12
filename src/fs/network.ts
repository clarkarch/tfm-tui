import path from "node:path";

// --- Network locations: pure primitives for the gvfs bridge. tfm does not
// implement a remote VFS — `gio mount` mounts the share through GVFS and the
// FUSE path under $XDG_RUNTIME_DIR/gvfs is an ordinary local directory, so
// every fs module (listing, transfer, preview) works unchanged. This module is
// IO-free: input parsing, argv builders, gvfs-name <-> URI mapping. ---

// schemes `gio mount` can handle out of the box
export const NETWORK_SCHEMES = ["sftp", "ssh", "ftp", "smb", "dav", "davs", "nfs", "afp", "mtp", "gphoto2"] as const;

export type ServerInput = { uri: string; label: string };

export type GvfsMountName = {
  scheme: string;
  host: string;
  user?: string;
  share?: string;
  uri: string;
  label: string;
};

export const gvfsRoot = (): string => {
  const runtime = process.env.XDG_RUNTIME_DIR;
  if (runtime) return path.join(runtime, "gvfs");
  // process.getuid is undefined on Windows; tfm is Linux-only but keep tsc happy
  const uid = typeof process.getuid === "function" ? process.getuid() : 1000;
  return `/run/user/${uid}/gvfs`;
};

export const isNetworkPath = (p: string): boolean => {
  const root = path.resolve(gvfsRoot());
  const rp = path.resolve(p);
  return rp === root || rp.startsWith(root + path.sep);
};

const prettify = (uri: string): string => {
  const withoutScheme = uri.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "").replace(/\/+$/, "");
  const userless = withoutScheme.includes("@") ? withoutScheme.slice(withoutScheme.indexOf("@") + 1) : withoutScheme;
  return userless || uri;
};

// Accepts a gvfs URI (`sftp://user@host/path`) or scp-like `[user@]host:/path`
// (→ sftp). Rejects whitespace/control chars so a pasted shell line can never
// smuggle a second argument (argv is array-passed anyway, but bad input should
// fail loudly at parse time).
export const parseServerInput = (raw: string): ServerInput | null => {
  const s = raw.trim();
  if (!s) return null;
  if (/\s/.test(s)) return null;
  for (const ch of s) {
    const code = ch.charCodeAt(0);
    if (code < 0x20 || code === 0x7f) return null;
  }
  const schemeMatch = s.match(/^([a-z][a-z0-9+.-]*):\/\//i);
  if (schemeMatch) {
    const scheme = schemeMatch[1]!.toLowerCase();
    if (!(NETWORK_SCHEMES as readonly string[]).includes(scheme)) return null;
    return { uri: s, label: prettify(s) };
  }
  // scp-like `[user@]host:/path` — assume ssh/sftp
  const scp = s.match(/^([^@/]+@)?([^:/]+):(.*)$/);
  if (!scp) return null;
  const user = scp[1] ? scp[1].slice(0, -1) : "";
  const host = scp[2]!;
  let rest = scp[3] ?? "";
  if (rest && !rest.startsWith("/")) rest = `/${rest}`;
  return { uri: `sftp://${user ? `${user}@` : ""}${host}${rest || "/"}`, label: host };
};

export const buildMountArgs = (uri: string): string[] => ["mount", uri];

export const buildUnmountArgs = (uri: string): string[] => ["mount", "-u", uri];

// gvfs names the FUSE dir by the connection: `sftp:host=H,user=U,port=P`,
// `smb-share:server=H,share=S`. Decode it back into a URI + display label so a
// mount made outside tfm is still navigable/disconnectable.
export const parseGvfsName = (name: string): GvfsMountName | null => {
  const colon = name.indexOf(":");
  if (colon <= 0) return null;
  let scheme = name.slice(0, colon).toLowerCase();
  const kv: Record<string, string> = {};
  for (const pair of name.slice(colon + 1).split(",")) {
    const eq = pair.indexOf("=");
    if (eq <= 0) continue;
    const key = pair.slice(0, eq).toLowerCase();
    let val = pair.slice(eq + 1);
    try {
      val = decodeURIComponent(val);
    } catch {}
    if (!(key in kv)) kv[key] = val;
  }
  if (scheme.endsWith("-share")) scheme = scheme.slice(0, -"-share".length);
  const host = kv.host ?? kv.server ?? "";
  const user = kv.user;
  const share = kv.share;
  const port = kv.port;
  if (!host) return null;
  const auth = user ? `${encodeURIComponent(user)}@` : "";
  const authority = port ? `${host}:${port}` : host;
  const pathPart = share ? `/${encodeURIComponent(share)}` : "/";
  const uri = `${scheme}://${auth}${authority}${pathPart}`;
  return { scheme, host, user, share, uri, label: share ? `${host}/${share}` : host };
};

export const networkMountLabel = (name: string): string => parseGvfsName(name)?.label ?? name;

// --- gio credential prompts ---
// `gio mount` (glib gio-tool-mount.c ask_password_cb / ask_question_cb) prints
// a message line, then a prompt with NO trailing newline, then fgets-blocks on
// stdin — one line per prompt, in User, Domain, Password order (or a numbered
// Choice for a question). Output is flushed via the glib log writer even when
// stdout is a pipe, so a streaming reader can drive it. Labels are forced to
// English by spawning with LC_ALL=C.
export type GioPrompt = {
  kind: "user" | "domain" | "password" | "choice";
  title: string;
  default?: string;
  password: boolean;
  // message printed before the prompt (question text for Choice), trimmed
  message?: string;
  consumed: number;
};

const GIO_PROMPT_RE = /^(User|Domain|Password|Choice)(?: \[([^\]]*)\])?: $/;

// If `buf` ends on a gio prompt, return it; otherwise null. A chunk can carry
// the message + prompt together, so scan only the final line.
export const takeGioPrompt = (buf: string): GioPrompt | null => {
  const nl = buf.lastIndexOf("\n");
  const tail = buf.slice(nl + 1);
  const m = GIO_PROMPT_RE.exec(tail);
  if (!m) return null;
  const raw = m[1]!;
  const kind = raw.toLowerCase() as GioPrompt["kind"];
  const message = buf.slice(0, nl + 1).trim();
  return {
    kind,
    title: kind === "user" ? "User name" : raw,
    default: m[2],
    password: kind === "password",
    ...(message ? { message } : {}),
    consumed: buf.length,
  };
};
