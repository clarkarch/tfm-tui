#!/usr/bin/env bash
# tfm installer: guided setup that downloads a prebuilt binary for your arch.
# usage: curl -fsSL https://raw.githubusercontent.com/clarkarch/tfm-tui/main/install.sh | bash
#        (any branch works — swap main for dev to try a staged installer)
# env: TFM_INSTALL_DIR (default ~/.local/bin), TFM_VERSION (default latest),
#      TFM_NO_VERIFY=1 to skip checksum verification (not recommended).
set -euo pipefail

REPO="clarkarch/tfm-tui"
DEST="${TFM_INSTALL_DIR:-$HOME/.local/bin}"
VERSION="${TFM_VERSION:-latest}"
TOTAL_STEPS=5
# step label field width (dots pad to here before the ✓/✗ mark)
LABEL_W=24

# Fancy = stdout is a real terminal and the user hasn't asked for plain output.
# Piped/CI runs (curl | bash | something, scripts) get boring one-liners.
if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  FANCY=1
  C_DIM=$'\033[2m'; C_GREEN=$'\033[32m'; C_BOLD=$'\033[1m'
  C_BLUE=$'\033[36m'; C_RED=$'\033[31m'; C_YEL=$'\033[33m'; C_RST=$'\033[0m'
else
  FANCY=0
  C_DIM=""; C_GREEN=""; C_BOLD=""; C_BLUE=""; C_RED=""; C_YEL=""; C_RST=""
fi

STEP_N=0
STEP_LABEL=""
STEP_OPEN=0

plain() { printf 'tfm: %s\n' "$*"; }

