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
  closeSync,
  cpSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { withTimeout, errMessage } from "../lib/uiutil";
import { errCode } from "../fs/fsutil";
import { validateKeybindSpec } from "../config/keyspec";
import {
  PLUGIN_API_VERSION,
  PLUGIN_NAME_RE,
  isPluginEnabled,
  type LoadedPlugin,
  type PluginApi,
  type PluginCommand,
  type PluginFileMenuEntry,
  type PluginModule,
  type PluginPreview,
  type PluginStore,
} from "./plugin-api";
import { normalizeSettingRow, type SettingRow } from "../config/config-schema";

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
  const h = new Bun.CryptoHasher("sha256");
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

// The store's cache — ONE tagged record. The old shape encoded three phases
// as a NUMBER that was otherwise a timestamp (-2 = never read, -1 = missing,
// else the file's mtime) plus a parallel `cache === null` flag for the same
// "unloaded" phase: the two could disagree, and a FAILED probe was read as
// "missing" — the same fact as a deleted file. Two live bugs came out of
// that: a failed probe replaced the cache with {} (the next write persisted
// a TRUNCATED state — every other key was lost), and a write whose
// post-rename probe failed left the cached mtime saying "missing" (a later
// deletion was invisible and the stale cache was served).
//
// The phases are about WHAT WE KNOW:
//   unread  — nothing established (never probed, or the probe failed)
//   missing — the file is gone (ENOENT); the data is a fresh empty view
//   loaded  — the contents were read at mtime M (fresh for that stamp)
//   written — the contents are OURS (we just wrote them) but the stamp is
//             unknown (the post-write probe failed) → the next successful
//             probe re-reads the file
// The "missing"/"written" arms carry the data because the write path
// MUTATES the object the read returns (a missing file still has a pending
// view).
type StoreState =
  | { kind: "unread" }
  | { kind: "missing"; data: Record<string, unknown> }
  | { kind: "loaded"; mtime: number; data: Record<string, unknown> }
  | { kind: "written"; data: Record<string, unknown> };

// synchronous store (see ./plugin-api): loads once, writes through
// atomically, and re-reads whenever the file's mtime moves under it — a
// deleted or externally rewritten state.json reflects immediately.
// `opts.stat` is the mtime probe (injectable so the cache's failure paths
// are testable: a probe that FAILS is not the same fact as a file that is
// gone).
export const makePluginStore = (dir: string, name: string, opts?: { stat?: (file: string) => number }): PluginStore => {
  const file = statePath(dir, name); // validates eagerly
  migrateState(dir, name);
  const statFile = opts?.stat ?? ((f: string) => statSync(f).mtimeMs);
  let state: StoreState = { kind: "unread" };
  let tmpSeq = 0;
  // the state file's mtime — THREE outcomes, not two: "present", "missing"
  // (ENOENT — the file is gone) and "unknown" (the probe ITSELF failed).
  const probe = (): { kind: "present"; mtime: number } | { kind: "missing" } | { kind: "unknown" } => {
    try {
      return { kind: "present", mtime: statFile(file) };
    } catch (err) {
      return errCode(err) === "ENOENT" ? { kind: "missing" } : { kind: "unknown" };
    }
  };
  const load = (): StoreState => {
    const p = probe();
    if (p.kind === "unknown") {
      // a failed probe is NOT "missing": keep what we know. An unread store
      // stays unread — a later successful probe re-reads the file.
      return state;
    }
    if (p.kind === "missing") {
      // the file is GONE: whatever we cached is void — the stale view must
      // not survive (the old shape's "the mtime did not move, so the cache
      // is fresh" reading served the deleted file's contents).
      state = { kind: "missing", data: {} };
      return state;
    }
    // the file is there: the cached stamp decides whether the data is fresh
    if (state.kind === "loaded" && state.mtime === p.mtime) return state;
    state = { kind: "loaded", mtime: p.mtime, data: readState(file) };
    return state;
  };
  const persist = (data: Record<string, unknown>): void => {
    mkdirSync(path.dirname(file), { recursive: true });
    // unique tmp per write (a fixed pid-named tmp lets two tfm instances
    // interleave bytes into one torn file) + fsync before rename, or a crash
    // lands the torn tmp as the live state. Still matches state.json.* so the
    // hash/fingerprint passes skip it.
    const tmp = `${file}.${process.pid}.${tmpSeq++}.tmp`;
    writeFileSync(tmp, JSON.stringify(data, null, 2));
    const fd = openSync(tmp, "r");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, file);
    // the write landed: adopt the new stamp. A failed probe leaves the state
    // "written" — the contents are ours, but the stamp is unknown (NEVER
    // "missing": that was the bug — the cached stamp said "missing", so a
    // later deletion was invisible and the stale cache was served).
    try {
      state = { kind: "loaded", mtime: statFile(file), data };
    } catch {
      state = { kind: "written", data };
    }
  };
  return {
    get: <T>(key: string, fallback: T): T => {
      const s = load();
      const v = s.kind === "unread" ? undefined : s.data[key];
      return (v === undefined ? fallback : v) as T;
    },
    set: (key: string, value: unknown): void => {
      const s = load();
      if (s.kind === "unread") {
        // we could not establish the file's contents (the probe failed) —
        // persisting now would TRUNCATE it. The old shape read the failed
        // probe as "missing" and wrote an empty state over the file.
        throw new Error(`plugin state unreadable: ${file}`);
      }
      s.data[key] = value;
      persist(s.data);
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
  // Plugins-view on/off — ONE transition. The plugin's STORE owns the flag
  // (the write lives here); the slot registration is DERIVED from it, so a
  // disabled plugin stops contributing UI immediately and the two can never
  // disagree. The old shape wrote the store in the settings model and
  // unregistered the slots in a separate call: a failure between the two
  // left a disabled plugin painting UI. No-op for unknown names.
  setEnabled: (name: string, enabled: boolean) => void;
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
      sinks.warn(`plugin folder ${name}/ has no ${name}.ts · skipped`);
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
      sinks.warn(`plugin ${name} is shadowed by the ${base}/ folder · skipped`);
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
      sinks.warn(`plugin ${name} could not move to a folder: ${errMessage(err)}`);
    }
  }
  return out.sort((a, b) => (a.file < b.file ? -1 : 1));
};

