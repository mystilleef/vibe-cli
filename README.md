# vibe-cli

`Metacognitive` oversight infrastructure for `AI` agents. Equips `LLM`
coding harnesses with skills to consult mentor models, store persistent
memory, enforce constitutional rules, and manage local data.

## Requirements

- `Bun` >=1.0.0. The binary uses `bun:sqlite` and requires `Bun`.
- Provider `API` key matching the selected `settings.json` entry.

## Quick start

### Step 1: Install binary

```sh
bun install -g @mystilleef/vibe-cli
```

Local checkout alternative:

```sh
bun install --frozen-lockfile
bun run build
```

### Step 2: Configure mentor provider

Copy example settings into the data root:

```sh
mkdir -p ~/.vibe-cli
cp settings.example.json ~/.vibe-cli/settings.json
```

Edit `~/.vibe-cli/settings.json` to define the mentor provider, model,
and credentials:

- `provider`: active mentor provider entry name.
- `maxAttempts`: refinement limit for `vibe check`.
- `providers[].spec`: `gemini`, `openai`, or `anthropic`.
- `providers[].envVar`: environment variable for provider key.
- `providers[].defaultModel`: model fallback.
- `providers[].thinking`: `off`, `low`, `medium`, `high`, or `xhigh`.

Export matching `API` key (for example, `GEMINI_API_KEY`,
`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`).

### Step 3: Install harness skills

Install bundled skills into your preferred `LLM` coding harness:

```sh
# Antigravity CLI
vibe skills install --target ~/.gemini/config/skills

# Claude Code
vibe skills install --target ~/.claude/skills

# Universal Agent Path (Default)
vibe skills install
```

### Step 4: Load agent policy

Install the guide and load it into agent context:

```sh
# Install vibe-guide.md into project root
vibe guide install
```

Add the guide to `AGENTS.md`, `CLAUDE.md`, or paste its content into your
agent's system prompt so agents know when and how to trigger `vibe`
skills. Loading is opt-in; the install command does not modify context
files automatically.

## Harness skill workflows

Developers instruct coding agents via natural language or slash
commands. The agent consults its policy, executes the underlying `vibe`
binary, processes mentor feedback, and reports back.

### `vibe-check`

Prompts mentor review before executing high-risk, ambiguous, or
multi-step tasks.

- **Natural Language**: _"Draft a proposal for schema migration, vibe
  check it, then show for review."_
- **Slash Command**: `/vibe-check`
- **Execution Loop**:
  1. Developer requests action.
  2. Agent matches criteria in `vibe-guide.md`.
  3. Agent executes `vibe check` `CLI` binary under the hood.
  4. Agent processes mentor feedback (`proceed: true/false`,
     recommendations).
  5. Agent presents approved plan or adjusts strategy.

### `vibe-learn`

Persists lessons into local memory after concrete outcomes.

- **Natural Language**: _"Record a vibe lesson about this failed
  database connection attempt."_
- **Slash Command**: `/vibe-learn`
- **Categories**: `mistake`, `success`, `preference`.

### `vibe-constitution`

Enforces persistent behavioral rules across sessions.

- **Natural Language**: _"Add a standing rule to vibe constitution
  requiring test execution before commits."_
- **Slash Command**: `/vibe-constitution`

## Storage

- Data root: `~/.vibe-cli`.
- Settings file: `~/.vibe-cli/settings.json`.
- `SQLite` database: `~/.vibe-cli/vibe.db`.
- `Autosessions`: map working directories to 4-hour local session
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

```sh
vibe skills list --target ~/.gemini/config/skills
vibe skills install --target ~/.claude/skills
vibe skills install --force
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
