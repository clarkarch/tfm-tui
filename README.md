# tfm (terminal file manager)

A modern, mouse-first file manager with places sidebar, grid view, drag & drop, image thumbnails right inside your terminal

![alpha](https://img.shields.io/badge/status-alpha-red) [![website](https://img.shields.io/badge/website-tfm--tui-blue?logo=githubpages&logoColor=white)](https://clarkarch.github.io/tfm-tui/)

> [!WARNING]
> Experimental vibecoded software — expect rough edges. Don't test on files you can't afford to lose. If you want to test safely, use Podman: `podman run --rm -it archlinux bash`

> [!IMPORTANT]
> This is still a terminal UI running inside your terminal, expect some visual/behavioral anomalies.

![tfm](screenshot.png)

## Features

- **Mouse-first**: click, rubber-band select, context menus, inline rename
- **Drag & drop**: move between folders (`ctrl+drag`), drag out to other apps, drop in from outside — cross-app DnD is kitty-only (OSC 72), in-app drag works everywhere
- **Desktop integration**: GTK bookmarks, recent files (`recently-used.xbel`), XDG trash with restore, system clipboard bridge
- **Embedded terminal**: right-click empty space → **Open Terminal Here** runs `$SHELL` in a pane at the current folder; keys hand off to tfm when you click the grid
- **Archives**: right-click an archive → **Extract Here** (staged, conflict-aware, undoable); right-click a selection → **Compress to…** opens a floating picker listing every format the installed tools can produce (`.tar.gz`, `.zip`, `.7z`, `.tar`, `.tar.xz`, `.tar.bz2`, `.tar.zst`, `.tar.lzma`, `.tar.lz4`, `.tar.br`, …)
- **Previews**: kitty image thumbnails, tree-sitter syntax highlighting, folder stats
- **Search**: type anywhere to filter the open folder; `[ui] recursive-search = true` also searches inside subfolders (fd when installed, built-in walk otherwise)
- **Themes**: 30+ bundled presets (Tokyo Night, Catppuccin, Dracula, Gruvbox, Nord, Rose Pine, Solarized, …) with live switching, fully configurable via `config.toml`

## Requirements

- Linux
- A terminal with the [kitty graphics protocol](https://sw.kovidgoyal.net/kitty/graphics-protocol.html) — **recommended: kitty** (full experience incl. cross-app drag & drop); ghostty gets thumbnails but not cross-app drag; others fall back to Nerd Font glyphs
- Runtime helpers (the installer checks these and tells you what's missing):
- `rsvg-convert` — theme-tinted icons and crisp SVG thumbnails (else Nerd Font glyphs; `magick` covers raster thumbnails as fallback)
- `magick` — raster image thumbnails (fallback when `rsvg-convert` is missing)
- `ffmpeg` — video thumbnails & previews (else videos show plain icons)
- `tar` — extract/compress tar archives; `gzip`/`bzip2`/`xz`/`zstd`/`lzma`/`lz4`/`brotli`/`lzip`/`lzop`/`compress` add the matching `.tar.*` choice; `unzip`+`zip` (or `7z` as a fallback) for `.zip`, plus `.7z` (missing tools just hide their picker rows)
- `gio` — starred-file metadata (`metadata::starred`; trash itself is built-in XDG, no `gio` needed)
  - `xdg-open` — opening files in their default app
  - `udisksctl` — removable-drive mount/eject
  - `wl-paste`/`wl-copy` or `xclip` — clipboard bridge with GUI apps

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/clarkarch/tfm-tui/main/install.sh | bash
```

Installs to `~/.local/bin` as `tfm` (and `terminal-file-manager`). Prebuilt binaries for linux x86_64/aarch64 are on [Releases](https://github.com/clarkarch/tfm-tui/releases).

From source:

```bash
bun install --frozen-lockfile
bun run check   # required gate: biome lint+format + tsc — must pass before pushing
bun test        # full suite (bun test <file> for one module)
bun run compile && cp dist/tfm ~/.local/bin/
```

Dev: `bun run --watch src/index.ts`. Launch `tfm [OPTIONS] [PATH]` — a directory opens it, a file opens its parent and highlights the file (`tfm ~/Downloads/report.pdf`); `tfm --help` lists the flags. An unknown flag or a nonexistent PATH exits non-zero instead of opening somewhere unexpected.

## Keys

| Key | Action |
|---|---|
| type anywhere | live search · `enter` opens first match · `esc` cancels |
| `enter` | open |
| `f2` | rename — bulk rename when multiple selected (restore in trash) |
| `backspace` | parent directory |
| `alt+left` / `alt+right` | back / forward in history |
| `esc` | open the esc menu (settings, view mode, sort, …) |
| `ctrl+q` | quit |
| `ctrl+z` / `ctrl+y` | undo / redo (`ctrl+shift+z` works too) |
| `ctrl+x` / `ctrl+c` / `ctrl+d` / `ctrl+v` | cut / copy / duplicate in place / paste |
| `ctrl+a` | select all |
| `ctrl+h` | toggle hidden files |
| `ctrl+r` | reload sidebar places |
| `ctrl+t` / `ctrl+w` | new tab / close tab (middle-click a chip also closes) |
| `ctrl+tab` / `ctrl+shift+tab` | next / previous tab |
| `delete` | trash selection (delete forever in trash) |
| `alt+enter` | properties for selection |
| `ctrl+shift+n` / `ctrl+alt+n` | new folder / new file |
| `ctrl+l` | edit the path bar |
| `f9` | toggle preview pane |
| `f4` | open terminal here |
| `ctrl+g` | toggle grid/list view |
| `ctrl+=` / `ctrl+-` | bigger / smaller tiles |
| `ctrl+click` / `shift+click` | toggle / range select |
| plain drag / `ctrl+drag` | drag out of terminal / move inside tfm |
| right-click | context menu |

Action keys under `[keys]` are remappable (`config.toml`, or `esc` → Settings → keys); arrows/`enter`/`esc`/search are structural.

## Config

`~/.config/tfm/config.toml` — see [`config.example.toml`](config.example.toml). Themes, tile size, session restore, persistent undo, glyph-only icon mode.

## Environment

| Variable / flag | Effect |
|---|---|
| `TFM_CONFIG` | override config file path (`~/.config/tfm/config.toml` by default) |
| `XDG_CONFIG_HOME` / `XDG_DATA_HOME` / `XDG_STATE_HOME` | honored for config, trash, session + undo journal |
| `TFM_VERSION` | installer: pin a release tag instead of `latest` |
| `TFM_INSTALL_DIR` | installer: destination dir (`~/.local/bin` by default) |
| `TFM_NO_VERIFY=1` | installer: skip checksum verification (not recommended) |
| `TFM_NO_SYNTAX_DL=1` | skip downloading extra tree-sitter grammars (offline machines) |
| `--help` / `-h` | print usage and exit |
| `--version` / `-v` | print version and exit |
| `--config FILE` / `-c FILE` | alternate config file (same as `TFM_CONFIG`) |
| `--debug` / `-d` | verbose event log for bug reports |
| `TFM_DEBUG_LOG` | debug log path (`/tmp/tfm-debug.log` by default) |
| `TFM_DND_LOG` | drag-and-drop trace path (`/tmp/tfm-dnd.log` by default) |

## Limitations

- Linux only; no macOS/Windows support
- Image thumbnails need a kitty-graphics-protocol terminal (kitty, ghostty); others fall back to Nerd Font glyphs
- tmux hides rasters unless `allow-passthrough` is on; icons render but won't display images
- Cross-device moves are copy+delete (no atomic rename across filesystems) — they run through the copy engine with the progress toast
- Drag & drop to/from other apps is kitty-only (OSC 72): ghostty does image thumbnails and in-app drag (`ctrl+drag`), but cross-app drag **won't** work there
- Custom kitty themes might misbehave

## License

[MIT](LICENSE)
