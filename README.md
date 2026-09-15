# tfm (terminal file manager)

A modern, mouse-first file manager with places sidebar, grid view, drag & drop, image thumbnails and more, right inside your terminal.

![beta](https://img.shields.io/badge/status-beta-yellow) [![website](https://img.shields.io/badge/website-tfm--tui-blue?logo=githubpages&logoColor=white)](https://clarkarch.github.io/tfm-tui/)

> [!WARNING]
> Beta software, usable daily, but back up anything irreplaceable first before performing a files op. 

> [!IMPORTANT]
> This is still a terminal UI running inside your terminal, expect some visual/behavioral anomalies.

![tfm](screenshot.png)

## Features

- Click, rubber-band select, right-click menus, inline rename.
- Drag files between folders (ctrl+drag), out to other apps, or in from outside.
  Cross-app drag is kitty-only.
- Places sidebar, GTK bookmarks, recent files, XDG trash with restore, clipboard.
- Dual pane: two independent file panes side by side, each with its own top bar
  (path, sort, search) and its own tabs. `Tab` switches the focused side, `F5`
  copies the selection to the other pane, `F6` moves it.
- Network locations: `sftp://`, `smb://`, WebDAV, FTP… via gvfs
  (sidebar → Connect to Server…), credentials prompted in-app.
- Embedded terminal (right-click → Open Terminal Here).
- Auto-hide panes: sidebar/preview/terminal collapse to the edge and slide back (animated) when the mouse nears them.
- Extract and compress archives (right-click).
- Image/video thumbnails, text syntax highlighting, folder sizes.
- Type-to-search, tabs, undo/redo, 30+ themes.

## Requirements

- Linux.
- Image thumbnails need the
  [kitty graphics protocol](https://sw.kovidgoyal.net/kitty/graphics-protocol.html)
  (kitty, ghostty, WezTerm, Konsole…). Without it you get Nerd Font glyphs.
  Cross-app drag needs kitty.
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
Override the path with `TFM_CONFIG`; XDG homes are honored. `--debug` writes a log.

## Plugins

TypeScript plugins in `~/.config/tfm/plugins/<name>/<name>.ts` with full trust,
hot reload, commands/keybinds, context menus, previews, events, pre-op veto
hooks, and **UI slots** (render OpenTUI widgets into the statusbar / sidebar
footer). Install from a git URL in `esc` → Plugins, or:

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
- Custom kitty themes can misbehave.

## License

[MIT](LICENSE)
