/**
 * Tests for runCliInProcess non-Error exception handling.
 *
 * `constitution set` wraps its action in `withCliError`, so a non-Error
 * throw from updateConstitution is caught there and routed through
 * `extractErrorMessage` (String(e)) into `fatal`'s JSON diagnostic. This
 * locks the wrapped-command contract that non-Error failures serialize as
 * `{"error":"[object Object]"}` with exit code 1. The unwrapped-handler
 * String(e) branch of runCliInProcess is exercised by cli.demo.test.ts. A
 * restorable spy injects the throw: a mock.module override would outlive
 * this file and break later suites sharing the module registry.
 */

import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { runCliInProcess } from "../src/cli";
import * as constitution from "../src/tools/constitution.js";

afterEach(() => {
  mock.restore();
});

describe("runCliInProcess - non-Error exception handling", () => {
  test("stringifies non-Error throws via String(e) in stderr", async () => {
    spyOn(constitution, "updateConstitution").mockImplementation(() => {
      throw { custom: "BOOM", code: 42 };
    });

    const result = await runCliInProcess([
      "constitution",
      "set",
      "--rule",
      "test",
    ]);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(JSON.parse(result.stderr)).toEqual({ error: "[object Object]" });
  });
});
