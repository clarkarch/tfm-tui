// --- Dual-pane model: two independent view states and which one is ACTIVE.
// Generic over the view type (AppState in the app) so this stays a leaf module
// with no dependency on nav.ts — nav.ts imports it, not the other way round.
// Pure data: no renderer, no fs, no config. ---

export type PaneIndex = 0 | 1;

export type PanePair<T> = {
  states: [T, T];
  active: PaneIndex;
};

export const makePanePair = <T>(first: T, second: T): PanePair<T> => ({
  states: [first, second],
  active: 0,
});

export const activeState = <T>(p: PanePair<T>): T => p.states[p.active];

export const otherPane = <T>(p: PanePair<T>): PaneIndex => (p.active === 0 ? 1 : 0);

export const otherState = <T>(p: PanePair<T>): T => p.states[otherPane(p)];

export const setActivePane = <T>(p: PanePair<T>, i: PaneIndex): void => {
  p.active = i;
};

export const togglePane = <T>(p: PanePair<T>): void => {
  p.active = otherPane(p);
};

// A stable facade over whichever pane is active: property reads/writes forward
// to the active state, so consumers that hold one `state`/`selection` reference
// keep working unchanged while the active pane changes under them. Methods are
// bound to the real target (selection methods close over their own state, so
// binding is just belt-and-braces). `overrides` lets a facade return a stable
// live sub-view (e.g. the live tileRefs Map) for props that are captured once
// at construction. Only safe for objects with plain data / closure methods.
export const activeFacade = <T extends object>(get: () => T, overrides?: Partial<Record<keyof T, unknown>>): T =>
  new Proxy({} as T, {
    get: (_t, prop) => {
      if (overrides && Object.hasOwn(overrides, prop)) return (overrides as any)[prop];
      const value = Reflect.get(get(), prop);
      if (typeof value !== "function") return value;
      // Dispatch at CALL time against the CURRENT active pane. Binding here
      // would freeze a method reference captured once at construction (bandCtx,
      // menu entries, OSC-72 handlers) to whichever pane was active then — the
      // exact stale-capture bug the facades exist to avoid.
      return (...args: unknown[]) => {
        const target = get();
        const fn = Reflect.get(target, prop);
        return typeof fn === "function" ? (fn as (...a: unknown[]) => unknown).apply(target, args) : undefined;
      };
    },
    set: (_t, prop, value) => {
      if (overrides && Object.hasOwn(overrides, prop)) {
        (overrides as any)[prop] = value;
        return true;
      }
      Reflect.set(get(), prop, value);
      return true;
    },
    has: (_t, prop) => (overrides ? Object.hasOwn(overrides, prop) : false) || prop in get(),
    deleteProperty: (_t, prop) => {
      Reflect.deleteProperty(get(), prop);
      return true;
    },
    ownKeys: () => Reflect.ownKeys(get()),
    getOwnPropertyDescriptor: (_t, prop) => Reflect.getOwnPropertyDescriptor(get(), prop),
  });

// A stable Map view over whichever pane is active: any Map operation forwards
// to the active pane's map, so a reference captured once keeps tracking the
// active pane. Used for selection.tileRefs, which ui-grid/rename/preview and
// the menu read through a long-lived ctx object.
export const activeMapFacade = <K, V>(get: () => Map<K, V>): Map<K, V> =>
  new Proxy(get(), {
    get: (_t, prop) => {
      const m = get();
      const value = Reflect.get(m, prop, m);
      return typeof value === "function" ? value.bind(m) : value;
    },
    set: (_t, prop, value) => {
      Reflect.set(get(), prop, value);
      return true;
    },
    has: (_t, prop) => Reflect.has(get(), prop),
  });

// A read-only live view that unions several maps (both panes' tileRefs), so
// hit-testing finds a tile id no matter which pane it lives in. `get`/`has`
// search in order; iteration/size/forEach span every map.
export const mergedMapFacade = <K, V>(maps: () => Array<Map<K, V>>): Map<K, V> =>
  new Proxy(new Map<K, V>(), {
    get: (_t, prop) => {
      const list = maps();
      if (prop === "get") {
        return (k: K): V | undefined => {
          for (const m of list) {
            if (m.has(k)) return m.get(k);
          }
          return undefined;
        };
      }
      if (prop === "has") return (k: K): boolean => list.some((m) => m.has(k));
      if (prop === "size") return list.reduce((n, m) => n + m.size, 0);
      if (prop === "forEach") {
        return (fn: (v: V, k: K, m: Map<K, V>) => void): void => {
          for (const m of list)
            m.forEach((v, k) => {
              fn(v, k, m);
            });
        };
      }
      if (prop === "keys" || prop === "values" || prop === "entries") {
        return function* (): Generator {
          for (const m of list) yield* (m as any)[prop]();
        };
      }
      if (prop === Symbol.iterator) {
        return function* (): Generator {
          for (const m of list) yield* m;
        };
      }
      return Reflect.get(_t, prop);
    },
  });
