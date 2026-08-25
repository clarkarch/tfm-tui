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
command -v tfm >/dev/null 2>&1 || echo "tfm: note: $DEST is not in your PATH — add it to use 'tfm'"
