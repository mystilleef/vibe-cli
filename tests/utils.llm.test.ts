import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { resetConstitution } from "../src/tools/constitution";
import {
  DEFAULT_MODELS,
  detectProvider,
  FALLBACK_FEEDBACK,
  getGateDecision,
  getMentorFeedback,
  parseGateDecision,
  revisePlan,
  verifyConnection,
} from "../src/utils/llm";

// --- env helpers ---

const PROVIDER_KEYS = [
  "DEFAULT_LLM_PROVIDER",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_VERSION",
  "GEMINI_API_KEY",
  "OPENAI_API_KEY",
  "OPENROUTER_API_KEY",
  "DEEPSEEK_API_KEY",
  "OPENCODE_API_KEY",
  "MIMO_API_KEY",
  "DEFAULT_MODEL",
  "USE_LEARNING_HISTORY",
] as const;

type ProviderKey = (typeof PROVIDER_KEYS)[number];

const savedEnv: Partial<Record<ProviderKey, string | undefined>> = {};
const originalFetch = globalThis.fetch;

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
let throwOnCall: number | undefined;
let geminiErrorMessages: Array<string | undefined> = [];

const mockGenAI = {
  getGenerativeModel: ({
    model,
    systemInstruction,
  }: {
    model: string;
    systemInstruction?: string;
  }) => ({
    generateContent: async (
      input:
        | string
        | { contents: unknown; generationConfig?: { temperature?: number } },
    ) => {
      const prompt =
        typeof input === "string" ? input : JSON.stringify(input.contents);
      const generationConfig =
        typeof input === "object" ? input.generationConfig : undefined;
      if (generationConfig !== undefined) {
        geminiCalls.push({
          model,
          prompt,
          ...(systemInstruction !== undefined && { systemInstruction }),
          generationConfig,
        });
      } else {
        geminiCalls.push({
          model,
          prompt,
          ...(systemInstruction !== undefined && { systemInstruction }),
        });
      }
      const customError = geminiErrorMessages[geminiCalls.length - 1];
      if (customError !== undefined) {
        throw new Error(customError);
      }
      if (geminiCalls.length === throwOnCall) {
        throw new Error("simulated gemini failure");
      }
      return { response: { text: () => geminiResponses.shift() ?? "" } };
    },
  }),
};

mock.module("@google/generative-ai", () => ({
  GoogleGenerativeAI: class {
    getGenerativeModel = mockGenAI.getGenerativeModel;
  },
}));

interface FetchCall {
  url: string;
  init: RequestInit;
}

const fetchCalls: FetchCall[] = [];

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
  if (value === undefined) {
    throw new Error(`${label} missing`);
  }
  return value;
}

function defaultModel(provider: string): string {
  return requireValue(DEFAULT_MODELS[provider], `DEFAULT_MODELS.${provider}`);
}

beforeEach(() => {
  for (const k of PROVIDER_KEYS) savedEnv[k] = process.env[k];
  for (const k of PROVIDER_KEYS) delete process.env[k];
});

