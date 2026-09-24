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
import { validateKeybindSpec } from "../config/keyspec";
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
import { isValidSettingRow, type SettingRow } from "../config/config-schema";

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

// state.json is excluded — store writes must not look like code edits. The
// `<pid>.tmp` sibling of an interrupted atomic write is excluded too, or a
// crash would fold it into the folder hash/fingerprint and the staged copy.
const isStateEntry = (name: string): boolean => name === "state.json" || name.startsWith("state.json.");
const skipCodeEntry = (e: PluginWalkEntry): boolean => isStateEntry(e.name) || e.st.isSymbolicLink();

// content hash of a plugin folder (all files, sorted, content + name).
// Bounded: at most 1000 files / 10MB hashed. Beyond-cap files can't be
// content-hashed (that defeats the cap), so their PATHS fold into the hash —
// an add/remove/rename past the cap still changes it (a content-only edit
// there still misses; the cap is the tradeoff).
export const hashPluginFolder = (folder: string): string => {
  const files: string[] = [];
  const tailNames: string[] = [];
  walkPluginTree(folder, (e) => {
    if (skipCodeEntry(e)) return;
    if (e.st.isFile()) {
      if (files.length >= 1000) tailNames.push(path.relative(folder, e.full));
      else files.push(e.full);
    }
  });
  const h = createHash("sha256");
  let bytes = 0;
  let cutByteCap = false;
  for (const f of files) {
    const rel = path.relative(folder, f);
    h.update(rel);
    h.update("\0");
    try {
      const data = readFileSync(f);
      if (bytes + data.length > 10 * 1024 * 1024) {
        cutByteCap = true;
        tailNames.push(rel);
        continue;
      }
      bytes += data.length;
      h.update(data);
    } catch {}
    h.update("\0");
  }
  if (cutByteCap || tailNames.length) {
    h.update(`truncated:${tailNames.sort().join("\0")}`);
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

// remove every staged build dir for a plugin (optionally keeping one). Exact
// `name-<16hex>` match: a startsWith check would delete sibling plugin `a-b`'s
// builds when pruning `a`. Used on reload (keep current) and on remove/uninstall
// (keep none) so plugin-build doesn't grow without bound across install cycles.
const pruneStagedFor = (name: string, except?: string): void => {
  const root = pluginBuildDir();
  const stagedRe = new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}-[0-9a-f]{16}$`);
  try {
    for (const entry of readdirSync(root)) {
      if (stagedRe.test(entry) && (!except || entry !== except)) {
        try {
          rmSync(path.join(root, entry), { recursive: true, force: true });
        } catch {}
      }
    }
  } catch {}
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
    cpSync(srcFolder, dest, { recursive: true, filter: (s) => !isStateEntry(path.basename(s)) });
    stripStagedSymlinks(dest);
  }
  // prune sibling hashes for this plugin (keep current) — the old staged
  // modules stay in Bun's cache but unreferenced; disk stays bounded.
  pruneStagedFor(name, `${name}-${hash}`);
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
  // best-effort quit teardown: quit is synchronous (process.exit kills pending
  // async IO), so the returned promises are NOT awaited — only a deactivate's
  // sync prefix runs. Remove/reload use the awaited path below.
  deactivateAll: () => void;
  // Plugins-view on/off: register/unregister the named plugin's slots so a
  // disabled plugin stops contributing UI immediately (store flag is written
  // by the caller). No-op for unknown names / plugins with no slots.
  setSlotEnabled: (name: string, enabled: boolean) => void;
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
  // bridge a plugin's `slots` contribution into the OpenTUI slot registry.
  // Returns an unregister fn stored as LoadedPlugin.disposeSlots.
  registerSlots?: (name: string, slots: Record<string, unknown>) => () => void;
}): PluginRegistry => {
  const { dir, api, warn, registerSlots } = deps;
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

  const loadOne = async (
    stagedFile: string,
    originalFile: string,
    rejectDuplicate?: (name: string) => boolean,
  ): Promise<LoadedPlugin> => {
    const mod: unknown = (await import(pathToFileURL(stagedFile).href)).default;
    if (!isPluginModule(mod)) throw new Error(`default export must be { name, activate }`);
    if (!PLUGIN_NAME_RE.test(mod.name)) throw new Error(`unsafe plugin name: ${JSON.stringify(mod.name)}`);
    // duplicate check BEFORE activate: a rejected duplicate must never have
    // run (its listeners/timers/slots would be live forever — the loaded
    // instance is discarded and runDeactivate never sees it)
    if (rejectDuplicate?.(mod.name)) {
      throw new Error(`duplicate plugin name ${JSON.stringify(mod.name)} (first file wins)`);
    }
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
    // live enabled read for the push/veto channels: a plugin toggled off in
    // the Plugins view must stop receiving events and stop vetoing file ops
    // immediately, not next restart. A throwing store read degrades to on.
    const pluginOn = (): boolean => {
      try {
        return ownStore.get("enabled", true);
      } catch {
        return true;
      }
    };
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
      // gate the push/veto channels on the live flag (the unsubscribe stays
      // the plugin's own; we only drop delivery while disabled)
      events: {
        ...api.events,
        on: (evt, cb) =>
          api.events.on(evt, (payload) => {
            if (pluginOn()) cb(payload);
          }),
      },
      hooks: {
        beforeFileOp: (fn) => api.hooks.beforeFileOp((payload) => (pluginOn() ? fn(payload) : undefined)),
      },
    };
    // teardown is resolved BEFORE the post-activate validation below: any throw
    // there must still tear down an already-activated plugin. It never reaches
    // `plugins`, so deactivateAll can't see it — its event/hook listeners,
    // timers and slots would leak on every rescan forever (the exact failure
    // class the duplicate check above guards against).
    let deactivate: (() => void | Promise<void>) | null =
      typeof (mod as { deactivate?: unknown }).deactivate === "function"
        ? (mod as { deactivate: () => void | Promise<void> }).deactivate
        : null;
    let disposeSlots: (() => void) | null = null;
    try {
      // a hanging activate must not stall the whole rescan (esc-menu reload
      // would never settle) — 10s cap, timer cleaned up via withTimeout.
      const result =
        (await withTimeout(
          Promise.resolve().then(() => mod.activate(scopedApi)),
          10000,
        )) ?? {};
      if (typeof result.deactivate === "function") deactivate = result.deactivate;
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
      const meta = (v: unknown): string => (typeof v === "string" ? v.slice(0, 200) : "");
      // OpenTUI slot contributions (statusbar / sidebar-footer). Registering is
      // isolated: a throw drops just the slots, never the plugin.
      const clean: Record<string, unknown> = {};
      if (result.slots !== undefined) {
        if (typeof result.slots !== "object" || result.slots === null || Array.isArray(result.slots)) {
          throw new Error(`slots must be an object`);
        }
        // per-entry validation (mirrors preview/commands): a slot value must be
        // a renderer function or a managed `{ render }` object; bad ones drop.
        for (const [key, val] of Object.entries(result.slots as Record<string, unknown>)) {
          const ok =
            typeof val === "function" ||
            (typeof val === "object" && val !== null && typeof (val as { render?: unknown }).render === "function");
          if (!ok) {
            try {
              api.log(`plugin ${m.name}: slot ${JSON.stringify(key)} invalid — dropped`);
            } catch {}
            continue;
          }
          clean[key] = val;
        }
        // register only when enabled; a disabled plugin's slots are retained on
        // the LoadedPlugin so re-enabling can register without a re-activate
        if (pluginOn() && registerSlots && Object.keys(clean).length) {
          try {
            disposeSlots = registerSlots(m.name, clean);
          } catch (err) {
            try {
              api.log(`plugin ${m.name} slots failed to register: ${err instanceof Error ? err.message : err}`);
            } catch {}
          }
        }
      }
      const rawRows = result.rows ?? [];
      if (!Array.isArray(rawRows)) throw new Error(`rows must be an array`);
      const rows = (rawRows as unknown[]).filter((r): r is SettingRow => {
        if (isValidSettingRow(r)) return true;
        try {
          api.log(
            `plugin ${m.name}: settings row ${JSON.stringify((r as { label?: unknown })?.label ?? "<unnamed>")} invalid — dropped`,
          );
        } catch {}
        return false;
      });
      return {
        name: mod.name,
        version: meta(m.version),
        author: meta(m.author),
        description: meta(m.description),
        rows,
        fileMenu: fileMenu as ((sel: { paths: string[] }) => PluginFileMenuEntry[]) | null,
        sidebarMenu: sidebarMenu as
          | ((place: { path?: string | null; scheme?: string }) => PluginFileMenuEntry[])
          | null,
        emptyAreaMenu: emptyAreaMenu as ((area: { cwd: string }) => PluginFileMenuEntry[]) | null,
        commands,
        preview,
        store: ownStore,
        deactivate,
        disposeSlots,
        slots: Object.keys(clean).length ? clean : null,
        file: originalFile,
      };
    } catch (err) {
      // activate already ran (or the post-activate validation threw): tear the
      // partial instance down or its listeners/timers/slots leak forever — it
      // is never pushed to `plugins`, so deactivateAll can't reach it.
      try {
        disposeSlots?.();
      } catch {}
      const fn = deactivate;
      if (fn) {
        try {
          await withTimeout(
            Promise.resolve().then(() => fn()),
            5000,
          );
        } catch {}
      }
      throw err;
    }
  };

  // best-effort teardown: never throws, never blocks the scan (5s cap, timer
  // cleaned up on both paths via withTimeout — a bare Promise.race leaks the
  // timeout handle on success and holds the event loop per unload).
  const runDeactivate = async (p: LoadedPlugin): Promise<void> => {
    try {
      p.disposeSlots?.();
    } catch {}
    const fn = p.deactivate;
    if (!fn) return;
    try {
      await withTimeout(
        Promise.resolve().then(() => fn()),
        5000,
      );
    } catch (err) {
      try {
        api.log(`plugin ${p.name} deactivate failed: ${err instanceof Error ? err.message : err}`);
      } catch {}
    }
  };

  // quit teardown: call every deactivate synchronously (promises ignored) so a
  // sync prefix flushes before process.exit. Async cleanup must use
  // events.on("quit") — see docs/plugins.md.
  const deactivateAll = (): void => {
    for (const p of [...plugins]) {
      try {
        p.disposeSlots?.();
      } catch {}
      if (!p.deactivate) continue;
      try {
        const r = p.deactivate();
        if (r instanceof Promise) void r.catch(() => {});
      } catch (err) {
        try {
          api.log(`plugin ${p.name} deactivate failed: ${err instanceof Error ? err.message : err}`);
        } catch {}
      }
    }
  };

  const doScan = async (): Promise<PluginScanDiff> => {
    const diff: PluginScanDiff = { added: [], removed: [], changed: [], errors: [] };
    const found = discoverPlugins(dir, {
      warn: (m) => warnOnce(`discover:${m}`, m),
      log: (m) => api.log(m),
    });
    const live = new Set(found.map((f) => f.file));
    // rm a staged build dir when no live snap references its hash (failed
    // loads must not litter plugin-build; P1-12).
    const pruneUnreferencedStage = (folderName: string, hash: string): void => {
      for (const s of snaps.values()) if (s.hash === hash) return;
      try {
        rmSync(path.join(pluginBuildDir(), `${folderName}-${hash}`), { recursive: true, force: true });
      } catch {}
    };
    // REMOVALS FIRST: a renamed folder is a NEW file, and loading it before
    // retiring the old name trips the duplicate check against the plugin's own
    // previous name (a load-late + misleading "duplicate plugin name" error).
    for (const [file, snap] of [...snaps]) {
      if (live.has(file)) continue;
      snaps.delete(file);
      const i = plugins.findIndex((p) => p.name === snap.name);
      if (i >= 0) {
        const [gone] = plugins.splice(i, 1);
        if (gone) await runDeactivate(gone);
      }
      // drop every staged build for the removed folder (uninstall/rename) so
      // $XDG_CACHE_HOME/tfm/plugin-build doesn't grow across install cycles
      pruneStagedFor(path.basename(path.dirname(file)));
      diff.removed.push(snap.name);
      for (const k of [...warned]) if (k.startsWith(file)) warned.delete(k);
    }
    const seen = new Set(plugins.map((p) => p.name));
    for (const { file } of found) {
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
          const lp = await loadOne(staged, file, (name) => seen.has(name));
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
        // name change across reload: keep first-wins semantics (pre-empts
        // activate like the fresh-path duplicate check)
        const lp = await loadOne(staged, file, (name) => name !== prev.name && seen.has(name));
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
    errors.length = 0;
    errors.push(...diff.errors);
    return diff;
  };

  // one scan at a time: reloadPlugins() fires from esc-menu open AND from
  // install/update/remove, so overlapping rescans could both pass the prev
  // check and double-load (duplicate listeners/slots). Callers share the
  // in-flight pass; a rejection is delivered to all of them and the slot frees.
  let scanning: Promise<PluginScanDiff> | null = null;
  const scan = (): Promise<PluginScanDiff> => {
    if (scanning) return scanning;
    scanning = doScan().finally(() => {
      scanning = null;
    });
    return scanning;
  };

  // Plugins-view enable/disable: register or unregister a plugin's slots so a
  // toggled-off plugin stops contributing UI immediately (registering only at
  // load would leave its slot live until restart). Store writes stay with the
  // caller (settings-model owns the flag).
  const setSlotEnabled = (name: string, enabled: boolean): void => {
    const p = plugins.find((x) => x.name === name);
    if (!p) return;
    if (!enabled) {
      try {
        p.disposeSlots?.();
      } catch {}
      p.disposeSlots = null;
      return;
    }
    if (!p.disposeSlots && registerSlots && p.slots && Object.keys(p.slots).length) {
      try {
        p.disposeSlots = registerSlots(p.name, p.slots);
      } catch (err) {
        try {
          api.log(`plugin ${p.name} slots failed to register: ${err instanceof Error ? err.message : err}`);
        } catch {}
      }
    }
  };

  return { plugins, errors, scan, deactivateAll, setSlotEnabled };
};
