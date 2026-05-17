import { afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTempHome, type TempHomeContext } from "./helpers/tempHome";

const llmInputs: unknown[] = [];

mock.module("../src/utils/llm.js", () => ({
  FALLBACK_QUESTIONS: "fallback",
  getMetacognitiveQuestions: async (input: unknown) => {
    llmInputs.push(input);
    return { questions: "approved" };
  },
  getGateDecision: async () => ({
    proceed: true,
    confidence: 0.99,
    reason: "sound",
  }),
  revisePlan: async () => "revised",
}));

let home: TempHomeContext | undefined;
let cwd: string | undefined;
const originalCwd = process.cwd();
let tools: typeof import("../src/tools/vibeCheck") &
  typeof import("../src/tools/vibeGate") &
  typeof import("../src/utils/state");

beforeAll(async () => {
  tools = {
    ...(await import("../src/tools/vibeCheck")),
    ...(await import("../src/tools/vibeGate")),
    ...(await import("../src/utils/state")),
  };
});

afterEach(async () => {
  process.chdir(originalCwd);
  llmInputs.length = 0;
  if (cwd) await rm(cwd, { recursive: true, force: true });
  cwd = undefined;
  if (home) await home.cleanup();
  home = undefined;
});

async function setupIsolatedCwd() {
  home = await createTempHome();
  cwd = await mkdtemp(join(tmpdir(), "vibe-cli-check-"));
  process.chdir(cwd);
  await tools.loadHistory();
}

function readHistoryKeys(): string[] {
  const file = join(home?.dataRoot, "history.json");
  expect(existsSync(file)).toBe(true);
  return Object.keys(JSON.parse(readFileSync(file, "utf8")));
}

describe("check and gate autosession sourcing", () => {
  test("check resolves one autosession for history summary, request context, and append", async () => {
    await setupIsolatedCwd();

    await tools.vibeCheckTool({ goal: "g1", plan: "p1" });
    await tools.vibeCheckTool({ goal: "g2", plan: "p2" });

    const keys = readHistoryKeys();
    expect(keys).toHaveLength(1);
    expect(keys[0]).not.toBe("default");
    expect(llmInputs).toEqual([
      expect.objectContaining({ sessionId: keys[0], historySummary: "" }),
      expect.objectContaining({
        sessionId: keys[0],
        historySummary: expect.stringContaining("Goal g1"),
      }),
    ]);
  });

  test("gate callers do not pass session IDs and still append under the current autosession", async () => {
    await setupIsolatedCwd();

    const result = await tools.vibeGateTool({ goal: "gate", plan: "plan" });

    expect(result.proceed).toBe(true);
    const keys = readHistoryKeys();
    expect(keys).toHaveLength(1);
    expect(llmInputs[0]).toEqual(
      expect.objectContaining({ sessionId: keys[0] }),
    );
  });
});
