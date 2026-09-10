// --- Plugins wiring: user extensions from ~/.config/tfm/plugins/*.ts.
// Runs after fileops (api context needs selection + nav/chrome sinks) and
// before grid/settings (menu entries merge plugin sections; aggregated rows
// feed the settings model). A plugin failure never breaks boot — loadPlugins
// isolates per plugin. ---

import { Text } from "@opentui/core";
import { dlog } from "../app/log";
import type { Command } from "../lib/command";
import { sharedPluginEvents } from "../lib/plugin-events";
import { KEY_SCHEMA, keySpecEqual } from "../config/config-schema";
import { getPluginCommandBinds } from "../plugins/plugin-api";
import {
  makePluginRegistry,
  makePluginStore,
  pluginsDir,
  PLUGIN_API_VERSION,
  type PluginApi,
} from "../plugins/plugins";
import type { CoreWiring } from "./core";
import type { ChromeWiring, GridFoundationWiring, NavWiring } from "./types";

export type PluginsWiring = Awaited<ReturnType<typeof wirePlugins>>;

// TDZ-safe late-cluster reader: getKeymap/getPick close over wirings that
// initialize AFTER the first plugin scan (an eager plugin calling
// api.commands()/ui.pick at activate top level would otherwise throw a
// ReferenceError and fail its own load). The fallback only ever surfaces
// pre-boot; lazy post-boot calls see the real values.
export const tdzSafe = <T>(get: () => T, fallback: T): (() => T) => {
  return () => {
    try {
      return get();
    } catch {
      return fallback;
    }
  };
};

