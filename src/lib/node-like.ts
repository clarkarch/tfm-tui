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

import type { ColorInput, MouseEvent } from "@opentui/core";

// The key shape the widgets read off a keypress (OpenTUI's ParsedKey `name`).
// Structural, so real ParsedKey values and test fakes both satisfy it.
export type KeyLike = { name?: string };

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
  // colors: hex string in, RGBA out — parsed by OpenTUI on assignment
  fg?: ColorInput;
  bg?: ColorInput;
  backgroundColor?: ColorInput;
  // tree + lifecycle
  parent?: NodeLike | null;
  add?(child: unknown, index?: number): unknown;
  remove?(child: unknown): void;
  getChildren?(): NodeLike[];
  destroy?(): void;
  insertBefore?(child: unknown, anchor?: unknown): unknown;
  focus?(): void;
  blur?(): void;
  handleKeyPress?(key: KeyLike): boolean;
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
