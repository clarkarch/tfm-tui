// --- Plugin events: the push channel plugins subscribe to (polling
// selection()/cwd() is the pull fallback). Core emits, plugins observe —
// never the reverse. Pure module: no renderer/fs imports, so fs/ and app/
// can emit without importing from ui/. Shared singleton mirrors
// sharedOpQueue (one bus for the process; tests use makePluginEvents for
// isolation). A throwing listener never breaks its neighbors. ---

export type PluginEventName = "navigate" | "selection" | "file-op" | "trash" | "undo" | "theme" | "quit" | "boot";

// op vocabularies (match on these, never on core internals):
// - file-op: "copy" | "move" | "rename" (+ outcome on every completion)
// - trash: "trash" | "restore" | "delete-forever" | "empty"
// - undo: "undo" | "redo" (only on an actual pop — empty stacks stay silent)
export type PluginEventPayload = {
  navigate: { dir: string };
  selection: { paths: string[] };
  "file-op": { op: string; paths: string[]; dest?: string; outcome?: { cancelled: boolean; failed: number } };
  trash: { op: string; paths: string[] };
  undo: { op: string; label: string };
  theme: { preset: string; theme?: unknown };
  quit: Record<string, never>;
  boot: Record<string, never>;
};

type PluginEventUnsub = () => void;

type PluginEvents = {
  on<E extends PluginEventName>(evt: E, cb: (payload: PluginEventPayload[E]) => void): PluginEventUnsub;
  emit<E extends PluginEventName>(evt: E, payload: PluginEventPayload[E]): void;
};

export const makePluginEvents = (): PluginEvents => {
  const listeners = new Map<PluginEventName, Set<(payload: never) => void>>();
  return {
    on: (evt, cb) => {
      let set = listeners.get(evt);
      if (!set) {
        set = new Set();
        listeners.set(evt, set);
      }
      const fn = cb as (payload: never) => void;
      set.add(fn);
      return () => {
        set!.delete(fn);
      };
    },
    emit: (evt, payload) => {
      const set = listeners.get(evt);
      if (!set) return;
      for (const fn of [...set]) {
        try {
          fn(payload as never);
        } catch {}
      }
    },
  };
};

let shared: PluginEvents | null = null;
export const sharedPluginEvents = (): PluginEvents => {
  if (!shared) shared = makePluginEvents();
  return shared;
};
