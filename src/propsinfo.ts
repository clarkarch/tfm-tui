import { readFileSync } from "node:fs";
import { lstat, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { FILE_ICON_BY_EXT, mimeForExt } from "./filetype";

// --- Pure display formatters + fs walkers for the properties dialog and
// status rows. No renderer, no app state. ---

export const fmtBytes = (n: number): string => {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = n, i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${i === 0 ? v : v.toFixed(1)} ${units[i]}`;
};

// rwx triad -> plain words; execute means "run" for files, "enter" for folders
export const permWords = (mode: number, shift: number, isDir: boolean): string => {
  const r = !!(mode & (4 << shift));
  const w = !!(mode & (2 << shift));
  const x = !!(mode & (1 << shift));
  if (!r && !w && !x) return "no access";
  const out: string[] = [];
  if (r) out.push("read");
  if (w) out.push("write");
  if (x) out.push(isDir ? "enter" : "run");
  return out.join(", ");
};

let idNameCache: Map<number, string> | null = null;
export const idName = (uid: number): string => {
  idNameCache ??= (() => {
    const m = new Map<number, string>();
    try {
      for (const line of readFileSync("/etc/passwd", "utf8").split("\n")) {
        const p = line.split(":");
        const uidN = Number(p[2]);
        if (p[0] && Number.isFinite(uidN)) m.set(uidN, p[0]);
      }
    } catch {}
    return m;
  })();
  return idNameCache.get(uid) ?? String(uid);
};

export const fmtDate = (ms?: number): string => {
  if (!ms) return "-";
  const d = new Date(ms);
  const p2 = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`;
};

export const mimeLabelFor = (name: string): string => {
  const dot = name.lastIndexOf(".");
  const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
  const mime = mimeForExt(ext);
  if (mime) return mime;
  const cat = FILE_ICON_BY_EXT[ext];
  return cat === "file-image" ? "image/*"
    : cat === "file-video" ? "video/*"
    : cat === "file-music" ? "audio/*"
    : cat === "zip-box" ? "archive"
    : cat === "file-pdf-box" ? "application/pdf"
    : cat === "file-code" ? "code"
    : cat === "file-document" ? "document"
    : "data";
};

// recursive dir totals; null when the tree is absurdly large
export const dirWalkStats = async (root: string): Promise<{ bytes: number; files: number; folders: number } | null> => {
  let bytes = 0, files = 0, folders = 0, count = 0;
  const stack: string[] = [root];
  while (stack.length) {
    const dir = stack.pop()!;
    let dirents;
    try { dirents = await readdir(dir, { withFileTypes: true }); } catch { continue; }
    for (const d of dirents) {
      if (++count > 200000) return null;
      const p = path.join(dir, d.name);
      // symlinks: report the link's own size, never follow (cycles / dupes)
      if (d.isSymbolicLink()) { files++; try { bytes += (await lstat(p)).size; } catch {} continue; }
      if (d.isDirectory()) { folders++; stack.push(p); continue; }
      files++;
      try { bytes += (await stat(p)).size; } catch {}
    }
  }
  return { bytes, files, folders };
};
