# Plugins

tfm plugins are small TypeScript files, loaded with **full trust** (like vim
plugins). They run in the same process, so a plugin can touch `node:fs`,
`node:child_process`, the network — anything Bun can. Only install plugins you
trust.

## Layout

One folder per plugin:

```
~/.config/tfm/plugins/<name>/<name>.ts   # the entry file
~/.config/tfm/plugins/<name>/state.json  # the plugin's own key/value store
~/.config/tfm/plugins/<name>/.tfm-source.json  # written by the installer
```

`$XDG_CONFIG_HOME` is honored. A legacy flat `<name>.ts` is migrated into the
folder layout on first scan.

## Install

In tfm: `esc` → Plugins → **Add from git URL…**.

CLI:

```
tfm plugins list              # installed plugins
tfm plugins search [query]    # search the index
tfm plugins add <url|id>      # install (or an index id, see docs/plugins.json)
tfm plugins remove <name>
tfm plugins update [name]     # one, or all
tfm plugins new <name>        # scaffold a starter plugin
```

Install accepts any git URL (`https://`, `ssh://`, `git://`, `git@host:repo`),
optionally `URL#ref subdir`. Edits hot-reload on the next esc-menu open.

## Writing one

```ts
export default {
  name: "hello",
  version: "1.0.0",
  author: "you",
  description: "example",
  apiVersion: 3,
  activate(api) {
    const off = api.events.on("navigate", ({ dir }) => api.log(`-> ${dir}`));
    return {
      rows: [{ kind: "action", label: "Say hi", run: () => api.notify("hi") }],
      fileMenu: (sel) => [{ label: `Hi ${sel.paths.length}`, run: (paths) => api.notify(paths.join("\n")) }],
      commands: [{ id: "hello:hi", title: "Hello: hi", defaultBinds: ["ctrl+j"], run: () => api.notify("hi") }],
      deactivate: () => off(),
    };
  },
};
```

`activate` may be async (10s cap). `deactivate` (or the returned one) runs on
remove and reload. **On quit** every `deactivate` is called synchronously, but
its returned promise is **not awaited** (quit is synchronous) — do sync cleanup
in `deactivate`, and anything async in an `api.events.on("quit")` listener
(listeners must be synchronous too).

## Manifest

| field | meaning |
|---|---|
| `name` | required, `[a-z0-9_-]`, becomes the folder name |
| `version` / `author` / `description` | optional, shown in the Plugins view |
| `apiVersion` | warn+load when it differs from core (currently `3`) |
| `minApiVersion` | higher than core → the plugin is rejected |

## API

`api` is the only surface. Add capabilities only by extending core.

- **Output**: `notify(msg, title?)`, `setStatusMsg(msg)`, `log(msg)`.
- **Context (read)**: `selection()`, `cwd()`.
- **Actions**: `navigate(dir)`, `open(path)`, `reveal(path)`, `select(paths)`.
- **Commands**: `commands()` (core + every plugin, for palettes).
- **UI**: `ui.pick({title, items})`, `ui.confirm({title, body?, danger?})`,
  `ui.prompt({title, value?, placeholder?, okLabel?})`,
  `ui.notifySticky(msg, title?) → close`.
- **State**: `store(name)` → `{ get(key, fallback), set(key, value) }`. Always
  returns your own store, whatever name you pass.
- **Events (observe)**: `events.on(evt, cb) → unsubscribe`. Events: `navigate`,
  `selection`, `file-op`, `trash`, `undo`, `theme`, `quit`, `boot`.
- **Hooks (intercept)**: `hooks.beforeFileOp(fn) → unsubscribe`. Return
  `{ skip: true, reason? }` to veto a `copy|move|rename|duplicate|trash|restore|delete-forever|empty`
  before core starts it. Sync-only, first skip wins.

Subscribe in `activate` and unsubscribe in `deactivate`, or listeners leak
across reloads.

## UI slots

`activate` can also return `slots` — real OpenTUI renderables painted into
tfm's layout. tfm mounts them at boot and refreshes them on every render, so
they see fresh `cwd`/`selection`.

Slot names:

- `statusbar` — a 1-row segment row (after the status label).
- `sidebar-footer` — a full-width stack under the places list.

The contribution gets `(ctx, data)`:

```ts
import { TextRenderable } from "@opentui/core";

export default {
  name: "clock",
  apiVersion: 3,
  activate(api) {
    return {
      slots: {
        statusbar(ctx, data) {
          return new TextRenderable(ctx.renderer(), {
            content: ` ${data.cwd} `,
            fg: ctx.colors().accent,
          });
        },
      },
    };
  },
};
```

`ctx` is `{ app, version, renderer(), colors(), cwd(), selection() }` (stable
ref, live getters). Plugin files may `import "@opentui/core"` — tfm installs
OpenTUI's runtime module support before loading plugins, so you get the host's
singleton (no second renderer). Read colors from `ctx.colors()` inside the
contribution so a theme flip repaints; baked hex looks stale after a theme
change.

A contribution must return one synchronous renderable. A throw (or returning
nothing) is contained per contribution (it renders as empty).

## Contributing points

`activate` can return: `rows` (extra rows in your Plugins-view category),
`fileMenu(sel)`, `sidebarMenu(place)`, `emptyAreaMenu({cwd})`, `commands`,
`preview` (`[{ exts, render(path) }]`, text only), `slots` (OpenTUI UI
contributions — see above), and `deactivate`.

## Not available

Toolbar buttons, sidebar sections, sort providers and custom
floating layers are core-only by design. Plugins can't rewrite an operation,
only veto it. (Statusbar / sidebar-footer UI is available via `slots`.)

## Types

`plugins-sample/tfm-api.d.ts` has the API types for editor autocomplete:

```ts
/// <reference path="./tfm-api.d.ts" />
export default { name: "x", apiVersion: 3, activate(api: TfmApi) { /* … */ } };
```
