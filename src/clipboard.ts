import { spawn } from "node:child_process";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

// --- System clipboard bridge (Nautilus-style copied-files). Nautilus
// publishes files on the CLIPBOARD selection as MIME
// `x-special/gnome-copied-files`: first line = "copy"|"cut", then one
// file:// URI per line.
//
// CLI tools can offer only ONE mime type per selection owner — can't have
// both gnome-copied-files and text. We publish PLAIN TEXT full paths (one per
// line) so paste-anywhere works; reading stays gnome-copied-files only (other
// apps' file pastes), internal pastes go through index.ts's clipboard. ---

export const CLIP_TYPE = "x-special/gnome-copied-files";

export type ClipTool = { get: string; put: string; putBase: string[]; getArgs: string[] };

export const sysClipTool = (): ClipTool | null => {
  if (process.env.WAYLAND_DISPLAY) {
    return { get: "wl-paste", put: "wl-copy", putBase: [], getArgs: ["-t", CLIP_TYPE] };
  }
  if (process.env.DISPLAY) {
    // -l 4: serve a few requests (target probe + fetch) then exit so we don't own it forever
    return { get: "xclip", put: "xclip", putBase: ["-selection", "clipboard", "-l", "4"], getArgs: ["-selection", "clipboard", "-o", "-t", CLIP_TYPE] };
  }
  return null;
};

// "file:///home/me/a%20b.txt" -> "/home/me/a b.txt"
const decodeFileUri = (l: string): string => {
  let u = l.slice(7);
  if (!u.startsWith("/")) u = u.slice(u.indexOf("/") + 1);
  try { u = decodeURIComponent(u); } catch {}
  return u;
};

export type CopiedFiles = { op: "copy" | "move"; paths: string[] };

// parse a gnome-copied-files payload: op from the first line ("cut" → move),
// body = file:// URIs only (plain text paths are intentionally ignored — tfm
// publishes text so paste-anywhere works, and internal pastes never come back
// through here). null when the payload holds no usable URIs.
export const parseCopiedFiles = (text: string): CopiedFiles | null => {
  const lines = text.split(/\r?\n/).filter(Boolean);
  if (!lines.length) return null;
  const op: "copy" | "move" = lines[0] === "cut" ? "move" : "copy";
  const body = lines[0] === "copy" || lines[0] === "cut" ? lines.slice(1) : lines;
  const paths = body
    .filter((l) => l.startsWith("file://"))
    .map(decodeFileUri);
  if (!paths.length) return null;
  return { op, paths };
};

const execFileP = promisify(execFile);

type ClipLog = (msg: string) => void;

// publish plain-text full paths (one per line) so paste-after-copy works in
// any app; fails silently with a log line when no tool is available
export const publishPathsToSystemClipboard = (mode: string, items: { path: string }[], log: ClipLog = () => {}): void => {
  const t = sysClipTool();
  if (!t || !items.length) return;
  const payload = items.map((i) => i.path).join("\n");
  try {
    const p = spawn(t.put, [...t.putBase], { stdio: ["pipe", "ignore", "ignore"] });
    p.stdin?.end(payload);
    p.unref?.();
    log(`system clipboard <- ${mode} ${items.length} item(s) via ${t.put} (text paths)`);
  } catch (err) {
    log(`system clipboard FAILED: ${err}`);
  }
};

// read a file payload from the system clipboard (gnome-copied-files only)
export const readCopiedFilesFromSystemClipboard = async (log: ClipLog = () => {}): Promise<CopiedFiles | null> => {
  const t = sysClipTool();
  if (!t) { log("paste: no system clipboard tool"); return null; }
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
