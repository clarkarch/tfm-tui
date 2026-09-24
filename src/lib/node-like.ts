// --- Minimal structural view of an OpenTUI renderable for the `byId` seam.
//
// The lookup seam used to be `byId(id: string): any`, which silently defeated
// the strict settings for the entire post-mount mutation surface: a typo or a
// wrong-node-type access compiled and simply did nothing ("progSetText(boxId)"
// variants — ids must live on the TEXT node, mutating a Box's `content` no-ops
// silently). Naming the members the widgets actually touch turns that class of
// bug into a compile error while keeping every existing call site unchanged.
//
// Members are typed from the real usage in src/ (measured, not guessed):
// `content`/`value` strings, `visible`/`opacity`/`translateX`/`translateY`
// numbers, whole-cell layout writes.
//
// The layout members MUST carry OpenTUI's CssLike union (`number | "auto" |
// `${number}%``): the class declares its dimensions that way, so a narrow
// `number` would make a real Renderable unassignable to this view (measured —
// that was the first tsc error).
//
// Colors use OpenTUI's own `ColorInput` (`string | RGBA`), which is exactly the
// contract the widgets rely on: assign a theme hex, read back an RGBA.
//
// `unknown` (not `any`) where the value is genuinely opaque to this module —
// the tree/event methods. `unknown` still accepts every real argument, but a
// caller must narrow before use, so it cannot silently launder a typo.
//
// Parameter positions are declared with METHOD syntax on purpose: TS checks
// method parameters bivariantly (strictFunctionTypes exempts method
// declarations), which is what lets a real Renderable — whose `add` takes a
// concrete `Renderable` — satisfy this structural view.

import type { ColorInput, KeyEvent, MouseEvent, Renderable } from "@opentui/core";

export type NodeLike = {
  id?: string;
  // text / input state (TextRenderable, InputRenderable, TextareaRenderable)
  content?: string;
  value?: string;
  // visibility + motion (animations and the hover drawer write these)
  visible?: boolean;
  opacity?: number;
  translateX?: number;
  translateY?: number;
  // layout, mutated post-mount by the widgets
  width?: number | "auto" | `${number}%`;
  height?: number | "auto" | `${number}%`;
  left?: number | "auto" | `${number}%`;
  top?: number | "auto" | `${number}%`;
  scrollTop?: number;
  // screen-space geometry, read by the drag ghost/band positioning. Required:
  // Renderable declares all four as plain number getters.
  x: number;
  y: number;
  screenX: number;
  screenY: number;
  // colors: hex string in, RGBA out — parsed by OpenTUI on assignment.
  // `textColor`/`focusedBackgroundColor` are runtime-assigned through OpenTUI's
  // options bag and carry no .d.ts declaration, which is exactly why they need
  // naming here: a theme repaint of the wrong node is otherwise invisible.
  fg?: ColorInput;
  bg?: ColorInput;
  backgroundColor?: ColorInput;
  color?: ColorInput | ColorInput[]; // ASCIIFont wordmark
  borderColor?: ColorInput;
  // surface chrome written by style.ts's applySurface
  border?: boolean;
  borderStyle?: string;
  textColor?: ColorInput;
  focusedTextColor?: ColorInput;
  focusedBackgroundColor?: ColorInput;
  // text-selection opt-out: every rebuilt Text node defaults selectable, and
  // the renderer's selection drag hijacks the file-drag flows (stripSelectable)
  selectable?: boolean;
  // teardown guard — a node reaped by an async rebuild answers true here
  isDestroyed?: boolean;
  // tree + lifecycle — REQUIRED because Renderable declares every one of them
  // (`abstract getChildren()`, `add`, `remove`, `insertBefore`, `destroy`,
  // `focus`, `blur`), so the widgets may call them unguarded. Only the ones a
  // real Renderable genuinely lacks stay optional.
  parent?: NodeLike | null;
  add(child: unknown, index?: number): unknown;
  remove(child: unknown): void;
  getChildren(): NodeLike[];
  destroy(): void;
  insertBefore(child: unknown, anchor?: unknown): unknown;
  focus(): void;
  blur(): void;
  handleKeyPress?(key: KeyEvent): boolean;
  // `unknown[]` rather than `never[]`: a real Renderable.on takes `any[]`, and
  // `any` is NOT assignable to `never`, so `never[]` failed assignability in
  // both bivariance directions (measured). `unknown[]` accepts it, and a
  // listener declared with narrower params still satisfies it.
  on?(event: string, cb: (...args: unknown[]) => unknown): unknown;
  // mouse handlers — the real OpenTUI event, so `ev.x`/`ev.modifiers` are typed
  onMouseDown?(ev: MouseEvent): void;
  onMouseUp?(ev: MouseEvent): void;
  onMouseMove?(ev: MouseEvent): void;
  onMouseOver?(ev: MouseEvent): void;
  onMouseOut?(ev: MouseEvent): void;
  onMouseDrop?(ev: MouseEvent): void;
  onMouseDrag?(ev: MouseEvent): void;
  onMouseScroll?(ev: MouseEvent): void;
};

// What the lookup seam actually hands back: `undefined` when no node owns the
// id (`findDescendantById`) and `null` when the lookup itself throws. Both are
// real outcomes — writing `NodeLike` alone would be a lie that forces every
// caller to pretend resolution succeeded, and test fakes that mirror the real
// contract (`map.get(id)`, i.e. possibly-undefined) wouldn't typecheck.
export type MaybeNode = NodeLike | null | undefined;

// The renderer root, as the lookup helpers see it: a node that can resolve ids
// (`renderer.root`). Widening NodeLike, so stripSelectable can walk from it.
export type NodeRoot = NodeLike & { findDescendantById(id: string): MaybeNode };

// The scroll container the grid paints into and the selection module scrolls,
// as they actually use it: a live scroll offset, the content host rows mount
// into, and the ScrollBox's resolved viewport height. Structural on purpose —
// the scroll hook reaches into the scrollbar's private change callback and the
// tests dial `viewport` directly, neither of which a concrete ScrollBoxRenderable
// (whose viewport is readonly) can express. Lives here, in the leaf module, so
// ui/ and input/ can both name it without an import cycle.
export type ScrollerLike = {
  scrollTop: number;
  // present on a real ScrollBox; test literals omit it
  scrollTo?(position: number | { x?: number; y?: number }): void;
  viewport?: { height: number | "auto" | `${number}%` } | null;
  content: {
    getChildren(): Renderable[];
    add(child: unknown, index?: number): unknown;
    remove(child: unknown): void;
  };
};
