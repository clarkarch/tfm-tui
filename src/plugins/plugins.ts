// --- Plugin loader: one folder per plugin (plugins/<name>/<name>.ts;
// legacy flat plugins/<name>.ts auto-migrates on first scan). Each folder
// entry is content-hashed, staged under XDG_CACHE_HOME/tfm/plugin-build,
// dynamic-imported from the staged path, shape-validated, activated, and
// aggregated. Every plugin is isolated: a missing dir loads nothing, a broken
// plugin is recorded in errors + warned and never breaks its neighbors.
// No-restart semantics: added/removed/EDITED folders all reflect on the next
// rescan (the esc menu rescans on open) — staging defeats Bun's import cache
// (query strings don't bust it, probed 2026-09), so edits deactivate +
// re-activate live. Deleted state files reset to fallbacks via an mtime
// check. Settings persist per plugin as plugins/<name>/state.json, never in
// the core config TOML (the static config-schema can't take
// runtime-registered keys). ---

import type { Stats } from "node:fs";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { withTimeout } from "../lib/uiutil";
import { validateKeybindSpec } from "../config/config-schema";
import {
  PLUGIN_API_VERSION,
  PLUGIN_NAME_RE,
  type LoadedPlugin,
  type PluginApi,
  type PluginCommand,
  type PluginFileMenuEntry,
  type PluginModule,
  type PluginPreview,
  type PluginStore,
} from "./plugin-api";

// user plugin home: alongside config.toml (XDG_CONFIG_HOME aware so tests
// can sandbox it — never hardcode ~/.config)
export const pluginsDir = (): string => {
  const base = process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config");
  return path.join(base, "tfm", "plugins");
};

// staged build root for hot-reload: each plugin folder is content-hashed and
// copied here per version, then imported from the staged path. A new hash =>
// a new path => Bun's module cache misses and the edit loads live (query
// strings don't bust it, probed 2026-09). XDG_CACHE_HOME aware for tests.
export const pluginBuildDir = (): string => {
  const base = process.env.XDG_CACHE_HOME ?? path.join(os.homedir(), ".cache");
  return path.join(base, "tfm", "plugin-build");
};

// shared recursive walk for the plugin-folder passes: readdir sorted (stable
// hash order), lstat only — symlinks are never followed (a link to /etc must
// not leak outside content into the hash or the staged copy) — and missing
// dirs/entries are skipped. Visitors decide what each entry means (the
// hash/fingerprint passes skip state.json + symlinks; staging removes them).
type PluginWalkEntry = { full: string; name: string; st: Stats };

const walkPluginTree = (dir: string, visit: (e: PluginWalkEntry) => void): void => {
  let names: string[];
  try {
    names = readdirSync(dir).sort();
  } catch {
    return;
  }
  for (const name of names) {
    const full = path.join(dir, name);
    let st: Stats;
    try {
      st = lstatSync(full);
    } catch {
      continue;
    }
    visit({ full, name, st });
    if (st.isDirectory()) walkPluginTree(full, visit);
  }
};

// state.json is excluded — store writes must not look like code edits
const skipCodeEntry = (e: PluginWalkEntry): boolean => e.name === "state.json" || e.st.isSymbolicLink();

// content hash of a plugin folder (all files, sorted, content + name).
// Bounded: at most 1000 files / 10MB hashed.
export const hashPluginFolder = (folder: string): string => {
  const files: string[] = [];
  walkPluginTree(folder, (e) => {
    if (files.length > 1000 || skipCodeEntry(e)) return;
    if (e.st.isFile()) files.push(e.full);
  });
  const h = createHash("sha256");
  let bytes = 0;
  for (const f of files) {
    const rel = path.relative(folder, f);
    h.update(rel);
    h.update("\0");
    try {
      const data = readFileSync(f);
      bytes += data.length;
      if (bytes > 10 * 1024 * 1024) break;
      h.update(data);
    } catch {}
    h.update("\0");
  }
  return h.digest("hex").slice(0, 16);
};

