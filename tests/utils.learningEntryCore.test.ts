import { describe, expect, test } from "bun:test";
import {
  DAY_MS,
  DEFAULT_LEARNING_DUPLICATE_OVERLAP_THRESHOLD,
  getLearningOverlapScore,
  isLearningOverlapDuplicate,
  learningRowToEntry,
} from "../src/utils/learningEntryCore.js";

describe("learningRowToEntry", () => {
  test("converts full row with solution and demo_id", () => {
    const row = {
      id: 1,
      type: "mistake" as const,
      category: "risk",
      observation: "forgot rollback",
      solution: "add rollback step",
      timestamp: 1000,
      demo_id: "demo-1",
    };
    expect(learningRowToEntry(row)).toEqual({
      type: "mistake",
      category: "risk",
      observation: "forgot rollback",
      solution: "add rollback step",
      timestamp: 1000,
      demoId: "demo-1",
    });
  });

  test("omits solution when null", () => {
    const row = {
      id: 2,
      type: "preference" as const,
      category: "style",
      observation: "prefer lists",
      solution: null,
      timestamp: 2000,
      demo_id: null,
    };
    const entry = learningRowToEntry(row);
    expect(entry.solution).toBeUndefined();
    expect(entry.demoId).toBeUndefined();
  });

  test("includes solution when non-null string", () => {
    const row = {
      id: 3,
      type: "success" as const,
      category: "test",
      observation: "good pattern",
      solution: "repeat it",
      timestamp: 3000,
      demo_id: null,
    };
    expect(learningRowToEntry(row).solution).toBe("repeat it");
  });

  test("includes demo_id when non-null string", () => {
    const row = {
      id: 4,
      type: "mistake" as const,
      category: "test",
      observation: "issue",
      solution: null,
      timestamp: 4000,
      demo_id: "demo-xyz",
    };
    expect(learningRowToEntry(row).demoId).toBe("demo-xyz");
  });
});

describe("getLearningOverlapScore", () => {
  test("returns 1.0 for identical strings", () => {
    expect(getLearningOverlapScore("fix the bug", "fix the bug")).toBe(1);
  });

  test("returns 0 for completely different strings", () => {
    expect(getLearningOverlapScore("apple banana", "car dog")).toBe(0);
  });

  test("returns partial overlap score", () => {
    // "fix" and "the" overlap, total unique left: 3, min(3,3)=3, overlap=2
    expect(getLearningOverlapScore("fix the bug", "fix the issue")).toBeCloseTo(
      2 / 3,
    );
  });

  test("is case insensitive", () => {
    expect(getLearningOverlapScore("Fix The Bug", "fix the bug")).toBe(1);
  });

  test("handles empty left string", () => {
    expect(getLearningOverlapScore("", "some text")).toBe(0);
  });

  test("handles empty right string", () => {
    expect(getLearningOverlapScore("some text", "")).toBe(0);
  });

  test("handles both empty strings", () => {
    expect(getLearningOverlapScore("", "")).toBe(0);
  });

  test("handles whitespace-only strings", () => {
    expect(getLearningOverlapScore("   ", "   ")).toBe(0);
  });

  test("splits on non-word characters", () => {
    // \W+ matches non-word chars; hyphen is non-word, underscore is word char
    expect(getLearningOverlapScore("fix-bug", "fix-bug")).toBe(1);
    // underscores don't split, so "fix_bug" is one token
    expect(getLearningOverlapScore("fix_bug", "fix bug")).toBeLessThan(1);
  });

  test("uses shorter array length for denominator", () => {
    // left: ["a", "b"] (2), right: ["a", "b", "c", "d"] (4)
    // overlap: ["a", "b"] = 2, min(2, 4) = 2, score = 1
    expect(getLearningOverlapScore("a b", "a b c d")).toBe(1);
  });
});

describe("isLearningOverlapDuplicate", () => {
  test("returns true when overlap exceeds threshold", () => {
    expect(isLearningOverlapDuplicate("fix the bug", "fix the issue")).toBe(
      true,
    );
  });

  test("returns false when overlap below threshold", () => {
    expect(isLearningOverlapDuplicate("apple banana", "car dog")).toBe(false);
  });

  test("uses default threshold when not specified", () => {
    expect(DEFAULT_LEARNING_DUPLICATE_OVERLAP_THRESHOLD).toBe(0.6);
  });

  test("accepts custom threshold", () => {
    // "fix the bug" vs "fix the issue" → 2/3 ≈ 0.667
    expect(
      isLearningOverlapDuplicate("fix the bug", "fix the issue", 0.7),
    ).toBe(false);
    expect(
      isLearningOverlapDuplicate("fix the bug", "fix the issue", 0.6),
    ).toBe(true);
  });

  test("threshold of 0 includes zero-score pairs", () => {
    // Score is 0, but 0 >= 0 is true
    expect(isLearningOverlapDuplicate("apple", "banana", 0)).toBe(true);
  });

  test("threshold of 1 requires exact word set match", () => {
    expect(isLearningOverlapDuplicate("fix the bug", "fix the bug", 1)).toBe(
      true,
    );
    expect(isLearningOverlapDuplicate("fix the bug", "fix the issue", 1)).toBe(
      false,
    );
  });
});

describe("DAY_MS", () => {
  test("equals 86400000 milliseconds", () => {
    expect(DAY_MS).toBe(86_400_000);
  });
});