export const wirePlugins = async (deps: {
  core: CoreWiring;
  nav: NavWiring;
  chrome: ChromeWiring;
  gridFoundation: GridFoundationWiring;
  // the keymap (core command table) and the pick widget wire LAST — deferred
  // arrows (TDZ seam rule); only CALLED post-boot, never during activate.
  // confirm arrives the same way (fileops wires before plugins, but the
  // explicit getter keeps the cluster type leaf-clean).
  getKeymap: () => { commands(): Command[] };
  getPick: () => {
    open(opts: { title: string; items?: Array<{ label: string; hint?: string; run: () => void }> }): void;
  };
  getConfirm?: () => {
    confirm(message: string, yesLabel: string, onYes: () => void, danger?: boolean): boolean;
    isOpen(): boolean;
  };
}) => {
  const { core, nav, chrome, gridFoundation, getKeymap, getPick, getConfirm } = deps;
  const dir = pluginsDir();
  let loaded: Array<{ commands: Array<{ id: string; title: string; hint?: string; run: () => void }> }> = [];
  const api: PluginApi = {
    version: PLUGIN_API_VERSION,
    notify: (message, title) => chrome.notify(message, title ?? "tfm"),
    setStatusMsg: nav.setStatusMsg,
    log: (message) => dlog(message),
    store: (name) => makePluginStore(dir, name),
    // live reads — selection/cwd resolve at call time, so a plugin action
    // run minutes later still sees the current state, never a stale capture
    selection: () => gridFoundation.selection.selPaths(),
    cwd: () => core.state.cwd,
    navigate: nav.navigate,
    refresh: nav.renderAll,
    // core table first, then plugin contributions in load order (hints fall
    // back to "" — most plugin commands carry no bind). Both late getters go
    // through tdzSafe: they close over wirings that initialize after scan.
    commands: () => [
      ...tdzSafe(() => getKeymap().commands(), [] as Command[])(),
      ...loaded.flatMap((p) => p.commands.map((c) => ({ ...c, hint: c.hint ?? "" }))),
    ],
    ui: {
      pick: (opts) => {
        const noop: () => {
          open(o: { title: string; items?: Array<{ label: string; hint?: string; run: () => void }> }): void;
        } = () => ({ open: () => {} });
        tdzSafe(getPick, noop())().open(opts);
      },
      confirm: (opts) =>
        new Promise<boolean>((resolve) => {
          const c = getConfirm?.();
          if (!c) {
            resolve(false);
            return;
          }
          let settled = false;
          // the poll timer must die on EVERY settle path — resolving without
          // clearing it leaks a 50ms interval per confirm (and holds the
          // event loop when the dialog never closes).
          let timer: ReturnType<typeof setInterval> | null = null;
          let hardTimer: ReturnType<typeof setTimeout> | null = null;
          const done = (v: boolean): void => {
            if (settled) return;
            settled = true;
            if (timer !== null) clearInterval(timer);
            if (hardTimer !== null) clearTimeout(hardTimer);
            resolve(v);
          };
          try {
            const opened = c.confirm(
              opts.body ? `${opts.title}: ${opts.body}` : opts.title,
              "Yes",
              () => done(true),
              opts.danger ?? false,
            );
            if (!opened) {
              done(false);
              return;
            }
          } catch {
            done(false);
            return;
          }
          // No/Esc/close resolves false — poll the open flag (the dialog has
          // no onNo hook; polling is the same settle pattern tests use).
          timer = setInterval(() => {
            try {
              if (!c.isOpen()) done(false);
            } catch {
              done(false);
            }
          }, 50);
          // backstop: a dialog that never closes must not pend forever.
          hardTimer = setTimeout(() => done(false), 5 * 60 * 1000);
        }),
      notifySticky: (message, title) => {
        try {
          const handle = chrome.notifySticky(
            [Text({ content: String(title ?? "tfm").slice(0, 60) }), Text({ content: String(message).slice(0, 120) })],
            { width: 40, height: 3 },
          );
          if (!handle) return () => {};
          let closed = false;
          return () => {
            if (closed) return;
            closed = true;
            try {
              handle.close();
            } catch {}
          };
        } catch {
          return () => {};
        }
      },
    },
    events: {
      on: (evt, cb) => (sharedPluginEvents().on as (e: typeof evt, c: typeof cb) => () => void)(evt, cb),
    },
  };
  const warn = (message: string): void => {
    chrome.notify(message, "plugins");
    dlog(message);
  };
  // registry-backed: the returned array is LIVE (rescan mutates it in place)
  // so the model, menus and api.commands merge see adds/removes with no
  // re-wiring; rescan also surfaces from the esc menu (no restart for
  // add/remove/edit — edits hot-reload via hashed staging, see plugins.ts)
  const registry = makePluginRegistry({ dir, api, warn });
  await registry.scan();
  loaded = registry.plugins;
  // colliding defaults load silently shadowed (core-wins at dispatch) — make
  // the shadowing visible once per load so authors/users know to remap.
  try {
    const seenPluginBinds: Array<{ title: string; spec: string }> = [];
    for (const p of registry.plugins) {
      for (const c of p.commands) {
        for (const spec of getPluginCommandBinds(p, c.id)) {
          const coreOwner = KEY_SCHEMA.find((row) =>
            (core.config.keys[row.action] ?? []).some((owned) => keySpecEqual(owned, spec)),
          );
          if (coreOwner) {
            api.log(
              `plugin ${p.name}: bind "${spec}" for ${JSON.stringify(c.id)} is shadowed by core "${coreOwner.label}" — remap it in the Plugins view`,
            );
            continue;
          }
          const sibling = seenPluginBinds.find((s) => keySpecEqual(s.spec, spec));
          if (sibling) {
            api.log(
              `plugin ${p.name}: bind "${spec}" for ${JSON.stringify(c.id)} is shadowed by "${sibling.title}" — remap it in the Plugins view`,
            );
            continue;
          }
          seenPluginBinds.push({ title: `${p.name}:${c.title}`, spec });
        }
      }
    }
  } catch {}
  try {
    sharedPluginEvents().emit("boot", {});
  } catch {}
  // promise confirm (danger-aware Yes/No) shared with the settings installer
  // rows — same dialog plugins get via api.ui.confirm, no second wrapper
  return { plugins: registry.plugins, reloadPlugins: () => registry.scan(), confirm: api.ui.confirm };
};
