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

import { errMessage } from "../lib/uiutil";
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

// "live" = the OpenTUI slot registry is available; "disabled" = the host
// degraded to a no-op (a renderer without a slot-registry store). The state
// is a FIELD, not a different object: a consumer must be able to tell "this
// host cannot host anything" from "this host is live but not mounted yet"
// (both look like no-ops through the methods alone).
export type PluginSlotsStatus = "disabled" | "live";

export type PluginSlots = {
  readonly status: PluginSlotsStatus;
  // true while the slot regions are mounted (a live host only)
  readonly mounted: boolean;
  register(plugin: { id: string; order?: number; slots: TfmSlotContribution }): () => void;
  mount(byId: (id: string) => MaybeNode): void;
  refresh(): void;
  dispose(): void;
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
    opts.log?.(`plugin slots disabled: ${errMessage(err)}`);
    registry = null;
  }
  const live = registry;
  const mounted: SlotRenderable<TfmSlotName, TfmSlotContext, TfmSlotData>[] = [];
  // Each registration gets a unique registry id. The loader loads the NEW
  // plugin generation BEFORE deactivating the old one (a throwing reload must
  // keep the old instance live), so registering under the plain plugin name
  // would throw "already registered" and silently drop the slots on every
  // hot-reload. The returned cleanup removes only its own generation.
  let regSeq = 0;
  // The pushed-data cache: the CONTENT signature of the data the mounted slots
  // last received (null = nothing pushed yet). Skipping the push when nothing
  // a contribution reads has changed avoids native node churn on every
  // renderAll in this OOM-sensitive app.
  let lastSig: string | null = null;

  // ONE read of the context: the data AND its signature come from the SAME
  // snapshot. Reading cwd and selection twice could mix a pre-navigation cwd
  // with a post-navigation selection.
  const currentData = (): TfmSlotData => {
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
  const sigOf = (d: TfmSlotData): string => `${d.cwd}\u0000${d.selection.join("\u0001")}`;

  // Push the current data into the mounted slots. `force` re-pushes even when
  // the content is unchanged — a NEW registration must be handed a snapshot
  // taken NOW. The SlotRenderable re-renders a contribution only when the
  // data OBJECT changed, so a contribution that inherits the previous
  // generation's object keeps the old cwd/selection (a selection change does
  // not run a renderAll, so the host's last push can be stale).
  const push = (force: boolean): void => {
    const d = currentData();
    const s = sigOf(d);
    if (!force && s === lastSig) return;
    lastSig = s;
    for (const slot of mounted) {
      try {
        slot.data = d; // the setter reconciles mounted contributions
      } catch {}
    }
  };

  const mountInto = (
    registry: CoreSlotRegistry<TfmSlotName, TfmSlotContext, TfmSlotData>,
    parent: MaybeNode,
    name: TfmSlotName,
    layout: Record<string, unknown>,
    d: TfmSlotData,
  ): boolean => {
    if (!parent) return false;
    try {
      const slot = new SlotRenderable<TfmSlotName, TfmSlotContext, TfmSlotData>(opts.renderer, {
        id: `tfm-plugin-slot-${name}`,
        registry,
        name,
        data: d,
        mode: "append",
        ...layout,
        // a contribution that throws shows nothing rather than crashing the pane
        fallback: () => [],
      });
      parent.add(slot);
      mounted.push(slot);
      return true;
    } catch (err) {
      opts.log?.(`plugin slot ${name} mount failed: ${errMessage(err)}`);
      return false;
    }
  };

  return {
    status: live ? "live" : "disabled",
    get mounted(): boolean {
      return mounted.length > 0;
    },
    register: (plugin) => {
      if (!live) return () => {};
      const id = `${plugin.id}#${++regSeq}`;
      // Push BEFORE the registration: the new contribution then renders ONCE,
      // with a snapshot of the CURRENT data. (Registering first would render
      // it with the object the previous generation left behind, and the push
      // that follows would render every contribution a second time.)
      push(true);
      return registerCorePlugin(live, { ...plugin, id });
    },
    mount: (byId) => {
      if (!live) return;
      if (mounted.length) return;
      // ONE data object for both regions: the SlotRenderable renders its
      // contributions with the data it was constructed with, so handing it a
      // different object afterwards would render every contribution TWICE.
      const d = currentData();
      let allMounted = true;
      // statusbar: a 1-row segment row; contributions append after the label
      if (!mountInto(live, byId("tfm-status"), "statusbar", { height: 1, flexDirection: "row", columnGap: 1 }, d)) {
        allMounted = false;
      }
      // sidebar-footer: a full-width stack under the places list
      if (!mountInto(live, byId("tfm-sidebar-root"), "sidebar-footer", { width: "100%", flexDirection: "column" }, d)) {
        allMounted = false;
      }
      // the mounted slots already carry `d` → the cache claims that push; a
      // region that failed to mount gets the next refresh's push instead
      lastSig = allMounted ? sigOf(d) : null;
    },
    refresh: () => {
      if (!live) return;
      push(false);
    },
    dispose: () => {
      for (const slot of mounted.splice(0)) {
        try {
          slot.destroy();
        } catch {}
      }
      try {
        live?.clear();
      } catch {}
      // a disposed host holds no "pushed" claim — the next mount starts clean
      lastSig = null;
    },
  };
};
