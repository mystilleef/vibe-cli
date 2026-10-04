/**
 * Direct-execution entry coverage: the module-level guard
 * `isDirectCliEntry(process.argv[1], import.meta.url)` runs the CLI only
 * when `argv[1]` names the CLI module itself. Subprocess smoke tests
 * exercise the real CLI but never merge coverage, so this file imports the
 * CLI with a crafted `argv[1]` in a fresh worker.
 *
 * The parse-rejection path is the one that both enters the entry block and
 * invokes its catch handler, so it closes the entry block and the
 * error-propagation decision in a single module evaluation. The entry
 * success path is already covered end-to-end by the subprocess smoke test
 * in `cliSurface.test.ts`.
 */
import { expect, test } from "bun:test";
import { waitForCondition } from "./helpers/asyncWait.js";
import { installDirectEntryHarness } from "./helpers/directEntryHarness.js";

const harness = installDirectEntryHarness();

test("routes parse rejection through fatal when argv1 names the CLI entry module", async () => {
  process.argv = [process.execPath, harness.cliPath, "unknown-command"];
  await import("../src/cli.js");

  // parseAsync is fire-and-forget at the entry point; wait for the fatal
  // exit instead of racing an unobserved promise.
  await waitForCondition(() => harness.exitSpy.mock.calls.length > 0);

  expect(harness.exitSpy).toHaveBeenCalledWith(1);
  expect(harness.stdoutSpy).not.toHaveBeenCalled();

  const lines = harness.stderr().trim().split("\n");
  const payload = JSON.parse(lines.at(-1) ?? "") as { error: string };
  expect(payload.error).toBe("error: unknown command 'unknown-command'");
});
