# vibe-check-cli — Session Notes

## What this is

A CLI rewrite of the abandoned `vibe-check-mcp-server` (final release v2.8.0).
Strips the MCP/HTTP/express layer entirely and exposes the same core logic as a
pure flag-driven CLI with JSON I/O.

Project location: `/home/lateef/Projects/vibe-check-cli/`
Original MCP server: `/home/lateef/Projects/vibe-check-mcp-server/`

## How it works

An agent runs a shell command with its current goal and plan as flags. The CLI
packages that into a prompt, calls a second LLM (the "mentor"), and returns
metacognitive questions as JSON on stdout. The agent reads the questions and
reflects before continuing.

```
Agent → vibe check --goal "..." --plan "..." → second LLM → {"questions": "..."}
```

Only `vibe check` makes API calls. `vibe learn` and `vibe constitution` are
purely local file I/O. `vibe verify` makes a minimal probe call to test
connectivity.

## Commands

| Command | Does |
|---|---|
| `vibe check` | Calls second LLM, returns `{"questions":"..."}` |
| `vibe verify` | Tests LLM connectivity; returns provider, model, latency_ms, response |
| `vibe learn` | Records mistake/preference/success to `~/.vibe-check/vibe-log.json` |
| `vibe constitution set/reset/get` | Manages per-session rules in `~/.vibe-check/constitution.json` |
| `vibe schema` | Emits compact JSON interface description for agent consumption |

### `vibe verify` output

```json
// success
{ "ok": true, "provider": "deepseek", "model": "deepseek-v4-pro", "latency_ms": 312, "response": "..." }

// failure
{ "ok": false, "provider": "deepseek", "model": "deepseek-v4-pro", "error": "DEEPSEEK_API_KEY not set." }
```

Exits 1 on failure — usable as a preflight gate:
```sh
vibe verify && vibe check --goal "..." --plan "..."
```

Flags: `--provider <name>`, `--model <name>`

## I/O contract

- Success → JSON on **stdout**, exit 0
- Error → `{"error": "message"}` on **stderr**, exit 1

## Configuration

**Zero-config** if an API key is already in the shell environment.

**Global config** (one-time, works across all projects):
```sh
mkdir -p ~/.vibe-check
echo "DEEPSEEK_API_KEY=your-key" >> ~/.vibe-check/.env
```

**Active global config** (`~/.vibe-check/.env`):
```
DEFAULT_LLM_PROVIDER=deepseek
DEFAULT_MODEL=deepseek-v4-pro
```

**Provider auto-detection order** (when `DEFAULT_LLM_PROVIDER` not set):
1. `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` → anthropic
2. `GEMINI_API_KEY` → gemini
3. `OPENAI_API_KEY` → openai
4. `OPENROUTER_API_KEY` → openrouter
5. `DEEPSEEK_API_KEY` → deepseek
6. `OPENCODE_API_KEY` → opencode

**Default models:**
| Provider | Default model | Notes |
|---|---|---|
| Anthropic | `claude-haiku-4-5-20251001` | |
| Gemini | `gemini-2.5-flash` | |
| OpenAI | `gpt-4o-mini` | |
| OpenRouter | _(required via `--model`)_ | |
| DeepSeek | `deepseek-v4-pro` | Flash: `deepseek-v4-flash` |
| OpenCode | `kimi-k2.6` | Go gateway — overridden by `DEFAULT_MODEL` |

> **DeepSeek deprecation:** `deepseek-chat` and `deepseek-reasoner` are retired
> after **2026-07-24**. Use `deepseek-v4-pro` / `deepseek-v4-flash` instead.

Override via `DEFAULT_MODEL=...` in `~/.vibe-check/.env` or `--model` flag.
`DEFAULT_MODEL` applies globally across all providers — currently set to
`deepseek-v4-pro`, so both `deepseek` and `opencode` resolve to V4 Pro.

## Providers

### DeepSeek

- **Env var:** `DEEPSEEK_API_KEY`
- **Base URL:** `https://api.deepseek.com/v1`
- **Models:** `deepseek-v4-pro` (default), `deepseek-v4-flash`
- **Transport:** OpenAI-compatible `/chat/completions`

### OpenCode (Go gateway)

- **Env var:** `OPENCODE_API_KEY`
- **Base URL:** `https://opencode.ai/zen/go/v1`
- **Subscription:** $5 first month, $10/month
- **Transport:** OpenAI-compatible `/chat/completions`
- **Default model:** `kimi-k2.6` (overridden by global `DEFAULT_MODEL`)

Available models:

| Model | ID | Notes |
|---|---|---|
| DeepSeek V4 Pro | `deepseek-v4-pro` | Best latency in testing (~7s) |
| DeepSeek V4 Flash | `deepseek-v4-flash` | |
| Kimi K2.6 | `kimi-k2.6` | Slow (~41s), leaks prompt |
| Kimi K2.5 | `kimi-k2.5` | |
| GLM-5.1 | `glm-5.1` | |
| GLM-5 | `glm-5` | |
| Qwen3.6 Plus | `qwen3.6-plus` | Slow (~39s), leaks prompt |
| Qwen3.5 Plus | `qwen3.5-plus` | |
| MiMo-V2.5-Pro | `mimo-v2.5-pro` | |
| MiMo-V2.5 | `mimo-v2.5` | |

## Implementation notes

- **`callOpenAICompat`** (`src/utils/llm.ts`) — shared helper used by DeepSeek,
  OpenCode, and OpenRouter. Takes `{ baseURL, apiKey, model, prompt }`, reuses
  the `openai` npm package with a custom `baseURL`. No new dependencies needed.
- DeepSeek and OpenCode were added without adding any npm packages.

## Key differences from MCP version

| | MCP server | CLI |
|---|---|---|
| Runtime deps | 10 | 3 (`@google/generative-ai`, `openai`, `commander`) |
| `axios` | yes | dropped — native `fetch` |
| `dotenv` | yes | dropped — Bun loads `.env` natively |
| Transport layer | MCP + express + HTTP | none |
| Constitution storage | in-memory (lost on exit) | file-persisted |
| Provider selection | hardcoded `gemini` fallback | 6 providers, auto-detects from env |
| Default model | `gemini-2.5-pro` | cheap/fast per provider |
| Build output | multi-file `build/` | single `dist/cli.js` (178KB) |

## Build & dev

```sh
bun install          # install deps
bun run dev          # run without building: bun run src/cli.ts <command>
bun run build        # bundle to dist/cli.js
bun run typecheck    # tsc --noEmit
```

## What's not done yet

- `bun link` / global install instructions
- Tests
- The `vibe schema` output doesn't yet surface the global config path
