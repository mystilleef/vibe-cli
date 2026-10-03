/**
 * Offline `vibe tldr` surface: the text/JSON output contract, color
 * resolution at the action edge, legacy `.env` diagnostic boundaries,
 * root-help discoverability, offline dependency traps, and page-to-CLI
 * help drift validation.
 *
 * The CLI module is imported after a temp HOME is installed so its
 * module-load legacy dotenv probe cannot touch the real home directory.
 */
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  spyOn,
  test,
} from "bun:test";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { isTldrInvocation } from "../src/utils/cliHelpers.js";
import * as database from "../src/utils/database.js";
import * as dbCore from "../src/utils/db-core.js";
import * as provider from "../src/utils/provider.js";
import * as settings from "../src/utils/settings.js";
import { runChild } from "./helpers/childProcess.js";
import { seedLearningEntries, seedSessionRows } from "./helpers/storageSeed.js";
import { createTempHome, type TempHomeContext } from "./helpers/tempHome.js";

type CliModule = typeof import("../src/cli.js");

const cliPath = join(import.meta.dir, "..", "src", "cli.ts");
const originalCwd = process.cwd();
const ESC = String.fromCharCode(27);
const LEGACY_DOTENV_WARNING =
  "Deprecated ~/.vibe-cli/.env ignored. Move provider settings to ~/.vibe-cli/settings.json and provide secrets through the parent process environment.";

const EXPECTED_COMMANDS = [
  "vibe settings install",
  "vibe verify",
  "vibe skills install --target ~/.claude/skills",
  "vibe guide install",
  "vibe demo",
  "vibe list all",
  "vibe list learnings --type mistake",
  'vibe check --goal "{{goal}}" --plan "{{steps}}"',
  "vibe doctor",
  "vibe prune --duplicates",
  "vibe prune --duplicates --yes",
  "vibe doctor --json",
];

let cli: CliModule;
let fileHome: TempHomeContext;

beforeAll(async () => {
  fileHome = await createTempHome();
  cli = await import("../src/cli.js");
});

afterAll(async () => {
  await fileHome.cleanup();
});

/** Temporarily apply env overrides (`undefined` deletes) and restore. */
async function withMutatedEnv<T>(
  overrides: Record<string, string | undefined>,
  fn: () => Promise<T>,
): Promise<T> {
  const saved = new Map<string, string | undefined>();
  for (const key of Object.keys(overrides)) saved.set(key, process.env[key]);
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

/** Run `fn` with a controlled `process.stdout.isTTY`, then restore it. */
async function withStdoutTty<T>(
  isTty: boolean,
  fn: () => Promise<T>,
): Promise<T> {
  const descriptor = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
  Object.defineProperty(process.stdout, "isTTY", {
    value: isTty,
    configurable: true,
    writable: true,
    enumerable: true,
  });
  try {
    return await fn();
  } finally {
    if (descriptor === undefined) {
      Reflect.deleteProperty(process.stdout, "isTTY");
    } else {
      Object.defineProperty(process.stdout, "isTTY", descriptor);
    }
  }
}

/** Run `fn` against a fresh temp HOME, restoring the prior HOME afterwards. */
async function withFreshHome<T>(
  fn: (home: TempHomeContext) => Promise<T>,
): Promise<T> {
  const fresh = await createTempHome();
  try {
    return await fn(fresh);
  } finally {
    await fresh.cleanup();
  }
}

/** Write a legacy provider .env that tldr runs must stay silent about. */
async function writeLegacyEnv(home: TempHomeContext): Promise<void> {
  await mkdir(home.dataRoot, { recursive: true });
  await writeFile(join(home.dataRoot, ".env"), "DEFAULT_MODEL=file-model\n");
}

/** Run one captured tldr invocation under pinned non-styled conditions. */
async function runTldrPlain(args: string[]) {
  return withStdoutTty(false, () =>
    withMutatedEnv({ NO_COLOR: "1" }, () => cli.runCliInProcess(args)),
  );
}

/** Assert every curated command appears backticked, in curated order. */
function expectOrderedCommands(output: string): void {
  let previous = -1;
  for (const command of EXPECTED_COMMANDS) {
    const index = output.indexOf(`\`${command}\``);
    expect(index).toBeGreaterThan(previous);
    previous = index;
  }
}

/** Assert stderr carries exactly one legacy dotenv diagnostic. */
function expectLegacyWarningOnce(stderr: string): void {
  expect(stderr.trim().split("\n")).toEqual([LEGACY_DOTENV_WARNING]);
}

/** Snapshot every file under `root` as sorted `path:sha256` entries. */
async function snapshotTree(root: string): Promise<string[]> {
  const entries: string[] = [];
  async function walk(dir: string): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(path);
        continue;
      }
      const digest = createHash("sha256")
        .update(await readFile(path))
        .digest("hex");
      entries.push(`${relative(root, path)}:${digest}`);
    }
  }
  await walk(root);
  return entries.sort();
}

