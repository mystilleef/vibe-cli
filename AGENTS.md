# Agent

## Commands

- **Install:** `bun install`
- **Test:** `bun coverage`
- **Lint:** `bun check`
- **Verify:** `bun verify`
- **Provider configuration required for model commands:**
  - Copy `settings.example.json` to `~/.vibe-cli/settings.json`
  - Export at least one secret matching a configured `envVar`, such as:
    - `GEMINI_API_KEY`,
    - `OPENAI_API_KEY`,
    - `OPENROUTER_API_KEY`,
    - `ANTHROPIC_API_KEY`,
    - `DEEPSEEK_API_KEY`,
    - `OPENCODE_API_KEY`,
    - `MIMO_API_KEY`,
    - `DASHSCOPE_API_KEY`

## Workflow

- CI: `bun run verify`

## Rules

- After edits:
  - Run `bun check` to address lint issues
  - Run `bun verify`, at your discretion, for comprehensive validation.

### Testing rules

- Before writing tests, read relevant `bun` testing guides, on demand,
  in `./docs/bun/testing`. The agent file in that folder indexes what
  each guide documents.

## Gotchas

- Provider metadata requires `~/.vibe-cli/settings.json`; legacy `.env` provider settings get ignored.
- CLI commands emit JSON to `stdout` on success, and error JSON
  `{"error":"..."}` to `stderr` with exit code 1 on failure.
- `Autosessions` expire after four hours of inactivity.
