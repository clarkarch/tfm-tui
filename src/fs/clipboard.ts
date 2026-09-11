import { existsSync } from "node:fs";
import { spawnSafe } from "./spawn-safe";
import { fileUriToPath } from "./uri";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

// --- System clipboard bridge (Nautilus-style copied-files). Nautilus
// publishes files on the CLIPBOARD selection as MIME
// `x-special/gnome-copied-files`: first line = "copy"|"cut", then one
// file:// URI per line (percent-encoded).
//
// We publish BARE PATHS, not the gnome format: a selection owner has exactly
// ONE mime type (wl-copy/xclip can't offer text/plain AND gnome-copied-files
// at once), and publishing the gnome type makes every text client (terminals,
// editors, browsers) paste NOTHING — not even the URIs. Bare text keeps
// paste-anywhere working; Tfm→Nautilus paste-as-files is drag-out's job
// (OSC 72), and the read side still accepts Nautilus's gnome payload. ---

const CLIP_TYPE = "x-special/gnome-copied-files";

type ClipTool = {
  get: string;
  put: string;
  putBase: string[];
  getArgs: string[];
  /** read without a mime filter — the bare-path text fallback */
  getTextArgs: string[];
};

export const sysClipTool = (): ClipTool | null => {
  if (process.env.WAYLAND_DISPLAY) {
    return {
      get: "wl-paste",
      put: "wl-copy",
      putBase: [],
      getArgs: ["-t", CLIP_TYPE],
      getTextArgs: [],
    };
  }
  if (process.env.DISPLAY) {
    // -l 10: serve target probes + fetches from the file manager AND a text
    // preview without expiring mid-paste (-l 4 expired after a few requests)
    return {
      get: "xclip",
      put: "xclip",
      putBase: ["-selection", "clipboard", "-l", "10"],
      getArgs: ["-selection", "clipboard", "-o", "-t", CLIP_TYPE],
      getTextArgs: ["-selection", "clipboard", "-o"],
    };
  }
  return null;
};

type CopiedFiles = { op: "copy" | "move"; paths: string[] };

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
  const paths = body.filter((l) => l.startsWith("file://")).map(fileUriToPath);
  if (!paths.length) return null;
  return { op, paths };
};

// tfm's own publish format: bare absolute paths, one per line. Only paths
// that EXIST are accepted — random copied prose must never turn a paste into
// a file op, and stale pastes shouldn't spawn error toasts. `exists` is
// injectable so tests stay fs-free.
export const parsePlainPaths = (text: string, exists: (p: string) => boolean = existsSync): CopiedFiles | null => {
  const paths = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.startsWith("/") && exists(l));
  return paths.length ? { op: "copy", paths } : null;
};

const execFileP = promisify(execFile);

type ClipLog = (msg: string) => void;

// publish bare paths (one per line) as text/plain so paste-anywhere works in
// terminals/editors/browsers; fails silently with a log line when no tool is
// available. spawnFn is injectable so tests pin the exact argv + payload a
// text/plain client receives (the contract a gnome-MIME publish broke once).
export const publishPathsToSystemClipboard = (
  mode: string,
  items: { path: string }[],
  log: ClipLog = () => {},
  spawnFn: typeof spawnSafe = spawnSafe,
): void => {
  const t = sysClipTool();
  if (!t || !items.length) return;
  const payload = items.map((i) => i.path).join("\n");
  try {
    const p = spawnFn(t.put, [...t.putBase], { stdio: ["pipe", "ignore", "ignore"] }, (err) =>
      log(`system clipboard FAILED: ${err.message}`),
    );
    p.stdin?.end(payload);
    p.unref?.();
    log(`system clipboard <- ${mode} ${items.length} item(s) via ${t.put} (text paths)`);
  } catch (err) {
    log(`system clipboard FAILED: ${err}`);
  }
};

// read a file payload from the system clipboard: Nautilus's gnome-copied-files
// first, then tfm's own bare-path text publish (a second instance's clipboard
// carries text/plain, not the gnome MIME). null when neither yields paths.
export const readCopiedFilesFromSystemClipboard = async (log: ClipLog = () => {}): Promise<CopiedFiles | null> => {
  const t = sysClipTool();
  if (!t) {
    log("paste: no system clipboard tool");
    return null;
  }
  const read = async (args: string[]): Promise<string | null> => {
    try {
      const { stdout } = await execFileP(t.get, args);
      return String(stdout ?? "");
    } catch (err) {
      log(`paste: clipboard read failed (${args.join(" ") || "default"}): ${err}`);
      return null;
    }
  };
  log(`paste: reading system clipboard via ${t.get}`);
  const gnome = await read(t.getArgs);
  if (gnome) {
    const lines = gnome.split(/\r?\n/).filter(Boolean);
    log(`paste: system clip lines=${lines.length} head=${JSON.stringify(lines.slice(0, 2))}`);
    const parsed = parseCopiedFiles(gnome);
    if (parsed) return parsed;
    const plain = parsePlainPaths(gnome);
    if (plain) return plain;
  }
  // gnome MIME not offered (a text-only clipboard): re-read without the filter
  const text = await read(t.getTextArgs);
  const plain = text ? parsePlainPaths(text) : null;
  if (!plain) log("paste: no usable file paths in system clip");
  return plain;
};
