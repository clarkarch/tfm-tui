// InputBarRenderable — single-line text input distilled from tedit's editor
// core (grapheme-aware cursor/width, word ops, shift/ctrl selection, double-click
// word select, in-bar undo/redo, bracketed paste, steady line cursor).
// Adapted from ~/Projects/vibecoded/js/tedit src/editor/* (MIT, same author).
import {
  Renderable,
  RGBA,
  type KeyEvent,
  type MouseEvent,
  type OptimizedBuffer,
  type PasteEvent,
} from "@opentui/core"

// --- grapheme width (from tedit width.ts, trimmed to what a bar needs)
const SEGMENTER = new Intl.Segmenter(undefined, { granularity: "grapheme" })

function graphemesOf(s: string): string[] {
  if (s.length === 0) return []
  return Array.from(SEGMENTER.segment(s), (seg) => seg.segment)
}

function isZeroWidth(cp: number): boolean {
  return cp === 0x200b || cp === 0x200c || cp === 0x200d || cp === 0xfeff
}

function isCombining(cp: number): boolean {
  return (
    (cp >= 0x0300 && cp <= 0x036f) ||
    (cp >= 0x0483 && cp <= 0x0489) ||
    (cp >= 0x1ab0 && cp <= 0x1aff) ||
    (cp >= 0x1dc0 && cp <= 0x1dff) ||
    (cp >= 0x20d0 && cp <= 0x20ff) ||
    (cp >= 0xfe00 && cp <= 0xfe0f)
  )
}

function isWide(cp: number): boolean {
  return (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0x303e) ||
    (cp >= 0x3041 && cp <= 0x33ff) ||
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0x4e00 && cp <= 0x9fff) ||
    (cp >= 0xa000 && cp <= 0xa4cf) ||
    (cp >= 0xa960 && cp <= 0xa97f) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe10 && cp <= 0xfe19) ||
    (cp >= 0xfe30 && cp <= 0xfe6f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1f64f) ||
    (cp >= 0x1f680 && cp <= 0x1f6ff)
  )
}

function charWidth(ch: string): number {
  if (ch.length === 0) return 0
  const cp = ch.codePointAt(0)!
  if (isZeroWidth(cp) || isCombining(cp)) return 0
  return isWide(cp) ? 2 : 1
}

export function strWidth(s: string): number {
  let w = 0
  for (const g of graphemesOf(s)) w += charWidth(g)
  return w
}

function graphemeBounds(s: string, i: number): [number, number] {
  let cur = 0
  for (const g of graphemesOf(s)) {
    const next = cur + g.length
    if (i >= cur && i < next) return [cur, next]
    cur = next
  }
  return [s.length, s.length]
}

function charIndexAtDisplayCol(s: string, displayCol: number): number {
  if (displayCol <= 0) return 0
  let col = 0
  let w = 0
  for (const g of graphemesOf(s)) {
    const gw = charWidth(g)
    if (gw === 0) {
      col += g.length
      continue
    }
    if (displayCol === w) return col
    if (displayCol < w + gw) return col
    col += g.length
    w += gw
  }
  return s.length
}

// --- word movement (tedit movement.ts semantics on a plain string)
function isWordChar(ch: string): boolean {
  if (ch.length !== 1) return false
  const c = ch.charCodeAt(0)
  return (c >= 97 && c <= 122) || (c >= 65 && c <= 90) || (c >= 48 && c <= 57) || c === 95
}
function isWs(ch: string): boolean {
  return ch === " " || ch === "\t"
}
function isPunct(ch: string): boolean {
  return !isWs(ch) && !isWordChar(ch)
}

function wordLeft(s: string, col: number): number {
  let c = col
  if (c === 0) return 0
  if (isWs(s[c - 1]!)) while (c > 0 && isWs(s[c - 1]!)) c--
  if (c === 0) return 0
  const kind = isWordChar(s[c - 1]!) ? "word" : "punct"
  while (c > 0 && (kind === "word" ? isWordChar(s[c - 1]!) : isPunct(s[c - 1]!))) c--
  return c
}