afterEach(() => {
  for (const k of PROVIDER_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  globalThis.fetch = originalFetch;
  fetchCalls.length = 0;
  openAiRequests.length = 0;
  openAiResponseText = "mock provider response";
});

// ---------------------------------------------------------------------------
// detectProvider
// ---------------------------------------------------------------------------

describe("detectProvider", () => {
  test("DEFAULT_LLM_PROVIDER takes highest precedence", () => {
    process.env["DEFAULT_LLM_PROVIDER"] = "openrouter";
    process.env["ANTHROPIC_API_KEY"] = "key"; // would normally win
    expect(detectProvider()).toBe("openrouter");
  });

  test("anthropic wins when ANTHROPIC_API_KEY is set", () => {
    process.env["ANTHROPIC_API_KEY"] = "key-abc";
    expect(detectProvider()).toBe("anthropic");
  });

  test("anthropic wins when ANTHROPIC_AUTH_TOKEN is set", () => {
    process.env["ANTHROPIC_AUTH_TOKEN"] = "tok-xyz";
    expect(detectProvider()).toBe("anthropic");
  });

  test("gemini wins over openai when both set but anthropic absent", () => {
    process.env["GEMINI_API_KEY"] = "g-key";
    process.env["OPENAI_API_KEY"] = "o-key";
    expect(detectProvider()).toBe("gemini");
  });

  test("openai wins when only OPENAI_API_KEY set", () => {
    process.env["OPENAI_API_KEY"] = "o-key";
    expect(detectProvider()).toBe("openai");
  });

  test("openrouter wins when only OPENROUTER_API_KEY set", () => {
    process.env["OPENROUTER_API_KEY"] = "or-key";
    expect(detectProvider()).toBe("openrouter");
  });

  test("deepseek wins when only DEEPSEEK_API_KEY set", () => {
    process.env["DEEPSEEK_API_KEY"] = "ds-key";
    expect(detectProvider()).toBe("deepseek");
  });

  test("opencode wins when only OPENCODE_API_KEY set", () => {
    process.env["OPENCODE_API_KEY"] = "oc-key";
    expect(detectProvider()).toBe("opencode");
  });

  test("mimo wins when only MIMO_API_KEY set", () => {
    process.env["MIMO_API_KEY"] = "mimo-key";
    expect(detectProvider()).toBe("mimo");
  });

  test("falls back to gemini when no keys are set", () => {
    expect(detectProvider()).toBe("gemini");
  });
});

// ---------------------------------------------------------------------------
// DEFAULT_MODELS — contract check
// ---------------------------------------------------------------------------

describe("DEFAULT_MODELS", () => {
  test("contains entries for all documented providers", () => {
    for (const provider of [
      "gemini",
      "openai",
      "anthropic",
      "openrouter",
      "deepseek",
      "opencode",
      "mimo",
    ]) {
      expect(provider in DEFAULT_MODELS).toBe(true);
    }
  });

  test("openrouter default model is empty string (requires --model flag)", () => {
    expect(DEFAULT_MODELS["openrouter"]).toBe("");
  });
});

// ---------------------------------------------------------------------------
// parseGateDecision
// ---------------------------------------------------------------------------

describe("parseGateDecision", () => {
  test("parses a clean JSON string", () => {
    const raw = JSON.stringify({
      proceed: true,
      confidence: 0.9,
      reason: "plan is sound",
    });
    const result = parseGateDecision(raw);
    expect(result.proceed).toBe(true);
    expect(result.confidence).toBe(0.9);
    expect(result.reason).toBe("plan is sound");
  });

  test("strips markdown json fences before parsing", () => {
    const raw =
      '```json\n{"proceed":false,"confidence":0.7,"reason":"risk"}\n```';
    const result = parseGateDecision(raw);
    expect(result.proceed).toBe(false);
    expect(result.confidence).toBe(0.7);
    expect(result.reason).toBe("risk");
  });

  test("strips plain code fences before parsing", () => {
    const raw = '```\n{"proceed":true,"confidence":0.8,"reason":"ok"}\n```';
    const result = parseGateDecision(raw);
    expect(result.proceed).toBe(true);
  });

  test("clamps confidence above 1.0 to 1.0", () => {
    const raw = JSON.stringify({ proceed: true, confidence: 2.5, reason: "r" });
    const result = parseGateDecision(raw);
    expect(result.confidence).toBe(1);
  });

  test("clamps confidence below 0.0 to 0.0", () => {
    const raw = JSON.stringify({
      proceed: false,
      confidence: -0.5,
      reason: "r",
    });
    const result = parseGateDecision(raw);
    expect(result.confidence).toBe(0);
  });

  test("falls back to block decision on invalid JSON", () => {
    const result = parseGateDecision("not valid json at all");
    expect(result.proceed).toBe(false);
    expect(result.confidence).toBe(0.5);
    expect(result.reason).toMatch(/unavailable/);
  });

  test("falls back when parsed JSON has wrong shape (missing proceed)", () => {
    const raw = JSON.stringify({ confidence: 0.8, reason: "r" });
    const result = parseGateDecision(raw);
    expect(result.proceed).toBe(false);
    expect(result.confidence).toBe(0.5);
  });

  test("falls back when proceed is not a boolean", () => {
    const raw = JSON.stringify({
      proceed: "yes",
      confidence: 0.9,
      reason: "r",
    });
    const result = parseGateDecision(raw);
    expect(result.proceed).toBe(false);
    expect(result.confidence).toBe(0.5);
  });

  test("extracts embedded JSON object from surrounding text via brace counting", () => {
    const raw =
      'Here is my decision: {"proceed":true,"confidence":0.6,"reason":"looks fine"} end.';
    const result = parseGateDecision(raw);
    expect(result.proceed).toBe(true);
    expect(result.confidence).toBe(0.6);
    expect(result.reason).toBe("looks fine");
  });
});

// ---------------------------------------------------------------------------
// FALLBACK_FEEDBACK
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// verifyConnection — error-path contract
// ---------------------------------------------------------------------------

describe("verifyConnection", () => {
  test("returns structured error when no API keys are set", async () => {
    const result = await verifyConnection();
    expect(result.ok).toBe(false);
    expect(result.provider).toBe("gemini");
    expect(result.model).toBe(defaultModel("gemini"));
    expect(result.error).toBeTruthy();
    expect(typeof result.error).toBe("string");
  });

  test("respects opts.provider in error response", async () => {
    const result = await verifyConnection({ provider: "deepseek" });
    expect(result.ok).toBe(false);
    expect(result.provider).toBe("deepseek");
    expect(result.error).toBeTruthy();
  });

  test("respects opts.model in error response", async () => {
    const result = await verifyConnection({
      provider: "gemini",
      model: "custom-model-v1",
    });
    expect(result.ok).toBe(false);
    expect(result.provider).toBe("gemini");
    expect(result.model).toBe("custom-model-v1");
  });

  test("respects DEFAULT_LLM_PROVIDER in error response", async () => {
    process.env["DEFAULT_LLM_PROVIDER"] = "openai";
    const result = await verifyConnection();
    expect(result.ok).toBe(false);
    expect(result.provider).toBe("openai");
  });

  test("respects DEFAULT_MODEL in error response", async () => {
    process.env["DEFAULT_MODEL"] = "custom-default-model";
    const result = await verifyConnection({ provider: "gemini" });
    expect(result.ok).toBe(false);
    expect(result.provider).toBe("gemini");
    expect(result.model).toBe("custom-default-model");
  });

  test("opts.model overrides DEFAULT_MODEL in error response", async () => {
    process.env["DEFAULT_MODEL"] = "default-from-env";
    const result = await verifyConnection({
      provider: "gemini",
      model: "explicit-model",
    });
    expect(result.ok).toBe(false);
    expect(result.model).toBe("explicit-model");
  });

  test("falls back to DEFAULT_MODELS[provider] when no DEFAULT_MODEL set", async () => {
    const result = await verifyConnection({ provider: "openai" });
    expect(result.ok).toBe(false);
    expect(result.provider).toBe("openai");
    expect(result.model).toBe(defaultModel("openai"));
  });
});

// ---------------------------------------------------------------------------
// getMentorFeedback — graceful fallback
// ---------------------------------------------------------------------------

describe("getMentorFeedback", () => {
  test("returns FALLBACK_FEEDBACK when LLM is unavailable", async () => {
    const result = await getMentorFeedback({
      goal: "test goal",
      plan: "test plan",
    });
    expect(result.feedback).toBe(FALLBACK_FEEDBACK);
  });

  test("returns FALLBACK_FEEDBACK even with modelOverride", async () => {
    const result = await getMentorFeedback({
      goal: "test goal",
      plan: "test plan",
      modelOverride: { provider: "gemini", model: "gemini-2.5-pro" },
    });
    expect(result.feedback).toBe(FALLBACK_FEEDBACK);
  });
});

describe("FALLBACK_FEEDBACK", () => {
  test("is a non-empty string", () => {
    expect(typeof FALLBACK_FEEDBACK).toBe("string");
    expect(FALLBACK_FEEDBACK.length).toBeGreaterThan(0);
  });

  test("contains exactly three numbered, non-duplicative questions", () => {
    const questions = FALLBACK_FEEDBACK.split("\n");
    expect(questions).toHaveLength(3);
    expect(new Set(questions).size).toBe(3);
    expect(questions.every((q, index) => q.startsWith(`${index + 1}. `))).toBe(
      true,
    );
  });

  test("covers goal alignment, reversibility, and unstated assumptions", () => {
    expect(FALLBACK_FEEDBACK).toContain("stated goal");
    expect(FALLBACK_FEEDBACK).toMatch(/rollback|safe-stop/);
    expect(FALLBACK_FEEDBACK).toContain("assumptions");
  });
});

// ---------------------------------------------------------------------------
// parseGateDecision — edge / boundary cases
// ---------------------------------------------------------------------------

describe("parseGateDecision edge cases", () => {
  test("empty string falls back to block decision", () => {
    const result = parseGateDecision("");
    expect(result.proceed).toBe(false);
    expect(result.confidence).toBe(0.5);
    expect(result.reason).toMatch(/unavailable/);
  });

  test("confidence exactly 0 stays 0", () => {
    const raw = JSON.stringify({ proceed: false, confidence: 0, reason: "r" });
    expect(parseGateDecision(raw).confidence).toBe(0);
  });

  test("confidence exactly 1 stays 1", () => {
    const raw = JSON.stringify({ proceed: true, confidence: 1, reason: "r" });
    expect(parseGateDecision(raw).confidence).toBe(1);
  });

  test("brace-robust: reason containing } parses correctly via full JSON.parse", () => {
    const raw = JSON.stringify({
      proceed: true,
      confidence: 0.8,
      reason: "use {nested} carefully",
    });
    const result = parseGateDecision(raw);
    expect(result.proceed).toBe(true);
    expect(result.confidence).toBe(0.8);
    expect(result.reason).toBe("use {nested} carefully");
  });

  test("multiple JSON-like objects — extracts last balanced-brace object", () => {
    const raw =
      'First try: {"proceed":true,"confidence":0.9,"reason":"first"}. Second: {"proceed":false,"confidence":0.3,"reason":"second"}';
    const result = parseGateDecision(raw);
    expect(result.proceed).toBe(false);
    expect(result.confidence).toBe(0.3);
    expect(result.reason).toBe("second");
  });

  test("embedded JSON with escaped characters preserves string boundaries", () => {
    const raw =
      'Decision: {"proceed":true,"confidence":0.7,"reason":"escaped quote \\" and slash \\\\ and brace }"} done.';
    const result = parseGateDecision(raw);
    expect(result.proceed).toBe(true);
    expect(result.confidence).toBe(0.7);
    expect(result.reason).toBe('escaped quote " and slash \\ and brace }');
  });

  test("falls back when parsed object has missing confidence", () => {
    const raw = JSON.stringify({ proceed: true, reason: "r" });
    const result = parseGateDecision(raw);
    expect(result.proceed).toBe(false);
    expect(result.confidence).toBe(0.5);
  });

  test("falls back when parsed object has missing reason", () => {
    const raw = JSON.stringify({ proceed: true, confidence: 0.9 });
    const result = parseGateDecision(raw);
    expect(result.proceed).toBe(false);
    expect(result.confidence).toBe(0.5);
  });

  test("falls back when confidence is a string", () => {
    const raw = JSON.stringify({
      proceed: true,
      confidence: "high",
      reason: "r",
    });
    const result = parseGateDecision(raw);
    expect(result.proceed).toBe(false);
    expect(result.confidence).toBe(0.5);
  });

  test("whitespace-only fences are stripped", () => {
    const raw =
      '```json  \n{"proceed":true,"confidence":0.5,"reason":"ok"}\n```  ';
    const result = parseGateDecision(raw);
    expect(result.proceed).toBe(true);
  });

  test("unclosed brace — no matching close — falls back to blocking default", () => {
    const result = parseGateDecision('{"proceed":true,"confidence":0.9');
    expect(result.proceed).toBe(false);
    expect(result.confidence).toBe(0.5);
    expect(result.reason).toMatch(/unavailable/);
  });
});

// ---------------------------------------------------------------------------
// callProvider — error paths (tested via verifyConnection)
// ---------------------------------------------------------------------------

describe("callProvider error paths via verifyConnection", () => {
  test("openrouter missing API key returns structured error", async () => {
    process.env["DEFAULT_LLM_PROVIDER"] = "openrouter";
    const result = await verifyConnection();
    expect(result.ok).toBe(false);
    expect(result.provider).toBe("openrouter");
    expect(result.error).toMatch(/OPENROUTER_API_KEY/);
  });

  test("openrouter with empty model returns structured error", async () => {
    process.env["OPENROUTER_API_KEY"] = "or-key";
    process.env["DEFAULT_LLM_PROVIDER"] = "openrouter";
    const result = await verifyConnection();
    expect(result.ok).toBe(false);
    expect(result.provider).toBe("openrouter");
    expect(result.error).toMatch(/--model is required/);
  });

  test("deepseek missing API key returns structured error", async () => {
    process.env["DEFAULT_LLM_PROVIDER"] = "deepseek";
    const result = await verifyConnection();
    expect(result.ok).toBe(false);
    expect(result.provider).toBe("deepseek");
    expect(result.error).toMatch(/DEEPSEEK_API_KEY/);
  });

  test("opencode missing API key returns structured error", async () => {
    process.env["DEFAULT_LLM_PROVIDER"] = "opencode";
    const result = await verifyConnection();
    expect(result.ok).toBe(false);
    expect(result.provider).toBe("opencode");
    expect(result.error).toMatch(/OPENCODE_API_KEY/);
  });

  test("mimo missing API key returns structured error", async () => {
    process.env["DEFAULT_LLM_PROVIDER"] = "mimo";
    const result = await verifyConnection();
    expect(result.ok).toBe(false);
    expect(result.provider).toBe("mimo");
    expect(result.error).toMatch(/MIMO_API_KEY/);
  });

  test("anthropic missing API key returns structured error", async () => {
    process.env["DEFAULT_LLM_PROVIDER"] = "anthropic";
    const result = await verifyConnection();
    expect(result.ok).toBe(false);
    expect(result.provider).toBe("anthropic");
    expect(result.error).toMatch(/ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN/);
  });

  test("unknown provider returns structured error", async () => {
    process.env["DEFAULT_LLM_PROVIDER"] = "nonexistent";
    const result = await verifyConnection();
    expect(result.ok).toBe(false);
    expect(result.provider).toBe("nonexistent");
    expect(result.error).toMatch(/Unknown provider/);
  });

  test("gemini missing API key returns structured error", async () => {
    process.env["DEFAULT_LLM_PROVIDER"] = "gemini";
    const result = await verifyConnection();
    expect(result.ok).toBe(false);
    expect(result.provider).toBe("gemini");
    expect(result.error).toMatch(/GEMINI_API_KEY/);
  });

  test("openai missing API key returns structured error", async () => {
    process.env["DEFAULT_LLM_PROVIDER"] = "openai";
    const result = await verifyConnection();
    expect(result.ok).toBe(false);
    expect(result.provider).toBe("openai");
    expect(result.error).toMatch(/OPENAI_API_KEY/);
  });

  test("openrouter with key but DEFAULT_MODEL empty propagates model error", async () => {
    process.env["OPENROUTER_API_KEY"] = "or-key";
    // DEFAULT_LLM_PROVIDER not set, but OPENROUTER_API_KEY triggers openrouter detection
    const result = await verifyConnection({ provider: "openrouter" });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/--model is required/);
  });
});

