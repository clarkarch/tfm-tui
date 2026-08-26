# tfm-tui

Terminal file manager — Nautilus-style places sidebar, grid view, mouse-first. Built on OpenTUI + Bun.

## Commands

```bash
bun dev              # run with watch
bun src/index.ts     # run
bunx tsc --noEmit --strict --target esnext --module esnext --moduleResolution bundler --skipLibCheck src/index.ts   # typecheck (always run after edits)
```

## Doc hygiene

- The moment a fix reveals a non-obvious lesson, record it here; if any claim in this file proves wrong or hallucinated, correct it in the same change. Stale docs cause regressions — but only record what actually matters.

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
- **Put ids on the TEXT node, not its wrapper Box** when the text must change at runtime. Boxes have no `.content`, so `progSetText(boxId, …)`-style updates no-op silently (bit us twice: progress-toast title/bar stayed blank).
- **Never mutate selection at mousedown when that press can also start a drag.** A modifier that means both "click toggle" and "drag" (ctrl) must DEFER its click action to mouseup-without-movement (`commitPendingCtrlToggle`). Toggling at mousedown unselected the pressed tile → ctrl+drag moved 0 items ("Moved 0 items") and rubber-band + ctrl-drag silently dropped the pressed file from `dragKeys`. Drag payload = selection ∪ {pressed tile}, committed only once the drag threshold trips.

## Kitty DnD (OSC 72) — what works

