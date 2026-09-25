#!/usr/bin/env bash
# tfm installer — one self-contained script, four ways in:
#
#   curl -fsSL https://raw.githubusercontent.com/clarkarch/tfm-tui/main/install.sh | bash
#       the latest release (any branch works; the branch only chooses this script)
#
#   curl -fsSL https://raw.githubusercontent.com/clarkarch/tfm-tui/dev/source.sh | bash
#       the dev branch, built from source on your machine (needs git + bun)
#
#   TFM_VERSION=v0.1.0-beta.0 ... | bash   pin a release
#   TFM_SOURCE=dev ... | bash              build a ref from source
#   TFM_LOCAL=./dist/tfm ... | bash        install a binary you already built
#
# One binary, two command names: `tfm` and `terminal-file-manager` (a symlink,
# or a copy where the filesystem has no symlinks). There is no backup copy of a
# previous install — the new build is tested BEFORE it replaces anything.
#
# env:
#   TFM_INSTALL_DIR   where tfm goes (default ~/.local/bin)
#   TFM_VERSION       release tag to install (default latest)
#   TFM_SOURCE        git ref to build and install (TFM_REF is an alias)
#   TFM_SRC_DIR       source checkout dir (default $XDG_DATA_HOME/tfm/src)
#   TFM_REMOTE        git remote to clone (default the GitHub repo)
#   TFM_LOCAL         install this binary instead of downloading or building
#   TFM_NO_VERIFY=1   skip the checksum check (not recommended)
#   TFM_NO_SMOKE=1    install without testing the build first (not recommended)
#   TFM_VERBOSE=1     stream child output instead of capturing it
#   TFM_WIDTH=N       force the render width (testing)
#   TFM_INSTALL_LIB_ONLY=1  define the helpers and stop (testing)
set -euo pipefail

REPO="clarkarch/tfm-tui"
DEST="${TFM_INSTALL_DIR:-$HOME/.local/bin}"
VERSION="${TFM_VERSION:-latest}"
SOURCE="${TFM_SOURCE:-${TFM_REF:-}}"
LOCAL="${TFM_LOCAL:-}"
SRC_DIR="${TFM_SRC_DIR:-${XDG_DATA_HOME:-$HOME/.local/share}/tfm/src}"
REMOTE="${TFM_REMOTE:-https://github.com/$REPO.git}"
VERBOSE="${TFM_VERBOSE:-}"
NO_SMOKE="${TFM_NO_SMOKE:-}"

# step label column, panel width bounds, and the narrowest terminal that can
# hold a step line + a panel (below it everything falls back to plain lines)
LABEL_W=10
# the download bar: never narrower than BAR_MIN, and capped at BAR_MAX so a
# 120-column terminal gets a bar, not an 88-cell ribbon
BAR_MIN=8
BAR_MAX=40
PANEL_MIN=36
PANEL_MAX=74
MIN_FANCY_COLS=60

# a whitespace/quote-bearing DEST breaks both the `export PATH="..."` line and
# the `case ":$PATH:"` probe below, silently skipping PATH setup — reject it
# before any download, and before anything else is printed
case "$DEST" in
  *[[:space:]]* | *\"* | *\'*)
    printf '%s\n' "tfm: TFM_INSTALL_DIR must not contain whitespace or quotes: $DEST" >&2
    exit 2
    ;;
esac

# ── terminal state ──────────────────────────────────────────────────────────
COLS=""
if [ -n "${TFM_WIDTH:-}" ]; then
  COLS="$TFM_WIDTH"
else
  COLS=$(tput cols 2>/dev/null || true)
  case "$COLS" in '' | *[!0-9]*) COLS=$(stty size 2>/dev/null | awk '{print $2}' || true) ;; esac
fi
case "$COLS" in '' | *[!0-9]*) COLS=80 ;; esac
case "$COLS" in 0) COLS=80 ;; esac

# Fancy = a real terminal we can draw in AND enough columns for a step line +
# a panel. Piped/CI/NO_COLOR/dumb/narrow runs get one factual line per step.
FANCY=0
if [ -t 1 ] && [ -z "${NO_COLOR:-}" ] && [ "${TERM:-dumb}" != "dumb" ] && [ -z "${CI:-}" ] &&
  [ "$COLS" -ge "$MIN_FANCY_COLS" ]; then
  FANCY=1
fi

if [ "$FANCY" = 1 ]; then
  C_DIM=$'\033[2m'; C_BOLD=$'\033[1m'; C_OK=$'\033[32m'; C_WARN=$'\033[33m'
  C_ERR=$'\033[31m'; C_BRAND=$'\033[36m'; C_RST=$'\033[0m'
else
  C_DIM=""; C_BOLD=""; C_OK=""; C_WARN=""; C_ERR=""; C_BRAND=""; C_RST=""
fi

# Width must be measured in CHARACTERS, and the ambient locale decides whether
# bash's ${#s} counts bytes or characters: under LC_ALL=C "·" is 2 bytes but one
# column, which shifted every box border by one glyph (this bit the installer
# twice). Force C.UTF-8 when the platform has it.
U8=0
if [ "$(printf '·' | LC_ALL=C.UTF-8 wc -m 2>/dev/null || true)" = 1 ]; then
  U8=1
  export LC_ALL=C.UTF-8
fi

ARCH=""
case "$(uname -m)" in
  x86_64) ARCH="x86_64-linux" ;;
  aarch64 | arm64) ARCH="aarch64-linux" ;;
  *) ARCH="" ;;
esac

# globals shared across phases, initialized so `set -u` can never bite mid-run
SHELL_KNOWN=1
SHELL_LABEL=""
RCFILE=""
LINE=""
SMOKE_VER=""
SMOKE_LINE=""
BAK_REMOVED=0
NEW_FILE=""
FETCH_PID=""
MODE=release

# ── helpers ─────────────────────────────────────────────────────────────────
plain() { printf 'tfm: %s\n' "$*"; }

have() { command -v "$1" >/dev/null 2>&1; }

# bytes → "18.8 MB" (the size column of the download/install steps)
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

repeat_char() { # repeat_char CHAR N
  local i=0 out=""
  while [ "$i" -lt "$2" ]; do out="$out$1"; i=$((i + 1)); done
  printf '%s' "$out"
}

# Drop SGR sequences without sed (an \x1b escape is not portable across sed
# builds). Our own lines carry escapes only around, never inside, the text.
strip_ansi() {
  local s=$1 out=""
  while [[ $s == *$'\033'* ]]; do
    out="$out${s%%$'\033'*}"
    s="${s#*$'\033'}"
    s="${s#\[}"
    if [[ $s == *[A-Za-z]* ]]; then s="${s#*[A-Za-z]}"; else s=""; fi
  done
  printf '%s' "$out$s"
}