function wordRight(s: string, col: number): number {
  const len = s.length
  let c = col
  if (c >= len) return len
  if (isWs(s[c]!)) {
    while (c < len && isWs(s[c]!)) c++
    if (c >= len) return len
  }
  const kind = isWordChar(s[c]!) ? "word" : "punct"
  while (c < len && (kind === "word" ? isWordChar(s[c]!) : isPunct(s[c]!))) c++
  return c
}

function wordBoundsAt(s: string, col: number): [number, number] | null {
  let c = Math.max(0, Math.min(col, s.length))
  while (c < s.length && isWs(s[c]!)) c++
  if (c >= s.length) return null
  const kind = isWordChar(s[c]!) ? "word" : "punct"
  let start = c
  while (start > 0 && (kind === "word" ? isWordChar(s[start - 1]!) : isPunct(s[start - 1]!))) start--
  let end = c
  while (end < s.length && (kind === "word" ? isWordChar(s[end]!) : isPunct(s[end]!))) end++
  return [start, end]
}

// --- undo (single-line ops with typed-run coalescing)
type Op = { start: number; end: number; oldText: string; text: string }

class BarUndo {
  private stack: Op[][] = []
  private redoStack: Op[][] = []
  private lastInsertAt = 0

  record(op: Op, coalesce = false): void {
    const now = Date.now()
    const top = this.stack[this.stack.length - 1]
    if (
      coalesce &&
      top &&
      top.length === 1 &&
      now - this.lastInsertAt < 600 &&
      top[0]!.start + top[0]!.text.length === op.start &&
      op.oldText === ""
    ) {
      top[0]!.text += op.text
      top[0]!.end += op.text.length
    } else {
      this.stack.push([op])
      if (this.stack.length > 200) this.stack.shift()
    }
    this.lastInsertAt = now
    this.redoStack = []
  }

  breakCoalescing(): void {
    this.lastInsertAt = 0
  }

  undo(): Op[] | null {
    const group = this.stack.pop()
    if (!group) return null
    this.redoStack.push(group)
    return group
  }

  redo(): Op[] | null {
    const group = this.redoStack.pop()
    if (!group) return null
    this.stack.push(group)
    return group
  }

  clear(): void {
    this.stack = []
    this.redoStack = []
  }
}

