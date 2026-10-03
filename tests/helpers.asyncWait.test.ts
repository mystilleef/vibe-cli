import { describe, expect, test } from "bun:test";
import { waitForCondition } from "./helpers/asyncWait.js";

describe("waitForCondition", () => {
  test("resolves with the immediate first check when the predicate already holds", async () => {
    let checks = 0;
    await expect(
      waitForCondition(() => {
        checks += 1;
        return true;
      }),
    ).resolves.toBeUndefined();
    expect(checks).toBe(1);
  });

  test("rejects with the configured bound when the predicate never holds", async () => {
    await expect(
      waitForCondition(() => false, { timeoutMs: 20, intervalMs: 1 }),
    ).rejects.toThrow("condition not met within 20ms");
  });
});