describe("tldr output contract", () => {
  test("prints the curated text page with ordered commands and placeholders", async () => {
    await withFreshHome(async (fresh) => {
      const result = await runTldrPlain(["tldr"]);

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
      expect(existsSync(fresh.dataRoot)).toBe(false);
      expect(result.stdout.split("\n")[0]).toBe("vibe");
      expect(result.stdout).toContain("mentor");
      expect(result.stdout).toContain("{{goal}}");
      expect(result.stdout).toContain("{{steps}}");
      expect(result.stdout).not.toContain(ESC);
      expectOrderedCommands(result.stdout);
    });
  });

  test("emits the exact JSON shape with preserved commands and placeholders", async () => {
    await withFreshHome(async (fresh) => {
      const result = await runTldrPlain(["tldr", "--json"]);

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
      expect(existsSync(fresh.dataRoot)).toBe(false);
      expect(result.stdout).not.toContain(ESC);

      const payload = JSON.parse(result.stdout) as {
        title: string;
        description: string;
        examples: { description: string; command: string }[];
      };
      expect(Object.keys(payload).sort()).toEqual([
        "description",
        "examples",
        "title",
      ]);
      expect(payload.title).toBe("vibe");
      expect(payload.description).toContain("mentor");
      expect(payload.examples).toHaveLength(12);
      expect(payload.examples.map((example) => example.command)).toEqual(
        EXPECTED_COMMANDS,
      );
      for (const example of payload.examples) {
        expect(Object.keys(example).sort()).toEqual(["command", "description"]);
        expect(example.description.length).toBeGreaterThan(0);
      }
    });
  });
});

describe("tldr text color resolution", () => {
  const COLOR_CASES = [
    {
      label: "tty with NO_COLOR unset",
      isTty: true,
      noColor: undefined,
      styled: true,
    },
    {
      label: "tty with empty NO_COLOR",
      isTty: true,
      noColor: "",
      styled: true,
    },
    {
      label: "tty with nonempty NO_COLOR",
      isTty: true,
      noColor: "1",
      styled: false,
    },
    {
      label: "non-tty with NO_COLOR unset",
      isTty: false,
      noColor: undefined,
      styled: false,
    },
    {
      label: "non-tty with empty NO_COLOR",
      isTty: false,
      noColor: "",
      styled: false,
    },
    {
      label: "non-tty with nonempty NO_COLOR",
      isTty: false,
      noColor: "1",
      styled: false,
    },
  ];

  for (const { label, isTty, noColor, styled } of COLOR_CASES) {
    test(`renders ${styled ? "styled" : "plain"} tldr text for ${label}`, async () => {
      await withFreshHome(async () => {
        const result = await withStdoutTty(isTty, () =>
          withMutatedEnv({ NO_COLOR: noColor }, () =>
            cli.runCliInProcess(["tldr"]),
          ),
        );

        expect(result.exitCode).toBe(0);
        expect(result.stderr).toBe("");
        if (styled) {
          expect(result.stdout).toContain(ESC);
        } else {
          expect(result.stdout).not.toContain(ESC);
        }
      });
    });
  }

  for (const { label, isTty, noColor } of COLOR_CASES.slice(0, 3)) {
    test(`renders ANSI-free tldr JSON for ${label}`, async () => {
      await withFreshHome(async () => {
        const result = await withStdoutTty(isTty, () =>
          withMutatedEnv({ NO_COLOR: noColor }, () =>
            cli.runCliInProcess(["tldr", "--json"]),
          ),
        );

        expect(result.exitCode).toBe(0);
        expect(result.stderr).toBe("");
        expect(result.stdout).not.toContain(ESC);
        expect(() => JSON.parse(result.stdout)).not.toThrow();
      });
    });
  }

  const FORCE_COLOR_CASES = [
    {
      label: "non-tty forcing color via FORCE_COLOR",
      isTty: false,
      forceColor: "1",
      styled: false,
    },
    {
      label: "tty disabling color via FORCE_COLOR",
      isTty: true,
      forceColor: "0",
      styled: true,
    },
  ];

  for (const { label, isTty, forceColor, styled } of FORCE_COLOR_CASES) {
    test(`renders ${styled ? "styled" : "plain"} tldr text for ${label}`, async () => {
      await withFreshHome(async () => {
        const result = await withStdoutTty(isTty, () =>
          withMutatedEnv({ NO_COLOR: undefined, FORCE_COLOR: forceColor }, () =>
            cli.runCliInProcess(["tldr"]),
          ),
        );

        expect(result.exitCode).toBe(0);
        expect(result.stderr).toBe("");
        if (styled) {
          expect(result.stdout).toContain(ESC);
        } else {
          expect(result.stdout).not.toContain(ESC);
        }
      });
    });
  }
});