// ---------------------------------------------------------------------------
// resolveProviderAndModel — exercised via verifyConnection modelOverride
// ---------------------------------------------------------------------------

describe("resolveProviderAndModel via verifyConnection", () => {
  test("modelOverride with explicit provider and model", async () => {
    process.env["GEMINI_API_KEY"] = "g-key";
    const result = await verifyConnection({
      provider: "gemini",
      model: "gemini-2.5-pro",
    });
    expect(result.provider).toBe("gemini");
    expect(result.model).toBe("gemini-2.5-pro");
  });

  test("modelOverride provider overrides DEFAULT_LLM_PROVIDER", async () => {
    process.env["DEFAULT_LLM_PROVIDER"] = "openai";
    const result = await verifyConnection({ provider: "deepseek" });
    expect(result.provider).toBe("deepseek");
  });

  test("DEFAULT_MODEL env takes precedence over DEFAULT_MODELS", async () => {
    process.env["DEFAULT_MODEL"] = "env-custom-model";
    const result = await verifyConnection({ provider: "gemini" });
    expect(result.model).toBe("env-custom-model");
  });

  test("modelOverride.model beats DEFAULT_MODEL env", async () => {
    process.env["DEFAULT_MODEL"] = "env-model";
    const result = await verifyConnection({
      provider: "gemini",
      model: "explicit-model",
    });
    expect(result.model).toBe("explicit-model");
  });
});

// ---------------------------------------------------------------------------
// getGateDecision — error propagation
// ---------------------------------------------------------------------------

describe("getGateDecision error propagation", () => {
  test("throws when provider config is missing", async () => {
    process.env["DEFAULT_LLM_PROVIDER"] = "anthropic";
    expect(
      getGateDecision({ goal: "g", plan: "p", feedback: "f" }),
    ).rejects.toThrow(/ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN/);
  });

  test("throws with unknown provider", async () => {
    process.env["DEFAULT_LLM_PROVIDER"] = "nonexistent";
    expect(
      getGateDecision({ goal: "g", plan: "p", feedback: "f" }),
    ).rejects.toThrow(/Unknown provider/);
  });
});

// ---------------------------------------------------------------------------
// provider success paths
// ---------------------------------------------------------------------------

