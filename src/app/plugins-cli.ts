// --- `tfm plugins <subcommand>`: headless plugin management (no renderer).
// Reuses the same leaf installer the Plugins view does, so behavior can't
// drift. Pure arg dispatch (parsePluginsArgs) is separated from the fs/git
// side so dispatch is unit-testable without touching the disk. ---

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { installPlugin, removePluginDir, updatePlugin, type ExecFn } from "../plugins/plugin-install";
import { pluginsDir } from "../plugins/plugins";
import { PLUGIN_API_VERSION, PLUGIN_NAME_RE } from "../plugins/plugin-api";
import {
  findIndexEntry,
  indexEntryToRaw,
  isGitUrl,
  parsePluginIndex,
  PLUGIN_INDEX_URL,
  searchIndex,
} from "../plugins/plugin-index";

export type PluginsCommand = "list" | "add" | "remove" | "update" | "new" | "search" | "help";

export type PluginsArgs = {
  cmd: PluginsCommand;
  target: string | null;
  error: string | null;
};

// PURE: `tfm plugins [list] | search [q] | add <url|id> | remove <name> | update [name] | new <name>`
export const parsePluginsArgs = (args: string[]): PluginsArgs => {
  const bad = (error: string): PluginsArgs => ({ cmd: "help", target: null, error });
  const first = args[0];
  if (first === undefined || first === "list" || first === "ls") return { cmd: "list", target: null, error: null };
  if (first === "help" || first === "--help" || first === "-h") return { cmd: "help", target: null, error: null };
  if (first === "search" || first === "find") return { cmd: "search", target: args[1] ?? "", error: null };
  if (first === "add" || first === "install") {
    const target = args.slice(1).join(" ").trim();
    return target ? { cmd: "add", target, error: null } : bad("add needs a git URL or index id");
  }
  if (first === "remove" || first === "rm") {
    const target = args[1];
    return target ? { cmd: "remove", target, error: null } : bad("remove needs a plugin name");
  }
  if (first === "update" || first === "upgrade") return { cmd: "update", target: args[1] ?? null, error: null };
  if (first === "new" || first === "create") {
    const target = args[1];
    return target ? { cmd: "new", target, error: null } : bad("new needs a plugin name");
  }
  return bad(`unknown plugins subcommand: ${JSON.stringify(first)}`);
};

export const pluginsHelp = (): string =>
  `tfm plugins — manage plugins (${pluginsDir()})

Usage: tfm plugins [list]
       tfm plugins search [query]
       tfm plugins add <git-url|index-id>
       tfm plugins remove <name>
       tfm plugins update [name]
       tfm plugins new <name>

  list              list installed plugins (default)
  search            search the plugin index
  add               install from a git URL or an index id
  remove            delete an installed plugin (and its state)
  update            re-pull/-clone one plugin, or all when no name is given
  new               scaffold a starter plugin in the plugins folder
`;

export const scaffoldPlugin = (name: string): string => {
  if (!PLUGIN_NAME_RE.test(name)) throw new Error(`unsafe plugin name: ${JSON.stringify(name)}`);
  return `// tfm plugin: ${name}
export default {
  name: ${JSON.stringify(name)},
  version: "0.1.0",
  apiVersion: ${PLUGIN_API_VERSION},
  activate(api) {
    return {
      rows: [
        {
          kind: "action",
          label: "Say hello",
          run: () => api.notify("hello from ${name}"),
        },
      ],
      commands: [
        {
          id: "${name}:hello",
          title: "${name}: say hello",
          run: () => api.notify("hello from ${name}"),
        },
      ],
    };
  },
};
`;
};

type PluginsCliDeps = {
  dir?: string;
  exec?: ExecFn;
  out?: (line: string) => void;
  err?: (line: string) => void;
  // index loader override (tests never hit the network)
  fetchIndex?: () => Promise<unknown>;
};

