import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { TempHomeContext } from "./tempHome";

/** Default provider configurations shared across test files. */
const DEFAULT_PROVIDERS = [
  {
    name: "gemini",
    spec: "gemini",
    envVar: "GEMINI_API_KEY",
    defaultModel: "gemini-default",
    thinking: "low",
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

/** Deepseek provider entry shared by provider-dependent command fixtures. */
export const DEEPSEEK_PROVIDER = {
  name: "deepseek",
  spec: "openai",
  envVar: "DEEPSEEK_API_KEY",
  baseUrl: "https://api.deepseek.com/v1",
  defaultModel: "deepseek-v4-pro",
} as const;

/**
 * Build a settings object for test fixtures.
 *
 * Overrides are spread at the top level; `providers` defaults to a standard
 * set covering gemini, openai, openrouter, custom-openai, and anthropic.
 */
export function mockSettings(overrides: Record<string, unknown> = {}) {
  return {
    provider: "gemini",
    useLearningHistory: false,
    providers: [...DEFAULT_PROVIDERS],
    ...overrides,
  };
}

/**
 * Minimal single-provider deepseek settings for commands that only need
 * one resolvable provider.
 */
export function deepseekSettings() {
  return { provider: "deepseek", providers: [DEEPSEEK_PROVIDER] };
}

/** Write settings JSON to a temp home data root. */
export async function writeSettings(
  tempHome: TempHomeContext,
  value: unknown,
): Promise<void> {
  await mkdir(tempHome.dataRoot, { recursive: true });
  await writeFile(
    join(tempHome.dataRoot, "settings.json"),
    typeof value === "string" ? value : JSON.stringify(value, null, 2),
  );
}
