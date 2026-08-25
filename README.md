# tfm — terminal file manager

Mouse-first file manager for the terminal. Nautilus-style places sidebar, grid view, drag-and-drop, image thumbnails, syntax-highlighted previews.

![alpha](https://img.shields.io/badge/status-alpha-red)

> [!WARNING]
> Experimental software — expect rough edges. Don't test on files you can't afford to lose.

## Features

- **Mouse-first**: click, rubber-band select, drag-and-drop (in-app and out to other apps via kitty OSC 72), context menus, inline rename
- **Desktop integration**: GTK bookmarks, recent files (`recently-used.xbel`), XDG trash with restore, system clipboard bridge
- **Safety**: everything destructive is trash-first and undoable (`ctrl+z`); replace conflicts stash victims in trash
- **Previews**: kitty image thumbnails, tree-sitter syntax highlighting, folder stats
- **Fast icons**: rsvg-tinted SVG rasters cached on disk per theme

## Requirements

- Linux + [Bun](https://bun.sh) (or use a compiled binary)
- A terminal with the [kitty graphics protocol](https://sw.kovidgoyal.net/kitty/graphics-protocol.html) (kitty, ghostty) — falls back to Nerd Font glyphs elsewhere
- `rsvg-convert` (icon rasterization), `wl-paste`/`xclip` (clipboard bridge)

## Install & run

```bash
bun install
bun run compile          # standalone binary in dist/
cp dist/tfm ~/.local/bin/tfm
tfm ~/some/path          # launches there; `terminal-file-manager` also works
```

Dev: `bun dev`.

## Keys

| Key | Action |
|---|---|
| type anywhere | live search · `enter` opens first match · `esc` cancels |
| `enter` / `f2` | open / rename |
| `backspace` | parent directory |
| `ctrl+z` / `ctrl+a` | undo / select all |
| `ctrl+h` | toggle hidden files |
| `delete` | trash (`delete` again in trash: permanent) |
| `ctrl+click` / `shift+click` | toggle / range select |
| plain drag / `ctrl+drag` | drag out of terminal / move inside tfm |
| right-click | context menu |

## Config

`~/.config/tfm/config.toml` — see [`config.example.toml`](config.example.toml). Themes, tile size, session restore, glyph-only icon mode.

## Limitations

- Linux only; no macOS/Windows support
- Image thumbnails need a kitty-graphics-protocol terminal (kitty, ghostty); others fall back to Nerd Font glyphs
- tmux hides rasters unless `allow-passthrough` is on; icons render but won't display images
- Cross-device moves are copy+delete (no atomic rename across filesystems)
- Single pane — no tabs or split view yet

## License

[MIT](LICENSE)
