import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type VibeCheckInput, vibeCheckTool } from "../src/tools/vibeCheck";
import { resolveAutosession } from "../src/utils/autosession";
import { FALLBACK_FEEDBACK } from "../src/utils/llm";
import { getHistorySummary } from "../src/utils/state";
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

function installQuestionFetch(): void {
  globalThis.fetch = (async (_input, init) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as AnthropicBody;
    requests.push(body);
    const prompt = body.messages?.[0]?.content ?? "";
    return new Response(
      JSON.stringify({
        content: [
          {
            type: "text",
            text: `questions:${body.model ?? "missing"}:${prompt.slice(0, 18)}`,
          },
        ],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;
}

function configureAnthropicEnv(): void {
  process.env.ANTHROPIC_API_KEY = "test-key";
  process.env.DEFAULT_LLM_PROVIDER = "anthropic";
  process.env.DEFAULT_MODEL = "";
  process.env.USE_LEARNING_HISTORY = "false";
}

function latestPrompt(): string {
  return requests.at(-1)?.messages?.[0]?.content ?? "";
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
  cwd = await mkdtemp(join(tmpdir(), "vibe-check-tool-"));
  process.chdir(cwd);
  requests.length = 0;
  console.error = () => {};
  configureAnthropicEnv();
  installQuestionFetch();
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

describe("vibeCheckTool", () => {
  test("passes all supplied context to the question generator and records returned questions", async () => {
    const input: VibeCheckInput = {
      goal: "ship safely",
      plan: "run focused tests",
      progress: "implementation complete",
      uncertainties: ["edge cases", "regression risk"],
      taskContext: "release prep",
      userPrompt: "verify this plan",
      modelOverride: { provider: "anthropic", model: "mock-claude" },
    };

    const result = await vibeCheckTool(input);
    const sessionId = resolveAutosession().id;
    const prompt = latestPrompt();

    expect(result.feedback).toContain("questions:mock-claude");
    expect(requests).toHaveLength(1);
    expect(requests[0]?.model).toBe("mock-claude");
    expect(prompt).not.toContain("History Context: None");
    expect(prompt).toContain("Goal: ship safely");
    expect(prompt).toContain("Plan: run focused tests");
    expect(prompt).toContain("Progress: implementation complete");
    expect(prompt).toContain("Uncertainties: edge cases, regression risk");
    expect(prompt).toContain("Task Context: release prep");
    expect(prompt).toContain("User Prompt: verify this plan");
    expect(getHistorySummary(sessionId)).toContain(result.feedback);
  });

  test("uses boundary defaults for omitted and empty optional context", async () => {
    const result = await vibeCheckTool({
      goal: "",
      plan: "",
      uncertainties: [],
      modelOverride: { provider: "anthropic", model: "mock-boundary" },
    });
    const prompt = latestPrompt();

    expect(result.feedback).toContain("questions:mock-boundary");
    expect(prompt).toContain("Goal: ");
    expect(prompt).toContain("Plan: ");
    expect(prompt).not.toContain("Progress:");
    expect(prompt).not.toContain("Uncertainties:");
    expect(prompt).not.toContain("Task Context:");
    expect(prompt).not.toContain("User Prompt:");
  });

  test("feeds previous interaction history into subsequent checks for the same autosession", async () => {
    const first = await vibeCheckTool({
      goal: "first goal",
      plan: "first plan",
      modelOverride: { provider: "anthropic", model: "mock-history" },
    });
    await vibeCheckTool({
      goal: "second goal",
      plan: "second plan",
      modelOverride: { provider: "anthropic", model: "mock-history" },
    });
    const secondPrompt = requests[1]?.messages?.[0]?.content ?? "";

    expect(first.feedback).toContain("questions:mock-history");
    expect(requests).toHaveLength(2);
    expect(secondPrompt).toContain("History Context:");
    expect(secondPrompt).toContain("Goal first goal");
    expect(secondPrompt).toContain(first.feedback);
  });

  test("returns and records fallback questions when question generation fails", async () => {
    const result = await vibeCheckTool({
      goal: "bad provider",
      plan: "force resolver error",
      modelOverride: { provider: "bogus" },
    });
    const sessionId = resolveAutosession().id;
    const summary = getHistorySummary(sessionId);

    expect(result).toEqual({ feedback: FALLBACK_FEEDBACK });
    expect(requests).toHaveLength(0);
    expect(summary).toContain("Goal bad provider");
    expect(summary).toContain(FALLBACK_FEEDBACK.slice(0, 80));
  });

  test("returns fallback questions when autosession state cannot be created", async () => {
    const blockedHome = join(cwd ?? ".", "home-file");
    await writeFile(blockedHome, "not a directory");
    process.env.HOME = blockedHome;

    const result = await vibeCheckTool({ goal: "g", plan: "p" });

    expect(result).toEqual({ feedback: FALLBACK_FEEDBACK });
    expect(requests).toHaveLength(0);
  });
});
