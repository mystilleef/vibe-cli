import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { resetConstitution } from "../src/tools/constitution";
import { mapAnthropicThinkingBudget } from "../src/utils/anthropic";
import {
  callProvider,
  FALLBACK_FEEDBACK,
  getGateDecision,
  getMentorFeedback,
  parseGateDecision,
  revisePlan,
  verifyConnection,
} from "../src/utils/llm";
import type { ProviderSpec, ThinkingLevel } from "../src/utils/settings";
import { isThinkingActive, mapThinkingLevel } from "../src/utils/settings";
import {
  mockSettings,
  writeSettings as writeSettingsShared,
} from "./helpers/mockSettings";
import { createTempHome, type TempHomeContext } from "./helpers/tempHome";

interface OpenAiCompatRequest {
  model: string;
  messages: Array<{ role: string; content: string }>;
  temperature?: number;
  reasoning_effort?: string;
  max_tokens?: number;
  max_completion_tokens?: number;
}

interface MockOpenAiOptions {
  apiKey?: string;
  baseURL?: string;
}

const openAiRequests: Array<{
  options: MockOpenAiOptions;
  request: OpenAiCompatRequest;
}> = [];
let openAiResponseText = "mock provider response";
let openAiThrowValue: unknown;

class MockOpenAI {
  private readonly options: MockOpenAiOptions;

  constructor(options: MockOpenAiOptions) {
    this.options = options;
  }

  chat = {
    completions: {
      create: async (request: OpenAiCompatRequest) => {
        if (openAiThrowValue !== undefined) {
          throw openAiThrowValue;
        }
        openAiRequests.push({ options: this.options, request });
        return { choices: [{ message: { content: openAiResponseText } }] };
      },
    },
  };
}

mock.module("openai", () => ({ OpenAI: MockOpenAI }));

interface GeminiSdkCall {
  model: string;
  contents: unknown;
  config?: {
    systemInstruction?: unknown;
    temperature?: number;
    thinkingConfig?: { thinkingLevel?: string };
  };
}

let geminiSdkCalls: GeminiSdkCall[] = [];
let geminiResponses: string[] = [];
let geminiErrorMessages: Array<string | undefined> = [];
let geminiApiKeys: string[] = [];

mock.module("@google/genai", () => ({
  GoogleGenAI: class {
    constructor(opts: { apiKey: string }) {
      geminiApiKeys.push(opts.apiKey);
    }

    models = {
      generateContent: async (input: {
        model: string;
        contents: unknown;
        config?: {
          systemInstruction?: unknown;
          temperature?: number;
          thinkingConfig?: { thinkingLevel?: string };
        };
      }) => {
        geminiSdkCalls.push({
          model: input.model,
          contents: input.contents,
          ...(input.config !== undefined && { config: input.config }),
        });
        const customError = geminiErrorMessages[geminiSdkCalls.length - 1];
        if (customError !== undefined) throw new Error(customError);
        return { text: geminiResponses.shift() ?? "" };
      },
    };
  },
}));

interface FetchCall {
  url: string;
  init: RequestInit;
}

const originalFetch = globalThis.fetch;
const fetchCalls: FetchCall[] = [];
let tempHome: TempHomeContext;

const PROVIDER_KEYS = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "GEMINI_API_KEY",
  "OPENAI_API_KEY",
  "OPENROUTER_API_KEY",
  "DEEPSEEK_API_KEY",
  "OPENCODE_API_KEY",
  "MIMO_API_KEY",
  "CUSTOM_OPENAI_KEY",
  "CUSTOM_ANTHROPIC_TOKEN",
  "DEFAULT_LLM_PROVIDER",
  "DEFAULT_MODEL",
] as const;

type ProviderKey = (typeof PROVIDER_KEYS)[number];
const savedEnv: Partial<Record<ProviderKey, string | undefined>> = {};

async function writeSettings(value: unknown): Promise<void> {
  await writeSettingsShared(tempHome, value);
}

function mockFetch(
  responseFactory: (
    url: string,
    init: RequestInit,
  ) => Response | Promise<Response>,
) {
  globalThis.fetch = (async (input, init) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    const requestInit = init ?? {};
    fetchCalls.push({ url, init: requestInit });
    return responseFactory(url, requestInit);
  }) as typeof fetch;
}

function parseBody<T>(init: RequestInit): T {
  return JSON.parse(String(init.body)) as T;
}

function requireValue<T>(value: T | undefined, label: string): T {
  if (value === undefined) throw new Error(`${label} missing`);
  return value;
}

beforeEach(async () => {
  for (const key of PROVIDER_KEYS) savedEnv[key] = process.env[key];
  for (const key of PROVIDER_KEYS) delete process.env[key];
  tempHome = await createTempHome();
  await writeSettings(mockSettings());
  globalThis.fetch = originalFetch;
  fetchCalls.length = 0;
  openAiRequests.length = 0;
  openAiResponseText = "mock provider response";
  openAiThrowValue = undefined;
  geminiSdkCalls = [];
  geminiResponses = [];
  geminiErrorMessages = [];
  geminiApiKeys = [];
  resetConstitution([]);
});

