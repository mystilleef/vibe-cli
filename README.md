# vibe-cli

> Vibe check your agent's ideas, proposals, plans, or solutions for
> **metacognitive** flaws with a mentor agent.

_Metacognitive_ oversight infrastructure for `AI` agents. Equips `LLM`
coding harnesses with skills to consult mentor models, store persistent
memory, and enforce constitutional rules.

## Requirements

- `Bun` >=1.0.0. The binary uses `bun:sqlite` and requires `Bun`.
- Provider `API` key matching the selected `settings.json` entry.

## Quick start

### Step 1: Install binary

```sh
bun install -g @mystilleef/vibe-cli
```

### Step 2: Configure mentor provider

1. Install the bundled settings template:

```sh
vibe settings install
```

2. Edit `~/.vibe-cli/settings.json` to define the mentor provider,
   model, and credentials:

- `provider`: active mentor provider entry name.
- `maxAttempts`: refinement limit for `vibe check`.
- `providers[].spec`: `gemini`, `openai`, or `anthropic`.
- `providers[].envVar`: environment variable for provider key.
- `providers[].defaultModel`: model fallback.
- `providers[].thinking`: `off`, `low`, `medium`, `high`, or `xhigh`.

3. Export matching `API` key (for example, `GEMINI_API_KEY`,
   `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`).

### Step 3: Install harness skills

Install bundled skills into your preferred `LLM` coding harness:

```sh
# Universal Agent Path (Default: ~/.agents/skills)
vibe skills install

# Claude Code
vibe skills install --target ~/.claude/skills

# Antigravity CLI
vibe skills install --target ~/.gemini/config/skills

```

### Step 4: Load agent policy

Install the guide and load it into agent context:

```sh
# Install vibe-guide.md into project root
vibe guide install
```

Add the guide to `AGENTS.md`, `CLAUDE.md`, or paste its content into
your agent's system prompt so agents know when and how to trigger `vibe`
skills. Loading remains opt-in. The install command never alters context
files automatically.

## Harness skill workflows

Developers instruct coding agents via natural language or slash
commands. The agent consults its policy, executes the underlying `vibe`
binary, processes mentor feedback, and reports back.

### `vibe-check`

Prompts mentor review before executing high-risk, ambiguous, or
multi-step tasks.

- **Natural language**: _"Draft a proposal for schema migration, vibe
  check it, then show for review."_
- **Slash command**: `/vibe-check`
- **Execution loop**:
  1. Developer requests action.
  2. Agent matches criteria in `vibe-guide.md`.
  3. Agent executes `vibe check` `CLI` binary under the hood.
  4. Agent processes mentor feedback (`proceed: true/false`,
     recommendations).
  5. Agent presents approved plan or adjusts strategy.

### `vibe-learn`

Persists lessons into local memory after concrete outcomes.

- **Natural language**: _"Record a vibe lesson about this failed
  database connection attempt."_
- **Slash command**: `/vibe-learn`
- **Categories**: `mistake`, `success`, `preference`.

### `vibe-constitution`

Enforces persistent behavioral rules across sessions.

- **Natural language**: _"Add a standing rule to vibe constitution
  requiring test execution before commits."_
- **Slash command**: `/vibe-constitution`

## Storage

- Data root: `~/.vibe-cli`.
- Settings file: `~/.vibe-cli/settings.json`.
- `SQLite` database: `~/.vibe-cli/vibe.db`.
- `Autosessions`: maps working directories to 4-hour local session
  scopes.
- Tables store review history, learning entries, constitution rules,
  migrations, and import markers.

## Agent protocol reference (`CLI` commands)

Coding agents execute these `CLI` commands behind the scenes. Developers
can also run them manually for administrative tasks.

### Check plan

```sh
vibe check \
  --goal "Update schema" \
  --plan "Run migration script, update ORM, run tests" \
  --uncertainty "No backup verified"
```

- Returns `JSON` with `proceed`, `confidence`, `reason`, `feedback`,
  `plan`, and `attempts`.
- Exit code `2` indicates non-proceeding verdict.

### Record lesson

```sh
vibe learn \
  --type mistake \
  --category "Database" \
  --observation "Connection timeout during heavy load." \
  --solution "Increase retry backoff threshold."
```

### Manage constitution rules

```sh
vibe constitution set --rule "Run test suite before commits."
vibe constitution get
vibe constitution reset --rule "Keep output concise."
```

### Manage skills

`skills list` and `skills install` print readable text by default. Pass
`--json` to emit the prior machine-readable payload for automation.

```sh
vibe skills list --target ~/.gemini/config/skills
vibe skills install --target ~/.claude/skills
vibe skills install --force

# Automation consumers
vibe skills list --target ~/.gemini/config/skills --json
vibe skills install --target ~/.claude/skills --json
```

### Manage guide

`guide list` and `guide install` print readable text by default. Pass
`--json` to emit the prior machine-readable payload for automation.

```sh
vibe guide list
vibe guide install

# Automation consumers
vibe guide list --json
vibe guide install --json
```

### Query and maintenance

```sh
vibe list all --json
vibe prune --duplicates --yes
vibe session
vibe verify --provider gemini --model gemini-3.5-flash
```

## Development

```sh
bun check
bun coverage
bun run build
bun verify
```

- `bun check`: `Biome` check/write plus `TypeScript` `--noEmit`.
- `bun coverage`: `Bun` test suite with coverage settings.
- `bun verify`: complete verification pipeline.

## Project layout

- `src/cli.ts`: `Commander` command registration edge.
- `src/tools/`: plan gate, learning, constitution, demo, prune
  orchestration.
- `src/utils/`: settings resolution, provider dispatch, `SQLite`
  persistence, schema projections.
- `skills/`: bundled agent skills (`vibe-check`, `vibe-learn`,
  `vibe-constitution`).
- `docs/vibe-guide.md`: operational policy for harness agent context.
- `tests/`: `Bun` test suite.
