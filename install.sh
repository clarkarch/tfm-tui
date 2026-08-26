#!/usr/bin/env bash
# tfm installer: downloads the latest prebuilt binary for your arch.
# usage: curl -fsSL https://raw.githubusercontent.com/clarkarch/tfm-tui/master/install.sh | bash
set -euo pipefail

REPO="clarkarch/tfm-tui"
DEST="${TFM_INSTALL_DIR:-$HOME/.local/bin}"

case "$(uname -m)" in
  x86_64) ARCH="x86_64-linux" ;;
  aarch64 | arm64) ARCH="aarch64-linux" ;;
  *) echo "tfm install: unsupported arch: $(uname -m)" >&2; exit 1 ;;
esac

mkdir -p "$DEST"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "tfm: downloading $ARCH..."
curl -fsSL "https://github.com/$REPO/releases/latest/download/tfm-$ARCH.gz" -o "$TMP/tfm.gz"
gunzip -f "$TMP/tfm.gz"
chmod +x "$TMP/tfm"
mv "$TMP/tfm" "$DEST/tfm"
ln -sf "$DEST/tfm" "$DEST/terminal-file-manager"

echo "tfm: installed -> $DEST/tfm (run it via \"tfm\" or \"terminal-file-manager\")"
# make sure 'tfm' resolves: prefer an already-on-PATH dir we can write, else
# add a PATH entry to the user's shell rc (idempotent)
if ! command -v tfm >/dev/null 2>&1; then
  if [ -w /usr/local/bin ] && ln -sf "$DEST/tfm" /usr/local/bin/tfm 2>/dev/null; then
    ln -sf "$DEST/tfm" /usr/local/bin/terminal-file-manager 2>/dev/null || true
    echo "tfm: linked into /usr/local/bin — available now"
  else
    case "$(basename "${SHELL:-bash}")" in
      fish) RCFILE="$HOME/.config/fish/config.fish"; LINE="fish_add_path $DEST" ;;
      zsh)  RCFILE="$HOME/.zshrc";                   LINE="export PATH=\"$DEST:\$PATH\"" ;;
      *)    RCFILE="${BASHRC:-$HOME/.bashrc}";       LINE="export PATH=\"$DEST:\$PATH\"" ;;
    esac
    mkdir -p "$(dirname "$RCFILE")"; touch "$RCFILE"
    if ! grep -qF '# tfm PATH' "$RCFILE"; then
      { echo; echo '# tfm PATH'; echo "$LINE"; } >> "$RCFILE"
      echo "tfm: PATH entry added to $RCFILE — open a new shell or run: source $RCFILE"
    fi
  fi
fi

# tfm degrades gracefully without these, but each one disables something
have() { command -v "$1" >/dev/null 2>&1; }
MISSING=""
add_missing() { MISSING="${MISSING}  - $1\\n"; }
have rsvg-convert || add_missing "rsvg-convert — icons fall back to font glyphs"
have magick       || add_missing "magick — SVG thumbnails"
have gio          || add_missing "gio — trash/stars use XDG fallback"
have xdg-open     || add_missing "xdg-open — opening files"
have udisksctl    || add_missing "udisksctl — drive mount/eject"
if ! have wl-paste && ! have wl-copy && ! have xclip; then
  add_missing "wl-paste/wl-copy or xclip — system clipboard bridge"
fi

if [ -n "$MISSING" ]; then
  RED=""; RST=""
  [ -t 1 ] && { RED=$'\033[31m'; RST=$'\033[0m'; }
  printf '%s\n' "${RED}tfm: missing optional helpers (install if you want those features):${RST}"
  printf '%s%b%s' "$RED" "$MISSING" "$RST"
fi
