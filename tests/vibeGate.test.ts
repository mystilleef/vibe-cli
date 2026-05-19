import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type VibeCheckInput,
  vibeGateLoop,
  vibeGateTool,
} from "../src/tools/vibeGate";
import { FALLBACK_QUESTIONS } from "../src/utils/llm";
import { createTempHome, type TempHomeContext } from "./helpers/tempHome";

interface AnthropicBody {
  model?: string;
  messages?: Array<{ role?: string; content?: string }>;
  system?: string;
}

let home: TempHomeContext | undefined;
let cwd: string | undefined;
let originalFetch: typeof fetch;
let originalConsoleError: typeof console.error;
let savedEnv: Partial<Record<string, string | undefined>>;
const requests: AnthropicBody[] = [];
const responseQueue: Array<string | { status: number; text: string }> = [];

function configureAnthropicEnv(): void {
  process.env.ANTHROPIC_API_KEY = "test-key";
  process.env.DEFAULT_LLM_PROVIDER = "anthropic";
  process.env.DEFAULT_MODEL = "";
  process.env.USE_LEARNING_HISTORY = "false";
}

function installAnthropicFetch(): void {
  globalThis.fetch = (async (_input, init) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as AnthropicBody;
    requests.push(body);
    const queued = responseQueue.shift() ?? "fallback-response";
    const status = typeof queued === "string" ? 200 : queued.status;
    const text = typeof queued === "string" ? queued : queued.text;
    const payload =
      status >= 400
        ? { error: { message: text } }
        : { content: [{ type: "text", text }] };
    return new Response(JSON.stringify(payload), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
}

function input(overrides: Partial<VibeCheckInput> = {}): VibeCheckInput {
  return {
    goal: "ship safely",
    plan: "run focused tests",
    ...overrides,
  };
}

function gateDecision(proceed: boolean, confidence: number, reason: string) {
  return JSON.stringify({ proceed, confidence, reason });
}

beforeEach(async () => {
  originalFetch = globalThis.fetch;
  originalConsoleError = console.error;
  savedEnv = {
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    DEFAULT_LLM_PROVIDER: process.env.DEFAULT_LLM_PROVIDER,
    DEFAULT_MODEL: process.env.DEFAULT_MODEL,
    USE_LEARNING_HISTORY: process.env.USE_LEARNING_HISTORY,
  };
  home = await createTempHome();
  cwd = await mkdtemp(join(tmpdir(), "vibe-gate-tool-"));
  process.chdir(cwd);
  requests.length = 0;
  responseQueue.length = 0;
  console.error = () => {};
  configureAnthropicEnv();
  installAnthropicFetch();
});

afterEach(async () => {
  process.chdir(import.meta.dir.replace(/\/tests$/, ""));
  globalThis.fetch = originalFetch;
  console.error = originalConsoleError;
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  if (cwd) await rm(cwd, { recursive: true, force: true });
  if (home) await home.cleanup();
  home = undefined;
  cwd = undefined;
});

describe("vibeGateTool", () => {
  test("passes generated questions into the gate decision and returns a proceed result", async () => {
    responseQueue.push(
      "questions:mock-gate:review rollback",
      gateDecision(true, 0.92, "risks addressed"),
    );

    const result = await vibeGateTool(
      input({ modelOverride: { provider: "anthropic", model: "mock-gate" } }),
    );

    expect(result).toEqual({
      proceed: true,
      confidence: 0.92,
      reason: "risks addressed",
      questions: "questions:mock-gate:review rollback",
      plan: "run focused tests",
      attempts: 1,
    });
    expect(requests).toHaveLength(2);
    expect(requests[0]?.model).toBe("mock-gate");
    expect(requests[1]?.model).toBe("mock-gate");
    const gatePrompt = requests[1]?.messages?.[0]?.content ?? "";
    expect(gatePrompt).toContain(
      "Feedback: questions:mock-gate:review rollback",
    );
  });

  test("falls back to a blocking decision when gate output is malformed", async () => {
    responseQueue.push("questions:needs-structure", "not json");

    const result = await vibeGateTool(input());

    expect(result.proceed).toBe(false);
    expect(result.confidence).toBe(0.5);
    expect(result.reason).toMatch(/unavailable/);
    expect(result.questions).toBe("questions:needs-structure");
    expect(result.attempts).toBe(1);
  });

  test("propagates gate provider failures after question fallback", async () => {
    await expect(
      vibeGateTool(
        input({ modelOverride: { provider: "unsupported-provider" } }),
      ),
    ).rejects.toThrow(/Unknown provider/);
    expect(requests).toHaveLength(0);
  });
});

describe("vibeGateLoop", () => {
  test("revises a blocked plan, then stops when the revised plan passes", async () => {
    responseQueue.push(
      "questions:first",
      gateDecision(false, 0.35, "missing rollback"),
      "add rollback and smoke tests",
      "questions:second",
      gateDecision(true, 0.88, "rollback added"),
    );

    const result = await vibeGateLoop(input(), 3);

    expect(result).toEqual({
      proceed: true,
      confidence: 0.88,
      reason: "rollback added",
      questions: "questions:second",
      plan: "add rollback and smoke tests",
      attempts: 2,
    });
    expect(requests).toHaveLength(5);
    expect(requests[2]?.messages?.[0]?.content).toContain(
      "Blocked plan: run focused tests",
    );
    expect(requests[2]?.messages?.[0]?.content).not.toContain("Block reason:");
    expect(requests[2]?.messages?.[0]?.content).toContain(
      "Safety feedback: questions:first",
    );
    expect(requests[3]?.messages?.[0]?.content).toContain(
      "Plan: add rollback and smoke tests",
    );
  });

  test("marks the last blocked attempt exhausted without revising after maxAttempts", async () => {
    responseQueue.push("questions:only", gateDecision(false, 0.2, "too risky"));

    const result = await vibeGateLoop(input(), 1);

    expect(result).toEqual({
      proceed: false,
      confidence: 0.2,
      reason: "too risky",
      questions: "questions:only",
      plan: "run focused tests",
      attempts: 1,
      exhausted: true,
    });
    expect(requests).toHaveLength(2);
  });

  test("returns an exhausted boundary result without running checks for zero attempts", async () => {
    const result = await vibeGateLoop(input(), 0);

    expect(result.exhausted).toBe(true);
    expect(Object.keys(result)).toEqual(["exhausted"]);
    expect(requests).toHaveLength(0);
  });

  test("returns an exhausted boundary result for negative maxAttempts", async () => {
    const result = await vibeGateLoop(input(), -1);

    expect(result.exhausted).toBe(true);
    expect(Object.keys(result)).toEqual(["exhausted"]);
    expect(requests).toHaveLength(0);
  });

  test("uses fallback questions when check generation fails, then revises from fallback feedback", async () => {
    responseQueue.push(
      { status: 500, text: "question generator down" },
      gateDecision(false, 0.4, "fallback feedback still blocks"),
      "fallback-aware revision",
      "questions:revised",
      gateDecision(true, 0.7, "fixed"),
    );

    const result = await vibeGateLoop(
      input({ modelOverride: { provider: "anthropic", model: "mock-loop" } }),
      2,
    );

    expect(result.proceed).toBe(true);
    expect(result.plan).toBe("fallback-aware revision");
    expect(requests[1]?.messages?.[0]?.content).toContain(
      `Feedback: ${FALLBACK_QUESTIONS}`,
    );
    expect(requests[2]?.messages?.[0]?.content).toContain(
      `Safety feedback: ${FALLBACK_QUESTIONS}`,
    );
  });
});