describe("tldr root-help discoverability", () => {
  test("root help lists tldr and ends with the exact quick-examples footer", async () => {
    await withFreshHome(async () => {
      const result = await cli.runCliInProcess(["--help"]);

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toContain("tldr");
      expect(
        result.stdout.trimEnd().endsWith("Run `vibe tldr` for quick examples."),
      ).toBe(true);
    });
  });
});

describe("tldr help and argument edges", () => {
  test("renders tldr help with the cheat-sheet description and json option", async () => {
    await withFreshHome(async (fresh) => {
      await writeLegacyEnv(fresh);

      const result = await cli.runCliInProcess(["tldr", "--help"]);

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toContain("Usage: vibe tldr [options]");
      expect(result.stdout).toContain(
        "Print the offline workflow cheat sheet (12 quick examples)",
      );
      expect(result.stdout).toContain("--json");
    });
  });

  test("rejects unknown tldr options with one JSON error line", async () => {
    await withFreshHome(async () => {
      const result = await cli.runCliInProcess(["tldr", "--nope"]);

      expect(result.exitCode).toBe(1);
      expect(result.stdout).toBe("");
      expect(JSON.parse(result.stderr)).toEqual({
        error: "error: unknown option '--nope'",
      });
    });
  });

  test("rejects excess positional arguments with one JSON error line", async () => {
    await withFreshHome(async () => {
      const result = await cli.runCliInProcess(["tldr", "bogus"]);

      expect(result.exitCode).toBe(1);
      expect(result.stdout).toBe("");
      expect(JSON.parse(result.stderr)).toEqual({
        error:
          "error: too many arguments for 'tldr'. Expected 0 arguments but got 1: bogus.",
      });
    });
  });

  test("dispatches tldr through the double-dash separator with silent legacy env", async () => {
    await withFreshHome(async (fresh) => {
      await writeLegacyEnv(fresh);

      const result = await runTldrPlain(["--", "tldr"]);

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout.split("\n")[0]).toBe("vibe");
      expectOrderedCommands(result.stdout);
    });
  });
});

describe("isTldrInvocation root-command detection", () => {
  test("accepts tldr as the root command with trailing options", () => {
    expect(isTldrInvocation(["tldr"])).toBe(true);
    expect(isTldrInvocation(["tldr", "--json"])).toBe(true);
    expect(isTldrInvocation(["--", "tldr"])).toBe(true);
  });

  test("rejects tldr appearing only as an option value or argument", () => {
    expect(isTldrInvocation(["check", "--goal", "tldr", "--help"])).toBe(false);
    expect(
      isTldrInvocation(["skills", "list", "--target", "tldr", "--help"]),
    ).toBe(false);
  });

  test("rejects invocations whose root command is not tldr", () => {
    expect(isTldrInvocation([])).toBe(false);
    expect(isTldrInvocation(["--help"])).toBe(false);
    expect(isTldrInvocation(["session"])).toBe(false);
    expect(isTldrInvocation(["unknown-command"])).toBe(false);
  });
});

