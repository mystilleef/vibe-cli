import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getConstitution, resetConstitution } from "../src/tools/constitution";
import { runDemo } from "../src/tools/demo";
import {
  addLearningEntry,
  getLearningCategorySummary,
  getLearningEntries,
} from "../src/utils/storage";
import { createTempHome, type TempHomeContext } from "./helpers/tempHome";

interface AnthropicBody {
  model?: string;
  messages?: Array<{ role?: string; content?: string }>;
}

const PROVIDER_ENV = [
  "ANTHROPIC_API_KEY",
  "DEFAULT_LLM_PROVIDER",
  "DEFAULT_MODEL",
  "USE_LEARNING_HISTORY",
] as const;

type ProviderEnvKey = (typeof PROVIDER_ENV)[number];

let home: TempHomeContext | undefined;
let cwd: string | undefined;
let originalFetch: typeof fetch;
let originalStdoutWrite: typeof process.stdout.write;
let savedEnv: Partial<Record<ProviderEnvKey, string | undefined>>;
const requests: AnthropicBody[] = [];
const responseQueue: string[] = [];
let onFetchRequest: ((requestCount: number) => void) | undefined;
let stdout = "";

function configureAnthropicEnv(): void {
  process.env.ANTHROPIC_API_KEY = "test-key";
  process.env.DEFAULT_LLM_PROVIDER = "anthropic";
  process.env.DEFAULT_MODEL = "default-demo-model";
  process.env.USE_LEARNING_HISTORY = "false";
}

function gateDecision(proceed: boolean, confidence: number, reason: string) {
  return JSON.stringify({ proceed, confidence, reason });
}