- Enable once: `\x1b]72;t=o:x=1;\x1b\\` (drag-out, trailing `;` = empty machine-id, byte-exact) + `\x1b]72;t=a;text/uri-list\x1b\\` (drop-in). Receive via `subscribeOsc`.
- MIME indices are **1-based** in requests (yazi's Lua ipairs). Drop data = unpadded base64 chunks until an empty frame; ack with FinishDrop `\x1b]72;t=r:o=1(copy)|2(move)`.
- Drag-out: kitty sends one-shot offer `t=o` at gesture start. Accept → pointer grabbed, real OS session (`AgreeDrag` + pre-sent `PresentDrag` + optional text `PresentDragIcon` badge + `StartDrag t=P:x=-1`). Decline → normal mouse events continue.
- Dead ends (don't retry): releasing over your own window returns `end canceled=true`, **no drop event**; kitty sends no mouse events past the window edge in 1006 mode; `?1016` pixel mode does report OOB but OpenTUI's parser drops negatives and misreads pixels as cells → mid-gesture internal→external handoff is impossible. Split modes at mousedown instead (we use: plain drag = external, ctrl+drag = internal).
- Debug log: `/tmp/tfm-dnd.log`.

## Terminal quirks: kitty / ghostty / tmux

- tfm sends XTSHIFTESCAPE at boot (`CSI > Ps s` — final byte is **s**, `n` is silently ignored) and releases it on quit, asking the terminal to forward shift+click while we own the mouse.
- kitty STILL eats shift+left via its *default mouse_maps* (`shift+left press grabbed …`) — fixed by map-to-nothing overrides in `~/.config/kitty/kitty.conf` (see "forward shift+left-click" block). Ghostty just needs `mouse-shift-capture = true`.
- Alt+click is the universal fallback for range-select.
- tmux sends Ctrl+H as raw `\x08`, which OpenTUI's keyparser drops — that keybind can't be tested under tmux.
- Synthetic SGR clicks (`tmux send-keys -H 1b 5b 3c …`) are a reliable way to test mouse paths headlessly.

## System clipboard bridge

- CLI tools can offer only ONE mime type per selection owner — can't have both. We publish **plain-text full paths** (one per line) so paste-anywhere works; Nautilus file-paste from tfm needs `x-special/gnome-copied-files` which would lose that.
- Paste INTO tfm reads `x-special/gnome-copied-files` via wl-paste/xclip and honors its cut/copy op word.

## Environment / tooling gotchas

- `gio trash` fails on tmpfs ("system internal mounts") — need an XDG manual fallback (`xdgTrashMove`).
- The embedded terminal's VT answers nothing by itself — shells that probe at boot (fish: Primary DA) stall ~10s with a "could not read response" warning. `answerTerminalProbes` replies inline to DA1/DA2/DSR in the PTY stream; extend it there if another probe stalls a shell.
- `magick` SVG thumbnails require `-density` before the input path.

## Virtual places & file ops

- Sidebar "Recent"/"Starred" are virtual cwds (`recent://` / `starred://`) — guard anything touching `state.cwd` with `isVirtualCwd()` or it tries to readdir the URI.
- ALL copies/moves funnel through `runTransfer()` (conflict prompt, undo units, progress toast); renames through `performRename()` — raw `fsRename` silently overwrites on Linux.
- Undo = Ctrl+Z, redo = Ctrl+Y / Ctrl+Shift+Z (`pushUndoBatch` with paired `redos` — every batch carries forward AND inverse closures; a fresh op clears the redo stack; batches without `redos` (replace-stash) break the redo chain). Replace stashes victims in trash so undo restores them.
- Bookmarks = standard `~/.config/gtk-3.0/bookmarks` (folders only); toggle lives in properties dialog beside star.

## Icons

- SVG sources live in `assets/icons/*.svg` (single color, path-only, no `<text>`).
- Icons flow through slots: `makeIconSlot(name, ...)` queues a fallback-glyph slot, `drainIconQueue()` swaps in an async `iconPng(name, fg, bg, pxW, pxH)` raster — tints hex colors to the theme, rasterizes via `rsvg-convert` at exact cell pixels (square output), flattens onto bg (kitty alpha is unreliable → causes tint), caches by `name:fg:bg:WxH`.
- **Slot names must match SVG filenames exactly** (`makeIconSlot("chevron-left")` → `assets/icons/chevron-left.svg`). The swap's `catch {}` swallows ENOENT silently — a wrong name just leaves the small fallback glyph in place forever (bit us: nav buttons queued `back`/`fwd`, files were `chevron-left.svg`/`chevron-right.svg`).
- Nerd font glyphs are the fallback. **Verify codepoints against the font cmap before using** — icon-set comments in old code were wrong (a guessed paste glyph turned out to be cellphone_nfc). Check with python fontTools (`getBestCmap`) against `/usr/share/fonts/TTF/MesloLGLDZ Nerd Font Mono (see fc-list)`.

## Preview pane

- Text previews use OpenTUI's `CodeRenderable` + tree-sitter. Bundled grammars: js/ts/jsx/tsx, markdown, zig; more languages registered opencode-style via `addDefaultParsers` with wasm+query URLs (downloaded once, disk-cached). Highlighted node is memoized per file (key+mtime+size) so re-previews don't re-parse.
- Syntax palette = new `syntax*` keys on Theme (stolen per-theme from opencode assets by `scripts/gen-themes.ts`; tokyo-night fallbacks for old configs). Keyword=accent, comment/punctuation=muted, variable=fg are derived, not stored.
- `isTextLike`: known-text extensions (toml, ini, lock, …) short-circuit BEFORE mime checks — globs2 reports mimes like `application/toml` that fail a text/* whitelist (bit us: toml had no preview).
- Inline rename: F2 / context-menu edits the tile label in place (`startInlineRename`); commits go through `performRename`, Esc/click-away cancels.

## Conventions

- Theme = the `colors` object in `src/index.ts`; values come from TOML config (`src/config.ts`) at `~/.config/tfm/config.toml` (`$TFM_CONFIG` overrides). See `config.example.toml`. Invalid/missing keys fall back to defaults silently (parse errors warn once on stderr).
- UI is one file (`src/index.ts`), built imperatively at module level; runtime mutation goes through ids + `findDescendantById`.
- All config changes flow through ONE path: mutate → `applyConfig(fresh)` → `scheduleSaveConfig()` (debounced TOML write, atomic tmp+rename). `applyConfig` rewrites the mutable geometry lets (`sw`, `TILE_W/TILE_H/ICON_CELLS_H` — never bake these into consts), repaints boot-baked widgets via `rethemeChrome()` (extend it whenever you add a widget with baked colors), and invalidates icon/thumbnail caches on theme change. Boot-baked icon slots need a `statesFactory` or they keep stale palette rasters.
- `src/themes.ts` is generated — edit via `bun scripts/gen-themes.ts <opencode-assets-dir>` (steals dark palettes from opencode's TUI assets, flattens alpha hex onto bg, skips transparent-background themes).
- `transparent-bg` (ui, default off): kitty applies `background_opacity` to ANY cell whose bg byte-equals its default bg color — explicit `48;2` SGR included — so when the kitty theme matches the tfm theme, the whole TUI goes see-through (verified by probe: `48;2;26;27;38` blends, `48;2;26;27;39` doesn't; OpenTUI emits explicit truecolor either way). Off forces opaque via `bumpHex` (+1 blue on `colors.bg`) AND renderer clear color = same nudged bg. On keeps the faithful hex and blends. The nudge is runtime-only — config stores/round-trips RAW hex (`themePresetIdx` and TOML saves compare raw). Settings-row setters that flip this must pass a fresh object to `applyConfig` — mutating `config` first makes the diff self-compare equal and skips invalidation.
- Selection model: plain click = anchor + select, ctrl+click = toggle (anchor untouched, committed on mouseup — see deferred-toggle rule above), shift/alt+click & shift+arrows = extend from anchor. Ctrl+drag stays internal-move DnD.
- Drag diagnosis: `/tmp/tfm-dnd.log` logs the whole path (`drag offer` accept/decline + why, `tile mousedown/drop` payload counts, `moveInto` in/out filtering). `Moved 0 items` from a drag means `runTransfer` got an empty srcs list — trace `dragKeys` backwards.
- `.gitignore`d: `node_modules/`, `nautilus/`, `opentui/` (reference clones, not project code).
