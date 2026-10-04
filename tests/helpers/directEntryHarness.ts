/**
 * Shared harness for direct-execution entry coverage: installs the
 * stdout/stderr/exit spies every entry-boundary test needs, resolves the
 * CLI module path, and owns process-state restoration. Test files get a
 * fresh module registry, so each install re-evaluates the CLI entry block.
 */
import { afterAll, beforeAll, mock, spyOn } from "bun:test";
import { resolve } from "node:path";
import { createTempHome, type TempHomeContext } from "./tempHome.js";

export interface DirectEntryHarnessOptions {
  /** Extra setup run after the temp HOME exists, before any test. */
  onHome?: (home: TempHomeContext) => Promise<void>;
}

export function installDirectEntryHarness(
  options: DirectEntryHarnessOptions = {},
) {
  const stdoutSpy = spyOn(process.stdout, "write").mockImplementation(
    (() => true) as typeof process.stdout.write,
  );
  const stderrSpy = spyOn(process.stderr, "write").mockImplementation(
    (() => true) as typeof process.stderr.write,
  );
  const exitSpy = spyOn(process, "exit").mockImplementation(
    (() => {}) as typeof process.exit,
  );
  const cliPath = resolve(import.meta.dir, "../../src/cli.ts");
  const previousArgv = process.argv;
  const joined = (calls: readonly unknown[][]): string =>
    calls.map((call) => String(call[0])).join("");

  let home: TempHomeContext | undefined;

  beforeAll(async () => {
    // Isolate HOME before the CLI import: module load runs the legacy
    // dotenv warning probe against the active HOME.
    home = await createTempHome();
    await options.onHome?.(home);
  });

  afterAll(async () => {
    mock.restore();
    process.argv = previousArgv;
    await home?.cleanup();
  });

  return {
    stdoutSpy,
    stderrSpy,
    exitSpy,
    cliPath,
    /** Every payload written to stdout, concatenated. */
    stdout: () => joined(stdoutSpy.mock.calls),
    /** Every payload written to stderr, concatenated. */
    stderr: () => joined(stderrSpy.mock.calls),
  };
}