function installAnthropicFetch(): void {
  globalThis.fetch = (async (_input, init) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as AnthropicBody;
    requests.push(body);
    onFetchRequest?.(requests.length);
    const text = responseQueue.shift() ?? "fallback-demo-response";
    return new Response(JSON.stringify({ content: [{ type: "text", text }] }), {
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
}

function captureStdout(): void {
  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdout += String(chunk);
    return true;
  }) as typeof process.stdout.write;
}

function visibleOutput(): string {
  let output = "";
  for (let i = 0; i < stdout.length; i += 1) {
    if (stdout.charCodeAt(i) === 27 && stdout[i + 1] === "[") {
      i += 2;
      while (i < stdout.length) {
        const code = stdout.charCodeAt(i);
        if (code >= 0x40 && code <= 0x7e) break;
        i += 1;
      }
      continue;
    }
    output += stdout[i];
  }
  return output;
}

beforeEach(async () => {
  originalFetch = globalThis.fetch;
  originalStdoutWrite = process.stdout.write;
  savedEnv = {};
  for (const key of PROVIDER_ENV) savedEnv[key] = process.env[key];
  home = await createTempHome();
  cwd = await mkdtemp(join(tmpdir(), "vibe-demo-tool-"));
  process.chdir(cwd);
  requests.length = 0;
  responseQueue.length = 0;
  onFetchRequest = undefined;
  stdout = "";
  configureAnthropicEnv();
  installAnthropicFetch();
  captureStdout();
});

afterEach(async () => {
  process.stdout.write = originalStdoutWrite;
  globalThis.fetch = originalFetch;
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  process.chdir(import.meta.dir.replace(/\/tests$/, ""));
  if (cwd) await rm(cwd, { recursive: true, force: true });
  if (home) await home.cleanup();
  home = undefined;
  cwd = undefined;
});

describe("runDemo", () => {
  test("walks through the demo, prints the decision, and clears demo state", async () => {
    resetConstitution(["Keep existing user rules"]);
    responseQueue.push(
      "Question one\n\nQuestion two",
      gateDecision(false, 0.42, "missing rollback"),
      "Safe plan feedback",
      gateDecision(true, 0.95, "safe migration plan"),
    );
    const legacyEntry = addLearningEntry(
      "Legacy user learning",
      "Premature Implementation",
      "Keep legacy data",
    );
    onFetchRequest = (requestCount) => {
      if (requestCount === 2) {
        addLearningEntry(
          "Concurrent user learning",
          "Premature Implementation",
          "Keep concurrent data",
        );
      }
    };

    await runDemo();

    const output = visibleOutput();
    expect(output).toContain("▸ vibe demo");
    expect(output).toContain("Step 1/4: Set a constitution rule");
    expect(output).toContain("Step 2/4: Run a vibe check on a risky plan");
    expect(output).toContain("Step 3/4: Run a vibe check on a safe plan");
    expect(output).toContain(
      "Step 4/4: Record the pattern for future sessions",
    );
    expect(output).toContain("Question one");
    expect(output).toContain("Question two");
    expect(output).toContain("✗ blocked");
    expect(output).toContain(
      'JSON: {"proceed":false,"confidence":0.42,"reason":"missing rollback"}',
    );
    expect(output).toContain("✓ Demo complete.");
    expect(output).toMatch(/"demoId": "demo-\d+-[a-z0-9]+"/);
    expect(getConstitution()).toEqual(["Keep existing user rules"]);
    expect(
      getLearningEntries()["Premature Implementation"]?.map(
        (entry) => entry.mistake,
      ),
    ).toEqual(["Legacy user learning", "Concurrent user learning"]);
    expect(
      getLearningEntries()["Premature Implementation"]?.every(
        (entry) => entry.demoId === undefined,
      ),
    ).toBe(true);
    const summary = getLearningCategorySummary();
    expect(summary).toHaveLength(1);
    expect(summary[0]?.category).toBe("Premature Implementation");
    expect(summary[0]?.count).toBe(2);
    expect(summary[0]?.recentExample.mistake).toBe("Concurrent user learning");
    expect(summary[0]?.recentExample.timestamp).toBeGreaterThanOrEqual(
      legacyEntry.timestamp,
    );
    expect(requests).toHaveLength(4);
    expect(requests[0]?.model).toBe("default-demo-model");
    expect(requests[1]?.messages?.[0]?.content).toContain(
      "Feedback: Question one\n\nQuestion two",
    );
  });

  test("forwards model overrides to the check provider", async () => {
    responseQueue.push(
      "Override provider questions",
      gateDecision(true, 0.91, "safe enough"),
      "Override safe plan feedback",
      gateDecision(true, 0.97, "safe migration"),
    );

    await runDemo({
      modelOverride: { provider: "anthropic", model: "demo-llm" },
    });

    expect(requests.map((request) => request.model)).toEqual([
      "demo-llm",
      "demo-llm",
      "demo-llm",
      "demo-llm",
    ]);
    expect(visibleOutput()).toContain("✓ proceed");
    expect(getConstitution()).toEqual([]);
    expect(getLearningEntries()).toEqual({});
  });

  test("propagates provider failures after the constitution step", async () => {
    resetConstitution(["Preserve provider failure rules"]);

    await expect(
      runDemo({ modelOverride: { provider: "unsupported-provider" } }),
    ).rejects.toThrow(/Unknown provider/);

    expect(requests).toHaveLength(0);
    expect(visibleOutput()).toContain("Step 1/4: Set a constitution rule");
    expect(visibleOutput()).toContain(
      "Step 2/4: Run a vibe check on a risky plan",
    );
    expect(getConstitution()).toEqual(["Preserve provider failure rules"]);
    expect(getLearningEntries()).toEqual({});
  });

  test("propagates safe plan check failure and restores state", async () => {
    resetConstitution(["Keep pre-demo rules"]);
    responseQueue.push(
      "Risky questions",
      gateDecision(false, 0.3, "missing rollback"),
      "Safe fallback questions",
    );
    let fetchCount = 0;
    onFetchRequest = (count) => {
      fetchCount = count;
      if (count === 4) {
        throw new Error("Simulated LLM failure on safe plan");
      }
    };

    await expect(runDemo()).rejects.toThrow(
      "Simulated LLM failure on safe plan",
    );

    const output = visibleOutput();
    expect(output).toContain("Step 2/4: Run a vibe check on a risky plan");
    expect(output).toContain("Step 3/4: Run a vibe check on a safe plan");
    expect(output).toContain("✗ blocked");
    expect(output).not.toContain("✓ Demo complete.");
    expect(getConstitution()).toEqual(["Keep pre-demo rules"]);
    expect(getLearningEntries()).toEqual({});
    expect(fetchCount).toBe(4);
  });

  test("prints safe plan questions and proceed decision JSON", async () => {
    responseQueue.push(
      "Risky feedback",
      gateDecision(false, 0.4, "no rollback"),
      "Safe question A\nSafe question B",
      gateDecision(true, 0.97, "thorough plan"),
    );

    await runDemo();

    const output = visibleOutput();
    expect(output).toContain("Safe question A");
    expect(output).toContain("Safe question B");
    expect(output).toContain(
      'JSON: {"proceed":true,"confidence":0.97,"reason":"thorough plan"}',
    );
    expect(getConstitution()).toEqual([]);
    expect(getLearningEntries()).toEqual({});
  });
});
