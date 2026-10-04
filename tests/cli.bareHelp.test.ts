/**
 * Bare and group help contract at both CLI boundaries: the five action-less
 * entry points print complete command-specific help on stdout and exit 0,
 * matching their explicit `--help` pages, while real-process parse failures
 * keep their JSON-only, newline-terminated stderr contract.
 *
 * The CLI module is imported after a temp HOME is installed so its module-load
 * legacy dotenv probe cannot touch the real home directory.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { type ChildProcessResult, runChild } from "./helpers/childProcess.js";
import {
  createTempHome,
  type TempHomeContext,
  withFreshHome,
} from "./helpers/tempHome.js";

type CliModule = typeof import("../src/cli.js");

const cliPath = join(import.meta.dir, "..", "src", "cli.ts");
const originalCwd = process.cwd();
const QUICK_EXAMPLES_FOOTER = "Run `vibe tldr` for quick examples.";
const CHILD_TEST_TIMEOUT_MS = 20_000;

type CliResult = ChildProcessResult;

/** Table row: usage-path label and bare-CLI arguments of one entry point. */
type HelpRow = [label: string, args: string[]];

const BARE_ROWS: HelpRow[] = [
  ["vibe", []],
  ["vibe constitution", ["constitution"]],
  ["vibe skills", ["skills"]],
  ["vibe guide", ["guide"]],
  ["vibe settings", ["settings"]],
];

/** Table row: invocation label, arguments, and original parse error string. */
type FailureRow = [label: string, args: string[], message: string];

const FAILURE_ROWS: FailureRow[] = [
  ["skills bogus", ["skills", "bogus"], "error: unknown command 'bogus'"],
  [
    "constitution bogus",
    ["constitution", "bogus"],
    "error: unknown command 'bogus'",
  ],
  ["--bogus", ["--bogus"], "error: unknown option '--bogus'"],
  ["skills --json", ["skills", "--json"], "error: unknown option '--json'"],
  ["settings --json", ["settings", "--json"], "error: unknown option '--json'"],
  [
    "constitution --json",
    ["constitution", "--json"],
    "error: unknown option '--json'",
  ],
];

/**
 * Table row: fallback help-command label, args, explicit page args, and the
 * usage path of the page the fallback must match. Commander's help command
 * falls back to the nearest parent page for unknown targets and throws its
 * `(outputHelp)` placeholder with a nonzero exit code, so the successful
 * output classification must hold for these error-looking invocations.
 */
type FallbackRow = [
  label: string,
  args: string[],
  explicitArgs: string[],
  usagePath: string,
];

const FALLBACK_ROWS: FallbackRow[] = [
  ["help bogus", ["help", "bogus"], ["--help"], "vibe"],
  ["help --bogus", ["help", "--bogus"], ["--help"], "vibe"],
  [
    "help skills bogus",
    ["help", "skills", "bogus"],
    ["skills", "--help"],
    "vibe skills",
  ],
];

let cli: CliModule;
let fileHome: TempHomeContext;

beforeAll(async () => {
  // Isolate HOME before the CLI import: module load runs the legacy dotenv
  // warning probe against the active HOME.
  fileHome = await createTempHome();
  cli = await import("../src/cli.js");
});

afterAll(async () => {
  await fileHome.cleanup();
});

/** Spawn the source CLI entry as a piped child with an explicit HOME. */
function runSource(args: readonly string[], home: string): Promise<CliResult> {
  return runChild("bun", ["run", cliPath, ...args], {
    cwd: originalCwd,
    env: { ...process.env, HOME: home },
    timeout: CHILD_TEST_TIMEOUT_MS,
  });
}

/** Assert one help result is a complete, successful, stdout-only page. */
function expectHelpPage(result: CliResult, usagePath: string): void {
  expect(result.exitCode).toBe(0);
  expect(result.stderr).toBe("");
  expect(result.stdout.trim().length).toBeGreaterThan(0);
  expect(result.stdout.startsWith(`Usage: ${usagePath} [`)).toBe(true);
}

