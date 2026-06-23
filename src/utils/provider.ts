/**
 * Provider resolution and dispatch for LLM calls.
 *
 * Handles loading settings, resolving credentials, and dispatching to
 * provider-specific implementations (OpenAI, Anthropic, Gemini).
 */
import type { GoogleGenerativeAI } from "@google/generative-ai";
import { callAnthropic } from "./anthropic.js";
import {
  loadProviderSettings,
  type ProviderSettingsEntry,
  resolveProviderEntry,
} from "./settings.js";

/** Lazily-initialized Gemini client scoped to the latest call-time API key. */
let genAI: GoogleGenerativeAI | null = null;
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
    const { GoogleGenerativeAI } = await import("@google/generative-ai");
    genAI = new GoogleGenerativeAI(apiKey);
    genAIKey = apiKey;
  }
}

async function callGeminiCustomEndpoint(
  apiKey: string,
  model: string,
  systemPrompt: string,
  userContent: string,
  temperature: number | undefined,
  baseUrl: string,
): Promise<string> {
  const url = `${normalizeBaseUrl(baseUrl)}/models/${model}:generateContent`;
  const body = {
    contents: [{ role: "user", parts: [{ text: userContent }] }],
    systemInstruction: { parts: [{ text: systemPrompt }] },
    generationConfig: {
      ...(temperature !== undefined && { temperature }),
    },
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
): Promise<string> {
  // Custom endpoints (e.g. opencode.ai) use /v1/models/{model}:generateContent,
  // not the /v1beta/ path hardcoded in @google/generative-ai.
  if (baseUrl !== undefined) {
    return callGeminiCustomEndpoint(
      apiKey,
      model,
      systemPrompt,
      userContent,
      temperature,
      baseUrl,
    );
  }
  await ensureGemini(apiKey);
  if (!genAI) throw new Error("Gemini client unavailable.");
  const request = {
    contents: [{ role: "user", parts: [{ text: userContent }] }],
    generationConfig: {
      ...(temperature !== undefined && { temperature }),
    },
  };
  return (
    await genAI
      .getGenerativeModel({ model, systemInstruction: systemPrompt })
      .generateContent(request)
  ).response.text();
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

function requireApiKey(credentials: ResolvedProviderCredentials): string {
  if (!credentials.apiKey) {
    throw new Error("Resolved provider API key is unavailable.");
  }
  return credentials.apiKey;
}

function resolveProviderTemperature(
  providerTemperature: number | null | undefined,
  defaultTemperature: number,
): number | undefined {
  return providerTemperature === null
    ? undefined
    : (providerTemperature ?? defaultTemperature);
}

async function callOpenAICompat({
  baseURL,
  apiKey,
  model,
  systemPrompt,
  userContent,
  temperature,
}: {
  baseURL: string;
  apiKey: string;
  model: string;
  systemPrompt: string;
  userContent: string;
  temperature?: number;
}): Promise<string> {
  const { OpenAI } = await import("openai");
  const client = new OpenAI({ apiKey, baseURL: normalizeBaseUrl(baseURL) });
  const response = await client.chat.completions.create({
    model,
    messages: [
      { role: "system" as const, content: systemPrompt },
      { role: "user" as const, content: userContent },
    ],
    ...(temperature !== undefined && { temperature }),
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
    );
  }

  throw new Error(
    `Unknown spec '${spec}'. Valid values: openai, anthropic, gemini`,
  );
}