# Box content: mostly ASCII. "·" is 2 bytes in the C locale — count it as one
# column so right borders stay aligned (plain %-42s would shift by 1).
box_top()    { printf '%s╭──────────────────────────────────────────╮%s\n' "$1" "$C_RST"; }
box_bottom() { printf '%s╰──────────────────────────────────────────╯%s\n' "$1" "$C_RST"; }
box_line() {
  local color text rest muls bytes pad i
  color=$1
  text=$2
  rest=$text
  muls=0
  while [[ "$rest" == *'·'* ]]; do
    rest=${rest#*·}
    muls=$((muls + 1))
  done
  # byte length in C locale; each · is 2 bytes but 1 column
  bytes=$(LC_ALL=C printf '%s' "$text" | wc -c)
  pad=$((42 - (bytes - muls)))
  [ "$pad" -lt 0 ] && pad=0
  printf '%s│%s%s' "$color" "$C_RST" "$text"
  i=0
  while [ "$i" -lt "$pad" ]; do printf ' '; i=$((i + 1)); done
  printf '%s│%s\n' "$color" "$C_RST"
}

# ~/ form for display (source ~/.bashrc)
pretty_home() {
  local p=$1
  case "$p" in
    "$HOME") printf '~' ;;
    "$HOME"/*) printf '~%s' "${p#"$HOME"}" ;;
    *) printf '%s' "$p" ;;
  esac
}

# $HOME form for copy-paste export lines (tilde does not expand in quotes)
pretty_dollar_home() {
  local p=$1
  case "$p" in
    "$HOME"/*) printf '$HOME%s' "${p#"$HOME"}" ;;
    *) printf '%s' "$p" ;;
  esac
}

# Print "." padding so the mark lands in a fixed column (label already printed).
print_dots_from() {
  local i=$1
  while [ "$i" -lt "$LABEL_W" ]; do printf '.'; i=$((i + 1)); done
}

begin_step() {
  STEP_N=$1
  STEP_LABEL=$2
  if [ "$FANCY" = 1 ]; then
    printf '  %d/%d  %s' "$STEP_N" "$TOTAL_STEPS" "$STEP_LABEL"
    STEP_OPEN=1
  fi
}

# Close the current step with a checkmark (fancy) or an ok line (plain).
end_step() {
  local detail=${1:-}
  if [ "$FANCY" = 1 ]; then
    if [ "$STEP_OPEN" = 1 ]; then
      print_dots_from "${#STEP_LABEL}"
      printf ' %s✓%s' "$C_GREEN" "$C_RST"
      STEP_OPEN=0
    else
      printf '  %d/%d  %s' "$STEP_N" "$TOTAL_STEPS" "$STEP_LABEL"
      print_dots_from "${#STEP_LABEL}"
      printf ' %s✓%s' "$C_GREEN" "$C_RST"
    fi
    if [ -n "$detail" ]; then printf '  %s' "$detail"; fi
    printf '\n'
  else
    if [ -n "$detail" ]; then plain "$STEP_LABEL — $detail"; else plain "$STEP_LABEL — ok"; fi
  fi
}

# Abort a step: mark ✗ (fancy) and print plain-English lines, then exit.
# Usage: fail_step "headline" "what to do" ["extra line" …]
fail_step() {
  if [ "$FANCY" = 1 ]; then
    if [ "$STEP_OPEN" = 1 ]; then
      print_dots_from "${#STEP_LABEL}"
      printf ' %s✗%s\n' "$C_RED" "$C_RST"
      STEP_OPEN=0
    else
      printf '  %d/%d  %s' "$STEP_N" "$TOTAL_STEPS" "$STEP_LABEL"
      print_dots_from "${#STEP_LABEL}"
      printf ' %s✗%s\n' "$C_RED" "$C_RST"
    fi
    printf '\n'
    local i=0
    for line in "$@"; do
      if [ "$i" = 0 ]; then printf '  %s%s%s\n' "$C_BOLD" "$line" "$C_RST"
      else printf '  %s\n' "$line"; fi
      i=$((i + 1))
    done
    printf '\n'
  else
    printf 'tfm: %s\n' "$1" >&2
    shift
    for line in "$@"; do printf '  %s\n' "$line" >&2; done
  fi
  exit 1
}

hsize() {
  local b=$1
  if [ "$b" -ge 1048576 ]; then
    printf '%d.%d MB' "$((b / 1048576))" "$(((b % 1048576) * 10 / 1048576))"
  elif [ "$b" -ge 1024 ]; then
    printf '%d KB' "$((b / 1024))"
  else
    printf '%d B' "$b"
  fi
}

have() { command -v "$1" >/dev/null 2>&1; }

# Login shell for the PATH prompt / rc pick. $SHELL wins; else the parent
# process (curl|bash from zsh still has PPID=zsh); else bash.
shell_base() {
  local b parent
  b=$(basename "${SHELL:-}" 2>/dev/null || true)
  if [ -n "$b" ] && [ "$b" != "." ]; then
    printf '%s' "$b"
    return
  fi
  parent=$(ps -p "${PPID:-1}" -o comm= 2>/dev/null || true)
  parent=$(basename "${parent:-bash}" 2>/dev/null || echo bash)
  printf '%s' "$parent"
}

# Sets SHELL_KNOWN, SHELL_LABEL, RCFILE, LINE for auto PATH setup.
# Unknown shells: SHELL_KNOWN=0 — we never write a wrong rc file.
setup_shell_profile() {
  SHELL_KNOWN=1
  SHELL_LABEL=$(shell_base)
  case "$SHELL_LABEL" in
    bash | sh | dash)
      SHELL_LABEL=bash
      RCFILE="${BASHRC:-$HOME/.bashrc}"
      LINE="export PATH=\"$DEST:\$PATH\""
      ;;
    zsh)
      RCFILE="$HOME/.zshrc"
      LINE="export PATH=\"$DEST:\$PATH\""
      ;;
    fish)
      RCFILE="$HOME/.config/fish/config.fish"
      LINE="fish_add_path $DEST"
      ;;
    *)
      SHELL_KNOWN=0
      RCFILE=""
      LINE=""
      ;;
  esac
}

if [ "$FANCY" = 1 ]; then
  printf '\n'
  box_top "$C_BLUE"
  box_line "$C_BLUE" "  tfm  -  installer"
  box_line "$C_BLUE" "  a file manager for your terminal"
  box_bottom "$C_BLUE"
  printf '\n'
fi

# ── 1/5 system ──────────────────────────────────────────────────────────────
begin_step 1 "Checking your system"
case "$(uname -m)" in
  x86_64) ARCH="x86_64-linux" ;;
  aarch64 | arm64) ARCH="aarch64-linux" ;;
  *)
    fail_step \
      "Sorry, tfm doesn't have a build for this computer's architecture ($(uname -m))." \
      "Nothing was installed."
    ;;
esac
end_step "$(uname -m) $(uname -s)"

# ── 2/5 download ────────────────────────────────────────────────────────────
begin_step 2 "Downloading tfm"
mkdir -p "$DEST"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

if [ "$VERSION" = "latest" ]; then
  BASE="https://github.com/$REPO/releases/latest/download"
else
  BASE="https://github.com/$REPO/releases/download/$VERSION"
fi

if ! curl -fsSL --retry 3 --proto '=https' "$BASE/tfm-$ARCH.gz" -o "$TMP/tfm.gz"; then
  fail_step \
    "Couldn't download tfm right now." \
    "Check your internet connection and run the same command again." \
    "Nothing was installed."
fi
end_step "$(hsize "$(wc -c < "$TMP/tfm.gz")")"

# ── 3/5 verify ──────────────────────────────────────────────────────────────
begin_step 3 "Verifying the download"
# checksum: fail closed when the release ships one, fail open (with a loud
# warning) only when the artifact has no published checksum at all.
# NOTE: compare digests directly, never `sha256sum -c`: the published sidecar
# embeds the release filename (tfm-<arch>.gz) while we save as tfm.gz, so -c
# looks for a file that isn't there and fails every install.
if curl -fsSL --retry 3 --proto '=https' "$BASE/tfm-$ARCH.gz.sha256" -o "$TMP/tfm.gz.sha256" 2>/dev/null; then
  want=$(cut -d' ' -f1 < "$TMP/tfm.gz.sha256")
  got=$(sha256sum < "$TMP/tfm.gz" | cut -d' ' -f1)
  if [ -z "$want" ] || [ "$want" != "$got" ]; then
    fail_step \
      "The download didn't match our security checksum." \
      "Nothing was installed. Please try again in a moment."
  fi
  end_step "intact"
elif [ "${TFM_NO_VERIFY:-}" = "1" ]; then
  if [ "$FANCY" = 1 ]; then
    print_dots_from "${#STEP_LABEL}"
    printf ' %s⚠%s  skipped (TFM_NO_VERIFY=1)\n' "$C_YEL" "$C_RST"
    STEP_OPEN=0
  else
    plain "WARNING: no checksum published, installing unverified (TFM_NO_VERIFY=1)"
  fi
else
  fail_step \
    "This release didn't publish a security checksum, so tfm refuses to install it." \
    "Re-run with TFM_NO_VERIFY=1 to skip the check, or pin TFM_VERSION" \
    "to a release that includes checksums. Nothing was installed."
fi

# ── 4/5 install ─────────────────────────────────────────────────────────────
begin_step 4 "Installing"
gunzip -f "$TMP/tfm.gz"
chmod +x "$TMP/tfm"
# never silently clobber: keep one backup of the previous binary
SAVED_BAK=0
if [ -e "$DEST/tfm" ]; then
  mv -f "$DEST/tfm" "$DEST/tfm.bak"
  SAVED_BAK=1
fi
mv "$TMP/tfm" "$DEST/tfm"
ln -sf "$DEST/tfm" "$DEST/terminal-file-manager"
if [ "$SAVED_BAK" = 1 ]; then
  end_step "$DEST/tfm (previous saved as tfm.bak)"
else
  end_step "$DEST/tfm"
fi

# ── PATH setup (before the last step so the prompt doesn't split a step line)
# make sure 'tfm' resolves — but only with explicit user consent (asked on the
# tty, since stdin belongs to the curl|bash pipe). No tty = just print instructions.
# Note: we only ever touch the user's own rc file — never /usr/local/bin.
# path_action: ready (live PATH ok) | reload (rc written, shell must source)
#              | export (declined, no tty, or unknown shell)
path_action=ready
reload_cmd=""
export_hint="export PATH=\"$(pretty_dollar_home "$DEST"):\$PATH\""
if ! command -v tfm >/dev/null 2>&1; then
  setup_shell_profile
  if [ "$SHELL_KNOWN" = 0 ]; then
    # don't guess an rc file — hand them the portable export instead
    path_action=export
  elif ! { true </dev/tty; } 2>/dev/null; then
    path_action=export
  else
    if [ "$FANCY" = 1 ]; then
      printf '\n  tfm isn'\''t in your PATH yet. Add it for %s? [Y/n] ' "$SHELL_LABEL"
    else
      printf 'tfm: add to PATH for %s? [Y/n] ' "$SHELL_LABEL"
    fi
    if ! IFS= read -r REPLY </dev/tty; then
      printf '\n'
      path_action=export
    elif [ "${REPLY#n}" != "$REPLY" ] || [ "${REPLY#N}" != "$REPLY" ]; then
      path_action=export
    else
      mkdir -p "$(dirname "$RCFILE")"; touch "$RCFILE"
      if ! grep -qF '# tfm PATH' "$RCFILE"; then
        { echo; echo '# tfm PATH'; echo "$LINE"; } >> "$RCFILE"
      fi
      # rc has the entry (written now or already) but this shell doesn't
      path_action=reload
      reload_cmd="source $(pretty_home "$RCFILE")"
    fi
    if [ "$FANCY" = 1 ]; then printf '\n'; fi
  fi
fi

# ── 5/5 finish: optional helpers ────────────────────────────────────────────
begin_step 5 "Finishing up"
# Optional helpers: plain-English "what you miss", no package names (they go
# stale per distro — the user installs from their software center when ready).
MISSING_NICE=0
NICE_LINES=""
add_nice() {
  MISSING_NICE=$((MISSING_NICE + 1))
  NICE_LINES="${NICE_LINES}      $1
"
}
have rsvg-convert || add_nice "rsvg-convert  -  crisp SVG / icon thumbnails"
have magick       || add_nice "ImageMagick   -  photo thumbnails"
have ffmpeg       || add_nice "ffmpeg        -  video thumbnails & previews"
have gio          || add_nice "gio           -  starred files, network places"
have udisksctl    || add_nice "udisksctl     -  mount / eject drives"
if ! have wl-paste && ! have wl-copy && ! have xclip; then
  add_nice "wl-clipboard or xclip  -  copy/paste with other apps"
fi

XDG_OK=1
have xdg-open || XDG_OK=0

if [ "$path_action" = reload ]; then
  end_step "PATH saved for $SHELL_LABEL - reload below"
elif [ "$path_action" = export ]; then
  if [ "${SHELL_KNOWN:-1}" = 0 ]; then
    end_step "shell not auto-configured - see below"
  else
    end_step "PATH not updated - see below"
  fi
elif [ "$MISSING_NICE" -gt 0 ]; then
  end_step "$MISSING_NICE optional extra$([ "$MISSING_NICE" -eq 1 ] || printf 's') missing"
elif [ "$XDG_OK" = 0 ]; then
  end_step "one required tool missing"
else
  end_step "all set"
fi

# ── success box (then helpers at the very bottom) ───────────────────────────
export_in_box=1
[ $((4 + ${#export_hint})) -gt 42 ] && export_in_box=0

if [ "$FANCY" = 1 ]; then
  printf '\n'
  box_top "$C_GREEN"
  box_line "$C_GREEN" "  tfm is ready!"
  box_line "$C_GREEN" ""
  if [ "$path_action" = reload ]; then
    box_line "$C_GREEN" "  This terminal needs a refresh:"
    box_line "$C_GREEN" ""
    box_line "$C_BOLD" "    $reload_cmd"
    box_line "$C_GREEN" ""
    box_line "$C_GREEN" "  Then:"
    box_line "$C_GREEN" ""
    box_line "$C_BOLD" "    tfm"
  elif [ "$path_action" = export ]; then
    if [ "${SHELL_KNOWN:-1}" = 0 ]; then
      box_line "$C_GREEN" "  Add it to PATH for your shell:"
    else
      box_line "$C_GREEN" "  Put this on PATH first:"
    fi
    box_line "$C_GREEN" ""
    if [ "$export_in_box" = 1 ]; then
      box_line "$C_BOLD" "    $export_hint"
      box_line "$C_GREEN" ""
      box_line "$C_GREEN" "  Then type:"
    else
      box_line "$C_DIM" "    (long path - command below)"
      box_line "$C_GREEN" ""
      box_line "$C_GREEN" "  Then type:"
    fi
    box_line "$C_GREEN" ""
    box_line "$C_BOLD" "    tfm"
  else
    box_line "$C_GREEN" "  Open a terminal and type:"
    box_line "$C_GREEN" ""
    box_line "$C_BOLD" "    tfm"
  fi
  box_line "$C_GREEN" ""
  box_line "$C_DIM" "  Tips: esc = menu · ctrl+q = quit"
  box_bottom "$C_GREEN"
  if [ "$path_action" = export ] && [ "$export_in_box" = 0 ]; then
    printf '\n  %sRun this once:%s\n    %s\n' "$C_DIM" "$C_RST" "$export_hint"
  fi
else
  plain "installed -> $DEST/tfm"
  case "$path_action" in
    reload) plain "reload this terminal: $reload_cmd" ;;
    export) plain "add to PATH: $export_hint" ;;
  esac
  plain "then type \"tfm\" (esc = menu, ctrl+q = quit)"
fi

# ── optional helpers (bottom, after the success box) ────────────────────────
if [ "$XDG_OK" = 0 ]; then
  if [ "$FANCY" = 1 ]; then
    printf '\n  %sOpening files needs one extra tool%s\n' "$C_RED" "$C_RST"
    printf '      xdg-open  -  launches files in their default app\n'
    printf '  %sInstall it from your software center or package manager.%s\n' "$C_DIM" "$C_RST"
  else
    plain "missing: xdg-open - needed to open files in their default app"
  fi
fi

if [ "$MISSING_NICE" -gt 0 ]; then
  if [ "$FANCY" = 1 ]; then
    printf '\n  %sNice to have (tfm works without them)%s\n' "$C_DIM" "$C_RST"
    printf '%s' "$NICE_LINES"
    printf '  %sNo rush - add them any time from your software center.%s\n' "$C_DIM" "$C_RST"
  else
    plain "optional helpers missing (install any time; tfm works without them):"
    printf '%s' "$NICE_LINES"
  fi
fi