function hexToRgba(hex: string | undefined, fallback: RGBA): RGBA {
  if (!hex || !/^#[0-9a-fA-F]{6}$/.test(hex)) return fallback
  const n = parseInt(hex.slice(1), 16)
  return RGBA.fromInts((n >> 16) & 255, (n >> 8) & 255, n & 255)
}

const DEFAULT_FG = RGBA.fromInts(224, 224, 224)
const DEFAULT_PLACEHOLDER = RGBA.fromInts(110, 110, 130)
const SEL_BG = RGBA.fromInts(58, 92, 148)
const SEL_FG = RGBA.fromInts(255, 255, 255)

export interface InputBarOptions {
  id?: string
  width?: number | `${number}%`
  flexGrow?: number
  value?: string
  placeholder?: string
  backgroundColor?: string
  focusedBackgroundColor?: string
  textColor?: string
  placeholderColor?: string
  cursorStyle?: "block" | "underline" | "line"
  maxLength?: number
  visible?: boolean
  onChange?: (value: string) => void
  onSubmit?: (value: string) => void
  onCancel?: (value: string) => void
  clipboardRead?: () => Promise<string | null>
  onCopy?: (text: string) => void
}

export class InputBarRenderable extends Renderable {
  public barBg: string | undefined
  public barFocusedBg: string | undefined
  public barFg: string | undefined
  public barPlaceholderColor: string | undefined

  private textValue: string
  private col = 0
  private anchor: number | null = null
  private scrollX = 0
  private undoStack = new BarUndo()
  private placeholder: string
  private cursorStyle: "block" | "underline" | "line"
  private maxLength: number
  private onChange?: (v: string) => void
  private onSubmit?: (v: string) => void
  private onCancel?: (v: string) => void
  private clipboardRead?: () => Promise<string | null>
  private onCopy?: (text: string) => void
  private lastDown: { x: number; time: number } | null = null
  private clickCount = 0

  constructor(ctx: ConstructorParameters<typeof Renderable>[0], options: InputBarOptions = {}) {
    super(ctx, {
      ...(options.id ? { id: options.id } : {}),
      width: options.width ?? "100%",
      height: 1,
      ...(options.flexGrow ? { flexGrow: options.flexGrow } : {}),
      overflow: "hidden",
    })
    this._focusable = true
    this.textValue = options.value ?? ""
    this.placeholder = options.placeholder ?? ""
    this.barBg = options.backgroundColor
    this.barFocusedBg = options.focusedBackgroundColor ?? options.backgroundColor
    this.barFg = options.textColor
    this.barPlaceholderColor = options.placeholderColor
    this.cursorStyle = options.cursorStyle ?? "line"
    this.maxLength = options.maxLength ?? Infinity
    this.onChange = options.onChange
    this.onSubmit = options.onSubmit
    this.onCancel = options.onCancel
    this.clipboardRead = options.clipboardRead
    this.onCopy = options.onCopy
    // visible's setter touches layout bookkeeping that only exists once the
    // node joins the tree — defer any initial hidden state
    if (options.visible === false) {
      setTimeout(() => { try { this.visible = false } catch {} }, 0)
    }
  }

  get value(): string {
    return this.textValue
  }

  set value(v: string) {
    this.textValue = v
    this.col = v.length
    this.anchor = null
    this.scrollX = 0
    this.undoStack.clear()
    this.requestRender()
  }

  clear(): void {
    this.value = ""
  }

  selectAll(): void {
    this.anchor = 0
    this.col = this.textValue.length
    this.requestRender()
  }

  applyColors(colors: { bg?: string; focusedBg?: string; fg?: string }): void {
    if (colors.bg !== undefined) this.barBg = colors.bg
    if (colors.focusedBg !== undefined) this.barFocusedBg = colors.focusedBg
    if (colors.fg !== undefined) this.barFg = colors.fg
    this.requestRender()
  }

  override focus(): void {
    super.focus()
    if (this.isDestroyed) return
    try {
      this._ctx.setCursorStyle({ style: this.cursorStyle, blinking: false })
    } catch {}
    this.requestRender()
  }

  override blur(): void {
    super.blur()
    if (this.isDestroyed) return
    try { this._ctx.setCursorPosition(0, 0, false) } catch {}
    this.requestRender()
  }

  // --- editing primitives
  private hasSel(): boolean {
    return this.anchor !== null && this.anchor !== this.col
  }

  private selStartCol(): number {
    return Math.min(this.anchor ?? this.col, this.col)
  }

  private selEndCol(): number {
    return Math.max(this.anchor ?? this.col, this.col)
  }

  private moveTo(col: number, select: boolean): void {
    col = Math.max(0, Math.min(col, this.textValue.length))
    if (!select) this.anchor = null
    else if (this.anchor === null) this.anchor = this.col
    this.col = col
  }

  private applyEdit(op: Op, coalesce = false): void {
    this.undoStack.record(op, coalesce)
    this.textValue = this.textValue.slice(0, op.start) + op.text + this.textValue.slice(op.end)
  }

  private deleteSelection(): boolean {
    if (!this.hasSel()) return false
    const s = this.selStartCol()
    const e = this.selEndCol()
    this.undoStack.breakCoalescing()
    this.applyEdit({ start: s, end: e, oldText: this.textValue.slice(s, e), text: "" })
    this.anchor = null
    this.col = s
    return true
  }

  insertText(t: string): void {
    if (!t) return
    t = t.replace(/[\n\r\t]+/g, " ")
    if (this.hasSel()) {
      const s = this.selStartCol()
      const e = this.selEndCol()
      this.undoStack.breakCoalescing()
      this.applyEdit({ start: s, end: e, oldText: this.textValue.slice(s, e), text: t })
      this.anchor = null
      this.col = s + t.length
    } else {
      this.applyEdit({ start: this.col, end: this.col, oldText: "", text: t }, true)
      this.col += t.length
    }
    if (this.maxLength !== Infinity && this.textValue.length > this.maxLength) {
      const over = this.textValue.length - this.maxLength
      this.textValue = this.textValue.slice(over)
      this.col = Math.max(0, this.col - over)
    }
    this.onChange?.(this.textValue)
  }

  private moveLeft(select: boolean): void {
    if (!select && this.hasSel()) {
      this.col = this.selStartCol()
      this.anchor = null
      return
    }
    if (this.col > 0) {
      const [start] = graphemeBounds(this.textValue, this.col - 1)
      this.moveTo(start, select)
    } else this.moveTo(this.col, select)
  }

  private moveRight(select: boolean): void {
    if (!select && this.hasSel()) {
      this.col = this.selEndCol()
      this.anchor = null
      return
    }
    if (this.col < this.textValue.length) {
      const [, end] = graphemeBounds(this.textValue, this.col)
      this.moveTo(end, select)
    } else this.moveTo(this.col, select)
  }

  private deleteBackward(): void {
    if (this.deleteSelection()) return
    this.undoStack.breakCoalescing()
    if (this.col > 0) {
      const [start] = graphemeBounds(this.textValue, this.col - 1)
      this.applyEdit({ start, end: this.col, oldText: this.textValue.slice(start, this.col), text: "" })
      this.col = start
    }
    this.onChange?.(this.textValue)
  }

  private deleteForward(): void {
    if (this.deleteSelection()) return
    this.undoStack.breakCoalescing()
    if (this.col < this.textValue.length) {
      const [, end] = graphemeBounds(this.textValue, this.col)
      this.applyEdit({ start: this.col, end, oldText: this.textValue.slice(this.col, end), text: "" })
    }
    this.onChange?.(this.textValue)
  }

  private deleteWordBackward(): void {
    if (this.deleteSelection()) return
    this.undoStack.breakCoalescing()
    if (this.col > 0) {
      const start = wordLeft(this.textValue, this.col)
      this.applyEdit({ start, end: this.col, oldText: this.textValue.slice(start, this.col), text: "" })
      this.col = start
    }
    this.onChange?.(this.textValue)
  }

  private deleteWordForward(): void {
    if (this.deleteSelection()) return
    this.undoStack.breakCoalescing()
    if (this.col < this.textValue.length) {
      const end = wordRight(this.textValue, this.col)
      this.applyEdit({ start: this.col, end, oldText: this.textValue.slice(this.col, end), text: "" })
    }
    this.onChange?.(this.textValue)
  }

  private deleteToEnd(): void {
    this.undoStack.breakCoalescing()
    if (this.col < this.textValue.length) {
      this.applyEdit({ start: this.col, end: this.textValue.length, oldText: this.textValue.slice(this.col), text: "" })
    }
    this.onChange?.(this.textValue)
  }

  private deleteToStart(): void {
    this.undoStack.breakCoalescing()
    if (this.col > 0) {
      this.applyEdit({ start: 0, end: this.col, oldText: this.textValue.slice(0, this.col), text: "" })
      this.col = 0
    }
    this.onChange?.(this.textValue)
  }

  private doUndo(): void {
    const group = this.undoStack.undo()
    if (!group) return
    for (let i = group.length - 1; i >= 0; i--) {
      const op = group[i]!
      this.textValue = this.textValue.slice(0, op.start) + op.oldText + this.textValue.slice(op.end)
      this.col = op.start + op.oldText.length
    }
    this.anchor = null
    this.onChange?.(this.textValue)
  }

  private doRedo(): void {
    const group = this.undoStack.redo()
    if (!group) return
    for (const op of group) {
      this.textValue = this.textValue.slice(0, op.start) + op.text + this.textValue.slice(op.end)
      this.col = op.start + op.text.length
    }
    this.anchor = null
    this.onChange?.(this.textValue)
  }

  private selectedText(): string {
    if (!this.hasSel()) return ""
    return this.textValue.slice(this.selStartCol(), this.selEndCol())
  }

  private clipToWidth(s: string, maxWidth: number): string {
    let out = ""
    let w = 0
    for (const g of graphemesOf(s)) {
      const gw = charWidth(g)
      if (w + gw > maxWidth) break
      out += g
      w += gw
    }
    return out
  }

  private numericWidth(fallback: number): number {
    return typeof this.width === "number" ? this.width : fallback
  }

  // --- input
  override handleKeyPress(key: KeyEvent): boolean {
    if (key.name === "escape") {
      this.onCancel?.(this.textValue)
      return true
    }
    if (key.name === "return" || key.name === "kpenter") {
      this.onSubmit?.(this.textValue)
      return true
    }
    const alt = !!(key as any).meta || !!(key as any).option
    const wordNav = !!key.ctrl || alt || !!key.super

    switch (key.name) {
      case "left":
        if (key.super) this.moveTo(0, key.shift)
        else if (wordNav) this.moveTo(wordLeft(this.textValue, this.col), key.shift)
        else this.moveLeft(key.shift)
        return true
      case "right":
        if (key.super) this.moveTo(this.textValue.length, key.shift)
        else if (wordNav) this.moveTo(wordRight(this.textValue, this.col), key.shift)
        else this.moveRight(key.shift)
        return true
      case "home":
        this.moveTo(0, key.shift)
        return true
      case "end":
        this.moveTo(this.textValue.length, key.shift)
        return true
      case "backspace":
        if (wordNav) this.deleteWordBackward()
        else this.deleteBackward()
        return true
      case "delete":
        if (wordNav) this.deleteWordForward()
        else this.deleteForward()
        return true
      case "a":
        if (key.ctrl || key.super) { this.selectAll(); return true }
        break
      case "k":
        if (key.ctrl) { this.deleteToEnd(); return true }
        break
      case "u":
        if (key.ctrl) { this.deleteToStart(); return true }
        break
      case "d":
        if (key.ctrl && !key.shift) { this.deleteForward(); return true }
        break
      case "z":
        if (key.ctrl || key.super) {
          if (key.shift) this.doRedo()
          else this.doUndo()
          return true
        }
        break
      case "y":
        if (key.ctrl) { this.doRedo(); return true }
        break
      case "c":
        if (key.ctrl || key.super) {
          const sel = this.selectedText()
          if (sel) this.onCopy?.(sel)
          return true
        }
        break
      case "x":
        if (key.ctrl || key.super) {
          const sel = this.selectedText()
          if (sel) {
            this.onCopy?.(sel)
            this.deleteSelection()
            this.onChange?.(this.textValue)
          }
          return true
        }
        break
      case "v":
        if ((key.ctrl || key.super) && this.clipboardRead) {
          void this.clipboardRead().then((t) => {
            if (t) { this.insertText(t); this.requestRender() }
          })
          return true
        }
        break
      case "w":
        if (key.ctrl) { this.deleteWordBackward(); return true }
        break
    }

    if (key.ctrl || key.super || (key as any).meta) return false
    const seq = key.sequence
    if (seq) {
      const c0 = seq.charCodeAt(0)
      if (c0 >= 32 && c0 !== 127) {
        this.insertText(seq)
        this.requestRender()
        return true
      }
    }
    return false
  }

  override handlePaste(event: PasteEvent): void {
    const text = new TextDecoder().decode(event.bytes).replace(/\x1b\[[0-9;]*[A-Za-z]/g, "")
    this.insertText(text)
    this.requestRender()
  }

  // --- mouse: click places cursor, drag selects, double-click selects word
  protected override onMouseEvent(event: MouseEvent): void {
    switch (event.type) {
      case "down": {
        if (event.button !== 0) break
        const now = Date.now()
        const prev = this.lastDown
        const multi = prev !== null && now - prev.time < 400 && Math.abs(event.x - prev.x) <= 2
        this.clickCount = multi ? this.clickCount + 1 : 1
        this.lastDown = { x: event.x, time: now }
        this.focus()
        const localCol = event.x - this._screenX + this.scrollX
        const target = charIndexAtDisplayCol(this.textValue, Math.max(0, localCol))
        if (this.clickCount === 2) {
          const bounds = wordBoundsAt(this.textValue, target)
          if (bounds) { this.anchor = bounds[0]; this.col = bounds[1] }
          else { this.anchor = null; this.col = target }
        } else {
          this.anchor = null
          this.col = target
        }
        this.ensureCursorVisible()
        this.requestRender()
        break
      }
      case "drag": {
        if (event.button !== 0) break
        if (this.anchor === null) this.anchor = this.col
        const localCol = event.x - this._screenX + this.scrollX
        this.col = charIndexAtDisplayCol(this.textValue, Math.max(0, localCol))
        this.ensureCursorVisible()
        this.requestRender()
        break
      }
    }
  }

  private ensureCursorVisible(): void {
    const avail = Math.max(1, this.numericWidth(40))
    const cw = strWidth(this.textValue.slice(0, this.col))
    if (cw < this.scrollX + 1) this.scrollX = Math.max(0, cw - 1)
    else if (cw >= this.scrollX + avail) this.scrollX = cw - avail
    const totalW = strWidth(this.textValue)
    this.scrollX = Math.max(0, Math.min(this.scrollX, Math.max(0, totalW - avail)))
  }

  // --- painting
  protected override renderSelf(buffer: OptimizedBuffer, _deltaTime: number): void {
    const x0 = this._screenX
    const y0 = this._screenY
    const w = Math.max(0, this.numericWidth(40))
    const bgHex = this._focused ? this.barFocusedBg : this.barBg
    const bgRgba = bgHex ? hexToRgba(bgHex, DEFAULT_FG) : undefined

    // background fill keeps the bar shape even when empty
    if (bgRgba) buffer.drawText(" ".repeat(w), x0, y0, bgRgba, bgRgba)

    const fgRgba = hexToRgba(this.barFg, DEFAULT_FG)

    if (this.textValue.length === 0) {
      if (!this._focused && this.placeholder) {
        buffer.drawText(
          this.clipToWidth(this.placeholder, w),
          x0, y0,
          hexToRgba(this.barPlaceholderColor, DEFAULT_PLACEHOLDER),
          bgRgba,
        )
      }
      return
    }

    // horizontal window around the cursor
    this.ensureCursorVisible()
    const startIdx = charIndexAtDisplayCol(this.textValue, this.scrollX)
    const chars = this.clipToWidth(this.textValue.slice(startIdx), w)
    if (!chars) return
    const endIdx = startIdx + chars.length

    if (this.hasSel()) {
      const s0 = Math.max(this.selStartCol(), startIdx)
      const s1 = Math.min(this.selEndCol(), endIdx)
      let dx = x0
      if (s0 > startIdx) {
        const pre = this.clipToWidth(this.textValue.slice(startIdx, s0), w)
        if (pre) { buffer.drawText(pre, dx, y0, fgRgba, bgRgba); dx += strWidth(pre) }
      }
      if (s1 > s0) {
        const budget = w - (dx - x0)
        const mid = this.clipToWidth(this.textValue.slice(s0, s1), budget)
        if (mid) { buffer.drawText(mid, dx, y0, SEL_FG, SEL_BG); dx += strWidth(mid) }
      }
      if (dx - x0 < w) {
        const post = this.clipToWidth(this.textValue.slice(Math.min(s1, endIdx), endIdx), w - (dx - x0))
        if (post) buffer.drawText(post, dx, y0, fgRgba, bgRgba)
      }
    } else {
      buffer.drawText(chars, x0, y0, fgRgba, bgRgba)
    }
  }

  override render(buffer: OptimizedBuffer, deltaTime: number): void {
    super.render(buffer, deltaTime)
    if ((this as any)._focused && !this.isDestroyed) {
      const col = strWidth(this.textValue.slice(0, this.col)) - this.scrollX
      try { this._ctx.setCursorPosition(this._screenX + Math.max(0, col), this._screenY, true) } catch {}
    }
  }
}
