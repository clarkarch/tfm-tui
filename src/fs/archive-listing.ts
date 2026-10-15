// --- One level of an archive as a directory listing (`archive://` cwd). Thin:
// the tool argv + line parsing live in ./archive (listArchiveMembers); this
// module filters members to the current inner dir and names their abs URIs. ---

import { detectArchiveFormat, listArchiveMembers, selectArchiveLane, type ArchiveRun, type WhichFn } from "./archive";
import { archiveUri, parseArchiveUri } from "./archive-scheme";

// structurally an Entry (listing.ts owns that type; a shared type import would
// make a cycle listing -> archive-listing -> listing, which imports.test.ts
// rejects). assignable to Entry without a cast.
export type ArchiveDirEntry = {
  name: string;
  isDir: boolean;
  size?: number;
  abs?: string;
  isLink?: boolean;
};

const clean = (s: string): string => s.replace(/^\/+|\/+$/g, "");

export const listArchiveDir = async (
  uri: string,
  deps?: { run?: ArchiveRun; which?: WhichFn },
): Promise<ArchiveDirEntry[]> => {
  const parsed = parseArchiveUri(uri);
  if (!parsed) throw new Error("bad archive path");
  const fmt = detectArchiveFormat(parsed.file);
  if (!fmt) throw new Error("not an archive");
  const which = deps?.which ?? Bun.which;
  if (selectArchiveLane(fmt, "extract", which) !== "spawn") throw new Error("no tar/unzip/7z to list this archive");
  const members = await listArchiveMembers(fmt, parsed.file, deps?.run, which);
  if (!members) throw new Error("can't list this archive");

  const inner = clean(parsed.inner);
  const prefix = inner ? `${inner}/` : "";
  const seen = new Map<string, ArchiveDirEntry>();
  for (const m of members) {
    let rel = m.name.replace(/^\.\//, "");
    if (prefix) {
      if (!rel.startsWith(prefix)) continue;
      rel = rel.slice(prefix.length);
    }
    rel = clean(rel);
    if (!rel) continue;
    const slash = rel.indexOf("/");
    const name = slash >= 0 ? rel.slice(0, slash) : rel;
    if (!name) continue;
    const isDir = slash >= 0 || m.dir;
    const existing = seen.get(name);
    if (existing) {
      if (isDir) existing.isDir = true;
      continue;
    }
    seen.set(name, {
      name,
      isDir,
      // size is a member's own (only when this IS the member, not a parent dir)
      ...(slash < 0 && m.size !== undefined ? { size: m.size } : {}),
      abs: archiveUri(parsed.file, inner ? `${inner}/${name}` : name),
    });
  }
  return [...seen.values()];
};