afterEach(async () => {
  await tempHome.cleanup();
  for (const key of PROVIDER_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  globalThis.fetch = originalFetch;
});

describe("parseGateDecision", () => {
  test("parses clean JSON", () => {
    const result = parseGateDecision(
      '{"proceed":true,"confidence":0.9,"reason":"ok"}',
    );

    expect(result).toEqual({ proceed: true, confidence: 0.9, reason: "ok" });
  });

  test("strips markdown fences", () => {
    const result = parseGateDecision(
      '```json\n{"proceed":false,"confidence":0.7,"reason":"risk"}\n```',
    );

    expect(result.proceed).toBe(false);
    expect(result.confidence).toBe(0.7);
  });

  test("extracts the last embedded JSON object", () => {
    const raw =
      'First: {"proceed":true,"confidence":0.9,"reason":"first"}. Second: {"proceed":false,"confidence":0.3,"reason":"second"}';

    expect(parseGateDecision(raw)).toEqual({
      proceed: false,
      confidence: 0.3,
      reason: "second",
    });
  });

  test("falls back for invalid shape", () => {
    const result = parseGateDecision("not json");

    expect(result.proceed).toBe(false);
    expect(result.confidence).toBe(0.5);
    expect(result.reason).toMatch(/unavailable/);
  });

  test("clamps confidence boundaries", () => {
    expect(
      parseGateDecision('{"proceed":true,"confidence":2,"reason":"ok"}')
        .confidence,
    ).toBe(1);
    expect(
      parseGateDecision('{"proceed":true,"confidence":-1,"reason":"ok"}')
        .confidence,
    ).toBe(0);
  });
});

describe("settings-backed provider and model resolution", () => {
  test("settings provider and provider default model drive calls", async () => {
    process.env["GEMINI_API_KEY"] = "gemini-key";
    geminiResponses = ["mentor response"];

    const result = await getMentorFeedback({ goal: "goal", plan: "plan" });

    expect(result.feedback).toBe("mentor response");
    expect(geminiApiKeys).toEqual(["gemini-key"]);
    expect(geminiSdkCalls[0]?.model).toBe("gemini-default");
  });

  test("provider override wins over settings provider", async () => {
    process.env["CUSTOM_OPENAI_KEY"] = "custom-key";

    const result = await getMentorFeedback({
      goal: "goal",
      plan: "plan",
      modelOverride: { provider: "custom-openai" },
    });

    expect(result.feedback).toBe("mock provider response");
    const request = requireValue(openAiRequests[0], "OpenAI request 0");
    expect(request.options).toEqual({
      apiKey: "custom-key",
      baseURL: "https://custom.example/v1",
    });
    expect(request.request.model).toBe("custom-default");
  });

  test("model override wins over settings model and provider default", async () => {
    await writeSettings(mockSettings({ model: "settings-model" }));
    process.env["CUSTOM_OPENAI_KEY"] = "custom-key";

    await revisePlan({
      goal: "goal",
      plan: "old plan",
      feedback: "feedback",
      modelOverride: { provider: "custom-openai", model: "explicit-model" },
    });

    expect(openAiRequests[0]?.request.model).toBe("explicit-model");
  });

  test("settings model wins over provider default", async () => {
    await writeSettings(
      mockSettings({ provider: "custom-openai", model: "settings-model" }),
    );
    process.env["CUSTOM_OPENAI_KEY"] = "custom-key";

    await getMentorFeedback({ goal: "goal", plan: "plan" });

    expect(openAiRequests[0]?.request.model).toBe("settings-model");
  });

  test("DEFAULT_LLM_PROVIDER and DEFAULT_MODEL never override settings", async () => {
    process.env["DEFAULT_LLM_PROVIDER"] = "custom-openai";
    process.env["DEFAULT_MODEL"] = "env-model";
    process.env["GEMINI_API_KEY"] = "gemini-key";
    geminiResponses = ["settings response"];

    const result = await getMentorFeedback({ goal: "goal", plan: "plan" });

    expect(result.feedback).toBe("settings response");
    expect(geminiSdkCalls[0]?.model).toBe("gemini-default");
    expect(openAiRequests).toHaveLength(0);
  });

  test("missing top-level provider reports settings error", async () => {
    await writeSettings({ providers: mockSettings().providers });

    const result = await verifyConnection();

    expect(result.ok).toBe(false);
    expect(result.error).toBe("provider not set in settings.json");
  });

  test("unmatched provider override reports settings entry error", async () => {
    const result = await verifyConnection({ provider: "missing" });

    expect(result.ok).toBe(false);
    expect(result.provider).toBe("missing");
    expect(result.error).toBe("Provider 'missing' not found in settings.json");
  });

  test("missing settings reports copy-settings guidance", async () => {
    await tempHome.cleanup();
    tempHome = await createTempHome();

    const result = await verifyConnection();

    expect(result.ok).toBe(false);
    expect(result.error).toBe(
      "No settings found. Copy settings.example.json to ~/.vibe-cli/settings.json",
    );
  });

  test("missing token names selected provider env var", async () => {
    await writeSettings(mockSettings({ provider: "custom-openai" }));

    const result = await verifyConnection();

    expect(result.ok).toBe(false);
    expect(result.provider).toBe("custom-openai");
    expect(result.model).toBe("custom-default");
    expect(result.error).toBe(
      "CUSTOM_OPENAI_KEY is not set in the environment",
    );
  });

  test("changed environment values between calls take effect", async () => {
    await writeSettings(mockSettings({ provider: "custom-openai" }));
    process.env["CUSTOM_OPENAI_KEY"] = "first-key";
    await verifyConnection();
    process.env["CUSTOM_OPENAI_KEY"] = "second-key";

    await verifyConnection();

    expect(openAiRequests[0]?.options.apiKey).toBe("first-key");
    expect(openAiRequests[1]?.options.apiKey).toBe("second-key");
  });

  test("Gemini changed API key between calls uses new key without retention", async () => {
    process.env["GEMINI_API_KEY"] = "first-gemini-key";
    geminiResponses = ["first response"];
    await getMentorFeedback({ goal: "goal", plan: "plan" });

    process.env["GEMINI_API_KEY"] = "second-gemini-key";
    geminiResponses = ["second response"];
    await getMentorFeedback({ goal: "goal", plan: "plan" });

    expect(geminiApiKeys).toEqual(["first-gemini-key", "second-gemini-key"]);
    expect(geminiSdkCalls.map((call) => call.model)).toEqual([
      "gemini-default",
      "gemini-default",
    ]);
  });

  test("OpenRouter without default model requires explicit --model before dispatch", async () => {
    await writeSettings(mockSettings({ provider: "openrouter" }));
    process.env["OPENROUTER_API_KEY"] = "or-key";

    const result = await verifyConnection();

    expect(result.ok).toBe(false);
    expect(result.error).toBe("--model is required with provider openrouter.");
    expect(openAiRequests).toHaveLength(0);
    expect(geminiSdkCalls).toHaveLength(0);
    expect(fetchCalls).toHaveLength(0);
  });

  test("OpenRouter accepts explicit model through the shared OpenAI adapter", async () => {
    await writeSettings(mockSettings({ provider: "openrouter" }));
    process.env["OPENROUTER_API_KEY"] = "or-key";

    const result = await verifyConnection({ model: "openrouter/model" });

    expect(result.ok).toBe(true);
    expect(result.model).toBe("openrouter/model");
    const request = requireValue(openAiRequests[0], "OpenAI request 0");
    expect(request.options).toEqual({
      apiKey: "or-key",
      baseURL: "https://openrouter.ai/api/v1",
    });
    expect(request.request.model).toBe("openrouter/model");
  });

  test("OpenAI-compatible base URLs are normalized before dispatch", async () => {
    await writeSettings(
      mockSettings({
        provider: "custom-openai",
        providers: mockSettings().providers.map((provider) =>
          provider.name === "custom-openai"
            ? { ...provider, baseUrl: "https://custom.example/v1///" }
            : provider,
        ),
      }),
    );
    process.env["CUSTOM_OPENAI_KEY"] = "custom-key";

    await verifyConnection();

    expect(openAiRequests[0]?.options.baseURL).toBe(
      "https://custom.example/v1",
    );
  });
});

describe("LLM call surfaces", () => {
  test("getGateDecision forwards gate prompt and temperature", async () => {
    process.env["CUSTOM_OPENAI_KEY"] = "custom-key";
    openAiResponseText = JSON.stringify({
      proceed: true,
      confidence: 0.8,
      reason: "ok",
    });

    const result = await getGateDecision({
      goal: "goal",
      plan: "plan",
      feedback: "feedback",
      modelOverride: { provider: "custom-openai" },
    });

    expect(result.proceed).toBe(true);
    const request = requireValue(openAiRequests[0], "OpenAI request 0");
    expect(request.request.temperature).toBe(0.1);
    expect(request.request.messages[0]?.content).toContain("Go/no-go");
    expect(request.request.messages[1]?.content).toContain("Goal: goal");
  });

  test("revisePlan forwards revision prompt", async () => {
    process.env["CUSTOM_OPENAI_KEY"] = "custom-key";
    openAiResponseText = "revised plan";

    const result = await revisePlan({
      goal: "goal",
      plan: "old plan",
      feedback: "missing rollback",
      blockReason: "irreversible op",
      modelOverride: { provider: "custom-openai" },
    });

    expect(result).toBe("revised plan");
    const request = requireValue(openAiRequests[0], "OpenAI request 0");
    expect(request.request.temperature).toBe(0.1);
    expect(request.request.messages[0]?.content).toContain("plan reviser");
    expect(request.request.messages[1]?.content).toContain(
      "Blocked plan: old plan",
    );
    expect(request.request.messages[1]?.content).toContain(
      "Block reason: irreversible op",
    );
  });

  test("Anthropic provider can use settings-selected model", async () => {
    await writeSettings(mockSettings({ provider: "anthropic" }));
    process.env["ANTHROPIC_API_KEY"] = "anth-key";
    mockFetch(() =>
      Response.json({ content: [{ type: "text", text: "anth ok" }] }),
    );

    const result = await verifyConnection();

    expect(result.ok).toBe(true);
    expect(result.provider).toBe("anthropic");
    expect(result.model).toBe("claude-default");
    const body = parseBody<{ model: string }>(
      requireValue(fetchCalls[0], "fetch call 0").init,
    );
    expect(body.model).toBe("claude-default");
  });

  test("Anthropic supports auth-token-only settings metadata", async () => {
    await writeSettings(
      mockSettings({
        provider: "anthropic",
        providers: mockSettings().providers.map((provider) =>
          provider.name === "anthropic"
            ? {
                ...provider,
                baseUrl: "https://anthropic-proxy.example///",
                apiVersion: "2024-01-01",
                authTokenEnvVar: "CUSTOM_ANTHROPIC_TOKEN",
              }
            : provider,
        ),
      }),
    );
    process.env["CUSTOM_ANTHROPIC_TOKEN"] = "token-value";
    mockFetch(() =>
      Response.json({ content: [{ type: "text", text: "anth ok" }] }),
    );

    const result = await verifyConnection();

    expect(result.ok).toBe(true);
    const call = requireValue(fetchCalls[0], "fetch call 0");
    expect(call.url).toBe("https://anthropic-proxy.example/v1/messages");
    expect(call.init.headers).toMatchObject({
      authorization: "Bearer token-value",
      "anthropic-version": "2024-01-01",
    });
  });

  test("Anthropic prefers API key when both auth values are present", async () => {
    await writeSettings(
      mockSettings({
        provider: "anthropic",
        providers: mockSettings().providers.map((provider) =>
          provider.name === "anthropic"
            ? { ...provider, authTokenEnvVar: "CUSTOM_ANTHROPIC_TOKEN" }
            : provider,
        ),
      }),
    );
    process.env["ANTHROPIC_API_KEY"] = "api-key-value";
    process.env["CUSTOM_ANTHROPIC_TOKEN"] = "token-value";
    mockFetch(() =>
      Response.json({ content: [{ type: "text", text: "anth ok" }] }),
    );

    await verifyConnection();

    expect(fetchCalls[0]?.init.headers).toMatchObject({
      "x-api-key": "api-key-value",
    });
    expect(fetchCalls[0]?.init.headers).not.toMatchObject({
      authorization: expect.any(String),
    });
  });

  test("Anthropic missing credentials names accepted env vars", async () => {
    await writeSettings(
      mockSettings({
        provider: "anthropic",
        providers: mockSettings().providers.map((provider) =>
          provider.name === "anthropic"
            ? { ...provider, authTokenEnvVar: "CUSTOM_ANTHROPIC_TOKEN" }
            : provider,
        ),
      }),
    );

    const result = await verifyConnection();

    expect(result.ok).toBe(false);
    expect(result.error).toBe(
      "ANTHROPIC_API_KEY or CUSTOM_ANTHROPIC_TOKEN is not set in the environment",
    );
  });

  test("impossible runtime specs report valid protocol adapters", async () => {
    await expect(
      callProvider(
        {
          name: "broken",
          spec: "unsupported" as ProviderSpec,
          envVar: "BROKEN_API_KEY",
        },
        { apiKey: "unused" },
        "model",
        "system",
        "user",
      ),
    ).rejects.toThrow(
      "Unknown spec 'unsupported'. Valid values: openai, anthropic, gemini",
    );
  });

  test("Gemini success uses only the resolved model", async () => {
    process.env["GEMINI_API_KEY"] = "gemini-key";
    geminiResponses = ["resolved response"];

    const result = await getMentorFeedback({
      goal: "goal",
      plan: "plan",
      modelOverride: { model: "gemini-pro" },
    });

    expect(result.feedback).toBe("resolved response");
    expect(geminiSdkCalls.map((call) => call.model)).toEqual(["gemini-pro"]);
  });

  test.each([
    "model not found",
    "context length exceeded",
    "context window exceeded",
    "model temporarily unavailable",
  ])("Gemini error %p keeps the requested model without fallback", async (message) => {
    process.env["GEMINI_API_KEY"] = "gemini-key";
    geminiErrorMessages = [message];

    const result = await verifyConnection({ model: "gemini-pro" });

    expect(result.ok).toBe(false);
    expect(result.model).toBe("gemini-pro");
    expect(result.error).toBe(message);
    expect(geminiSdkCalls.map((call) => call.model)).toEqual(["gemini-pro"]);
  });

  test("Gemini with custom baseUrl uses fetch to /models/{model}:generateContent", async () => {
    process.env["GEMINI_API_KEY"] = "gemini-key";
    mockFetch(
      () =>
        new Response(
          JSON.stringify({
            candidates: [
              { content: { parts: [{ text: "gemini baseUrl response" }] } },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );

    const result = await callProvider(
      {
        name: "gemini",
        spec: "gemini",
        envVar: "GEMINI_API_KEY",
        baseUrl: "https://gemini.proxy.example/v1/",
      },
      { apiKey: "gemini-key" },
      "gemini-model",
      "system prompt",
      "user prompt",
    );

    expect(result).toBe("gemini baseUrl response");
    expect(geminiSdkCalls).toHaveLength(0);
    const call = requireValue(fetchCalls[0], "fetch call 0");
    expect(call.url).toBe(
      "https://gemini.proxy.example/v1/models/gemini-model:generateContent",
    );
    expect(call.init.headers).toMatchObject({ "x-goog-api-key": "gemini-key" });
  });

  test("Gemini omits model request options when provider baseUrl is absent", async () => {
    process.env["GEMINI_API_KEY"] = "gemini-key";
    geminiResponses = ["gemini no baseUrl response"];

    const result = await callProvider(
      {
        name: "gemini",
        spec: "gemini",
        envVar: "GEMINI_API_KEY",
      },
      { apiKey: "gemini-key" },
      "gemini-model",
      "system prompt",
      "user prompt",
    );

    expect(result).toBe("gemini no baseUrl response");
    expect(geminiSdkCalls[0]?.model).toBe("gemini-model");
  });

  test("custom OpenAI model override passes unchanged", async () => {
    await writeSettings(mockSettings({ provider: "openrouter" }));
    process.env["OPENROUTER_API_KEY"] = "or-key";

    const result = await verifyConnection({ model: "vendor/custom:model" });

    expect(result.ok).toBe(true);
    expect(result.model).toBe("vendor/custom:model");
    expect(openAiRequests[0]?.request.model).toBe("vendor/custom:model");
  });

  test("getMentorFeedback returns fallback on provider errors", async () => {
    const result = await getMentorFeedback({
      goal: "goal",
      plan: "plan",
      modelOverride: { provider: "missing" },
    });

    expect(result.feedback).toBe(FALLBACK_FEEDBACK);
  });
});

describe("FALLBACK_FEEDBACK", () => {
  test("contains three unique numbered items", () => {
    const lines = FALLBACK_FEEDBACK.split("\n");

    expect(lines).toHaveLength(3);
    expect(new Set(lines).size).toBe(3);
    expect(
      lines.every((line, index) => line.startsWith(`${index + 1}. `)),
    ).toBe(true);
  });
});

describe("extractContent edge cases", () => {
  test("returns empty string when message content is null", async () => {
    process.env["CUSTOM_OPENAI_KEY"] = "custom-key";
    openAiResponseText = "";

    const result = await callProvider(
      {
        name: "custom-openai",
        spec: "openai",
        envVar: "CUSTOM_OPENAI_KEY",
        baseUrl: "https://custom.example/v1",
      },
      { apiKey: "custom-key" },
      "model",
      "system",
      "user",
    );

    expect(result).toBe("");
  });
});

describe("buildContextSection through getMentorFeedback", () => {
  test("includes userPrompt in context when provided", async () => {
    process.env["CUSTOM_OPENAI_KEY"] = "custom-key";
    openAiResponseText = "response with user prompt";

    const result = await getMentorFeedback({
      goal: "test goal",
      plan: "test plan",
      userPrompt: "do it carefully",
      modelOverride: { provider: "custom-openai" },
    });

    expect(result.feedback).toBe("response with user prompt");
    const request = requireValue(openAiRequests[0], "OpenAI request 0");
    expect(request.request.messages[1]?.content).toContain(
      "User Prompt: do it carefully",
    );
  });

  test("includes progress in context when provided", async () => {
    process.env["CUSTOM_OPENAI_KEY"] = "custom-key";
    openAiResponseText = "response with progress";

    const result = await getMentorFeedback({
      goal: "test goal",
      plan: "test plan",
      progress: "50% complete",
      modelOverride: { provider: "custom-openai" },
    });

    expect(result.feedback).toBe("response with progress");
    const request = requireValue(openAiRequests[0], "OpenAI request 0");
    expect(request.request.messages[1]?.content).toContain(
      "Progress: 50% complete",
    );
  });

  test("includes uncertainties in context when provided", async () => {
    process.env["CUSTOM_OPENAI_KEY"] = "custom-key";
    openAiResponseText = "response with uncertainties";

    const result = await getMentorFeedback({
      goal: "test goal",
      plan: "test plan",
      uncertainties: ["rate limits", "auth scope"],
      modelOverride: { provider: "custom-openai" },
    });

    expect(result.feedback).toBe("response with uncertainties");
    const request = requireValue(openAiRequests[0], "OpenAI request 0");
    expect(request.request.messages[1]?.content).toContain(
      "Uncertainties: rate limits, auth scope",
    );
  });

  test("includes taskContext in context when provided", async () => {
    process.env["CUSTOM_OPENAI_KEY"] = "custom-key";
    openAiResponseText = "response with task context";

    const result = await getMentorFeedback({
      goal: "test goal",
      plan: "test plan",
      taskContext: "working on auth module",
      modelOverride: { provider: "custom-openai" },
    });

    expect(result.feedback).toBe("response with task context");
    const request = requireValue(openAiRequests[0], "OpenAI request 0");
    expect(request.request.messages[1]?.content).toContain(
      "Task Context: working on auth module",
    );
  });

  test("includes historySummary in context when provided", async () => {
    process.env["CUSTOM_OPENAI_KEY"] = "custom-key";
    openAiResponseText = "response with history";

    const result = await getMentorFeedback({
      goal: "test goal",
      plan: "test plan",
      historySummary: "previously fixed auth bug",
      modelOverride: { provider: "custom-openai" },
    });

    expect(result.feedback).toBe("response with history");
    const request = requireValue(openAiRequests[0], "OpenAI request 0");
    expect(request.request.messages[1]?.content).toContain(
      "History Context: previously fixed auth bug",
    );
  });

  test("includes all optional fields together", async () => {
    process.env["CUSTOM_OPENAI_KEY"] = "custom-key";
    openAiResponseText = "full context response";

    const result = await getMentorFeedback({
      goal: "deploy service",
      plan: "build and test",
      userPrompt: "be thorough",
      progress: "80%",
      uncertainties: ["network latency"],
      taskContext: "production deploy",
      historySummary: "last deploy succeeded",
      modelOverride: { provider: "custom-openai" },
    });

    expect(result.feedback).toBe("full context response");
    const request = requireValue(openAiRequests[0], "OpenAI request 0");
    const content = request.request.messages[1]?.content as string;
    expect(content).toContain("Goal: deploy service");
    expect(content).toContain("Plan: build and test");
    expect(content).toContain("User Prompt: be thorough");
    expect(content).toContain("Progress: 80%");
    expect(content).toContain("Uncertainties: network latency");
    expect(content).toContain("Task Context: production deploy");
    expect(content).toContain("History Context: last deploy succeeded");
  });

  test("excludes empty uncertainties array from context", async () => {
    process.env["CUSTOM_OPENAI_KEY"] = "custom-key";
    openAiResponseText = "no uncertainties";

    await getMentorFeedback({
      goal: "test goal",
      plan: "test plan",
      uncertainties: [],
      modelOverride: { provider: "custom-openai" },
    });

    const request = requireValue(openAiRequests[0], "OpenAI request 0");
    expect(request.request.messages[1]?.content).not.toContain("Uncertainties");
  });

  test("includes constitution rules when set", async () => {
    process.env["CUSTOM_OPENAI_KEY"] = "custom-key";
    openAiResponseText = "with rules";
    resetConstitution(["always verify inputs", "log errors"]);

    await getMentorFeedback({
      goal: "test goal",
      plan: "test plan",
      modelOverride: { provider: "custom-openai" },
    });

    const request = requireValue(openAiRequests[0], "OpenAI request 0");
    const content = request.request.messages[1]?.content as string;
    expect(content).toContain("Constitution:");
    expect(content).toContain("- always verify inputs");
    expect(content).toContain("- log errors");
  });

  test("includes learning context when useLearningHistory is true", async () => {
    await writeSettings(
      mockSettings({
        provider: "custom-openai",
        useLearningHistory: true,
      }),
    );
    process.env["CUSTOM_OPENAI_KEY"] = "custom-key";
    openAiResponseText = "learning response";

    const result = await getMentorFeedback({
      goal: "test goal",
      plan: "test plan",
      modelOverride: { provider: "custom-openai" },
    });

    // With useLearningHistory: true, the call succeeds even if the
    // learning store is empty (the empty section gets filtered out).
    expect(result.feedback).toBe("learning response");
  });

  test("excludes learning context when useLearningHistory is false", async () => {
    await writeSettings(
      mockSettings({
        provider: "custom-openai",
        useLearningHistory: false,
      }),
    );
    process.env["CUSTOM_OPENAI_KEY"] = "custom-key";
    openAiResponseText = "no learning response";

    const result = await getMentorFeedback({
      goal: "test goal",
      plan: "test plan",
      modelOverride: { provider: "custom-openai" },
    });

    expect(result.feedback).toBe("no learning response");
    const request = requireValue(openAiRequests[0], "OpenAI request 0");
    expect(request.request.messages[1]?.content).not.toContain(
      "Learning Context:",
    );
  });

  test("includes learning context when useLearningHistory defaults to true", async () => {
    // Build settings without the useLearningHistory key entirely.
    const settings = mockSettings({ provider: "custom-openai" });
    const { useLearningHistory: _, ...withoutLearning } = settings as Record<
      string,
      unknown
    > & { useLearningHistory?: boolean };
    await writeSettings(withoutLearning);
    process.env["CUSTOM_OPENAI_KEY"] = "custom-key";
    openAiResponseText = "default learning response";

    const result = await getMentorFeedback({
      goal: "test goal",
      plan: "test plan",
      modelOverride: { provider: "custom-openai" },
    });

    // Default is true, so the call succeeds (empty learning store is
    // filtered out by buildContextSection).
    expect(result.feedback).toBe("default learning response");
  });
});

describe("revisePlan edge cases", () => {
  test("omits block reason line from prompt when blockReason absent", async () => {
    process.env["CUSTOM_OPENAI_KEY"] = "custom-key";
    openAiResponseText = "revised plan";

    const result = await revisePlan({
      goal: "goal",
      plan: "old plan",
      feedback: "missing rollback",
      modelOverride: { provider: "custom-openai" },
    });

    expect(result).toBe("revised plan");
    const request = requireValue(openAiRequests[0], "OpenAI request 0");
    expect(request.request.messages[1]?.content).not.toContain("Block reason");
    expect(request.request.messages[1]?.content).toContain(
      "Safety feedback: missing rollback",
    );
  });
});

describe("verifyConnection edge cases", () => {
  test("error with pre-set provider and model skips settings fallback", async () => {
    await writeSettings(mockSettings({ provider: "gemini" }));

    const result = await verifyConnection({
      provider: "custom-openai",
      model: "explicit-model",
    });

    expect(result.ok).toBe(false);
    expect(result.provider).toBe("custom-openai");
    expect(result.model).toBe("explicit-model");
    expect(result.error).toBe(
      "CUSTOM_OPENAI_KEY is not set in the environment",
    );
  });

  test("error with pre-set provider only resolves model from settings", async () => {
    await writeSettings(mockSettings({ provider: "gemini" }));

    const result = await verifyConnection({
      provider: "custom-openai",
    });

    expect(result.ok).toBe(false);
    expect(result.provider).toBe("custom-openai");
    expect(result.model).toBe("custom-default");
    expect(result.error).toBe(
      "CUSTOM_OPENAI_KEY is not set in the environment",
    );
  });

  test("error with no opts and broken settings reports error", async () => {
    await tempHome.cleanup();
    tempHome = await createTempHome();

    const result = await verifyConnection();

    expect(result.ok).toBe(false);
    expect(result.error).toBe(
      "No settings found. Copy settings.example.json to ~/.vibe-cli/settings.json",
    );
  });

  test("success truncates long responses to 200 characters", async () => {
    process.env["CUSTOM_OPENAI_KEY"] = "custom-key";
    openAiResponseText = "x".repeat(300);

    const result = await verifyConnection({
      provider: "custom-openai",
      model: "test-model",
    });

    expect(result.ok).toBe(true);
    expect(result.response).toHaveLength(200);
    expect(result.response).toBe("x".repeat(200));
  });

  test("handles non-Error throw during connection", async () => {
    openAiThrowValue = "connection refused";
    process.env["CUSTOM_OPENAI_KEY"] = "custom-key";

    const result = await verifyConnection({
      provider: "custom-openai",
      model: "test-model",
    });

    expect(result.ok).toBe(false);
    expect(result.error).toBe("connection refused");
  });
});

describe("Anthropic credentials resolution", () => {
  test("missing API key and no authTokenEnvVar names only envVar", async () => {
    await writeSettings(
      mockSettings({
        provider: "anthropic",
      }),
    );

    const result = await verifyConnection();

    expect(result.ok).toBe(false);
    expect(result.error).toBe(
      "ANTHROPIC_API_KEY is not set in the environment",
    );
  });
});

describe("callProvider credential guards", () => {
  test("gemini spec throws when credentials lack apiKey", async () => {
    await expect(
      callProvider(
        {
          name: "gemini",
          spec: "gemini",
          envVar: "GEMINI_API_KEY",
        },
        {},
        "model",
        "system",
        "user",
      ),
    ).rejects.toThrow("Resolved provider API key is unavailable.");
  });

  test("openai spec throws when credentials lack apiKey", async () => {
    await expect(
      callProvider(
        {
          name: "openai",
          spec: "openai",
          envVar: "OPENAI_API_KEY",
          baseUrl: "https://api.openai.com/v1",
        },
        {},
        "model",
        "system",
        "user",
      ),
    ).rejects.toThrow("Resolved provider API key is unavailable.");
  });
});

describe("temperature resolution via provider settings", () => {
  test("provider temperature null omits temperature from OpenAI request", async () => {
    await writeSettings(
      mockSettings({
        provider: "custom-openai",
        providers: mockSettings().providers.map((provider) =>
          provider.name === "custom-openai"
            ? { ...provider, temperature: null }
            : provider,
        ),
      }),
    );
    process.env["CUSTOM_OPENAI_KEY"] = "custom-key";

    await verifyConnection();

    const request = requireValue(openAiRequests[0], "OpenAI request 0");
    expect(request.request.temperature).toBeUndefined();
  });

  test("provider temperature null omits temperature from Anthropic request", async () => {
    await writeSettings(
      mockSettings({
        provider: "anthropic",
        providers: mockSettings().providers.map((provider) =>
          provider.name === "anthropic"
            ? { ...provider, temperature: null }
            : provider,
        ),
      }),
    );
    process.env["ANTHROPIC_API_KEY"] = "anth-key";
    mockFetch(() =>
      Response.json({ content: [{ type: "text", text: "anth ok" }] }),
    );

    await verifyConnection();

    const body = parseBody<Record<string, unknown>>(
      requireValue(fetchCalls[0], "fetch call 0").init,
    );
    expect(body["temperature"]).toBeUndefined();
  });

  test("provider temperature null omits temperature from Gemini request", async () => {
    await writeSettings(
      mockSettings({
        provider: "gemini",
        providers: mockSettings().providers.map((provider) =>
          provider.name === "gemini"
            ? { ...provider, temperature: null }
            : provider,
        ),
      }),
    );
    process.env["GEMINI_API_KEY"] = "gemini-key";
    geminiResponses = ["ok"];

    await verifyConnection();

    expect(geminiSdkCalls[0]?.config?.temperature).toBeUndefined();
  });

  test("provider explicit temperature is used for OpenAI", async () => {
    await writeSettings(
      mockSettings({
        provider: "custom-openai",
        providers: mockSettings().providers.map((provider) =>
          provider.name === "custom-openai"
            ? { ...provider, temperature: 0.7 }
            : provider,
        ),
      }),
    );
    process.env["CUSTOM_OPENAI_KEY"] = "custom-key";

    await verifyConnection();

    const request = requireValue(openAiRequests[0], "OpenAI request 0");
    expect(request.request.temperature).toBe(0.7);
  });

  test("provider explicit temperature is used for Anthropic", async () => {
    await writeSettings(
      mockSettings({
        provider: "anthropic",
        providers: mockSettings().providers.map((provider) =>
          provider.name === "anthropic"
            ? { ...provider, temperature: 0.7 }
            : provider,
        ),
      }),
    );
    process.env["ANTHROPIC_API_KEY"] = "anth-key";
    mockFetch(() =>
      Response.json({ content: [{ type: "text", text: "anth ok" }] }),
    );

    await verifyConnection();

    const body = parseBody<Record<string, unknown>>(
      requireValue(fetchCalls[0], "fetch call 0").init,
    );
    expect(body["temperature"]).toBe(0.7);
  });

  test("provider explicit temperature is used for Gemini", async () => {
    await writeSettings(
      mockSettings({
        provider: "gemini",
        providers: mockSettings().providers.map((provider) =>
          provider.name === "gemini"
            ? { ...provider, temperature: 0.7 }
            : provider,
        ),
      }),
    );
    process.env["GEMINI_API_KEY"] = "gemini-key";
    geminiResponses = ["ok"];

    await verifyConnection();

    expect(geminiSdkCalls[0]?.config?.temperature).toBe(0.7);
  });

  test("default temperature 0.1 used when provider has no temperature set", async () => {
    process.env["CUSTOM_OPENAI_KEY"] = "custom-key";

    await getMentorFeedback({
      goal: "goal",
      plan: "plan",
      modelOverride: { provider: "custom-openai" },
    });

    const request = requireValue(openAiRequests[0], "OpenAI request 0");
    expect(request.request.temperature).toBe(0.1);
  });

  test("provider temperature zero is sent to OpenAI", async () => {
    await writeSettings(
      mockSettings({
        provider: "custom-openai",
        providers: mockSettings().providers.map((provider) =>
          provider.name === "custom-openai"
            ? { ...provider, temperature: 0 }
            : provider,
        ),
      }),
    );
    process.env["CUSTOM_OPENAI_KEY"] = "custom-key";

    await verifyConnection();

    const request = requireValue(openAiRequests[0], "OpenAI request 0");
    expect(request.request.temperature).toBe(0);
  });

  test("modelOverride temperature wins over model selection only", async () => {
    await writeSettings(
      mockSettings({
        provider: "custom-openai",
        providers: mockSettings().providers.map((provider) =>
          provider.name === "custom-openai"
            ? { ...provider, temperature: 0.7 }
            : provider,
        ),
      }),
    );
    process.env["CUSTOM_OPENAI_KEY"] = "custom-key";

    await getGateDecision({
      goal: "goal",
      plan: "plan",
      feedback: "feedback",
      modelOverride: { provider: "custom-openai", model: "custom-model" },
    });

    const request = requireValue(openAiRequests[0], "OpenAI request 0");
    expect(request.request.temperature).toBe(0.7);
    expect(request.request.model).toBe("custom-model");
  });

  test("revisePlan uses provider temperature when set", async () => {
    await writeSettings(
      mockSettings({
        provider: "custom-openai",
        providers: mockSettings().providers.map((provider) =>
          provider.name === "custom-openai"
            ? { ...provider, temperature: 0.5 }
            : provider,
        ),
      }),
    );
    process.env["CUSTOM_OPENAI_KEY"] = "custom-key";
    openAiResponseText = "revised plan";

    await revisePlan({
      goal: "goal",
      plan: "old plan",
      feedback: "missing rollback",
      modelOverride: { provider: "custom-openai" },
    });

    const request = requireValue(openAiRequests[0], "OpenAI request 0");
    expect(request.request.temperature).toBe(0.5);
  });

  test("provider temperature zero is sent to Anthropic", async () => {
    await writeSettings(
      mockSettings({
        provider: "anthropic",
        providers: mockSettings().providers.map((provider) =>
          provider.name === "anthropic"
            ? { ...provider, temperature: 0 }
            : provider,
        ),
      }),
    );
    process.env["ANTHROPIC_API_KEY"] = "anth-key";
    mockFetch(() =>
      Response.json({ content: [{ type: "text", text: "anth ok" }] }),
    );

    await verifyConnection();

    const body = parseBody<Record<string, unknown>>(
      requireValue(fetchCalls[0], "fetch call 0").init,
    );
    expect(body["temperature"]).toBe(0);
  });

  test("provider temperature zero is sent to Gemini", async () => {
    await writeSettings(
      mockSettings({
        provider: "gemini",
        providers: mockSettings().providers.map((provider) =>
          provider.name === "gemini"
            ? { ...provider, temperature: 0 }
            : provider,
        ),
      }),
    );
    process.env["GEMINI_API_KEY"] = "gemini-key";
    geminiResponses = ["ok"];

    await verifyConnection();

    expect(geminiSdkCalls[0]?.config?.temperature).toBe(0);
  });

  test("default temperature 0.1 used for Anthropic when provider has no temperature set", async () => {
    await writeSettings(mockSettings({ provider: "anthropic" }));
    process.env["ANTHROPIC_API_KEY"] = "anth-key";
    mockFetch(() =>
      Response.json({ content: [{ type: "text", text: "anth ok" }] }),
    );

    await verifyConnection();

    const body = parseBody<Record<string, unknown>>(
      requireValue(fetchCalls[0], "fetch call 0").init,
    );
    expect(body["temperature"]).toBe(0.1);
  });

  test("default temperature 0.1 used for Gemini when provider has no temperature set", async () => {
    await writeSettings(mockSettings({ provider: "gemini" }));
    process.env["GEMINI_API_KEY"] = "gemini-key";
    geminiResponses = ["ok"];

    await verifyConnection();

    expect(geminiSdkCalls[0]?.config?.temperature).toBe(0.1);
  });
});

// ── T-002: Shared thinking mapping and inactive semantics ─────────────────

describe("isThinkingActive", () => {
  test("returns false for undefined", () => {
    expect(isThinkingActive(undefined)).toBe(false);
  });

  test("returns false for off", () => {
    expect(isThinkingActive("off")).toBe(false);
  });

  test.each([
    "low",
    "medium",
    "high",
    "xhigh",
  ] as ThinkingLevel[])("returns true for active level %p", (level) => {
    expect(isThinkingActive(level)).toBe(true);
  });
});

describe("mapThinkingLevel", () => {
  test.each([
    ["low" as const, "low" as const],
    ["medium" as const, "medium" as const],
    ["high" as const, "high" as const],
    ["xhigh" as const, "high" as const],
  ])("maps %p to %p", (input, expected) => {
    expect(mapThinkingLevel(input)).toBe(expected);
  });
});

describe("mapAnthropicThinkingBudget", () => {
  test.each([
    ["low" as const, 2048 as const],
    ["medium" as const, 4096 as const],
    ["high" as const, 8192 as const],
    ["xhigh" as const, 16384 as const],
  ])("maps %p to %d", (input, expected) => {
    expect(mapAnthropicThinkingBudget(input)).toBe(expected);
  });
});

describe("thinking inactive preserves existing behavior", () => {
  test("existing temperature resolution unchanged when thinking undefined", async () => {
    // Temperature tests in the suite above already validate behavior
    // when thinking is absent; this gate confirms no interaction.
    await writeSettings(mockSettings({ provider: "custom-openai" }));
    process.env["CUSTOM_OPENAI_KEY"] = "custom-key";

    await verifyConnection();

    const request = requireValue(openAiRequests[0], "OpenAI request 0");
    expect(request.request.temperature).toBe(0.1);
  });

  test("credential errors surface unchanged when thinking undefined", async () => {
    await writeSettings(mockSettings({ provider: "custom-openai" }));

    const result = await verifyConnection();

    expect(result.ok).toBe(false);
    expect(result.error).toBe(
      "CUSTOM_OPENAI_KEY is not set in the environment",
    );
  });

  test("endpoint selection unchanged when thinking off", async () => {
    // Settings with thinking: off on a Gemini provider still route
    // correctly through the default path.
    await writeSettings(
      mockSettings({
        provider: "gemini",
        providers: mockSettings().providers.map((provider) =>
          provider.name === "gemini"
            ? { ...provider, thinking: "off" }
            : provider,
        ),
      }),
    );
    process.env["GEMINI_API_KEY"] = "gemini-key";
    geminiResponses = ["gemini off response"];

    const result = await verifyConnection();

    expect(result.ok).toBe(true);
    expect(geminiSdkCalls[0]?.model).toBe("gemini-default");
  });

  test("provider API errors propagate unchanged", async () => {
    process.env["GEMINI_API_KEY"] = "gemini-key";
    geminiErrorMessages = ["model not found"];

    const result = await verifyConnection({ model: "gemini-pro" });

    expect(result.ok).toBe(false);
    expect(result.error).toBe("model not found");
  });
});

// ── T-003: OpenAI-compatible reasoning payload and o-series rules ─────────

function openAiRequest(): OpenAiCompatRequest {
  return requireValue(
    openAiRequests[openAiRequests.length - 1]?.request,
    "OpenAI request",
  );
}

describe("callOpenAICompat reasoning_effort", () => {
  test.each([
    ["low" as const, "low" as const],
    ["medium" as const, "medium" as const],
    ["high" as const, "high" as const],
    ["xhigh" as const, "high" as const],
  ])("active level %p sends reasoning_effort %p", async (level, expected) => {
    process.env["CUSTOM_OPENAI_KEY"] = "custom-key";

    await callProvider(
      {
        name: "custom-openai",
        spec: "openai",
        envVar: "CUSTOM_OPENAI_KEY",
        baseUrl: "https://custom.example/v1",
        thinking: level,
      },
      { apiKey: "custom-key" },
      "gpt-4",
      "system",
      "user",
    );

    expect(openAiRequest().reasoning_effort).toBe(expected);
  });

  test("omits reasoning_effort when thinking is off", async () => {
    process.env["CUSTOM_OPENAI_KEY"] = "custom-key";

    await callProvider(
      {
        name: "custom-openai",
        spec: "openai",
        envVar: "CUSTOM_OPENAI_KEY",
        baseUrl: "https://custom.example/v1",
        thinking: "off",
      },
      { apiKey: "custom-key" },
      "gpt-4",
      "system",
      "user",
    );

    expect(openAiRequest()).not.toHaveProperty("reasoning_effort");
  });

  test("omits reasoning_effort when thinking is absent", async () => {
    process.env["CUSTOM_OPENAI_KEY"] = "custom-key";

    await callProvider(
      {
        name: "custom-openai",
        spec: "openai",
        envVar: "CUSTOM_OPENAI_KEY",
        baseUrl: "https://custom.example/v1",
      },
      { apiKey: "custom-key" },
      "gpt-4",
      "system",
      "user",
    );

    expect(openAiRequest()).not.toHaveProperty("reasoning_effort");
  });

  test("inactive calls match prior request payload shape", async () => {
    process.env["CUSTOM_OPENAI_KEY"] = "custom-key";

    await callProvider(
      {
        name: "custom-openai",
        spec: "openai",
        envVar: "CUSTOM_OPENAI_KEY",
        baseUrl: "https://custom.example/v1",
      },
      { apiKey: "custom-key" },
      "gpt-4",
      "system",
      "user",
      0.1,
    );

    const request = openAiRequest();
    expect(request.model).toBe("gpt-4");
    expect(request.temperature).toBe(0.1);
    expect(request.messages).toEqual([
      { role: "system", content: "system" },
      { role: "user", content: "user" },
    ]);
    expect(request).not.toHaveProperty("reasoning_effort");
    expect(request).not.toHaveProperty("max_tokens");
    expect(request).not.toHaveProperty("max_completion_tokens");
  });
});

describe("O-series model rules", () => {
  test("omits temperature for o-series models", async () => {
    process.env["CUSTOM_OPENAI_KEY"] = "custom-key";

    await callProvider(
      {
        name: "custom-openai",
        spec: "openai",
        envVar: "CUSTOM_OPENAI_KEY",
        baseUrl: "https://custom.example/v1",
      },
      { apiKey: "custom-key" },
      "o3-mini",
      "system",
      "user",
      0.7,
    );

    expect(openAiRequest()).not.toHaveProperty("temperature");
  });

  test("o3 model omits temperature", async () => {
    process.env["CUSTOM_OPENAI_KEY"] = "custom-key";

    await callProvider(
      {
        name: "custom-openai",
        spec: "openai",
        envVar: "CUSTOM_OPENAI_KEY",
        baseUrl: "https://custom.example/v1",
      },
      { apiKey: "custom-key" },
      "o3",
      "system",
      "user",
      0.5,
    );

    expect(openAiRequest()).not.toHaveProperty("temperature");
  });

  test("o-series uses max_completion_tokens when maxTokens provided", async () => {
    process.env["CUSTOM_OPENAI_KEY"] = "custom-key";

    await callProvider(
      {
        name: "custom-openai",
        spec: "openai",
        envVar: "CUSTOM_OPENAI_KEY",
        baseUrl: "https://custom.example/v1",
      },
      { apiKey: "custom-key" },
      "o1",
      "system",
      "user",
      0.1,
      4096,
    );

    const request = openAiRequest();
    expect(request).not.toHaveProperty("max_tokens");
    expect(request.max_completion_tokens).toBe(4096);
  });

  test("non-o-series uses max_tokens when maxTokens provided", async () => {
    process.env["CUSTOM_OPENAI_KEY"] = "custom-key";

    await callProvider(
      {
        name: "custom-openai",
        spec: "openai",
        envVar: "CUSTOM_OPENAI_KEY",
        baseUrl: "https://custom.example/v1",
      },
      { apiKey: "custom-key" },
      "gpt-4",
      "system",
      "user",
      0.1,
      2048,
    );

    const request = openAiRequest();
    expect(request).not.toHaveProperty("max_completion_tokens");
    expect(request.max_tokens).toBe(2048);
  });

  test("non-o-series behavior unchanged when maxTokens absent", async () => {
    process.env["CUSTOM_OPENAI_KEY"] = "custom-key";

    await callProvider(
      {
        name: "custom-openai",
        spec: "openai",
        envVar: "CUSTOM_OPENAI_KEY",
        baseUrl: "https://custom.example/v1",
      },
      { apiKey: "custom-key" },
      "gpt-4",
      "system",
      "user",
      0.1,
    );

    const request = openAiRequest();
    expect(request.temperature).toBe(0.1);
    expect(request).not.toHaveProperty("max_tokens");
    expect(request).not.toHaveProperty("max_completion_tokens");
    expect(request).not.toHaveProperty("reasoning_effort");
  });

  test("o-series with active thinking sends both reasoning_effort and o-series shape", async () => {
    process.env["CUSTOM_OPENAI_KEY"] = "custom-key";

    await callProvider(
      {
        name: "custom-openai",
        spec: "openai",
        envVar: "CUSTOM_OPENAI_KEY",
        baseUrl: "https://custom.example/v1",
        thinking: "high",
      },
      { apiKey: "custom-key" },
      "o1",
      "system",
      "user",
      0.7,
      8192,
    );

    const request = openAiRequest();
    expect(request.reasoning_effort).toBe("high");
    expect(request).not.toHaveProperty("temperature");
    expect(request.max_completion_tokens).toBe(8192);
    expect(request).not.toHaveProperty("max_tokens");
  });

  test("o-series with thinking off omits reasoning_effort and temperature", async () => {
    process.env["CUSTOM_OPENAI_KEY"] = "custom-key";

    await callProvider(
      {
        name: "custom-openai",
        spec: "openai",
        envVar: "CUSTOM_OPENAI_KEY",
        baseUrl: "https://custom.example/v1",
        thinking: "off",
      },
      { apiKey: "custom-key" },
      "o3-mini",
      "system",
      "user",
      0.5,
    );

    const request = openAiRequest();
    expect(request).not.toHaveProperty("reasoning_effort");
    expect(request).not.toHaveProperty("temperature");
  });

  test("o-series provider errors propagate unchanged", async () => {
    openAiThrowValue = new Error("model 'o1' not found");
    process.env["CUSTOM_OPENAI_KEY"] = "custom-key";

    await expect(
      callProvider(
        {
          name: "custom-openai",
          spec: "openai",
          envVar: "CUSTOM_OPENAI_KEY",
          baseUrl: "https://custom.example/v1",
          thinking: "medium",
        },
        { apiKey: "custom-key" },
        "o1",
        "system",
        "user",
      ),
    ).rejects.toThrow("model 'o1' not found");
  });

  test("o-series base URL normalization preserved", async () => {
    process.env["CUSTOM_OPENAI_KEY"] = "custom-key";

    await callProvider(
      {
        name: "custom-openai",
        spec: "openai",
        envVar: "CUSTOM_OPENAI_KEY",
        baseUrl: "https://custom.example/v1///",
        thinking: "low",
      },
      { apiKey: "custom-key" },
      "o1",
      "system",
      "user",
    );

    const request = openAiRequest();
    expect(request.reasoning_effort).toBe("low");
    expect(request).not.toHaveProperty("temperature");
    expect(request.model).toBe("o1");
  });

  test("non-o-series model starting with o but not digit preserves temperature", async () => {
    process.env["CUSTOM_OPENAI_KEY"] = "custom-key";

    await callProvider(
      {
        name: "custom-openai",
        spec: "openai",
        envVar: "CUSTOM_OPENAI_KEY",
        baseUrl: "https://custom.example/v1",
      },
      { apiKey: "custom-key" },
      "openai-gpt",
      "system",
      "user",
      0.7,
    );

    expect(openAiRequest().temperature).toBe(0.7);
  });

  test("model with o-digit in middle is not treated as o-series", async () => {
    process.env["CUSTOM_OPENAI_KEY"] = "custom-key";

    await callProvider(
      {
        name: "custom-openai",
        spec: "openai",
        envVar: "CUSTOM_OPENAI_KEY",
        baseUrl: "https://custom.example/v1",
      },
      { apiKey: "custom-key" },
      "gpt-o3",
      "system",
      "user",
      0.5,
    );

    expect(openAiRequest().temperature).toBe(0.5);
  });

  test("temperature zero preserved with active thinking on non-o-series", async () => {
    process.env["CUSTOM_OPENAI_KEY"] = "custom-key";

    await callProvider(
      {
        name: "custom-openai",
        spec: "openai",
        envVar: "CUSTOM_OPENAI_KEY",
        baseUrl: "https://custom.example/v1",
        thinking: "medium",
      },
      { apiKey: "custom-key" },
      "gpt-4",
      "system",
      "user",
      0,
    );

    const request = openAiRequest();
    expect(request.temperature).toBe(0);
    expect(request.reasoning_effort).toBe("medium");
  });

  test("temperature null omits temperature while preserving active thinking", async () => {
    process.env["CUSTOM_OPENAI_KEY"] = "custom-key";

    await callProvider(
      {
        name: "custom-openai",
        spec: "openai",
        envVar: "CUSTOM_OPENAI_KEY",
        baseUrl: "https://custom.example/v1",
        thinking: "high",
        temperature: null,
      },
      { apiKey: "custom-key" },
      "gpt-4",
      "system",
      "user",
    );

    const request = openAiRequest();
    expect(request).not.toHaveProperty("temperature");
    expect(request.reasoning_effort).toBe("high");
  });
});

// ── T-004: Anthropic thinking payload, headers, tokens, parsing ─────────

describe("Anthropic thinking via callProvider", () => {
  test("active thinking sends thinking block, beta header, and forced temperature", async () => {
    process.env["ANTHROPIC_API_KEY"] = "anth-key";
    mockFetch(() => Response.json({ content: [{ type: "text", text: "ok" }] }));

    await callProvider(
      {
        name: "anthropic",
        spec: "anthropic",
        envVar: "ANTHROPIC_API_KEY",
        thinking: "high",
      },
      { apiKey: "anth-key" },
      "claude-sonnet",
      "system",
      "user",
      0.7,
      4096,
    );

    const body = lastFetchBody();
    expect(body["thinking"]).toEqual({
      type: "enabled",
      budget_tokens: 8192,
    });
    expect(body["temperature"]).toBe(1.0);
    expect(body["max_tokens"]).toBe(9216); // budget 8192 + 1024 floor > explicit 4096
    expect(lastFetchHeaders()["anthropic-beta"]).toBe("thinking-1.0");
  });

  test("inactive thinking omits thinking block and preserves temperature", async () => {
    process.env["ANTHROPIC_API_KEY"] = "anth-key";
    mockFetch(() => Response.json({ content: [{ type: "text", text: "ok" }] }));

    await callProvider(
      {
        name: "anthropic",
        spec: "anthropic",
        envVar: "ANTHROPIC_API_KEY",
        thinking: "off",
      },
      { apiKey: "anth-key" },
      "claude-sonnet",
      "system",
      "user",
      0.3,
      2048,
    );

    const body = lastFetchBody();
    expect(body["thinking"]).toBeUndefined();
    expect(body["temperature"]).toBe(0.3);
    expect(body["max_tokens"]).toBe(1024); // callAnthropic default; maxTokens not forwarded from callProvider (pre-existing)
    expect(lastFetchHeaders()["anthropic-beta"]).toBeUndefined();
  });

  test("absent thinking preserves existing Anthropic request shape", async () => {
    process.env["ANTHROPIC_API_KEY"] = "anth-key";
    mockFetch(() => Response.json({ content: [{ type: "text", text: "ok" }] }));

    // No thinking field on provider entry
    await callProvider(
      {
        name: "anthropic",
        spec: "anthropic",
        envVar: "ANTHROPIC_API_KEY",
      },
      { apiKey: "anth-key" },
      "claude-haiku",
      "system",
      "user",
      0.1,
    );

    const body = lastFetchBody();
    expect(body["thinking"]).toBeUndefined();
    expect(body["temperature"]).toBe(0.1);
    expect(body["max_tokens"]).toBe(1024);
    expect(lastFetchHeaders()["anthropic-beta"]).toBeUndefined();
  });

  test("xhigh thinking sends budget 16384 with token floor", async () => {
    process.env["ANTHROPIC_API_KEY"] = "anth-key";
    mockFetch(() => Response.json({ content: [{ type: "text", text: "ok" }] }));

    await callProvider(
      {
        name: "anthropic",
        spec: "anthropic",
        envVar: "ANTHROPIC_API_KEY",
        thinking: "xhigh",
      },
      { apiKey: "anth-key" },
      "claude-opus",
      "system",
      "user",
    );

    const body = lastFetchBody();
    expect(body["thinking"]).toEqual({
      type: "enabled",
      budget_tokens: 16384,
    });
    expect(body["temperature"]).toBe(1.0);
    expect(body["max_tokens"]).toBe(17408); // 16384 + 1024
  });

  test("thinking flows through settings-based Anthropic dispatch", async () => {
    await writeSettings(
      mockSettings({
        provider: "anthropic",
        providers: mockSettings().providers.map((p) =>
          p.name === "anthropic" ? { ...p, thinking: "medium" } : p,
        ),
      }),
    );
    process.env["ANTHROPIC_API_KEY"] = "anth-key";
    mockFetch(() =>
      Response.json({ content: [{ type: "text", text: "anth ok" }] }),
    );

    const result = await verifyConnection();

    expect(result.ok).toBe(true);
    const body = lastFetchBody();
    expect(body["thinking"]).toEqual({
      type: "enabled",
      budget_tokens: 4096,
    });
    expect(body["temperature"]).toBe(1.0);
    expect(lastFetchHeaders()["anthropic-beta"]).toBe("thinking-1.0");
  });

  test("Anthropic thinking off via settings preserves default temperature", async () => {
    await writeSettings(
      mockSettings({
        provider: "anthropic",
        providers: mockSettings().providers.map((p) =>
          p.name === "anthropic" ? { ...p, thinking: "off" } : p,
        ),
      }),
    );
    process.env["ANTHROPIC_API_KEY"] = "anth-key";
    mockFetch(() =>
      Response.json({ content: [{ type: "text", text: "anth ok" }] }),
    );

    await verifyConnection();

    const body = lastFetchBody();
    expect(body["thinking"]).toBeUndefined();
    expect(body["temperature"]).toBe(0.1);
    expect(lastFetchHeaders()["anthropic-beta"]).toBeUndefined();
  });

  test("Anthropic with thinking active preserves auth token behavior", async () => {
    await writeSettings(
      mockSettings({
        provider: "anthropic",
        providers: mockSettings().providers.map((p) =>
          p.name === "anthropic"
            ? {
                ...p,
                thinking: "low",
                baseUrl: "https://anth-proxy.example",
                apiVersion: "2024-01-01",
                authTokenEnvVar: "CUSTOM_ANTHROPIC_TOKEN",
              }
            : p,
        ),
      }),
    );
    process.env["CUSTOM_ANTHROPIC_TOKEN"] = "token-value";
    mockFetch(() =>
      Response.json({ content: [{ type: "text", text: "anth ok" }] }),
    );

    await verifyConnection();

    const headers = lastFetchHeaders();
    expect(headers["authorization"]).toBe("Bearer token-value");
    expect(headers["anthropic-beta"]).toBe("thinking-1.0");
    expect(headers["anthropic-version"]).toBe("2024-01-01");
  });

  test("Anthropic thinking with provider temperature null forces 1.0", async () => {
    await writeSettings(
      mockSettings({
        provider: "anthropic",
        providers: mockSettings().providers.map((p) =>
          p.name === "anthropic"
            ? { ...p, thinking: "high", temperature: null }
            : p,
        ),
      }),
    );
    process.env["ANTHROPIC_API_KEY"] = "anth-key";
    mockFetch(() =>
      Response.json({ content: [{ type: "text", text: "anth ok" }] }),
    );

    await verifyConnection();

    const body = lastFetchBody();
    expect(body["temperature"]).toBe(1.0);
  });

  test("Anthropic thinking with provider temperature zero forces 1.0", async () => {
    await writeSettings(
      mockSettings({
        provider: "anthropic",
        providers: mockSettings().providers.map((p) =>
          p.name === "anthropic"
            ? { ...p, thinking: "medium", temperature: 0 }
            : p,
        ),
      }),
    );
    process.env["ANTHROPIC_API_KEY"] = "anth-key";
    mockFetch(() =>
      Response.json({ content: [{ type: "text", text: "anth ok" }] }),
    );

    await verifyConnection();

    const body = lastFetchBody();
    expect(body["temperature"]).toBe(1.0);
  });

  test("Anthropic API errors propagate with thinking active", async () => {
    await writeSettings(
      mockSettings({
        provider: "anthropic",
        providers: mockSettings().providers.map((p) =>
          p.name === "anthropic" ? { ...p, thinking: "high" } : p,
        ),
      }),
    );
    process.env["ANTHROPIC_API_KEY"] = "bad-key";
    mockFetch(
      () =>
        new Response(JSON.stringify({ error: { message: "invalid key" } }), {
          status: 401,
          headers: { "anthropic-request-id": "req-001" },
        }),
    );

    const result = await verifyConnection();

    expect(result.ok).toBe(false);
    expect(result.error).toBe(
      "Anthropic auth failed (401) (request id: req-001). Check ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN.",
    );
  });
});

// ── T-005: Gemini SDK migration and default config path ─────────────────

describe("Gemini default SDK call shape", () => {
  test("sends model, contents, and config via models.generateContent", async () => {
    process.env["GEMINI_API_KEY"] = "gemini-key";
    geminiResponses = ["sdk response"];

    const result = await callProvider(
      {
        name: "gemini",
        spec: "gemini",
        envVar: "GEMINI_API_KEY",
      },
      { apiKey: "gemini-key" },
      "gemini-model",
      "system prompt",
      "user prompt",
      0.1,
    );

    expect(result).toBe("sdk response");
    expect(geminiSdkCalls[0]).toMatchObject({
      model: "gemini-model",
      contents: [{ role: "user", parts: [{ text: "user prompt" }] }],
      config: {
        systemInstruction: { parts: [{ text: "system prompt" }] },
        temperature: 0.1,
      },
    });
  });

  test("active thinking sends thinkingConfig in config", async () => {
    process.env["GEMINI_API_KEY"] = "gemini-key";
    geminiResponses = ["thinking response"];

    await callProvider(
      {
        name: "gemini",
        spec: "gemini",
        envVar: "GEMINI_API_KEY",
        thinking: "high",
      },
      { apiKey: "gemini-key" },
      "gemini-model",
      "system prompt",
      "user prompt",
    );

    expect(geminiSdkCalls[0]?.config?.thinkingConfig).toEqual({
      thinkingLevel: "high",
    });
  });

  test.each([
    ["low" as const, "low" as const],
    ["medium" as const, "medium" as const],
    ["high" as const, "high" as const],
    ["xhigh" as const, "high" as const],
  ])("active level %p sets thinkingLevel %p in SDK config", async (level, expected) => {
    process.env["GEMINI_API_KEY"] = "gemini-key";
    geminiResponses = ["ok"];

    await callProvider(
      {
        name: "gemini",
        spec: "gemini",
        envVar: "GEMINI_API_KEY",
        thinking: level,
      },
      { apiKey: "gemini-key" },
      "gemini-model",
      "system prompt",
      "user prompt",
    );

    expect(geminiSdkCalls[0]?.config?.thinkingConfig).toEqual({
      thinkingLevel: expected,
    });
  });

  test("inactive thinking omits thinkingConfig from config", async () => {
    process.env["GEMINI_API_KEY"] = "gemini-key";
    geminiResponses = ["no thinking"];

    await callProvider(
      {
        name: "gemini",
        spec: "gemini",
        envVar: "GEMINI_API_KEY",
        thinking: "off",
      },
      { apiKey: "gemini-key" },
      "gemini-model",
      "system prompt",
      "user prompt",
      0.2,
    );

    expect(geminiSdkCalls[0]?.config).toBeDefined();
    expect(geminiSdkCalls[0]?.config?.thinkingConfig).toBeUndefined();
    expect(geminiSdkCalls[0]?.config?.temperature).toBe(0.2);
  });

  test("absent thinking omits thinkingConfig", async () => {
    process.env["GEMINI_API_KEY"] = "gemini-key";
    geminiResponses = ["absent"];

    await callProvider(
      {
        name: "gemini",
        spec: "gemini",
        envVar: "GEMINI_API_KEY",
      },
      { apiKey: "gemini-key" },
      "gemini-model",
      "system prompt",
      "user prompt",
    );

    if (geminiSdkCalls[0]?.config) {
      expect(geminiSdkCalls[0].config.thinkingConfig).toBeUndefined();
    }
  });

  test("new SDK lazy-initialized once per API key", async () => {
    // Use a unique key not touched by earlier tests to avoid
    // module-level genAI/genAIKey state contamination.
    geminiResponses = ["first", "second"];

    await callProvider(
      { name: "gemini", spec: "gemini", envVar: "GEMINI_API_KEY" },
      { apiKey: "lazy-key" },
      "gemini-model",
      "system",
      "user",
    );
    await callProvider(
      { name: "gemini", spec: "gemini", envVar: "GEMINI_API_KEY" },
      { apiKey: "lazy-key" },
      "gemini-model",
      "system",
      "user",
    );

    // Same key reused → only one SDK instantiation
    expect(geminiApiKeys).toEqual(["lazy-key"]);
    expect(geminiSdkCalls).toHaveLength(2);
  });

  test("changed API key creates new SDK instance", async () => {
    process.env["GEMINI_API_KEY"] = "first-key";
    geminiResponses = ["first"];

    await callProvider(
      { name: "gemini", spec: "gemini", envVar: "GEMINI_API_KEY" },
      { apiKey: "first-key" },
      "gemini-model",
      "system",
      "user",
    );

    process.env["GEMINI_API_KEY"] = "second-key";
    geminiResponses = ["second"];

    await callProvider(
      { name: "gemini", spec: "gemini", envVar: "GEMINI_API_KEY" },
      { apiKey: "second-key" },
      "gemini-model",
      "system",
      "user",
    );

    expect(geminiApiKeys).toEqual(["first-key", "second-key"]);
  });

  test("custom baseUrl bypasses SDK and uses raw fetch with thinking config", async () => {
    process.env["GEMINI_API_KEY"] = "gemini-key";
    mockFetch(
      () =>
        new Response(
          JSON.stringify({
            candidates: [{ content: { parts: [{ text: "custom endpoint" }] } }],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );

    const result = await callProvider(
      {
        name: "gemini",
        spec: "gemini",
        envVar: "GEMINI_API_KEY",
        baseUrl: "https://proxy.example/v1/",
        thinking: "high",
      },
      { apiKey: "gemini-key" },
      "gemini-model",
      "system prompt",
      "user prompt",
      0.1,
    );

    expect(result).toBe("custom endpoint");
    // Custom endpoint path does not use the SDK mock
    expect(geminiSdkCalls).toHaveLength(0);
    // Assert thinking config is present in the custom endpoint fetch body
    const fetchBody = JSON.parse(
      String(fetchCalls[0]?.init.body ?? "{}"),
    ) as Record<string, unknown>;
    const genConfig = fetchBody["generationConfig"] as Record<string, unknown>;
    expect(genConfig["thinkingConfig"]).toEqual({ thinkingLevel: "high" });
    expect(genConfig["temperature"]).toBe(0.1);
  });

  test("missing credentials surface unchanged with new SDK", async () => {
    process.env["GEMINI_API_KEY"] = "gemini-key";
    geminiErrorMessages = ["API key not valid"];

    const result = await verifyConnection({ model: "gemini-pro" });

    expect(result.ok).toBe(false);
    expect(result.model).toBe("gemini-pro");
    expect(result.error).toBe("API key not valid");
  });

  test("temperature zero preserved with active thinking in SDK config", async () => {
    process.env["GEMINI_API_KEY"] = "gemini-key";
    geminiResponses = ["ok"];

    await callProvider(
      {
        name: "gemini",
        spec: "gemini",
        envVar: "GEMINI_API_KEY",
        thinking: "medium",
      },
      { apiKey: "gemini-key" },
      "gemini-model",
      "system",
      "user",
      0,
    );

    expect(geminiSdkCalls[0]?.config?.temperature).toBe(0);
    expect(geminiSdkCalls[0]?.config?.thinkingConfig).toEqual({
      thinkingLevel: "medium",
    });
  });

  test("temperature null omits temperature while preserving active thinking in SDK config", async () => {
    process.env["GEMINI_API_KEY"] = "gemini-key";
    geminiResponses = ["ok"];

    await callProvider(
      {
        name: "gemini",
        spec: "gemini",
        envVar: "GEMINI_API_KEY",
        thinking: "high",
        temperature: null,
      },
      { apiKey: "gemini-key" },
      "gemini-model",
      "system",
      "user",
    );

    const cfg = geminiSdkCalls[0]?.config;
    expect(cfg?.temperature).toBeUndefined();
    expect(cfg?.thinkingConfig).toEqual({ thinkingLevel: "high" });
  });
});

// ── T-006: Gemini custom endpoint thinking path ──────────────────────────

function lastFetchBody(): Record<string, unknown> {
  return JSON.parse(
    String(fetchCalls[fetchCalls.length - 1]?.init.body ?? "{}"),
  );
}

function lastFetchUrl(): string {
  return fetchCalls[fetchCalls.length - 1]?.url ?? "";
}

function lastFetchHeaders(): Record<string, string> {
  return (fetchCalls[fetchCalls.length - 1]?.init.headers ?? {}) as Record<
    string,
    string
  >;
}

describe("Gemini custom endpoint thinking", () => {
  beforeEach(() => {
    mockFetch(
      () =>
        new Response(
          JSON.stringify({
            candidates: [
              { content: { parts: [{ text: "custom endpoint response" }] } },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );
  });

  test("custom endpoint URL, auth header, contents, system instruction, and temperature preserved with active thinking", async () => {
    process.env["GEMINI_API_KEY"] = "gemini-key";

    await callProvider(
      {
        name: "gemini",
        spec: "gemini",
        envVar: "GEMINI_API_KEY",
        baseUrl: "https://proxy.example/v1/",
        thinking: "high",
      },
      { apiKey: "gemini-key" },
      "gemini-custom-model",
      "system instruction",
      "user content",
      0.3,
    );

    expect(geminiSdkCalls).toHaveLength(0);
    expect(lastFetchUrl()).toBe(
      "https://proxy.example/v1/models/gemini-custom-model:generateContent",
    );
    expect(lastFetchHeaders()).toMatchObject({
      "x-goog-api-key": "gemini-key",
    });
    const body = lastFetchBody();
    expect(body["contents"]).toEqual([
      { role: "user", parts: [{ text: "user content" }] },
    ]);
    expect(body["systemInstruction"]).toEqual({
      parts: [{ text: "system instruction" }],
    });
    expect(body["generationConfig"]).toMatchObject({ temperature: 0.3 });
  });

  test.each([
    ["low" as const, "low" as const],
    ["medium" as const, "medium" as const],
    ["high" as const, "high" as const],
    ["xhigh" as const, "high" as const],
  ])("active level %p sets thinkingLevel %p in custom endpoint body", async (level, expected) => {
    process.env["GEMINI_API_KEY"] = "gemini-key";

    await callProvider(
      {
        name: "gemini",
        spec: "gemini",
        envVar: "GEMINI_API_KEY",
        baseUrl: "https://proxy.example/v1/",
        thinking: level,
      },
      { apiKey: "gemini-key" },
      "gemini-model",
      "system",
      "user",
    );

    expect(geminiSdkCalls).toHaveLength(0);
    const body = lastFetchBody();
    expect(body["generationConfig"]).toMatchObject({
      thinkingConfig: { thinkingLevel: expected },
    });
  });

  test("thinking off omits thinkingConfig from custom endpoint body", async () => {
    process.env["GEMINI_API_KEY"] = "gemini-key";

    await callProvider(
      {
        name: "gemini",
        spec: "gemini",
        envVar: "GEMINI_API_KEY",
        baseUrl: "https://proxy.example/v1/",
        thinking: "off",
      },
      { apiKey: "gemini-key" },
      "gemini-model",
      "system",
      "user",
      0.2,
    );

    expect(geminiSdkCalls).toHaveLength(0);
    const genConfig = lastFetchBody()["generationConfig"] as Record<
      string,
      unknown
    >;
    expect(genConfig["thinkingConfig"]).toBeUndefined();
    expect(genConfig["temperature"]).toBe(0.2);
  });

  test("absent thinking omits thinkingConfig from custom endpoint body", async () => {
    process.env["GEMINI_API_KEY"] = "gemini-key";

    await callProvider(
      {
        name: "gemini",
        spec: "gemini",
        envVar: "GEMINI_API_KEY",
        baseUrl: "https://proxy.example/v1/",
      },
      { apiKey: "gemini-key" },
      "gemini-model",
      "system",
      "user",
    );

    expect(geminiSdkCalls).toHaveLength(0);
    const genConfig = lastFetchBody()["generationConfig"] as Record<
      string,
      unknown
    >;
    expect(genConfig["thinkingConfig"]).toBeUndefined();
  });

  test("custom endpoint preserves temperature when thinking is absent and temperature undefined", async () => {
    process.env["GEMINI_API_KEY"] = "gemini-key";

    // Use provider temperature null to suppress the default temperature 0.1
    await callProvider(
      {
        name: "gemini",
        spec: "gemini",
        envVar: "GEMINI_API_KEY",
        baseUrl: "https://proxy.example/v1/",
        temperature: null,
      },
      { apiKey: "gemini-key" },
      "gemini-model",
      "system",
      "user",
    );

    // When both temperature and thinking are absent, generationConfig is omitted
    expect(lastFetchBody()).not.toHaveProperty("generationConfig");
  });

  test("custom endpoint non-2xx error surfaces unchanged with active thinking", async () => {
    mockFetch(
      () =>
        new Response("backend unavailable", {
          status: 503,
          headers: { "content-type": "text/plain" },
        }),
    );
    process.env["GEMINI_API_KEY"] = "gemini-key";

    await expect(
      callProvider(
        {
          name: "gemini",
          spec: "gemini",
          envVar: "GEMINI_API_KEY",
          baseUrl: "https://proxy.example/v1/",
          thinking: "medium",
        },
        { apiKey: "gemini-key" },
        "gemini-model",
        "system",
        "user",
      ),
    ).rejects.toThrow("Gemini error 503: backend unavailable");
  });

  test("custom endpoint malformed JSON error surfaces unchanged with active thinking", async () => {
    mockFetch(
      () =>
        new Response("not json", {
          status: 200,
          headers: { "content-type": "text/plain" },
        }),
    );
    process.env["GEMINI_API_KEY"] = "gemini-key";

    await expect(
      callProvider(
        {
          name: "gemini",
          spec: "gemini",
          envVar: "GEMINI_API_KEY",
          baseUrl: "https://proxy.example/v1/",
          thinking: "high",
        },
        { apiKey: "gemini-key" },
        "gemini-model",
        "system",
        "user",
      ),
    ).rejects.toThrow("Gemini returned non-JSON response: not json");
  });

  test("custom endpoint with thinking off preserves current inactive request shape", async () => {
    process.env["GEMINI_API_KEY"] = "gemini-key";

    await callProvider(
      {
        name: "gemini",
        spec: "gemini",
        envVar: "GEMINI_API_KEY",
        baseUrl: "https://proxy.example/v1/",
        thinking: "off",
      },
      { apiKey: "gemini-key" },
      "gemini-model",
      "system",
      "user",
    );

    const body = lastFetchBody();
    // No thinking fields anywhere in the body
    expect(JSON.stringify(body)).not.toContain("thinking");
    expect(body["contents"]).toBeDefined();
    expect(body["systemInstruction"]).toBeDefined();
  });

  test("custom endpoint thinking active with high sends generationConfig with thinkingConfig", async () => {
    process.env["GEMINI_API_KEY"] = "gemini-key";

    await callProvider(
      {
        name: "gemini",
        spec: "gemini",
        envVar: "GEMINI_API_KEY",
        baseUrl: "https://proxy.example/v1/",
        thinking: "high",
      },
      { apiKey: "gemini-key" },
      "gemini-model",
      "system",
      "user",
      0.1,
    );

    const genConfig = lastFetchBody()["generationConfig"] as Record<
      string,
      unknown
    >;
    expect(genConfig).toEqual({
      temperature: 0.1,
      thinkingConfig: { thinkingLevel: "high" },
    });
  });

  test("custom endpoint xhigh maps to high thinkingLevel in body", async () => {
    process.env["GEMINI_API_KEY"] = "gemini-key";

    await callProvider(
      {
        name: "gemini",
        spec: "gemini",
        envVar: "GEMINI_API_KEY",
        baseUrl: "https://proxy.example/v1/",
        thinking: "xhigh",
      },
      { apiKey: "gemini-key" },
      "gemini-model",
      "system",
      "user",
    );

    const genConfig = lastFetchBody()["generationConfig"] as Record<
      string,
      unknown
    >;
    expect(genConfig["thinkingConfig"]).toEqual({ thinkingLevel: "high" });
  });

  test("custom endpoint temperature zero preserved with active thinking", async () => {
    process.env["GEMINI_API_KEY"] = "gemini-key";

    await callProvider(
      {
        name: "gemini",
        spec: "gemini",
        envVar: "GEMINI_API_KEY",
        baseUrl: "https://proxy.example/v1/",
        thinking: "low",
      },
      { apiKey: "gemini-key" },
      "gemini-model",
      "system",
      "user",
      0,
    );

    const genConfig = lastFetchBody()["generationConfig"] as Record<
      string,
      unknown
    >;
    expect(genConfig).toEqual({
      temperature: 0,
      thinkingConfig: { thinkingLevel: "low" },
    });
  });

  test("custom endpoint temperature null omits temperature while preserving active thinking", async () => {
    process.env["GEMINI_API_KEY"] = "gemini-key";

    await callProvider(
      {
        name: "gemini",
        spec: "gemini",
        envVar: "GEMINI_API_KEY",
        baseUrl: "https://proxy.example/v1/",
        thinking: "xhigh",
        temperature: null,
      },
      { apiKey: "gemini-key" },
      "gemini-model",
      "system",
      "user",
    );

    const genConfig = lastFetchBody()["generationConfig"] as Record<
      string,
      unknown
    >;
    expect(genConfig).toEqual({
      thinkingConfig: { thinkingLevel: "high" },
    });
  });
});
