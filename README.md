<h1 align="center">
  <img src="assets/icons/tfm.svg" width="192" alt="tfm logo"><br>
  tfm (terminal file manager)<br>
  <img src="https://img.shields.io/badge/status-stable-brightgreen?style=flat-square" alt="stable"> <a href="https://clarkarch.github.io/tfm-tui/"><img src="https://img.shields.io/badge/website-tfm--tui-blue?style=flat-square&logo=githubpages&logoColor=white" alt="website"></a>
</h1>

![tfm](screenshot.png)

## Showcase





https://github.com/user-attachments/assets/843f0cf4-36ef-4732-a27a-7ebcb36bde03



### Embedded terminal



https://github.com/user-attachments/assets/06b395db-8a91-4402-9ad7-158a5f77ccfe



### Preview pane




https://github.com/user-attachments/assets/b8dc3ea8-93e1-4593-9516-a3108f613d10



### Animations


https://github.com/user-attachments/assets/b47c7136-642c-4c85-8b2a-dcab1bd0b37b

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
- Browse inside archives (tar, zip, 7z, rar) as folders.
- Eject USB drives safely; plug and unplug detected live.
- Set tfm as your default file manager.
- Embedded terminal.
- Clipboard copy/paste with other apps.
- Open privileged files with sudo prompt.
- Command palette to search and run any action.
- Customizable themes, settings GUI, keybinds.
- Plugin support with hot reload (source builds only — see [Plugins](#plugins)).
- …and many more.

## Requirements

- Linux.
- Any terminal (need image support for the full experience).
- Everything below is optional.
  - `xdg-open` (opening files)
  - `magick` (extra photo thumbnails)
  - `gio` (starred files and servers)
  - `udisksctl` (USB drives)
  - `ffmpeg` (video thumbnails)
  - `wl-clipboard` / `xclip` (copy and paste with other apps)
  - `tar` / `unzip` / `zip` / `7z` (zip files and archives)

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/clarkarch/tfm-tui/main/install.sh | bash
```

### build from source

The main branch, built on your machine — needs git and Bun 1.4 or newer:

```bash
curl -fsSL https://raw.githubusercontent.com/clarkarch/tfm-tui/main/source.sh | bash
```

Or manually build from source:

```bash
git clone https://github.com/clarkarch/tfm-tui.git
cd tfm-tui
bun install --frozen-lockfile
bun run check && bun test
bun run compile && cp dist/tfm ~/.local/bin/
```

## Update

`esc` → About or:

```bash
tfm update
```
`--tag v1.0.0` pins a release, `--force` reinstalls anyway; `update notices` (off by default) is in advanced settings.

## Uninstall

```bash
tfm uninstall
```

It removes the binary and its `terminal-file-manager` name, the desktop entry
and icons, the D-Bus activator, the PATH line the installer added, and the
install record. It asks whether to keep your settings, plugins and caches,
then asks you to confirm. Works offline.

## Keys

- `enter` open · `f2` rename · `backspace`/`alt+up` up · `alt+home` home · `escape` menu · `f1` help · `ctrl+p` command palette
- `ctrl+c/x/v/d` copy/cut/paste/duplicate · `ctrl+z/y` undo/redo
- `tab` switch focused pane · `f5`/`f6` copy/move to the other pane (dual pane)
- `ctrl+t/w` new/close tab · `ctrl+tab` switch tab (per pane)
- `delete` trash · `alt+enter` properties · `ctrl+q` quit
- `ctrl+a` select all · `space` toggle · `shift+arrows` extend selection
- `alt+left/right` history back/forward · `ctrl+shift+n` / `ctrl+alt+n` new folder/file
- `ctrl+shift+d` dual pane · `ctrl+=/-` zoom · `ctrl+r` reload places · `ctrl+alt+r` restart
- `tfm update` installs the newest release (`esc` → About → Update checks on demand)
- `ctrl+h` hidden · `ctrl+l` path bar · `ctrl+g` grid/list · `f3` preview · `ctrl+\``/`f4` terminal · `ctrl+shift+s` connect to server
- `arrows` move · `pageup`/`pagedown` page · `home`/`end` first/last

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

> The release binaries are compiled ahead of time, so they carry no JavaScript
> interpreter for a plugin to run in — `tfm plugins` says so and the plugin
> commands are off. A build from source (below) still has plugins.

## Notes

- Cross-app drag & drop is kitty-only.
- Mouse on the Linux console (TTY) needs `gpm` running.
- Custom kitty themes can misbehave.

## Development

One long-lived branch, `main`, plus a branch per piece of work:

```bash
git switch -c my-change main
# … work, commit, push …
gh pr create --base main --head my-change
```

`main` is protected: changes land through a pull request and CI has to pass.
Releases are cut by tagging `main` — `git tag v1.2.1 && git push origin v1.2.1`
— and the tag's version must match `package.json`, so `--version` never lies.

## License

[MIT](LICENSE)
