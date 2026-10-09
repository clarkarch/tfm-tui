// --- Grid window math: the pure viewport/row-range arithmetic the grid builds
// and slides against, plus the scroller scroll hook. Split out of ui-grid so
// the geometry can be read (and tested) without the renderable builders: this
// module imports nothing, touches no renderer, and holds no state. ---

// ScrollBox's scrollbar holds its change callback privately; the thumb drag
// writes the position field raw and then calls it, bypassing scrollTop's setter.
type ScrollBarHookable = { _onChange?: (position: number) => void };
type ScrollBarHost = { verticalScrollBar?: ScrollBarHookable };

// ONE viewport window for both the thumbnail drain ranking and the file
// animation cap — they must agree, or a tile the animator skipped is also
// (worse) not the one the thumb worker treats as urgent. `+1` row of slack
// covers the partially visible one at the bottom. Pure, so both call sites
// (and the test) read the same math.
export const visibleTileCap = (termH: number, rowH: number, cols: number): number =>
  cols * (Math.floor(termH / rowH) + 1);

// the bottom VISIBLE row for a scroll offset — overlap-based, not full-row
// math: a row counts the moment its TOP cell enters the viewport.
// firstRow + floor(visH/rowH) waits until the row fits whole, delaying the
// bottom scroll-reveal by up to rowH-1 cells. The -1 keeps exact alignment
// from counting the next row (scrollTop=0, visH=10, rh=5 → rows 0..1, not 2).
export const visibleBottomRow = (scrollTop: number, visH: number, rowHgt: number, rows: number): number => {
  if (rows <= 0) return -1;
  if (!(rowHgt > 0)) return rows - 1;
  if (!(visH > 0)) return Math.max(0, Math.min(rows - 1, Math.floor(Math.max(0, scrollTop) / rowHgt)));
  return Math.max(0, Math.min(rows - 1, Math.floor((Math.max(0, scrollTop) + visH - 1) / rowHgt)));
};

// rows of built-but-unseen slack above/below the viewport in windowed mode —
// the scroll hook fires on EVERY integer row scroll, so this only absorbs
// partial-row wheels; a fling past it just slides the window (incremental —
// visible rows are never destroyed)
const WINDOW_OVERSCAN = 1;

// the windowed row range for a scroll offset — pure, used by BOTH the initial
// windowed build and every slide so the two can never drift. firstRow is
// CLAMPED to the row count: a listing that shrinks while scrolled deep
// (mass-delete, watcher rebuild) renders against the still-stale scrollTop
// before the next layout pass re-clamps it — an unclamped window (r0 > r1)
// would build a pads-only pane (a blank flash + a wasted rebuild).
export const windowRange = (
  scrollTop: number,
  rowHgt: number,
  rows: number,
  termH: number,
): { firstRow: number; r0: number; r1: number } => {
  const firstRow = Math.max(0, Math.min(Math.floor(scrollTop / rowHgt), rows - 1));
  return {
    firstRow,
    r0: Math.max(0, firstRow - WINDOW_OVERSCAN),
    r1: Math.min(rows - 1, firstRow + Math.floor(termH / rowHgt) + WINDOW_OVERSCAN),
  };
};

// wrap a scroller's `scrollTop` accessor AND its vertical scrollbar's onChange
// so every scroll path notifies the windowed grid. The setter covers wheel
// (ScrollBox does `scrollTop += n`), drag auto-scroll and programmatic
// scrollTo, but a THUMB DRAG bypasses it entirely (ScrollBar's slider writes
// its `_scrollPosition` field raw, then calls the bar's `_onChange` closure
// — ScrollBox.ts wires that to content.translateY only). By `_onChange` run
// time the scrollTop GETTER already reads the new position, so the chained
// callback sees the same value every path does. ScrollBox exposes no scroll
// event; this beats per-frame polling. A single notch can fire onScroll 2-3x
// (setter + the slider re-entrancy in updateSliderFromScrollState + the
// slide's own offset-restore write) — the callback MUST be idempotent;
// syncWindow's range-equality guard makes the repeats free.
// `object` (not GridScroller): the hook probes for a scrollTop accessor and
// rejects anything else, so a bare object is a legitimate argument.
export const hookScrollerScroll = (scroller: object, onScroll: () => void): boolean => {
  let hooked = false;
  try {
    const proto = Object.getPrototypeOf(scroller);
    const d = proto && Object.getOwnPropertyDescriptor(proto, "scrollTop");
    // bind the setter once: the descriptor's own `set` widens back to optional
    // inside the closure below
    const setter = d && typeof d.set === "function" ? d.set : undefined;
    if (d && setter && !Object.getOwnPropertyDescriptor(scroller, "scrollTop")) {
      Object.defineProperty(scroller, "scrollTop", {
        configurable: true,
        get: d.get,
        set(value: number) {
          setter.call(this, value);
          try {
            onScroll();
          } catch {}
        },
      });
      hooked = true;
    }
  } catch {}
  try {
    const bar = (scroller as ScrollBarHost).verticalScrollBar;
    if (bar && typeof bar._onChange === "function") {
      const orig = bar._onChange.bind(bar);
      bar._onChange = (position: number) => {
        orig(position);
        try {
          onScroll();
        } catch {}
      };
      hooked = true;
    }
  } catch {}
  return hooked;
};