/** Assert the bare-root page keeps the quick-examples footer; group pages omit it. */
function expectFooterPolicy(page: string, usagePath: string): void {
  if (usagePath === "vibe") {
    expect(page.trimEnd().endsWith(QUICK_EXAMPLES_FOOTER)).toBe(true);
  } else {
    expect(page).not.toContain(QUICK_EXAMPLES_FOOTER);
  }
}

describe("bare invocation help at the in-process boundary", () => {
  test.each(BARE_ROWS)(
    "returns complete help matching the --help page for bare %s in-process",
    async (label, args) => {
      await withFreshHome(async () => {
        const bare = await cli.runCliInProcess(args);
        const explicit = await cli.runCliInProcess([...args, "--help"]);

        expectHelpPage(bare, label);
        expectHelpPage(explicit, label);
        expect(bare.stdout).toBe(explicit.stdout);
        expectFooterPolicy(bare.stdout, label);
      });
    },
  );
});

describe("help command pages at the in-process boundary", () => {
  test.each(BARE_ROWS)(
    "returns the --help page for help %s in-process",
    async (label, args) => {
      await withFreshHome(async () => {
        const viaHelp = await cli.runCliInProcess(["help", ...args]);
        const explicit = await cli.runCliInProcess([...args, "--help"]);

        expectHelpPage(viaHelp, label);
        expectHelpPage(explicit, label);
        expect(viaHelp.stdout).toBe(explicit.stdout);
      });
    },
  );
});

describe("bare invocation help at the real-process boundary", () => {
  test.each(BARE_ROWS)(
    "returns complete piped help matching the --help page for bare %s",
    async (label, args) => {
      await withFreshHome(async (home) => {
        const [bare, explicit] = await Promise.all([
          runSource(args, home.home),
          runSource([...args, "--help"], home.home),
        ]);

        expectHelpPage(bare, label);
        expectHelpPage(explicit, label);
        expect(bare.stdout).toBe(explicit.stdout);
        expectFooterPolicy(bare.stdout, label);
      });
    },
    CHILD_TEST_TIMEOUT_MS,
  );
});

describe("help command pages at the real-process boundary", () => {
  test.each(BARE_ROWS)(
    "returns the piped --help page for help %s",
    async (label, args) => {
      await withFreshHome(async (home) => {
        const [viaHelp, explicit] = await Promise.all([
          runSource(["help", ...args], home.home),
          runSource([...args, "--help"], home.home),
        ]);

        expectHelpPage(viaHelp, label);
        expectHelpPage(explicit, label);
        expect(viaHelp.stdout).toBe(explicit.stdout);
      });
    },
    CHILD_TEST_TIMEOUT_MS,
  );
});

describe("fallback help pages at the in-process boundary", () => {
  test.each(FALLBACK_ROWS)(
    "falls back to the parent page for %s in-process",
    async (_label, args, explicitArgs, usagePath) => {
      await withFreshHome(async () => {
        const fallback = await cli.runCliInProcess(args);
        const explicit = await cli.runCliInProcess(explicitArgs);

        expectHelpPage(fallback, usagePath);
        expect(fallback.stdout).toBe(explicit.stdout);
      });
    },
  );
});

describe("fallback help pages at the real-process boundary", () => {
  test.each(FALLBACK_ROWS)(
    "falls back to the parent piped page for %s",
    async (_label, args, explicitArgs, usagePath) => {
      await withFreshHome(async (home) => {
        const [fallback, explicit] = await Promise.all([
          runSource(args, home.home),
          runSource(explicitArgs, home.home),
        ]);

        expectHelpPage(fallback, usagePath);
        expect(fallback.stdout).toBe(explicit.stdout);
      });
    },
    CHILD_TEST_TIMEOUT_MS,
  );
});

describe("parse failures at the real-process boundary", () => {
  test.each(FAILURE_ROWS)(
    "retains one newline-terminated fatal JSON error for %s",
    async (_label, args, message) => {
      await withFreshHome(async (home) => {
        const result = await runSource(args, home.home);

        expect(result.exitCode).toBe(1);
        expect(result.stdout).toBe("");
        expect(result.stderr).toBe(`${JSON.stringify({ error: message })}\n`);
      });
    },
    CHILD_TEST_TIMEOUT_MS,
  );
});
