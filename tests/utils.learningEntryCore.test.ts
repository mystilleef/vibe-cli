import { describe, expect, test } from "bun:test";
import {
  getLearningOverlapScore,
  isLearningOverlapDuplicate,
  learningRowToEntry,
} from "../src/utils/learningEntryCore";

// ── getLearningOverlapScore ───────────────────────────────────────────────

describe("getLearningOverlapScore", () => {
  test("returns 0 when both strings are empty", () => {
    expect(getLearningOverlapScore("", "")).toBe(0);
  });

  test("returns 0 when left string is empty", () => {
    expect(getLearningOverlapScore("", "alpha beta")).toBe(0);
  });

  test("returns 0 when right string is empty", () => {
    expect(getLearningOverlapScore("alpha beta", "")).toBe(0);
  });

  test("returns 0 when both strings are whitespace only", () => {
    expect(getLearningOverlapScore("   ", "\t\n")).toBe(0);
  });

  test("returns 1 for identical strings", () => {
    expect(
      getLearningOverlapScore("alpha beta gamma", "alpha beta gamma"),
    ).toBe(1);
  });

  test("returns 0 for completely disjoint strings", () => {
    expect(getLearningOverlapScore("alpha beta", "gamma delta")).toBe(0);
  });

  test("case-insensitive matching", () => {
    expect(getLearningOverlapScore("ALPHA BETA", "alpha beta")).toBe(1);
  });

  test("partial overlap computes correct ratio", () => {
    const score = getLearningOverlapScore(
      "alpha beta gamma delta",
      "alpha beta zeta eta",
    );
    expect(score).toBe(0.5); // 2 overlapping / min(4,4) = 0.5
  });

  test("punctuation is split as word boundaries", () => {
    const score = getLearningOverlapScore(
      "alpha, beta; gamma",
      "alpha beta gamma",
    );
    expect(score).toBe(1);
  });

  test("shorter string determines denominator", () => {
    // left has 5 words, right has 3. Overlap: 2 ("alpha", "beta").
    // score = 2 / min(5, 3) = 2/3
    const score = getLearningOverlapScore(
      "alpha beta gamma delta epsilon",
      "alpha beta zeta",
    );
    expect(score).toBeCloseTo(2 / 3, 5);
  });
});

// ── isLearningOverlapDuplicate ────────────────────────────────────────────

describe("isLearningOverlapDuplicate", () => {
  test("returns true when overlap meets default threshold", () => {
    expect(
      isLearningOverlapDuplicate(
        "alpha beta gamma delta",
        "alpha beta gamma zeta",
      ),
    ).toBe(true); // 3/4 = 0.75 > 0.6
  });

  test("returns false when overlap is below default threshold", () => {
    expect(
      isLearningOverlapDuplicate(
        "alpha beta gamma delta epsilon",
        "alpha zeta eta theta iota",
      ),
    ).toBe(false); // 1/5 = 0.2
  });

  test("threshold 0 always returns true for non-empty strings", () => {
    expect(isLearningOverlapDuplicate("alpha beta", "gamma delta", 0)).toBe(
      true,
    );
    expect(isLearningOverlapDuplicate("x", "y", 0)).toBe(true);
  });

  test("threshold 1 requires exact match", () => {
    expect(isLearningOverlapDuplicate("alpha beta", "alpha beta", 1)).toBe(
      true,
    );
    // "alpha beta" vs "alpha gamma" overlap = 1/2 = 0.5, below 1.0
    expect(isLearningOverlapDuplicate("alpha beta", "alpha gamma", 1)).toBe(
      false,
    );
  });

  test("empty strings satisfy threshold 0 (score 0 >= 0)", () => {
    expect(isLearningOverlapDuplicate("", "", 0)).toBe(true);
  });
});

// ── learningRowToEntry ────────────────────────────────────────────────────

describe("learningRowToEntry", () => {
  test("maps all non-null fields from storage row to entry", () => {
    const row = {
      id: 1,
      type: "mistake" as const,
      category: "imports",
      observation: "forgot import",
      solution: "add import",
      timestamp: 1000,
      demo_id: "demo-1",
    };
    const entry = learningRowToEntry(row);
    expect(entry).toEqual({
      type: "mistake",
      category: "imports",
      observation: "forgot import",
      solution: "add import",
      timestamp: 1000,
      demoId: "demo-1",
    });
  });

  test("omits solution when null", () => {
    const row = {
      id: 2,
      type: "preference" as const,
      category: "style",
      observation: "use tabs",
      solution: null,
      timestamp: 2000,
      demo_id: null,
    };
    const entry = learningRowToEntry(row);
    expect(entry).toEqual({
      type: "preference",
      category: "style",
      observation: "use tabs",
      timestamp: 2000,
    });
    expect("solution" in entry).toBe(false);
    expect("demoId" in entry).toBe(false);
  });

  test("handles success type row", () => {
    const row = {
      id: 3,
      type: "success" as const,
      category: "testing",
      observation: "DRY test helpers",
      solution: "extracted setup",
      timestamp: 3000,
      demo_id: null,
    };
    const entry = learningRowToEntry(row);
    expect(entry.type).toBe("success");
    expect(entry.solution).toBe("extracted setup");
    expect("demoId" in entry).toBe(false);
  });

  test("preserves id field is not propagated (id is not part of LearningEntry)", () => {
    const row = {
      id: 99,
      type: "mistake" as const,
      category: "x",
      observation: "y",
      solution: null,
      timestamp: 1,
      demo_id: null,
    };
    const entry = learningRowToEntry(row);
    expect("id" in entry).toBe(false);
  });
});
