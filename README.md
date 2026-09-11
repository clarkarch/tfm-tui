# tfm (terminal file manager)

A modern, mouse-first file manager with places sidebar, grid view, drag & drop, image thumbnails and more, right inside your terminal.

![alpha](https://img.shields.io/badge/status-alpha-red) [![website](https://img.shields.io/badge/website-tfm--tui-blue?logo=githubpages&logoColor=white)](https://clarkarch.github.io/tfm-tui/)

> [!WARNING]
> Experimental vibecoded software, expect rough edges. Don't test on files you can't afford to lose. If you want to test safely, use Podman: `podman run --rm -it archlinux bash`

> [!IMPORTANT]
> This is still a terminal UI running inside your terminal, expect some visual/behavioral anomalies.

![tfm](screenshot.png)

## Features

- Click, rubber-band select, right-click menus, inline rename.
- Drag files between folders (ctrl+drag), out to other apps, or in from outside.
  Cross-app drag is kitty-only.
- Places sidebar, GTK bookmarks, recent files, XDG trash with restore, clipboard.
- Embedded terminal (right-click → Open Terminal Here).
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
  - `gio` (starred files)
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
- `ctrl+t/w` new/close tab · `ctrl+tab` switch tab
- `delete` trash · `alt+enter` properties · `ctrl+q` quit
- `ctrl+h` hidden · `ctrl+l` path bar · `ctrl+g` grid/list · `f9` preview · `f4` terminal

Everything is remappable: `esc` → Settings → keys.

## Config

`~/.config/tfm/config.toml`, see [config.example.toml](config.example.toml).
Override the path with `TFM_CONFIG`; XDG homes are honored. `--debug` writes a log.

## Limitations

- Linux only.
- Thumbnails need the kitty graphics protocol; tmux hides them unless
  `allow-passthrough` is on.
- Cross-app drag & drop is kitty-only.
- Custom kitty themes can misbehave.

## License

[MIT](LICENSE)
