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
cp .env.example ~/.vibe-cli/.env
```

Fill `~/.vibe-cli/.env` with one provider key and optional defaults:

```env
DEFAULT_LLM_PROVIDER=gemini
DEFAULT_MODEL=gemini-2.5-pro
GEMINI_API_KEY=<key>
```

Supported providers:

- `gemini`
- `openai`
- `openrouter`
- `anthropic`
- `deepseek`
- `opencode`

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

`vibe` loads `~/.vibe-cli/.env` at startup. Provider selection follows
this order:

1. `--provider`
2. `DEFAULT_LLM_PROVIDER`
3. Detected provider key in the environment
4. `gemini` fallback

Model selection follows this order:

1. `--model`
2. `DEFAULT_MODEL`
3. Provider default

Provider defaults:

| Provider     | Default model                          |
| ------------ | -------------------------------------- |
| `gemini`     | `gemini-2.5-flash`                     |
| `openai`     | `gpt-4o-mini`                          |
| `anthropic`  | `claude-haiku-4-5-20251001`            |
| `deepseek`   | `deepseek-v4-pro`                      |
| `opencode`   | `kimi-k2.6`                            |
| `openrouter` | Pass `--model` or set `DEFAULT_MODEL`. |

Extra environment variables:

<!-- prettier-ignore-start -->
| Variable | Purpose |
| --- | --- |
| `GEMINI_API_KEY` | Gemini API key. |
| `OPENAI_API_KEY` | OpenAI API key. |
| `OPENROUTER_API_KEY` | OpenRouter API key. |
| `ANTHROPIC_API_KEY` | Anthropic API key. |
| `ANTHROPIC_AUTH_TOKEN` | Anthropic `OAuth` bearer token alternative. |
| `ANTHROPIC_BASE_URL` | Anthropic API base URL override. |
| `ANTHROPIC_VERSION` | Anthropic API version override. |
| `DEEPSEEK_API_KEY` | DeepSeek API key. |
| `OPENCODE_API_KEY` | OpenCode-compatible API key. |
| `USE_LEARNING_HISTORY` | Skip stored entries when set to `false`. |
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
- `--provider <name>` / `--model <name>`: per-call override.

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

Configuration and local state persist under `~/.vibe-cli/`. The
`~/.vibe-cli/.env` file stores provider keys and defaults. SQLite-backed
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
