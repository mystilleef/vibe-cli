/** Default provider configurations shared across test files. */
const DEFAULT_PROVIDERS = [
  {
    name: "gemini",
    spec: "gemini",
    envVar: "GEMINI_API_KEY",
    defaultModel: "gemini-default",
  },
  {
    name: "openai",
    spec: "openai",
    envVar: "OPENAI_API_KEY",
    baseUrl: "https://api.openai.com/v1",
    defaultModel: "gpt-default",
  },
  {
    name: "openrouter",
    spec: "openai",
    envVar: "OPENROUTER_API_KEY",
    baseUrl: "https://openrouter.ai/api/v1",
  },
  {
    name: "custom-openai",
    spec: "openai",
    envVar: "CUSTOM_OPENAI_KEY",
    baseUrl: "https://custom.example/v1",
    defaultModel: "custom-default",
  },
  {
    name: "anthropic",
    spec: "anthropic",
    envVar: "ANTHROPIC_API_KEY",
    defaultModel: "claude-default",
  },
] as const;

/**
 * Build a settings object for test fixtures.
 *
 * Overrides are spread at the top level; `providers` defaults to a standard
 * set covering gemini, openai, openrouter, custom-openai, and anthropic.
 */
export function mockSettings(overrides: Record<string, unknown> = {}) {
  return {
    provider: "gemini",
    providers: [...DEFAULT_PROVIDERS],
    ...overrides,
  };
}
