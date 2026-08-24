# tfm-tui

Terminal file manager — Nautilus-style places sidebar, grid view, mouse-first. Built on OpenTUI + Bun.

## Commands

```bash
bun dev              # run with watch
bun src/index.ts     # run
bunx tsc --noEmit --strict --target esnext --module esnext --moduleResolution bundler --skipLibCheck src/index.ts   # typecheck (always run after edits)
```

## Critical OpenTUI rules (learned the hard way)

- Composition helpers (`Box()`, `Text()`, `Input()`) return **lazy proxied VNodes**. Mutating them before/after mount silently does nothing. For runtime changes: give an `id`, then use `renderer.root.findDescendantById(id)` and mutate the real renderable.
- There is **no click event** — use `onMouseDown` / `onMouseUp`. Hover: `onMouseOver`/`onMouseOut`.
- **Images don't participate in flex layout reliably.** Wrap every `ImageRenderable` in a fixed-size plain `Box` slot; never let labels share flow with raw images.
- `renderer.resolution` is `null` at boot. Anything needing real cell pixels must wait/poll for it.
- Kitty images draw over text cells — keep rasters inside their own rows; never rely on z-order.
- `findDescendantById` works **post-mount only**.
- `console.log` / `console.error` are swallowed by the renderer — debug via file logging (`appendFileSync`, see `/tmp/tfm-dnd.log` pattern).
- Proxied VNodes: `getChildren()` pre-mount throws `"{} is not iterable"`; property mutations post-mount silently no-op.
- Don't let event handler params shadow closure variables — this caused the folder-open regression.
- **Text renderables default `selectable = true`** — the renderer's text-selection drag hijacks custom drag flows and short-circuits before capture/drop dispatch. Call `stripSelectable()` *after every async rebuild* (it races `renderGrid()` otherwise).
- Boot the renderer with `exitOnCtrlC: false` or Ctrl+C kills the app before key handlers see it.
- Mouse DnD primitives exist: first drag motion sets a captured renderable (source gets all drag events), release fires `onMouseDrop` on whatever is hovered with `.source` set. Build drags on this, not manual hit-testing.
- `renderer.subscribeOsc(cb)` is the sanctioned way to receive OSC sequences (kitty DnD etc.) — never add a second `process.stdin` data listener.
- Ctrl+I == Tab in all terminals; check `opentui/packages/core/src/lib/parse.keypress.ts` when binding keys.

## Kitty DnD (OSC 72) — what works

- Enable once: `\x1b]72;t=o:x=1;\x1b\\` (drag-out, trailing `;` = empty machine-id, byte-exact) + `\x1b]72;t=a;text/uri-list\x1b\\` (drop-in). Receive via `subscribeOsc`.
- MIME indices are **1-based** in requests (yazi's Lua ipairs). Drop data = unpadded base64 chunks until an empty frame; ack with FinishDrop `\x1b]72;t=r:o=1(copy)|2(move)`.
- Drag-out: kitty sends one-shot offer `t=o` at gesture start. Accept → pointer grabbed, real OS session (`AgreeDrag` + pre-sent `PresentDrag` + optional text `PresentDragIcon` badge + `StartDrag t=P:x=-1`). Decline → normal mouse events continue.
- Dead ends (don't retry): releasing over your own window returns `end canceled=true`, **no drop event**; kitty sends no mouse events past the window edge in 1006 mode; `?1016` pixel mode does report OOB but OpenTUI's parser drops negatives and misreads pixels as cells → mid-gesture internal→external handoff is impossible. Split modes at mousedown instead (we use: plain drag = external, ctrl+drag = internal).
- Debug log: `/tmp/tfm-dnd.log`.

## System clipboard bridge

- CLI tools can offer only ONE mime type per selection owner — can't have both. We publish **plain-text full paths** (one per line) so paste-anywhere works; Nautilus file-paste from tfm needs `x-special/gnome-copied-files` which would lose that.
- Paste INTO tfm reads `x-special/gnome-copied-files` via wl-paste/xclip and honors its cut/copy op word.

## Environment / tooling gotchas

- `gio trash` fails on tmpfs ("system internal mounts") — need an XDG manual fallback.
- `magick` SVG thumbnails require `-density` before the input path.

## Icons

- SVG sources live in `assets/icons/*.svg` (single color, path-only, no `<text>`).
- Never commit pre-rasterized PNGs as icons. Icons flow through slots: `makeIconSlot(name, ...)` queues a fallback-glyph slot, `applyRasterIcons()` swaps in an async `iconPng(name, fg, bg, pxW, pxH)` raster — tints hex colors to the theme, rasterizes via `rsvg-convert` at exact cell pixels (square output), flattens onto bg (kitty alpha is unreliable → causes tint), caches by `name:fg:bg:WxH`.
- **Slot names must match SVG filenames exactly** (`makeIconSlot("chevron-left")` → `assets/icons/chevron-left.svg`). The swap's `catch {}` swallows ENOENT silently — a wrong name just leaves the small fallback glyph in place forever (bit us: nav buttons queued `back`/`fwd`, files were `chevron-left.svg`/`chevron-right.svg`).
- Nerd font glyphs are the fallback. **Verify codepoints against the font cmap before using** — icon-set comments in old code were wrong. Check with python fontTools (`getBestCmap`) against `/usr/share/fonts/TTF/MesloLGLDZ Nerd Font Mono (see fc-list)`.

## Conventions

- Theme = the `colors` object in `src/index.ts`; values come from TOML config (`src/config.ts`) at `~/.config/tfm/config.toml` (`$TFM_CONFIG` overrides). See `config.example.toml`. Invalid/missing keys fall back to defaults silently (parse errors warn once on stderr).
- UI is one file (`src/index.ts`), built imperatively at module level; runtime mutation goes through ids + `findDescendantById`.
- `.gitignore`d: `node_modules/`, `nautilus/`, `opentui/` (reference clones, not project code).
