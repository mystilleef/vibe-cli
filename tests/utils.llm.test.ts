import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { resetConstitution } from "../src/tools/constitution";
import {
  callProvider,
  FALLBACK_FEEDBACK,
  getGateDecision,
  getMentorFeedback,
  parseGateDecision,
  revisePlan,
  verifyConnection,
} from "../src/utils/llm";
import type { ProviderSpec } from "../src/utils/settings";
import { mockSettings } from "./helpers/mockSettings";
import { createTempHome, type TempHomeContext } from "./helpers/tempHome";

interface OpenAiCompatRequest {
  model: string;
  messages: Array<{ role: string; content: string }>;
  temperature?: number;
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

class MockOpenAI {
  private readonly options: MockOpenAiOptions;

  constructor(options: MockOpenAiOptions) {
    this.options = options;
  }

  chat = {
    completions: {
      create: async (request: OpenAiCompatRequest) => {
        openAiRequests.push({ options: this.options, request });
        return { choices: [{ message: { content: openAiResponseText } }] };
      },
    },
  };
}

mock.module("openai", () => ({ OpenAI: MockOpenAI }));

let geminiCalls: Array<{
  model: string;
  prompt: string;
  systemInstruction?: string;
  generationConfig?: { temperature?: number };
}> = [];
let geminiResponses: string[] = [];
let geminiErrorMessages: Array<string | undefined> = [];
let geminiApiKeys: string[] = [];

const mockGenAI = {
  getGenerativeModel: ({
    model,
    systemInstruction,
  }: {
    model: string;
    systemInstruction?: string;
  }) => ({
    generateContent: async (input: {
      contents: unknown;
      generationConfig?: { temperature?: number };
    }) => {
      geminiCalls.push({
        model,
        prompt: JSON.stringify(input.contents),
        ...(systemInstruction !== undefined && { systemInstruction }),
        ...(input.generationConfig !== undefined && {
          generationConfig: input.generationConfig,
        }),
      });
      const customError = geminiErrorMessages[geminiCalls.length - 1];
      if (customError !== undefined) throw new Error(customError);
      return { response: { text: () => geminiResponses.shift() ?? "" } };
    },
  }),
};

mock.module("@google/generative-ai", () => ({
  GoogleGenerativeAI: class {
    constructor(apiKey: string) {
      geminiApiKeys.push(apiKey);
    }

    getGenerativeModel = mockGenAI.getGenerativeModel;
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
  "USE_LEARNING_HISTORY",
] as const;

type ProviderKey = (typeof PROVIDER_KEYS)[number];
const savedEnv: Partial<Record<ProviderKey, string | undefined>> = {};

async function writeSettings(value: unknown): Promise<void> {
  await mkdir(tempHome.dataRoot, { recursive: true });
  await writeFile(
    join(tempHome.dataRoot, "settings.json"),
    JSON.stringify(value),
  );
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
  process.env["USE_LEARNING_HISTORY"] = "false";
  globalThis.fetch = originalFetch;
  fetchCalls.length = 0;
  openAiRequests.length = 0;
  openAiResponseText = "mock provider response";
  geminiCalls = [];
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
    expect(geminiCalls[0]?.model).toBe("gemini-default");
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
    expect(geminiCalls[0]?.model).toBe("gemini-default");
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
    expect(geminiCalls.map((call) => call.model)).toEqual([
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
    expect(geminiCalls).toHaveLength(0);
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
    expect(geminiCalls.map((call) => call.model)).toEqual(["gemini-pro"]);
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
    expect(geminiCalls.map((call) => call.model)).toEqual(["gemini-pro"]);
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
    process.env["USE_LEARNING_HISTORY"] = "false";
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
    process.env["USE_LEARNING_HISTORY"] = "false";
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
    process.env["USE_LEARNING_HISTORY"] = "false";
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
    process.env["USE_LEARNING_HISTORY"] = "false";
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
    process.env["USE_LEARNING_HISTORY"] = "false";
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
    process.env["USE_LEARNING_HISTORY"] = "false";
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
    process.env["USE_LEARNING_HISTORY"] = "false";
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
    process.env["USE_LEARNING_HISTORY"] = "false";
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

    expect(geminiCalls[0]?.generationConfig?.temperature).toBeUndefined();
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

    expect(geminiCalls[0]?.generationConfig?.temperature).toBe(0.7);
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

    expect(geminiCalls[0]?.generationConfig?.temperature).toBe(0);
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

    expect(geminiCalls[0]?.generationConfig?.temperature).toBe(0.1);
  });
});
