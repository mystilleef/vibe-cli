import { describe, expect, test } from "bun:test";
import {
  extractCategoryEntries,
  extractLearningEntries,
  mapLegacyEntry,
  validateLegacyLearningEntry,
} from "../src/utils/legacyImporter.js";

describe("validateLegacyLearningEntry", () => {
  test("returns null for non-object input", () => {
    expect(validateLegacyLearningEntry(null)).toBeNull();
    expect(validateLegacyLearningEntry(undefined)).toBeNull();
    expect(validateLegacyLearningEntry("string")).toBeNull();
    expect(validateLegacyLearningEntry(123)).toBeNull();
  });

  test("returns null when mistake is not a string", () => {
    expect(
      validateLegacyLearningEntry({ mistake: 123, timestamp: 1000 }),
    ).toBeNull();
    expect(
      validateLegacyLearningEntry({ mistake: null, timestamp: 1000 }),
    ).toBeNull();
    expect(validateLegacyLearningEntry({ timestamp: 1000 })).toBeNull();
  });

  test("returns null when timestamp is not a number", () => {
    expect(
      validateLegacyLearningEntry({ mistake: "test", timestamp: "1000" }),
    ).toBeNull();
    expect(
      validateLegacyLearningEntry({ mistake: "test", timestamp: null }),
    ).toBeNull();
    expect(validateLegacyLearningEntry({ mistake: "test" })).toBeNull();
  });

  test("returns null when type is invalid", () => {
    expect(
      validateLegacyLearningEntry({
        mistake: "test",
        timestamp: 1000,
        type: "invalid",
      }),
    ).toBeNull();
    expect(
      validateLegacyLearningEntry({
        mistake: "test",
        timestamp: 1000,
        type: "SUCCESS",
      }),
    ).toBeNull();
  });

  test("returns null when solution is not a string", () => {
    expect(
      validateLegacyLearningEntry({
        mistake: "test",
        timestamp: 1000,
        solution: 123,
      }),
    ).toBeNull();
    expect(
      validateLegacyLearningEntry({
        mistake: "test",
        timestamp: 1000,
        solution: null,
      }),
    ).toBeNull();
  });

  test("returns null when demoId is not a string", () => {
    expect(
      validateLegacyLearningEntry({
        mistake: "test",
        timestamp: 1000,
        demoId: 123,
      }),
    ).toBeNull();
    expect(
      validateLegacyLearningEntry({
        mistake: "test",
        timestamp: 1000,
        demoId: null,
      }),
    ).toBeNull();
  });

  test("returns validated entry for valid input", () => {
    const entry = {
      mistake: "test mistake",
      timestamp: 1000,
      type: "mistake",
      solution: "test solution",
      demoId: "demo-1",
    };
    const result = validateLegacyLearningEntry(entry);
    expect(result).toEqual(entry);
    expect(result?.mistake).toBe("test mistake");
    expect(result?.timestamp).toBe(1000);
  });

  test("accepts valid type values", () => {
    expect(
      validateLegacyLearningEntry({
        mistake: "test",
        timestamp: 1000,
        type: "mistake",
      }),
    ).not.toBeNull();
    expect(
      validateLegacyLearningEntry({
        mistake: "test",
        timestamp: 1000,
        type: "preference",
      }),
    ).not.toBeNull();
    expect(
      validateLegacyLearningEntry({
        mistake: "test",
        timestamp: 1000,
        type: "success",
      }),
    ).not.toBeNull();
  });

  test("accepts entry without optional fields", () => {
    const entry = { mistake: "test", timestamp: 1000 };
    expect(validateLegacyLearningEntry(entry)).not.toBeNull();
  });
});

describe("mapLegacyEntry", () => {
  test("maps entry with all fields", () => {
    const entry = {
      mistake: "test mistake",
      timestamp: 1000,
      type: "mistake",
      solution: "test solution",
      demoId: "demo-1",
      category: "coding",
    };
    const result = mapLegacyEntry(entry, "default-category");
    expect(result).toEqual({
      type: "mistake",
      category: "coding",
      observation: "test mistake",
      solution: "test solution",
      timestamp: 1000,
      demoId: "demo-1",
    });
  });

  test("uses category parameter when entry.category is undefined", () => {
    const entry = {
      mistake: "test mistake",
      timestamp: 1000,
    };
    const result = mapLegacyEntry(entry, "fallback-category");
    expect(result.category).toBe("fallback-category");
  });

  test("omits optional fields when undefined", () => {
    const entry = {
      mistake: "test mistake",
      timestamp: 1000,
    };
    const result = mapLegacyEntry(entry, "category");
    expect(result.type).toBeUndefined();
    expect(result.solution).toBeUndefined();
    expect(result.demoId).toBeUndefined();
    expect(result).toEqual({
      category: "category",
      observation: "test mistake",
      timestamp: 1000,
    });
  });

  test("includes optional fields when defined", () => {
    const entry = {
      mistake: "test mistake",
      timestamp: 1000,
      type: "success",
      solution: "solution",
      demoId: "demo",
    };
    const result = mapLegacyEntry(entry, "category");
    expect(result.type).toBe("success");
    expect(result.solution).toBe("solution");
    expect(result.demoId).toBe("demo");
  });
});

