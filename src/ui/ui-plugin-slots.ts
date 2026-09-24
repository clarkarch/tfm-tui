// --- OpenTUI plugin-slot host: the UI-extension surface for tfm plugins.
// tfm defines named regions (`TfmSlotName`) and a read-only context; plugins
// registered here return real OpenTUI renderables for those regions. The host
// keeps layout control (SlotRenderable owns size/position); a contribution
// only renders content.
//
// Why a registry at all: OpenTUI 0.5.9 ships the slot registry + the
// runtime-module Bun plugin that lets externally imported plugin files share
// THIS process's @opentui/core singleton (see ui-plugin-runtime.ts). Two plugin
// files importing "@opentui/core" would otherwise get a second instance and
// their nodes wouldn't integrate. ---

import {
  type CliRenderer,
  createCoreSlotRegistry,
  registerCorePlugin,
  SlotRenderable,
  type CorePlugin,
  type CoreSlotRegistry,
} from "@opentui/core";
import type { Theme } from "../config/config";
import type { MaybeNode } from "../lib/node-like";

export type TfmSlotName = "statusbar" | "sidebar-footer";

// stable object reference (the registry keys on it); fields are live getters
// so contributions can read fresh state without the host re-creating context
export type TfmSlotContext = {
  app: string;
  version: string;
  // host renderer — construct your renderables with ctx.renderer()
  renderer: () => CliRenderer;
  // live theme colors — read inside the contribution so a theme flip repaints
  colors: () => Theme;
  cwd: () => string;
  selection: () => string[];
};

export type TfmSlotData = { cwd: string; selection: string[] };

// what a plugin may return from activate() under `slots`
export type TfmSlotContribution = CorePlugin<TfmSlotName, TfmSlotContext, TfmSlotData>["slots"];

export type PluginSlots = {
  register(plugin: { id: string; order?: number; slots: TfmSlotContribution }): () => void;
  mount(byId: (id: string) => MaybeNode): void;
  refresh(): void;
  dispose(): void;
  isMounted(): boolean;
};

export const makePluginSlots = (opts: {
  renderer: CliRenderer;
  context: TfmSlotContext;
  log?: (message: string) => void;
}): PluginSlots => {
  let registry: CoreSlotRegistry<TfmSlotName, TfmSlotContext, TfmSlotData> | null = null;
  try {
    registry = createCoreSlotRegistry<TfmSlotName, TfmSlotContext, TfmSlotData>(opts.renderer, opts.context);
  } catch (err) {
    // a renderer without a live slot-registry store (tests / headless wiring)
    // degrades to a no-op host — logged so a real failure isn't silent
    opts.log?.(`plugin slots disabled: ${err instanceof Error ? err.message : err}`);
    registry = null;
  }
  if (!registry) {
    return {
      register: () => () => {},
      mount: () => {},
      refresh: () => {},
      dispose: () => {},
      isMounted: () => false,
    };
  }
  const live = registry;
  const mounted: SlotRenderable<TfmSlotName, TfmSlotContext, TfmSlotData>[] = [];
  // Each registration gets a unique registry id. The loader loads the NEW
  // plugin generation BEFORE deactivating the old one (a throwing reload must
  // keep the old instance live), so registering under the plain plugin name
  // would throw "already registered" and silently drop the slots on every
  // hot-reload. The returned cleanup removes only its own generation.
  let regSeq = 0;
  // skip work when nothing a contribution reads has changed (avoids native
  // node churn on every renderAll in this OOM-sensitive app)
  let lastSig = "\u0000";

  const sig = (): string => {
    let cwd = "";
    let selection: string[] = [];
    try {
      cwd = opts.context.cwd();
    } catch {}
    try {
      selection = opts.context.selection();
    } catch {}
    return `${cwd}\u0000${selection.join("\u0001")}`;
  };

  const refresh = (): void => {
    const s = sig();
    if (s === lastSig) return;
    lastSig = s;
    const d = data();
    for (const slot of mounted) {
      try {
        slot.data = d; // the setter reconciles mounted contributions
      } catch {}
    }
  };

  const data = (): TfmSlotData => {
    let cwd = "";
    let selection: string[] = [];
    try {
      cwd = opts.context.cwd();
    } catch {}
    try {
      selection = opts.context.selection();
    } catch {}
    return { cwd, selection };
  };

  const mountInto = (parent: any, name: TfmSlotName, layout: Record<string, unknown>): void => {
    if (!parent) return;
    try {
      const slot = new SlotRenderable<TfmSlotName, TfmSlotContext, TfmSlotData>(opts.renderer, {
        id: `tfm-plugin-slot-${name}`,
        registry: live,
        name,
        data: data(),
        mode: "append",
        ...layout,
        // a contribution that throws shows nothing rather than crashing the pane
        fallback: () => [],
      });
      parent.add(slot);
      mounted.push(slot);
    } catch (err) {
      opts.log?.(`plugin slot ${name} mount failed: ${err instanceof Error ? err.message : err}`);
    }
  };

  return {
    register: (plugin) => {
      const id = `${plugin.id}#${++regSeq}`;
      return registerCorePlugin(live, { ...plugin, id });
    },
    mount: (byId) => {
      if (mounted.length) return;
      // statusbar: a 1-row segment row; contributions append after the label
      mountInto(byId("tfm-status"), "statusbar", { height: 1, flexDirection: "row", columnGap: 1 });
      // sidebar-footer: a full-width stack under the places list
      mountInto(byId("tfm-sidebar-root"), "sidebar-footer", { width: "100%", flexDirection: "column" });
      lastSig = "\u0000";
      refresh();
    },
    refresh,
    dispose: () => {
      for (const slot of mounted.splice(0)) {
        try {
          slot.destroy();
        } catch {}
      }
      try {
        live.clear();
      } catch {}
    },
    isMounted: () => mounted.length > 0,
  };
};
