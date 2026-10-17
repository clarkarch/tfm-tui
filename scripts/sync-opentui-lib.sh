#!/bin/sh
# Stage the opentui fork's prebuilt libopentui over the installed platform
# package. tfm depends on the fork's built package (file:../opentui-fork/
# packages/core/dist), which pulls the UNPATCHED @opentui/core-linux-* npm
# package for the native library; this copies the patched .so (placementOpacity
# + fillDimsImages support) over it.
#
# Run after `bun install`. In dev, after rebuilding the fork's native library:
#   (cd ../opentui-fork/packages/core && bun run build:native)
#   sh scripts/sync-opentui-lib.sh
#
# The HOST target must be present in the fork: a source install must never
# ship a binary whose JS calls ABI the unpatched npm library does not have, so
# a missing host lib exits non-zero (the installer reports it) instead of
# silently leaving the npm one in place. Other targets are staged when the fork
# ships them, which only matters for a checkout that resolves the platform
# package through the fork's own node_modules.
set -eu

fork="${OPENTUI_FORK_DIR:-../opentui-fork}"

host_arch=$(uname -m)
case "$host_arch" in
  x86_64 | amd64) host_triple=x86_64-linux; host_pkg=core-linux-x64 ;;
  aarch64 | arm64) host_triple=aarch64-linux; host_pkg=core-linux-arm64 ;;
  *) host_triple=""; host_pkg="" ;;
esac
if [ -n "$host_pkg" ] && command -v ldd >/dev/null 2>&1 && ldd --version 2>&1 | head -n 1 | grep -qi musl; then
  host_triple="$host_triple-musl"
  host_pkg="$host_pkg-musl"
fi

stage() { # stage TRIPLE PLATFORM_PKG
  src="$fork/packages/native/lib/$1/libopentui.so"
  dest="node_modules/@opentui/$2/libopentui.so"
  # the platform package is only installed after `bun install` — nothing to do
  [ -d "$(dirname "$dest")" ] || return 0
  if [ ! -f "$src" ]; then
    printf 'tfm: the opentui fork at %s ships no prebuilt %s lib.\n' "$fork" "$1" >&2
    printf 'tfm: build it once and commit it: (cd %s/packages/core && bun run build:native)\n' "$fork" >&2
    return 1
  fi
  cp -f "$src" "$dest"
  printf 'staged %s -> %s\n' "$1" "$dest"
  # a source checkout can resolve the platform package through the fork's own
  # node_modules (bun follows the real path), so stage there too when present
  for also in "$fork/node_modules/@opentui/$2/libopentui.so" \
    "$fork"/node_modules/.bun/@opentui+$2@*/node_modules/@opentui/$2/libopentui.so; do
    [ -f "$also" ] && cp -f "$src" "$also"
  done
  return 0
}

if [ -n "$host_pkg" ]; then
  stage "$host_triple" "$host_pkg" || exit 1
fi
for target in \
  "x86_64-linux core-linux-x64" \
  "aarch64-linux core-linux-arm64" \
  "x86_64-linux-musl core-linux-x64-musl" \
  "aarch64-linux-musl core-linux-arm64-musl"; do
  # shellcheck disable=SC2086
  set -- $target
  [ "$1" = "$host_triple" ] && continue
  stage "$1" "$2" || true
done