// cheap folder fingerprint for the rescan fast path: max mtimeMs + file
// count over non-state, non-symlink files. Catches helper-file edits the old
// main-file-only check missed (P0-5) without paying the content hash.
const folderFingerprint = (folder: string): string => {
  let maxMtime = 0;
  let count = 0;
  walkPluginTree(folder, (e) => {
    if (skipCodeEntry(e) || !e.st.isFile()) return;
    count++;
    if (e.st.mtimeMs > maxMtime) maxMtime = e.st.mtimeMs;
  });
  return `${maxMtime}|${count}`;
};

// strip copied-through symlinks from a staged dir (cpSync preserves them as
// links — a staged link to /etc would resolve outside content at import).
// Best-effort; a failure leaves the link (import still sandboxed to the file).
const stripStagedSymlinks = (dest: string): void => {
  walkPluginTree(dest, (e) => {
    if (!e.st.isSymbolicLink()) return;
    try {
      rmSync(e.full, { force: true });
    } catch {}
  });
};

// copy a plugin folder to its hashed staging dir, prune older hashes for the
// same plugin, return the staged main-file path. Idempotent per hash.
// Takes a precomputed hash so callers that already hashed (the scan loop)
// don't pay twice (P1-13).
export const copyStagedPlugin = (srcFolder: string, name: string, hash: string, mainBase: string): string => {
  const root = pluginBuildDir();
  const dest = path.join(root, `${name}-${hash}`);
  const stagedMain = path.join(dest, mainBase);
  if (!existsSync(stagedMain)) {
    mkdirSync(root, { recursive: true });
    try {
      rmSync(dest, { recursive: true, force: true });
    } catch {}
    cpSync(srcFolder, dest, { recursive: true, filter: (s) => path.basename(s) !== "state.json" });
    stripStagedSymlinks(dest);
  }
  // prune sibling hashes for this plugin (keep current) — the old staged
  // modules stay in Bun's cache but unreferenced; disk stays bounded.
  // Exact `name-<16hex>` match: a startsWith check would delete sibling
  // plugin `a-b`'s builds when pruning `a`.
  const stagedRe = new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}-[0-9a-f]{16}$`);
  try {
    for (const entry of readdirSync(root)) {
      if (stagedRe.test(entry) && path.join(root, entry) !== dest) {
        try {
          rmSync(path.join(root, entry), { recursive: true, force: true });
        } catch {}
      }
    }
  } catch {}
  return stagedMain;
};

// state lives INSIDE the plugin folder (plugins/<name>/state.json) so a
// plugin is one self-contained directory
const statePath = (dir: string, name: string): string => {
  if (!PLUGIN_NAME_RE.test(name)) throw new Error(`unsafe plugin name: ${JSON.stringify(name)}`);
  return path.join(dir, name, "state.json");
};

// one-time move of the pre-folder-layout flat state (plugins/<name>.json)
const migrateState = (dir: string, name: string): void => {
  const next = statePath(dir, name); // validates eagerly
  const prev = path.join(dir, `${name}.json`);
  try {
    if (!existsSync(next) && existsSync(prev)) {
      mkdirSync(path.join(dir, name), { recursive: true });
      renameSync(prev, next);
    }
  } catch {}
};

const readState = (file: string): Record<string, unknown> => {
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (typeof parsed === "object" && parsed !== null) return parsed as Record<string, unknown>;
  } catch {}
  return {};
};

// synchronous store (see ./plugin-api): loads once, writes through
// atomically, and re-reads whenever the file's mtime moves under it — a
// deleted or externally rewritten state.json reflects immediately.
export const makePluginStore = (dir: string, name: string): PluginStore => {
  const file = statePath(dir, name); // validates eagerly
  migrateState(dir, name);
  // mtime of the last read; -1 = missing (deleted), -2 = never read
  let cache: Record<string, unknown> | null = null;
  let cacheMtime = -2;
  const load = (): Record<string, unknown> => {
    let mtime: number;
    try {
      mtime = statSync(file).mtimeMs;
    } catch {
      mtime = -1;
    }
    if (cache === null || mtime !== cacheMtime) {
      cache = mtime === -1 ? {} : readState(file);
      cacheMtime = mtime;
    }
    return cache;
  };
  const persist = (): void => {
    mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(cache, null, 2));
    renameSync(tmp, file);
    try {
      cacheMtime = statSync(file).mtimeMs;
    } catch {}
  };
  return {
    get: <T>(key: string, fallback: T): T => {
      const v: unknown = load()[key];
      return (v === undefined ? fallback : v) as T;
    },
    set: (key: string, value: unknown): void => {
      load()[key] = value;
      persist();
    },
  };
};

const isPluginModule = (mod: unknown): mod is PluginModule => {
  if (typeof mod !== "object" || mod === null) return false;
  const m = mod as Record<string, unknown>;
  return typeof m.name === "string" && typeof m.activate === "function";
};

type PluginScanDiff = {
  added: string[];
  removed: string[];
  changed: string[];
  errors: string[];
};

type PluginRegistry = {
  // live array — mutated in place on every scan so holders (settings model,
  // menu entries, api.commands merge) see adds/removes without re-wiring
  plugins: LoadedPlugin[];
  errors: string[];
  scan: () => Promise<PluginScanDiff>;
};

// one discoverable plugin: folders are canonical (<name>/<name>.ts), legacy
// flat files (<name>.ts) auto-migrate on sight. Keyed by main-file path.
type Discovered = { file: string };

const discoverPlugins = (
  dir: string,
  sinks: { warn(message: string): void; log(message: string): void },
): Discovered[] => {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return []; // no plugins dir yet — first run
  }
  const out: Discovered[] = [];
  const folderMains = new Set<string>();
  for (const name of [...names].sort()) {
    if (name.startsWith(".")) continue;
    let st: ReturnType<typeof statSync> | undefined;
    try {
      st = statSync(path.join(dir, name));
    } catch {
      continue;
    }
    if (!st.isDirectory()) continue;
    const main = path.join(dir, name, `${name}.ts`);
    if (existsSync(main)) {
      out.push({ file: main });
      folderMains.add(name);
    } else {
      sinks.warn(`plugin folder ${name}/ has no ${name}.ts — skipped`);
    }
  }
  for (const name of [...names].sort()) {
    if (!name.endsWith(".ts") || name.startsWith(".")) continue;
    const full = path.join(dir, name);
    let st: ReturnType<typeof statSync> | undefined;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (!st.isFile()) continue;
    const base = name.slice(0, -".ts".length);
    if (folderMains.has(base)) {
      sinks.warn(`plugin ${name} is shadowed by the ${base}/ folder — skipped`);
      continue;
    }
    // one-time move into the folder layout (logged, not warned: it happens
    // exactly once, then the flat file is gone)
    const target = path.join(dir, base, name);
    try {
      mkdirSync(path.join(dir, base), { recursive: true });
      renameSync(full, target);
      sinks.log(`plugin ${name} moved to ${base}/ (folder layout)`);
      out.push({ file: target });
    } catch (err) {
      sinks.warn(`plugin ${name} could not move to a folder: ${err instanceof Error ? err.message : err}`);
    }
  }
  return out.sort((a, b) => (a.file < b.file ? -1 : 1));
};

export const makePluginRegistry = (deps: {
  dir: string;
  api: PluginApi;
  warn(message: string): void;
}): PluginRegistry => {
  const { dir, api, warn } = deps;
  const plugins: LoadedPlugin[] = [];
  const errors: string[] = [];
  // main-path -> last-seen version; warned keys dedupe repeat toasts across
  // rescans (a persistently broken plugin warns once per distinct version)
  const snaps = new Map<string, { fp: string; hash: string; name: string }>();
  // one store instance per plugin name, shared across reloads and every
  // scopedApi — separate makePluginStore handles keep independent caches and
  // last-write-wins clobbers (P1-7). The cache is mtime-checked, so sharing
  // never serves stale state.json.
  const stores = new Map<string, PluginStore>();
  const storeFor = (name: string): PluginStore => {
    let s = stores.get(name);
    if (!s) {
      s = makePluginStore(dir, name);
      stores.set(name, s);
    }
    return s;
  };
  const warned = new Set<string>();
  const warnOnce = (key: string, message: string): void => {
    if (warned.has(key)) return;
    warned.add(key);
    try {
      warn(message);
    } catch {}
  };

  const loadOne = async (stagedFile: string, originalFile: string): Promise<LoadedPlugin> => {
    const mod: unknown = (await import(pathToFileURL(stagedFile).href)).default;
    if (!isPluginModule(mod)) throw new Error(`default export must be { name, activate }`);
    if (!PLUGIN_NAME_RE.test(mod.name)) throw new Error(`unsafe plugin name: ${JSON.stringify(mod.name)}`);
    const m = mod as PluginModule & { minApiVersion?: unknown; apiVersion?: unknown };
    if (typeof m.minApiVersion === "number" && PLUGIN_API_VERSION < m.minApiVersion) {
      throw new Error(`requires apiVersion >= ${m.minApiVersion} (core is ${PLUGIN_API_VERSION})`);
    }
    if (typeof m.apiVersion === "number" && m.apiVersion !== PLUGIN_API_VERSION) {
      warn(`plugin ${m.name}: apiVersion ${m.apiVersion} != ${PLUGIN_API_VERSION} (loading anyway)`);
    }
    // namespaced store: every plugin gets ONLY its own store, whatever name
    // it asks for (cross-plugin state reads warn and return the caller's own).
    const ownStore = storeFor(m.name);
    const scopedApi: PluginApi = {
      ...api,
      store: (requested: string) => {
        if (requested !== m.name) {
          try {
            api.log(`plugin ${m.name} asked for store(${JSON.stringify(requested)}) — returning its own store`);
          } catch {}
        }
        return ownStore;
      },
    };
    // a hanging activate must not stall the whole rescan (esc-menu reload
    // would never settle) — 10s cap, timer cleaned up via withTimeout.
    const result =
      (await withTimeout(
        Promise.resolve().then(() => mod.activate(scopedApi)),
        10000,
      )) ?? {};
    const fileMenu = result.fileMenu ?? null;
    if (fileMenu !== null && typeof fileMenu !== "function") throw new Error(`fileMenu must be a function`);
    const sidebarMenu = result.sidebarMenu ?? null;
    if (sidebarMenu !== null && typeof sidebarMenu !== "function") throw new Error(`sidebarMenu must be a function`);
    const emptyAreaMenu = result.emptyAreaMenu ?? null;
    if (emptyAreaMenu !== null && typeof emptyAreaMenu !== "function")
      throw new Error(`emptyAreaMenu must be a function`);
    const rawPreview = result.preview ?? [];
    if (!Array.isArray(rawPreview)) throw new Error(`preview must be an array`);
    // malformed preview entries drop individually — one bad ext list must not
    // sink the plugin's good ones. exts normalized lowercase without dots.
    const preview = (rawPreview as unknown[]).flatMap((raw): PluginPreview[] => {
      if (typeof raw !== "object" || raw === null) return [];
      const r = raw as { exts?: unknown; render?: unknown };
      if (!Array.isArray(r.exts) || !r.exts.length || !r.exts.every((e) => typeof e === "string")) return [];
      if (typeof r.render !== "function") return [];
      const exts = (r.exts as string[]).map((e) => e.toLowerCase().replace(/^\./, "")).filter(Boolean);
      if (!exts.length) return [];
      return [{ exts, render: r.render as (path: string) => string | Promise<string> }];
    });
    const rawCommands = result.commands ?? [];
    if (!Array.isArray(rawCommands)) throw new Error(`commands must be an array`);
    // malformed command entries drop individually (like fileMenu entries at
    // use time) — one bad item must not sink the plugin's good ones.
    // defaultBinds must be string[] of VALID specs when present: an unvalidated
    // default like ["j"] would dispatch before type-to-search and swallow
    // plain typing (P0-7). Invalid entries drop the whole command with a log.
    // Conflicts stay core-wins at dispatch (shadowed until remapped).
    // Non-namespaced ids warn.
    const commands = (rawCommands as unknown[]).flatMap((raw): PluginCommand[] => {
      if (
        typeof raw !== "object" ||
        raw === null ||
        typeof (raw as { id: unknown }).id !== "string" ||
        typeof (raw as { title: unknown }).title !== "string" ||
        typeof (raw as { run: unknown }).run !== "function"
      ) {
        return [];
      }
      const c = raw as PluginCommand;
      if (!c.id.startsWith(`${m.name}:`)) {
        try {
          api.log(`plugin ${m.name}: command id ${JSON.stringify(c.id)} should be namespaced ("${m.name}:verb")`);
        } catch {}
      }
      let defaultBinds: string[] | undefined;
      if (c.defaultBinds !== undefined) {
        if (!Array.isArray(c.defaultBinds) || !c.defaultBinds.every((s) => typeof s === "string")) return [];
        const bad = (c.defaultBinds as string[]).find((s) => validateKeybindSpec(s) !== null);
        if (bad !== undefined) {
          try {
            api.log(
              `plugin ${m.name}: command ${JSON.stringify(c.id)} defaultBind ${JSON.stringify(bad)} invalid (${validateKeybindSpec(bad)}) — entry dropped`,
            );
          } catch {}
          return [];
        }
        defaultBinds = [...c.defaultBinds];
      }
      return [
        {
          id: c.id,
          title: c.title,
          ...(typeof c.hint === "string" ? { hint: c.hint } : {}),
          run: c.run,
          ...(defaultBinds ? { defaultBinds } : {}),
        },
      ];
    });
    const deactivate =
      typeof result.deactivate === "function"
        ? result.deactivate
        : typeof (mod as { deactivate?: unknown }).deactivate === "function"
          ? ((mod as { deactivate: () => void | Promise<void> }).deactivate as () => void | Promise<void>)
          : null;
    return {
      name: mod.name,
      rows: result.rows ?? [],
      fileMenu: fileMenu as ((sel: { paths: string[] }) => PluginFileMenuEntry[]) | null,
      sidebarMenu: sidebarMenu as ((place: { path?: string | null; scheme?: string }) => PluginFileMenuEntry[]) | null,
      emptyAreaMenu: emptyAreaMenu as ((area: { cwd: string }) => PluginFileMenuEntry[]) | null,
      commands,
      preview,
      store: ownStore,
      deactivate,
      file: originalFile,
    };
  };

  // best-effort teardown: never throws, never blocks the scan (5s cap, timer
  // cleaned up on both paths via withTimeout — a bare Promise.race leaks the
  // timeout handle on success and holds the event loop per unload).
  const runDeactivate = async (p: LoadedPlugin): Promise<void> => {
    if (!p.deactivate) return;
    try {
      await withTimeout(
        Promise.resolve().then(() => p.deactivate!()),
        5000,
      );
    } catch (err) {
      try {
        api.log(`plugin ${p.name} deactivate failed: ${err instanceof Error ? err.message : err}`);
      } catch {}
    }
  };

  const scan = async (): Promise<PluginScanDiff> => {
    const diff: PluginScanDiff = { added: [], removed: [], changed: [], errors: [] };
    const found = discoverPlugins(dir, {
      warn: (m) => warnOnce(`discover:${m}`, m),
      log: (m) => api.log(m),
    });
    const seen = new Set(plugins.map((p) => p.name));
    const live = new Set<string>();
    // rm a staged build dir when no live snap references its hash (failed
    // loads must not litter plugin-build; P1-12).
    const pruneUnreferencedStage = (folderName: string, hash: string): void => {
      for (const s of snaps.values()) if (s.hash === hash) return;
      try {
        rmSync(path.join(pluginBuildDir(), `${folderName}-${hash}`), { recursive: true, force: true });
      } catch {}
    };
    for (const { file } of found) {
      live.add(file);
      const srcFolder = path.dirname(file);
      const mainBase = path.basename(file);
      const folderName = path.basename(srcFolder);
      // fast path: folder fingerprint (max mtime + count, state.json and
      // symlinks excluded) catches helper-file edits the old main-file-only
      // check missed, without paying the content hash (P0-5).
      let fp: string;
      try {
        fp = folderFingerprint(srcFolder);
      } catch {
        continue;
      }
      const prev = snaps.get(file);
      if (prev && prev.fp === fp) continue;
      // warn key must change per content version, or repeat failures dedupe
      // against the first version's key and go silent (warnOnce).
      let hash: string;
      try {
        hash = hashPluginFolder(srcFolder);
      } catch (err) {
        const message = `plugin ${path.basename(file)} failed to reload: ${err instanceof Error ? err.message : err}`;
        diff.errors.push(message);
        warnOnce(`${file}|${fp}|hash`, message);
        continue;
      }
      if (prev && hash === prev.hash) {
        prev.fp = fp;
        continue;
      }
      const vkey = `${file}|${hash}`;
      if (!prev) {
        try {
          const staged = copyStagedPlugin(srcFolder, folderName, hash, mainBase);
          const lp = await loadOne(staged, file);
          if (seen.has(lp.name)) throw new Error(`duplicate plugin name ${JSON.stringify(lp.name)} (first file wins)`);
          seen.add(lp.name);
          plugins.push(lp);
          snaps.set(file, { fp, hash, name: lp.name });
          diff.added.push(lp.name);
        } catch (err) {
          pruneUnreferencedStage(folderName, hash);
          const message = `plugin ${path.basename(file)} failed to load: ${err instanceof Error ? err.message : err}`;
          diff.errors.push(message);
          warnOnce(vkey, message);
        }
        continue;
      }
      // content change => hot-reload via a fresh staged path (defeats Bun's
      // import cache). Load the new instance FIRST, then deactivate the old
      // and splice: a throwing reload keeps the old instance fully live
      // (deactivate-first would leave a dead-but-listed corpse). The overlap
      // window is benign — commands/rows only appear at splice, stores are
      // the shared memoized instance, and only events emitted mid-activate
      // could double-fire.
      try {
        const staged = copyStagedPlugin(srcFolder, folderName, hash, mainBase);
        const lp = await loadOne(staged, file);
        // name change across reload: keep first-wins semantics
        if (lp.name !== prev.name && seen.has(lp.name)) {
          pruneUnreferencedStage(folderName, hash);
          throw new Error(`duplicate plugin name ${JSON.stringify(lp.name)} (first file wins)`);
        }
        const idx = plugins.findIndex((p) => p.name === prev.name);
        const old = idx >= 0 ? plugins[idx] : undefined;
        if (old) await runDeactivate(old);
        if (idx >= 0) plugins.splice(idx, 1, lp);
        else plugins.push(lp);
        seen.delete(prev.name);
        seen.add(lp.name);
        prev.fp = fp;
        prev.hash = hash;
        prev.name = lp.name;
        diff.changed.push(lp.name);
        try {
          api.log(`plugin ${lp.name} reloaded`);
        } catch {}
      } catch (err) {
        pruneUnreferencedStage(folderName, hash);
        // fp intentionally left stale so the next rescan retries (transient
        // errors self-heal); a real content change alters fp anyway.
        const message = `plugin ${path.basename(file)} failed to reload: ${err instanceof Error ? err.message : err}`;
        diff.errors.push(message);
        warnOnce(vkey, message);
      }
    }
    for (const [file, snap] of [...snaps]) {
      if (live.has(file)) continue;
      snaps.delete(file);
      const i = plugins.findIndex((p) => p.name === snap.name);
      if (i >= 0) {
        const [gone] = plugins.splice(i, 1);
        if (gone) await runDeactivate(gone);
      }
      diff.removed.push(snap.name);
      for (const k of [...warned]) if (k.startsWith(file)) warned.delete(k);
    }
    errors.length = 0;
    errors.push(...diff.errors);
    return diff;
  };

  return { plugins, errors, scan };
};
