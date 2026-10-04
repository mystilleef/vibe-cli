import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { TempHomeContext } from "./tempHome";

/** Anthropic messages request fields observed by test fetch mocks. */
export interface AnthropicBody {
  model?: string;
  messages?: Array<{ role?: string; content?: string }>;
  system?: string;
}

/**
 * Point provider environment at the Anthropic adapter.
 *
 * `defaultModel` becomes `DEFAULT_MODEL`; each caller chooses the value its
 * tool under test resolves.
 */
export function configureAnthropicEnv(defaultModel: string): void {
  process.env["ANTHROPIC_API_KEY"] = "test-key";
  process.env["DEFAULT_LLM_PROVIDER"] = "anthropic";
  process.env["DEFAULT_MODEL"] = defaultModel;
}

/**
 * Anthropic response text carrying a gate verdict for mock response queues.
 */
export function gateDecision(
  proceed: boolean,
  confidence: number,
  reason: string,
): string {
  return JSON.stringify({ proceed, confidence, reason });
}

/**
 * Write a single-provider Anthropic settings file into a temp home.
 *
 * `defaultModel` becomes the provider entry's default model, independent of
 * the environment override.
 */
export async function writeAnthropicSettings(
  home: TempHomeContext,
  defaultModel: string,
): Promise<void> {
  await mkdir(home.dataRoot, { recursive: true });
  await writeFile(
    join(home.dataRoot, "settings.json"),
    JSON.stringify({
      provider: "anthropic",
      useLearningHistory: false,
      providers: [
        {
          name: "anthropic",
          spec: "anthropic",
          envVar: "ANTHROPIC_API_KEY",
          defaultModel,
        },
      ],
    }),
  );
}
