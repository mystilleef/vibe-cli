# Agent

## Commands

- **Install:** `bun install`
- **Test:** `bun coverage`
- **Lint:** `bun check`
- **Verify:** `bun verify`
- **Environment variables required:**
  - `GEMINI_API_KEY`,
  - `OPENAI_API_KEY`,
  - `OPENROUTER_API_KEY`,
  - `ANTHROPIC_API_KEY`,
  - `DEEPSEEK_API_KEY`,
  - `OPENCODE_API_KEY` (requires at least one provider key)

## Workflow

- CI: `bun run verify`

## Rules

- After edits:
  - Run `bun check` to address lint issues
  - Run `bun verify`, at your discretion, for comprehensive validation.

## Gotchas

- Environment configuration requires `~/.vibe-cli/.env`.
- CLI commands emit JSON to `stdout` on success, and error JSON
  `{"error":"..."}` to `stderr` with exit code 1 on failure.
- `Autosessions` expire after four hours of inactivity.
