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
- Open privileged files with sudo prompt.
- Customizable themes, settings GUI, keybinds.
- Plugin support with hot reload.
- …and many more.

## Requirements

- Linux.
- Terminal with the [kitty graphics protocol](https://sw.kovidgoyal.net/kitty/graphics-protocol.html) (kitty, ghostty, WezTerm, Konsole…).
- Strongly recommended (the installer flags these):
  - `resvg` (theme-tinted icons and SVG thumbnails; several times faster than `rsvg-convert`, which also works if you have it)
  - `xdg-open` (open files in their default app)
- Optional tools (the installer lists what's missing):
  - `magick` (raster image thumbnails)
  - `ffmpeg` (video thumbnails)
  - `gio` (starred files, network locations)
  - `udisksctl` (mount/eject drives)
  - `wl-clipboard` / `xclip` (clipboard with GUI apps)
  - `tar` / `unzip` / `zip` / `7z` (archives)

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/clarkarch/tfm-tui/main/install.sh | bash
```

The installer downloads the latest release, verifies its checksum, installs to
`~/.local/bin/tfm` (keeping your previous build as `tfm.bak`), offers to add that
directory to your `PATH`, and then starts the binary once to be sure it runs.
Pin a specific release with `TFM_VERSION=v0.1.0-beta.0` in front of the command,
or install a binary you built yourself with `TFM_LOCAL=./dist/tfm`.

### dev branch

Builds the branch on your machine and installs it the same way — needs `git` and
Bun 1.4 or newer:

```bash
curl -fsSL https://raw.githubusercontent.com/clarkarch/tfm-tui/dev/install-from-source.sh | bash
```

It keeps a checkout in `~/.local/share/tfm/src`, rebuilds it, and only installs
if the build succeeds. Re-run the same command to update; `TFM_BRANCH=main`
builds another branch instead.

### build by hand

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
- `ctrl+a` select all · `space` toggle · `shift+arrows` extend selection
- `alt+left/right` history back/forward · `ctrl+shift+n` / `ctrl+alt+n` new folder/file
- `ctrl+shift+d` dual pane · `ctrl+=/-` zoom · `ctrl+r` reload places · `ctrl+alt+r` restart
- `ctrl+h` hidden · `ctrl+l` path bar · `ctrl+g` grid/list · `f9` preview · `f4` terminal · `ctrl+shift+s` connect to server

Everything is remappable: `esc` → Settings → keys.

## Config

`esc` → Settings or:

```bash
TFM_CONFIG=/custom/path/config.toml tfm
```
See [config.example.toml](config.example.toml).

## Plugins

`esc` → Plugins or:

```bash
tfm plugins search
tfm plugins add <url|id>
tfm plugins new my-plugin
```
See [docs/plugins.md](docs/plugins.md).

## Notes

- Thumbnails need the kitty graphics protocol; tmux hides them unless
  `allow-passthrough` is on.
- Cross-app drag & drop is kitty-only.
- Mouse on the Linux console (TTY) needs `gpm` running.
- Icons can show a black box behind open menus or while rubber-band selecting.
- Custom kitty themes can misbehave.

## License

[MIT](LICENSE)
