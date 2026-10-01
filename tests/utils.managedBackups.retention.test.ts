/**
 * Retention-count invariant for managed backup purging. Doctor resolves
 * `--keep-backups` through this contract, so accepted and rejected shapes
 * are pinned at the source: a positive, safely representable integer.
 */
import { describe, expect, test } from "bun:test";
import {
  assertValidRetention,
  isValidRetention,
} from "../src/utils/managedBackups.js";

describe("isValidRetention", () => {
  test.each([1, 2, 5, Number.MAX_SAFE_INTEGER])(
    "accepts positive safely representable integer %d",
    (value) => {
      expect(isValidRetention(value)).toBe(true);
    },
  );

  test.each([
    0,
    -1,
    0.5,
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    Number.MAX_SAFE_INTEGER + 1,
    Number.MIN_SAFE_INTEGER,
  ])("rejects %s", (value) => {
    expect(isValidRetention(value)).toBe(false);
  });
});

describe("assertValidRetention", () => {
  test("passes silently for a valid retention", () => {
    expect(() => assertValidRetention(5)).not.toThrow();
  });

  test.each([0, 1.5, Number.NaN])(
    "throws naming the received value for %s",
    (value) => {
      expect(() => assertValidRetention(value)).toThrow(
        `invalid retention: expected a positive integer, received ${String(value)}`,
      );
    },
  );
});
