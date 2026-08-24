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

## Icons

- SVG sources live in `assets/icons/*.svg` (single color, path-only, no `<text>`).
- Never commit pre-rasterized PNGs as icons. Icons flow through slots: `makeIconSlot(name, ...)` queues a fallback-glyph slot, `applyRasterIcons()` swaps in an async `iconPng(name, fg, bg, pxW, pxH)` raster — tints hex colors to the theme, rasterizes via `rsvg-convert` at exact cell pixels (square output), flattens onto bg (kitty alpha is unreliable → causes tint), caches by `name:fg:bg:WxH`.
- **Slot names must match SVG filenames exactly** (`makeIconSlot("chevron-left")` → `assets/icons/chevron-left.svg`). The swap's `catch {}` swallows ENOENT silently — a wrong name just leaves the small fallback glyph in place forever (bit us: nav buttons queued `back`/`fwd`, files were `chevron-left.svg`/`chevron-right.svg`).
- Nerd font glyphs are the fallback. **Verify codepoints against the font cmap before using** — icon-set comments in old code were wrong. Check with python fontTools (`getBestCmap`) against `/usr/share/fonts/TTF/MesloLGLDZ Nerd Font Mono (see fc-list)`.

## Conventions

- Theme = the `colors` object in `src/index.ts`; values come from TOML config (`src/config.ts`) at `~/.config/tfm/config.toml` (`$TFM_CONFIG` overrides). See `config.example.toml`. Invalid/missing keys fall back to defaults silently (parse errors warn once on stderr).
- UI is one file (`src/index.ts`), built imperatively at module level; runtime mutation goes through ids + `findDescendantById`.
- `.gitignore`d: `node_modules/`, `nautilus/`, `opentui/` (reference clones, not project code).
