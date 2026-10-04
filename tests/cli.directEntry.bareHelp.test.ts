/**
 * Direct-execution entry coverage for the implicit-help branch of the entry
 * catch: a bare invocation throws Commander's `(outputHelp)` placeholder
 * with a nonzero exit code, so the entry boundary must classify it as
 * successful output — draining the complete help page to stdout, setting
 * exit code 0, and never routing through the fatal JSON error contract.
 * Mirrors `cli.directEntry.test.ts` (parse rejection) and
 * `cli.directEntry.version.test.ts` (exit-code-0 termination); the CLI
 * module is imported in a fresh worker with `argv[1]` naming the CLI module
 * itself.
 */
import { expect, test } from "bun:test";
import { waitForCondition } from "./helpers/asyncWait.js";
import { installDirectEntryHarness } from "./helpers/directEntryHarness.js";

const harness = installDirectEntryHarness();

const QUICK_EXAMPLES_FOOTER = "Run `vibe tldr` for quick examples.";

test("drains bare implicit help to stdout and exits 0 at the entry boundary", async () => {
  process.argv = [process.execPath, harness.cliPath];
  process.exitCode = undefined;
  const cli = await import("../src/cli.js");

  // The entry block's parseAsync is fire-and-forget; the catch sets the
  // exit code only after the `(outputHelp)` throw is classified.
  await waitForCondition(() => process.exitCode === 0);

  const stdout = harness.stdout();
  expect(stdout.startsWith("Usage: vibe [")).toBe(true);
  expect(stdout.trimEnd().endsWith(QUICK_EXAMPLES_FOOTER)).toBe(true);
  expect(harness.stderrSpy).not.toHaveBeenCalled();
  expect(harness.exitSpy).not.toHaveBeenCalled();

  // The direct-entry page matches the captured in-process page.
  const captured = await cli.runCliInProcess([]);
  expect(captured.exitCode).toBe(0);
  expect(stdout).toBe(captured.stdout);
});
