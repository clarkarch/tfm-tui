// --- Plugin index: a small curated JSON catalog served from the project's
// GitHub Pages site, so `tfm plugins search/add <id>` works without a URL.
// Pure parsing/resolution (tested); the fetch is injected at the call site so
// tests never hit the network. An entry's url is validated with the same
// parseGitUrl the installer uses, so a bad index entry can't smuggle a
// file:///path. ---

import { parseGitUrl } from "./plugin-install";

export const PLUGIN_INDEX_URL = "https://clarkarch.github.io/tfm-tui/plugins.json";

export type PluginIndexEntry = {
  id: string;
  name: string;
  description: string;
  url: string;
  ref?: string;
  subdir?: string;
};

export const parsePluginIndex = (json: unknown): PluginIndexEntry[] => {
  const list = (json as { plugins?: unknown })?.plugins ?? json;
  if (!Array.isArray(list)) return [];
  const out: PluginIndexEntry[] = [];
  for (const raw of list) {
    if (typeof raw !== "object" || raw === null) continue;
    const e = raw as Record<string, unknown>;
    if (typeof e.id !== "string" || !e.id) continue;
    if (typeof e.url !== "string") continue;
    try {
      parseGitUrl(e.url); // throws on file://, bare paths, shell metachars
    } catch {
      continue;
    }
    out.push({
      id: e.id,
      name: typeof e.name === "string" && e.name ? e.name : e.id,
      description: typeof e.description === "string" ? e.description : "",
      url: e.url,
      ...(typeof e.ref === "string" ? { ref: e.ref } : {}),
      ...(typeof e.subdir === "string" ? { subdir: e.subdir } : {}),
    });
  }
  return out;
};

// the `URL[#ref] [subdir]` raw string installPlugin understands
export const indexEntryToRaw = (e: PluginIndexEntry): string =>
  `${e.url}${e.ref ? `#${e.ref}` : ""}${e.subdir ? ` ${e.subdir}` : ""}`;

export const findIndexEntry = (index: PluginIndexEntry[], id: string): PluginIndexEntry | null =>
  index.find((e) => e.id === id) ?? null;

// substring match over id/name/description (case-insensitive)
export const searchIndex = (index: PluginIndexEntry[], query: string): PluginIndexEntry[] => {
  const q = query.trim().toLowerCase();
  if (!q) return [...index];
  return index.filter((e) => `${e.id} ${e.name} ${e.description}`.toLowerCase().includes(q));
};

// `add <target>`: a real URL wins; otherwise treat the target as an index id
export const isGitUrl = (s: string): boolean => {
  try {
    parseGitUrl(s);
    return true;
  } catch {
    return false;
  }
};
