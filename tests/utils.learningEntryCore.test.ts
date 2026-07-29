import { describe, expect, test } from "bun:test";
import type { LearningEntry } from "../src/utils/learningEntryCore.js";
import {
  DAY_MS,
  DEFAULT_LEARNING_DUPLICATE_OVERLAP_THRESHOLD,
  getLearningOverlapScore,
  isLearningOverlapDuplicate,
  learningRowToEntry,
  summarizeLearningCategories,
  summarizeLearningCategoryGroups,
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

describe("summarizeLearningCategoryGroups", () => {
  function entry(overrides: Partial<LearningEntry> = {}): LearningEntry {
    return {
      type: "mistake",
      category: "test",
      observation: "default observation",
      timestamp: 1000,
      ...overrides,
    };
  }

  test("builds summary for single group with single entry", () => {
    const groups: Map<string, LearningEntry[]> = new Map([
      ["risk", [entry({ category: "risk", observation: "forgot rollback" })]],
    ]);
    const result = summarizeLearningCategoryGroups(groups);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      category: "risk",
      count: 1,
    });
    expect(result[0]?.recentExample.observation).toBe("forgot rollback");
  });

  test("builds summary for single group with multiple entries — uses last entry as recentExample", () => {
    const groups: Map<string, LearningEntry[]> = new Map([
      [
        "style",
        [
          entry({
            category: "style",
            observation: "prefer lists",
            timestamp: 1000,
          }),
          entry({
            category: "style",
            observation: "use markdown",
            timestamp: 2000,
          }),
        ],
      ],
    ]);
    const result = summarizeLearningCategoryGroups(groups);
    expect(result).toHaveLength(1);
    expect(result[0]?.count).toBe(2);
    // recentExample is the last entry (timestamp 2000)
    expect(result[0]?.recentExample.observation).toBe("use markdown");
  });

  test("returns empty array for empty iterable", () => {
    expect(summarizeLearningCategoryGroups(new Map())).toEqual([]);
    expect(summarizeLearningCategoryGroups([])).toEqual([]);
  });

  test("skips groups with empty entry arrays", () => {
    const groups: Map<string, LearningEntry[]> = new Map([
      ["empty-cat", []],
      ["risk", [entry({ category: "risk", observation: "something" })]],
    ]);
    const result = summarizeLearningCategoryGroups(groups);
    expect(result).toHaveLength(1);
    expect(result[0]?.category).toBe("risk");
  });

  test("sorts by count descending, then by category lexically", () => {
    const groups: Map<string, LearningEntry[]> = new Map([
      ["zebra", [entry({ category: "zebra" })]],
      [
        "beta",
        [
          entry({ category: "beta", observation: "b1" }),
          entry({ category: "beta", observation: "b2" }),
          entry({ category: "beta", observation: "b3" }),
        ],
      ],
      [
        "alpha",
        [
          entry({ category: "alpha", observation: "a1" }),
          entry({ category: "alpha", observation: "a2" }),
          entry({ category: "alpha", observation: "a3" }),
        ],
      ],
    ]);
    const result = summarizeLearningCategoryGroups(groups);
    // beta (3) and alpha (3) have same count, lexical order: alpha < beta
    // Then zebra (1)
    expect(result.map((s) => s.category)).toEqual(["alpha", "beta", "zebra"]);
    expect(result.map((s) => s.count)).toEqual([3, 3, 1]);
  });

  test("sorts by count when counts differ", () => {
    const groups: Map<string, LearningEntry[]> = new Map([
      ["rare", [entry({ category: "rare" })]],
      [
        "common",
        [
          entry({ category: "common", observation: "c1" }),
          entry({ category: "common", observation: "c2" }),
          entry({ category: "common", observation: "c3" }),
          entry({ category: "common", observation: "c4" }),
        ],
      ],
      [
        "medium",
        [
          entry({ category: "medium", observation: "m1" }),
          entry({ category: "medium", observation: "m2" }),
        ],
      ],
    ]);
    const result = summarizeLearningCategoryGroups(groups);
    expect(result.map((s) => s.category)).toEqual(["common", "medium", "rare"]);
  });

  test("works with Iterable (not just Map)", () => {
    const groups: [string, LearningEntry[]][] = [
      ["cat", [entry({ category: "cat", observation: "hello" })]],
    ];
    const result = summarizeLearningCategoryGroups(groups);
    expect(result).toHaveLength(1);
    expect(result[0]?.category).toBe("cat");
  });

  test("recentExample carries all fields from the last entry", () => {
    const groups: Map<string, LearningEntry[]> = new Map([
      [
        "success",
        [
          entry({
            type: "success",
            category: "success",
            observation: "first",
            solution: "old",
            timestamp: 1000,
            demoId: "demo-1",
          }),
          entry({
            type: "success",
            category: "success",
            observation: "last",
            solution: "new",
            timestamp: 2000,
            demoId: "demo-2",
          }),
        ],
      ],
    ]);
    const result = summarizeLearningCategoryGroups(groups);
    expect(result[0]?.recentExample).toMatchObject({
      observation: "last",
      solution: "new",
      demoId: "demo-2",
      timestamp: 2000,
    });
  });
});

describe("summarizeLearningCategories", () => {
  function entry(overrides: Partial<LearningEntry> = {}): LearningEntry {
    return {
      type: "mistake",
      category: "test",
      observation: "default",
      timestamp: 1000,
      ...overrides,
    };
  }

  test("groups entries by category and builds summaries", () => {
    const learnings: LearningEntry[] = [
      entry({ category: "risk", observation: "forgot rollback" }),
      entry({ category: "style", observation: "prefer lists" }),
      entry({ category: "risk", observation: "missing validation" }),
    ];
    const result = summarizeLearningCategories(learnings);
    // risk has 2, style has 1 — sorted by count desc
    expect(result.map((s) => s.category)).toEqual(["risk", "style"]);
    expect(result[0]?.count).toBe(2);
    expect(result[1]?.count).toBe(1);
  });

  test("returns empty array for empty learnings", () => {
    expect(summarizeLearningCategories([])).toEqual([]);
  });

  test("recent example is the last entry per category (by array order)", () => {
    const learnings: LearningEntry[] = [
      entry({ category: "risk", observation: "first risk", timestamp: 1000 }),
      entry({ category: "risk", observation: "last risk", timestamp: 2000 }),
    ];
    const result = summarizeLearningCategories(learnings);
    expect(result[0]?.recentExample.observation).toBe("last risk");
  });

  test("entries with different categories stay separate", () => {
    const learnings: LearningEntry[] = [
      entry({ category: "a", observation: "a1" }),
      entry({ category: "b", observation: "b1" }),
      entry({ category: "a", observation: "a2" }),
      entry({ category: "c", observation: "c1" }),
      entry({ category: "b", observation: "b2" }),
      entry({ category: "b", observation: "b3" }),
    ];
    const result = summarizeLearningCategories(learnings);
    // b=3, a=2, c=1
    expect(result.map((s) => `${s.category}:${s.count}`)).toEqual([
      "b:3",
      "a:2",
      "c:1",
    ]);
  });
});

describe("DAY_MS", () => {
  test("equals 86400000 milliseconds", () => {
    expect(DAY_MS).toBe(86_400_000);
  });
});
