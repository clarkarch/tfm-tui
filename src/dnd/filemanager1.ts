import path from "node:path";
import { fileUriToPath } from "../fs/uri";

// --- Pure org.freedesktop.FileManager1 call planner. D-Bus ShowItems /
// ShowFolders URIs become per-directory open plans ({dir, select}); the
// daemon opens one tfm per plan and the existing file-launch path
// (pendingSelect) highlights the file. No dbus import here — frames and
// the bus stay in the service module; this is unit-testable planning. ---

export type ShowPlan = { dir: string; select: string | null };

const toPath = (uri: string): string | null => {
  if (!uri.startsWith("file://")) return null;
  try {
    const p = fileUriToPath(uri);
    return p.startsWith("/") ? p : null;
  } catch {
    return null;
  }
};

// ShowItems: every URI names an ITEM — files highlight inside their parent
// dir (first file per dir wins; the spec leaves multi-item behavior to the
// implementation), trailing-slash URIs open as plain dirs. No stat, no
// extension sniffing: ShowItems means "this item", so the path IS the
// highlight and the parent IS the dir. (The file-launch path re-derives
// parent/select itself, so even a dir passed without a slash opens right.)
export const planShowItems = (uris: string[]): ShowPlan[] => {
  const plans: ShowPlan[] = [];
  const seenDir = new Set<string>();
  for (const uri of uris) {
    const p = toPath(uri);
    if (!p) continue;
    const isDir = uri.endsWith("/");
    const clean = isDir ? p.replace(/\/+$/, "") || "/" : p;
    const dir = isDir ? clean : path.dirname(p);
    if (seenDir.has(dir)) continue;
    seenDir.add(dir);
    plans.push({ dir, select: isDir ? null : p });
  }
  return plans;
};

// ShowFolders: every URI opens as a folder; files degrade to their parent
// (a folder view can't highlight). Deduped by dir.
export const planShowFolders = (uris: string[]): ShowPlan[] => {
  const plans: ShowPlan[] = [];
  const seen = new Set<string>();
  for (const uri of uris) {
    const p = toPath(uri);
    if (!p) continue;
    const base = path.basename(p.replace(/\/+$/, ""));
    const dir = uri.endsWith("/") || !base.includes(".") ? p.replace(/\/+$/, "") || "/" : path.dirname(p);
    if (seen.has(dir)) continue;
    seen.add(dir);
    plans.push({ dir, select: null });
  }
  return plans;
};
