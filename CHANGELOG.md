# Changelog

## Unreleased

Update checking and `tfm update`:

- `tfm update` asks GitHub for the newest release, prints what it found, asks
  before changing anything, then hands the install to `install.sh` (the same
  script as the documented one-liner, so replace and checksum policy stays in
  one place). `--tag vX` pins a release, `--force` reinstalls. Dev and source
  builds are refused with a pointer at `source.sh` instead of being silently
  swapped for a release.
- `esc` → About gained an Update row: it shows the live state (check for
  updates / up to date / update to vX), checks on click, and asks with the same
  confirm dialog as the default-file-manager prompt. The in-app install runs in
  the background behind a sticky toast and reports the outcome.
- New `[ui] check-updates` (off by default: tfm makes no network requests of
  its own). When on, the first frame is painted first and then one cached check
  per day can report a newer release, once per version. Also a `check for
  updates` command in the palette, unbound by default and remappable.
- The installer now exits early when you already run the target release
  (no more 40 MB re-download for nothing; `TFM_FORCE=1` reinstalls) and records
  what it installed (`$XDG_DATA_HOME/tfm/install.json`), which is how the app
  knows a source build from a release.
- The yes/no confirm dialogs dropped their `~~~~` divider row (empty trash,
  delete forever, default file manager, update).

## 1.0.0 — first stable release
