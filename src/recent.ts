import { mkdir, readFile, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import path from "node:path";
import { mimeForExt } from "./filetype";
import { parseIso, pathToUri, uriToPath, xdgDataHome, xdgStateHome } from "./uri";

// --- Recent files (freedesktop recently-used.xbel) + tfm's starred registry.
// Persistence only: read/write these two registries, nothing else. Batching
// opens and building grid Entries stays in index.ts. ---

export type XbelItem = { path: string; modified: number };

const xbelPath = (): string => path.join(xdgDataHome(), "recently-used.xbel");

export const readRecentXbel = (): XbelItem[] => {
  let xml = "";
  try {
    xml = readFileSync(xbelPath(), "utf8");
  } catch {
    return [];
  }
  const out: XbelItem[] = [];
  const bmRe = /<bookmark\b[^>]*href="([^"]+)"[^>]*>/g;
  let m: RegExpExecArray | null;
  // biome-ignore lint/suspicious/noAssignInExpressions: classic exec-loop idiom
  while ((m = bmRe.exec(xml))) {
    const p = uriToPath(m[1]!);
    if (!p) continue;
    // modified attr lives on the same tag; fall back to the application entry
    const tag = m[0];
    const mod = tag.match(/modified="([^"]+)"/)?.[1];
    out.push({ path: p, modified: mod ? parseIso(mod) : 0 });
  }
  // newest first, one row per file
  const seen = new Set<string>();
  const uniq: XbelItem[] = [];
  for (const it of out.sort((a, b) => b.modified - a.modified)) {
    if (seen.has(it.path)) continue;
    seen.add(it.path);
    uniq.push(it);
  }
  return uniq;
};

export const upsertRecentXbel = async (paths: string[]): Promise<void> => {
  try {
    let xml = "";
    try {
      xml = await readFile(xbelPath(), "utf8");
    } catch {}
    const now = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
    type Kept = { uri: string; block: string };
    const kept: Kept[] = [];
    const counts = new Map<string, number>();
    const bmRe = /[ \t]*<bookmark\b[\s\S]*?<\/bookmark>[ \t]*\n?/g;
    for (const blk of xml.match(bmRe) ?? []) {
      const uri = blk.match(/href="([^"]+)"/)?.[1];
      if (!uri) continue;
      if (paths.some((p) => pathToUri(p) === uri)) {
        counts.set(uri, parseInt(blk.match(/count="(\d+)"/)?.[1] ?? "0", 10) + 1);
        continue;
      }
      kept.push({ uri, block: blk.trim() });
    }
    for (const p of paths) {
      const uri = pathToUri(p);
      const mime = mimeForExt(path.extname(p).slice(1)) ?? "application/octet-stream";
      const count = counts.get(uri) ?? 1;
      kept.push({
        uri,
        block: `  <bookmark href="${uri}" added="${now}" modified="${now}" visited="${now}">
    <info>
      <metadata owner="http://freedesktop.org">
        <mime:mime-type type="${mime}"/>
        <bookmark:applications>
          <bookmark:application name="tfm" exec="&apos;tfm&apos;" modified="${now}" count="${count}"/>
        </bookmark:applications>
      </metadata>
    </info>
  </bookmark>`,
      });
    }
    const head = `<?xml version="1.0" encoding="UTF-8"?>
<xbel version="1.0"
      xmlns:bookmark="http://www.freedesktop.org/standards/desktop-bookmarks"
      xmlns:mime="http://www.freedesktop.org/standards/shared-mime-info">
`;
    const body = kept
      .slice(-500)
      .map((k) => k.block)
      .join("\n");
    await writeFile(xbelPath(), `${head}${body}\n</xbel>\n`, "utf8");
  } catch {}
};

// Starred registry: tfm's own list, kept in sync with gvfs metadata so
// nautilus sees the same stars (gio set metadata::starred).
const starredListPath = (): string => path.join(xdgStateHome(), "tfm", "starred.list");

export const readStarredList = (): string[] => {
  try {
    return readFileSync(starredListPath(), "utf8")
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
};

export const writeStarredList = async (paths: string[]): Promise<void> => {
  try {
    await mkdir(path.dirname(starredListPath()), { recursive: true });
    await writeFile(starredListPath(), `${[...new Set(paths)].join("\n")}\n`, "utf8");
  } catch {}
};

export const starredRegistryAdd = (p: string): void => {
  void writeStarredList([...readStarredList(), p]);
};
export const starredRegistryRemove = (p: string): void => {
  void writeStarredList(readStarredList().filter((x) => x !== p));
};
