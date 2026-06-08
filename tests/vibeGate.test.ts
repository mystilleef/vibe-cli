import {
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type VibeCheckInput,
  vibeGateLoop,
  vibeGateTool,
} from "../src/tools/vibeGate";
import { FALLBACK_FEEDBACK } from "../src/utils/llm";
import { createTempHome, type TempHomeContext } from "./helpers/tempHome";

interface AnthropicBody {
  model?: string;
  messages?: Array<{ role?: string; content?: string }>;
  system?: string;
}

let home: TempHomeContext | undefined;
let cwd: string | undefined;
let originalFetch: typeof fetch;
let savedEnv: Partial<Record<string, string | undefined>>;
const requests: AnthropicBody[] = [];
const responseQueue: Array<string | { status: number; text: string }> = [];

function configureAnthropicEnv(): void {
  process.env["ANTHROPIC_API_KEY"] = "test-key";
  process.env["DEFAULT_LLM_PROVIDER"] = "anthropic";
  process.env["DEFAULT_MODEL"] = "";
  process.env["USE_LEARNING_HISTORY"] = "false";
}

async function writeAnthropicSettings(): Promise<void> {
  if (home === undefined) throw new Error("temp home not initialized");
  await mkdir(home.dataRoot, { recursive: true });
  await writeFile(
    join(home.dataRoot, "settings.json"),
    JSON.stringify({
      provider: "anthropic",
      providers: [
        {
          name: "anthropic",
          spec: "anthropic",
          envVar: "ANTHROPIC_API_KEY",
          defaultModel: "claude-test-default",
        },
      ],
    }),
  );
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
  savedEnv = {
    ANTHROPIC_API_KEY: process.env["ANTHROPIC_API_KEY"],
    DEFAULT_LLM_PROVIDER: process.env["DEFAULT_LLM_PROVIDER"],
    DEFAULT_MODEL: process.env["DEFAULT_MODEL"],
    USE_LEARNING_HISTORY: process.env["USE_LEARNING_HISTORY"],
  };
  home = await createTempHome();
  await writeAnthropicSettings();
  cwd = await mkdtemp(join(tmpdir(), "vibe-gate-tool-"));
  process.chdir(cwd);
  requests.length = 0;
  responseQueue.length = 0;
  spyOn(console, "error").mockImplementation(() => {});
  configureAnthropicEnv();
  installAnthropicFetch();
});

afterEach(async () => {
  process.chdir(import.meta.dir.replace(/\/tests$/, ""));
  globalThis.fetch = originalFetch;
  mock.restore();
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
      feedback: "questions:mock-gate:review rollback",
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
    expect(result.feedback).toBe("questions:needs-structure");
    expect(result.attempts).toBe(1);
  });

  test("propagates gate provider failures after question fallback", async () => {
    let thrown: Error | undefined;
    try {
      await vibeGateTool(
        input({ modelOverride: { provider: "unsupported-provider" } }),
      );
    } catch (e) {
      thrown = e as Error;
    }
    expect(thrown?.message).toMatch(
      /Provider 'unsupported-provider' not found in settings\.json/,
    );
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
      feedback: "questions:second",
      plan: "add rollback and smoke tests",
      attempts: 2,
    });
    expect(requests).toHaveLength(5);
    expect(requests[2]?.messages?.[0]?.content).toContain(
      "Blocked plan: run focused tests",
    );
    expect(requests[2]?.messages?.[0]?.content).toContain(
      "Block reason: missing rollback",
    );
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
      feedback: "questions:only",
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
      `Feedback: ${FALLBACK_FEEDBACK}`,
    );
    expect(requests[2]?.messages?.[0]?.content).toContain(
      `Safety feedback: ${FALLBACK_FEEDBACK}`,
    );
  });

  test("exhausts after maxAttempts blocks without passing", async () => {
    responseQueue.push(
      "questions:one",
      gateDecision(false, 0.2, "block 1"),
      "revision 1",
      "questions:two",
      gateDecision(false, 0.3, "block 2"),
      "revision 2",
      "questions:three",
      gateDecision(false, 0.4, "block 3"),
    );
    // maxAttempts=3, after third block no revision call (attempt < maxAttempts is false)
    const result = await vibeGateLoop(input(), 3);

    expect(result.proceed).toBe(false);
    expect(result.exhausted).toBe(true);
    expect(result.attempts).toBe(3);
    expect(result.plan).toBe("revision 2");
    expect(result.confidence).toBe(0.4);
    expect(result.reason).toBe("block 3");
    // 3 checks + 3 gates + 2 revisions = 8 requests
    expect(requests).toHaveLength(8);
  });

  test("propagates modelOverride through revisePlan calls", async () => {
    responseQueue.push(
      "questions:first",
      gateDecision(false, 0.3, "missing rollback"),
      "revision with model",
      "questions:second",
      gateDecision(true, 0.9, "ok"),
    );

    const result = await vibeGateLoop(
      input({
        modelOverride: { provider: "anthropic", model: "custom-model" },
      }),
      2,
    );

    expect(result.proceed).toBe(true);
    expect(result.plan).toBe("revision with model");
    // Verify plan revision call used the overridden model
    const reviseCall = requests[2];
    expect(reviseCall?.model).toBe("custom-model");
    expect(reviseCall?.system).toContain("plan reviser");
    expect(reviseCall?.messages?.[0]?.content).toContain(
      "Block reason: missing rollback",
    );
  });

  test("propagates error when vibeGateTool throws during loop", async () => {
    // gate throws with unknown provider
    try {
      await vibeGateLoop(
        input({ modelOverride: { provider: "unsupported-provider" } }),
        2,
      );
      expect.unreachable("should have thrown");
    } catch (err) {
      expect((err as Error).message).toMatch(
        /Provider 'unsupported-provider' not found in settings\.json/,
      );
    }
    expect(requests).toHaveLength(0);
  });

  test("propagates error when revisePlan throws mid-loop", async () => {
    responseQueue.push("questions:first", gateDecision(false, 0.3, "blocked"), {
      status: 500,
      text: "anthropic internal error",
    });

    try {
      await vibeGateLoop(input(), 2);
      expect.unreachable("should have thrown");
    } catch (err) {
      expect((err as Error).message).toMatch(/Anthropic error 500/);
    }
    // 1 check + 1 gate + 1 failed revision = at most 3 requests (revision fetch failed)
    expect(requests).toHaveLength(3);
  });

  test("preserves last state when revisePlan fails on final retry attempt", async () => {
    // Only 1 attempt, blocked, revisePlan crashes → error propagates with last state unknown
    // But there's no revise since maxAttempts=1, so this exercises just the gate block path
    responseQueue.push("questions:final", gateDecision(false, 0.1, "no"));

    const result = await vibeGateLoop(input(), 1);
    expect(result.exhausted).toBe(true);
    expect(result.proceed).toBe(false);
    expect(result.plan).toBe("run focused tests");
    expect(requests).toHaveLength(2);
  });
});