# Columns, not bytes: the ambient locale decides whether bash's ${#s} counts
# bytes or characters, and under LC_ALL=C "·" is two — that shifted every border
# by one glyph. C.UTF-8 first, with a locale-proof fallback for musl/busybox.
disp_w() {
  local s
  s=$(strip_ansi "$1")
  if [ "$U8" = 1 ]; then
    printf '%s' "${#s}"
    return
  fi
  # No C.UTF-8: a character is a byte that is not a UTF-8 continuation byte
  # (0x80–0xBF), so width = total bytes minus those. Locale-proof and correct
  # for ANY input — the previous per-glyph table both miscounted 3-byte glyphs
  # (✓ ─ │) and silently swallowed glyphs while stripping a match out.
  printf '%s' "$s" | LC_ALL=C tr -d '\200-\277' | LC_ALL=C wc -c | tr -d '[:space:]'
}

# Wrap plain text to a column budget, words first, hard-breaking a token longer
# than the budget (a deep path) so nothing is ever truncated or overflows.
wrap_line() {
  local text=$1 width=$2
  [ "$width" -lt 1 ] && width=1
  local line="" word rest chunk
  while [ -n "$text" ]; do
    rest="${text#"${text%%[![:space:]]*}"}"
    if [ -z "$rest" ]; then break; fi
    word="${rest%%[[:space:]]*}"
    text="${rest#"$word"}"
    if [ "$(disp_w "$word")" -gt "$width" ]; then
      [ -n "$line" ] && { printf '%s\n' "$line"; line=""; }
      chunk=$word
      while [ "$(disp_w "$chunk")" -gt "$width" ]; do
        printf '%s\n' "${chunk:0:$width}"
        chunk="${chunk:$width}"
      done
      line="$chunk"
      continue
    fi
    if [ -z "$line" ]; then
      line="$word"
    elif [ "$(($(disp_w "$line") + 1 + $(disp_w "$word")))" -le "$width" ]; then
      line="$line $word"
    else
      printf '%s\n' "$line"
      line="$word"
    fi
  done
  [ -n "$line" ] && printf '%s\n' "$line"
  return 0
}

# Indented prose. Wraps instead of running off the edge, and stays a single
# `tfm:` line in plain mode. INDENT is extra leading spaces (0 by default).
note() {
  local color=$1 text=${2:-} indent=${3:-0}
  local w=$((COLS - 4 - indent))
  [ "$w" -gt 72 ] && w=72
  [ "$w" -lt 20 ] && w=20
  local wrapped line
  wrapped=$(wrap_line "$text" "$w")
  while IFS= read -r line; do
    [ -z "$line" ] && continue
    if [ "$FANCY" = 1 ]; then
      printf '  %s%s%s%s\n' "$(repeat_char ' ' "$indent")" "$color" "$line" "$C_RST"
    else
      plain "$line"
    fi
  done <<<"$wrapped"
}

rule() { # dim horizontal rule under the header / above a mode note
  local w=$((COLS - 4))
  [ "$w" -gt 64 ] && w=64
  [ "$w" -lt 20 ] && w=20
  if [ "$FANCY" = 1 ]; then printf '  %s%s%s\n' "$C_DIM" "$(repeat_char '─' "$w")" "$C_RST"; fi
}

# Rounded result panel. Content is plain text (escapes only around it), wrapped
# to the panel width and padded by display columns, so corners line up on every
# terminal. Width adapts to the content and never exceeds the terminal.
# A line starting with "> " is drawn indented by 4 (commands) — `wrap_line`
# normalizes whitespace, so leading spaces cannot survive on their own.
panel() {
  local color=$1
  shift
  local inner=0 l w indent=0
  for l in "$@"; do
    indent=0
    case "$l" in
      '>'*) indent=4; l="${l#>}"; l="${l# }" ;;
    esac
    w=$((indent + $(disp_w "$l")))
    [ "$w" -gt "$inner" ] && inner=$w
  done
  inner=$((inner + 4))
  [ "$inner" -gt "$PANEL_MAX" ] && inner=$PANEL_MAX
  [ "$inner" -lt "$PANEL_MIN" ] && inner=$PANEL_MIN
  local max=$((COLS - 4))
  [ "$inner" -gt "$max" ] && inner=$max
  local text_w=$((inner - 4))
  [ "$text_w" -lt 10 ] && text_w=10
  local bar
  bar=$(repeat_char '─' "$inner")
  printf '  %s╭%s%s╮%s\n' "$color" "$bar" "$color" "$C_RST"
  for l in "$@"; do
    indent=0
    case "$l" in
      '>'*) indent=4; l="${l#>}"; l="${l# }" ;;
    esac
    if [ -z "$l" ]; then
      printf '  %s│%s%s%s│%s\n' "$color" "$C_RST" "$(repeat_char ' ' "$inner")" "$color" "$C_RST"
      continue
    fi
    local wrapped pad content
    wrapped=$(wrap_line "$l" "$((text_w - indent))")
    while IFS= read -r wl; do
      pad=$((text_w - indent - $(disp_w "$wl")))
      [ "$pad" -lt 0 ] && pad=0
      # one pre-built content cell: keeps the format string and the argument
      # count in sync (an extra %s silently shifts the right border 2 columns)
      content="$(repeat_char ' ' "$indent")$wl$(repeat_char ' ' "$pad")"
      printf '  %s│%s  %s  %s│%s\n' "$color" "$C_RST" "$content" "$color" "$C_RST"
    done <<<"$wrapped"
  done
  printf '  %s╰%s%s╯%s\n' "$color" "$bar" "$color" "$C_RST"
}

# ── progress bar (download) ──────────────────────────────────────────────────
# curl's own `--progress-bar` draws a `####…100.0%` line in ITS style, outside the
# step list, and the next step line erases it a moment later. This paints the
# download row instead: the same 17-column prefix every step uses, a bar that
# takes the leftover width, and the same `\r\033[K` repaint idiom — nothing
# scrolls and the finished `✓ download …` line lands in its place.
fmt_speed() { # fmt_speed BYTES_PER_SEC — "12.4 MB/s", "—" while unknown
  local b=${1:-}
  # never hand garbage to hsize: its arithmetic would abort the install
  case "$b" in '' | *[!0-9]*) printf '—' ; return 0 ;; esac
  if [ "$b" -gt 0 ]; then printf '%s/s' "$(hsize "$b")"; else printf '—'; fi
}

fmt_eta() { # fmt_eta MILLISECONDS — "0:02", "1:01:40", "—" while unknown
  local ms=${1:-} s
  case "$ms" in '' | *[!0-9]*) printf '—' ; return 0 ;; esac
  # round up: the last tick must not claim 0:00 while bytes are still coming
  s=$(((ms + 999) / 1000))
  if [ "$s" -ge 3600 ]; then
    printf '%d:%02d:%02d' "$((s / 3600))" "$(((s % 3600) / 60))" "$((s % 60))"
  else
    printf '%d:%02d' "$((s / 60))" "$((s % 60))"
  fi
}

