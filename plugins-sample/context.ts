// tfm context plugin — copy to ~/.config/tfm/plugins/context/context.ts and restart.
// Shows what plugins can do beyond settings rows: read the live selection +
// cwd through the api, and append entries to the file right-click menu.
// No imports needed. A throwing fileMenu() never breaks the menu — that
// plugin's section is skipped.

const plugin = {
  name: "context",
  activate(api) {
    return {
      rows: [
        {
          kind: "action",
          label: "Where am I",
          run: () => {
            const sel = api.selection();
            api.notify(`${sel.length} selected in ${api.cwd()}`);
          },
        },
      ],
      fileMenu: (sel) => [
        {
          label: `Count (${sel.paths.length})`,
          run: (paths) => api.notify(paths.length === 1 ? paths[0] : `${paths.length} items`),
        },
      ],
    };
  },
};

export default plugin;
