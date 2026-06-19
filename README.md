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
- Supported provider credentials (for example, Gemini, OpenAI,
  Anthropic)

## Installation

1. **Install and build**:
   ```sh
   make install
   make
   ```
2. **Configure settings**:
   ```sh
   mkdir -p ~/.vibe-cli
   cp settings.example.json ~/.vibe-cli/settings.json
   ```
   Edit `~/.vibe-cli/settings.json` to configure providers and models.
3. **Set environment secrets**:
   ```sh
   export GEMINI_API_KEY=<key>
   ```
4. **Choose an installation method**:
   - **Local Link**:
     ```sh
     bun link
     ```
     (Requires `~/.cache/.bun/cache` or `~/.bun/bin` in `PATH`)
   - **Direct Copy**:
     ```sh
     mkdir -p ~/.local/bin
     cp dist/vibe ~/.local/bin/vibe
     ```
     (Add `~/.local/bin` to `PATH` when needed)

## Agent skills

Bundled agent skills live in `skills/`:

- `vibe-check`: Oversees risky, ambiguous, irreversible, or multi-step
  work.
- `vibe-constitution`: Manages persistent rules to guide future checks.
- `vibe-learn`: Records reusable mistake, preference, and success
  lessons.

Install skills to the default agent harness directory:

```sh
mkdir -p ~/.agents/skills
cp -R skills/* ~/.agents/skills/
```

For custom configurations, copy `skills/*` to the appropriate skills
directory.

## Development

Run development commands:

```sh
bun dev --help
bun check
bun verify
```

Available development scripts:

<!-- prettier-ignore-start -->
| Command | Action |
| --- | --- |
| `bun dev` | Runs `src/cli.ts` directly. |
| `bun check` | Performs Biome verification and TypeScript type-checking. |
| `bun coverage` | Runs tests and outputs coverage statistics. |
| `bun build` | Compiles the binary to `dist/vibe`. |
| `bun verify` | Executes formatting, linting, type-checking, builds, and tests. |
<!-- prettier-ignore-end -->

The `Makefile` mirrors these commands via standard targets (`install`,
`check`, `coverage`, `verify`).

## Configuration

The CLI reads provider configuration from `~/.vibe-cli/settings.json`.

### Provider and model resolution

#### Provider resolution order

1. `--provider` argument matching a `providers[].name` entry.
2. Top-level `provider` defined in `settings.json`.

#### Model resolution order

1. `--model` argument.
2. Top-level `model` defined in `settings.json`.
3. Selected provider's `defaultModel`.

### Provider settings

Each provider entry requires:

- `name`
- `spec` (`openai`, `anthropic`, or `gemini`)
- `envVar` (Environment variable holding the API key)

OpenAI-compatible endpoints also require `baseUrl`.

#### Provider notes

- **OpenRouter**: Omit `defaultModel` in settings. Pass `--model` or
  specify top-level `model`.
- **DashScope (Qwen)**: Set `envVar` to `"DASHSCOPE_API_KEY"`; configure
  `baseUrl` for OpenAI compatibility.
- **Anthropic**: Supports API keys (`envVar`), bearer-tokens
  (`authTokenEnvVar`), `baseUrl`, and `apiVersion`. API keys take
  precedence.

### Environment variables

<!-- prettier-ignore-start -->
| Variable | Target Provider/Usage |
| --- | --- |
| `GEMINI_API_KEY` | Gemini |
| `OPENAI_API_KEY` | OpenAI |
| `OPENROUTER_API_KEY` | OpenRouter |
| `ANTHROPIC_API_KEY` | Anthropic API Key |
| `ANTHROPIC_AUTH_TOKEN` | Anthropic Bearer Token |
| `DEEPSEEK_API_KEY` | DeepSeek |
| `OPENCODE_API_KEY` | OpenCode |
| `MIMO_API_KEY` | `Mimo` |
| `DASHSCOPE_API_KEY` | DashScope |
<!-- prettier-ignore-end -->

## Usage

Commands output JSON to `stdout`. Errors print `{"error":"message"}` to
`stderr` and exit with code `1`.

### Check a plan

```sh
vibe check \
  --goal "Update documentation" \
  --plan "Inspect code, update README, run verification" \
  --context "Repository maintenance task"
```

Blocks unsafe plans with exit code `2`. Returns the reviewed plan.

Options:

- `--progress <text>`: Work completed so far.
- `--uncertainty <text>`: Concerns or unknowns (repeatable).
- `--prompt <text>`: Original user prompt.
- `--max-attempts <n>`: Refinement loop limit (defaults to `10`).
- `--provider <name>`: Provider override.
- `--model <name>`: Model override.

### Record a lesson

```sh
vibe learn \
  --type success \
  --category "Documentation" \
  --mistake "Inspect code before writing public docs." \
  --solution "Use source and tests as the documentation authority."
```

Accepts types: `mistake`, `preference`, `success`. `mistake` and
`success` require `--solution`.

### Manage constitution rules

```sh
vibe constitution set --rule "Ask before destructive changes."
vibe constitution get
vibe constitution reset --rule "Keep responses concise."
```

Feeds session-specific rules to future vibe checks.

### Inspect session

```sh
vibe session
```

### Verify connectivity

```sh
vibe verify --provider gemini --model gemini-2.5-flash
```

### Emit integration schema

```sh
vibe schema
```

Outputs command structures, options, and exit codes.

### Run demo

```sh
vibe demo
```

## Storage

Configuration and SQLite state persist under `~/.vibe-cli/`.

The SQLite database stores:

- `autosessions` (keyed by working directory; expire after 4 hours of
  inactivity)
- Plan check interaction history
- Recorded lessons (`learn`)
- Active constitution rules (capped at 50 rules per session)

The CLI ignores legacy `~/.vibe-cli/.env` settings and emits deprecation
warnings if found.

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

Run verification before committing changes:

```sh
bun verify
```
