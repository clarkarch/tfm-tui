// tfm command-palette plugin — copy to ~/.config/tfm/plugins/palette/palette.ts and
// restart tfm. Opens a fuzzy command list over EVERYTHING dispatchable: all
// core keybind actions (same closures the keys run) plus every installed
// plugin's commands. No imports needed. Opens from its Plugins-view row (and
// the file menu) — a global hotkey would need a core [keys] row, which core
// deliberately keeps closed to plugins.

const plugin = {
  name: "palette",
  activate(api) {
    // api.commands() is read lazily here (not at activate time): the core
    // half only exists once the keymap wires, which is after plugins load
    const open = () => {
      api.ui.pick({
        title: "Command palette",
        items: api.commands().map((c) => ({ label: c.title, hint: c.hint || undefined, run: c.run })),
      });
    };
    return {
      rows: [{ kind: "action", label: "Command palette…", run: open }],
      fileMenu: () => [{ label: "Command palette…", run: () => open() }],
    };
  },
};

export default plugin;
