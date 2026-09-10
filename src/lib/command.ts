// --- Command: one dispatchable action — a core keybind action or a plugin
// contribution. The keymap builds these from its action table (same closures
// the keypress chain calls, so palette runs behave exactly like keypresses);
// plugins contribute them via activate(); the pick overlay renders them.
// Single shape shared everywhere (see the lib/ note: 3-line utilities and
// their types live here, never in ui/). ---

export type Command = {
  id: string;
  title: string;
  hint: string;
  run: () => void;
};
