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

# The fork's prebuilt library keeps its debug symbols: 28 MB per target, of
# which 5 MB is code. A compiled binary EMBEDS the library it loads, so the
# symbols would ship to every user of the release (the tarball grows by the
# size of the symbols). Strip the copy we stage — the fork keeps its own file
# intact, so its debugging is not affected.
#
# Best effort: no strip (or a strip that does not understand the file) only
# means a bigger binary, never a broken build.
strip_native() { # strip_native FILE
  file="$1"
  [ -f "$file" ] || return 0
  tmp=$(mktemp "${TMPDIR:-/tmp}/tfm-strip.XXXXXX")
  cp -f "$file" "$tmp"
  before=$(wc -c < "$tmp")
  # GNU strip (Linux): --strip-unneeded keeps the dynamic symbols (the ABI).
  # BSD strip (macOS): -x drops the local symbols.
  if strip --strip-unneeded "$tmp" 2>/dev/null; then
    after=$(wc -c < "$tmp")
  elif strip -x "$tmp" 2>/dev/null; then
    after=$(wc -c < "$tmp")
  else
    printf 'tfm: no usable strip for %s — the binary keeps the debug symbols\n' "$file" >&2
    rm -f "$tmp"
    return 0
  fi
  if [ "$after" -lt "$before" ]; then
    cp -f "$tmp" "$file"
    printf 'stripped %s: %s -> %s bytes\n' "$file" "$before" "$after"
  else
    printf '%s was already stripped (%s bytes)\n' "$file" "$before"
  fi
  rm -f "$tmp"
  return 0
}

stage() { # stage TRIPLE PLATFORM_PKG [required]
  src="$fork/packages/native/lib/$1/libopentui.so"
  dest="node_modules/@opentui/$2/libopentui.so"
  # the platform package is only installed after `bun install` — nothing to do
  [ -d "$(dirname "$dest")" ] || return 0
  if [ ! -f "$src" ]; then
    if [ "${3:-}" = required ]; then
      printf 'tfm: the opentui fork at %s ships no prebuilt %s lib.\n' "$fork" "$1" >&2
      printf 'tfm: build it once and commit it: (cd %s/packages/core && bun run build:native)\n' "$fork" >&2
      return 1
    fi
    # other targets are optional (only a checkout that resolves through the
    # fork's own node_modules would touch them)
    return 0
  fi
  cp -f "$src" "$dest"
  strip_native "$dest"
  printf 'staged %s -> %s\n' "$1" "$dest"
  # a source checkout can resolve the platform package through the fork's own
  # node_modules (bun follows the real path), so stage there too when present.
  # packages/core/node_modules comes FIRST: the fork's dist imports the
  # platform package from there, so a lib left there shadows the patched one.
  for also in "$fork/node_modules/@opentui/$2/libopentui.so" \
    "$fork/packages/core/node_modules/@opentui/$2/libopentui.so" \
    "$fork"/node_modules/.bun/@opentui+$2@*/node_modules/@opentui/$2/libopentui.so; do
    [ -f "$also" ] || continue
    # the same file (the fork resolves through our node_modules): it is
    # staged and stripped already
    if [ "$also" -ef "$dest" ]; then
      continue
    fi
    cp -f "$dest" "$also"
    strip_native "$also"
  done
  return 0
}

if [ -n "$host_pkg" ]; then
  stage "$host_triple" "$host_pkg" required || exit 1
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
