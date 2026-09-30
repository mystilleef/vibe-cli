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
import { afterAll, beforeAll, expect, mock, spyOn, test } from "bun:test";
import { resolve } from "node:path";
import { waitForCondition } from "./helpers/asyncWait.js";
import { createTempHome, type TempHomeContext } from "./helpers/tempHome.js";

const stdoutSpy = spyOn(process.stdout, "write").mockImplementation(
  (() => true) as typeof process.stdout.write,
);
const stderrSpy = spyOn(process.stderr, "write").mockImplementation(
  (() => true) as typeof process.stderr.write,
);
const exitSpy = spyOn(process, "exit").mockImplementation(
  (() => {}) as typeof process.exit,
);

const cliPath = resolve(import.meta.dir, "../src/cli.ts");
const previousArgv = process.argv;

let home: TempHomeContext;

beforeAll(async () => {
  // Isolate HOME before the CLI import: module load runs the legacy dotenv
  // warning probe against the active HOME.
  home = await createTempHome();
});

afterAll(async () => {
  mock.restore();
  process.argv = previousArgv;
  await home.cleanup();
});

test("routes parse rejection through fatal when argv1 names the CLI entry module", async () => {
  process.argv = [process.execPath, cliPath, "unknown-command"];
  await import("../src/cli.js");

  // parseAsync is fire-and-forget at the entry point; wait for the fatal
  // exit instead of racing an unobserved promise.
  await waitForCondition(() => exitSpy.mock.calls.length > 0);

  expect(exitSpy).toHaveBeenCalledWith(1);
  expect(stdoutSpy).not.toHaveBeenCalled();

  const writes = stderrSpy.mock.calls.map((call) => String(call[0])).join("");
  const lines = writes.trim().split("\n");
  const payload = JSON.parse(lines.at(-1) ?? "") as { error: string };
  expect(payload.error).toBe("error: unknown command 'unknown-command'");
});