bar_for() { # bar_for WIDTH PCT — exactly WIDTH columns, rounded fill
  local w=$1 pct=${2:-0} f
  case "$pct" in '' | *[!0-9]*) pct=0 ;; esac
  [ "$pct" -gt 100 ] && pct=100
  f=$(((w * pct + 50) / 100))
  [ "$f" -gt "$w" ] && f=$w
  printf '%s%s' "$(repeat_char '█' "$f")" "$(repeat_char '░' "$((w - f))")"
}

sweep_for() { # sweep_for WIDTH POS [WINDOW] — no honest percentage to show
  local w=$1 pos=${2:-0} win=${3:-10}
  [ "$win" -gt "$w" ] && win=$w
  [ "$pos" -gt "$((w - win))" ] && pos=$((w - win))
  [ "$pos" -lt 0 ] && pos=0
  printf '%s%s%s' "$(repeat_char '░' "$pos")" "$(repeat_char '█' "$win")" \
    "$(repeat_char '░' "$((w - pos - win))")"
}

# Pick the widest stats string that still leaves a usable bar, plus the bar width
# that goes with it. Candidates degrade in the order given (full → short → min),
# so the percentage is the last thing to survive. Sets STATS_TEXT and STATS_W;
# the 17 is the step prefix and the 2 the gap before the bar.
progress_stats() { # progress_stats FULL SHORT MIN
  local cand
  STATS_TEXT=$3
  for cand in "$1" "$2" "$3"; do
    [ -z "$cand" ] && continue
    if [ "$((17 + 2 + $(disp_w "$cand") + BAR_MIN))" -le "$COLS" ]; then
      STATS_TEXT=$cand
      break
    fi
  done
  STATS_W=$((COLS - 17 - 2 - $(disp_w "$STATS_TEXT")))
  if [ "$STATS_W" -gt "$BAR_MAX" ]; then STATS_W=$BAR_MAX; fi
  if [ "$STATS_W" -lt "$BAR_MIN" ]; then STATS_W=$BAR_MIN; fi
  # explicit: the last test above may legitimately be false, and a function that
  # "fails" here would take the whole install down under `set -e`
  return 0
}

# One repaint of the CURRENT step's row, WITHOUT a newline (the pending-line
# idiom): the next tick, step_ok or fail_at erases it with `\r\033[K`.
progress_paint() { # progress_paint BAR STATS
  [ "$FANCY" = 1 ] || return 0
  printf '\r\033[K  %s·%s  %s%-*s%s  %s%s%s  %s%s%s' \
    "$C_DIM" "$C_RST" "$C_DIM" "$LABEL_W" "$STEP_LABEL" "$C_RST" \
    "$C_BRAND" "$1" "$C_RST" "$C_DIM" "$2" "$C_RST"
}

# Milliseconds since the epoch. $EPOCHREALTIME is a bash builtin: the bar
# repaints ~10x/s, and a `date` fork per tick would be 10 processes a second.
now_ms() {
  local t=${EPOCHREALTIME:-}
  if [ -n "$t" ]; then
    t=${t//./}
    printf '%s' "${t:0:13}"
  else
    printf '%s' "$(( $(date +%s) * 1000 ))"
  fi
}

file_size() { # file_size FILE — bytes, 0 while the file doesn't exist yet
  local n=""
  if [ -e "$1" ]; then n=$(stat -c%s "$1" 2>/dev/null || wc -c <"$1" 2>/dev/null || true); fi
  case "$n" in '' | *[!0-9]*) printf '0' ;; *) printf '%s' "$n" ;; esac
}

# The LAST Content-Length in a headers dump: a redirect chain repeats it and the
# final hop is the object we actually get. Empty for a chunked answer — which is
# what sends the row into sweep mode instead of inventing a percentage.
hdr_length() { # hdr_length < headers
  local len
  len=$(tr -d '\r' | sed -n 's/^[Cc]ontent-[Ll]ength:[[:space:]]*\([0-9][0-9]*\).*$/\1/p' | tail -n1 || true)
  case "$len" in '' | *[!0-9]*) printf '' ;; *) printf '%s' "$len" ;; esac
}

# ── steps ───────────────────────────────────────────────────────────────────
# One line per step, printed once, when its outcome is known. While a step runs
# we draw a dim pending line WITHOUT a newline and replace it in place, so a
# step's finished line can never appear before its work is done (the old
# installer printed "Downloaded tfm" while curl was still running) and no
# question can split the list.
STEP_LABEL=""
STEP_DETAIL=""
STEP_PENDING=0

step_begin() {
  STEP_LABEL=$1
  STEP_DETAIL=""
  if [ "$FANCY" = 1 ]; then
    printf '  %s·%s  %s%-*s%s' "$C_DIM" "$C_RST" "$C_DIM" "$LABEL_W" "$STEP_LABEL" "$C_RST"
    STEP_PENDING=1
  fi
}

_step_line() { # _step_line GLYPH COLOR DETAIL LEVEL
  local detail=${3:-}
  if [ "$FANCY" = 1 ]; then
    printf '\r\033[K'
    printf '  %s%s%s  %s%-*s%s' "$2" "$1" "$C_RST" "$C_BOLD" "$LABEL_W" "$STEP_LABEL" "$C_RST"
    [ -n "$detail" ] && printf '  %s%s%s' "$C_DIM" "$detail" "$C_RST"
    printf '\n'
  elif [ "$4" = warn ]; then
    # a warning must not read as a success in a CI log
    plain "warning: $STEP_LABEL${detail:+, $detail}"
  elif [ -n "$detail" ]; then
    plain "$STEP_LABEL, $detail"
  else
    plain "$STEP_LABEL, ok"
  fi
  STEP_PENDING=0
}

step_ok() { _step_line '✓' "$C_OK" "${1:-}" ok; }
step_warn() { _step_line '⚠' "$C_WARN" "${1:-}" warn; }

# Print the ✗ line for the current step without exiting (fail_step calls this).
step_fail() { _step_line '✗' "$C_ERR" "${1:-}" error; }

# Abort: mark the step ✗, then a bold headline and dim hints. Nothing else is
# touched (the previous binary is where it was) and the temp dir is kept so the
# captured child output survives for a bug report.
fail_at() { # fail_at LABEL DETAIL HEADLINE [HINT...]
  STEP_LABEL=$1
  STEP_DETAIL=$2
  shift 2
  fail_step "$@"
}

fail_step() {
  local headline=$1
  shift
  local hint
  if [ "$FANCY" = 1 ]; then
    step_fail "$STEP_DETAIL"
    printf '\n'
  else
    plain "FAILED ${STEP_LABEL}${STEP_DETAIL:+, $STEP_DETAIL}"
  fi
  note "$C_BOLD" "$headline"
  for hint in "$@"; do note "$C_DIM" "$hint"; done
  if [ -n "$RUN_LOG" ] && [ -s "$RUN_LOG" ]; then
    note "$C_DIM" "last output:"
    show_log_tail
    note "$C_DIM" "full output: $RUN_LOG"
    KEEP_WORK=1
  fi
  exit 1
}