export const runPluginsCli = async (args: string[], deps: PluginsCliDeps = {}): Promise<number> => {
  const dir = deps.dir ?? pluginsDir();
  const out = deps.out ?? ((s) => console.log(s));
  const err = deps.err ?? ((s) => console.error(s));
  const loadIndex = async () => {
    const raw = deps.fetchIndex
      ? await deps.fetchIndex()
      : await fetch(PLUGIN_INDEX_URL, { signal: AbortSignal.timeout(4000) }).then((r) => r.json());
    return parsePluginIndex(raw);
  };
  const parsed = parsePluginsArgs(args);
  if (parsed.error) {
    err(`tfm: ${parsed.error}`);
    err("try 'tfm plugins help'");
    return 2;
  }

  const installed = (): string[] => {
    try {
      return readdirSync(dir).filter((n) => {
        if (n.startsWith(".")) return false;
        try {
          return statSync(path.join(dir, n)).isDirectory();
        } catch {
          return false;
        }
      });
    } catch {
      return [];
    }
  };

  const sourceOf = (name: string): string => {
    try {
      const raw: unknown = JSON.parse(readFileSync(path.join(dir, name, ".tfm-source.json"), "utf8"));
      const s = raw as { url?: unknown };
      return typeof s.url === "string" ? s.url : "";
    } catch {
      return "";
    }
  };

  try {
    switch (parsed.cmd) {
      case "help":
        out(pluginsHelp());
        return 0;
      case "list": {
        const names = installed();
        if (!names.length) {
          out(`no plugins installed (${dir})`);
          return 0;
        }
        for (const n of names) {
          const src = sourceOf(n);
          out(src ? `${n}  ${src}` : n);
        }
        return 0;
      }
      case "add": {
        let raw = parsed.target;
        // falsy covers both null (no target parsed) and ""
        if (!raw) {
          err("tfm: add needs a git URL or an index id");
          return 1;
        }
        if (!isGitUrl(raw)) {
          // treat as an index id
          const entry = findIndexEntry(await loadIndex(), raw);
          if (!entry) {
            err(`tfm: no plugin '${raw}' in the index (pass a full git URL to install anyway)`);
            return 1;
          }
          raw = indexEntryToRaw(entry);
        }
        const res = await installPlugin({ dir, raw, ...(deps.exec ? { exec: deps.exec } : {}) });
        out(`installed ${res.name} -> ${res.dest}`);
        return 0;
      }
      case "search": {
        const hits = searchIndex(await loadIndex(), parsed.target ?? "");
        if (!hits.length) {
          out("no matching plugins");
          return 0;
        }
        for (const e of hits) out(`${e.id}  ${e.description || e.name}`);
        return 0;
      }
      case "remove": {
        const target = parsed.target;
        if (!target) {
          err("tfm: remove needs a plugin name");
          return 1;
        }
        const dest = removePluginDir(dir, target);
        out(`removed ${target} (${dest})`);
        return 0;
      }
      case "update": {
        const targets = parsed.target ? [parsed.target] : installed();
        if (!targets.length) {
          out("no plugins to update");
          return 0;
        }
        let failed = 0;
        for (const name of targets) {
          try {
            const msg = await updatePlugin({ dir, name, ...(deps.exec ? { exec: deps.exec } : {}) });
            out(`updated ${name}: ${msg}`);
          } catch (e) {
            failed++;
            err(`update ${name} failed: ${e instanceof Error ? e.message : e}`);
          }
        }
        return failed ? 1 : 0;
      }
      case "new": {
        const name = parsed.target;
        if (!name) {
          err("tfm: new needs a plugin name");
          return 1;
        }
        if (!PLUGIN_NAME_RE.test(name)) {
          err(`tfm: unsafe plugin name: ${JSON.stringify(name)}`);
          return 2;
        }
        const folder = path.join(dir, name);
        const file = path.join(folder, `${name}.ts`);
        if (existsSync(file)) {
          err(`tfm: ${file} already exists`);
          return 1;
        }
        mkdirSync(folder, { recursive: true });
        writeFileSync(file, scaffoldPlugin(name));
        out(`created ${file}`);
        return 0;
      }
    }
  } catch (e) {
    err(`tfm: ${e instanceof Error ? e.message : e}`);
    return 1;
  }
};
