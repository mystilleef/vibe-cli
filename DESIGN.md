# Design

Architecture notes and key constraints not derivable from code alone.

---

## Provider system

Three specs map to three distinct HTTP clients:

### OpenAI

- **Client**: `openai` `npm` SDK
- **Auth header**: `Authorization: Bearer {apiKey}`
- **URL path**: `{baseUrl}/chat/completions`

### Anthropic

- **Client**: raw `fetch`
- **Auth header**: `x-api-key: {apiKey}` or
  `Authorization: Bearer {authToken}`
- **URL path**: `{baseUrl}/v1/messages`

### Gemini

- **Client**: `@google/generative-ai` SDK or `fetch` (for custom
  `baseUrl`)
- **Auth header**: `x-goog-api-key: {apiKey}`
- **URL path**: Uses the SDK default when omitting `baseUrl`, or
  `{baseUrl}/models/{model}:generateContent` when providing a custom
  `baseUrl`

### Gemini custom endpoint caveat

`@google/generative-ai` hardcodes `/v1beta/` in all URL paths —
incompatible with proxies that use `/v1/`. When `baseUrl` appears in a
`gemini` provider entry, `callGemini` in `provider.ts` bypasses the SDK
and calls `fetch` directly:

```
{baseUrl}/models/{model}:generateContent
```

Changing this path or removing the `baseUrl` branch breaks all
non-Google Gemini proxies.

---

## Endpoint architecture for `OpenCode.ai`

OpenCode offers two services with separate API keys
(`OPENCODE_API_KEY`):

### Zen (`https://opencode.ai/zen`)

Premium, curated models. Full endpoint reference:
`https://opencode.ai/docs/zen/`

| Model family                    | Spec        | `baseUrl` |
| ------------------------------- | ----------- | --------- |
| `Claude`                        | `anthropic` | [zen]     |
| `GPT` / `OpenAI`-compatible     | `openai`    | [zen-v1]  |
| `Gemini`                        | `gemini`    | [zen-v1]  |
| `DeepSeek`, `Kimi`, `GLM`, etc. | `openai`    | [zen-v1]  |

### Go (`https://opencode.ai/zen/go`)

Low-cost subscription for open models. Full reference:
`https://opencode.ai/docs/go/`

| Model family                            | Spec        | `baseUrl` |
| --------------------------------------- | ----------- | --------- |
| `Qwen`, `MiniMax` (`Anthropic`-format)  | `anthropic` | [go]      |
| `Kimi`, `GLM`, `DeepSeek`, `MiMo`, etc. | `openai`    | [go-v1]   |

### Model ID format

OpenCode model IDs use **hyphens only** — no dots. Examples:

- `claude-sonnet-4-6` ✓ — `claude-sonnet-4.6` ✗
- `claude-opus-4-8` ✓ — `claude-opus-4.8` ✗

A mismatched model ID returns `401` from the zen endpoint (not `404`).

---

## Settings resolution

Settings file: `~/.vibe-cli/settings.json`. The system validates the
settings schema on load — see `src/utils/settings.ts`. The `gemini` spec
with no `baseUrl` requires no `baseUrl` field. Adding one activates the
custom-fetch path.

`openai` spec **requires** `baseUrl`. `anthropic` and `gemini` treat it
as optional.

---

## Key source files

- **`src/utils/provider.ts`**: Dispatches specs and handles proxy Gemini
  via `callGeminiCustomEndpoint`.
- **`src/utils/anthropic.ts`**: Constructs Anthropic headers and maps
  errors.
- **`src/utils/settings.ts`**: Loads and validates settings, and
  resolves providers.
- **`src/utils/llm.ts`**: Manages gate logic, prompt templates, and
  provider orchestration.
- **`settings.example.json`**: Provides the canonical provider
  configuration reference.

[zen]: https://opencode.ai/zen
[zen-v1]: https://opencode.ai/zen/v1
[go]: https://opencode.ai/zen/go
[go-v1]: https://opencode.ai/zen/go/v1
