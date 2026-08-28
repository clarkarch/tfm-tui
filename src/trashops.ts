import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { fsErrText, fsMove, trashDir, uniqueTarget, xdgTrashMove, safeRestoreMove } from "./fsutil";

// --- Trash operations: trash / restore / delete-forever / empty. The fs
// primitives come from fsutil; UI feedback (status, notifications, refresh)
// and the undo stack arrive through an injected sink, so this module never
// touches the renderer or app state. ---

export type UndoPair = () => Promise<void> | void;

export type TrashOpsSink = {
  /** push a completed undo batch (already paired with redos) */
  pushUndoBatch(label: string, units: UndoPair[], redos: UndoPair[]): void;
  /** status bar one-liner */
  status(msg: string): void;
  /** toast notification */
  notify(msg: string, title?: string): void;
  /** schedule a grid refresh */
  refresh(): void;
};

// XDG trashinfo -> original absolute path. Spec says URL-encoded; nautilus
// writes bare encoded abs paths (and sometimes file:// URIs).
export const trashOrigPath = async (name: string): Promise<string | null> => {
  try {
    const raw = await readFile(path.join(trashDir(), "info", `${name}.trashinfo`), "utf8");
    const m = raw.match(/^Path=(.+)$/m);
    if (!m?.[1]) return null;
    let p = m[1].trim();
    if (p.startsWith("file://")) p = p.slice(7);
    try { p = decodeURIComponent(p); } catch {}
    return path.resolve(p);
  } catch { return null; }
};

export const makeTrashOps = (sink: TrashOpsSink) => {
  const trashPaths = (paths: string[]): void => {
    void (async () => {
      const units: UndoPair[] = [];
      const redos: UndoPair[] = [];
      let ok = 0;
      const failWhy = new Set<string>();
      for (const p of paths) {
        // always trash via our own xdg path: we control the final name, so the
        // undo unit pairs deterministically (a before/after listing diff could
        // mis-pair when something else trashes a similar name concurrently)
        try {
          const loc = await xdgTrashMove(p);
          const hit = path.basename(loc);
          const from = path.join(trashDir(), "files", hit);
          units.push(async () => {
            await safeRestoreMove(from, p);
            try { await rm(path.join(trashDir(), "info", `${hit}.trashinfo`)); } catch {}
          });
          redos.push(async () => { try { if (existsSync(p)) await xdgTrashMove(p); } catch {} });
          ok++;
        } catch (err) { failWhy.add(fsErrText(err)); }
      }
      sink.pushUndoBatch(`trash ${ok} item${ok === 1 ? "" : "s"}`, units, redos);
      sink.refresh();
      const failed = paths.length - ok;
      const why = [...failWhy][0];
      const summary = failed
        ? `Trashed ${ok}/${paths.length} · ${failed} FAILED${why ? ` (${why})` : ""}`
        : `Trashed ${ok} item${ok === 1 ? "" : "s"}`;
      sink.status(ok === paths.length ? `${summary} · ctrl+z to undo` : summary);
      if (failed > 0) sink.notify(summary, "trash failed");
      else sink.notify(`${summary} · ctrl+z to undo`, "trash");
    })();
  };

  const restoreFromTrash = (paths: string[]): void => {
    void (async () => {
      let ok = 0;
      const failWhy = new Set<string>();
      for (const src of paths) {
        const orig = await trashOrigPath(path.basename(src));
        if (!orig) { failWhy.add("no trashinfo"); continue; }
        try {
          await mkdir(path.dirname(orig), { recursive: true });
          let dest = orig;
          if (existsSync(dest)) dest = uniqueTarget(path.dirname(dest), path.basename(dest));
          await fsMove(src, dest);
          try { await rm(path.join(trashDir(), "info", `${path.basename(src)}.trashinfo`)); } catch {}
          ok++;
        } catch (err) { failWhy.add(fsErrText(err)); }
      }
      sink.refresh();
      const failed = paths.length - ok;
      const why = [...failWhy][0];
      const summary = `Restored ${ok} of ${paths.length}${failed ? ` · ${failed} FAILED${why ? ` (${why})` : ""}` : ""}`;
      sink.status(summary);
      sink.notify(summary, failed ? "restore failed" : "restore");
    })();
  };

  const deleteForever = (paths: string[]): void => {
    void (async () => {
      let ok = 0;
      const failWhy = new Set<string>();
      for (const p of paths) {
        try {
          await rm(p, { recursive: true });
          try { await rm(path.join(trashDir(), "info", `${path.basename(p)}.trashinfo`)); } catch {}
          ok++;
        } catch (err) { failWhy.add(fsErrText(err)); }
      }
      sink.refresh();
      const failed = paths.length - ok;
      const why = [...failWhy][0];
      const summary = `Deleted ${ok} of ${paths.length}${failed ? ` · ${failed} FAILED${why ? ` (${why})` : ""}` : ""}`;
      sink.status(summary);
      sink.notify(summary, failed ? "delete failed" : "delete");
    })();
  };

  const emptyTrash = (): void => {
    void (async () => {
      const filesDir = path.join(trashDir(), "files");
      let names: string[];
      try { names = await readdir(filesDir); } catch (err) {
        sink.refresh();
        sink.notify(`Could not read trash (${fsErrText(err)})`, "empty failed");
        sink.status("Trash unreadable");
        return;
      }
      let n = 0;
      const failWhy = new Set<string>();
      for (const k of names) {
        try {
          await rm(path.join(filesDir, k), { recursive: true });
          try { await rm(path.join(trashDir(), "info", `${k}.trashinfo`)); } catch {}
          n++;
        } catch (err) { failWhy.add(fsErrText(err)); }
      }
      sink.refresh();
      const failed = names.length - n;
      const why = [...failWhy][0];
      if (failed > 0) {
        sink.notify(`Emptied ${n}/${names.length} · ${failed} FAILED${why ? ` (${why})` : ""}`, "empty failed");
        sink.status(`Trash partially emptied (${n}/${names.length})`);
        return;
      }
      sink.notify(`Emptied ${n} item${n === 1 ? "" : "s"}`, "trash");
      sink.status(`Trash emptied (${n})`);
    })();
  };

  return { trashPaths, restoreFromTrash, deleteForever, emptyTrash };
};
