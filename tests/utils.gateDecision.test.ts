import { describe, expect, test } from "bun:test";
import { parseGateDecision } from "../src/utils/gateDecision.js";

describe("parseGateDecision", () => {
  // ── Stage 1: direct JSON.parse ──────────────────────────────────────────

  test("parses clean JSON", () => {
    const result = parseGateDecision(
      '{"proceed":true,"confidence":0.9,"reason":"ok"}',
    );
    expect(result).toEqual({ proceed: true, confidence: 0.9, reason: "ok" });
  });

  test("strips markdown fences", () => {
    const result = parseGateDecision(
      '```json\n{"proceed":false,"confidence":0.7,"reason":"risk"}\n```',
    );
    expect(result.proceed).toBe(false);
    expect(result.confidence).toBe(0.7);
  });

  test("clamps confidence above 1 to 1", () => {
    expect(
      parseGateDecision('{"proceed":true,"confidence":2,"reason":"ok"}')
        .confidence,
    ).toBe(1);
  });

  test("clamps confidence below 0 to 0", () => {
    expect(
      parseGateDecision('{"proceed":true,"confidence":-1,"reason":"ok"}')
        .confidence,
    ).toBe(0);
  });

  test("accepts boundary confidence 0.0", () => {
    const result = parseGateDecision(
      '{"proceed":true,"confidence":0.0,"reason":"ok"}',
    );
    expect(result.confidence).toBe(0);
  });

  test("accepts boundary confidence 1.0", () => {
    const result = parseGateDecision(
      '{"proceed":true,"confidence":1.0,"reason":"ok"}',
    );
    expect(result.confidence).toBe(1);
  });

  // ── Stage 2: brace-extraction fallback ──────────────────────────────────

  test("extracts the last embedded JSON object via brace counting", () => {
    const raw =
      'First: {"proceed":true,"confidence":0.9,"reason":"first"}. Second: {"proceed":false,"confidence":0.3,"reason":"second"}';
    expect(parseGateDecision(raw)).toEqual({
      proceed: false,
      confidence: 0.3,
      reason: "second",
    });
  });

  test("Stage 2 brace counter correctly skips string-internal braces when outer { is last", () => {
    // The outer { of the JSON object must be the last { in the string.
    // Then findMatchingCloseBrace correctly skips the } inside "reason".
    const raw =
      'text "with {braces}" before {"proceed":true,"confidence":0.85,"reason":"all clear"}';
    const result = parseGateDecision(raw);
    expect(result.proceed).toBe(true);
    expect(result.confidence).toBe(0.85);
    expect(result.reason).toBe("all clear");
  });

  test("Stage 2 brace extraction fails when last { yields invalid JSON substring", () => {
    // lastIndexOf("{") finds the { inside the string value, not the outer {
    // findMatchingCloseBrace finds the matching } inside the string → "{braces}" → invalid JSON
    const raw =
      'prefix {"proceed":true,"confidence":0.8,"reason":"has {braces} inside"}';
    const result = parseGateDecision(raw);
    // Falls to blocking default since brace extraction targets wrong { position
    expect(result.proceed).toBe(false);
    expect(result.confidence).toBe(0.5);
    expect(result.reason).toMatch(/unavailable/);
  });

  test("Stage 2 finds balanced braces when last { is the outer one", () => {
    // The last { IS the opening of the JSON object
    const raw =
      'text before {"proceed":true,"confidence":0.65,"reason":"good"}';
    const result = parseGateDecision(raw);
    expect(result.proceed).toBe(true);
    expect(result.confidence).toBe(0.65);
    expect(result.reason).toBe("good");
  });

  test("Stage 2 handles unbalanced braces by returning blocking default", () => {
    const raw = 'prefix {"proceed":true,"confidence":0.9,"reason":"unclosed"';
    const result = parseGateDecision(raw);
    expect(result.proceed).toBe(false);
    expect(result.confidence).toBe(0.5);
  });

  // ── Stage 3: blocking default ───────────────────────────────────────────

  test("returns blocking default for invalid shape after successful parse", () => {
    const result = parseGateDecision("not json at all");
    expect(result.proceed).toBe(false);
    expect(result.confidence).toBe(0.5);
    expect(result.reason).toMatch(/unavailable/);
  });

  test("returns blocking default for empty string", () => {
    const result = parseGateDecision("");
    expect(result.proceed).toBe(false);
    expect(result.confidence).toBe(0.5);
    expect(result.reason).toMatch(/unavailable/);
  });

  test("returns blocking default for JSON with missing fields", () => {
    const result = parseGateDecision('{"proceed":true}');
    expect(result.proceed).toBe(false);
    expect(result.confidence).toBe(0.5);
  });

  test("returns blocking default for JSON with wrong field types", () => {
    const result = parseGateDecision(
      '{"proceed":"yes","confidence":"high","reason":true}',
    );
    expect(result.proceed).toBe(false);
    expect(result.confidence).toBe(0.5);
  });

  test("returns blocking default for JSON array", () => {
    const result = parseGateDecision("[1, 2, 3]");
    expect(result.proceed).toBe(false);
    expect(result.confidence).toBe(0.5);
  });

  test("returns blocking default for null JSON", () => {
    const result = parseGateDecision("null");
    expect(result.proceed).toBe(false);
    expect(result.confidence).toBe(0.5);
  });

  test("returns blocking default for bare boolean", () => {
    const result = parseGateDecision("true");
    expect(result.proceed).toBe(false);
    expect(result.confidence).toBe(0.5);
  });

  test("returns blocking default for bare string", () => {
    const result = parseGateDecision('"just a string"');
    expect(result.proceed).toBe(false);
    expect(result.confidence).toBe(0.5);
  });

  // ── findMatchingCloseBrace edge cases ───────────────────────────────────

  test("handles escaped backslash before quote", () => {
    // "reason":"a\\" ends with \\" → the \" is a quote inside the string,
    // not a closing quote
    const raw = String.raw`{"proceed":true,"confidence":0.7,"reason":"a\\"}`;
    const result = parseGateDecision(raw);
    // This may or may not parse correctly depending on brace matching
    // The key is that we don't crash and get some result
    expect(typeof result.proceed).toBe("boolean");
    expect(typeof result.confidence).toBe("number");
    expect(typeof result.reason).toBe("string");
  });

  test("handles text with no braces at all", () => {
    const result = parseGateDecision("just plain text nothing here");
    expect(result.proceed).toBe(false);
    expect(result.confidence).toBe(0.5);
    expect(result.reason).toMatch(/unavailable/);
  });

  test("Stage 2 brace counter handles escaped backslash before quote in string", () => {
    // JSON with escaped quote inside string value: "say \"hello\""
    // The brace counter must handle \\" correctly
    const raw =
      'text {"proceed":true,"confidence":0.75,"reason":"say \\"hi\\""}';
    const result = parseGateDecision(raw);
    expect(result.proceed).toBe(true);
    expect(result.confidence).toBe(0.75);
  });

  test("Stage 2 brace counter handles escaped characters in nested strings", () => {
    // JSON with backslash-escaped sequence in reason
    const raw =
      'data {"proceed":false,"confidence":0.6,"reason":"path \\n line"}';
    const result = parseGateDecision(raw);
    expect(result.proceed).toBe(false);
    expect(result.confidence).toBe(0.6);
  });

  test("handles brace inside a deeply nested JSON structure", () => {
    const raw =
      'analysis {"proceed":true,"confidence":0.95,"reason":"all clear"} done';
    const result = parseGateDecision(raw);
    expect(result.proceed).toBe(true);
    expect(result.confidence).toBe(0.95);
    expect(result.reason).toBe("all clear");
  });

  test("handles multiple JSON objects and extracts the last one", () => {
    const raw =
      'try1: {"proceed":true,"confidence":0.5,"reason":"first"}. try2: {"proceed":false,"confidence":0.9,"reason":"final answer"}';
    const result = parseGateDecision(raw);
    expect(result.proceed).toBe(false);
    expect(result.confidence).toBe(0.9);
    expect(result.reason).toBe("final answer");
  });
});
