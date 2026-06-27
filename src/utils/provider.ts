/**
 * Provider resolution and dispatch for LLM calls.
 *
 * Handles loading settings, resolving credentials, and dispatching to
 * provider-specific implementations (OpenAI, Anthropic, Gemini).
 */
import type { GoogleGenAI } from "@google/genai";
import { callAnthropic } from "./anthropic.js";
import {
  isThinkingActive,
  loadProviderSettings,
  mapThinkingLevel,
  normalizeBaseUrl,
  type ProviderSettingsEntry,
  resolveProviderEntry,
  type ThinkingLevel,
} from "./settings.js";

/** Lazily-initialized Gemini client scoped to the latest call-time API key. */
let genAI: GoogleGenAI | null = null;
let genAIKey: string | null = null;

export interface ResolvedProviderCredentials {
  apiKey?: string;
  authToken?: string;
}

export interface ResolvedProviderAndModel {
  provider: ProviderSettingsEntry;
  model: string;
  credentials: ResolvedProviderCredentials;
}

export function resolveProviderAndModel(modelOverride?: {
  provider?: string;
  model?: string;
}): ResolvedProviderAndModel {
  const settings = loadProviderSettings();
  const provider = resolveProviderEntry(settings, modelOverride?.provider);
  const model =
    modelOverride?.model ?? settings.model ?? provider.defaultModel ?? "";

  if (!model) {
    throw new Error(`--model is required with provider ${provider.name}.`);
  }

  const apiKey = process.env[provider.envVar];
  if (provider.spec !== "anthropic") {
    if (!apiKey) {
      throw new Error(`${provider.envVar} is not set in the environment`);
    }
    return { provider, model, credentials: { apiKey } };
  }

  const authToken = provider.authTokenEnvVar
    ? process.env[provider.authTokenEnvVar]
    : undefined;
  if (!apiKey && !authToken) {
    const authMessage = provider.authTokenEnvVar
      ? `${provider.envVar} or ${provider.authTokenEnvVar}`
      : provider.envVar;
    throw new Error(`${authMessage} is not set in the environment`);
  }

  return {
    provider,
    model,
    credentials: {
      ...(apiKey !== undefined && { apiKey }),
      ...(authToken !== undefined && { authToken }),
    },
  };
}

async function ensureGemini(apiKey: string) {
  if (!genAI || genAIKey !== apiKey) {
    const { GoogleGenAI } = await import("@google/genai");
    genAI = new GoogleGenAI({ apiKey });
    genAIKey = apiKey;
  }
}

interface GeminiEndpointOptions {
  apiKey: string;
  model: string;
  systemPrompt: string;
  userContent: string;
  temperature: number | undefined;
  baseUrl: string;
  thinking?: ThinkingLevel | undefined;
}

async function callGeminiCustomEndpoint({
  apiKey,
  model,
  systemPrompt,
  userContent,
  temperature,
  baseUrl,
  thinking,
}: GeminiEndpointOptions): Promise<string> {
  const url = `${normalizeBaseUrl(baseUrl)}/models/${model}:generateContent`;
  const genConfig: Record<string, unknown> = {
    ...(temperature !== undefined && { temperature }),
    ...buildGeminiThinkingConfig(thinking),
  };
  const body = {
    contents: [{ role: "user", parts: [{ text: userContent }] }],
    systemInstruction: { parts: [{ text: systemPrompt }] },
    ...(Object.keys(genConfig).length > 0 && { generationConfig: genConfig }),
  };
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", "x-goog-api-key": apiKey },
    body: JSON.stringify(body),
  });
  const raw = await response.text();
  if (!response.ok) {
    throw new Error(`Gemini error ${response.status}: ${raw.trim()}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Gemini returned non-JSON response: ${raw.trim()}`);
  }
  const text =
    (parsed as { candidates?: { content?: { parts?: { text?: string }[] } }[] })
      ?.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
  return text;
}

async function callGemini(
  apiKey: string,
  model: string,
  systemPrompt: string,
  userContent: string,
  temperature?: number,
  baseUrl?: string,
  thinking?: ThinkingLevel,
): Promise<string> {
  // Custom endpoints (e.g. opencode.ai) use /v1/models/{model}:generateContent,
  // not the /v1beta/ path hardcoded in @google/genai.
  if (baseUrl !== undefined) {
    return callGeminiCustomEndpoint({
      apiKey,
      model,
      systemPrompt,
      userContent,
      temperature,
      baseUrl,
      thinking,
    });
  }
  await ensureGemini(apiKey);
  if (!genAI) throw new Error("Gemini client unavailable.");
  const config: Record<string, unknown> = {
    systemInstruction: { parts: [{ text: systemPrompt }] },
    ...(temperature !== undefined && { temperature }),
    ...buildGeminiThinkingConfig(thinking),
  };
  const response = await genAI.models.generateContent({
    model,
    contents: [{ role: "user", parts: [{ text: userContent }] }],
    config,
  });
  return response.text ?? "";
}

