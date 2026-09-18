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
// Deliberately `any`: the COLOR members and the tree/event methods. OpenTUI
// parses colors on assignment (widgets legitimately assign theme hex strings
// and read back RGBA objects), and the mutation methods' declared return types
// (`add() → number`, `handleKeyPress() → boolean`) are values the widgets
// ignore — pinning them would force fake nodes and no-op handlers to fabricate
// returns, and for handleKeyPress it would invite a behavior change (returning
// true "consumes" the key differently than the current void handlers do).
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
  fg?: any;
  bg?: any;
  backgroundColor?: any;
  // tree + lifecycle
  parent?: any;
  add?(child: any, index?: number): any;
  remove?(child: any): void;
  getChildren?(): any[];
  destroy?(): void;
  insertBefore?(child: any, anchor?: any): any;
  focus?(): void;
  blur?(): void;
  handleKeyPress?(key: any): any;
  on?(event: string, cb: (...args: any[]) => any): any;
  // mouse handlers (bivariant method syntax, see the note above)
  onMouseDown?(ev: any): void;
  onMouseUp?(ev: any): void;
  onMouseMove?(ev: any): void;
  onMouseOver?(ev: any): void;
  onMouseOut?(ev: any): void;
  onMouseDrop?(ev: any): void;
  onMouseDrag?(ev: any): void;
};

// What the lookup seam actually hands back: `undefined` when no node owns the
// id (`findDescendantById`) and `null` when the lookup itself throws. Both are
// real outcomes — writing `NodeLike` alone would be a lie that forces every
// caller to pretend resolution succeeded, and test fakes that mirror the real
// contract (`map.get(id)`, i.e. possibly-undefined) wouldn't typecheck.
export type MaybeNode = NodeLike | null | undefined;
