// tfm showcase plugin — copy to ~/.config/tfm/plugins/showcase/showcase.ts and
// start tfm (or rescan via the esc menu — edits hot-reload live). Demonstrates
// the v3 surfaces: manifest metadata, events, keybinds, sidebar/empty-area
// menus, preview renderers, confirm/prompt/sticky dialogs, navigation actions,
// pre-op veto hooks, async activate + deactivate.
//
// Full trust like vim plugins: Bun gives you node:fs/child_process — core
// exposes no process wrappers on purpose. apiVersion 3; minApiVersion gates
// loading when core is too old.
//
// UI slots: import @opentui/core (runtime support is installed for you) and
// return renderables for "statusbar" / "sidebar-footer".
import { TextRenderable } from "@opentui/core";

const plugin = {
  name: "showcase",
  version: "1.0.0",
  author: "you",
  description: "tfm plugin API tour",
  apiVersion: 3,
  async activate(api) {
    const store = api.store("showcase");
    // push, not poll: unsubscribe in deactivate or listeners leak across reloads
    const offs = [
      api.events.on("navigate", ({ dir }) => api.log(`showcase: navigated to ${dir}`)),
      api.events.on("selection", ({ paths }) => {
        if (paths.length === 1) api.setStatusMsg(`showcase sees ${paths[0]}`);
      }),
      api.events.on("file-op", ({ op, paths }) => api.log(`showcase: ${op} ${paths.length} item(s)`)),
      // veto channel: block trashing files whose name contains ".keep"
      api.hooks.beforeFileOp(({ op, paths }) => {
        if (op === "trash" && paths.some((p) => p.includes(".keep"))) {
          return { skip: true, reason: "showcase protects .keep files" };
        }
      }),
    ];
    return {
      rows: [
        {
          kind: "action",
          label: "Greet (sticky)",
          run: () => {
            const close = api.ui.notifySticky("pinned until you re-run me", "showcase");
            if (store.get("pinned", false)) close();
            store.set("pinned", !store.get("pinned", false));
          },
        },
        {
          kind: "action",
          label: "Ask to continue…",
          run: async () => {
            const ok = await api.ui.confirm({ title: "Showcase", body: "proceed?", danger: false });
            api.notify(ok ? "confirmed" : "cancelled");
          },
        },
        {
          kind: "action",
          label: "Type something…",
          run: async () => {
            const text = await api.ui.prompt({ title: "Showcase input", placeholder: "type here" });
            api.notify(text === null ? "cancelled" : `you typed: ${text}`);
          },
        },
        {
          kind: "action",
          label: "Select the first two entries",
          run: () => {
            const paths = api
              .selection()
              .slice(0, 2)
              .map((s) => s.path);
            api.select(paths);
          },
        },
      ],
      fileMenu: (sel) => [
        { label: `Showcase (${sel.paths.length})`, run: (paths) => api.notify(paths.join("\n") || "(none)") },
        { label: "Show in folder", run: (paths) => api.reveal(paths[0] ?? "") },
        { label: "Open with default app", run: (paths) => paths[0] && api.open(paths[0]) },
      ],
      sidebarMenu: (place) => [
        { label: `Showcase here (${place.path ?? place.scheme ?? "?"})`, run: (paths) => api.notify(paths[0] ?? "?") },
      ],
      emptyAreaMenu: (area) => [{ label: "Showcase cwd", run: () => api.notify(area.cwd) }],
      commands: [
        {
          id: "showcase:hello",
          title: "Showcase: say hello",
          defaultBinds: ["ctrl+j"],
          run: () => api.notify("hello from showcase"),
        },
      ],
      preview: [
        {
          exts: ["csv"],
          render: async (filePath) => {
            const { readFile } = await import("node:fs/promises");
            const text = await readFile(filePath, "utf8").catch(() => "");
            // first 20 lines — empty string falls to core
            return text.split("\n").slice(0, 20).join("\n");
          },
        },
      ],
      // a live statusbar segment showing the current directory
      slots: {
        statusbar(ctx, data) {
          return new TextRenderable(ctx.renderer(), {
            content: ` showcase:${data.cwd} `,
            fg: ctx.colors().accent,
          });
        },
      },
      deactivate: () => {
        for (const off of offs) {
          try {
            off();
          } catch {}
        }
      },
    };
  },
};

export default plugin;
