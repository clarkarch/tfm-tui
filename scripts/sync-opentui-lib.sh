#!/bin/sh
# Stage the opentui fork's freshly built libopentui over the installed platform
# package. tfm depends on the fork's built package (file:../opentui-fork/
# packages/core/dist), which pulls the unpatched @opentui/core-linux-* npm
# package for the native library; this copies the patched .so (placementOpacity
# support) over it.
#
# Run after `bun install` and after rebuilding the fork's native library:
#   (cd ../opentui-fork/packages/core && bun run build:native)
#   sh scripts/sync-opentui-lib.sh
set -eu

fork="${OPENTUI_FORK_DIR:-../opentui-fork}"

# bun resolves the platform package from whichever copy of @opentui/core it
# loaded (tfm's node_modules copy, or the fork's own install when the package
# resolves through its real path), so stage into every libopentui.so found
# under those node_modules trees.
stage() {
  src="$fork/packages/native/lib/$1/libopentui.so"
  [ -f "$src" ] || return 0
  for dest in node_modules/@opentui/$2/libopentui.so \
              "$fork"/node_modules/@opentui/$2/libopentui.so \
              "$fork"/node_modules/.bun/@opentui+$2@*/node_modules/@opentui/$2/libopentui.so; do
    [ -d "$(dirname "$dest")" ] || continue
    cp -f "$src" "$dest"
    echo "staged $1 -> $dest"
  done
}

stage x86_64-linux core-linux-x64
stage aarch64-linux core-linux-arm64
stage x86_64-linux-musl core-linux-x64-musl
stage aarch64-linux-musl core-linux-arm64-musl
