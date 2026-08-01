# Proposal: `vibe settings install`

## Problem

- README step 2: `cp settings.example.json
  ~/.vibe-cli/settings.json` — works only from a checked-out repo.
- Global install (`bun install -g @mystilleef/vibe-cli`) ships no
  local `settings.example.json` to copy.
- `src/utils/settings.ts` already resolves the asset via
  `findPackageRoot` (`SETTINGS_EXAMPLE_PATH`) — no command copies it.

## Goals

- `vibe settings install` copies bundled `settings.example.json` →
  `<dataRoot>/settings.json`.
- Preserve user edits — no silent overwrite.
- Match `skills install`/`guide install` conventions (`--json`,
  `emitListResult`, exit codes).

## Non-goals

- Drift-sync after first install.
- Editing or validating the user's existing `settings.json`.
- `settings list`/`status` companion — single fixed-path file, `test
  -f` suffices (`YAGNI`).

## Design: skip-unless-forced

- `guide`/`skills install` hash-compare and replace — bundled asset
  drives the target.
- `settings.json` inverts this: user edits (provider/model/thinking)
  live in the file post-install.
- Missing → install. Present → skip. `--force` → overwrite.
  `--dry-run` → report only, no writes.

## Interface

```sh
vibe settings install [--dry-run] [--force] [--json]
```

- No `--target` — destination fixed at `getDataRoot()/settings.json`,
  the one path `loadProviderSettings()` reads.
- Test seams (non-public): `anchorDir` for source, `dataRoot`
  override for destination — matches `guideInstaller.ts`.

## Implementation

- `src/tools/settingsInstaller.ts`, parallel to `guideInstaller.ts`:
  - Resolve source via `SETTINGS_EXAMPLE_PATH`.
  - Validate source through `validateProviderSettings` before any
    write — malformed bundled asset fails loudly, nothing touches
    disk.
  - Symlink-rejection walk + atomic temp-file-then-`rename` (reuse
    `installGuide`'s implementation).
  - Status: `missing | present`. Action: `installed | skipped |
    replaced`.
  - On `installed`/`replaced`, non-`--json`: print a one-line
    reminder — edit the file, export the matching provider's `API`
    key env var.
- `src/cli.ts`: new `settings` command group, `install` subcommand,
  `withCliError` + `emitListResult`.
- New `src/utils/settingsFormatters.ts`: `formatSettingsInstall` —
  kept separate from `skillsGuideFormatters.ts` (that file scopes to
  skills+guide; `settings` grows independently).
- `SETTINGS_FILE_MISSING_ERROR` (`src/utils/settings.ts:11`): point
  at `vibe settings install`.
- `README.md` step 2: replace manual `mkdir -p && cp`.

## Decisions (`vibe-check`-confirmed)

| # | Decision | Reason |
| - | -------- | ------ |
| 1 | Skip-unless-forced, not hash-compare-replace | Prevents clobbering user edits on every bundled-example version bump. |
| 2 | Omit `settings list`/`status` | Single file, fixed path — no concrete consumer yet for a status subcommand. |
| 3 | New `settingsFormatters.ts` | Avoids mis-scoping `skillsGuideFormatters.ts`. |
| 4 | Validate source pre-copy | Fail-fast before a broken bundled asset reaches disk. |
| 5 | Post-install reminder, text mode only | User's next step: edit file, export key. Omit in `--json`. |
