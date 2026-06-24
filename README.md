# vibe-cli

`Metacognitive` AI agent oversight CLI with JSON I/O.

`vibe` helps agents:

- Review plans before risky work.
- Revise blocked plans until approval or attempt exhaustion.
- Record local mistake, preference, and success patterns.
- Keep autosession-scoped constitution rules.
- List local data for agent inspection.
- Prune stale or duplicate local data with backup safeguards.
- Test provider connectivity before `LLM` use.

## Requirements

- Bun >= 1.0.0.
- Provider credential for any command that calls an `LLM`.

## Install

```sh
bun install --frozen-lockfile
bun run build
```

Configure local settings:

```sh
mkdir -p ~/.vibe-cli
cp settings.example.json ~/.vibe-cli/settings.json
```

Then:

- Edit `~/.vibe-cli/settings.json`.
- Select a top-level `provider`.
- Export the credential `env` var named by that provider entry.
- Run `./dist/vibe schema` to inspect resolved `config`.

Run without a copied binary:

```sh
bun run src/cli.ts schema
```

## Agent skills

Bundled skills under `skills/`:

- `vibe-check`: plan review gate for risky, ambiguous, irreversible, or
  multi-step work.
- `vibe-constitution`: persistent rules for future checks.
- `vibe-learn`: reusable mistake, preference, and success lessons.

Install skills:

```sh
mkdir -p ~/.agents/skills
cp -R skills/* ~/.agents/skills/
```

## Configuration

Settings path: `~/.vibe-cli/settings.json`.

Top-level fields:

- `provider`: selected provider entry name.
- `model`: optional model override.
- `maxAttempts`: optional plan refinement limit; fallback `10`.
- `useLearningHistory`: optional learning-history prompt toggle.
- `providers`: provider entries.

Provider entry fields:

- `name`
- `spec`: `openai`, `anthropic`, or `gemini`
- `envVar`: credential environment variable name
- `defaultModel`: optional default model
- `baseUrl`: endpoint URL; include for `openai` spec
- `apiVersion`: optional Anthropic API version
- `authTokenEnvVar`: optional Anthropic bearer-token `env` var
- `temperature`: optional finite number or `null`

Resolution order:

1. Provider: `--provider` flag, then settings `provider`.
2. Model: `--model` flag, then settings `model`, then provider
   `defaultModel`.

Credential lookup reads only the parent-process environment. Legacy
`~/.vibe-cli/.env` triggers a deprecation warning.

## Usage

Core commands print one JSON object to `stdout`. List commands print
pretty text unless `--json`. Failures print `{"error":"message"}` to
`stderr` and exit `1`.

### Check a plan

```sh
vibe check \
  --goal "Update README" \
  --plan "Inspect project evidence, update documentation, run verification" \
  --context "Documentation maintenance"
```

Useful flags:

- `--progress <text>`
- `--uncertainty <text>` repeatable
- `--prompt <text>`
- `--provider <name>`
- `--model <name>`
- `--max-attempts <n>`

Exit `2` signals a blocked or exhausted plan.

### Record a lesson

```sh
vibe learn \
  --type success \
  --category "Documentation" \
  --observation "Project evidence guided the README." \
  --solution "Inspect source and configuration before drafting."
```

Types: `mistake`, `preference`, `success`. `mistake` and `success` need
`--solution`.

### Manage rules

```sh
vibe constitution set --rule "Ask before destructive changes."
vibe constitution get
vibe constitution reset --rule "Keep responses concise."
```

The active `autosession` keeps up to 50 rules.

### List local data

```sh
vibe list
vibe list learnings --type mistake --limit 5 --json
vibe list providers
vibe list all --json
```

List `subcommands`:

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

Targets:

- `--learnings`: stale learning entries
- `--duplicates`: overlapping learning entries
- `--demos`: demo-linked learning entries
- `--sessions`: stale sessions

Options:

- `--age <days>`: default `90`
- `--category <name>`: learning or duplicate filters
- `--overlap <float>`: default `0.6`
- `--dry-run`: report candidates only
- `-y, --yes`: allow deletion after backup

Without explicit target or `--yes`, prune runs a dry-run across all
targets.

### Other commands

```sh
vibe session
vibe migrate
vibe verify --provider gemini --model gemini-2.5-flash
vibe schema
vibe demo
```

## Storage

Data root: `~/.vibe-cli/`.

SQLite data:

- `Autosessions` keyed by working directory.
- Check interaction history.
- Learning entries.
- Constitution rules.

`Autosessions` expire after 4 hours of inactivity. Constitution storage
caps each session at 50 rules.

## Development

```sh
bun check
bun coverage
bun run build
bun verify
```

Make targets mirror scripts:

```sh
make check
make coverage
make verify
```

CI runs:

```sh
bun install --frozen-lockfile
bun run verify
```

## Project layout

```text
src/cli.ts              command registration and JSON emitters
src/tools/              command implementations
src/utils/              provider, settings, storage, and formatting helpers
tests/                  Bun test suite
skills/                 bundled agent skills
settings.example.json   provider settings template
```

## License

**MIT**
