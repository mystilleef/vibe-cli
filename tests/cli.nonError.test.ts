/**
 * Tests for runCliInProcess non-Error exception handling (cli.ts:693-694).
 *
 * Uses mock.module to trigger a non-Error throw from a command handler
 * that is not wrapped in withCliError, so the throw propagates to
 * runCliInProcess's catch block and hits the String(e) codepath.
 */

import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";

// Register mocks before the CLI module is imported. Bun hoists
// mock.module calls above all imports so the mock takes effect when
// cli.ts resolves its constitution dependency.
//
// The "constitution set" subcommand is not wrapped in withCliError.
// When updateConstitution throws a non-Error, the throw escapes
// Commander and reaches runCliInProcess's catch block, hitting the
// String(e) branch (cli.ts:693-694).
mock.module("../src/tools/constitution.js", () => ({
  updateConstitution: () => {
    // Non-Error throw — hits the String(e) branch (cli.ts:693-694)
    throw { custom: "BOOM", code: 42 };
  },
  resetConstitution: () => {},
  getConstitution: () => [] as string[],
  getCurrentConstitutionSessionId: () => "test-nonerror-session",
}));

// Import under test AFTER mock registration.
import { runCliInProcess } from "../src/cli";

// ── Helpers ─────────────────────────────────────────────────────────

let originalCwd: string;

beforeAll(() => {
  originalCwd = process.cwd();
});

afterAll(() => {
  process.chdir(originalCwd);
});

async function runCli(
  args: string[],
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return runCliInProcess(args);
}

// ── Tests ───────────────────────────────────────────────────────────

describe("runCliInProcess - non-Error exception handling", () => {
  test("stringifies non-Error throws via String(e) in stderr", async () => {
    const result = await runCli(["constitution", "set", "--rule", "test"]);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    // Should contain the String(e) representation of the thrown object
    const parsed = JSON.parse(result.stderr);
    expect(parsed).toEqual({
      error: "[object Object]",
    });
  });
});
