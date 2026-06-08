import { describe, expect, test } from "bun:test";
import {
  buildCheckParams,
  buildPruneParams,
  parsePruneNumericOpts,
  resolveModelOverride,
} from "../src/utils/cliHelpers";

/** Run fn with VIBE_MAX_ATTEMPTS set to value, restoring the original afterward. */
function withMaxAttemptsEnv(value: string | undefined, fn: () => void): void {
  const original = process.env["VIBE_MAX_ATTEMPTS"];
  try {
    if (value === undefined) {
      delete process.env["VIBE_MAX_ATTEMPTS"];
    } else {
      process.env["VIBE_MAX_ATTEMPTS"] = value;
    }
    fn();
  } finally {
    if (original === undefined) {
      delete process.env["VIBE_MAX_ATTEMPTS"];
    } else {
      process.env["VIBE_MAX_ATTEMPTS"] = original;
    }
  }
}

describe("resolveModelOverride", () => {
  test("returns empty object when neither provider nor model set", () => {
    expect(resolveModelOverride({})).toEqual({});
  });

  test("returns provider only", () => {
    expect(resolveModelOverride({ provider: "openai" })).toEqual({
      modelOverride: { provider: "openai" },
    });
  });

  test("returns model only", () => {
    expect(resolveModelOverride({ model: "gpt-4" })).toEqual({
      modelOverride: { model: "gpt-4" },
    });
  });

  test("returns both provider and model", () => {
    expect(
      resolveModelOverride({ provider: "openai", model: "gpt-4" }),
    ).toEqual({
      modelOverride: { provider: "openai", model: "gpt-4" },
    });
  });

  test("handles empty string values as falsy", () => {
    expect(resolveModelOverride({ provider: "", model: "" })).toEqual({});
  });
});

describe("buildCheckParams", () => {
  const baseOpts = {
    goal: "test goal",
    plan: "test plan",
  };

  test("builds params with required fields only", () => {
    const result = buildCheckParams(baseOpts);
    expect(result.params.goal).toBe("test goal");
    expect(result.params.plan).toBe("test plan");
    expect(result.params.progress).toBeUndefined();
    expect(result.params.uncertainties).toBeUndefined();
    expect(result.params.taskContext).toBeUndefined();
    expect(result.params.userPrompt).toBeUndefined();
    expect(result.params.modelOverride).toBeUndefined();
    expect(result.maxAttempts).toBe(10);
  });

  test("includes optional fields when present", () => {
    const opts = {
      ...baseOpts,
      progress: "50%",
      uncertainty: ["maybe", "unsure"],
      context: "some context",
      prompt: "user prompt",
      maxAttempts: "5",
    };
    const result = buildCheckParams(opts);
    expect(result.params.progress).toBe("50%");
    expect(result.params.uncertainties).toEqual(["maybe", "unsure"]);
    expect(result.params.taskContext).toBe("some context");
    expect(result.params.userPrompt).toBe("user prompt");
    expect(result.maxAttempts).toBe(5);
  });

  test("clamps maxAttempts — zero and negative fall back to default 10", () => {
    // parseInt returns 0, then `0 || 10` → 10, then Math.max(1, 10) → 10
    expect(
      buildCheckParams({ ...baseOpts, maxAttempts: "0" }).maxAttempts,
    ).toBe(10);
    // parseInt returns -5, then `-5 || 10` → -5, then Math.max(1, -5) → 1
    expect(
      buildCheckParams({ ...baseOpts, maxAttempts: "-5" }).maxAttempts,
    ).toBe(1);
  });

  test("defaults maxAttempts to 10 on NaN", () => {
    expect(
      buildCheckParams({ ...baseOpts, maxAttempts: "abc" }).maxAttempts,
    ).toBe(10);
    expect(
      buildCheckParams({ ...baseOpts, maxAttempts: undefined }).maxAttempts,
    ).toBe(10);
  });

  test("uses settingsMaxAttempts when CLI option absent", () => {
    const result = buildCheckParams(baseOpts, 7);
    expect(result.maxAttempts).toBe(7);
  });

  test("CLI option overrides settingsMaxAttempts", () => {
    const result = buildCheckParams({ ...baseOpts, maxAttempts: "3" }, 7);
    expect(result.maxAttempts).toBe(3);
  });

  test("settingsMaxAttempts overrides env var", () => {
    withMaxAttemptsEnv("2", () => {
      const result = buildCheckParams(baseOpts, 7);
      expect(result.maxAttempts).toBe(7);
    });
  });

  test("env var used when settingsMaxAttempts and CLI absent", () => {
    withMaxAttemptsEnv("4", () => {
      const result = buildCheckParams(baseOpts);
      expect(result.maxAttempts).toBe(4);
    });
  });

  test("falls back to default 10 when all sources absent", () => {
    withMaxAttemptsEnv(undefined, () => {
      const result = buildCheckParams(baseOpts);
      expect(result.maxAttempts).toBe(10);
    });
  });

  test("env var NaN falls back to default 10", () => {
    withMaxAttemptsEnv("abc", () => {
      const result = buildCheckParams(baseOpts);
      expect(result.maxAttempts).toBe(10);
    });
  });

  test("env var '0' clamped to 1 by Math.max", () => {
    withMaxAttemptsEnv("0", () => {
      const result = buildCheckParams(baseOpts);
      // parseInt('0') = 0, resolved = 0, Math.max(1, 0) = 1
      expect(result.maxAttempts).toBe(1);
    });
  });

  test("settingsMaxAttempts used when env var is NaN", () => {
    withMaxAttemptsEnv("abc", () => {
      const result = buildCheckParams(baseOpts, 5);
      expect(result.maxAttempts).toBe(5);
    });
  });

  test("CLI '0' falls through to settingsMaxAttempts", () => {
    const result = buildCheckParams({ ...baseOpts, maxAttempts: "0" }, 7);
    expect(result.maxAttempts).toBe(7);
  });

  test("CLI NaN falls through to settingsMaxAttempts", () => {
    const result = buildCheckParams({ ...baseOpts, maxAttempts: "abc" }, 7);
    expect(result.maxAttempts).toBe(7);
  });

  test("CLI negative wins over settingsMaxAttempts, clamped to 1", () => {
    const result = buildCheckParams({ ...baseOpts, maxAttempts: "-5" }, 7);
    // -5 is valid (not 0, not NaN), so CLI wins; Math.max(1, -5) = 1
    expect(result.maxAttempts).toBe(1);
  });

  test("includes model override when provider set", () => {
    const result = buildCheckParams({ ...baseOpts, provider: "openai" });
    expect(result.params.modelOverride).toEqual({ provider: "openai" });
  });

  test("includes model override when model set", () => {
    const result = buildCheckParams({ ...baseOpts, model: "gpt-4" });
    expect(result.params.modelOverride).toEqual({ model: "gpt-4" });
  });
});