describe("tldr avoids storage, provider, and network dependencies", () => {
  let attempts: string[];
  const realFetch = globalThis.fetch;
  let restores: (() => void)[] = [];

  function recordAttempt(label: string): never {
    attempts.push(label);
    throw new Error(`forbidden access attempt: ${label}`);
  }

  function installDependencyTraps(): void {
    // Per-spy restoration only: `mock.restore()` would reset process-wide
    // stream spies other suites install at module load, clobbering the
    // capture dispatch layer for every later test in a shared run.
    const spies = [
      spyOn(database, "getVibeDatabase").mockImplementation(() =>
        recordAttempt("database:getVibeDatabase"),
      ),
      spyOn(database, "withDatabase").mockImplementation(() =>
        recordAttempt("database:withDatabase"),
      ),
      spyOn(database, "openVibeDatabase").mockImplementation(() =>
        recordAttempt("database:openVibeDatabase"),
      ),
      spyOn(database, "openVibeDatabaseWithMigrationReport").mockImplementation(
        () => recordAttempt("database:openVibeDatabaseWithMigrationReport"),
      ),
      spyOn(dbCore, "getDataRoot").mockImplementation(() =>
        recordAttempt("db-core:getDataRoot"),
      ),
      spyOn(dbCore, "ensureDataDir").mockImplementation(() =>
        recordAttempt("db-core:ensureDataDir"),
      ),
      spyOn(provider, "resolveProviderAndModel").mockImplementation(() =>
        recordAttempt("provider:resolveProviderAndModel"),
      ),
      spyOn(provider, "callProvider").mockImplementation(() =>
        recordAttempt("provider:callProvider"),
      ),
      spyOn(settings, "loadProviderSettings").mockImplementation(() =>
        recordAttempt("settings:loadProviderSettings"),
      ),
      spyOn(settings, "resolveProviderEntry").mockImplementation(() =>
        recordAttempt("settings:resolveProviderEntry"),
      ),
    ];
    restores.push(...spies.map((spy) => () => spy.mockRestore()));
    globalThis.fetch = Object.assign(
      async () => recordAttempt("network:fetch"),
      { preconnect: globalThis.fetch.preconnect },
    );
  }

  beforeAll(() => {
    attempts = [];
  });

  afterEach(() => {
    for (const restore of restores) restore();
    restores = [];
    globalThis.fetch = realFetch;
    attempts = [];
  });

  test("records no dependency attempt for tldr text output", async () => {
    await withFreshHome(async () => {
      installDependencyTraps();
      const result = await cli.runCliInProcess(["tldr"]);

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
      expect(attempts).toEqual([]);
    });
  });

  test("records no dependency attempt for tldr JSON output", async () => {
    await withFreshHome(async () => {
      installDependencyTraps();
      const result = await cli.runCliInProcess(["tldr", "--json"]);

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
      expect(() => JSON.parse(result.stdout)).not.toThrow();
      expect(attempts).toEqual([]);
    });
  });

  test("records attempted database access for a state-backed command", async () => {
    await withFreshHome(async () => {
      installDependencyTraps();
      const result = await cli.runCliInProcess(["migrate"]);

      expect(result.exitCode).toBe(1);
      expect(attempts).toContain(
        "database:openVibeDatabaseWithMigrationReport",
      );
    });
  });

  test("records attempted data-root resolution for a settings-backed command", async () => {
    await withFreshHome(async () => {
      installDependencyTraps();
      const result = await cli.runCliInProcess(["settings", "install"]);

      expect(result.exitCode).toBe(1);
      expect(attempts).toContain("db-core:getDataRoot");
    });
  });

  test("records attempted provider resolution despite swallowed failures", async () => {
    await withFreshHome(async () => {
      installDependencyTraps();
      // verifyConnection swallows resolution failures and reports them in
      // its result; the trap records the attempt anyway.
      const result = await cli.runCliInProcess(["verify"]);

      expect(result.exitCode).toBe(1);
      expect(attempts).toContain("provider:resolveProviderAndModel");
    });
  });

  test("records attempted network access at the fetch boundary", async () => {
    await withFreshHome(async () => {
      installDependencyTraps();
      await expect(globalThis.fetch("https://example.invalid")).rejects.toThrow(
        /forbidden access attempt/,
      );
      expect(attempts).toEqual(["network:fetch"]);
    });
  });

  test("leaves a fresh home without a data root after both output forms", async () => {
    await withFreshHome(async (fresh) => {
      const text = await cli.runCliInProcess(["tldr"]);
      const json = await cli.runCliInProcess(["tldr", "--json"]);

      expect(text.exitCode).toBe(0);
      expect(json.exitCode).toBe(0);
      expect(existsSync(fresh.dataRoot)).toBe(false);
    });
  });

  test("keeps seeded inventory and content byte-identical", async () => {
    await withFreshHome(async (fresh) => {
      await mkdir(fresh.dataRoot, { recursive: true });
      await writeFile(
        join(fresh.dataRoot, "settings.json"),
        JSON.stringify({ provider: "deepseek", providers: [] }, null, 2),
      );
      seedLearningEntries(fresh.dataRoot, [
        {
          type: "mistake",
          category: "testing",
          observation: "Seeded observation",
          solution: "Seeded solution",
          timestamp: Date.parse("2026-01-01T00:00:00.000Z"),
        },
      ]);
      seedSessionRows(fresh.dataRoot, [
        {
          id: "session-seeded",
          createdAt: "2026-01-01T00:00:00.000Z",
          lastAccessedAt: "2026-01-01T00:00:00.000Z",
          constitutionRules: ["Keep seeded state intact"],
        },
      ]);

      const before = await snapshotTree(fresh.dataRoot);
      const text = await cli.runCliInProcess(["tldr"]);
      const json = await cli.runCliInProcess(["tldr", "--json"]);

      expect(text.exitCode).toBe(0);
      expect(json.exitCode).toBe(0);
      expect(await snapshotTree(fresh.dataRoot)).toEqual(before);
    });
  });

  test("records no dependency attempt during page drift validation", async () => {
    await withFreshHome(async () => {
      installDependencyTraps();
      const report = await validateCommandSpans(
        extractVibeSpans(pageText),
        runHelpProbe,
      );

      expect(report.issues).toEqual([]);
      expect(attempts).toEqual([]);
    });
  });
});