describe("extractCategoryEntries", () => {
  test("returns null for non-object data", () => {
    expect(extractCategoryEntries("cat", null)).toBeNull();
    expect(extractCategoryEntries("cat", undefined)).toBeNull();
    expect(extractCategoryEntries("cat", "string")).toBeNull();
  });

  test("returns null when examples is not an array", () => {
    expect(extractCategoryEntries("cat", { examples: "not-array" })).toBeNull();
    expect(extractCategoryEntries("cat", { examples: 123 })).toBeNull();
    expect(extractCategoryEntries("cat", {})).toBeNull();
  });

  test("returns null when any example is invalid", () => {
    const data = {
      examples: [
        { mistake: "valid", timestamp: 1000 },
        { mistake: "invalid", timestamp: "not-a-number" },
      ],
    };
    expect(extractCategoryEntries("cat", data)).toBeNull();
  });

  test("returns mapped entries for valid examples", () => {
    const data = {
      examples: [
        { mistake: "mistake1", timestamp: 1000 },
        { mistake: "mistake2", timestamp: 2000, type: "success" },
      ],
    };
    const result = extractCategoryEntries("test-category", data);
    expect(result).toEqual([
      {
        category: "test-category",
        observation: "mistake1",
        timestamp: 1000,
      },
      {
        type: "success",
        category: "test-category",
        observation: "mistake2",
        timestamp: 2000,
      },
    ]);
  });

  test("returns empty array for empty examples", () => {
    const data = { examples: [] };
    expect(extractCategoryEntries("cat", data)).toEqual([]);
  });

  test("uses entry.category when available", () => {
    const data = {
      examples: [{ mistake: "test", timestamp: 1000, category: "entry-cat" }],
    };
    const result = extractCategoryEntries("param-cat", data);
    expect(result?.[0]?.category).toBe("entry-cat");
  });
});

describe("extractLearningEntries", () => {
  test("returns null for non-object input", () => {
    expect(extractLearningEntries(null)).toBeNull();
    expect(extractLearningEntries(undefined)).toBeNull();
    expect(extractLearningEntries("string")).toBeNull();
  });

  test("returns null when mistakes is not an object", () => {
    expect(extractLearningEntries({ mistakes: "not-object" })).toBeNull();
    expect(extractLearningEntries({ mistakes: null })).toBeNull();
    expect(extractLearningEntries({})).toBeNull();
  });

  test("returns null when any category has invalid data", () => {
    const input = {
      mistakes: {
        valid: {
          examples: [{ mistake: "test", timestamp: 1000 }],
        },
        invalid: {
          examples: "not-array",
        },
      },
    };
    expect(extractLearningEntries(input)).toBeNull();
  });

  test("returns null when any entry is invalid", () => {
    const input = {
      mistakes: {
        coding: {
          examples: [
            { mistake: "valid", timestamp: 1000 },
            { mistake: "invalid", timestamp: "not-number" },
          ],
        },
      },
    };
    expect(extractLearningEntries(input)).toBeNull();
  });

  test("returns entries from all categories", () => {
    const input = {
      mistakes: {
        coding: {
          examples: [{ mistake: "code mistake", timestamp: 1000 }],
        },
        process: {
          examples: [{ mistake: "process mistake", timestamp: 2000 }],
        },
      },
    };
    const result = extractLearningEntries(input);
    expect(result).toEqual([
      { category: "coding", observation: "code mistake", timestamp: 1000 },
      { category: "process", observation: "process mistake", timestamp: 2000 },
    ]);
  });

  test("returns empty array when no categories", () => {
    const input = { mistakes: {} };
    expect(extractLearningEntries(input)).toEqual([]);
  });

  test("handles entries with all optional fields", () => {
    const input = {
      mistakes: {
        test: {
          examples: [
            {
              mistake: "test",
              timestamp: 1000,
              type: "success",
              solution: "solution",
              demoId: "demo",
              category: "custom",
            },
          ],
        },
      },
    };
    const result = extractLearningEntries(input);
    expect(result?.[0]).toEqual({
      type: "success",
      category: "custom",
      observation: "test",
      solution: "solution",
      timestamp: 1000,
      demoId: "demo",
    });
  });
});
