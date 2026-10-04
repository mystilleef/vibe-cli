/**
 * Direct-execution entry coverage for the module-load dotenv exemption:
 * when argv[1] names the CLI module and the invocation is a root `tldr`
 * command, module load must stay silent about a legacy ~/.vibe-cli/.env —
 * only the cheat sheet page reaches stdout, and nothing reaches stderr.
 * Mirrors the directEntry family worker pattern; the legacy .env guarantees
 * the warning would fire without the exemption, and successful dispatch
 * never sets an exit code at the entry boundary, so the page drain is the
 * completion signal.
 */
import { expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { waitForCondition } from "./helpers/asyncWait.js";
import { installDirectEntryHarness } from "./helpers/directEntryHarness.js";

const harness = installDirectEntryHarness({
  async onHome(home) {
    // A legacy .env makes the module-load warning observable: without the
    // tldr exemption, importing the CLI would write the deprecation warning
    // to stderr.
    await mkdir(home.dataRoot, { recursive: true });
    await writeFile(join(home.dataRoot, ".env"), "DEFAULT_MODEL=file-model\n");
  },
});

const TLDR_PAGE_MARKER = "Task-first mentor review cheat sheet";

test("skips the legacy dotenv warning for a direct tldr entry", async () => {
  process.argv = [process.execPath, harness.cliPath, "tldr"];
  const cli = await import("../src/cli.js");

  // The entry block's parseAsync is fire-and-forget and success never sets
  // an exit code, so wait for the cheat sheet to drain to stdout instead.
  await waitForCondition(() => harness.stdout().includes(TLDR_PAGE_MARKER));

  const stdout = harness.stdout();
  expect(harness.stderrSpy).not.toHaveBeenCalled();
  expect(harness.exitSpy).not.toHaveBeenCalled();

  // The direct-entry page matches the captured in-process page.
  const captured = await cli.runCliInProcess(["tldr"]);
  expect(captured.exitCode).toBe(0);
  expect(captured.stderr).toBe("");
  expect(stdout).toBe(captured.stdout);
});