// --- One plugin FILE's lifecycle state.
//
// The old shape was a flat record ({fp, hash, name}) whose MEANING depended
// on which fields were fresh: a snap whose fp matched the disk meant
// "loaded", a snap whose fp lagged behind meant "the live instance is the
// OLD version — retry", and a MISSING snap meant "never loaded". Three
// states in one shape, and every reader had to know which comparison had
// been made to learn which state it was in.
//
// The state is explicit now:
//
//   "loaded" — the live instance runs exactly this content (fp/hash = the
//              disk's), so an unchanged fp means "nothing to do".
//   "failed" — the last attempt at this content failed; the next scan
//              RETRIES it. An older instance may still be live: a failed
//              reload keeps the old plugin running (the failure is
//              reported, the plugin is not taken away).
//
// The NAME is deliberately NOT here: the live instance owns it, and the
// loader joins the two by the instance's FILE — so a plugin that renames
// itself on reload is still the one instance that gets retired.
type PluginSnap = { state: "loaded"; fp: string; hash: string } | { state: "failed"; fp: string };

export const makePluginRegistry = (deps: {
  dir: string;
  api: PluginApi;
  warn(message: string): void;
  // bridge a plugin's `slots` contribution into the OpenTUI slot registry.
  // Returns an unregister fn stored as LoadedPlugin.disposeSlots.
  registerSlots?: (name: string, slots: Record<string, unknown>) => () => void;
  // the loader can be switched OFF for a build that may not run code from
  // disk (AOT: the executable only carries what was compiled into it). A
  // disabled registry never touches the plugins dir, so no plugin file is
  // ever imported. Default: on.
  enabled?: boolean;
}): PluginRegistry => {
  const { dir, api, warn, registerSlots } = deps;
  const enabled = deps.enabled ?? true;
  const plugins: LoadedPlugin[] = [];
  const errors: string[] = [];
  // main-path -> the file's lifecycle state (see PluginSnap above)
  const snaps = new Map<string, PluginSnap>();
  // The warning dedupe is PER FILE: a file owns the content versions it has
  // already warned about. The old shape was one flat Set of composite keys
  // (`<path>|<version>`) cleaned by a PREFIX delete — a path prefix could
  // wipe another file's keys, and a file that never LOADED (no snap) was
  // never cleaned at all: its key outlived the file, so re-installing the
  // same broken content was SILENT (no toast for a plugin that does not
  // load). The owners are paths: a plugin file, or the plugins dir itself
  // (the discovery warnings are about the dir's contents, not about one
  // plugin's lifecycle).
  const warned = new Map<string, Set<string>>();
  const warnOnce = (owner: string, version: string, message: string): void => {
    let versions = warned.get(owner);
    if (!versions) {
      versions = new Set();
      warned.set(owner, versions);
    }
    if (versions.has(version)) return;
    versions.add(version);
    try {
      warn(message);
    } catch {}
  };
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

  const loadOne = async (
    stagedFile: string,
    originalFile: string,
    rejectDuplicate?: (name: string) => boolean,
  ): Promise<LoadedPlugin> => {
    const mod: unknown = (await import(Bun.pathToFileURL(stagedFile).href)).default;
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
    // The live enable flag. The STORE owns the value (it is mtime-checked, so
    // an external edit reflects immediately); this read is the ONE surface
    // every consumer goes through. A throwing read PROPAGATES here — each
    // reader picks its own degrade policy (the push/veto gate degrades to
    // "on", the settings model warns, the filters degrade to "on").
    const readEnabled = (): boolean => ownStore.get("enabled", true);
    // live enabled read for the push/veto channels: a plugin toggled off in
    // the Plugins view must stop receiving events and stop vetoing file ops
    // immediately, not next restart. A throwing store read degrades to on.
    const pluginOn = (): boolean => {
      try {
        return readEnabled();
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
        // The slots are NOT registered here: the registration is DERIVED from
        // the plugin's enable flag by the registry (syncSlots), so the load
        // path and the toggle path share ONE derivation. A disabled plugin's
        // contributions are retained on the LoadedPlugin, so re-enabling
        // registers them without a re-activate.
      }
      const rawRows = result.rows ?? [];
      if (!Array.isArray(rawRows)) throw new Error(`rows must be an array`);
      // normalize: a legacy cycle row (getIdx + customLabel) is folded into
      // the tagged selection, so the app has ONE row shape
      const rows: SettingRow[] = [];
      for (const r of rawRows as unknown[]) {
        const row = normalizeSettingRow(r);
        if (row) {
          rows.push(row);
          continue;
        }
        try {
          api.log(
            `plugin ${m.name}: settings row ${JSON.stringify((r as { label?: unknown })?.label ?? "<unnamed>")} invalid — dropped`,
          );
        } catch {}
      }
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
        // the live enable flag — a PROJECTION of the store (the owner). The
        // read propagates a broken store to the reader, which picks its own
        // degrade policy.
        get enabled() {
          return readEnabled();
        },
        // the slot registration starts EMPTY: the registry derives it from the
        // flag (syncSlots) once the plugin is live.
        slotRegistration: { kind: "none" },
        slots: Object.keys(clean).length ? clean : null,
        file: originalFile,
      };
    } catch (err) {
      // activate already ran (or the post-activate validation threw): tear the
      // partial instance down or its listeners/timers leak forever — it is
      // never pushed to `plugins`, so deactivateAll can't reach it. (Its slots
      // were never registered: the registration is derived after the load.)
      await tearPartial(deactivate);
      throw err;
    }
  };

  // best-effort teardown: never throws, never blocks the scan (5s cap, timer
  // cleaned up on both paths via withTimeout — a bare Promise.race leaks the
  // timeout handle on success and holds the event loop per unload). Shared by
  // runDeactivate and loadOne's post-activate-validation catch.
  const tearPartial = async (
    deactivate: (() => unknown) | null | undefined,
    log?: (err: unknown) => void,
  ): Promise<void> => {
    if (!deactivate) return;
    try {
      await withTimeout(
        Promise.resolve().then(() => deactivate()),
        5000,
      );
    } catch (err) {
      log?.(err);
    }
  };

  // The slot registration is DERIVED from the plugin's enable flag: enabled +
  // contributions => registered; otherwise nothing is registered. ONE
  // derivation for the load path and the toggle path — the old shape
  // registered inside the load and toggled through a separate call (two
  // writers of one fact).
  const syncSlots = (p: LoadedPlugin): void => {
    const wants = isPluginEnabled(p) && !!p.slots && Object.keys(p.slots).length > 0;
    const reg = p.slotRegistration;
    if (wants) {
      if (reg.kind === "registered") return;
      if (!registerSlots || !p.slots) return;
      try {
        p.slotRegistration = { kind: "registered", dispose: registerSlots(p.name, p.slots) };
      } catch (err) {
        p.slotRegistration = { kind: "none" };
        try {
          api.log(`plugin ${p.name} slots failed to register: ${errMessage(err)}`);
        } catch {}
      }
      return;
    }
    if (reg.kind !== "registered") return;
    try {
      reg.dispose();
    } catch (err) {
      // the state advances only on SUCCESS: a failed unregister KEEPS the
      // handle, so the next enable cannot register a SECOND copy of the same
      // contribution (the old shape dropped the handle and leaked one).
      try {
        api.log(`plugin ${p.name} slots failed to unregister: ${errMessage(err)}`);
      } catch {}
      return;
    }
    p.slotRegistration = { kind: "none" };
  };

  // Dispose a plugin's slot registration. A failed dispose keeps the handle
  // (the state advances only on success) — and the plugin is remembered so
  // the registry can RETRY it: a lost handle leaks the contribution for the
  // rest of the session.
  const pendingDisposals: LoadedPlugin[] = [];
  const disposeSlotsOf = (p: LoadedPlugin): void => {
    const reg = p.slotRegistration;
    if (reg.kind !== "registered") return;
    try {
      reg.dispose();
    } catch (err) {
      try {
        api.log(`plugin ${p.name} slots failed to unregister: ${errMessage(err)}`);
      } catch {}
      if (!pendingDisposals.includes(p)) pendingDisposals.push(p);
      return;
    }
    p.slotRegistration = { kind: "none" };
  };
  const flushPendingDisposals = (): void => {
    for (const p of [...pendingDisposals]) {
      const reg = p.slotRegistration;
      if (reg.kind !== "registered") {
        pendingDisposals.splice(pendingDisposals.indexOf(p), 1);
        continue;
      }
      try {
        reg.dispose();
      } catch {
        continue; // keep it for the next try
      }
      p.slotRegistration = { kind: "none" };
      pendingDisposals.splice(pendingDisposals.indexOf(p), 1);
    }
  };

  const runDeactivate = async (p: LoadedPlugin): Promise<void> => {
    disposeSlotsOf(p);
    await tearPartial(p.deactivate, (err) => {
      try {
        api.log(`plugin ${p.name} deactivate failed: ${errMessage(err)}`);
      } catch {}
    });
  };

  // quit teardown: call every deactivate synchronously (promises ignored) so a
  // sync prefix flushes before process.exit. Async cleanup must use
  // events.on("quit") — see docs/plugins.md.
  const deactivateAll = (): void => {
    flushPendingDisposals();
    for (const p of [...plugins]) {
      disposeSlotsOf(p);
      if (!p.deactivate) continue;
      try {
        const r = p.deactivate();
        if (r instanceof Promise) void r.catch(() => {});
      } catch (err) {
        try {
          api.log(`plugin ${p.name} deactivate failed: ${errMessage(err)}`);
        } catch {}
      }
    }
  };

  const doScan = async (): Promise<PluginScanDiff> => {
    // a plugin whose unregister failed keeps its handle — retry the
    // disposal before anything else (a lost handle leaks the contribution)
    flushPendingDisposals();
    // one failed-load recorder: prune the staged dir (given), record + warn
    // once per distinct content version (a repeat failure dedupes silently
    // else). The dedupe key is the FILE's: the file owns the versions it has
    // already warned about.
    const recordLoadError = (file: string, what: string, version: string, err: unknown, prune?: () => void): void => {
      prune?.();
      const message = `plugin ${path.basename(file)} ${what}: ${errMessage(err)}`;
      diff.errors.push(message);
      warnOnce(file, version, message);
    };
    const diff: PluginScanDiff = { added: [], removed: [], changed: [], errors: [] };
    const found = discoverPlugins(dir, {
      // the discovery warnings are about the DIR's contents, not about one
      // plugin's lifecycle — the dir owns them
      warn: (m) => warnOnce(dir, m, m),
      log: api.log,
    });
    const live = new Set(found.map((f) => f.file));
    // A file that is GONE takes its warning keys with it: the dedupe belongs
    // to the FILE, so re-installing the same broken content warns AGAIN (the
    // user has to be told their plugin does not load). A file that never
    // LOADED has no snap, so the removal sweep below never reached its key —
    // the key outlived the file and the re-install was SILENT.
    for (const owner of [...warned.keys()]) {
      if (owner === dir) continue;
      if (!live.has(owner)) warned.delete(owner);
    }
    // rm a staged build dir when no live snap references its hash (failed
    // loads must not litter plugin-build; P1-12). Only a LOADED snap holds a
    // live staged dir — a failed attempt's staged copy is litter.
    const pruneUnreferencedStage = (folderName: string, hash: string): void => {
      for (const s of snaps.values()) if (s.state === "loaded" && s.hash === hash) return;
      try {
        rmSync(path.join(pluginBuildDir(), `${folderName}-${hash}`), { recursive: true, force: true });
      } catch {}
    };
    // REMOVALS FIRST: a renamed folder is a NEW file, and loading it before
    // retiring the old name trips the duplicate check against the plugin's own
    // previous name (a load-late + misleading "duplicate plugin name" error).
    for (const file of [...snaps.keys()]) {
      if (live.has(file)) continue;
      snaps.delete(file);
      // the live instance is joined by its FILE (not by its name): the name
      // lives in ONE place — the instance — so a plugin that renamed itself
      // on reload is still the one instance that gets retired.
      const i = plugins.findIndex((p) => p.file === file);
      if (i >= 0) {
        const [gone] = plugins.splice(i, 1);
        if (gone) {
          await runDeactivate(gone);
          diff.removed.push(gone.name);
        }
      }
      // drop every staged build for the removed folder (uninstall/rename) so
      // $XDG_CACHE_HOME/tfm/plugin-build doesn't grow across install cycles
      pruneStagedFor(path.basename(path.dirname(file)));
    }
    // "which names are taken" is ONE fact — the live instances' names. The
    // old shape tracked it THREE times (the snap's name, the instance's name
    // and a scan-local `seen` set kept in step by hand).
    const nameTakenByOther = (file: string, name: string): boolean =>
      plugins.some((p) => p.file !== file && p.name === name);
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
      // the fast path applies to a LOADED file only: a FAILED one must be
      // retried (the old shape encoded that by leaving the snap's fp stale,
      // which every reader had to know).
      if (prev?.state === "loaded" && prev.fp === fp) continue;
      // warn key must change per content version, or repeat failures dedupe
      // against the first version's key and go silent (warnOnce).
      let hash: string;
      try {
        hash = hashPluginFolder(srcFolder);
      } catch (err) {
        snaps.set(file, { state: "failed", fp });
        recordLoadError(file, "failed to reload", fp, err);
        continue;
      }
      // the content is unchanged since the last SUCCESSFUL load — only the
      // fingerprint moved (a touched file): nothing to do.
      if (prev?.state === "loaded" && hash === prev.hash) {
        prev.fp = fp;
        continue;
      }
      // the live instance for this file (NONE = a first load; one = a
      // reload). The join is by FILE, so a plugin that renamed itself is
      // still the same instance.
      const current = plugins.find((p) => p.file === file);
      if (!current) {
        try {
          const staged = copyStagedPlugin(srcFolder, folderName, hash, mainBase);
          const lp = await loadOne(staged, file, (name) => nameTakenByOther(file, name));
          plugins.push(lp);
          // the slot registration is DERIVED from the flag (the same
          // derivation the toggle uses)
          syncSlots(lp);
          snaps.set(file, { state: "loaded", fp, hash });
          diff.added.push(lp.name);
        } catch (err) {
          // the file's state says the attempt failed — the next scan retries
          snaps.set(file, { state: "failed", fp });
          recordLoadError(file, "failed to load", hash, err, () => pruneUnreferencedStage(folderName, hash));
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
        const lp = await loadOne(staged, file, (name) => nameTakenByOther(file, name));
        const idx = plugins.indexOf(current);
        await runDeactivate(current);
        plugins.splice(idx, 1, lp);
        // the new instance's registration is derived from the flag (the old
        // one was disposed with the old instance)
        syncSlots(lp);
        snaps.set(file, { state: "loaded", fp, hash });
        diff.changed.push(lp.name);
        try {
          api.log(`plugin ${lp.name} reloaded`);
        } catch {}
      } catch (err) {
        // the state records the failure, so the next scan RETRIES it
        // (transient errors self-heal); the old instance stays live.
        snaps.set(file, { state: "failed", fp });
        recordLoadError(file, "failed to reload", hash, err, () => pruneUnreferencedStage(folderName, hash));
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
    // disabled build: the loader never reaches the plugins dir, so no plugin
    // file is imported (an AOT executable could not run one anyway) and the
    // diff stays empty on every scan
    if (!enabled) return Promise.resolve({ added: [], removed: [], changed: [], errors: [] });
    if (scanning) return scanning;
    scanning = doScan().finally(() => {
      scanning = null;
    });
    return scanning;
  };

  // Plugins-view enable/disable — ONE transition. The plugin's STORE owns the
  // flag (the write lives HERE, not in the settings model) and the slot
  // registration is DERIVED from it, so the flag and the UI can never
  // disagree: a disabled plugin stops contributing UI immediately, and a
  // failed store write leaves BOTH as they were (the old shape wrote the
  // store in the model and unregistered the slots in a separate call).
  const setEnabled = (name: string, enabled: boolean): void => {
    const p = plugins.find((x) => x.name === name);
    if (!p) return;
    p.store.set("enabled", enabled); // the owner write — throws => nothing changed
    syncSlots(p);
  };

  return { plugins, errors, scan, deactivateAll, setEnabled };
};
