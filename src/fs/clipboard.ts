import { spawnSafe } from "./spawn-safe";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";

// --- System clipboard bridge (Nautilus-style copied-files). Nautilus
// publishes files on the CLIPBOARD selection as MIME
// `x-special/gnome-copied-files`: first line = "copy"|"cut", then one
// file:// URI per line (percent-encoded).
//
// We publish the SAME gnome format (not bare text paths) so Tfm→Nautilus
// paste-as-files works and cross-instance Tfm→Tfm pastes round-trip through
// readCopiedFilesFromSystemClipboard. Pasting into a text editor yields
// `copy\nfile://…` lines (same as Nautilus) instead of bare paths —
// file-manager interop wins over clean text paste. ---

export const CLIP_TYPE = "x-special/gnome-copied-files";

export type ClipTool = {
  get: string;
  put: string;
  putBase: string[];
  /** extra args to offer the gnome mime type on publish */
  putMimeArgs: string[];
  getArgs: string[];
};

export const sysClipTool = (): ClipTool | null => {
  if (process.env.WAYLAND_DISPLAY) {
    return {
      get: "wl-paste",
      put: "wl-copy",
      putBase: [],
      putMimeArgs: ["-t", CLIP_TYPE],
      getArgs: ["-t", CLIP_TYPE],
    };
  }
  if (process.env.DISPLAY) {
    // -l 10: serve target probes + fetches from the file manager AND a text
    // preview without expiring mid-paste (-l 4 expired after a few requests)
    return {
      get: "xclip",
      put: "xclip",
      putBase: ["-selection", "clipboard", "-l", "10"],
      putMimeArgs: ["-t", CLIP_TYPE],
      getArgs: ["-selection", "clipboard", "-o", "-t", CLIP_TYPE],
    };
  }
  return null;
};

// "/home/me/a b.txt" -> "file:///home/me/a%20b.txt"
export const fileUriFor = (p: string): string => {
  const abs = path.resolve(p);
  const encoded = abs
    .split(path.sep)
    .map((seg, i) => (i === 0 && seg === "" ? "" : encodeURIComponent(seg)))
    .join("/");
  return `file://${encoded}`;
};

// "file:///home/me/a%20b.txt" -> "/home/me/a b.txt"
const decodeFileUri = (l: string): string => {
  let u = l.slice(7);
  if (!u.startsWith("/")) u = u.slice(u.indexOf("/") + 1);
  try {
    u = decodeURIComponent(u);
  } catch {}
  return u;
};

export type CopiedFiles = { op: "copy" | "move"; paths: string[] };

// internal-clipboard cut check (tile dimming): the pressed path is "cut" when
// the pending clipboard is a cut containing it. null clipboard = nothing cut.
export const isCutKeyFor = (
  clip: { mode: string; items: { path: string }[] } | null | undefined,
  key: string,
): boolean => clip?.mode === "cut" && clip.items.some((i) => i.path === key);

// parse a gnome-copied-files payload: op from the first line ("cut" → move),
// body = file:// URIs only. null when the payload holds no usable URIs.
export const parseCopiedFiles = (text: string): CopiedFiles | null => {
  const lines = text.split(/\r?\n/).filter(Boolean);
  if (!lines.length) return null;
  const op: "copy" | "move" = lines[0] === "cut" ? "move" : "copy";
  const body = lines[0] === "copy" || lines[0] === "cut" ? lines.slice(1) : lines;
  const paths = body.filter((l) => l.startsWith("file://")).map(decodeFileUri);
  if (!paths.length) return null;
  return { op, paths };
};

const execFileP = promisify(execFile);

type ClipLog = (msg: string) => void;

// publish gnome-copied-files so GUI file managers (and other tfm instances)
// can paste as files; fails silently with a log line when no tool is available
export const publishPathsToSystemClipboard = (
  mode: string,
  items: { path: string }[],
  log: ClipLog = () => {},
): void => {
  const t = sysClipTool();
  if (!t || !items.length) return;
  const header = mode === "cut" ? "cut" : "copy";
  const payload = [header, ...items.map((i) => fileUriFor(i.path))].join("\n");
  try {
    const p = spawnSafe(t.put, [...t.putMimeArgs, ...t.putBase], { stdio: ["pipe", "ignore", "ignore"] }, (err) =>
      log(`system clipboard FAILED: ${err.message}`),
    );
    p.stdin?.end(payload);
    p.unref?.();
    log(`system clipboard <- ${mode} ${items.length} item(s) via ${t.put} (${CLIP_TYPE})`);
  } catch (err) {
    log(`system clipboard FAILED: ${err}`);
  }
};

// read a file payload from the system clipboard (gnome-copied-files only)
export const readCopiedFilesFromSystemClipboard = async (log: ClipLog = () => {}): Promise<CopiedFiles | null> => {
  const t = sysClipTool();
  if (!t) {
    log("paste: no system clipboard tool");
    return null;
  }
  log(`paste: reading system clipboard via ${t.get}`);
  try {
    const { stdout } = await execFileP(t.get, t.getArgs);
    const text = String(stdout ?? "");
    const lines = text.split(/\r?\n/).filter(Boolean);
    log(`paste: system clip lines=${lines.length} head=${JSON.stringify(lines.slice(0, 2))}`);
    const parsed = parseCopiedFiles(text);
    if (!parsed) log("paste: no file:// uris in system clip");
    return parsed;
  } catch (err) {
    log(`paste: system clipboard read failed: ${err}`);
    return null;
  }
};
