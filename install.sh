#!/usr/bin/env bash
# tfm installer: downloads the latest prebuilt binary for your arch.
# usage: curl -fsSL https://raw.githubusercontent.com/clarkarch/tfm-tui/main/install.sh | bash
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
# make sure 'tfm' resolves — but only with explicit user consent (asked on the
# tty, since stdin belongs to the curl|bash pipe). No tty = just print instructions.
if ! command -v tfm >/dev/null 2>&1; then
  if ! { true </dev/tty; } 2>/dev/null; then
    echo "tfm: note: $DEST is not in your PATH — run: export PATH=\"$DEST:\$PATH\""
  else
    printf "tfm: add %s to PATH automatically? [Y/n] " "$DEST"
    DECLINE="tfm: ok — later: export PATH=\"$DEST:\$PATH\""
    if ! IFS= read -r REPLY </dev/tty; then
      echo; echo "$DECLINE"
    elif [ "${REPLY#n}" != "$REPLY" ] || [ "${REPLY#N}" != "$REPLY" ]; then
      echo "$DECLINE"
    else
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
  fi
fi

# tfm degrades gracefully without these, but each one disables something
have() { command -v "$1" >/dev/null 2>&1; }
MISSING=""
add_missing() { MISSING="${MISSING}  - $1\\n"; }
have rsvg-convert || add_missing "rsvg-convert — theme-tinted icons"
have magick       || add_missing "magick — SVG image thumbnails"
have gio          || add_missing "gio — Nautilus-compatible trash & starred files"
have xdg-open     || add_missing "xdg-open — opens files in their default app (required)"
have udisksctl    || add_missing "udisksctl — mount/eject removable drives"
if ! have wl-paste && ! have wl-copy && ! have xclip; then
  add_missing "wl-paste/wl-copy or xclip — copy/paste between tfm and GUI apps"
fi

if [ -n "$MISSING" ]; then
  RED=""; RST=""
  [ -t 1 ] && { RED=$'\033[31m'; RST=$'\033[0m'; }
  printf '%s\n' "${RED}tfm: missing helpers — install these for full functionality:${RST}"
  printf '%s%b%s' "$RED" "$MISSING" "$RST"
fi
