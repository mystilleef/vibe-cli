# vibe-cli

`Metacognitive` AI agent oversight through a Bun-powered CLI with JSON
I/O.

`vibe` helps agents pause before risky work, refine unsafe plans, record
reusable lessons, and keep per-session behavioral rules.

## Features

- Gate plans with model-backed `metacognitive` review.
- Revise blocked plans until approval or attempt exhaustion.
- Record mistake, preference, and success patterns in local storage.
- Maintain `autosession`-scoped constitution rules.
- Emit compact JSON for agent integrations.
- Verify provider connectivity before use.

## Requirements

- [Bun](https://bun.sh/)
- At least one supported provider key for commands that call a model

## Install

```sh
# Install project dependencies.
make install
# Build dist/vibe.
make
# Create a user-local bin directory.
mkdir -p ~/.local/bin
# Copy the executable into PATH.
cp dist/vibe ~/.local/bin/vibe
# Create the vibe configuration directory.
mkdir -p ~/.vibe-cli
# Copy the example provider configuration.
cp settings.example.json ~/.vibe-cli/settings.json
```

Edit `~/.vibe-cli/settings.json` to choose provider entries, models,
protocol specs, base URLs, and credential environment variable names.
The CLI never stores API tokens in settings. Export secrets through the
parent process environment before running provider commands:

```sh
export GEMINI_API_KEY=<key>
```

Supported protocol specs:

- `gemini`
- `openai`
- `anthropic`

Build the executable:

```sh
make
```

Each command creates `dist/vibe`. Install the CLI with one option:

```sh
bun link
```

`bun link` requires `~/.cache/.bun/cache` or `~/.bun/bin` in `PATH`.

Or copy the executable directly:

```sh
mkdir -p ~/.local/bin
cp dist/vibe ~/.local/bin/vibe
```

Add `~/.local/bin` to `PATH` when needed.

## Agent skills

Bundled agent skills live in `skills/`.

- `vibe-check`: main user-invoked skill. Run it when a plan needs
  oversight before risky, ambiguous, irreversible, or multi-step work.
- `vibe-constitution`: support skill for persistent rules that guide
  future checks.
- `vibe-learn`: support skill for reusable mistake, preference, and
  success lessons.

Optional but recommended: install bundled skills for your agent harness.
For the default skills folder:

```sh
mkdir -p ~/.agents/skills
cp -R skills/* ~/.agents/skills/
```

If your preferred harness uses another skills configuration folder, copy
`skills/*` there instead.

## Development

```sh
bun run src/cli.ts --help
bun check
bun verify
```

Useful scripts:

<!-- prettier-ignore-start -->
| Script | Purpose |
| --- | --- |
| `bun dev` | Run `src/cli.ts` directly. |
| `bun check` | Run Biome checks and TypeScript type-checking. |
| `bun coverage` | Run tests with coverage. |
| `bun build` | Compile the `vibe` binary into `dist/vibe`. |
| `bun verify` | Run migration, format, type-check, build, and coverage. |
<!-- prettier-ignore-end -->

The `Makefile` mirrors common workflows with `make install`,
`make check`, `make coverage`, and `make verify`.

## Configuration

`vibe` reads provider configuration from
`~/.vibe-cli/settings.json` only when a command needs provider data. Copy
`settings.example.json` manually; no command auto-installs runtime
defaults.

Provider selection follows this order:

1. `--provider` matching a `providers[].name` entry.
2. Top-level `provider` in `settings.json`.

Model selection follows this order:

1. `--model`.
2. Top-level `model` in `settings.json`, when present.
3. Selected provider `defaultModel`, when present.

Provider entries require `name`, supported `spec`, and `envVar`.
OpenAI-compatible entries also require `baseUrl`. Supported `spec`
values:

- `openai`: OpenAI-compatible HTTP APIs, including OpenAI, OpenRouter,
  DeepSeek, Mimo, OpenCode, and Qwen/DashScope.
- `anthropic`: Anthropic Messages API.
- `gemini`: Gemini API.

`DEFAULT_LLM_PROVIDER` and `DEFAULT_MODEL` no longer select providers or
models. Provider names, default models, base URLs, Anthropic API version,
and Anthropic `authTokenEnvVar` belong in `settings.json`. API tokens do
not; export direct environment variables through the parent process.

Configuration notes:

- OpenRouter entries in `settings.example.json` intentionally omit
  `defaultModel`; pass `--model` or set top-level `model`.
- Qwen/DashScope uses `envVar: "DASHSCOPE_API_KEY"` with an
  OpenAI-compatible `baseUrl`.
- Anthropic supports `envVar` API-key auth, optional
  `authTokenEnvVar` bearer-token auth, optional `baseUrl`, and optional
  `apiVersion`; API keys win when both auth values exist.
- Missing or invalid settings produce JSON-safe actionable errors for CLI
  commands.

Extra environment variables:

<!-- prettier-ignore-start -->
| Variable | Purpose |
| --- | --- |
| `GEMINI_API_KEY` | Gemini API key when referenced by `settings.json`. |
| `OPENAI_API_KEY` | OpenAI API key when referenced by `settings.json`. |
| `OPENROUTER_API_KEY` | OpenRouter API key when referenced by `settings.json`. |
| `ANTHROPIC_API_KEY` | Anthropic API key when referenced by `settings.json`. |
| `ANTHROPIC_AUTH_TOKEN` | Anthropic bearer-token alternative when referenced by `authTokenEnvVar`. |
| `DEEPSEEK_API_KEY` | DeepSeek API key when referenced by `settings.json`. |
| `OPENCODE_API_KEY` | OpenCode-compatible API key when referenced by `settings.json`. |
| `MIMO_API_KEY` | Mimo API key when referenced by `settings.json`. |
| `DASHSCOPE_API_KEY` | Qwen/DashScope API key when referenced by `settings.json`. |
<!-- prettier-ignore-end -->

## Usage

All commands write JSON to `stdout`. Fatal errors write
`{"error":"message"}` to `stderr` and exit with code `1`.

### Check a plan

```sh
bun run src/cli.ts check \
  --goal "Update documentation" \
  --plan "Inspect code, update README, run verification" \
  --context "Repository maintenance task"
```

`check` reviews the plan, blocks unsafe output with exit code `2`, and
returns the final reviewed plan.

Common options:

- `--progress <text>`: work completed so far.
- `--uncertainty <text>`: repeat for one or more uncertainties.
- `--prompt <text>`: original user prompt.
- `--max-attempts <n>`: refinement loop limit, default `10`.
- `--provider <name>`: per-call override matching a `settings.json`
  provider entry name.
- `--model <name>`: per-call model override.

### Record a lesson

```sh
bun run src/cli.ts learn \
  --type success \
  --category "Documentation" \
  --mistake "Inspect code before writing public docs." \
  --solution "Use source and tests as the documentation authority."
```

`learn` accepts `mistake`, `preference`, and `success` entry types.
Mistake and success entries require `--solution`.

### Manage constitution rules

```sh
bun run src/cli.ts constitution set --rule "Ask before destructive changes."
bun run src/cli.ts constitution get
bun run src/cli.ts constitution reset --rule "Keep responses concise."
```

Rules attach to the active `autosession` and feed future vibe checks.

### Inspect the active session

```sh
bun run src/cli.ts session
```

### Verify provider connectivity

```sh
bun run src/cli.ts verify --provider gemini --model gemini-2.5-flash
```

### Emit the integration schema

```sh
bun run src/cli.ts schema
```

`schema` returns a compact machine-readable summary of commands,
options, outputs, and exit codes.

### Run the demo

```sh
bun run src/cli.ts demo
```

## Storage

Configuration and local state persist under `~/.vibe-cli/`.
`settings.json` stores provider metadata only; provide secrets through
the parent process environment. Legacy `~/.vibe-cli/.env` provider
settings get ignored with a deprecation diagnostic. SQLite-backed
storage stores:

- `autosessions` keyed by working directory
- check interaction history
- learning entries
- constitution rules
- legacy migration records

`Autosessions` expire after four hours without access. Constitution
rules keep the latest 50 rules per session.

## Project layout

```text
src/
  cli.ts                 CLI entry point and command registration
  tools/
    constitution.ts      Session-scoped rule management
    demo.ts              Interactive walkthrough
    vibeCheck.ts         Metacognitive question generation wrapper
    vibeGate.ts          Blocking gate and plan refinement loop
    vibeLearn.ts         Learning-entry recording
  utils/
    anthropic.ts         Anthropic request configuration
    autosession.ts       Working-directory session resolution
    database.ts          SQLite schema and connection helpers
    dotenv.ts            Environment loading
    llm.ts               Provider dispatch, prompts, and gate logic
    state.ts             Check interaction history
    storage.ts           Learning-entry storage and summaries
tests/                   Bun test suite
```

## Verification

Run the full suite before publishing changes:

```sh
bun verify
```