describe("parsePruneNumericOpts", () => {
  test("returns undefined age and overlap for empty opts", () => {
    const result = parsePruneNumericOpts({});
    expect(result.age).toBeUndefined();
    expect(result.overlap).toBeUndefined();
  });

  test("parses valid age", () => {
    expect(parsePruneNumericOpts({ age: "30" }).age).toBe(30);
    expect(parsePruneNumericOpts({ age: "0" }).age).toBe(0);
    expect(parsePruneNumericOpts({ age: "-5" }).age).toBe(-5);
  });

  test("parses valid overlap", () => {
    expect(parsePruneNumericOpts({ overlap: "0.8" }).overlap).toBe(0.8);
    expect(parsePruneNumericOpts({ overlap: "0" }).overlap).toBe(0);
    expect(parsePruneNumericOpts({ overlap: "1" }).overlap).toBe(1);
  });

  test("throws on NaN age", () => {
    expect(() => parsePruneNumericOpts({ age: "abc" })).toThrow(
      "--age must be a valid integer",
    );
  });

  test("throws on NaN overlap", () => {
    expect(() => parsePruneNumericOpts({ overlap: "abc" })).toThrow(
      "--overlap must be a valid number between 0 and 1",
    );
  });

  test("handles undefined values", () => {
    const result = parsePruneNumericOpts({
      age: undefined,
      overlap: undefined,
    });
    expect(result.age).toBeUndefined();
    expect(result.overlap).toBeUndefined();
  });
});

describe("buildPruneParams", () => {
  test("returns empty params for empty opts", () => {
    const { params } = buildPruneParams({});
    expect(params).toEqual({});
  });

  test("parses boolean flags", () => {
    const { params } = buildPruneParams({
      learnings: true,
      duplicates: true,
      demos: true,
      sessions: true,
      dryRun: true,
      yes: true,
    });
    expect(params.learnings).toBe(true);
    expect(params.duplicates).toBe(true);
    expect(params.demos).toBe(true);
    expect(params.sessions).toBe(true);
    expect(params.dryRun).toBe(true);
    expect(params.yes).toBe(true);
  });

  test("includes parsed numeric values", () => {
    const { params } = buildPruneParams({ age: "30", overlap: "0.8" });
    expect(params.age).toBe(30);
    expect(params.overlap).toBe(0.8);
  });

  test("includes category", () => {
    const { params } = buildPruneParams({ category: "testing" });
    expect(params.category).toBe("testing");
  });

  test("handles undefined optional fields", () => {
    const { params } = buildPruneParams({
      age: undefined,
      overlap: undefined,
      category: undefined,
    });
    expect(params.age).toBeUndefined();
    expect(params.overlap).toBeUndefined();
    expect(params.category).toBeUndefined();
  });

  test("ignores false boolean flags", () => {
    const { params } = buildPruneParams({
      learnings: false,
      duplicates: false,
    });
    expect(params.learnings).toBeUndefined();
    expect(params.duplicates).toBeUndefined();
  });
});
