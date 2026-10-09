#!/usr/bin/env bash
# tfm dev kit — build a branch from source and install it exactly like a release.
#
#   curl -fsSL https://raw.githubusercontent.com/clarkarch/tfm-tui/dev/source.sh | bash
#
# The build itself lives in install.sh (TFM_SOURCE=<ref>), so there is one
# installer, one output style, and one place where PATH/replace/checksum policy
# is decided. This file only pins the branch and fetches the real script.
#
# env:
#   TFM_BRANCH         branch to build (default dev)
#   TFM_INSTALLER_REF  branch to fetch install.sh from (default TFM_BRANCH)
#   TFM_INSTALLER_URL  full installer URL (file:// allowed, for local testing)
#   plus everything install.sh understands: TFM_INSTALL_DIR, TFM_SRC_DIR,
#   TFM_MIRROR/TFM_REMOTE, TFM_NO_SMOKE, ...
set -euo pipefail

BRANCH="${TFM_BRANCH:-dev}"
REF="${TFM_SOURCE:-$BRANCH}"
URL="${TFM_INSTALLER_URL:-https://raw.githubusercontent.com/clarkarch/tfm-tui/${TFM_INSTALLER_REF:-$BRANCH}/install.sh}"

TMP="${TMPDIR:-/tmp}/tfm-installer.$$.sh"
trap 'rm -f "$TMP"' EXIT

# `--proto '=https,file'` keeps the transport honest (no plain http) while still
# allowing a local path for tests via TFM_INSTALLER_URL.
if ! curl -fsSL --retry 3 --proto '=https,file' "$URL" -o "$TMP"; then
  printf 'tfm: could not fetch the installer from %s\n' "$URL" >&2
  exit 1
fi

printf 'tfm: building %s from source\n' "$REF"
TFM_SOURCE="$REF" bash "$TMP"
