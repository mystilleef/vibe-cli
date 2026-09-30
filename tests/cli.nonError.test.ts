/**
 * Tests for runCliInProcess non-Error exception handling.
 *
 * The "constitution set" subcommand is not wrapped in withCliError, so a
 * non-Error throw from updateConstitution escapes Commander and reaches
 * runCliInProcess's catch block, hitting its String(e) branch. A restorable
 * spy injects the throw: a mock.module override would outlive this file and
 * break later suites sharing the module registry.
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