function resolveProviderTemperature(
  providerTemperature: number | null | undefined,
  defaultTemperature: number,
): number | undefined {
  return providerTemperature === null
    ? undefined
    : (providerTemperature ?? defaultTemperature);
}

function requireApiKey(credentials: ResolvedProviderCredentials): string {
  if (!credentials.apiKey) {
    throw new Error("Resolved provider API key is unavailable.");
  }
  return credentials.apiKey;
}

/** Build Gemini thinking config when thinking is active. */
function buildGeminiThinkingConfig(
  thinking: ThinkingLevel | undefined,
):
  | { thinkingConfig: { thinkingLevel: "low" | "medium" | "high" } }
  | undefined {
  if (!isThinkingActive(thinking)) return undefined;
  return { thinkingConfig: { thinkingLevel: mapThinkingLevel(thinking) } };
}

/** Detect o-series models (`^o\\d`) that reject `temperature` and `max_tokens`. */
function isOModel(model: string): boolean {
  return /^o\d/.test(model);
}

interface OpenAICompatOptions {
  baseURL: string;
  apiKey: string;
  model: string;
  systemPrompt: string;
  userContent: string;
  temperature?: number;
  thinking?: ThinkingLevel;
  maxTokens?: number;
}

async function callOpenAICompat({
  baseURL,
  apiKey,
  model,
  systemPrompt,
  userContent,
  temperature,
  thinking,
  maxTokens,
}: OpenAICompatOptions): Promise<string> {
  const { OpenAI } = await import("openai");
  const client = new OpenAI({ apiKey, baseURL: normalizeBaseUrl(baseURL) });
  const oModel = isOModel(model);
  const tokenParam = oModel ? "max_completion_tokens" : "max_tokens";
  const response = await client.chat.completions.create({
    model,
    messages: [
      { role: "system" as const, content: systemPrompt },
      { role: "user" as const, content: userContent },
    ],
    ...(!oModel && temperature !== undefined && { temperature }),
    ...(maxTokens !== undefined && { [tokenParam]: maxTokens }),
    ...(isThinkingActive(thinking) && {
      reasoning_effort: mapThinkingLevel(thinking),
    }),
  });
  return response.choices[0]?.message.content || "";
}

/**
 * Dispatch an LLM call to the resolved provider.
 *
 * Passes system and user prompts as distinct arguments to every provider.
 * Throws on unknown protocol specs.
 */
export async function callProvider(
  provider: ProviderSettingsEntry,
  credentials: ResolvedProviderCredentials,
  model: string,
  systemPrompt: string,
  userContent: string,
  temperature = 0.1,
  maxTokens?: number,
): Promise<string> {
  const resolvedTemp = resolveProviderTemperature(
    provider.temperature,
    temperature,
  );

  const spec = provider.spec;

  if (spec === "openai") {
    return callOpenAICompat({
      baseURL: provider.baseUrl ?? "",
      apiKey: requireApiKey(credentials),
      model,
      systemPrompt,
      userContent,
      ...(resolvedTemp !== undefined && { temperature: resolvedTemp }),
      ...(provider.thinking !== undefined && { thinking: provider.thinking }),
      ...(maxTokens !== undefined && { maxTokens }),
    });
  }

  if (spec === "anthropic") {
    return callAnthropic({
      model,
      systemPrompt,
      compiledPrompt: userContent,
      ...(resolvedTemp !== undefined && { temperature: resolvedTemp }),
      ...(provider.baseUrl !== undefined && { baseUrl: provider.baseUrl }),
      ...(provider.apiVersion !== undefined && {
        version: provider.apiVersion,
      }),
      ...(credentials.apiKey !== undefined && { apiKey: credentials.apiKey }),
      ...(credentials.authToken !== undefined && {
        authToken: credentials.authToken,
      }),
      ...(provider.thinking !== undefined && { thinking: provider.thinking }),
    });
  }

  if (spec === "gemini") {
    return callGemini(
      requireApiKey(credentials),
      model,
      systemPrompt,
      userContent,
      resolvedTemp,
      provider.baseUrl,
      provider.thinking,
    );
  }

  throw new Error(
    `Unknown spec '${spec}'. Valid values: openai, anthropic, gemini`,
  );
}