describe("source-process legacy .env diagnostics", () => {
  function childEnv(home: TempHomeContext): Record<string, string | undefined> {
    return { ...process.env, HOME: home.home };
  }

  test("keeps source tldr runs silent with a legacy .env present", async () => {
    await withFreshHome(async (fresh) => {
      await writeLegacyEnv(fresh);

      const text = await runChild("bun", ["run", cliPath, "tldr"], {
        cwd: originalCwd,
        env: childEnv(fresh),
        timeout: 10_000,
      });
      const json = await runChild("bun", ["run", cliPath, "tldr", "--json"], {
        cwd: originalCwd,
        env: childEnv(fresh),
        timeout: 10_000,
      });

      expect(text.exitCode).toBe(0);
      expect(text.stderr).toBe("");
      expect(text.stdout).toContain("vibe doctor --json");
      expect(json.exitCode).toBe(0);
      expect(json.stderr).toBe("");
      expect(
        (JSON.parse(json.stdout) as { examples: unknown[] }).examples,
      ).toHaveLength(12);
      expect(existsSync(join(fresh.dataRoot, "vibe.db"))).toBe(false);
    });
  });

  test("keeps one legacy diagnostic for a source local command", async () => {
    await withFreshHome(async (fresh) => {
      await writeLegacyEnv(fresh);

      const result = await runChild("bun", ["run", cliPath, "session"], {
        cwd: originalCwd,
        env: childEnv(fresh),
        timeout: 10_000,
      });

      expect(result.exitCode).toBe(0);
      expectLegacyWarningOnce(result.stderr);
      expect(() => JSON.parse(result.stdout)).not.toThrow();
    });
  });

  test("keeps one legacy diagnostic for a source settings-backed command", async () => {
    await withFreshHome(async (fresh) => {
      await writeLegacyEnv(fresh);
      await writeFile(
        join(fresh.dataRoot, "settings.json"),
        JSON.stringify(
          {
            provider: "deepseek",
            providers: [
              {
                name: "deepseek",
                spec: "openai",
                envVar: "DEEPSEEK_API_KEY",
                baseUrl: "https://api.deepseek.com/v1",
                defaultModel: "deepseek-v4-pro",
              },
            ],
          },
          null,
          2,
        ),
      );

      const result = await runChild(
        "bun",
        ["run", cliPath, "list", "providers", "--json"],
        {
          cwd: originalCwd,
          env: childEnv(fresh),
          timeout: 10_000,
        },
      );

      expect(result.exitCode).toBe(0);
      expectLegacyWarningOnce(result.stderr);
      expect(() => JSON.parse(result.stdout)).not.toThrow();
    });
  });
});

/* Page-to-CLI drift validation. Test-local helpers only: Commander
 * registration stays private and the curated page stays read-only. */

/** Captured help probe result used by the drift validator. */
interface HelpProbe {
  exitCode: number;
  stdout: string;
}

/** Probe CLI help through the captured in-process runner. */
type HelpRunner = (args: string[]) => Promise<HelpProbe>;

/** One drift finding bound to the cited span that produced it. */
interface SpanIssue {
  span: string;
  message: string;
}

/** Outcome of one validation run over cited command spans. */
interface DriftReport {
  issues: SpanIssue[];
  coveredRootCommands: string[];
}

/** Parsed help option entry: declared flags and value arity. */
interface HelpOption {
  shorts: string[];
  longs: string[];
  takesValue: boolean;
}

