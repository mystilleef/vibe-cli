# vibe-cli

`Metacognitive` AI agent oversight—pure CLI with `JSON` I/O.

## Project overview

`vibe-cli` provides a framework for AI agents to perform self-reflection
and receive oversight. It enables agents to check plans, record learning
patterns, and adhere to session-specific behavioral rules.

- **Purpose**: Oversight and `metacognition` for AI agents.
- **Architecture**: TypeScript-based CLI using Bun runtime.
- **Core Components**:
  - `src/cli.ts`: Entry point and command definitions.
  - `src/tools/`: Logic for vibe checks, learning, and constitutions.
  - `src/utils/`: **LLM** integrations, state management, and storage.

## Technologies

- **Runtime**: [Bun](https://bun.sh/)
- **Language**: TypeScript
- **CLI Framework**: [Commander](https://github.com/tj/commander.js)
- **Linting/Formatting**: [Biome](https://biomejs.dev/)
- **`LLM` Integration**: Google Generative AI, OpenAI, Anthropic,
  OpenRouter.

## Building and running

**CRITICAL!**: agents should call `bun verify` after changes to the
project.

### Key commands

- `bun install`: Install project dependencies.
- `bun run build`: Compile TypeScript to `dist/cli.js` and set
  executable permissions.
- `bun dev`: Run the CLI directly from source.
- `bun verify`: Execute full verification suite (lint, type-check,
  build, tests).
- `bun coverage`: Run tests and generate coverage reports.
- `bun check`: Run non-mutating lint and type-checks.
- `bun fix`: Apply automated lint and formatting fixes.

### CLI usage

- `vibe check --goal <text> --plan <text>`: Perform a `metacognitive`
  vibe check.
- `vibe learn --mistake <text> --category <text>`: Record a mistake or
  success pattern.
- `vibe constitution set --rule <text>`: Define session-specific
  behavioral rules.
- `vibe session`: Retrieve the active `autosession` ID.
- `vibe verify`: Test `LLM` connectivity and configuration.
- `vibe schema`: Output JSON schema for agent integration.

## Development conventions

- **JSON I/O**: All CLI commands emit JSON to `stdout` for programmatic
  consumption.
- **Environment**: Configuration resides in `~/.vibe-cli/.env`.
- **Type Safety**: Strict TypeScript usage with `tsconfig.json`
  enforcement.
- **Code Quality**: Biome handles linting and formatting; `bun verify`
  must pass before contributions.
- **Testing**: Tests located in `tests/` directory; run via `bun test`.
