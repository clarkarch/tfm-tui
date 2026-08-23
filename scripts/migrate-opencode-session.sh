#!/bin/bash
# Rebinds opencode session history from test-ui -> tfm-tui.
# Run AFTER closing all opencode instances.
set -e
DB="$HOME/.local/share/opencode/opencode.db"
OLD="/home/clark/Projects/vibecoded/js/test-ui"
NEW="/home/clark/Projects/vibecoded/js/tfm-tui"

cp "$DB" "$DB.bak-$(date +%s)"
sqlite3 "$DB" "
  UPDATE project SET worktree  = '$NEW' WHERE worktree  = '$OLD';
  UPDATE session SET directory = '$NEW' WHERE directory = '$OLD';"
echo "migrated: $(sqlite3 "$DB" "SELECT COUNT(*) FROM project WHERE worktree='$NEW'") project row(s)"