# ── children ────────────────────────────────────────────────────────────────
# Child output is captured into one log so a step line stays clean; it is shown
# on failure and kept on disk for bug reports. TFM_VERBOSE=1 streams instead.
run_child() {
  if [ -n "$VERBOSE" ]; then
    "$@" 2>&1 | tee -a "$RUN_LOG"
  else
    "$@" >>"$RUN_LOG" 2>&1
  fi
}

# Same, but inside a directory. Building MUST run in the checkout: without this
# `bun run compile` writes dist/tfm into whatever directory the installer was
# started from (it clobbered the repo it was testing).
run_child_in() {
  local dir=$1
  shift
  if [ -n "$VERBOSE" ]; then
    (cd "$dir" && "$@") 2>&1 | tee -a "$RUN_LOG"
  else
    (cd "$dir" && "$@") >>"$RUN_LOG" 2>&1
  fi
}

show_log_tail() {
  [ -s "$RUN_LOG" ] || return 0
  local line w n=8 i=0 wl
  w=$((COLS - 6))
  [ "$w" -gt 70 ] && w=70
  # at most 3 lines of any one log line (a minified error must not bury the
  # headline); process substitution, never `wrap_line | head` — head closing
  # early SIGPIPEs the producer and `set -o pipefail` would abort the installer
  tail -n "$n" "$RUN_LOG" | while IFS= read -r line; do
    i=0
    while IFS= read -r wl; do
      if [ "$FANCY" = 1 ]; then
        printf '    %s%s%s\n' "$C_DIM" "$wl" "$C_RST"
      else
        plain "$wl"
      fi
      i=$((i + 1))
      [ "$i" -ge 3 ] && break
    done < <(wrap_line "$line" "$w")
  done
}

cleanup() {
  local code=$?
  if [ "$STEP_PENDING" = 1 ] && [ "$FANCY" = 1 ]; then printf '\n'; fi
  # a half-copied binary must never outlive us (only SIGKILL skips this trap,
  # which is why install_binary sweeps the pattern too)
  if [ -n "${NEW_FILE:-}" ]; then rm -f "$NEW_FILE" 2>/dev/null; fi
  # a download in flight dies with the process group anyway; be explicit
  if [ -n "${FETCH_PID:-}" ]; then kill "$FETCH_PID" 2>/dev/null || true; fi
  if [ -n "${WORK:-}" ] && [ -d "$WORK" ] && [ "${KEEP_WORK:-0}" = 0 ]; then
    rm -rf "$WORK"
  fi
  # explicit: a bare `return` leaves the script's exit status at the mercy of
  # the trap function's last command
  exit "$code"
}

# ── shell PATH setup ────────────────────────────────────────────────────────
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
# Unknown shells: SHELL_KNOWN=0, we never write a wrong rc file.
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

