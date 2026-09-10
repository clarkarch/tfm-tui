// tfm hello-world plugin — copy this file to ~/.config/tfm/plugins/hello/hello.ts
// (or $XDG_CONFIG_HOME/tfm/plugins/hello/hello.ts) and restart tfm. It appears as
// a "plugins" category in the esc-menu settings view.
//
// No imports needed: tfm calls activate(api) and renders the returned rows
// with the same panel as core settings. api = { version, notify,
// setStatusMsg, log, store, ... } (see plugins-sample/showcase.ts for the
// full v2 surface: events, commands+keybinds, menus, preview, confirm).
// store(name) persists per-plugin JSON at plugins/<name>/state.json — plugin
// settings NEVER go in config.toml.
// A throwing plugin is skipped with a warning; it can never break boot.

const plugin = {
  name: "hello",
  activate(api) {
    const store = api.store("hello");
    return {
      rows: [
        {
          kind: "action",
          label: "Say hello",
          run: () => {
            const enthusiastic = store.get("enthusiastic", false);
            api.notify(enthusiastic ? "Hello from the hello plugin!" : "hello from the hello plugin.");
          },
        },
        {
          kind: "toggle",
          label: "enthusiasm",
          get: () => store.get("enthusiastic", false),
          set: (v) => store.set("enthusiastic", v),
        },
      ],
    };
  },
};

export default plugin;
