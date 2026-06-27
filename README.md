# vibe-cli

**Metacognitive** oversight CLI for AI agents. Reviews plans, records
lessons, stores constitution rules, lists local memory, prunes stale
data, and verifies provider connectivity through JSON-first commands.

## Requirements

- Bun.
- Node.js 22 in CI.
- Provider API key matching the selected `settings.json` entry.

## Install

```sh
bun install --frozen-lockfile
bun run build
```

- Local checkout:

```sh
bun run src/cli.ts --help
```

- Built binary:

```sh
./dist/vibe --help
```

## Configuration

Copy the example settings file into the data root:

```sh
mkdir -p ~/.vibe-cli
cp settings.example.json ~/.vibe-cli/settings.json
```

Then edit `~/.vibe-cli/settings.json`:

- `provider`: active provider entry name.
- `maxAttempts`: refinement limit for `vibe check`.
- `providers[].spec`: `gemini`, `openai`, or `anthropic`.
- `providers[].envVar`: environment variable for the provider key.
- `providers[].defaultModel`: model fallback when `--model` stays
  omitted.
- `providers[].thinking`: `off`, `low`, `medium`, `high`, or `xhigh`.

Provider environment examples from `settings.example.json`:

- `GEMINI_API_KEY`
- `OPENAI_API_KEY`
- `ANTHROPIC_API_KEY` or `ANTHROPIC_AUTH_TOKEN`
- `OPENROUTER_API_KEY`
- `DEEPSEEK_API_KEY`
- `MIMO_API_KEY`
- `HF_TOKEN`
- `OPENCODE_API_KEY`
- `DASHSCOPE_API_KEY`

## Usage

Examples use the package bin name `vibe`. Substitute
`bun run src/cli.ts` in a checkout.

### Inspect command surface

```sh
vibe schema
vibe --help
```

### Check a plan

```sh
vibe check \
  --goal "Update README" \
  --plan "Inspect evidence, update docs, run verification" \
  --uncertainty "No release focus supplied"
```

- Returns JSON with `proceed`, `confidence`, `reason`, `feedback`,
  `plan`, and `attempts`.
- Non-proceeding result exits with code `2`.
- `--provider` and `--model` override settings for one call.

### Record a lesson

```sh
vibe learn \
  --type success \
  --category "Documentation" \
  --observation "Project evidence guided the README." \
  --solution "Inspect source and configuration before drafting."
```

- `mistake` and `success` entries require `--solution`.
- `preference` entries can omit `--solution`.
- Storage suppresses similar observations.

### Manage rules

```sh
vibe constitution set --rule "Ask before destructive changes."
vibe constitution get
vibe constitution reset --rule "Keep responses concise."
```

- Rules attach to the current `autosession`.
- Storage keeps up to 50 rules per `autosession`.

### Query local data

```sh
vibe list
vibe list providers
vibe list learnings --type mistake --limit 5 --json
vibe list all --json
```

`Subcommands`:

- `learnings`
- `constitution`
- `sessions`
- `providers`
- `checks`
- `categories`
- `stats`
- `all`

### Prune local data

```sh
vibe prune --learnings --dry-run
vibe prune --duplicates --yes
```

- Without `--yes`, prune reports candidates only.
- Destructive prune writes a backup path in the result.
- Filters: `--age`, `--category`, `--overlap`.

### Other commands

```sh
vibe session
vibe migrate
vibe verify --provider gemini --model gemini-3.5-flash
vibe demo
```

- `session`: active `autosession` ID for the working directory.
- `migrate`: database migration state.
- `verify`: live provider connectivity probe.
- `demo`: live `walkthrough`.

## Storage

- Data root: `~/.vibe-cli`.
- Settings file: `~/.vibe-cli/settings.json`.
- SQLite file: `~/.vibe-cli/vibe.db`.
- `Autosessions` map working directories to 4-hour local sessions.
- Tables store interactions, learning entries, constitution rules,
  migrations, and legacy import markers.

## Development

```sh
bun check
bun coverage
bun run build
bun verify
```

- `bun check`: Biome check/write plus TypeScript `--noEmit`.
- `bun coverage`: Bun test suite with coverage settings from
  `bunfig.toml`.
- `bun verify`: Biome migration, check, build, coverage chain.

Make targets:

```sh
make check
make coverage
make verify
```

## Project layout

- `src/cli.ts`: Commander command registration.
- `src/tools/`: plan gate, learning, constitution, demo, prune
  orchestration.
- `src/utils/`: settings, provider dispatch, storage, schema, list
  readers, `formatters`.
- `skills/`: bundled agent skills for `vibe-check`, `vibe-learn`,
  `vibe-constitution`.
- `tests/`: Bun test suite.