pretty_home() { # ~/ form for display (source ~/.bashrc)
  local p=$1
  case "$p" in
    "$HOME") printf '~' ;;
    "$HOME"/*) printf '~%s' "${p#"$HOME"}" ;;
    *) printf '%s' "$p" ;;
  esac
}

pretty_dollar_home() { # $HOME form for copy-paste export lines (tilde does not expand in quotes)
  local p=$1
  case "$p" in
    "$HOME"/*) printf '$HOME%s' "${p#"$HOME"}" ;;
    *) printf '%s' "$p" ;;
  esac
}

# ── optional tools ──────────────────────────────────────────────────────────
# Two buckets: the two that visibly degrade tfm, then everything else. The
# packager hint is best-effort — a wrong `apt install` is worse than naming the
# tool alone, so tools without a reliable package name are called out by name.
TOOLS_RECOMMENDED="resvg xdg-open"
TOOLS_OPTIONAL="magick ffmpeg gio udisksctl clip"

tool_present() {
  case "$1" in
    clip) have wl-paste || have wl-copy || have xclip ;;
    *) have "$1" ;;
  esac
}

tool_name() { # how the tool is presented (the key is the binary we probe)
  case "$1" in
    clip) printf 'wl-clipboard' ;;
    *) printf '%s' "$1" ;;
  esac
}

tool_desc() {
  case "$1" in
    resvg) printf 'icons and SVG thumbnails' ;;
    xdg-open) printf 'opens files in their default app' ;;
    magick) printf 'photo thumbnails' ;;
    ffmpeg) printf 'video thumbnails and previews' ;;
    gio) printf 'starred files and network places' ;;
    udisksctl) printf 'mount and eject drives' ;;
    clip) printf 'copy/paste with other apps (wl-clipboard or xclip)' ;;
    *) printf '' ;;
  esac
}

# OS_RELEASE is a seam: tests point it at a fixture instead of the real file.
OS_RELEASE="${TFM_OS_RELEASE:-/etc/os-release}"

detect_pm() {
  local id="" like=""
  if [ -r "$OS_RELEASE" ]; then
    # `|| true` on both: head exits after one line, so sed can be SIGPIPE-killed
    # and pipefail would then abort the installer over a successful read
    id=$(sed -n 's/^ID="\{0,1\}\([^"]*\)"\{0,1\}$/\1/p' "$OS_RELEASE" | head -n1 || true)
    like=$(sed -n 's/^ID_LIKE="\{0,1\}\([^"]*\)"\{0,1\}$/\1/p' "$OS_RELEASE" | head -n1 || true)
  fi
  case "$id $like" in
    *debian* | *ubuntu* | *apt*) printf 'apt' ;;
    *arch* | *manjaro*) printf 'pacman' ;;
    *fedora* | *rhel* | *centos*) printf 'dnf' ;;
    *opensuse* | *suse*) printf 'zypper' ;;
    *alpine*) printf 'apk' ;;
    *) printf '' ;;
  esac
}

pm_cmd() {
  case "$1" in
    apt) printf 'sudo apt install' ;;
    pacman) printf 'sudo pacman -S' ;;
    dnf) printf 'sudo dnf install' ;;
    zypper) printf 'sudo zypper install' ;;
    apk) printf 'sudo apk add' ;;
    *) printf '' ;;
  esac
}

pm_pkg() { # pm_pkg PM TOOL — "" when we don't know a package for that family
  case "$2" in
    magick) printf 'imagemagick' ;;
    ffmpeg) printf 'ffmpeg' ;;
    udisksctl) printf 'udisks2' ;;
    clip) printf 'wl-clipboard' ;;
    xdg-open) printf 'xdg-utils' ;;
    gio)
      case "$1" in
        apt) printf 'libglib2.0-bin' ;;
        apk) printf 'glib' ;;
        zypper) printf 'glib2-tools' ;;
        *) printf 'glib2' ;;
      esac
      ;;
    resvg) printf '' ;; # not reliably packaged; cargo/software center instead
    *) printf '' ;;
  esac
}

print_extras() {
  local t rec="" opt=""
  for t in $TOOLS_RECOMMENDED; do tool_present "$t" || rec="$rec $t"; done
  for t in $TOOLS_OPTIONAL; do tool_present "$t" || opt="$opt $t"; done
  [ -z "${rec# }" ] && [ -z "${opt# }" ] && return 0

  local pm cmd pkgs="" unpkg="" p
  pm=$(detect_pm)
  if [ -n "$pm" ]; then
    cmd=$(pm_cmd "$pm")
    for t in $rec $opt; do
      p=$(pm_pkg "$pm" "$t")
      if [ -n "$p" ]; then pkgs="$pkgs $p"; else unpkg="$unpkg $t"; fi
    done
  fi

  local bucket
  for bucket in rec opt; do
    local list
    if [ "$bucket" = rec ]; then list="$rec"; else list="$opt"; fi
    [ -z "${list# }" ] && continue
    if [ "$FANCY" = 1 ]; then
      printf '\n  %s%s%s\n' "$C_BOLD" "$([ "$bucket" = rec ] && printf 'recommended' || printf 'optional')" "$C_RST"
      local name
      for name in $list; do
        printf '    %s%-*s%s  %s%s%s\n' "$C_BOLD" 12 "$(tool_name "$name")" "$C_RST" "$C_DIM" "$(tool_desc "$name")" "$C_RST"
      done
    else
      plain "$([ "$bucket" = rec ] && printf 'recommended' || printf 'optional') tools missing:${list}"
    fi
  done

  if [ "$FANCY" = 1 ]; then
    printf '\n'
    if [ -n "$cmd" ] && [ -n "${pkgs# }" ]; then
      note "$C_DIM" "install them with:"
      note "$C_BOLD" "$cmd$pkgs" 4
    else
      note "$C_DIM" "install them from your software center or package manager."
    fi
    [ -n "${unpkg# }" ] && note "$C_DIM" "no package mapped:${unpkg} — cargo install resvg also works"
  else
    if [ -n "$cmd" ] && [ -n "${pkgs# }" ]; then plain "install with:  $cmd$pkgs"; fi
  fi
  return 0
}

# ── steps: shared ───────────────────────────────────────────────────────────
WORK=""
RUN_LOG=""
KEEP_WORK=0

setup_workdir() {
  WORK=$(mktemp -d) || fail_at system "no temp dir" "Couldn't create a temporary directory." "Set TMPDIR to a writable directory and try again."
  RUN_LOG="$WORK/install.log"
  : >"$RUN_LOG"
  trap cleanup EXIT
}

banner() { # banner MODE
  local mode=$1 desc="" os
  case "$mode" in
    source) desc="from source · $SOURCE" ;;
    local) desc="local build · $(pretty_home "$LOCAL")" ;;
    *)
      if [ "$VERSION" = "latest" ]; then desc="latest release"; else desc="release $VERSION"; fi
      ;;
  esac
  if [ "$FANCY" = 1 ]; then
    printf '\n  %s%stfm%s %s· installer · %s%s\n' \
      "$C_BOLD" "$C_BRAND" "$C_RST" "$C_DIM" "$desc" "$C_RST"
    rule
    printf '\n'
  else
    os=$(uname -s)
    plain "installer · $desc (${os,,} $(uname -m))"
  fi
}

step_system() {
  step_begin "system"
  if [ -z "$ARCH" ]; then
    fail_at system "unsupported $(uname -m)" \
      "Sorry, tfm doesn't have a build for this computer's architecture ($(uname -m))." \
      "Nothing was installed."
  fi
  if [ "$MODE" = "release" ]; then
    have curl || fail_at system "no curl" "curl is needed to download tfm." "Install curl and run the same command again."
    have gunzip || fail_at system "no gunzip" "gunzip is needed to unpack tfm." "Install gzip and run the same command again."
    have sha256sum || fail_at system "no sha256sum" "sha256sum is needed to verify the download." "Install coreutils and run the same command again."
  fi
  if [ -e "$DEST" ] && [ ! -d "$DEST" ]; then
    fail_at system "$DEST is not a directory" "Can't install into $DEST — it exists and isn't a directory." "Set TFM_INSTALL_DIR to a directory and try again."
  fi
  if ! mkdir -p "$DEST" 2>>"$RUN_LOG"; then
    fail_at system "can't create $DEST" "Couldn't create the install directory $DEST." "Check permissions, or set TFM_INSTALL_DIR to somewhere you can write."
  fi
  if [ ! -w "$DEST" ]; then
    fail_at system "$DEST not writable" "The install directory $DEST isn't writable by you." "Check permissions, or set TFM_INSTALL_DIR to somewhere you can write."
  fi
  step_ok "$(uname -s | tr '[:upper:]' '[:lower:]') $(uname -m) · installs to $(pretty_home "$DEST")"
}

# ── steps: release ──────────────────────────────────────────────────────────
BASE=""
if [ "$VERSION" = "latest" ]; then
  BASE="https://github.com/$REPO/releases/latest/download"
else
  BASE="https://github.com/$REPO/releases/download/$VERSION"
fi

# Content-Length for URL, from a HEAD request: "" when the server won't say. The
# `|| true` sits inside the group on purpose — a refused HEAD under `pipefail`
# must not abort an install over a cosmetic feature.
fetch_length() {
  { curl -fsSIL --retry 3 --proto '=https' "$1" 2>>"$RUN_LOG" || true; } | hdr_length
}

# Download URL into FILE while painting our own progress row on the step line.
# Returns curl's status (the caller keeps deciding what a failure means).
# TFM_VERBOSE=1 streams curl's output instead: raw mode stays raw, no bar.
fetch_with_bar() { # fetch_with_bar URL FILE HEADER_FILE
  local url=$1 file=$2 hdr=$3
  local pid rc=0 total cur=0 prev=0 last tnow ms inst speed=0 pct=0 eta="" stats
  local pos=0 win=10
  : >"$hdr"
  if [ -n "$VERBOSE" ]; then
    curl -fSL --retry 3 --proto '=https' -D "$hdr" -o "$file" "$url" 2>&1 | tee -a "$RUN_LOG"
    return $?
  fi
  # ask first, so the bar is determinate from its first frame ("" → sweep)
  total=$(fetch_length "$url")
  curl -fSL --retry 3 --proto '=https' -D "$hdr" -o "$file" "$url" >>"$RUN_LOG" 2>&1 &
  pid=$!
  FETCH_PID=$pid
  last=$(now_ms)
  while kill -0 "$pid" 2>/dev/null; do
    tnow=$(now_ms)
    ms=$((tnow - last))
    last=$tnow
    cur=$(file_size "$file")
    # a server that ignored our HEAD still says so in its response headers
    [ -z "$total" ] && total=$(hdr_length <"$hdr")
    if [ "$ms" -gt 0 ]; then
      inst=$(((cur - prev) * 1000 / ms))
      [ "$inst" -lt 0 ] && inst=0
      prev=$cur
      # one 100 ms window is far too jittery to print: smooth it
      speed=$(((speed * 3 + inst) / 4))
    fi
    if [ -n "$total" ] && [ "$total" -gt 0 ]; then
      pct=$((cur * 100 / total))
      [ "$pct" -gt 100 ] && pct=100
      eta=""
      if [ "$speed" -gt 0 ] && [ "$pct" -lt 100 ]; then
        eta=$(fmt_eta "$(((total - cur) * 1000 / speed))")
      fi
      progress_stats "$pct% · $(fmt_speed "$speed") · ${eta:-—}" \
        "$pct% · $(fmt_speed "$speed")" "$pct%"
      progress_paint "$(bar_for "$STATS_W" "$pct")" "$STATS_TEXT"
    else
      stats=$(hsize "$cur")
      progress_stats "$stats · $(fmt_speed "$speed")" "$stats" "$stats"
      pos=$(((pos + 1) % (STATS_W + win)))
      progress_paint "$(sweep_for "$STATS_W" "$pos" "$win")" "$STATS_TEXT"
    fi
    sleep 0.1 2>/dev/null || sleep 1
  done
  if wait "$pid"; then rc=0; else rc=$?; fi
  FETCH_PID=""
  return "$rc"
}

step_download() {
  step_begin "download"
  # the bar paints this step's own row while curl runs in the background
  if ! fetch_with_bar "$BASE/tfm-$ARCH.gz" "$WORK/tfm.gz" "$WORK/tfm.hdr"; then
    fail_at download "download failed" \
      "Couldn't download tfm right now." \
      "Check your internet connection and run the same command again." \
      "Nothing was installed."
  fi
  if [ ! -s "$WORK/tfm.gz" ]; then
    fail_at download "empty download" \
      "The download came back empty." \
      "Please try again in a moment. Nothing was installed."
  fi
  step_ok "$(hsize "$(wc -c <"$WORK/tfm.gz" | tr -d ' ')") · tfm-$ARCH.gz"
}

step_verify() {
  step_begin "verify"
  # fail closed when the release ships a checksum, fail open (loud) only when
  # there is none at all.
  # NOTE: compare digests directly, never `sha256sum -c`: the published sidecar
  # embeds the release filename (tfm-<arch>.gz) while we save as tfm.gz, so -c
  # looks for a file that isn't there and fails every install.
  if curl -fsSL --retry 3 --proto '=https' "$BASE/tfm-$ARCH.gz.sha256" -o "$WORK/tfm.gz.sha256" >>"$RUN_LOG" 2>&1; then
    local want got
    want=$(cut -d' ' -f1 <"$WORK/tfm.gz.sha256")
    got=$(sha256sum <"$WORK/tfm.gz" | cut -d' ' -f1)
    if [ -z "$want" ] || [ "$want" != "$got" ]; then
      fail_at verify "checksum mismatch" \
        "The download didn't match our security checksum." \
        "Nothing was installed. Please try again in a moment."
    fi
    step_ok "sha256 matches the published checksum"
  elif [ "${TFM_NO_VERIFY:-}" = "1" ]; then
    step_warn "skipped (TFM_NO_VERIFY=1)"
  else
    fail_at verify "no checksum published" \
      "This release didn't publish a security checksum, so tfm refuses to install it." \
      "Re-run with TFM_NO_VERIFY=1 to skip the check, or pin TFM_VERSION to a release that includes checksums. Nothing was installed."
  fi
}

# ── steps: source ───────────────────────────────────────────────────────────
bun_version() {
  local v
  v=$(bun --version 2>/dev/null || true)
  v="${v#v}"
  case "$v" in '' | *[!0-9.]*) printf '' ;; *) printf '%s' "$v" ;; esac
}

# numeric major.minor compare against 1.4 (Bun < 1.4.0 skips overwriting an
# existing file in cpSync, which breaks plugin updates, and Bun.Image needs
# >= 1.3.14 for photo thumbnails — CI pins 1.4.0, so we do too)
version_ge_14() {
  local v=$1 maj min rest
  maj="${v%%.*}"
  rest="${v#*.}"
  min="${rest%%.*}"
  [ "$maj" -gt 1 ] && return 0
  [ "$maj" -eq 1 ] && [ "$min" -ge 4 ] && return 0
  return 1
}

step_toolchain() {
  step_begin "toolchain"
  have git || fail_at toolchain "no git" \
    "Building from source needs git." \
    "Install git (or use the release one-liner from the README) and try again."
  if ! have bun; then
    if [ -t 1 ] && { true </dev/tty; } 2>/dev/null; then
      local no_bun="Building from source needs bun 1.4 or newer."
      local bun_hint="Install it with: curl -fsSL https://bun.sh/install | bash"
      local ask="bun isn't installed. Install it with the official script?"
      local ans=""
      if [ "$FANCY" = 1 ]; then printf '\n'; fi
      if [ "$FANCY" = 1 ]; then
        printf '  %s?%s  %s  %s[y/N]%s ' "$C_BRAND" "$C_RST" "$ask" "$C_DIM" "$C_RST"
      else
        printf 'tfm: %s [y/N] ' "$ask"
      fi
      # default NO: this one runs a third-party network installer, unlike the
      # PATH question, so a stray Enter must not install anything
      if ! IFS= read -r ans </dev/tty; then
        printf '\n'
        fail_at toolchain "no bun" "$no_bun" "$bun_hint"
      fi
      case "$ans" in
        y | Y | yes | YES | Yes) ;;
        *)
          printf '\n'
          fail_at toolchain "no bun" "$no_bun" "$bun_hint"
          ;;
      esac
      if ! run_child bash -c 'curl -fsSL https://bun.sh/install | bash'; then
        fail_at toolchain "bun install failed" \
          "Couldn't install bun automatically." \
          "Install it by hand from https://bun.sh and run the same command again."
      fi
      export PATH="$HOME/.bun/bin:$PATH"
    fi
    have bun || fail_at toolchain "no bun" \
      "Building from source needs bun 1.4 or newer." \
      "Install it with: curl -fsSL https://bun.sh/install | bash"
  fi
  local bv
  bv=$(bun_version)
  if [ -z "$bv" ]; then
    fail_at toolchain "bun version unknown" \
      "Couldn't read the bun version." \
      "Run 'bun --version' to check your install, or use the release one-liner."
  fi
  if ! version_ge_14 "$bv"; then
    fail_at toolchain "bun $bv too old" \
      "tfm needs bun 1.4 or newer (found $bv)." \
      "Run 'bun upgrade' and try again."
  fi
  step_ok "$(git --version | cut -d' ' -f1-3) · bun $bv"
}

step_fetch() {
  step_begin "fetch"
  local short=""
  if [ -d "$SRC_DIR/.git" ]; then
    local origin
    origin=$(git -C "$SRC_DIR" remote get-url origin 2>/dev/null || true)
    if [ "$origin" != "$REMOTE" ]; then
      fail_at fetch "foreign checkout" \
        "$SRC_DIR is a git checkout of a different repository ($origin)." \
        "Point TFM_SRC_DIR at a different path, or remove that directory."
    fi
    if [ -n "$(git -C "$SRC_DIR" status --porcelain 2>/dev/null)" ]; then
      fail_at fetch "local changes" \
        "$SRC_DIR has local changes, so tfm won't touch it." \
        "Commit or stash them, or point TFM_SRC_DIR at a fresh path." \
        "Nothing was installed."
    fi
    if ! run_child git -C "$SRC_DIR" fetch --depth 1 origin "$SOURCE"; then
      fail_at fetch "fetch failed" \
        "Couldn't fetch $SOURCE from $REMOTE." \
        "Check your internet connection and try again. Nothing was installed."
    fi
    if ! run_child git -C "$SRC_DIR" checkout -q --detach FETCH_HEAD; then
      fail_at fetch "checkout failed" \
        "Couldn't check out $SOURCE in $SRC_DIR." \
        "Remove that directory and run the same command again."
    fi
  else
    if [ -e "$SRC_DIR" ]; then
      fail_at fetch "not a checkout" \
        "$SRC_DIR exists and isn't a tfm git checkout, so tfm won't touch it." \
        "Point TFM_SRC_DIR at a different path, or remove that directory."
    fi
    mkdir -p "$(dirname "$SRC_DIR")"
    if ! run_child git clone --depth 1 --single-branch --branch "$SOURCE" "$REMOTE" "$SRC_DIR"; then
      rm -rf "$SRC_DIR" 2>/dev/null || true
      fail_at fetch "clone failed" \
        "Couldn't clone $SOURCE from $REMOTE." \
        "Check your internet connection and try again. Nothing was installed."
    fi
  fi
  short=$(git -C "$SRC_DIR" rev-parse --short HEAD 2>/dev/null || printf '?')
  step_ok "$SOURCE @ $short → $(pretty_home "$SRC_DIR")"
}

step_build() {
  step_begin "build"
  local t0 t1 secs
  t0=$(date +%s)
  if ! run_child_in "$SRC_DIR" bun install --frozen-lockfile; then
    fail_at build "install failed" \
      "bun couldn't install the dependencies of $SRC_DIR." \
      "See the output above, or run 'bun install --frozen-lockfile' there yourself." \
      "Nothing was installed."
  fi
  if ! run_child_in "$SRC_DIR" bun run compile; then
    fail_at build "compile failed" \
      "The build of $SRC_DIR failed." \
      "See the output above, or run 'bun run compile' there yourself." \
      "Nothing was installed."
  fi
  if [ ! -s "$SRC_DIR/dist/tfm" ]; then
    fail_at build "no binary" \
      "The build finished but produced no binary at $SRC_DIR/dist/tfm." \
      "See the output above. Nothing was installed."
  fi
  t1=$(date +%s)
  secs=$((t1 - t0))
  local took
  if [ "$secs" -ge 60 ]; then took="$((secs / 60))m$((secs % 60))s"; else took="${secs}s"; fi
  step_ok "$took · bun install + bun run compile → dist/tfm"
}

# ── steps: install ──────────────────────────────────────────────────────────
# No backup copy is kept: the STAGED build is tested before anything in $DEST is
# touched, so a build that doesn't run leaves the installed one exactly where it
# is. The old flow moved the previous binary to tfm.bak first and only warned
# afterwards — a 100 MB file nobody ever cleaned up.
#
# Run `<file> --version` (what the old `check` step did, moved in front of the
# swap). Sets SMOKE_VER on success, SMOKE_LINE to whatever it printed.
smoke_version() { # smoke_version FILE
  local file=$1 out="" first="" ok=1
  SMOKE_VER=""
  SMOKE_LINE=""
  if have timeout; then
    out=$(timeout -k 2 15 "$file" --version 2>&1) || ok=0
  else
    out=$("$file" --version 2>&1) || ok=0
  fi
  first="${out%%$'\n'*}"
  SMOKE_LINE=$first
  [ "$ok" = 1 ] || return 1
  case "$first" in
    'tfm '*) SMOKE_VER="${first#tfm }"; return 0 ;;
    *) return 1 ;;
  esac
}

# One binary, two commands. Created BEFORE the swap, so the two names can never
# disagree: if the name can't be installed, the install fails while your tfm is
# still untouched.
link_second_name() { # link_second_name SRC_FILE
  local src=$1
  local link="$DEST/terminal-file-manager"
  if [ -d "$link" ] && [ ! -L "$link" ]; then
    fail_at install "terminal-file-manager is a directory" \
      "$link is a directory, so tfm can't install the command there." \
      "Move it aside and run the same command again." \
      "Nothing was installed over your copy."
  fi
  ln -sfn "$DEST/tfm" "$link" 2>>"$RUN_LOG" && return 0
  # no symlinks on this filesystem (exFAT/vfat): install a copy instead — of the
  # STAGED file, so it works on a fresh install too, and never through a symlink
  # we just failed to replace (cp would write into its target)
  rm -f "$link" 2>/dev/null || true
  cp -f "$src" "$link" 2>>"$RUN_LOG" && return 0
  fail_at install "can't install terminal-file-manager" \
    "Couldn't create $link." \
    "Check permissions and free space, then try again." \
    "Nothing was installed over your copy."
}

install_binary() { # install_binary SRC_FILE
  local src=$1
  chmod +x "$src" || fail_at install "chmod failed" \
    "Couldn't mark the new build executable." \
    "Nothing was installed over your copy."
  if [ -z "$NO_SMOKE" ]; then
    smoke_version "$src" || fail_at install "the build didn't run" \
      "The new build didn't report its version (${SMOKE_LINE:-no output})." \
      "Nothing was installed over your copy."
  fi
  link_second_name "$src"
  # copy into the install dir + rename = one atomic swap. `mv "$src" "$DEST/tfm"`
  # would be a cross-device copy whenever $WORK sits on another filesystem (tmpfs
  # /tmp), and a failure halfway through it truncates the installed binary.
  rm -f "$DEST"/.tfm-new.* 2>/dev/null || true
  NEW_FILE="$DEST/.tfm-new.$$"
  if ! cp -f "$src" "$NEW_FILE" 2>>"$RUN_LOG" || ! chmod +x "$NEW_FILE" 2>>"$RUN_LOG" ||
    ! mv -f "$NEW_FILE" "$DEST/tfm" 2>>"$RUN_LOG"; then
    rm -f "$NEW_FILE" 2>/dev/null || true
    NEW_FILE=""
    # a dangling second name is only possible when there was no previous binary
    if [ ! -e "$DEST/tfm" ]; then rm -f "$DEST/terminal-file-manager" 2>/dev/null || true; fi
    fail_at install "move failed" \
      "Couldn't write $DEST/tfm." \
      "Check permissions and free space, then try again." \
      "Your existing tfm (if any) is untouched."
  fi
  NEW_FILE=""
  # a tfm.bak an older installer left behind is swept only now — never before the
  # swap, when it is still the only copy of a working binary
  BAK_REMOVED=0
  if [ -f "$DEST/tfm.bak" ] && [ ! -L "$DEST/tfm.bak" ]; then
    if rm -f "$DEST/tfm.bak" 2>>"$RUN_LOG"; then BAK_REMOVED=1; fi
  fi
}

step_install() {
  step_begin "install"
  local src="$WORK/tfm" from="" detail=""
  if [ "$MODE" = "release" ]; then
    if ! run_child gunzip -f "$WORK/tfm.gz"; then
      fail_at install "unpack failed" \
        "Couldn't unpack the download." \
        "Is the disk full? Free some space and try again." \
        "Nothing new was installed over your copy."
    fi
  else
    # source / local: COPY into the temp dir instead of moving, so the checkout
    # (and your own build under dist/) keeps its binary for the next run
    if [ "$MODE" = "source" ]; then from="$SRC_DIR/dist/tfm"; else from="$LOCAL"; fi
    if [ ! -f "$from" ]; then
      fail_at install "no such file" \
        "There is no binary at $from." \
        "Point TFM_LOCAL at a built tfm binary, or let the build produce dist/tfm."
    fi
    if ! cp -f "$from" "$src" 2>>"$RUN_LOG"; then
      fail_at install "copy failed" \
        "Couldn't copy $from into the temp dir." \
        "Check free space, then try again." \
        "Nothing new was installed over your copy."
    fi
  fi
  if [ ! -s "$src" ]; then
    fail_at install "empty build" \
      "The binary to install is empty ($src)." \
      "Rebuild it and try again. Nothing was installed."
  fi
  install_binary "$src"
  if [ -n "$NO_SMOKE" ]; then
    detail="$(pretty_home "$DEST")/tfm · test skipped (TFM_NO_SMOKE=1)"
  else
    detail="$(pretty_home "$DEST")/tfm · tfm $SMOKE_VER runs"
  fi
  if [ "$BAK_REMOVED" = 1 ]; then detail="$detail · removed old tfm.bak"; fi
  step_ok "$detail"
}

# ── PATH setup + result ─────────────────────────────────────────────────────
path_action=""
reload_cmd=""
export_hint=""

ask_path() {
  path_action=ready
  reload_cmd=""
  export_hint="export PATH=\"$(pretty_dollar_home "$DEST"):\$PATH\""
  # only $DEST on PATH counts: a stray older `tfm` elsewhere must not skip setup
  case ":$PATH:" in
    *":$DEST:"*) return 0 ;;
  esac
  setup_shell_profile
  if [ "$SHELL_KNOWN" = 0 ]; then
    # don't guess an rc file, hand them the portable export instead
    path_action=export
    return 0
  fi
  # no tty to ask on (stdin belongs to the curl|bash pipe): print instructions
  if ! { true </dev/tty; } 2>/dev/null; then
    path_action=export
    return 0
  fi
  local REPLY=""
  if [ "$FANCY" = 1 ]; then
    printf '  %s?%s  add %s%s%s to your PATH for %s?  %s[Y/n]%s ' \
      "$C_BRAND" "$C_RST" "$C_BOLD" "$(pretty_home "$DEST")" "$C_RST" "$SHELL_LABEL" "$C_DIM" "$C_RST"
  else
    printf 'tfm: add %s to PATH for %s? [Y/n] ' "$(pretty_home "$DEST")" "$SHELL_LABEL"
  fi
  if ! IFS= read -r REPLY </dev/tty; then
    printf '\n'
    path_action=export
    return 0
  fi
  if [ "${REPLY#n}" != "$REPLY" ] || [ "${REPLY#N}" != "$REPLY" ]; then
    path_action=export
    if [ "$FANCY" = 1 ]; then printf '\n'; fi
    return 0
  fi
  mkdir -p "$(dirname "$RCFILE")"
  touch "$RCFILE"
  if ! grep -qF '# tfm PATH' "$RCFILE"; then
    { echo; echo '# tfm PATH'; echo "$LINE"; } >>"$RCFILE"
  fi
  # the rc file has the entry (written now or already) but this shell doesn't
  path_action=reload
  reload_cmd="source $(pretty_home "$RCFILE")"
  if [ "$FANCY" = 1 ]; then printf '\n'; fi
  return 0
}

print_result() {
  local title="tfm is ready"
  if [ -n "$SMOKE_VER" ]; then title="tfm $SMOKE_VER is ready"; fi
  local long_export=0
  if [ "$((8 + $(disp_w "$export_hint")))" -gt "$PANEL_MAX" ]; then long_export=1; fi

  local lines=("$title" "installed to $(pretty_home "$DEST")/tfm" "")
  case "$path_action" in
    reload)
      lines+=("this terminal needs a refresh:" "> $reload_cmd" "" "then start it:" "> tfm or terminal-file-manager")
      ;;
    export)
      if [ "$SHELL_KNOWN" = 0 ]; then
        lines+=("add $(pretty_home "$DEST") to your PATH for your shell:")
      else
        lines+=("put it on your PATH first:")
      fi
      [ "$long_export" = 0 ] && lines+=("> $export_hint")
      lines+=("" "then start it:" "> tfm or terminal-file-manager")
      ;;
    *)
      lines+=("start it:" "> tfm or terminal-file-manager")
      ;;
  esac
  if [ "$FANCY" = 1 ]; then
    panel "$C_OK" "${lines[@]}"
  else
    # no box in a log: the same lines, one `tfm:` line each
    local l
    for l in "${lines[@]}"; do
      [ -z "$l" ] && continue
      case "$l" in
        '>'*) l="${l#>}"; l="${l# }" ;;
      esac
      plain "$l"
    done
  fi
  if [ "$path_action" = export ] && [ "$long_export" = 1 ]; then
    printf '\n'
    note "$C_DIM" "run this once:"
    if [ "$FANCY" = 1 ]; then printf '    %s%s%s\n' "$C_BOLD" "$export_hint" "$C_RST"; else plain "$export_hint"; fi
  fi
}

print_tip() {
  if [ "$FANCY" = 1 ]; then
    printf '\n  %sesc opens the menu · ctrl+q quits · github.com/%s%s\n' "$C_DIM" "$REPO" "$C_RST"
  else
    plain 'run "tfm" (esc opens the menu, ctrl+q quits)'
  fi
}

# ── main ────────────────────────────────────────────────────────────────────
# TFM_INSTALL_LIB_ONLY=1 exposes the renderers (disp_w / wrap_line / panel /
# step_*) to tests without doing any work: `source install.sh`.
if [ "${TFM_INSTALL_LIB_ONLY:-}" = "1" ]; then
  if [ "${BASH_SOURCE[0]}" != "$0" ]; then return 0; fi
  exit 0
fi

MODE=release
if [ -n "$LOCAL" ]; then
  MODE=local
elif [ -n "$SOURCE" ]; then
  MODE=source
fi

banner "$MODE"
setup_workdir
step_system
if [ "$MODE" = "release" ]; then
  step_download
  step_verify
elif [ "$MODE" = "source" ]; then
  step_toolchain
  step_fetch
  step_build
fi
step_install
if [ "$MODE" = "source" ]; then
  rule
  note "$C_DIM" "unreleased dev build · re-run the same command to update"
  if [ "$FANCY" = 1 ]; then printf '\n'; fi
fi
ask_path
print_result
print_tip
print_extras
