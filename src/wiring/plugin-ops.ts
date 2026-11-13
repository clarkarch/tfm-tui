// --- Plugin dir mutations: add (clone), update (git pull), remove (rm).
// The three share ONE directory (the plugins dir) and the same git
// machinery, so "a plugin dir is being mutated" is ONE state — and the
// guard that owns it used to cover only the ADD path. The fs work arrives
// through deps (the wiring owns the real clone/pull/rm and the prompt /
// confirm overlays); this module owns the ORCHESTRATION and the guard.
// Every path is fire-and-forget: a failure is a toast + a log line, never
// a throw. ---

import { AmbiguousPluginError, derivePluginName, parseGitUrl } from "../plugins/plugin-install";
import { errMessage } from "../lib/uiutil";

export type PluginOpsDeps = {
  // the outcome channel: a failure must never read as a success
  notify: (message: string, title?: string) => void;
  // the sticky progress toast (the wiring builds it — it owns the theme);
  // the returned closer settles it
  progress: (title: string, message: string) => () => void;
  // the Yes/No confirm (danger: true) — resolves false when declined
  confirm: (o: { title: string; danger?: boolean }) => Promise<boolean>;
  // the URL prompt for the add path — resolves null when cancelled. The
  // wiring wraps the TDZ getter (the prompt overlay wires last)
  prompt: () => Promise<string | null>;
  // the fs work
  install: (raw: string) => Promise<{ name: string }>;
  update: (name: string) => Promise<string>;
  remove: (name: string) => void;
  // is a plugin with this name already installed?
  exists: (name: string) => boolean;
  // is git available at all? (the add path needs it)
  hasGit: () => boolean;
  log: (message: string) => void;
  // re-scan + repaint the Plugins view
  refresh: () => void;
};

export type PluginOps = {
  addFromUrl: () => void;
  update: (name: string) => void;
  remove: (name: string) => void;
};

export const makePluginOps = (deps: PluginOpsDeps): PluginOps => {
  // ONE owner for "a plugin dir is being mutated". The old shape had a
  // single boolean that covered ONLY the add path: an in-flight clone
  // raced a remove (the clone re-creates the dir the user just removed)
  // and two updates on the same repo interleaved `git index.lock`.
  //
  // The map is keyed by the plugin the op touches. The ADD path owns the
  // WHOLE plugins dir — its target name is only known after the URL
  // prompt, and the clone writes into the shared dir — so it is the one
  // key that conflicts with every other op.
  const ADD_KEY = "*";
  type PluginOp = { key: string; kind: "add" | "update" | "remove" };
  const ops = new Map<string, PluginOp>();
  const busy = (key: string): boolean => {
    for (const k of ops.keys()) {
      if (k === ADD_KEY || k === key) return true;
    }
    return false;
  };
  const begin = (op: PluginOp): boolean => {
    if (busy(op.key)) return false;
    ops.set(op.key, op);
    return true;
  };
  // identity-safe release: a settle never frees a slot another op owns
  const end = (op: PluginOp): void => {
    if (ops.get(op.key) === op) ops.delete(op.key);
  };
  // a refused op is ANNOUNCED — the "no silent op" invariant: the user
  // clicked something and must not be left with nothing on screen
  const refuse = (): void => deps.notify("Another plugin action is running · try again", "plugins");

  const addFromUrl = (): void => {
    const op: PluginOp = { key: ADD_KEY, kind: "add" };
    if (!begin(op)) {
      refuse();
      return;
    }
    void (async () => {
      try {
        if (!deps.hasGit()) {
          deps.notify("git not found · install git", "plugins");
          return;
        }
        const raw = await deps.prompt();
        if (raw === null) return;
        let name: string;
        try {
          name = derivePluginName(parseGitUrl(raw));
        } catch (err) {
          deps.notify(errMessage(err), "add plugin");
          return;
        }
        // early collision hint on the derived name (the install may still
        // normalize to a different final name — that error surfaces below)
        try {
          if (deps.exists(name)) {
            deps.notify(`Already installed · remove first`, "add plugin");
            return;
          }
        } catch {}
        deps.log(`plugin install requested: ${raw} -> ${name}`);
        // title-only: the trust warning already leads the URL prompt's title,
        // and the outcome toast reports back
        const ok = await deps.confirm({
          title: `Install "${name}"?`,
          danger: true,
        });
        if (!ok) return;
        const doneCloning = deps.progress("plugins", `Cloning ${name}…`);
        try {
          const res = await deps.install(raw);
          deps.log(`plugin installed: ${res.name} from ${raw}`);
          deps.notify(`Installed ${res.name}`, "plugins");
        } catch (err) {
          if (err instanceof AmbiguousPluginError) {
            deps.notify(`Repo has ${err.candidates.length} plugins · retry with URL subdir`, "add plugin");
          } else {
            deps.notify(errMessage(err), "add plugin");
          }
          deps.log(`plugin install failed: ${errMessage(err)}`);
          return;
        } finally {
          doneCloning();
        }
        deps.refresh();
      } finally {
        end(op);
      }
    })().catch(() => {});
  };

  const update = (name: string): void => {
    const op: PluginOp = { key: name, kind: "update" };
    if (!begin(op)) {
      refuse();
      return;
    }
    void (async () => {
      try {
        const doneUpdating = deps.progress("plugins", `Updating ${name}…`);
        try {
          const out = await deps.update(name);
          deps.log(`plugin updated: ${name}: ${out}`);
          deps.notify(`${name} · ${out}`, "plugins");
        } catch (err) {
          deps.notify(errMessage(err), "plugins");
          return;
        } finally {
          doneUpdating();
        }
        deps.refresh();
      } finally {
        end(op);
      }
    })().catch(() => {});
  };

  const remove = (name: string): void => {
    const op: PluginOp = { key: name, kind: "remove" };
    if (!begin(op)) {
      refuse();
      return;
    }
    void (async () => {
      try {
        // title-only (see above — the confirm itself carries the context)
        const ok = await deps.confirm({
          title: `Remove "${name}"?`,
          danger: true,
        });
        if (!ok) return;
        try {
          deps.remove(name);
        } catch (err) {
          deps.notify(errMessage(err), "plugins");
          return;
        }
        deps.log(`plugin removed: ${name}`);
        deps.notify(`Removed ${name}`, "plugins");
        deps.refresh();
      } finally {
        end(op);
      }
    })().catch(() => {});
  };

  return { addFromUrl, update, remove };
};
