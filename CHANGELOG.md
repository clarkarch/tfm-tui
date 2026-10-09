# Changelog

## 1.0.0 — first stable release

Terminal file manager goes stable: the beta warning is lifted and the
version is `1.0.0`.

Stability work in this release:

- Quit refuses while file operations are in flight (same guard restart
  already had) instead of exiting mid-batch and stranding completed files
  with no undo entry.
- Plugin `beforeFileOp` veto now covers `extract` and `compress` (it
  previously covered only copy/move/rename/duplicate/trash paths).
- Archive extraction is staged + contained: tools that write outside the
  staging dir (`../` members) are refused with the escape moved to trash
  (recoverable, never deleted), and symlinks resolving outside staging are
  removed before entries move into place.
- Bulk rename re-checks each target at apply time so a file created
  between planning and applying is never silently overwritten.
- Per-mount trash sidecars no longer fall back to the home trash: a
  missing `$topdir/.Trash-$uid` sidecar (or unreadable original-path
  lookup) no longer touches or resolves to a same-named home entry.
- Undo journal `trash` steps are idempotent: undoing a copy whose target
  is already gone succeeds instead of reporting FAILED.
- Sudo outcomes keep their permission-qualified undo hint
  (`ctrl+z to undo (may need permission)`); trash/restore stay
  unprivileged by design, deletes escalate without an undo promise.