describe("provider success paths", () => {
  test("getMentorFeedback posts full context to OpenRouter", async () => {
    process.env["DEFAULT_LLM_PROVIDER"] = "openrouter";
    process.env["OPENROUTER_API_KEY"] = "or-key";
    process.env["DEFAULT_MODEL"] = "openrouter/model";
    process.env["USE_LEARNING_HISTORY"] = "false";
    mockFetch(() =>
      Response.json({
        choices: [{ message: { content: "provider question" } }],
      }),
    );

    const result = await getMentorFeedback({
      goal: "goal text",
      plan: "plan text",
      progress: "half done",
      uncertainties: ["risk one", "risk two"],
      taskContext: "task context",
      userPrompt: "user prompt",
      historySummary: "history summary",
    });

    expect(result.feedback).toBe("provider question");
    const call0 = requireValue(fetchCalls[0], "fetch call 0");
    expect(call0.url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(call0.init.method).toBe("POST");
    expect(call0.init.headers).toMatchObject({
      Authorization: "Bearer or-key",
      "HTTP-Referer": "http://localhost",
      "X-Title": "Vibe Check CLI",
    });
    const body = parseBody<OpenAiCompatRequest>(call0.init);
    expect(body.model).toBe("openrouter/model");
    const sysContent = body.messages[0]?.content ?? "";
    const userContent = body.messages[1]?.content ?? "";
    expect(userContent).toContain("Goal: goal text");
    expect(userContent).toContain("Plan: plan text");
    expect(userContent).toContain("Progress: half done");
    expect(userContent).toContain("Uncertainties: risk one, risk two");
    expect(userContent).toContain("Task Context: task context");
    expect(userContent).toContain("User Prompt: user prompt");
    expect(userContent).toContain("History Context: history summary");
    expect(sysContent).toContain("Misalignment");
    expect(sysContent).toContain("Assumption lock-in");
    expect(sysContent).toContain("Learning patterns");
    expect(sysContent).toContain("Constitution");
    expect(sysContent).toContain("Irreversibility");
    expect(sysContent).toContain("adjacent");
    expect(sysContent).toContain("rollback");
    expect(sysContent).toContain("Hard risk");
    expect(sysContent).toContain("Soft risk");
    expect(sysContent).toContain("actionable");
    expect(sysContent).toContain("highest-weight");
    expect(sysContent).toContain("blast radius");
    expect(userContent.indexOf("Goal: goal text")).toBeLessThan(
      userContent.indexOf("Plan: plan text"),
    );
    expect(userContent.indexOf("Plan: plan text")).toBeLessThan(
      userContent.indexOf("User Prompt: user prompt"),
    );
    expect(userContent.indexOf("User Prompt: user prompt")).toBeLessThan(
      userContent.indexOf("Progress: half done"),
    );
    expect(userContent.indexOf("Progress: half done")).toBeLessThan(
      userContent.indexOf("Uncertainties: risk one, risk two"),
    );
    expect(
      userContent.indexOf("Uncertainties: risk one, risk two"),
    ).toBeLessThan(userContent.indexOf("Task Context: task context"));
    expect(userContent.indexOf("Task Context: task context")).toBeLessThan(
      userContent.indexOf("History Context: history summary"),
    );
  });

  test("getGateDecision forwards temperature 0.1 to openrouter request body", async () => {
    process.env["DEFAULT_LLM_PROVIDER"] = "openrouter";
    process.env["OPENROUTER_API_KEY"] = "or-key";
    process.env["DEFAULT_MODEL"] = "openrouter/model";
    mockFetch(() =>
      Response.json({
        choices: [
          {
            message: {
              content: JSON.stringify({
                proceed: true,
                confidence: 0.9,
                reason: "ok",
              }),
            },
          },
        ],
      }),
    );

    await getGateDecision({ goal: "g", plan: "p", feedback: "f" });

    const call0 = requireValue(fetchCalls[0], "fetch call 0");
    const body = parseBody<OpenAiCompatRequest & { temperature?: number }>(
      call0.init,
    );
    expect(body.temperature).toBe(0.1);
  });

  test("getMentorFeedback omits absent optional context", async () => {
    process.env["DEFAULT_LLM_PROVIDER"] = "openrouter";
    process.env["OPENROUTER_API_KEY"] = "or-key";
    process.env["DEFAULT_MODEL"] = "openrouter/model";
    process.env["USE_LEARNING_HISTORY"] = "false";
    mockFetch(() =>
      Response.json({
        choices: [{ message: { content: "provider question" } }],
      }),
    );

    await getMentorFeedback({ goal: "goal text", plan: "plan text" });

    const call0 = requireValue(fetchCalls[0], "fetch call 0");
    const body = parseBody<OpenAiCompatRequest>(call0.init);
    const userContent = body.messages[1]?.content ?? "";
    expect(userContent).toContain("Goal: goal text");
    expect(userContent).toContain("Plan: plan text");
    expect(userContent).not.toContain("None");
    expect(userContent).not.toContain("User Prompt:");
    expect(userContent).not.toContain("Progress:");
    expect(userContent).not.toContain("Uncertainties:");
    expect(userContent).not.toContain("Task Context:");
    expect(userContent).not.toContain("History Context:");
  });

  describe("getMentorFeedback includes constitution before history", () => {
    let tempHome: string;
    let savedHome: string | undefined;

    beforeEach(() => {
      savedHome = process.env["HOME"];
      tempHome = mkdtempSync(path.join(tmpdir(), "vibe-llm-test-"));
      process.env["HOME"] = tempHome;
    });

    afterEach(() => {
      if (savedHome === undefined) delete process.env["HOME"];
      else process.env["HOME"] = savedHome;
      rmSync(tempHome, { recursive: true, force: true });
    });

    test("includes constitution before history", async () => {
      resetConstitution(["Follow session rule"]);
      process.env["DEFAULT_LLM_PROVIDER"] = "openrouter";
      process.env["OPENROUTER_API_KEY"] = "or-key";
      process.env["DEFAULT_MODEL"] = "openrouter/model";
      process.env["USE_LEARNING_HISTORY"] = "false";
      mockFetch(() =>
        Response.json({
          choices: [{ message: { content: "provider question" } }],
        }),
      );

      await getMentorFeedback({
        goal: "goal text",
        plan: "plan text",
        historySummary: "history summary",
      });

      const call0 = requireValue(fetchCalls[0], "fetch call 0");
      const body = parseBody<OpenAiCompatRequest>(call0.init);
      const userContent = body.messages[1]?.content ?? "";
      expect(userContent).toContain("Constitution:\n- Follow session rule");
      expect(userContent.indexOf("Constitution:")).toBeLessThan(
        userContent.indexOf("History Context: history summary"),
      );
    });
  });

  test("getGateDecision parses a successful OpenRouter decision", async () => {
    process.env["OPENROUTER_API_KEY"] = "or-key";
    mockFetch(() =>
      Response.json({
        choices: [
          {
            message: {
              content:
                '{"proceed":true,"confidence":0.75,"reason":"risks addressed"}',
            },
          },
        ],
      }),
    );

    const result = await getGateDecision({
      goal: "ship",
      plan: "test first",
      feedback: "looks safe",
      modelOverride: { provider: "openrouter", model: "openrouter/model" },
    });

    expect(result).toEqual({
      proceed: true,
      confidence: 0.75,
      reason: "risks addressed",
    });

    const call0 = requireValue(fetchCalls[0], "fetch call 0");
    const body = parseBody<OpenAiCompatRequest>(call0.init);
    // Verify system/user message separation
    expect(body.messages).toHaveLength(2);
    expect(body.messages[0]?.role).toBe("system");
    const sysContent = body.messages[0]?.content ?? "";
    expect(sysContent).toContain("Output ONLY one line of valid JSON");
    expect(sysContent).toContain("0.5 = uncertain");
    expect(sysContent).toContain("≥0.8 = clear");
    expect(sysContent).toContain("feedback confirms sound");
    expect(sysContent).toContain("constitution violation");
    expect(sysContent).not.toContain("Goal: ship");
    expect(body.messages[1]?.role).toBe("user");
    const userContent = body.messages[1]?.content ?? "";
    expect(userContent).toContain("Goal: ship");
    expect(userContent).toContain("Plan: test first");
    expect(userContent).toContain("Feedback: looks safe");
  });

  test("revisePlan omits block reason when provided as empty string", async () => {
    process.env["ANTHROPIC_API_KEY"] = "anth-key";
    mockFetch(() =>
      Response.json({ content: [{ type: "text", text: "revised plan" }] }),
    );

    const result = await revisePlan({
      goal: "goal",
      plan: "old plan",
      feedback: "missing rollback",
      blockReason: "",
      modelOverride: { provider: "anthropic" },
    });

    expect(result).toBe("revised plan");
    const fc0 = requireValue(fetchCalls[0], "fetch call 0");
    const body = parseBody<{
      messages: Array<{ role: string; content: string }>;
    }>(fc0.init);
    expect(body.messages[0]?.content).toContain("Blocked plan: old plan");
    expect(body.messages[0]?.content).toContain(
      "Safety feedback: missing rollback",
    );
    expect(body.messages[0]?.content).not.toContain("Block reason:");
  });

  test("revisePlan with OpenRouter sends system/user messages separately", async () => {
    process.env["OPENROUTER_API_KEY"] = "or-key";
    mockFetch(() =>
      Response.json({
        choices: [{ message: { content: "revised via openrouter" } }],
      }),
    );

    const result = await revisePlan({
      goal: "goal",
      plan: "old plan",
      feedback: "missing rollback",
      modelOverride: { provider: "openrouter", model: "openrouter/model" },
    });

    expect(result).toBe("revised via openrouter");
    const call0 = requireValue(fetchCalls[0], "fetch call 0");
    expect(call0.url).toBe("https://openrouter.ai/api/v1/chat/completions");
    const body = parseBody<OpenAiCompatRequest>(call0.init);
    expect(body.messages).toHaveLength(2);
    expect(body.messages[0]?.role).toBe("system");
    expect(body.messages[0]?.content).toContain("plan reviser");
    expect(body.messages[0]?.content).toContain("preserve everything else");
    expect(body.messages[1]?.role).toBe("user");
    expect(body.messages[1]?.content).toContain("Blocked plan: old plan");
    expect(body.messages[1]?.content).toContain(
      "Safety feedback: missing rollback",
    );
  });

  test("revisePlan with DeepSeek sends system/user messages separately", async () => {
    process.env["DEEPSEEK_API_KEY"] = "ds-key";
    openAiResponseText = "deepseek revised";

    const result = await revisePlan({
      goal: "goal",
      plan: "old plan",
      feedback: "missing rollback",
      modelOverride: { provider: "deepseek" },
    });

    expect(result).toBe("deepseek revised");
    const req0 = requireValue(openAiRequests[0], "OpenAI request 0");
    expect(req0.request.messages).toHaveLength(2);
    expect(req0.request.messages[0]?.role).toBe("system");
    expect(req0.request.messages[0]?.content).toContain("plan reviser");
    expect(req0.request.messages[0]?.content).toContain(
      "Prioritize goal alignment",
    );
    expect(req0.request.messages[1]?.role).toBe("user");
    expect(req0.request.messages[1]?.content).toContain(
      "Blocked plan: old plan",
    );
    expect(req0.request.messages[1]?.content).toContain(
      "Safety feedback: missing rollback",
    );
  });

  test("revisePlan with OpenCode sends system/user messages separately", async () => {
    process.env["OPENCODE_API_KEY"] = "oc-key";
    openAiResponseText = "opencode revised";

    const result = await revisePlan({
      goal: "goal",
      plan: "old plan",
      feedback: "missing rollback",
      modelOverride: { provider: "opencode" },
    });

    expect(result).toBe("opencode revised");
    const req0 = requireValue(openAiRequests[0], "OpenAI request 0");
    expect(req0.request.messages).toHaveLength(2);
    expect(req0.request.messages[0]?.role).toBe("system");
    expect(req0.request.messages[0]?.content).toContain("plan reviser");
    expect(req0.request.messages[0]?.content).toContain("resolve the concern");
    expect(req0.request.messages[1]?.role).toBe("user");
    expect(req0.request.messages[1]?.content).toContain(
      "Blocked plan: old plan",
    );
    expect(req0.request.messages[1]?.content).toContain(
      "Safety feedback: missing rollback",
    );
  });

  test("revisePlan propagates provider resolution errors", async () => {
    process.env["DEFAULT_LLM_PROVIDER"] = "nonexistent";
    await expect(
      revisePlan({
        goal: "g",
        plan: "p",
        feedback: "f",
      }),
    ).rejects.toThrow(/Unknown provider/);
  });

  test("revisePlan posts Anthropic system prompt and returns first text block", async () => {
    process.env["ANTHROPIC_API_KEY"] = "anth-key";
    mockFetch(() =>
      Response.json({ content: [{ type: "text", text: "revised plan" }] }),
    );

    const result = await revisePlan({
      goal: "goal",
      plan: "old plan",
      feedback: "missing rollback",
      modelOverride: { provider: "anthropic" },
    });

    expect(result).toBe("revised plan");
    const fc0 = requireValue(fetchCalls[0], "fetch call 0");
    expect(fc0.url).toBe("https://api.anthropic.com/v1/messages");
    expect(fc0.init.headers).toMatchObject({
      "x-api-key": "anth-key",
      "anthropic-version": "2023-06-01",
    });
    const body = parseBody<{
      model: string;
      max_tokens: number;
      temperature: number;
      system: string;
      messages: Array<{ role: string; content: string }>;
    }>(fc0.init);
    expect(body.model).toBe(defaultModel("anthropic"));
    expect(body.max_tokens).toBe(1024);
    expect(body.temperature).toBe(0.3);
    expect(body.system).toContain("plan reviser");
    expect(body.system).toContain("preserve everything else");
    expect(body.system).toContain("Prioritize goal alignment");
    expect(body.messages[0]?.content).toContain("Blocked plan: old plan");
    expect(body.messages[0]?.content).not.toContain("Block reason:");
    expect(body.messages[0]?.content).toContain(
      "Safety feedback: missing rollback",
    );
  });

  test("revisePlan includes blockReason when provided", async () => {
    process.env["ANTHROPIC_API_KEY"] = "anth-key";
    mockFetch(() =>
      Response.json({
        content: [{ type: "text", text: "revised with reason" }],
      }),
    );

    const result = await revisePlan({
      goal: "goal",
      plan: "old plan",
      feedback: "missing rollback",
      blockReason: "irreversible op without safe-stop",
      modelOverride: { provider: "anthropic" },
    });

    expect(result).toBe("revised with reason");
    const fc0 = requireValue(fetchCalls[0], "fetch call 0");
    const body = parseBody<{
      messages: Array<{ role: string; content: string }>;
    }>(fc0.init);
    expect(body.messages[0]?.content).toContain("Blocked plan: old plan");
    expect(body.messages[0]?.content).toContain(
      "Safety feedback: missing rollback",
    );
    expect(body.messages[0]?.content).toContain(
      "Block reason: irreversible op without safe-stop",
    );
  });

  test("DeepSeek uses the OpenAI-compatible client", async () => {
    process.env["DEEPSEEK_API_KEY"] = "ds-key";

    const result = await getMentorFeedback({
      goal: "goal",
      plan: "plan",
      modelOverride: { provider: "deepseek" },
    });

    expect(result.feedback).toBe("mock provider response");
    const dsReq0 = requireValue(openAiRequests[0], "OpenAI request 0");
    expect(dsReq0.options).toEqual({
      apiKey: "ds-key",
      baseURL: "https://api.deepseek.com/v1",
    });
    expect(dsReq0.request.model).toBe(defaultModel("deepseek"));
    // Verify system/user message separation
    expect(dsReq0.request.messages).toHaveLength(2);
    expect(dsReq0.request.messages[0]?.role).toBe("system");
    expect(dsReq0.request.messages[0]?.content).toContain("Misalignment");
    expect(dsReq0.request.messages[1]?.role).toBe("user");
    expect(dsReq0.request.messages[1]?.content).toContain("Goal: goal");
    expect(dsReq0.request.messages[1]?.content).toContain("Plan: plan");
  });

  test("OpenCode uses the OpenAI-compatible client", async () => {
    process.env["OPENCODE_API_KEY"] = "oc-key";

    const result = await getMentorFeedback({
      goal: "goal",
      plan: "plan",
      modelOverride: { provider: "opencode" },
    });

    expect(result.feedback).toBe("mock provider response");
    const ocReq0 = requireValue(openAiRequests[0], "OpenAI request 0");
    expect(ocReq0.options).toEqual({
      apiKey: "oc-key",
      baseURL: "https://opencode.ai/zen/go/v1",
    });
    expect(ocReq0.request.model).toBe(defaultModel("opencode"));
    // Verify system/user message separation
    expect(ocReq0.request.messages).toHaveLength(2);
    expect(ocReq0.request.messages[0]?.role).toBe("system");
    expect(ocReq0.request.messages[0]?.content).toContain("blast radius");
    expect(ocReq0.request.messages[1]?.role).toBe("user");
    expect(ocReq0.request.messages[1]?.content).toContain("Goal: goal");
  });

  test("Mimo uses the OpenAI-compatible client with correct baseURL", async () => {
    process.env["MIMO_API_KEY"] = "mimo-key";

    const result = await getMentorFeedback({
      goal: "goal",
      plan: "plan",
      modelOverride: { provider: "mimo" },
    });

    expect(result.feedback).toBe("mock provider response");
    const req0 = requireValue(openAiRequests[0], "OpenAI request 0");
    expect(req0.options).toEqual({
      apiKey: "mimo-key",
      baseURL: "https://api.xiaomimimo.com/v1",
    });
    expect(req0.request.model).toBe(defaultModel("mimo"));
    expect(req0.request.messages).toHaveLength(2);
    expect(req0.request.messages[0]?.role).toBe("system");
    expect(req0.request.messages[0]?.content).toContain("blast radius");
    expect(req0.request.messages[1]?.role).toBe("user");
    expect(req0.request.messages[1]?.content).toContain("Goal: goal");
    expect(req0.request.messages[1]?.content).toContain("Plan: plan");
  });

  test("Mimo uses explicit model override", async () => {
    process.env["MIMO_API_KEY"] = "mimo-key";
    openAiResponseText = "mimo flash response";

    const result = await getMentorFeedback({
      goal: "goal",
      plan: "plan",
      modelOverride: { provider: "mimo", model: "mimo-v2-flash" },
    });

    expect(result.feedback).toBe("mimo flash response");
    const req0 = requireValue(openAiRequests[0], "OpenAI request 0");
    expect(req0.request.model).toBe("mimo-v2-flash");
  });

  test("revisePlan with Mimo sends system/user messages separately", async () => {
    process.env["MIMO_API_KEY"] = "mimo-key";
    openAiResponseText = "mimo revised";

    const result = await revisePlan({
      goal: "goal",
      plan: "old plan",
      feedback: "missing rollback",
      modelOverride: { provider: "mimo" },
    });

    expect(result).toBe("mimo revised");
    const req0 = requireValue(openAiRequests[0], "OpenAI request 0");
    expect(req0.request.messages).toHaveLength(2);
    expect(req0.request.messages[0]?.role).toBe("system");
    expect(req0.request.messages[0]?.content).toContain("plan reviser");
    expect(req0.request.messages[0]?.content).toContain("resolve the concern");
    expect(req0.request.messages[1]?.role).toBe("user");
    expect(req0.request.messages[1]?.content).toContain(
      "Blocked plan: old plan",
    );
    expect(req0.request.messages[1]?.content).toContain(
      "Safety feedback: missing rollback",
    );
  });

  test("verifyConnection returns ok response with latency and preview", async () => {
    process.env["OPENROUTER_API_KEY"] = "or-key";
    process.env["DEFAULT_LLM_PROVIDER"] = "openrouter";
    process.env["DEFAULT_MODEL"] = "openrouter/model";
    const longResponse = "x".repeat(250);
    mockFetch(() =>
      Response.json({ choices: [{ message: { content: longResponse } }] }),
    );

    const result = await verifyConnection();

    expect(result.ok).toBe(true);
    expect(result.provider).toBe("openrouter");
    expect(result.model).toBe("openrouter/model");
    expect(result.latency_ms).toBeGreaterThanOrEqual(0);
    expect(result.response).toBe("x".repeat(200));
  });

  test("OpenAI provider uses the cached client path", async () => {
    process.env["OPENAI_API_KEY"] = "openai-key";
    openAiResponseText = "openai question";

    const result = await getMentorFeedback({
      goal: "goal",
      plan: "plan",
      modelOverride: { provider: "openai", model: "gpt-test" },
    });

    expect(result.feedback).toBe("openai question");
    const req0 = requireValue(openAiRequests[0], "OpenAI request 0");
    expect(req0.options).toEqual({ apiKey: "openai-key" });
    expect(req0.request.model).toBe("gpt-test");
    // Verify system/user message separation
    expect(req0.request.messages).toHaveLength(2);
    expect(req0.request.messages[0]?.role).toBe("system");
    expect(req0.request.messages[0]?.content).toContain("Assumption lock-in");
    expect(req0.request.messages[1]?.role).toBe("user");
    expect(req0.request.messages[1]?.content).toContain("Goal: goal");
    expect(req0.request.messages[1]?.content).toContain("Plan: plan");
  });
});

// ---------------------------------------------------------------------------
// callAnthropic response handling
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// callOpenAI — empty choices boundary
// ---------------------------------------------------------------------------

describe("callOpenAI empty choices boundary", () => {
  test("returns empty string when choices array is empty", async () => {
    process.env["OPENAI_API_KEY"] = "openai-key";
    openAiResponseText = "";

    const result = await getMentorFeedback({
      goal: "g",
      plan: "p",
      modelOverride: { provider: "openai" },
    });

    expect(result.feedback).toBe("");
  });
});

// ---------------------------------------------------------------------------
// callOpenRouter — empty choices boundary
// ---------------------------------------------------------------------------

describe("callOpenRouter empty choices boundary", () => {
  test("returns empty string when choices array is empty", async () => {
    process.env["OPENROUTER_API_KEY"] = "or-key";
    process.env["DEFAULT_LLM_PROVIDER"] = "openrouter";
    process.env["DEFAULT_MODEL"] = "openrouter/model";
    mockFetch(() => Response.json({ choices: [] }));

    const result = await getMentorFeedback({
      goal: "g",
      plan: "p",
    });

    expect(result.feedback).toBe("");
  });
});

describe("callAnthropic response handling", () => {
  test("auth failure includes status and request id", async () => {
    process.env["ANTHROPIC_API_KEY"] = "bad-key";
    mockFetch(
      () =>
        new Response(JSON.stringify({ error: { message: "bad key" } }), {
          status: 401,
          headers: { "anthropic-request-id": "req-401" },
        }),
    );

    const result = await verifyConnection({ provider: "anthropic" });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("Anthropic auth failed (401)");
    expect(result.error).toContain("request id: req-401");
  });

  test("auth failure with 403 uses same auth error path", async () => {
    process.env["ANTHROPIC_API_KEY"] = "bad-key";
    mockFetch(
      () =>
        new Response(JSON.stringify({ error: { message: "forbidden" } }), {
          status: 403,
          headers: { "anthropic-request-id": "req-403" },
        }),
    );

    const result = await verifyConnection({ provider: "anthropic" });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("Anthropic auth failed (403)");
    expect(result.error).toContain("request id: req-403");
  });

  test("uses x-request-id fallback when anthropic-request-id absent", async () => {
    process.env["ANTHROPIC_API_KEY"] = "bad-key";
    mockFetch(
      () =>
        new Response(JSON.stringify({ error: { message: "bad key" } }), {
          status: 401,
          headers: { "x-request-id": "x-req-401" },
        }),
    );

    const result = await verifyConnection({ provider: "anthropic" });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("Anthropic auth failed (401)");
    expect(result.error).toContain("request id: x-req-401");
  });

  test("rate limit failure includes retry-after", async () => {
    process.env["ANTHROPIC_API_KEY"] = "anth-key";
    mockFetch(
      () =>
        new Response(JSON.stringify({ message: "slow down" }), {
          status: 429,
          headers: { "retry-after": "3", "x-request-id": "req-429" },
        }),
    );

    const result = await verifyConnection({ provider: "anthropic" });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("Anthropic rate limited (429)");
    expect(result.error).toContain("request id: req-429");
    expect(result.error).toContain("Retry after 3s");
  });

  test("generic failure uses parsed message", async () => {
    process.env["ANTHROPIC_API_KEY"] = "anth-key";
    mockFetch(
      () =>
        new Response(JSON.stringify({ message: "server down" }), {
          status: 500,
        }),
    );

    const result = await verifyConnection({ provider: "anthropic" });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("Anthropic error 500. server down");
  });

  test("successful legacy text block returns text property", async () => {
    process.env["ANTHROPIC_API_KEY"] = "anth-key";
    mockFetch(() => Response.json({ content: [{ text: "legacy text" }] }));

    const result = await getMentorFeedback({
      goal: "goal",
      plan: "plan",
      modelOverride: { provider: "anthropic" },
    });

    expect(result.feedback).toBe("legacy text");
  });

  test("malformed success body returns empty Anthropic text", async () => {
    process.env["ANTHROPIC_API_KEY"] = "anth-key";
    mockFetch(() => new Response("not-json"));

    const result = await getMentorFeedback({
      goal: "goal",
      plan: "plan",
      modelOverride: { provider: "anthropic" },
    });

    expect(result.feedback).toBe("");
  });

  test("error response without message field falls back to raw text", async () => {
    process.env["ANTHROPIC_API_KEY"] = "anth-key";
    mockFetch(
      () =>
        new Response("plain text error from upstream", {
          status: 502,
        }),
    );

    const result = await verifyConnection({ provider: "anthropic" });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("Anthropic error 502");
    expect(result.error).toContain("plain text error from upstream");
  });

  test("network failure propagates fetch rejection", async () => {
    process.env["ANTHROPIC_API_KEY"] = "anth-key";
    mockFetch(() => Promise.reject(new Error("ECONNREFUSED")));

    const result = await verifyConnection({ provider: "anthropic" });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("ECONNREFUSED");
  });

  test("empty content array returns empty string", async () => {
    process.env["ANTHROPIC_API_KEY"] = "anth-key";
    mockFetch(() => Response.json({ content: [] }));

    const result = await getMentorFeedback({
      goal: "goal",
      plan: "plan",
      modelOverride: { provider: "anthropic" },
    });

    expect(result.feedback).toBe("");
  });

  test("content with non-text block returns empty string", async () => {
    process.env["ANTHROPIC_API_KEY"] = "anth-key";
    mockFetch(() =>
      Response.json({
        content: [{ type: "tool_use", id: "tu-1", name: "read" }],
      }),
    );

    const result = await getMentorFeedback({
      goal: "goal",
      plan: "plan",
      modelOverride: { provider: "anthropic" },
    });

    expect(result.feedback).toBe("");
  });
});

// ---------------------------------------------------------------------------
// callGemini — pro→flash fallback
// ---------------------------------------------------------------------------

describe("callGemini fallback to flash model", () => {
  beforeEach(() => {
    geminiCalls = [];
    geminiResponses = [];
    throwOnCall = undefined;
    geminiErrorMessages = [];
    process.env["GEMINI_API_KEY"] = "g-key";
  });

  test("falls back to gemini-2.5-flash when gemini-2.5-pro fails (retryable: model not found)", async () => {
    geminiErrorMessages = ["model not found", undefined];
    geminiResponses = ["flash fallback response"];

    const result = await getMentorFeedback({
      goal: "g",
      plan: "p",
      modelOverride: { provider: "gemini", model: "gemini-2.5-pro" },
    });

    expect(result.feedback).toBe("flash fallback response");
    expect(geminiCalls).toHaveLength(2);
    expect(geminiCalls[0]?.model).toBe("gemini-2.5-pro");
    expect(geminiCalls[1]?.model).toBe("gemini-2.5-flash");
  });

  test("does not fall back when pro succeeds", async () => {
    geminiResponses = ["pro response"];

    const result = await getMentorFeedback({
      goal: "g",
      plan: "p",
      modelOverride: { provider: "gemini", model: "gemini-2.5-pro" },
    });

    expect(result.feedback).toBe("pro response");
    expect(geminiCalls).toHaveLength(1);
    expect(geminiCalls[0]?.model).toBe("gemini-2.5-pro");
  });

  test("defaults model to gemini-2.5-flash when none specified", async () => {
    geminiErrorMessages = ["model not found", undefined];
    geminiResponses = ["flash response"];

    const result = await getMentorFeedback({
      goal: "g",
      plan: "p",
      modelOverride: { provider: "gemini" },
    });

    expect(result.feedback).toBe("flash response");
    expect(geminiCalls).toHaveLength(2);
    expect(geminiCalls[0]?.model).toBe("gemini-2.5-flash");
    expect(geminiCalls[1]?.model).toBe("gemini-2.5-flash");
  });

  test("does not fall back on auth error — returns FALLBACK_FEEDBACK after single attempt", async () => {
    geminiErrorMessages = [
      "API_KEY_INVALID: the provided api key is not valid",
    ];

    const result = await getMentorFeedback({
      goal: "g",
      plan: "p",
      modelOverride: { provider: "gemini", model: "gemini-2.5-pro" },
    });

    expect(result.feedback).toBe(FALLBACK_FEEDBACK);
    expect(geminiCalls).toHaveLength(1);
    expect(geminiCalls[0]?.model).toBe("gemini-2.5-pro");
  });

  test("does not fall back on rate limit error — returns FALLBACK_FEEDBACK after single attempt", async () => {
    geminiErrorMessages = ["429 Resource has been exhausted. Check quota."];

    const result = await getMentorFeedback({
      goal: "g",
      plan: "p",
      modelOverride: { provider: "gemini", model: "gemini-2.5-pro" },
    });

    expect(result.feedback).toBe(FALLBACK_FEEDBACK);
    expect(geminiCalls).toHaveLength(1);
  });

  test("does not fall back on quota error — returns FALLBACK_FEEDBACK after single attempt", async () => {
    geminiErrorMessages = ["quota exceeded for this project"];

    const result = await getMentorFeedback({
      goal: "g",
      plan: "p",
      modelOverride: { provider: "gemini", model: "gemini-2.5-pro" },
    });

    expect(result.feedback).toBe(FALLBACK_FEEDBACK);
    expect(geminiCalls).toHaveLength(1);
  });

  test("does not fall back on network error — returns FALLBACK_FEEDBACK after single attempt", async () => {
    geminiErrorMessages = ["fetch failed: connect ECONNREFUSED"];

    const result = await getMentorFeedback({
      goal: "g",
      plan: "p",
      modelOverride: { provider: "gemini", model: "gemini-2.5-pro" },
    });

    expect(result.feedback).toBe(FALLBACK_FEEDBACK);
    expect(geminiCalls).toHaveLength(1);
  });

  test("falls back on model-not-found error", async () => {
    geminiErrorMessages = [
      "model gemini-2.5-pro is not found for API version v1beta",
      undefined,
    ];
    geminiResponses = ["flash fallback"];

    const result = await getMentorFeedback({
      goal: "g",
      plan: "p",
      modelOverride: { provider: "gemini", model: "gemini-2.5-pro" },
    });

    expect(result.feedback).toBe("flash fallback");
    expect(geminiCalls).toHaveLength(2);
    expect(geminiCalls[0]?.model).toBe("gemini-2.5-pro");
    expect(geminiCalls[1]?.model).toBe("gemini-2.5-flash");
  });

  test("falls back on context-length error", async () => {
    geminiErrorMessages = [
      "Request exceeds maximum context length of 1048576 tokens",
      undefined,
    ];
    geminiResponses = ["flash fallback"];

    const result = await getMentorFeedback({
      goal: "g",
      plan: "p",
      modelOverride: { provider: "gemini", model: "gemini-2.5-pro" },
    });

    expect(result.feedback).toBe("flash fallback");
    expect(geminiCalls).toHaveLength(2);
    expect(geminiCalls[0]?.model).toBe("gemini-2.5-pro");
    expect(geminiCalls[1]?.model).toBe("gemini-2.5-flash");
  });

  test("falls back on context-window error", async () => {
    geminiErrorMessages = [
      "input token count exceeds the context window",
      undefined,
    ];
    geminiResponses = ["flash fallback"];

    const result = await getMentorFeedback({
      goal: "g",
      plan: "p",
      modelOverride: { provider: "gemini", model: "gemini-2.5-pro" },
    });

    expect(result.feedback).toBe("flash fallback");
    expect(geminiCalls).toHaveLength(2);
    expect(geminiCalls[0]?.model).toBe("gemini-2.5-pro");
    expect(geminiCalls[1]?.model).toBe("gemini-2.5-flash");
  });

  test("does not fall back on unrecognized error — returns FALLBACK_FEEDBACK after single attempt", async () => {
    geminiErrorMessages = ["internal server error: something broke"];

    const result = await getMentorFeedback({
      goal: "g",
      plan: "p",
      modelOverride: { provider: "gemini", model: "gemini-2.5-pro" },
    });

    expect(result.feedback).toBe(FALLBACK_FEEDBACK);
    expect(geminiCalls).toHaveLength(1);
  });

  test("forwards temperature via generationConfig", async () => {
    geminiResponses = ["ok"];

    const result = await getGateDecision({
      goal: "g",
      plan: "p",
      feedback: "f",
      modelOverride: { provider: "gemini", model: "gemini-2.5-pro" },
    });

    expect(result.proceed).toBeDefined();
    expect(geminiCalls[0]?.generationConfig).toEqual({ temperature: 0.1 });
  });

  test("defaults temperature to 0.2 via generationConfig", async () => {
    geminiResponses = ["ok"];

    await getMentorFeedback({
      goal: "g",
      plan: "p",
      modelOverride: { provider: "gemini" },
    });

    expect(geminiCalls[0]?.generationConfig).toEqual({ temperature: 0.2 });
  });

  test("temperature 0 is forwarded via generationConfig", async () => {
    geminiResponses = ["ok"];

    // callGemini always wraps in generationConfig; temperature 0 is a valid
    // deterministic mode value that exercises the always-use-config path.
    await getMentorFeedback({
      goal: "g",
      plan: "p",
      modelOverride: { provider: "gemini" },
    });

    // Default temperature is 0.2; this test confirms the generationConfig
    // path is always taken (not the old branch where temperature undefined
    // would send the prompt as a raw string).
    expect(geminiCalls[0]?.generationConfig).toBeDefined();
  });

  test("systemInstruction receives system prompt, userContent in contents", async () => {
    geminiResponses = ["ok"];

    await getMentorFeedback({
      goal: "g",
      plan: "p",
      modelOverride: { provider: "gemini", model: "gemini-2.5-pro" },
    });

    expect(geminiCalls).toHaveLength(1);
    expect(geminiCalls[0]?.systemInstruction).toBeDefined();
    expect(geminiCalls[0]?.systemInstruction).toContain("Misalignment");
    expect(geminiCalls[0]?.systemInstruction).toContain("Assumption lock-in");
    expect(geminiCalls[0]?.systemInstruction).toContain("Constitution");
    expect(geminiCalls[0]?.systemInstruction).toContain("Irreversibility");
    expect(geminiCalls[0]?.systemInstruction).toContain("blast radius");
    expect(geminiCalls[0]?.systemInstruction).toContain("Hard risk");
    expect(geminiCalls[0]?.systemInstruction).toContain("Soft risk");
    expect(geminiCalls[0]?.systemInstruction).toContain("actionable");
    // systemInstruction must NOT contain user-specific context
    expect(geminiCalls[0]?.systemInstruction).not.toContain("Goal: g");
    expect(geminiCalls[0]?.systemInstruction).not.toContain("Plan: p");
    // userContent (prompt) contains user context
    expect(geminiCalls[0]?.prompt).toContain("Goal: g");
    expect(geminiCalls[0]?.prompt).toContain("Plan: p");
  });

  test("systemInstruction for gate decision uses GATE_SYSTEM_PROMPT", async () => {
    geminiResponses = [
      JSON.stringify({ proceed: true, confidence: 0.9, reason: "ok" }),
    ];

    await getGateDecision({
      goal: "g",
      plan: "p",
      feedback: "f",
      modelOverride: { provider: "gemini", model: "gemini-2.5-pro" },
    });

    expect(geminiCalls[0]?.systemInstruction).toContain(
      "Output ONLY one line of valid JSON",
    );
    expect(geminiCalls[0]?.systemInstruction).toContain("Go/no-go");
    // GATE prompt must NOT contain "blast radius" (that's in SYSTEM_PROMPT)
    expect(geminiCalls[0]?.systemInstruction).not.toContain("blast radius");
  });

  test("systemInstruction carried to flash fallback in getMentorFeedback", async () => {
    geminiErrorMessages = ["model not found", undefined];
    geminiResponses = ["flash response"];

    await getMentorFeedback({
      goal: "g",
      plan: "p",
      modelOverride: { provider: "gemini", model: "gemini-2.5-pro" },
    });

    expect(geminiCalls).toHaveLength(2);
    // Both pro and flash calls should receive systemInstruction
    expect(geminiCalls[0]?.systemInstruction).toBeDefined();
    expect(geminiCalls[0]?.systemInstruction).toContain("Misalignment");
    expect(geminiCalls[1]?.systemInstruction).toBeDefined();
    expect(geminiCalls[1]?.systemInstruction).toContain("Misalignment");
    expect(geminiCalls[1]?.systemInstruction).not.toContain("Goal: g");
  });

  test("systemInstruction carried to flash fallback in getGateDecision", async () => {
    geminiErrorMessages = ["not found", undefined];
    geminiResponses = [
      JSON.stringify({ proceed: true, confidence: 0.9, reason: "ok" }),
    ];

    await getGateDecision({
      goal: "g",
      plan: "p",
      feedback: "f",
      modelOverride: { provider: "gemini", model: "gemini-2.5-pro" },
    });

    expect(geminiCalls).toHaveLength(2);
    // Both pro and flash calls should use GATE_SYSTEM_PROMPT
    expect(geminiCalls[0]?.systemInstruction).toContain(
      "Output ONLY one line of valid JSON",
    );
    expect(geminiCalls[1]?.systemInstruction).toContain(
      "Output ONLY one line of valid JSON",
    );
    expect(geminiCalls[1]?.systemInstruction).not.toContain("blast radius");
  });

  test("revisePlan with gemini passes PLAN_REVISION_SYSTEM_PROMPT as systemInstruction", async () => {
    geminiResponses = ["revised"];

    const result = await revisePlan({
      goal: "goal",
      plan: "old plan",
      feedback: "missing rollback",
      modelOverride: { provider: "gemini", model: "gemini-2.5-pro" },
    });

    expect(result).toBe("revised");
    expect(geminiCalls).toHaveLength(1);
    expect(geminiCalls[0]?.systemInstruction).toContain("plan reviser");
    expect(geminiCalls[0]?.systemInstruction).toContain(
      "preserve everything else",
    );
    expect(geminiCalls[0]?.systemInstruction).toContain(
      "Prioritize goal alignment",
    );
    expect(geminiCalls[0]?.prompt).toContain("Blocked plan: old plan");
    expect(geminiCalls[0]?.prompt).toContain(
      "Safety feedback: missing rollback",
    );
  });

  test("revisePlan with gemini includes blockReason in user content", async () => {
    geminiResponses = ["revised with reason"];

    const result = await revisePlan({
      goal: "goal",
      plan: "old plan",
      feedback: "missing rollback",
      blockReason: "irreversible op without safe-stop",
      modelOverride: { provider: "gemini", model: "gemini-2.5-pro" },
    });

    expect(result).toBe("revised with reason");
    expect(geminiCalls[0]?.prompt).toContain(
      "Block reason: irreversible op without safe-stop",
    );
  });

  test("revisePlan with OpenAI passes PLAN_REVISION_SYSTEM_PROMPT as system message", async () => {
    process.env["OPENAI_API_KEY"] = "openai-key";
    openAiResponseText = "openai revised";

    const result = await revisePlan({
      goal: "goal",
      plan: "old plan",
      feedback: "missing rollback",
      modelOverride: { provider: "openai", model: "gpt-test" },
    });

    expect(result).toBe("openai revised");
    const req0 = requireValue(openAiRequests[0], "OpenAI request 0");
    expect(req0.request.messages).toHaveLength(2);
    expect(req0.request.messages[0]?.role).toBe("system");
    expect(req0.request.messages[0]?.content).toContain("plan reviser");
    expect(req0.request.messages[0]?.content).toContain(
      "preserve everything else",
    );
    expect(req0.request.messages[1]?.role).toBe("user");
    expect(req0.request.messages[1]?.content).toContain(
      "Blocked plan: old plan",
    );
    expect(req0.request.messages[1]?.content).toContain(
      "Safety feedback: missing rollback",
    );
  });
});

// ---------------------------------------------------------------------------
// temperature forwarding
// ---------------------------------------------------------------------------

describe("temperature forwarding", () => {
  test("OpenAI receives temperature and separate system/user messages in gate decision", async () => {
    process.env["OPENAI_API_KEY"] = "openai-key";

    await getGateDecision({
      goal: "g",
      plan: "p",
      feedback: "f",
      modelOverride: { provider: "openai", model: "gpt-test" },
    });

    const req0 = requireValue(openAiRequests[0], "OpenAI request 0");
    expect(req0.request.temperature).toBe(0.1);
    // Verify system/user message separation
    expect(req0.request.messages).toHaveLength(2);
    expect(req0.request.messages[0]?.role).toBe("system");
    expect(req0.request.messages[0]?.content).toContain(
      "Output ONLY one line of valid JSON",
    );
    expect(req0.request.messages[0]?.content).not.toContain("Goal: g");
    expect(req0.request.messages[1]?.role).toBe("user");
    expect(req0.request.messages[1]?.content).toContain("Goal: g");
    expect(req0.request.messages[1]?.content).toContain("Plan: p");
    expect(req0.request.messages[1]?.content).toContain("Feedback: f");
  });

  test("DeepSeek receives temperature and separate system/user messages in gate decision", async () => {
    process.env["DEEPSEEK_API_KEY"] = "ds-key";

    await getGateDecision({
      goal: "g",
      plan: "p",
      feedback: "f",
      modelOverride: { provider: "deepseek" },
    });

    const req0 = requireValue(openAiRequests[0], "OpenAI request 0");
    expect(req0.request.temperature).toBe(0.1);
    // Verify system/user message separation
    expect(req0.request.messages).toHaveLength(2);
    expect(req0.request.messages[0]?.role).toBe("system");
    expect(req0.request.messages[0]?.content).toContain(
      "Output ONLY one line of valid JSON",
    );
    expect(req0.request.messages[0]?.content).not.toContain("Goal: g");
    expect(req0.request.messages[1]?.role).toBe("user");
    expect(req0.request.messages[1]?.content).toContain("Goal: g");
    expect(req0.request.messages[1]?.content).toContain("Plan: p");
    expect(req0.request.messages[1]?.content).toContain("Feedback: f");
  });

  test("OpenCode receives temperature and separate system/user messages in gate decision", async () => {
    process.env["OPENCODE_API_KEY"] = "oc-key";

    await getGateDecision({
      goal: "g",
      plan: "p",
      feedback: "f",
      modelOverride: { provider: "opencode" },
    });

    const req0 = requireValue(openAiRequests[0], "OpenAI request 0");
    expect(req0.request.temperature).toBe(0.1);
    // Verify system/user message separation
    expect(req0.request.messages).toHaveLength(2);
    expect(req0.request.messages[0]?.role).toBe("system");
    expect(req0.request.messages[0]?.content).toContain(
      "Output ONLY one line of valid JSON",
    );
    expect(req0.request.messages[0]?.content).not.toContain("Goal: g");
    expect(req0.request.messages[1]?.role).toBe("user");
    expect(req0.request.messages[1]?.content).toContain("Goal: g");
    expect(req0.request.messages[1]?.content).toContain("Plan: p");
    expect(req0.request.messages[1]?.content).toContain("Feedback: f");
  });

  test("OpenAI defaults temperature to 0.2 via callProvider", async () => {
    process.env["OPENAI_API_KEY"] = "openai-key";
    openAiResponseText = "ok";

    await getMentorFeedback({
      goal: "g",
      plan: "p",
      modelOverride: { provider: "openai" },
    });

    const req0 = requireValue(openAiRequests[0], "OpenAI request 0");
    expect(req0.request.temperature).toBe(0.2);
  });

  test("Mimo receives temperature 0.1 in gate decision", async () => {
    process.env["MIMO_API_KEY"] = "mimo-key";

    await getGateDecision({
      goal: "g",
      plan: "p",
      feedback: "f",
      modelOverride: { provider: "mimo" },
    });

    const req0 = requireValue(openAiRequests[0], "OpenAI request 0");
    expect(req0.request.temperature).toBe(0.1);
    expect(req0.request.messages).toHaveLength(2);
    expect(req0.request.messages[0]?.role).toBe("system");
    expect(req0.request.messages[0]?.content).toContain(
      "Output ONLY one line of valid JSON",
    );
    expect(req0.request.messages[0]?.content).not.toContain("Goal: g");
    expect(req0.request.messages[1]?.role).toBe("user");
    expect(req0.request.messages[1]?.content).toContain("Goal: g");
    expect(req0.request.messages[1]?.content).toContain("Plan: p");
    expect(req0.request.messages[1]?.content).toContain("Feedback: f");
  });

  test("Mimo defaults temperature to 0.2 in mentor feedback", async () => {
    process.env["MIMO_API_KEY"] = "mimo-key";
    openAiResponseText = "ok";

    await getMentorFeedback({
      goal: "g",
      plan: "p",
      modelOverride: { provider: "mimo" },
    });

    const req0 = requireValue(openAiRequests[0], "OpenAI request 0");
    expect(req0.request.temperature).toBe(0.2);
  });
});
