// tfm showcase plugin — copy to ~/.config/tfm/plugins/showcase/showcase.ts and
// restart (or rescan via the esc menu — edits hot-reload live). Demonstrates
// the v2 surfaces: events, keybinds, sidebar/empty-area menus, preview
// renderers, confirm/sticky dialogs, async activate + deactivate.
//
// Full trust like vim plugins: Bun gives you node:fs/child_process — core
// exposes no process wrappers on purpose. apiVersion 2; minApiVersion gates
// loading when core is too old.

const plugin = {
  name: "showcase",
  apiVersion: 2,
  async activate(api) {
    const store = api.store("showcase");
    // push, not poll: unsubscribe in deactivate or listeners leak across reloads
    const offs = [
      api.events.on("navigate", ({ dir }) => api.log(`showcase: navigated to ${dir}`)),
      api.events.on("selection", ({ paths }) => {
        if (paths.length === 1) api.setStatusMsg(`showcase sees ${paths[0]}`);
      }),
      api.events.on("file-op", ({ op, paths }) => api.log(`showcase: ${op} ${paths.length} item(s)`)),
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
      ],
      fileMenu: (sel) => [
        { label: `Showcase (${sel.paths.length})`, run: (paths) => api.notify(paths.join("\n") || "(none)") },
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
            // first 20 lines, pipes aligned — empty string falls to core
            return text.split("\n").slice(0, 20).join("\n");
          },
        },
      ],
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