/** Root commands the page leaves uncovered by design. */
const DOCUMENTED_ROOT_EXCLUSIONS = [
  "learn",
  "constitution",
  "session",
  "migrate",
  "schema",
  "tldr",
  "help",
];

const PLACEHOLDER_PATTERN = /\{\{[^}]*\}\}/g;
const ANGLED_PLACEHOLDER = /^<[^>]+>$/;

/** Substitute `{{…}}` values and tokenize one span, honoring quoted values. */
function tokenizeCommandSpan(span: string): {
  tokens: string[];
  generic: boolean;
} {
  const normalized = span.replace(PLACEHOLDER_PATTERN, "placeholder-value");
  const tokens: string[] = [];
  let current = "";
  let started = false;
  let quoted = false;
  for (const char of normalized) {
    if (char === '"') {
      quoted = !quoted;
      started = true;
      continue;
    }
    if (!quoted && char.trim() === "") {
      if (started) tokens.push(current);
      current = "";
      started = false;
      continue;
    }
    current += char;
    started = true;
  }
  if (started) tokens.push(current);
  return {
    tokens,
    generic: tokens.some((token) => ANGLED_PLACEHOLDER.test(token)),
  };
}

/** Every backticked `vibe …` span across page metadata, descriptions, examples. */
function extractVibeSpans(page: string): string[] {
  const spans: string[] = [];
  for (const match of page.matchAll(/`([^`]+)`/g)) {
    const span = match[1] ?? "";
    if (/^vibe(\s|$)/.test(span)) spans.push(span);
  }
  return spans;
}

/** Lines of a named help section up to the following blank line or prose. */
function parseHelpSection(help: string, header: string): string[] {
  const lines = help.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === header);
  if (start === -1) return [];
  const section: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.trim() === "" || !/^\s/.test(line)) break;
    section.push(line);
  }
  return section;
}

/** Subcommand names listed in a help output's `Commands:` section. */
function parseHelpCommands(help: string): string[] {
  const names: string[] = [];
  for (const line of parseHelpSection(help, "Commands:")) {
    const name = /^ {2}(\S+)/.exec(line)?.[1];
    if (name !== undefined) names.push(name);
  }
  return names;
}

/** Parse one `Options:` entry line into declared flags and value arity. */
function parseOptionLine(line: string): HelpOption | undefined {
  const words = line.trim().split(/\s+/);
  const shorts: string[] = [];
  const longs: string[] = [];
  let index = 0;
  while (index < words.length) {
    const flag = /^(--?[\w-]+),?$/.exec(words[index] ?? "");
    if (flag === null) break;
    const name = flag[1] ?? "";
    if (name.startsWith("--")) longs.push(name);
    else shorts.push(name);
    index += 1;
  }
  if (index === 0) return undefined;
  const remainder = words.slice(index).join(" ");
  return { shorts, longs, takesValue: /^(<|\[)/.test(remainder) };
}

/** Parsed `Options:` entries of one help output. */
function parseHelpOptions(help: string): HelpOption[] {
  const options: HelpOption[] = [];
  for (const line of parseHelpSection(help, "Options:")) {
    const option = parseOptionLine(line);
    if (option !== undefined) options.push(option);
  }
  return options;
}

/** Find the option entry declaring a cited flag name. */
function findCitedOption(help: string, name: string): HelpOption | undefined {
  return parseHelpOptions(help).find((option) =>
    name.startsWith("--")
      ? option.longs.includes(name)
      : option.shorts.includes(name),
  );
}

/** Validate one concrete span; omit `coveredRootCommands` to skip coverage. */
async function validateConcreteSpan(
  span: string,
  tokens: readonly string[],
  probe: HelpRunner,
  issues: SpanIssue[],
  coveredRootCommands?: string[],
): Promise<void> {
  const root = await probe(["--help"]);
  if (root.exitCode !== 0) {
    issues.push({ span, message: `root help probe exited ${root.exitCode}` });
    return;
  }
  const path: string[] = [];
  let help = root.stdout;
  const rest = tokens.slice(1);
  let index = 0;
  while (index < rest.length) {
    const candidate = rest[index] ?? "";
    if (candidate.startsWith("-")) break;
    if (!parseHelpCommands(help).includes(candidate)) break;
    path.push(candidate);
    index += 1;
    const leaf = await probe([...path, "--help"]);
    if (leaf.exitCode !== 0) {
      issues.push({
        span,
        message: `help probe for "${path.join(" ")}" exited ${leaf.exitCode}`,
      });
      return;
    }
    help = leaf.stdout;
  }

  const label = ["vibe", ...path].join(" ");
  let pendingFlag = "";
  for (const token of rest.slice(index)) {
    if (pendingFlag !== "") {
      pendingFlag = "";
      continue;
    }
    if (!token.startsWith("-")) {
      issues.push({ span, message: `unresolved command token "${token}"` });
      continue;
    }
    const separator = token.indexOf("=");
    const name = separator === -1 ? token : token.slice(0, separator);
    const option = findCitedOption(help, name);
    if (option === undefined) {
      issues.push({
        span,
        message: `flag "${name}" is absent from "${label}" help`,
      });
      continue;
    }
    if (separator === -1 && option.takesValue) pendingFlag = name;
  }
  if (pendingFlag !== "") {
    issues.push({
      span,
      message: `flag "${pendingFlag}" consumes no value at span end`,
    });
  }

  const rootCommand = path[0];
  if (coveredRootCommands !== undefined && rootCommand !== undefined) {
    coveredRootCommands.push(rootCommand);
  }
}

/**
 * Validate cited spans against live help output: resolve command paths
 * through parent help, require leaf-help exit 0 with every cited flag
 * declared, and reject stray command tokens. Generic `vibe <command>
 * --help` spans expand into root command help probes and never count as
 * workflow coverage.
 */
async function validateCommandSpans(
  spans: readonly string[],
  runHelp: HelpRunner,
): Promise<DriftReport> {
  const issues: SpanIssue[] = [];
  const coveredRootCommands: string[] = [];
  const probes = new Map<string, HelpProbe>();
  const probe: HelpRunner = async (args) => {
    const key = args.join(" ");
    const cached = probes.get(key);
    if (cached !== undefined) return cached;
    const result = await runHelp(args);
    probes.set(key, result);
    return result;
  };

  for (const span of spans) {
    const { tokens, generic } = tokenizeCommandSpan(span);
    if ((tokens[0] ?? "") !== "vibe") {
      issues.push({ span, message: 'span must start with "vibe"' });
      continue;
    }
    const rest = tokens.slice(1);
    if (!generic) {
      await validateConcreteSpan(
        span,
        tokens,
        probe,
        issues,
        coveredRootCommands,
      );
      continue;
    }
    for (const token of rest) {
      if (!token.startsWith("-") && !ANGLED_PLACEHOLDER.test(token)) {
        issues.push({
          span,
          message: `generic help span carries stray token "${token}"`,
        });
      }
    }
    const rootHelp = await probe(["--help"]);
    if (rootHelp.exitCode !== 0) {
      issues.push({
        span,
        message: `root help probe exited ${rootHelp.exitCode}`,
      });
      continue;
    }
    const flagTokens = rest.filter((token) => token.startsWith("-"));
    for (const command of parseHelpCommands(rootHelp.stdout)) {
      await validateConcreteSpan(
        span,
        ["vibe", command, ...flagTokens],
        probe,
        issues,
      );
    }
  }

  return { issues, coveredRootCommands };
}

/**
 * Root commands lacking concrete page coverage and sitting outside the
 * documented exclusions.
 */
function findUncoveredRootCommands(
  rootCommands: readonly string[],
  coveredRootCommands: readonly string[],
): string[] {
  const covered = new Set(coveredRootCommands);
  return rootCommands.filter(
    (command) =>
      !covered.has(command) && !DOCUMENTED_ROOT_EXCLUSIONS.includes(command),
  );
}

const pagePath = join(import.meta.dir, "..", "docs", "tldr.md");
const pageText = await readFile(pagePath, "utf8");

/** Probe captured CLI help through the in-process runner. */
async function runHelpProbe(args: string[]): Promise<HelpProbe> {
  return cli.runCliInProcess(args);
}

describe("tldr page command drift validation", () => {
  test("passes help-only inspection for every real page command span", async () => {
    await withFreshHome(async () => {
      const spans = extractVibeSpans(pageText);
      expect(spans).toContain("vibe --help");
      expect(spans).toContain("vibe <command> --help");
      for (const command of EXPECTED_COMMANDS) {
        expect(spans).toContain(command);
      }

      const report = await validateCommandSpans(spans, runHelpProbe);

      expect(report.issues).toEqual([]);
      const expectedCovered = [
        ...new Set(
          EXPECTED_COMMANDS.map(
            (command) => tokenizeCommandSpan(command).tokens[1] ?? "",
          ),
        ),
      ].sort();
      expect([...new Set(report.coveredRootCommands)].sort()).toEqual(
        expectedCovered,
      );
    });
  }, 30_000);

  test("matches parsed root commands against page coverage and documented exclusions", async () => {
    await withFreshHome(async () => {
      const rootHelp = await runHelpProbe(["--help"]);
      const rootCommands = parseHelpCommands(rootHelp.stdout);
      const report = await validateCommandSpans(
        extractVibeSpans(pageText),
        runHelpProbe,
      );

      expect(report.issues).toEqual([]);
      const uncovered = rootCommands.filter(
        (command) => !report.coveredRootCommands.includes(command),
      );
      expect(uncovered.sort()).toEqual([...DOCUMENTED_ROOT_EXCLUSIONS].sort());
      expect(
        findUncoveredRootCommands(rootCommands, report.coveredRootCommands),
      ).toEqual([]);
    });
  }, 30_000);

  test("rejects a synthetic uncovered root command outside the page", async () => {
    await withFreshHome(async () => {
      const rootCommands = parseHelpCommands(
        (await runHelpProbe(["--help"])).stdout,
      );
      const report = await validateCommandSpans(
        extractVibeSpans(pageText),
        runHelpProbe,
      );

      expect(
        findUncoveredRootCommands(
          [...rootCommands, "frobnicate"],
          report.coveredRootCommands,
        ),
      ).toEqual(["frobnicate"]);
    });
  }, 30_000);

  test("expands generic help references into deterministic root help probes without coverage", async () => {
    await withFreshHome(async () => {
      const recorded: string[][] = [];
      const recordingRunner: HelpRunner = async (args) => {
        recorded.push([...args]);
        return runHelpProbe(args);
      };

      const report = await validateCommandSpans(
        ["vibe <command> --help"],
        recordingRunner,
      );

      expect(report.issues).toEqual([]);
      expect(report.coveredRootCommands).toEqual([]);
      const rootCommands = parseHelpCommands(
        (await runHelpProbe(["--help"])).stdout,
      );
      expect(recorded).toEqual([
        ["--help"],
        ...rootCommands.map((command) => [command, "--help"]),
      ]);
    });
  }, 30_000);

  test("keeps option values and quoted placeholders out of command paths", async () => {
    await withFreshHome(async () => {
      expect(
        tokenizeCommandSpan('vibe check --goal "{{goal}}" --plan "{{steps}}"'),
      ).toEqual({
        tokens: [
          "vibe",
          "check",
          "--goal",
          "placeholder-value",
          "--plan",
          "placeholder-value",
        ],
        generic: false,
      });
      expect(tokenizeCommandSpan("vibe <command> --help").generic).toBe(true);

      const report = await validateCommandSpans(
        [
          "vibe list learnings --type mistake",
          "vibe skills install --target ~/.claude/skills",
        ],
        runHelpProbe,
      );

      expect(report.issues).toEqual([]);
      expect(report.coveredRootCommands).toEqual(["list", "skills"]);
    });
  });

  const INVALID_SPANS: { span: string; reason: RegExp }[] = [
    { span: "vibe list bogus", reason: /unresolved command token "bogus"/ },
    {
      span: "vibe skills install bogus",
      reason: /unresolved command token "bogus"/,
    },
    {
      span: "vibe doctor --nope",
      reason: /flag "--nope" is absent from "vibe doctor" help/,
    },
    {
      span: "vibe check --goal",
      reason: /flag "--goal" consumes no value at span end/,
    },
  ];

  for (const { span, reason } of INVALID_SPANS) {
    test(`rejects synthetic span ${span} with one deterministic issue`, async () => {
      await withFreshHome(async () => {
        const report = await validateCommandSpans([span], runHelpProbe);

        expect(report.issues).toHaveLength(1);
        expect(report.issues[0]?.span).toBe(span);
        expect(report.issues[0]?.message).toMatch(reason);
      });
    });
  }

  test("rejects invalid nested commands despite Commander help short-circuiting", async () => {
    await withFreshHome(async () => {
      const shortCircuit = await cli.runCliInProcess([
        "list",
        "bogus",
        "--help",
      ]);

      expect(shortCircuit.exitCode).toBe(0);

      const report = await validateCommandSpans(
        ["vibe list bogus"],
        runHelpProbe,
      );

      expect(report.issues).toHaveLength(1);
      expect(report.issues[0]?.message).toMatch(
        /unresolved command token "bogus"/,
      );
    });
  });
});
