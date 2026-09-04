#!/usr/bin/env bash
# tfm installer: downloads a prebuilt binary for your arch.
# usage: curl -fsSL https://raw.githubusercontent.com/clarkarch/tfm-tui/main/install.sh | bash
# env: TFM_INSTALL_DIR (default ~/.local/bin), TFM_VERSION (default latest),
#      TFM_NO_VERIFY=1 to skip checksum verification (not recommended).
set -euo pipefail

REPO="clarkarch/tfm-tui"
DEST="${TFM_INSTALL_DIR:-$HOME/.local/bin}"
VERSION="${TFM_VERSION:-latest}"

case "$(uname -m)" in
  x86_64) ARCH="x86_64-linux" ;;
  aarch64 | arm64) ARCH="aarch64-linux" ;;
  *) echo "tfm install: unsupported arch: $(uname -m)" >&2; exit 1 ;;
esac

mkdir -p "$DEST"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

if [ "$VERSION" = "latest" ]; then
  BASE="https://github.com/$REPO/releases/latest/download"
else
  BASE="https://github.com/$REPO/releases/download/$VERSION"
fi
echo "tfm: downloading $ARCH ($VERSION)..."
curl -fsSL --retry 3 --proto '=https' "$BASE/tfm-$ARCH.gz" -o "$TMP/tfm.gz"

# checksum: fail closed when the release ships one, fail open (with a loud
# warning) only when the artifact has no published checksum at all.
if curl -fsSL --retry 3 --proto '=https' "$BASE/tfm-$ARCH.gz.sha256" -o "$TMP/tfm.gz.sha256" 2>/dev/null; then
  ( cd "$TMP" && sha256sum -c tfm.gz.sha256 --status ) \
    || { echo "tfm install: CHECKSUM MISMATCH — refusing to install $TMP/tfm.gz" >&2; exit 1; }
  echo "tfm: checksum verified"
elif [ "${TFM_NO_VERIFY:-}" = "1" ]; then
  echo "tfm: WARNING: no checksum published, installing unverified (TFM_NO_VERIFY=1)" >&2
else
  echo "tfm install: no checksum published for tfm-$ARCH.gz — refusing to install." >&2
  echo "  Re-run with TFM_NO_VERIFY=1 to override, or pin TFM_VERSION to a release with checksums." >&2
  exit 1
fi

gunzip -f "$TMP/tfm.gz"
chmod +x "$TMP/tfm"
# never silently clobber: keep one backup of the previous binary
if [ -e "$DEST/tfm" ]; then
  mv -f "$DEST/tfm" "$DEST/tfm.bak"
  echo "tfm: previous binary backed up to $DEST/tfm.bak"
fi
mv "$TMP/tfm" "$DEST/tfm"
ln -sf "$DEST/tfm" "$DEST/terminal-file-manager"

echo "tfm: installed -> $DEST/tfm (run it via \"tfm\" or \"terminal-file-manager\")"
# make sure 'tfm' resolves — but only with explicit user consent (asked on the
# tty, since stdin belongs to the curl|bash pipe). No tty = just print instructions.
# Note: we only ever touch the user's own rc file — never /usr/local/bin.
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

# tfm degrades gracefully without these, but each one disables something
have() { command -v "$1" >/dev/null 2>&1; }
MISSING=""
add_missing() { MISSING="${MISSING}  - $1\\n"; }
have rsvg-convert || add_missing "rsvg-convert — theme-tinted icons and SVG thumbnails"
have magick       || add_missing "magick — raster image thumbnails (fallback)"
have ffmpeg       || add_missing "ffmpeg — video thumbnails & previews"
have gio          || add_missing "gio — starred-file metadata (trash itself needs no gio)"
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
