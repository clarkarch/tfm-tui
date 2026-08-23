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
- Never commit pre-rasterized PNGs as icons. Use `iconPng(name, fg, bg)` in `src/index.ts`: it tints hex colors to the theme, rasterizes via `rsvg-convert` at exact cell pixels (square output), flattens onto bg (kitty alpha is unreliable → causes tint), and caches by `name:fg:bg:WxH`.
- Nerd font glyphs are the fallback. **Verify codepoints against the font cmap before using** — icon-set comments in old code were wrong. Check with python fontTools (`getBestCmap`) against `/usr/share/fonts/TTF/MesloLGLDZNerdFontMono-Regular.ttf`.

## Conventions

- Theme = the `colors` object (Catppuccin Mocha) in `src/index.ts`. All colors come from there.
- UI is one file (`src/index.ts`), built imperatively at module level; runtime mutation goes through ids + `findDescendantById`.
- `.gitignore`d: `node_modules/`, `nautilus/`, `opentui/` (reference clones, not project code).
