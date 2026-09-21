# tfm (terminal file manager)

A modern, mouse-first file manager with places sidebar, grid view, drag & drop, image thumbnails and more, right inside your terminal.

![beta](https://img.shields.io/badge/status-beta-yellow) [![website](https://img.shields.io/badge/website-tfm--tui-blue?logo=githubpages&logoColor=white)](https://clarkarch.github.io/tfm-tui/)

> [!WARNING]
> Beta software, usable daily, but still back up anything irreplaceable first before performing a files op. 

> [!IMPORTANT]
> This is still a terminal UI running inside your terminal, expect some visual/behavioral anomalies.

![tfm](screenshot.png)

## Features

- Mouse: click, rubber-band select, right-click menus, drag and drop.
- Browse files in grid or list view.
- Sidebar with places, bookmarks, drives, trash, recent, starred.
- Search as you type, including inside subfolders.
- Sort by name, size, date.
- Copy, move, paste, duplicate, rename.
- Bulk rename multiple files at once.
- New file / new folder inline.
- Drag and drop between panes and from other apps.
- Trash, restore, delete forever, empty trash.
- Undo / redo file operations.
- Preview text, code, images, videos, folders.
- Open files + Open With app picker.
- Properties dialog with permissions editing.
- Tabs + dual pane.
- Connect to network servers.
- Extract and compress archives.
- Embedded terminal.
- Clipboard copy/paste with other apps.
- Edit system files with a sudo prompt.
- Customizable themes, settings GUI, keybinds.
- Plugin support with hot reload.
- …and many more.

## Requirements

- Linux.
- Image thumbnails need a terminal with the
  [kitty graphics protocol](https://sw.kovidgoyal.net/kitty/graphics-protocol.html)
  (kitty, ghostty, WezTerm, Konsole…).
  Without it you see text icons instead of thumbnails.
- Optional tools (the installer lists what's missing):
  - `rsvg-convert` (icons and SVG thumbnails)
  - `magick` (raster image thumbnails)
  - `ffmpeg` (video thumbnails)
  - `gio` (starred files, network locations)
  - `xdg-open` (open files in their default app)
  - `udisksctl` (mount/eject drives)
  - `wl-clipboard` / `xclip` (clipboard with GUI apps)
  - `tar` / `unzip` / `zip` / `7z` (archives)

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/clarkarch/tfm-tui/main/install.sh | bash
```

Or build from source:

```bash
bun install --frozen-lockfile
bun run check && bun test
bun run compile && cp dist/tfm ~/.local/bin/
```

## Keys

- `enter` open · `f2` rename · `backspace` up · `escape` menu
- `ctrl+c/x/v/d` copy/cut/paste/duplicate · `ctrl+z/y` undo/redo
- `tab` switch focused pane · `f5`/`f6` copy/move to the other pane (dual pane)
- `ctrl+t/w` new/close tab · `ctrl+tab` switch tab (per pane)
- `delete` trash · `alt+enter` properties · `ctrl+q` quit
- `ctrl+h` hidden · `ctrl+l` path bar · `ctrl+g` grid/list · `f9` preview · `f4` terminal · `ctrl+shift+s` connect to server

Everything is remappable: `esc` → Settings → keys.

## Config

`~/.config/tfm/config.toml`, see [config.example.toml](config.example.toml).
Override the path with `TFM_CONFIG`. `--debug` writes a log.

## Plugins

TypeScript plugins in `~/.config/tfm/plugins/<name>/<name>.ts` with hot reload,
commands/keybinds, context menus, previews, and events.
Install from a git URL in `esc` → Plugins, or:

```bash
tfm plugins search
tfm plugins add <url|id>
tfm plugins new my-plugin
```

See [docs/plugins.md](docs/plugins.md).

## Limitations

- Linux only.
- Thumbnails need the kitty graphics protocol; tmux hides them unless
  `allow-passthrough` is on.
- Cross-app drag & drop is kitty-only.
- Icons can show a black box behind open menus or while rubber-band selecting.
- Custom kitty themes can misbehave.

## License

[MIT](LICENSE)
