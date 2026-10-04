/**
 * Direct-execution entry coverage for the exit-code-0 branch of the entry
 * catch: a `--version` throw carries Commander's successful exit code 0, so
 * the entry boundary must drain the version to stdout, set exit code 0, and
 * never route through the fatal JSON error contract. Mirrors
 * `cli.directEntry.test.ts`, which pins the parse-rejection branch; the CLI
 * module is imported in a fresh worker with `argv[1]` naming the CLI module
 * itself.
 */
import { expect, test } from "bun:test";
import { waitForCondition } from "./helpers/asyncWait.js";
import { installDirectEntryHarness } from "./helpers/directEntryHarness.js";

const harness = installDirectEntryHarness();

test("drains version output to stdout and exits 0 at the entry boundary", async () => {
  process.argv = [process.execPath, harness.cliPath, "--version"];
  process.exitCode = undefined;
  const cli = await import("../src/cli.js");

  // The entry block's parseAsync is fire-and-forget; the catch sets the
  // exit code only after the successful-termination throw is classified.
  await waitForCondition(() => process.exitCode === 0);

  const stdout = harness.stdout();
  expect(stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/);
  expect(harness.stderrSpy).not.toHaveBeenCalled();
  expect(harness.exitSpy).not.toHaveBeenCalled();

  // The direct-entry page matches the captured in-process page.
  const captured = await cli.runCliInProcess(["--version"]);
  expect(captured.exitCode).toBe(0);
  expect(stdout).toBe(captured.stdout);
});
