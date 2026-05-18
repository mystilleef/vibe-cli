import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { type VibeLearnInput, vibeLearnTool } from "../src/tools/vibeLearn";
import {
  addLearningEntry,
  getLearningCategorySummary,
  getLearningEntries,
} from "../src/utils/storage";
import { createTempHome, type TempHomeContext } from "./helpers/tempHome";

let home: TempHomeContext | undefined;
const originalConsoleError = console.error;

beforeEach(async () => {
  home = await createTempHome();
  console.error = () => {};
});

afterEach(async () => {
  console.error = originalConsoleError;
  if (home) await home.cleanup();
  home = undefined;
});

describe("vibeLearnTool", () => {
  test("adds a sanitized learning entry and preserves custom categories", async () => {
    const input: VibeLearnInput = {
      mistake: "Agent kept adding tools. Extra sentence should be ignored.",
      category: "bespoke workflow",
      solution: "Keep the toolset minimal",
      type: "mistake",
    };

    const result = await vibeLearnTool(input);
    const entries = getLearningEntries()["bespoke workflow"] ?? [];

    expect(result.added).toBe(true);
    expect(result.alreadyKnown).toBe(false);
    expect(result.currentTally).toBe(1);
    expect(result.topCategories[0]?.category).toBe("bespoke workflow");
    expect(entries).toHaveLength(1);
    expect(entries[0]?.mistake).toBe("Agent kept adding tools.");
    expect(entries[0]?.solution).toBe("Keep the toolset minimal.");
  });

  test("accepts preferences without solutions and normalizes overtooling categories", async () => {
    const result = await vibeLearnTool({
      mistake: "Prefer one verification tool",
      category: "too many tools",
      type: "preference",
    });
    const entries = getLearningEntries().Overtooling ?? [];

    expect(result.added).toBe(true);
    expect(result.currentTally).toBe(1);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.type).toBe("preference");
    expect(entries[0]?.solution).toBeUndefined();
    expect(entries[0]?.mistake).toBe("Prefer one verification tool.");
  });

  test("rejects mistake and success entries without a solution", async () => {
    const missingMistakeSolution = await vibeLearnTool({
      mistake: "Missing solution",
      category: "validation",
    });
    const missingSuccessSolution = await vibeLearnTool({
      mistake: "Good outcome",
      category: "validation",
      type: "success",
    });

    expect(missingMistakeSolution).toEqual({
      added: false,
      alreadyKnown: false,
      currentTally: 0,
      topCategories: [],
    });
    expect(missingSuccessSolution).toEqual({
      added: false,
      alreadyKnown: false,
      currentTally: 0,
      topCategories: [],
    });
    expect(getLearningEntries()).toEqual({});
  });

  test("skips new writes for similar existing mistakes", async () => {
    const category = "Premature Implementation";
    await vibeLearnTool({
      mistake: "Repeat the exact same risky plan.",
      category,
      solution: "Verify before acting.",
    });

    const result = await vibeLearnTool({
      mistake: "repeat exact same risky plan now.",
      category,
      solution: "Stop and verify first.",
    });
    const entries = getLearningEntries()[category] ?? [];

    expect(result.added).toBe(false);
    expect(result.alreadyKnown).toBe(true);
    expect(result.currentTally).toBe(1);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.solution).toBe("Verify before acting.");
  });

  test("rejects input with missing mistake", async () => {
    const result = await vibeLearnTool({
      mistake: "",
      category: "validation",
    });
    expect(result).toEqual({
      added: false,
      alreadyKnown: false,
      currentTally: 0,
      topCategories: [],
    });
  });

  test("rejects input with missing category", async () => {
    const result = await vibeLearnTool({
      mistake: "A mistake",
      category: "",
    });
    expect(result).toEqual({
      added: false,
      alreadyKnown: false,
      currentTally: 0,
      topCategories: [],
    });
  });

  test("accepts success type entries with a solution", async () => {
    const result = await vibeLearnTool({
      mistake: "Achieved a great outcome",
      category: "wins",
      solution: "Keep doing it this way",
      type: "success",
    });
    const entries = getLearningEntries().wins ?? [];

    expect(result.added).toBe(true);
    expect(result.currentTally).toBe(1);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.type).toBe("success");
    expect(entries[0]?.solution).toBe("Keep doing it this way.");
  });

  test("passes demoId through to the storage layer", async () => {
    const result = await vibeLearnTool({
      mistake: "Demo test entry.",
      category: "democat",
      solution: "Demo test solution.",
      demoId: "my-demo-123",
    });
    expect(result.added).toBe(true);

    const entries = getLearningEntries().democat ?? [];
    expect(entries).toHaveLength(1);
    expect(entries[0]?.demoId).toBe("my-demo-123");
  });

  test("normalizes all standard categories via keyword matching", async () => {
    const suites = [
      { input: "complex solution needed", expected: "Complex Solution Bias" },
      { input: "extra feature scope creep", expected: "Feature Creep" },
      { input: "jumping in too early", expected: "Premature Implementation" },
      { input: "wrong direction misaligned", expected: "Misalignment" },
      { input: "unnecessary tools overkill", expected: "Overtooling" },
    ];

    for (const { input, expected } of suites) {
      const result = await vibeLearnTool({
        mistake: `Test for ${input}.`,
        category: input,
        solution: "Normalize test solution.",
      });
      const summary = getLearningCategorySummary();
      const found = summary.find((s) => s.category === expected);
      expect(
        found,
        `category "${input}" should map to "${expected}"`,
      ).toBeDefined();
      expect(result.added).toBe(true);
    }

    // All 5 standard categories should exist with count=1 each
    const summary = getLearningCategorySummary();
    expect(summary).toHaveLength(5);
    for (const s of summary) {
      expect(s.count).toBe(1);
    }
  });

  test("ignores empty legacy mistakes when checking similarity", async () => {
    addLearningEntry("", "legacy", "legacy solution");

    const result = await vibeLearnTool({
      mistake: "Recover from malformed historical records",
      category: "legacy",
      solution: "Treat empty legacy mistakes as non-matches",
    });
    const entries = getLearningEntries().legacy ?? [];
    const summary = getLearningCategorySummary().find(
      (category) => category.category === "legacy",
    );

    expect(result.added).toBe(true);
    expect(result.alreadyKnown).toBe(false);
    expect(result.currentTally).toBe(2);
    expect(entries.map((entry) => entry.mistake)).toEqual([
      "",
      "Recover from malformed historical records.",
    ]);
    expect(summary?.count).toBe(2);
  });
});
