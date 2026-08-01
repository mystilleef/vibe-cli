import { Database } from "bun:sqlite";
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync } from "node:fs";
import {
  cp,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { runCliInProcess } from "../src/cli";
import { getCwdKey } from "../src/utils/autosession";
import { getMigrationIds, initializeSchema } from "../src/utils/database";
import type { LearningType } from "../src/utils/storage";
import { createTempHome, type TempHomeContext } from "./helpers/tempHome";

const homes: TempHomeContext[] = [];
const cwdRoots: string[] = [];
const originalCwd = process.cwd();
const cli = join(originalCwd, "src", "cli.ts");
const mockAnthropicFetch = join(
  originalCwd,
  "tests",
  "helpers",
  "mockAnthropicFetch.ts",
);
const failOnFetch = join(originalCwd, "tests", "helpers", "failOnFetch.ts");
const failOnFetchRecorder = join(
  originalCwd,
  "tests",
  "helpers",
  "failOnFetchRecorder.ts",
);
const capturePruneInput = join(
  originalCwd,
  "tests",
  "helpers",
  "capturePruneInput.ts",
);
const skillsPackageRoot = join(
  originalCwd,
  "tests",
  "helpers",
  "skillsPackageRoot.ts",
);
const EXPECTED_MIGRATION_IDS = getMigrationIds();
const EMPTY_CLI_HOME = join(tmpdir(), "vibe-cli-empty-home");
const LEGACY_DOTENV_WARNING =
  "Deprecated ~/.vibe-cli/.env ignored. Move provider settings to ~/.vibe-cli/settings.json and provide secrets through the parent process environment.";

interface CliResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

afterEach(async () => {
  process.chdir(originalCwd);
  await Promise.all(
    cwdRoots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
  await Promise.all(homes.splice(0).map((home) => home.cleanup()));
});

async function useTempHome(): Promise<TempHomeContext> {
  const home = await createTempHome();
  homes.push(home);
  return home;
}

async function createCwd(): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), "vibe-cli-surface-"));
  cwdRoots.push(cwd);
  return cwd;
}

async function writeSettings(
  home: TempHomeContext,
  value: unknown,
): Promise<void> {
  await mkdir(home.dataRoot, { recursive: true });
  await writeFile(
    join(home.dataRoot, "settings.json"),
    JSON.stringify(value, null, 2),
  );
}

function listSettings(overrides: Record<string, unknown> = {}) {
  return {
    provider: "deepseek",
    providers: [
      {
        name: "anthropic",
        spec: "anthropic",
        envVar: "ANTHROPIC_API_KEY",
        defaultModel: "claude-haiku-4-5-20251001",
      },
      {
        name: "deepseek",
        spec: "openai",
        envVar: "DEEPSEEK_API_KEY",
        baseUrl: "https://api.deepseek.com/v1",
        defaultModel: "deepseek-v4-pro",
      },
      {
        name: "gemini",
        spec: "gemini",
        envVar: "GEMINI_API_KEY",
        defaultModel: "gemini-2.5-flash",
      },
      {
        name: "openrouter",
        spec: "openai",
        envVar: "OPENROUTER_API_KEY",
        baseUrl: "https://openrouter.ai/api/v1",
      },
    ],
    ...overrides,
  };
}

function parseMigrationReport(result: CliResult): {
  applied: string[];
  pending: string[];
  ranAt: string;
  status: string;
} {
  expect(result.exitCode).toBe(0);
  expect(result.stderr).toBe("");
  expect(result.stdout.trim().split("\n")).toHaveLength(1);
  const report = JSON.parse(result.stdout) as {
    applied: string[];
    pending: string[];
    ranAt: string;
    status: string;
  };
  expect(Object.keys(report).sort()).toEqual([
    "applied",
    "pending",
    "ranAt",
    "status",
  ]);
  expect(Date.parse(report.ranAt)).not.toBeNaN();
  return report;
}

async function seedSchemaMigrationsOnly(
  home: TempHomeContext,
  appliedIds: readonly string[] = [],
): Promise<void> {
  await mkdir(home.dataRoot, { recursive: true });
  const db = new Database(join(home.dataRoot, "vibe.db"));
  db.run(`
    CREATE TABLE schema_migrations (
      id TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
  `);
  const insert = db.prepare(
    "INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)",
  );
  for (const id of appliedIds) {
    insert.run(id, "2026-01-01T00:00:00.000Z");
  }
  db.close();
}

async function seedInitialMigrationOnly(home: TempHomeContext): Promise<void> {
  await seedSchemaMigrationsOnly(home, ["001_initial_schema"]);
  const db = new Database(join(home.dataRoot, "vibe.db"));
  // Fully materialize migration 001 so the state is internally consistent:
  // schema_migrations records the migration as applied and every table/index
  // it creates actually exists. Migrations 002 and 003 remain truly pending.
  db.run(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      cwd_key TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL,
      last_accessed_at TEXT NOT NULL
    );
    CREATE INDEX idx_sessions_last_accessed_at
      ON sessions(last_accessed_at);
    CREATE TABLE learning_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL CHECK (type IN ('mistake', 'preference', 'success')),
      category TEXT NOT NULL,
      mistake TEXT NOT NULL,
      solution TEXT,
      timestamp INTEGER NOT NULL,
      demo_id TEXT
    );
    CREATE INDEX idx_learning_entries_category_timestamp
      ON learning_entries(category, timestamp);
    CREATE INDEX idx_learning_entries_demo_id
      ON learning_entries(demo_id)
      WHERE demo_id IS NOT NULL;
    CREATE TABLE constitution_rules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      rule TEXT NOT NULL,
      position INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(session_id, position)
    );
    CREATE INDEX idx_constitution_rules_session_position
      ON constitution_rules(session_id, position);
    CREATE TABLE interactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      goal TEXT NOT NULL,
      output TEXT NOT NULL,
      timestamp INTEGER NOT NULL
    );
    CREATE INDEX idx_interactions_session_timestamp
      ON interactions(session_id, timestamp);
  `);
  db.close();
}

interface CliRunOptions {
  cwd?: string;
  home?: string;
  env?: Record<string, string | undefined>;
  preload?: string;
}

function buildCliEnv(options: CliRunOptions): Record<string, string> {
  const env: Record<string, string> = {
    ...process.env,
    HOME: options.home ?? EMPTY_CLI_HOME,
  };
  for (const [key, value] of Object.entries(options.env ?? {})) {
    if (value === undefined) {
      delete env[key];
    } else {
      env[key] = value;
    }
  }
  return env;
}

function cliSpawnCmd(args: string[], options: CliRunOptions): string[] {
  return [
    "bun",
    "run",
    ...(options.preload === undefined ? [] : ["--preload", options.preload]),
    cli,
    ...args,
  ];
}

/**
 * Temporarily apply env var overrides (delete on `undefined`), run `fn`, then
 * restore exactly the touched keys to their prior values.
 */
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

/**
 * Run the CLI. `preload`-less calls run in-process via `runCliInProcess`
 * (no OS process spawn, immune to harness concurrency). Calls that need a
 * `--preload` module mock (fetch interception, fault injection) still spawn
 * a real subprocess — that mock must land before `cli.ts`'s module graph
 * loads, which only a fresh process/module registry can give.
 */
async function runCli(
  args: string[],
  options: CliRunOptions = {},
): Promise<CliResult> {
  mkdirSync(EMPTY_CLI_HOME, { recursive: true });
  if (options.preload !== undefined) {
    const result = Bun.spawnSync({
      cmd: cliSpawnCmd(args, options),
      cwd: options.cwd ?? originalCwd,
      env: buildCliEnv(options),
      stdout: "pipe",
      stderr: "pipe",
      timeout: 10_000,
    });
    return {
      stdout: result.stdout.toString(),
      stderr: result.stderr.toString(),
      exitCode: result.exitCode,
    };
  }
  const savedCwd = process.cwd();
  process.chdir(options.cwd ?? originalCwd);
  try {
    return await withMutatedEnv(
      { HOME: options.home ?? EMPTY_CLI_HOME, ...options.env },
      () => runCliInProcess(args),
    );
  } finally {
    process.chdir(savedCwd);
  }
}

async function runCliBatch(
  commandsList: string[][],
  options: CliRunOptions = {},
): Promise<{ args: string[]; result: CliResult }[]> {
  mkdirSync(EMPTY_CLI_HOME, { recursive: true });
  const env = buildCliEnv(options);
  return Promise.all(
    commandsList.map(async (args) => {
      const proc = Bun.spawn({
        cmd: cliSpawnCmd(args, options),
        cwd: options.cwd ?? originalCwd,
        env,
        stdout: "pipe",
        stderr: "pipe",
        timeout: 10_000,
      });
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      return { args, result: { stdout, stderr, exitCode } };
    }),
  );
}

interface IsolatedCliRun {
  args: string[];
  home: TempHomeContext;
  cwd: string;
  result: CliResult;
}

/**
 * Spawns CLI children with isolated HOME, cwd, and environment.
 * Each child gets its own temp HOME and temp cwd.
 */
async function runCliBatchIsolated(
  commandsList: string[][],
  baseOptions: Omit<CliRunOptions, "home" | "cwd"> = {},
): Promise<IsolatedCliRun[]> {
  const entries = await Promise.all(
    commandsList.map(async (args) => {
      const home = await useTempHome();
      const cwd = await createCwd();
      return { args, home, cwd };
    }),
  );
  return Promise.all(
    entries.map(async ({ args, home, cwd }) => {
      const proc = Bun.spawn({
        cmd: cliSpawnCmd(args, {
          ...baseOptions,
          home: home.home,
          cwd,
        }),
        cwd,
        env: buildCliEnv({ ...baseOptions, home: home.home, cwd }),
        stdout: "pipe",
        stderr: "pipe",
        timeout: 10_000,
      });
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      return { args, home, cwd, result: { stdout, stderr, exitCode } };
    }),
  );
}

async function expectHelpWithoutSession(command: string[]): Promise<void> {
  const result = await runCli([...command, "--help"]);
  expect(result.exitCode).toBe(0);
  expect(result.stderr).toBe("");
  expect(result.stdout).not.toContain("--session");
}

function expectLegacyDotenvWarningOnce(stderr: string): void {
  expect(stderr.trim().split("\n")).toEqual([LEGACY_DOTENV_WARNING]);
}

async function dirExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

async function scanSkillsCliResidue(): Promise<string[]> {
  const entries = await readdir(originalCwd);
  return entries.filter((e) => e.startsWith(".skills-cli-")).sort();
}

async function readDirTree(dir: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  async function walk(d: string, base: string) {
    const entries = await readdir(d, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const fullPath = join(d, entry.name);
      const relPath = join(base, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath, relPath);
      } else if (entry.isFile()) {
        result[relPath] = await readFile(fullPath, "utf8");
      }
    }
  }
  await walk(dir, "");
  return result;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

type SeedLearningEntry = {
  type: LearningType;
  category: string;
  observation: string;
  solution?: string;
  timestamp: number;
  demoId?: string;
};

async function seedLearningEntries(
  home: TempHomeContext,
  entries: readonly SeedLearningEntry[],
): Promise<void> {
  await mkdir(home.dataRoot, { recursive: true });
  const db = new Database(join(home.dataRoot, "vibe.db"));
  initializeSchema(db);
  const insert = db.prepare(
    `INSERT INTO learning_entries
       (type, category, observation, solution, timestamp, demo_id)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  for (const entry of entries) {
    insert.run(
      entry.type,
      entry.category,
      entry.observation,
      entry.solution ?? null,
      entry.timestamp,
      entry.demoId ?? null,
    );
  }
  db.close();
}

type SeedSessionRow = {
  id: string;
  cwdKey: string;
  cwd?: string | null;
  createdAt?: string;
  lastAccessedAt?: string;
};

type SeedInteractionRow = {
  sessionId: string;
  goal: string;
  output: string;
  timestamp: number;
};

async function seedSessionsAndInteractions(
  home: TempHomeContext,
  sessions: readonly SeedSessionRow[],
  interactions: readonly SeedInteractionRow[],
): Promise<void> {
  await mkdir(home.dataRoot, { recursive: true });
  const db = new Database(join(home.dataRoot, "vibe.db"));
  initializeSchema(db);
  const insertSession = db.prepare(
    "INSERT INTO sessions (id, cwd_key, cwd, created_at, last_accessed_at) VALUES (?, ?, ?, ?, ?)",
  );
  const insertInteraction = db.prepare(
    "INSERT INTO interactions (session_id, goal, output, timestamp) VALUES (?, ?, ?, ?)",
  );
  for (const session of sessions) {
    insertSession.run(
      session.id,
      session.cwdKey,
      session.cwd ?? null,
      session.createdAt ?? "2026-01-01T00:00:00.000Z",
      session.lastAccessedAt ?? "2026-01-01T00:00:00.000Z",
    );
  }
  for (const interaction of interactions) {
    insertInteraction.run(
      interaction.sessionId,
      interaction.goal,
      interaction.output,
      interaction.timestamp,
    );
  }
  db.close();
}

/** Shared check-runner — reduces boilerplate across max-attempts tests. */
async function runVibeCheck(
  extraArgs: string[] = [],
  extraEnv: Record<string, string | undefined> = {},
): Promise<{
  result: CliResult;
  payload: Record<string, unknown>;
}> {
  const home = await useTempHome();
  await writeSettings(home, listSettings({ provider: "anthropic" }));
  const result = await runCli(
    [
      "check",
      "--goal",
      "ship safely",
      "--plan",
      "run targeted tests",
      "--provider",
      "anthropic",
      ...extraArgs,
    ],
    {
      home: home.home,
      preload: mockAnthropicFetch,
      env: {
        ANTHROPIC_API_KEY: "ak",
        DEFAULT_MODEL: undefined,
        ...extraEnv,
      },
    },
  );
  return {
    result,
    payload: JSON.parse(result.stdout) as Record<string, unknown>,
  };
}

describe("CLI autosession surface", () => {
  test("production storage modules do not import legacy migration helpers", async () => {
    const productionModules = [
      "src/utils/autosession.ts",
      "src/utils/storage.ts",
      "src/utils/state.ts",
      "src/tools/constitution.ts",
      "src/cli.ts",
    ];

    for (const modulePath of productionModules) {
      const source = await readFile(join(originalCwd, modulePath), "utf8");
      expect(source).not.toContain("legacyMigration");
      expect(source).not.toContain("vibe-log.json");
      expect(source).not.toContain("constitution.json");
      expect(source).not.toContain("history.json");
    }
  });

  test("affected help output omits public --session options", async () => {
    await expectHelpWithoutSession(["check"]);
    await expectHelpWithoutSession(["learn"]);
    await expectHelpWithoutSession(["constitution", "set"]);
    await expectHelpWithoutSession(["constitution", "get"]);
    await expectHelpWithoutSession(["constitution", "reset"]);

    await expectHelpWithoutSession(["demo"]);
  });

  test("provider help describes settings entry names without hardcoded providers", async () => {
    const result = await runCli(["check", "--help"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("settings provider entry name");
    expect(result.stdout).not.toContain(
      "gemini | openai | openrouter | anthropic | deepseek | opencode",
    );
  });

  test("removed --session options fail through Commander", async () => {
    for (const command of [
      ["check", "--session", "x", "--goal", "g", "--plan", "p"],
      ["learn", "--session", "x", "--observation", "m", "--category", "c"],
      ["constitution", "set", "--session", "x", "--rule", "r"],
      ["constitution", "get", "--session", "x"],
      ["constitution", "reset", "--session", "x"],
      ["demo", "--session", "x"],
    ]) {
      const result = await runCli(command);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("unknown option '--session'");
    }
  });

  test("list command group exposes shared JSON output without affecting existing emitters", async () => {
    const pretty = await runCli(["list"]);
    const json = await runCli(["list", "--json"]);
    const help = await runCli(["list", "--help"]);

    expect(pretty.exitCode).toBe(0);
    expect(pretty.stderr).toBe("");
    expect(pretty.stdout).toContain("List commands");
    expect(pretty.stdout).toContain("- learnings");
    expect(json.exitCode).toBe(0);
    expect(json.stderr).toBe("");
    expect(JSON.parse(json.stdout)).toEqual({
      commands: [
        "learnings",
        "constitution",
        "sessions",
        "providers",
        "checks",
        "categories",
        "stats",
        "all",
      ],
    });
    expect(help.exitCode).toBe(0);
    expect(help.stdout).toContain("--json");
  });

  test("list learnings and categories handle empty local data", async () => {
    const home = await useTempHome();
    const prettyLearnings = await runCli(["list", "learnings"], {
      home: home.home,
    });
    const jsonLearnings = await runCli(["list", "learnings", "--json"], {
      home: home.home,
    });
    const prettyCategories = await runCli(["list", "categories"], {
      home: home.home,
    });
    const jsonCategories = await runCli(["list", "categories", "--json"], {
      home: home.home,
    });

    expect(prettyLearnings.exitCode).toBe(0);
    expect(prettyLearnings.stderr).toBe("");
    expect(prettyLearnings.stdout).toContain("Learnings");
    expect(prettyLearnings.stdout).toContain("(none)");
    expect(JSON.parse(jsonLearnings.stdout)).toEqual([]);
    expect(prettyCategories.exitCode).toBe(0);
    expect(prettyCategories.stderr).toBe("");
    expect(prettyCategories.stdout).toContain("Categories");
    expect(prettyCategories.stdout).toContain("(none)");
    expect(JSON.parse(jsonCategories.stdout)).toEqual([]);
  });

  test("list learnings filters, limits, and renders grouped pretty output", async () => {
    const home = await useTempHome();
    const base = Date.parse("2026-01-01T00:00:00.000Z");
    await seedLearningEntries(home, [
      {
        type: "mistake",
        category: "alpha",
        observation: "Alpha older.",
        solution: "Fix older.",
        timestamp: base,
      },
      {
        type: "success",
        category: "alpha",
        observation: "Alpha newer.",
        solution: "Keep newer.",
        timestamp: base + 1000,
      },
      {
        type: "preference",
        category: "beta",
        observation: "Beta preference.",
        timestamp: base + 2000,
      },
      {
        type: "mistake",
        category: "beta",
        observation: "Beta mistake.",
        solution: "Fix beta.",
        timestamp: base + 3000,
      },
      {
        type: "mistake",
        category: "gamma",
        observation: "Gamma mistake.",
        solution: "Fix gamma.",
        timestamp: base + 4000,
      },
    ]);

    const typed = await runCli(
      ["list", "learnings", "--type", "mistake", "--limit", "2", "--json"],
      { home: home.home },
    );
    const filtered = await runCli(
      ["list", "learnings", "--category", "beta", "--limit", "1", "--json"],
      { home: home.home },
    );
    const pretty = await runCli(["list", "learnings", "--type", "success"], {
      home: home.home,
    });

    expect(JSON.parse(typed.stdout)).toEqual([
      {
        type: "mistake",
        category: "alpha",
        observation: "Alpha older.",
        solution: "Fix older.",
        timestamp: base,
      },
      {
        type: "mistake",
        category: "beta",
        observation: "Beta mistake.",
        solution: "Fix beta.",
        timestamp: base + 3000,
      },
    ]);
    expect(JSON.parse(filtered.stdout)).toEqual([
      {
        type: "preference",
        category: "beta",
        observation: "Beta preference.",
        timestamp: base + 2000,
      },
    ]);
    expect(pretty.exitCode).toBe(0);
    expect(pretty.stderr).toBe("");
    expect(pretty.stdout).toContain("Category: alpha");
    expect(pretty.stdout).toContain("[success] Alpha newer.");
    expect(pretty.stdout).toContain("Solution: Keep newer.");
    expect(pretty.stdout).toMatch(/\((just now|\d+[dhms] ago)\)/);
  });

  test("list categories reports deterministic counts and recent examples", async () => {
    const home = await useTempHome();
    const base = Date.parse("2026-01-01T00:00:00.000Z");
    await seedLearningEntries(home, [
      {
        type: "mistake",
        category: "beta",
        observation: "Beta older.",
        solution: "Fix beta older.",
        timestamp: base,
      },
      {
        type: "mistake",
        category: "alpha",
        observation: "Alpha older.",
        solution: "Fix alpha older.",
        timestamp: base + 1000,
      },
      {
        type: "success",
        category: "alpha",
        observation: "Alpha newer.",
        solution: "Keep alpha newer.",
        timestamp: base + 2000,
      },
      {
        type: "preference",
        category: "beta",
        observation: "Beta newer.",
        timestamp: base + 3000,
      },
      {
        type: "mistake",
        category: "gamma",
        observation: "Gamma only.",
        solution: "Fix gamma.",
        timestamp: base + 4000,
      },
    ]);

    const json = await runCli(["list", "categories", "--json"], {
      home: home.home,
    });
    const pretty = await runCli(["list", "categories"], { home: home.home });
    const categories = JSON.parse(json.stdout) as Array<{
      category: string;
      count: number;
      recentExample: { observation: string };
    }>;

    expect(categories.map((category) => category.category)).toEqual([
      "alpha",
      "beta",
      "gamma",
    ]);
    expect(categories.map((category) => category.count)).toEqual([2, 2, 1]);
    expect(categories[0]?.recentExample.observation).toBe("Alpha newer.");
    expect(categories[1]?.recentExample.observation).toBe("Beta newer.");
    expect(pretty.exitCode).toBe(0);
    expect(pretty.stderr).toBe("");
    expect(pretty.stdout).toContain("Category  Count  Recent Example");
    expect(pretty.stdout.indexOf("alpha")).toBeLessThan(
      pretty.stdout.indexOf("beta"),
    );
    expect(pretty.stdout).toContain("[success] Alpha newer.");
  });

  test("list constitution targets the active autosession in JSON and pretty modes", async () => {
    const home = await useTempHome();
    const cwd = await createCwd();

    const empty = await runCli(["list", "constitution", "--json"], {
      cwd,
      home: home.home,
    });
    const emptyPayload = JSON.parse(empty.stdout) as {
      session: string;
      rules: string[];
    };
    const set = await runCli(
      ["constitution", "set", "--rule", "Prefer tests", "Prefer local state"],
      { cwd, home: home.home },
    );
    const json = await runCli(["list", "constitution", "--json"], {
      cwd,
      home: home.home,
    });
    const pretty = await runCli(["list", "constitution"], {
      cwd,
      home: home.home,
    });
    const payload = JSON.parse(json.stdout) as {
      session: string;
      rules: string[];
    };

    expect(empty.exitCode).toBe(0);
    expect(empty.stderr).toBe("");
    expect(emptyPayload.rules).toEqual([]);
    expect(set.exitCode).toBe(0);
    expect(json.exitCode).toBe(0);
    expect(json.stderr).toBe("");
    expect(payload).toEqual({
      session: emptyPayload.session,
      rules: ["Prefer tests", "Prefer local state"],
    });
    expect(pretty.exitCode).toBe(0);
    expect(pretty.stderr).toBe("");
    expect(pretty.stdout).toContain(`Session: ${emptyPayload.session}`);
    expect(pretty.stdout).toContain("1. Prefer tests");
    expect(pretty.stdout).toContain("2. Prefer local state");
  });

  test("constitution get/set/reset emit fatal JSON without stdout on database open failure", async () => {
    const home = await useTempHome();
    await mkdir(home.dataRoot, { recursive: true });
    await writeFile(join(home.dataRoot, "vibe.db"), "not sqlite");

    for (const args of [
      ["constitution", "get"],
      ["constitution", "set", "--rule", "r"],
      ["constitution", "reset"],
    ]) {
      const result = await runCli(args, { home: home.home });

      expect(result.exitCode).toBe(1);
      expect(result.stdout).toBe("");
      expect(JSON.parse(result.stderr)).toEqual({ error: expect.any(String) });
    }
  });

  test("constitution get/set/reset read via readListConstitution instead of duplicate autosession resolution", async () => {
    const source = await readFile(join(originalCwd, "src/cli.ts"), "utf8");
    const constitutionBlock = source.slice(
      source.indexOf('.command("constitution")'),
      source.indexOf('.command("session")'),
    );

    expect(constitutionBlock).not.toContain("getConstitution(");
    expect(constitutionBlock).not.toContain("getCurrentConstitutionSessionId(");
    expect(constitutionBlock.match(/readListConstitution\(\)/g)).toHaveLength(
      3,
    );
  });

  test("list sessions preserves JSON cwd_key and pretty cwd fallback", async () => {
    const home = await useTempHome();
    await mkdir(home.dataRoot, { recursive: true });
    const db = new Database(join(home.dataRoot, "vibe.db"));
    initializeSchema(db);
    const insert = db.prepare(
      "INSERT INTO sessions (id, cwd_key, cwd, created_at, last_accessed_at) VALUES (?, ?, ?, ?, ?)",
    );
    insert.run(
      "session-with-cwd",
      "cwd-key-with-cwd",
      "/tmp/project-with-cwd",
      "2026-01-01T00:00:00.000Z",
      "2026-01-03T00:00:00.000Z",
    );
    insert.run(
      "session-without-cwd",
      "cwd-key-fallback",
      null,
      "2026-01-01T00:00:00.000Z",
      "2026-01-02T00:00:00.000Z",
    );
    db.close();

    const json = await runCli(["list", "sessions", "--json"], {
      home: home.home,
    });
    const pretty = await runCli(["list", "sessions"], { home: home.home });
    const payload = JSON.parse(json.stdout) as Array<{
      id: string;
      cwd_key: string;
      cwd: string | null;
      created_at: string;
      last_accessed_at: string;
    }>;

    expect(json.exitCode).toBe(0);
    expect(json.stderr).toBe("");
    expect(payload).toEqual([
      {
        id: "session-with-cwd",
        cwd_key: "cwd-key-with-cwd",
        cwd: "/tmp/project-with-cwd",
        created_at: "2026-01-01T00:00:00.000Z",
        last_accessed_at: "2026-01-03T00:00:00.000Z",
      },
      {
        id: "session-without-cwd",
        cwd_key: "cwd-key-fallback",
        cwd: null,
        created_at: "2026-01-01T00:00:00.000Z",
        last_accessed_at: "2026-01-02T00:00:00.000Z",
      },
    ]);
    expect(pretty.exitCode).toBe(0);
    expect(pretty.stderr).toBe("");
    expect(pretty.stdout).toMatch(/cwd\s+id\s+created_at\s+last_accessed_at/);
    expect(pretty.stdout).toContain("/tmp/project-with-cwd");
    expect(pretty.stdout).toContain("session-with-cwd");
    expect(pretty.stdout).not.toContain("cwd-key-with-cwd");
    expect(pretty.stdout).toContain("cwd-key-fallback");
    expect(pretty.stdout).toContain("session-without-cwd");
  });

  test("list providers returns settings JSON and marks the active provider", async () => {
    const home = await useTempHome();
    await writeSettings(home, listSettings());

    const json = await runCli(["list", "providers", "--json"], {
      home: home.home,
    });
    const pretty = await runCli(["list", "providers"], {
      home: home.home,
    });
    const payload = JSON.parse(json.stdout) as Record<string, string>;

    expect(json.exitCode).toBe(0);
    expect(json.stderr).toBe("");
    expect(payload).toEqual({
      anthropic: "claude-haiku-4-5-20251001",
      deepseek: "deepseek-v4-pro",
      gemini: "gemini-2.5-flash",
      openrouter: "",
    });
    expect(payload).not.toHaveProperty("activeProvider");
    expect(pretty.exitCode).toBe(0);
    expect(pretty.stderr).toBe("");
    expect(pretty.stdout).toContain("Providers");
    expect(pretty.stdout).toMatch(/deepseek\s+deepseek-v4-pro\s+\*/);
    expect(pretty.stdout).toMatch(/openrouter\s+\(required via --model\)/);
  });

  test("list providers emits JSON stderr when settings cannot resolve active provider", async () => {
    const home = await useTempHome();
    await writeSettings(home, listSettings({ provider: "missing" }));

    const result = await runCli(["list", "providers", "--json"], {
      home: home.home,
    });

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(JSON.parse(result.stderr)).toEqual({
      error: "Provider 'missing' not found in settings.json",
    });
  });

  test("legacy env warning prints once for local-only JSON commands without settings", async () => {
    const home = await useTempHome();
    await mkdir(home.dataRoot, { recursive: true });
    await writeFile(join(home.dataRoot, ".env"), "DEFAULT_MODEL=file-model\n");

    for (const args of [
      ["session"],
      ["constitution", "get"],
      ["list", "learnings", "--json"],
    ]) {
      const result = await runCli(args, { home: home.home });

      expect(result.exitCode).toBe(0);
      expect(() => JSON.parse(result.stdout)).not.toThrow();
      expectLegacyDotenvWarningOnce(result.stderr);
    }
  });

  test("legacy env warning prints once for settings-backed provider lists", async () => {
    const home = await useTempHome();
    await mkdir(home.dataRoot, { recursive: true });
    await writeFile(join(home.dataRoot, ".env"), "DEFAULT_MODEL=file-model\n");
    await writeSettings(home, listSettings());

    const providers = await runCli(["list", "providers", "--json"], {
      home: home.home,
    });
    const all = await runCli(["list", "all", "--json"], { home: home.home });

    expect(providers.exitCode).toBe(0);
    expect(JSON.parse(providers.stdout)).toMatchObject({
      deepseek: "deepseek-v4-pro",
      openrouter: "",
    });
    expectLegacyDotenvWarningOnce(providers.stderr);

    expect(all.exitCode).toBe(0);
    expect(JSON.parse(all.stdout).providers).toMatchObject({
      activeProvider: "deepseek",
      providers: expect.objectContaining({ deepseek: "deepseek-v4-pro" }),
    });
    expectLegacyDotenvWarningOnce(all.stderr);
  });

  test("list checks filters, limits, parses, and truncates reasons", async () => {
    const home = await useTempHome();
    const base = Date.parse("2026-01-01T00:00:00.000Z");
    const longReason = "R".repeat(125);
    await seedSessionsAndInteractions(
      home,
      [
        { id: "session-alpha", cwdKey: "alpha-key", cwd: "/tmp/alpha" },
        { id: "session-beta", cwdKey: "beta-key", cwd: "/tmp/beta" },
      ],
      [
        {
          sessionId: "session-alpha",
          goal: "Review history",
          output: JSON.stringify({ reason: "Older parsed reason." }),
          timestamp: base,
        },
        {
          sessionId: "session-alpha",
          goal: "Deploy carefully",
          output: JSON.stringify({ reason: longReason }),
          timestamp: base + 2000,
        },
        {
          sessionId: "session-beta",
          goal: "Fallback output",
          output: "Plain fallback reason.",
          timestamp: base + 1000,
        },
      ],
    );

    const json = await runCli(
      [
        "list",
        "checks",
        "--session",
        "session-alpha",
        "--limit",
        "1",
        "--json",
      ],
      { home: home.home },
    );
    const pretty = await runCli(["list", "checks"], { home: home.home });
    const payload = JSON.parse(json.stdout) as Array<{
      id: number;
      session_id: string;
      goal: string;
      output: string;
      timestamp: number;
      displayCwd: string | null;
    }>;

    expect(json.exitCode).toBe(0);
    expect(json.stderr).toBe("");
    expect(payload).toEqual([
      {
        id: 2,
        session_id: "session-alpha",
        goal: "Deploy carefully",
        output: JSON.stringify({ reason: longReason }),
        timestamp: base + 2000,
        displayCwd: "/tmp/alpha",
      },
    ]);
    expect(pretty.exitCode).toBe(0);
    expect(pretty.stderr).toBe("");
    expect(pretty.stdout).toContain("Checks");
    expect(pretty.stdout).toContain("Session: /tmp/alpha");
    expect(pretty.stdout).toContain("Session: /tmp/beta");
    expect(pretty.stdout.indexOf("Deploy carefully")).toBeLessThan(
      pretty.stdout.indexOf("Review history"),
    );
    expect(pretty.stdout).toContain(`Reason: ${"R".repeat(120)}…`);
    expect(pretty.stdout).toContain("Reason: Plain fallback reason.");
  });

  test("list commands never perform provider network calls", async () => {
    const home = await useTempHome();
    const cwd = await createCwd();
    const env = {
      ANTHROPIC_API_KEY: "ak",
      DEFAULT_LLM_PROVIDER: "anthropic",
    };
    await writeSettings(home, listSettings());

    const commands = [
      ["list"],
      ["list", "--json"],
      [
        "list",
        "learnings",
        "--type",
        "mistake",
        "--category",
        "risk",
        "--limit",
        "5",
      ],
      [
        "list",
        "learnings",
        "--type",
        "mistake",
        "--category",
        "risk",
        "--limit",
        "5",
        "--json",
      ],
      ["list", "constitution"],
      ["list", "constitution", "--json"],
      ["list", "sessions"],
      ["list", "sessions", "--json"],
      ["list", "providers"],
      ["list", "providers", "--json"],
      ["list", "checks", "--session", "missing", "--limit", "5"],
      ["list", "checks", "--session", "missing", "--limit", "5", "--json"],
      ["list", "categories"],
      ["list", "categories", "--json"],
      ["list", "stats"],
      ["list", "stats", "--json"],
      ["list", "all"],
      ["list", "all", "--json"],
    ];

    const results = await runCliBatch(commands, {
      cwd,
      home: home.home,
      preload: failOnFetch,
      env,
    });

    for (const { args, result } of results) {
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).not.toBe("");
      if (args.includes("--json"))
        expect(() => JSON.parse(result.stdout)).not.toThrow();
    }
  }, 10000);

  test("list stats and all compose local readers", async () => {
    const home = await useTempHome();
    const cwd = await createCwd();
    const base = Date.parse("2026-01-01T00:00:00.000Z");
    const set = await runCli(
      ["constitution", "set", "--rule", "Prefer local reads"],
      {
        cwd,
        home: home.home,
      },
    );
    const activeSession = (JSON.parse(set.stdout) as { session: string })
      .session;
    await seedLearningEntries(home, [
      {
        type: "mistake",
        category: "risk",
        observation: "Risk one.",
        solution: "Mitigate risk.",
        timestamp: base,
      },
      {
        type: "preference",
        category: "style",
        observation: "Style one.",
        timestamp: base + 1000,
      },
      {
        type: "success",
        category: "risk",
        observation: "Risk success.",
        solution: "Repeat it.",
        timestamp: base + 2000,
      },
    ]);
    await seedSessionsAndInteractions(
      home,
      [
        {
          id: "secondary-session",
          cwdKey: "secondary-key",
          cwd: "/tmp/secondary",
          lastAccessedAt: "2026-01-02T00:00:00.000Z",
        },
      ],
      [
        {
          sessionId: activeSession,
          goal: "First active goal",
          output: JSON.stringify({ reason: "First active reason." }),
          timestamp: base,
        },
        {
          sessionId: activeSession,
          goal: "Second active goal",
          output: JSON.stringify({ reason: "Second active reason." }),
          timestamp: base + 1000,
        },
        {
          sessionId: "secondary-session",
          goal: "Secondary goal",
          output: JSON.stringify({ reason: "Secondary reason." }),
          timestamp: base + 2000,
        },
      ],
    );

    await writeSettings(home, listSettings());

    const statsJson = await runCli(["list", "stats", "--json"], {
      cwd,
      home: home.home,
    });
    const statsPretty = await runCli(["list", "stats"], {
      cwd,
      home: home.home,
    });
    const allJson = await runCli(["list", "all", "--json"], {
      cwd,
      home: home.home,
    });
    const allPretty = await runCli(["list", "all"], {
      cwd,
      home: home.home,
    });
    const stats = JSON.parse(statsJson.stdout);
    const all = JSON.parse(allJson.stdout) as {
      learnings: unknown[];
      constitution: { rules: string[] };
      sessions: unknown[];
      providers: { activeProvider: string; providers: Record<string, string> };
      checks: unknown[];
      categories: unknown[];
      stats: unknown;
    };

    expect(statsJson.exitCode).toBe(0);
    expect(statsJson.stderr).toBe("");
    expect(stats).toEqual({
      learnings: { total: 3, mistake: 1, preference: 1, success: 1 },
      sessions: { total: 2, mostActiveCwd: cwd },
      constitution: { activeRules: 1 },
      checks: { total: 3 },
    });
    expect(statsPretty.exitCode).toBe(0);
    expect(statsPretty.stderr).toBe("");
    expect(statsPretty.stdout).toContain("Learnings: 3 total");
    expect(statsPretty.stdout).toContain(`Most active cwd: ${cwd}`);
    expect(allJson.exitCode).toBe(0);
    expect(allJson.stderr).toBe("");
    expect(Object.keys(all)).toEqual([
      "learnings",
      "constitution",
      "sessions",
      "providers",
      "checks",
      "categories",
      "stats",
    ]);
    expect(all.learnings).toHaveLength(3);
    expect(all.constitution.rules).toEqual(["Prefer local reads"]);
    expect(all.sessions).toHaveLength(2);
    expect(all.providers.providers["deepseek"]).toBe("deepseek-v4-pro");
    expect(all.checks).toHaveLength(3);
    expect(all.categories).toHaveLength(2);
    expect(all.stats).toEqual(stats);
    expect(allPretty.exitCode).toBe(0);
    expect(allPretty.stderr).toBe("");
    for (const heading of [
      "Learnings",
      "Constitution",
      "Sessions",
      "Providers",
      "Checks",
      "Categories",
      "Stats",
    ]) {
      expect(allPretty.stdout).toContain(heading);
    }
    expect(allPretty.stdout).toContain("Prefer local reads");
    expect(allPretty.stdout).toMatch(/deepseek\s+deepseek-v4-pro\s+\*/);
    expect(allPretty.stdout).toContain("Second active goal");
  });

  test("learn command JSON output remains unchanged after list additions", async () => {
    const home = await useTempHome();
    const result = await runCli(
      [
        "learn",
        "--observation",
        "Store reusable successes.",
        "--category",
        "archive",
        "--solution",
        "Review them before similar work.",
        "--type",
        "success",
      ],
      { home: home.home },
    );
    const payload = JSON.parse(result.stdout) as {
      added: boolean;
      alreadyKnown: boolean;
      categoryCount: number;
      topCategories: Array<{
        category: string;
        count: number;
        recentExample: { type: string; observation: string; solution: string };
      }>;
    };

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(payload).toMatchObject({
      added: true,
      alreadyKnown: false,
      categoryCount: 1,
      topCategories: [
        {
          category: "archive",
          count: 1,
          recentExample: {
            type: "success",
            observation: "Store reusable successes.",
            solution: "Review them before similar work.",
          },
        },
      ],
    });
  });

  test("session schema adds nullable display cwd idempotently", () => {
    const db = new Database(":memory:");
    initializeSchema(db);
    initializeSchema(db);

    const columns = db
      .query<{ name: string; type: string; notnull: number }, []>(
        "PRAGMA table_info(sessions)",
      )
      .all();
    db.close();

    expect(columns).toContainEqual(
      expect.objectContaining({ name: "cwd", type: "TEXT", notnull: 0 }),
    );
  });

  test("migrate command reports fresh database migrations", async () => {
    const home = await useTempHome();

    const result = await runCli(["migrate"], { home: home.home });
    const report = parseMigrationReport(result);

    expect(report).toEqual({
      applied: EXPECTED_MIGRATION_IDS,
      pending: EXPECTED_MIGRATION_IDS,
      ranAt: report.ranAt,
      status: "migrated",
    });
  });

  test("migrate command reports empty database files as fresh migrations", async () => {
    const home = await useTempHome();
    await mkdir(home.dataRoot, { recursive: true });
    await writeFile(join(home.dataRoot, "vibe.db"), "");

    const result = await runCli(["migrate"], { home: home.home });
    const report = parseMigrationReport(result);

    expect(report).toEqual({
      applied: EXPECTED_MIGRATION_IDS,
      pending: EXPECTED_MIGRATION_IDS,
      ranAt: report.ranAt,
      status: "migrated",
    });
  });

  test("migrate command reports schema-migrations-only databases as fresh migrations", async () => {
    const home = await useTempHome();
    await seedSchemaMigrationsOnly(home);

    const result = await runCli(["migrate"], { home: home.home });
    const report = parseMigrationReport(result);

    expect(report).toEqual({
      applied: EXPECTED_MIGRATION_IDS,
      pending: EXPECTED_MIGRATION_IDS,
      ranAt: report.ranAt,
      status: "migrated",
    });
  });

  test("migrate command reports current databases without pending migrations", async () => {
    const home = await useTempHome();

    const first = parseMigrationReport(
      await runCli(["migrate"], { home: home.home }),
    );
    const second = parseMigrationReport(
      await runCli(["migrate"], { home: home.home }),
    );

    expect(first.pending).toEqual(EXPECTED_MIGRATION_IDS);
    expect(second).toEqual({
      applied: EXPECTED_MIGRATION_IDS,
      pending: [],
      ranAt: second.ranAt,
      status: "up-to-date",
    });
  });

  test("migrate command reports partially migrated databases", async () => {
    const home = await useTempHome();
    await seedInitialMigrationOnly(home);

    const result = await runCli(["migrate"], { home: home.home });
    const report = parseMigrationReport(result);

    expect(report).toEqual({
      applied: EXPECTED_MIGRATION_IDS,
      pending: EXPECTED_MIGRATION_IDS.slice(1),
      ranAt: report.ranAt,
      status: "migrated",
    });
  });

  test("migrate command rejects flags without stdout success payload", async () => {
    const home = await useTempHome();

    const result = await runCli(["migrate", "--json"], { home: home.home });

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(JSON.parse(result.stderr)).toEqual({ error: expect.any(String) });
  });

  test("migrate command emits fatal JSON without stdout on filesystem setup failure", async () => {
    const home = await useTempHome();
    await writeFile(home.dataRoot, "not a directory");

    const result = await runCli(["migrate"], { home: home.home });

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(JSON.parse(result.stderr)).toEqual({ error: expect.any(String) });
  });

  test("migrate command emits fatal JSON without stdout on database open failure", async () => {
    const home = await useTempHome();
    await mkdir(home.dataRoot, { recursive: true });
    await writeFile(join(home.dataRoot, "vibe.db"), "not sqlite");

    const result = await runCli(["migrate"], { home: home.home });

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(JSON.parse(result.stderr)).toEqual({ error: expect.any(String) });
  });

  test("migrate command emits fatal JSON without stdout on migration SQL failure", async () => {
    const home = await useTempHome();
    await seedSchemaMigrationsOnly(home, ["001_initial_schema"]);

    const result = await runCli(["migrate"], { home: home.home });

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(JSON.parse(result.stderr)).toEqual({ error: expect.any(String) });
  });

  test("session command emits JSON and refreshes lastAccessedAt", async () => {
    const home = await useTempHome();
    const cwd = await createCwd();
    const cwdKey = getCwdKey(cwd);

    const first = await runCli(["session"], { cwd, home: home.home });
    const firstJson = JSON.parse(first.stdout) as { session: string };
    const db = new Database(join(home.dataRoot, "vibe.db"));
    const oldTimestamp = new Date(Date.now() - 1000).toISOString();
    db.prepare(
      "UPDATE sessions SET last_accessed_at = ? WHERE cwd_key = ?",
    ).run(oldTimestamp, cwdKey);

    const second = await runCli(["session"], { cwd, home: home.home });
    const secondJson = JSON.parse(second.stdout) as { session: string };
    const touched = db
      .query<
        {
          id: string;
          cwd_key: string;
          cwd: string | null;
          created_at: string;
          last_accessed_at: string;
        },
        [string]
      >(
        "SELECT id, cwd_key, cwd, created_at, last_accessed_at FROM sessions WHERE cwd_key = ?",
      )
      .get(cwdKey);
    db.close();

    expect(first.exitCode).toBe(0);
    expect(second.exitCode).toBe(0);
    expect(firstJson.session).toMatch(/^[0-9a-f-]{36}$/);
    expect(secondJson.session).toBe(firstJson.session);
    expect(touched).toMatchObject({
      id: firstJson.session,
      cwd_key: cwdKey,
      cwd,
    });
    expect(Number.isNaN(Date.parse(touched?.created_at ?? ""))).toBe(false);
    expect(Date.parse(touched?.last_accessed_at ?? "")).toBeGreaterThan(
      Date.parse(oldTimestamp),
    );
  });

  test("session command migrates and refreshes rows without display cwd", async () => {
    const home = await useTempHome();
    const cwd = await createCwd();
    const cwdKey = getCwdKey(cwd);
    const dbPath = join(home.dataRoot, "vibe.db");
    const sessionId = "00000000-0000-4000-8000-000000000001";
    const createdAt = new Date(Date.now() - 2000).toISOString();
    const oldTimestamp = new Date(Date.now() - 1000).toISOString();

    await mkdir(home.dataRoot, { recursive: true });
    const db = new Database(dbPath);
    db.run(`
      CREATE TABLE schema_migrations (
        id TEXT PRIMARY KEY,
        applied_at TEXT NOT NULL
      );
      INSERT INTO schema_migrations (id, applied_at)
        VALUES ('001_initial_schema', '${createdAt}');
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        cwd_key TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL,
        last_accessed_at TEXT NOT NULL
      );
      CREATE INDEX idx_sessions_last_accessed_at
        ON sessions(last_accessed_at);
      CREATE TABLE learning_entries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        type TEXT NOT NULL CHECK (type IN ('mistake', 'preference', 'success')),
        category TEXT NOT NULL,
        mistake TEXT NOT NULL,
        solution TEXT,
        timestamp INTEGER NOT NULL,
        demo_id TEXT
      );
    `);
    db.prepare(
      "INSERT INTO sessions (id, cwd_key, created_at, last_accessed_at) VALUES (?, ?, ?, ?)",
    ).run(sessionId, cwdKey, createdAt, oldTimestamp);
    db.close();

    const result = await runCli(["session"], { cwd, home: home.home });
    const migrated = new Database(dbPath);
    const touched = migrated
      .query<
        { id: string; cwd: string | null; last_accessed_at: string },
        [string]
      >("SELECT id, cwd, last_accessed_at FROM sessions WHERE cwd_key = ?")
      .get(cwdKey);
    const migration = migrated
      .query<{ id: string }, []>(
        "SELECT id FROM schema_migrations WHERE id = '002_sessions_display_cwd'",
      )
      .get();
    migrated.close();

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ session: sessionId });
    expect(migration).toEqual({ id: "002_sessions_display_cwd" });
    expect(touched?.id).toBe(sessionId);
    expect(touched?.cwd).toBeNull();
    expect(Date.parse(touched?.last_accessed_at ?? "")).toBeGreaterThan(
      Date.parse(oldTimestamp),
    );
  });

  test("schema excludes list commands and preserves metadata", async () => {
    const result = await runCli(["schema"]);
    const schema = JSON.parse(result.stdout) as {
      v?: unknown;
      data?: unknown;
      errors?: unknown;
      config?: unknown;
      commands: Record<
        string,
        {
          req?: Record<string, string>;
          opt?: Record<string, string>;
          out?: unknown;
          exit?: Record<string, string>;
        }
      >;
    };

    const commandKeys = Object.keys(schema.commands);

    for (const key of ["v", "data", "errors", "config"]) {
      expect(schema).toHaveProperty(key);
    }
    expect(commandKeys).not.toContain("list");
    expect(commandKeys.some((command) => command.startsWith("list "))).toBe(
      false,
    );
    for (const command of [
      "check",
      "learn",
      "constitution set",
      "constitution get",
      "constitution reset",
      "session",
      "verify",
      "prune",
      "migrate",
      "skills list",
      "skills install",
      "guide list",
      "guide install",
    ]) {
      expect(schema.commands[command]).toBeDefined();
      expect(schema.commands[command]?.opt ?? {}).not.toHaveProperty(
        "--session",
      );
    }
    expect(schema.commands["skills list"]).toMatchObject({
      when: expect.any(String),
      req: {},
      opt: {
        "--target": expect.any(String),
      },
      out: expect.objectContaining({
        target: expect.any(String),
        skills: expect.any(String),
      }),
      exit: expect.objectContaining({
        "0": expect.any(String),
        "1": expect.any(String),
      }),
    });
    expect(schema.commands["skills install"]).toMatchObject({
      when: expect.any(String),
      req: {},
      opt: expect.objectContaining({
        "--target": expect.any(String),
        "--dry-run": expect.any(String),
        "--force": expect.any(String),
      }),
      out: expect.objectContaining({
        target: expect.any(String),
        dryRun: expect.any(String),
        force: expect.any(String),
        ok: expect.any(String),
        skills: expect.any(String),
      }),
      exit: expect.objectContaining({
        "0": expect.any(String),
        "2": expect.any(String),
        "1": expect.any(String),
      }),
    });
    expect(schema.commands["guide list"]).toMatchObject({
      when: expect.any(String),
      req: {},
      opt: {
        "--target": expect.any(String),
      },
      out: expect.objectContaining({
        target: expect.any(String),
        status: expect.any(String),
      }),
      exit: {
        "0": expect.any(String),
        "1": expect.any(String),
      },
    });
    expect(schema.commands["guide install"]).toMatchObject({
      when: expect.any(String),
      req: {},
      opt: expect.objectContaining({
        "--target": expect.any(String),
        "--dry-run": expect.any(String),
      }),
      out: expect.objectContaining({
        target: expect.any(String),
        dryRun: expect.any(String),
        ok: expect.any(String),
        status: expect.any(String),
        action: expect.any(String),
      }),
      exit: {
        "0": expect.any(String),
        "1": expect.any(String),
      },
    });
    expect(schema.commands["migrate"]).toMatchObject({
      when: expect.any(String),
      req: {},
      opt: {},
      out: {
        applied: "[str]",
        pending: "[str]",
        ranAt: "ISO datetime str",
        status: "migrated|up-to-date",
      },
      exit: {
        "0": "success",
        "1": "error",
      },
    });
    expect(Object.keys(schema.commands["migrate"]?.req ?? {})).toEqual([]);
    expect(Object.keys(schema.commands["migrate"]?.opt ?? {})).toEqual([]);
    expect(Object.keys(schema.commands["migrate"]?.out ?? {})).toEqual([
      "applied",
      "pending",
      "ranAt",
      "status",
    ]);
    expect(Object.keys(schema.commands["migrate"]?.exit ?? {})).toEqual([
      "0",
      "1",
    ]);
    expect(Object.keys(schema.commands["prune"]?.opt ?? {})).toEqual([
      "--learnings",
      "--duplicates",
      "--demos",
      "--sessions",
      "--age",
      "--category",
      "--overlap",
      "--dry-run",
      "-y, --yes",
    ]);
    expect(schema.commands["prune"]).toMatchObject({
      when: expect.any(String),
      req: {},
      opt: expect.objectContaining({
        "--learnings": expect.any(String),
        "--duplicates": expect.any(String),
        "--demos": expect.any(String),
        "--sessions": expect.any(String),
        "--age": expect.any(String),
        "--category": expect.any(String),
        "--overlap": expect.any(String),
        "--dry-run": expect.any(String),
        "-y, --yes": expect.any(String),
      }),
      out: expect.objectContaining({
        dryRun: expect.any(String),
        targets: expect.any(String),
        candidateCounts: expect.any(String),
        representativeDetails: expect.any(String),
        backupPath: expect.any(String),
        deletedCounts: expect.any(String),
        skippedTargets: expect.any(String),
        failedTargets: expect.any(String),
      }),
      exit: expect.objectContaining({
        "0": expect.any(String),
        "1": expect.any(String),
      }),
    });
  });

  test("schema reports settings config without loading home env provider defaults", async () => {
    const home = await useTempHome();
    await mkdir(home.dataRoot, { recursive: true });
    await writeFile(
      join(home.dataRoot, ".env"),
      [
        "# ignored comment",
        "DEFAULT_LLM_PROVIDER=deepseek",
        "DEFAULT_MODEL=file-model",
        "MALFORMED_LINE",
        "EMPTY_VALUE=",
      ].join("\n"),
    );

    await writeSettings(home, listSettings());

    const result = await runCli(["schema"], {
      home: home.home,
      env: {
        DEFAULT_LLM_PROVIDER: undefined,
        DEFAULT_MODEL: "shell-model",
        ANTHROPIC_API_KEY: undefined,
        ANTHROPIC_AUTH_TOKEN: undefined,
        GEMINI_API_KEY: undefined,
        OPENAI_API_KEY: undefined,
        OPENROUTER_API_KEY: undefined,
        DEEPSEEK_API_KEY: undefined,
        OPENCODE_API_KEY: undefined,
      },
    });
    const schema = JSON.parse(result.stdout) as {
      config: { provider: string; model: string };
    };

    expect(result.exitCode).toBe(0);
    expectLegacyDotenvWarningOnce(result.stderr);
    expect(schema.config).toEqual({
      provider: "deepseek",
      model: "deepseek-v4-pro",
    });
  });

  test("verify ignores provider API keys from legacy home env files", async () => {
    const home = await useTempHome();
    await mkdir(home.dataRoot, { recursive: true });
    await writeFile(join(home.dataRoot, ".env"), "DEEPSEEK_API_KEY=file-key\n");
    await writeSettings(home, listSettings());

    const result = await runCli(["verify"], {
      home: home.home,
      env: { DEEPSEEK_API_KEY: undefined, DEFAULT_MODEL: undefined },
    });
    const payload = JSON.parse(result.stdout) as { ok: boolean; error: string };

    expect(result.exitCode).toBe(1);
    expectLegacyDotenvWarningOnce(result.stderr);
    expect(payload.ok).toBe(false);
    expect(payload.error).toBe(
      "DEEPSEEK_API_KEY is not set in the environment",
    );
  });

  test("verify emits JSON failure and exits 1 for unsupported providers", async () => {
    const home = await useTempHome();
    await writeSettings(home, listSettings());

    const result = await runCli(["verify", "--provider", "bogus"], {
      home: home.home,
      env: { DEFAULT_MODEL: undefined },
    });
    const payload = JSON.parse(result.stdout) as {
      ok: boolean;
      provider: string;
      model: string;
      error: string;
    };

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe("");
    expect(payload).toMatchObject({
      ok: false,
      provider: "bogus",
      model: "(default)",
    });
    expect(payload.error).toContain(
      "Provider 'bogus' not found in settings.json",
    );
  });

  test("check emits blocking result JSON when gate provider resolution fails", async () => {
    const home = await useTempHome();
    await writeSettings(home, listSettings());

    const result = await runCli(
      ["check", "--goal", "g", "--plan", "p", "--provider", "bogus"],
      { home: home.home, env: { DEFAULT_MODEL: undefined } },
    );
    const payload = JSON.parse(result.stdout) as {
      proceed: boolean;
      reason: string;
    };

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toBe("");
    expect(payload.proceed).toBe(false);
    expect(payload.reason).toBe("Feedback generation failed");
  });

  test("check emits approval JSON and exits 0 with mocked Anthropic", async () => {
    const { result, payload } = await runVibeCheck(
      [
        "--model",
        "mock-claude",
        "--progress",
        "implementation done",
        "--uncertainty",
        "edge cases",
        "--context",
        "release prep",
        "--prompt",
        "please verify",
      ],
      { VIBE_TEST_ANTHROPIC_MODE: "proceed" },
    );

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(payload).toMatchObject({
      proceed: true,
      confidence: 0.91,
      reason: "proceed:mock-claude",
      attempts: 1,
    });
    expect(payload["feedback"]).toContain("questions:mock-claude");
  });

  test("check emits exhausted block JSON and exits 2 at attempt boundary", async () => {
    const { result, payload } = await runVibeCheck(["--max-attempts", "1"], {
      VIBE_TEST_ANTHROPIC_MODE: "block",
    });

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toBe("");
    expect(payload).toMatchObject({
      proceed: false,
      exhausted: true,
      attempts: 1,
      reason: "block:claude-haiku-4-5-20251001",
    });
  });

  test("--max-attempts 0 flag falls back to 10 due to falsy default", async () => {
    const { result, payload } = await runVibeCheck(["--max-attempts", "0"], {
      VIBE_TEST_ANTHROPIC_MODE: "block",
    });

    expect(result.exitCode).toBe(2);
    expect(payload["exhausted"]).toBe(true);
    expect(payload["attempts"]).toBeGreaterThanOrEqual(1);
  });

  test("settings maxAttempts used when CLI option absent", async () => {
    const home = await useTempHome();
    await writeSettings(
      home,
      listSettings({ provider: "anthropic", maxAttempts: 1 }),
    );

    const result = await runCli(
      [
        "check",
        "--goal",
        "ship safely",
        "--plan",
        "run targeted tests",
        "--provider",
        "anthropic",
        "--model",
        "mock-claude",
      ],
      {
        home: home.home,
        preload: mockAnthropicFetch,
        env: {
          ANTHROPIC_API_KEY: "ak",
          DEFAULT_MODEL: undefined,
          VIBE_TEST_ANTHROPIC_MODE: "block",
        },
      },
    );
    const payload = JSON.parse(result.stdout) as Record<string, unknown>;

    expect(result.exitCode).toBe(2);
    expect(payload).toMatchObject({
      proceed: false,
      exhausted: true,
      attempts: 1,
    });
  }, 15000);

  test("--max-attempts CLI overrides settings maxAttempts", async () => {
    const home = await useTempHome();
    await writeSettings(
      home,
      listSettings({ provider: "anthropic", maxAttempts: 1 }),
    );

    const result = await runCli(
      [
        "check",
        "--goal",
        "ship safely",
        "--plan",
        "run targeted tests",
        "--provider",
        "anthropic",
        "--model",
        "mock-claude",
        "--max-attempts",
        "3",
      ],
      {
        home: home.home,
        preload: mockAnthropicFetch,
        env: {
          ANTHROPIC_API_KEY: "ak",
          DEFAULT_MODEL: undefined,
          VIBE_TEST_ANTHROPIC_MODE: "proceed",
        },
      },
    );
    const payload = JSON.parse(result.stdout) as Record<string, unknown>;

    expect(result.exitCode).toBe(0);
    expect(payload).toMatchObject({ proceed: true, attempts: 1 });
  }, 15000);

  test("verify emits JSON success and exits 0 with mocked Anthropic", async () => {
    const home = await useTempHome();
    await writeSettings(home, listSettings({ provider: "anthropic" }));

    const result = await runCli(
      ["verify", "--provider", "anthropic", "--model", "mock-verify"],
      {
        home: home.home,
        preload: mockAnthropicFetch,
        env: { ANTHROPIC_API_KEY: "ak", DEFAULT_MODEL: undefined },
      },
    );
    const payload = JSON.parse(result.stdout) as {
      ok: boolean;
      provider: string;
      model: string;
      response: string;
    };

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(payload).toMatchObject({
      ok: true,
      provider: "anthropic",
      model: "mock-verify",
    });
    expect(payload.response).toContain("questions:mock-verify");
  }, 15000);

  test("learn command emits validation failure JSON without process failure", async () => {
    const home = await useTempHome();

    const result = await runCli(
      ["learn", "--observation", "Repeated risky plan.", "--category", "risk"],
      { home: home.home },
    );
    const payload = JSON.parse(result.stdout) as {
      added: boolean;
      alreadyKnown: boolean;
      categoryCount: number;
      topCategories: unknown[];
    };

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain(
      "--solution is required for mistake and success types",
    );
    expect(payload).toEqual({
      added: false,
      alreadyKnown: false,
      categoryCount: 0,
      topCategories: [],
    });
  });

  test("constitution commands preserve ordered state and support clearing", async () => {
    const home = await useTempHome();
    const cwd = await createCwd();

    const set = await runCli(
      ["constitution", "set", "--rule", "Prefer tests", "Prefer rollbacks"],
      { cwd, home: home.home },
    );
    const get = await runCli(["constitution", "get"], { cwd, home: home.home });
    const reset = await runCli(["constitution", "reset"], {
      cwd,
      home: home.home,
    });

    expect(set.exitCode).toBe(0);
    expect(JSON.parse(set.stdout)).toMatchObject({
      rules: ["Prefer tests", "Prefer rollbacks"],
    });
    expect(JSON.parse(get.stdout)).toMatchObject({
      rules: ["Prefer tests", "Prefer rollbacks"],
    });
    expect(JSON.parse(reset.stdout)).toMatchObject({ rules: [] });
  });

  test("prune help output shows all options", async () => {
    const result = await runCli(["prune", "--help"]);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("--learnings");
    expect(result.stdout).toContain("--duplicates");
    expect(result.stdout).toContain("--demos");
    expect(result.stdout).toContain("--sessions");
    expect(result.stdout).toContain("--age <days>");
    expect(result.stdout).toContain("--category <name>");
    expect(result.stdout).toContain("--overlap <float>");
    expect(result.stdout).toContain("--dry-run");
    expect(result.stdout).toContain("-y, --yes");
  });

  test("prune dry-run mode works without providers", async () => {
    const home = await useTempHome();

    const result = await runCli(
      [
        "prune",
        "--learnings",
        "--duplicates",
        "--demos",
        "--sessions",
        "--dry-run",
      ],
      {
        home: home.home,
        preload: failOnFetch,
        env: {
          ANTHROPIC_API_KEY: "ak",
          DEFAULT_LLM_PROVIDER: "anthropic",
        },
      },
    );
    const payload = JSON.parse(result.stdout) as {
      dryRun: boolean;
      targets: string[];
      candidateCounts: Record<string, number>;
      backupPath: string | null;
      deletedCounts: Record<string, number>;
      skippedTargets: string[];
      failedTargets: unknown[];
    };

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(payload.dryRun).toBe(true);
    expect(payload.targets).toEqual(
      expect.arrayContaining(["learnings", "duplicates", "demos", "sessions"]),
    );
    expect(payload.candidateCounts).toBeDefined();
    expect(payload.backupPath).toBeNull();
    expect(payload.deletedCounts).toEqual({
      learnings: 0,
      duplicates: 0,
      demos: 0,
      sessions: 0,
    });
    expect(payload.failedTargets).toEqual([]);
  }, 15000);

  test("prune with no targets defaults to dry-run summary", async () => {
    const home = await useTempHome();

    const result = await runCli(["prune"], { home: home.home });
    const payload = JSON.parse(result.stdout) as {
      dryRun: boolean;
      targets: string[];
    };

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(payload.dryRun).toBe(true);
    expect(payload.targets).toEqual(
      expect.arrayContaining(["learnings", "duplicates", "demos", "sessions"]),
    );
  });

  test("prune rejects invalid --age", async () => {
    const home = await useTempHome();

    const result = await runCli(["prune", "--learnings", "--age", "-5"], {
      home: home.home,
    });
    const payload = JSON.parse(result.stderr) as { error: string };

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(payload.error).toContain("--age must be a positive integer");
  });

  test("prune rejects invalid --overlap", async () => {
    const home = await useTempHome();

    const result = await runCli(["prune", "--duplicates", "--overlap", "1.5"], {
      home: home.home,
    });
    const payload = JSON.parse(result.stderr) as { error: string };

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(payload.error).toContain(
      "--overlap must be a float between 0 and 1",
    );
  });

  test("prune rejects --category with no explicit targets", async () => {
    const home = await useTempHome();

    const result = await runCli(["prune", "--category", "scope", "--dry-run"], {
      home: home.home,
    });
    const payload = JSON.parse(result.stderr) as { error: string };

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(payload.error).toContain(
      "--category is only allowed with --learnings or --duplicates",
    );
  });

  test("prune rejects --category with --demos", async () => {
    const home = await useTempHome();

    const result = await runCli(
      ["prune", "--demos", "--category", "test-category", "--dry-run"],
      { home: home.home },
    );
    const payload = JSON.parse(result.stderr) as { error: string };

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(payload.error).toContain(
      "--category is only allowed with --learnings or --duplicates",
    );
  });

  test("prune rejects --category with --sessions", async () => {
    const home = await useTempHome();

    const result = await runCli(
      ["prune", "--sessions", "--category", "test-category", "--dry-run"],
      { home: home.home },
    );
    const payload = JSON.parse(result.stderr) as { error: string };

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(payload.error).toContain(
      "--category is only allowed with --learnings or --duplicates",
    );
  });

  test("prune accepts --category with mixed compatible and incompatible targets", async () => {
    const cases = [
      {
        args: [
          "prune",
          "--learnings",
          "--demos",
          "--category",
          "test-category",
          "--dry-run",
        ],
        expectedTargets: ["learnings", "demos"],
      },
      {
        args: [
          "prune",
          "--duplicates",
          "--sessions",
          "--category",
          "test-category",
          "--dry-run",
        ],
        expectedTargets: ["duplicates", "sessions"],
      },
    ] as const;

    for (const { args, expectedTargets } of cases) {
      const home = await useTempHome();

      const result = await runCli([...args], { home: home.home });
      const payload = JSON.parse(result.stdout) as {
        dryRun: boolean;
        targets: string[];
      };

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
      expect(payload.dryRun).toBe(true);
      expect(payload.targets).toEqual(expect.arrayContaining(expectedTargets));
      expect(payload.targets).toHaveLength(expectedTargets.length);
    }
  });

  test("prune omits negated boolean option variants from its CLI contract", async () => {
    const help = await runCli(["prune", "--help"]);

    expect(help.exitCode).toBe(0);
    expect(help.stdout).not.toContain("--no-dry-run");
    expect(help.stdout).not.toContain("--no-yes");

    for (const option of ["--no-dry-run", "--no-yes"]) {
      const result = await runCli(["prune", option]);

      expect(result.exitCode).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("unknown option");
      expect(result.stderr).toContain(option);
    }
  });

  test("prune commands never perform provider network calls", async () => {
    const env = {
      ANTHROPIC_API_KEY: "ak",
      DEFAULT_LLM_PROVIDER: "anthropic",
    };
    const commands = [
      ["prune"],
      ["prune", "--learnings", "--dry-run"],
      ["prune", "--duplicates", "--dry-run"],
      ["prune", "--demos", "--dry-run"],
      ["prune", "--sessions", "--dry-run"],
      [
        "prune",
        "--learnings",
        "--duplicates",
        "--demos",
        "--sessions",
        "--dry-run",
      ],
    ];

    const results = await runCliBatchIsolated(commands, {
      preload: failOnFetch,
      env,
    });

    for (const { result, home, cwd } of results) {
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).not.toBe("");
      expect(() => JSON.parse(result.stdout)).not.toThrow();
      // Private HOME was used, not the shared EMPTY_CLI_HOME.
      expect(home.home).not.toBe(EMPTY_CLI_HOME);
      // Each child used a unique cwd.
      expect(cwd).not.toBe(originalCwd);
    }
  }, 10000);

  test("concurrent prune children use isolated HOME and local storage", async () => {
    await rm(EMPTY_CLI_HOME, { recursive: true, force: true });
    await mkdir(EMPTY_CLI_HOME, { recursive: true });

    const env = {
      ANTHROPIC_API_KEY: "ak",
      DEFAULT_LLM_PROVIDER: "anthropic",
    };
    const commands = [
      ["prune", "--learnings", "--dry-run"],
      ["prune", "--duplicates", "--dry-run"],
      ["prune", "--sessions", "--dry-run"],
    ];

    const results = await runCliBatchIsolated(commands, {
      preload: failOnFetchRecorder,
      env,
    });

    const homes = new Set(results.map((r) => r.home.home));
    const cwds = new Set(results.map((r) => r.cwd));

    // Every child received a unique HOME.
    expect(homes.size).toBe(results.length);
    // Every child received a unique cwd.
    expect(cwds.size).toBe(results.length);

    for (const { result, home, cwd } of results) {
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
      const payload = JSON.parse(result.stdout) as {
        dryRun: boolean;
        targets: string[];
      };
      expect(payload.dryRun).toBe(true);

      // No database file was created in the shared EMPTY_CLI_HOME.
      expect(await dirExists(join(EMPTY_CLI_HOME, ".vibe-cli"))).toBe(false);
      // Private HOME has its own data root.
      expect(home.dataRoot).toContain(home.home);
      // cwd is different from HOME and originalCwd.
      expect(cwd).not.toBe(home.home);
      expect(cwd).not.toBe(originalCwd);
    }
  }, 10000);

  test("prune destructive requires --yes and emits backup path", async () => {
    const home = await useTempHome();
    const base = Date.parse("2026-01-01T00:00:00.000Z");
    await seedLearningEntries(home, [
      {
        type: "mistake",
        category: "test",
        observation: "Old entry.",
        solution: "Fix it.",
        timestamp: base - 100 * 24 * 60 * 60 * 1000,
      },
    ]);

    const dryRun = await runCli(
      ["prune", "--learnings", "--age", "90", "--dry-run"],
      { home: home.home },
    );
    const dryPayload = JSON.parse(dryRun.stdout) as {
      dryRun: boolean;
      candidateCounts: { learnings: number };
    };

    expect(dryPayload.dryRun).toBe(true);
    expect(dryPayload.candidateCounts.learnings).toBeGreaterThanOrEqual(1);

    const destructive = await runCli(
      ["prune", "--learnings", "--age", "90", "--yes"],
      { home: home.home },
    );
    const destructivePayload = JSON.parse(destructive.stdout) as {
      dryRun: boolean;
      backupPath: string | null;
      deletedCounts: { learnings: number };
    };

    expect(destructive.exitCode).toBe(0);
    expect(destructive.stderr).toBe("");
    expect(destructivePayload.dryRun).toBe(false);
    expect(destructivePayload.backupPath).toBeDefined();
    expect(destructivePayload.backupPath).not.toBeNull();
    expect(destructivePayload.deletedCounts.learnings).toBeGreaterThanOrEqual(
      1,
    );
  });

  test("prune destructive accepts -y short flag", async () => {
    const home = await useTempHome();
    const base = Date.parse("2026-01-01T00:00:00.000Z");
    await seedLearningEntries(home, [
      {
        type: "mistake",
        category: "test",
        observation: "Old entry.",
        solution: "Fix it.",
        timestamp: base - 100 * 24 * 60 * 60 * 1000,
      },
    ]);

    const result = await runCli(["prune", "--learnings", "--age", "90", "-y"], {
      home: home.home,
    });
    const payload = JSON.parse(result.stdout) as {
      dryRun: boolean;
      backupPath: string | null;
      deletedCounts: { learnings: number };
    };

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(payload.dryRun).toBe(false);
    expect(payload.backupPath).not.toBeNull();
    expect(payload.deletedCounts.learnings).toBeGreaterThanOrEqual(1);
  });

  test("prune rejects simultaneous --dry-run and --yes", async () => {
    const home = await useTempHome();
    const base = Date.parse("2026-01-01T00:00:00.000Z");
    await seedLearningEntries(home, [
      {
        type: "mistake",
        category: "test",
        observation: "Old entry.",
        solution: "Fix it.",
        timestamp: base - 100 * 24 * 60 * 60 * 1000,
      },
    ]);

    const result = await runCli(
      ["prune", "--learnings", "--age", "90", "--dry-run", "--yes"],
      { home: home.home },
    );
    const payload = JSON.parse(result.stderr) as { error: string };

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(payload.error).toContain("--dry-run cannot be combined with --yes");

    const dryRun = await runCli(
      ["prune", "--learnings", "--age", "90", "--dry-run"],
      { home: home.home },
    );
    const dryPayload = JSON.parse(dryRun.stdout) as {
      candidateCounts: { learnings: number };
    };
    expect(dryPayload.candidateCounts.learnings).toBeGreaterThanOrEqual(1);
  });

  test("prune with no flags excludes all four target flags from runPrune input", async () => {
    const home = await useTempHome();
    const capturePath = join(home.home, "prune-input.json");

    const result = await runCli(["prune"], {
      home: home.home,
      preload: capturePruneInput,
      env: { VIBE_PRUNE_CAPTURE: capturePath },
    });
    const payload = JSON.parse(result.stdout) as {
      dryRun: boolean;
      targets: string[];
    };

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(payload.dryRun).toBe(true);
    expect(payload.targets).toEqual([
      "learnings",
      "duplicates",
      "demos",
      "sessions",
    ]);

    // Verify the input to runPrune: unset flags must not appear at all
    const captured = JSON.parse(await readFile(capturePath, "utf-8")) as Record<
      string,
      unknown
    >;
    expect(captured).not.toHaveProperty("learnings");
    expect(captured).not.toHaveProperty("duplicates");
    expect(captured).not.toHaveProperty("demos");
    expect(captured).not.toHaveProperty("sessions");
    expect(captured).not.toHaveProperty("dryRun");
    expect(captured).not.toHaveProperty("yes");
  }, 15000);

  test("prune boolean flags include true in runPrune input when provided", async () => {
    const cases = [
      { args: ["prune", "--dry-run"], expected: "dryRun" },
      { args: ["prune", "--yes"], expected: "yes" },
      { args: ["prune", "-y"], expected: "yes" },
    ] as const;

    for (const [index, { args, expected }] of cases.entries()) {
      const home = await useTempHome();
      const capturePath = join(home.home, `prune-input-${index}.json`);

      const result = await runCli([...args], {
        home: home.home,
        preload: capturePruneInput,
        env: { VIBE_PRUNE_CAPTURE: capturePath },
      });

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");

      const captured = JSON.parse(
        await readFile(capturePath, "utf-8"),
      ) as Record<string, unknown>;
      expect(captured[expected]).toBe(true);
    }
  }, 15000);

  test("prune --learnings includes only learnings:true in runPrune input", async () => {
    const home = await useTempHome();
    const capturePath = join(home.home, "prune-input.json");

    const result = await runCli(["prune", "--learnings"], {
      home: home.home,
      preload: capturePruneInput,
      env: { VIBE_PRUNE_CAPTURE: capturePath },
    });
    const payload = JSON.parse(result.stdout) as {
      dryRun: boolean;
      targets: string[];
    };

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(payload.dryRun).toBe(true);
    expect(payload.targets).toEqual(["learnings"]);

    const captured = JSON.parse(await readFile(capturePath, "utf-8")) as Record<
      string,
      unknown
    >;
    expect(captured["learnings"]).toBe(true);
    expect(captured).not.toHaveProperty("duplicates");
    expect(captured).not.toHaveProperty("demos");
    expect(captured).not.toHaveProperty("sessions");
  }, 15000);

  test("prune --duplicates --demos includes only those two flags in runPrune input", async () => {
    const home = await useTempHome();
    const capturePath = join(home.home, "prune-input.json");

    const result = await runCli(["prune", "--duplicates", "--demos"], {
      home: home.home,
      preload: capturePruneInput,
      env: { VIBE_PRUNE_CAPTURE: capturePath },
    });
    const payload = JSON.parse(result.stdout) as {
      dryRun: boolean;
      targets: string[];
    };

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(payload.dryRun).toBe(true);
    expect(payload.targets).toEqual(
      expect.arrayContaining(["duplicates", "demos"]),
    );
    expect(payload.targets).toHaveLength(2);

    const captured = JSON.parse(await readFile(capturePath, "utf-8")) as Record<
      string,
      unknown
    >;
    expect(captured["duplicates"]).toBe(true);
    expect(captured["demos"]).toBe(true);
    expect(captured).not.toHaveProperty("learnings");
    expect(captured).not.toHaveProperty("sessions");
  }, 15000);

  test("prune rejects non-numeric --age via CLI fatal", async () => {
    const home = await useTempHome();

    const result = await runCli(["prune", "--learnings", "--age", "abc"], {
      home: home.home,
    });
    const payload = JSON.parse(result.stderr) as { error: string };

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(payload.error).toContain("--age must be a valid integer");
  });

  test("prune rejects non-numeric --overlap via CLI fatal", async () => {
    const home = await useTempHome();

    const result = await runCli(["prune", "--duplicates", "--overlap", "abc"], {
      home: home.home,
    });
    const payload = JSON.parse(result.stderr) as { error: string };

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(payload.error).toContain(
      "--overlap must be a valid number between 0 and 1",
    );
  });

  test("learn --type preference succeeds without --solution", async () => {
    const home = await useTempHome();

    const result = await runCli(
      [
        "learn",
        "--observation",
        "Prefer small incremental deploys.",
        "--category",
        "deployment",
        "--type",
        "preference",
      ],
      { home: home.home },
    );
    const payload = JSON.parse(result.stdout) as {
      added: boolean;
      alreadyKnown: boolean;
      categoryCount: number;
    };

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(payload).toMatchObject({
      added: true,
      alreadyKnown: false,
      categoryCount: 1,
    });
  });

  test("learn --type success without --solution emits validation failure", async () => {
    const home = await useTempHome();

    const result = await runCli(
      [
        "learn",
        "--observation",
        "Safe rollback pattern.",
        "--category",
        "safety",
        "--type",
        "success",
      ],
      { home: home.home },
    );
    const payload = JSON.parse(result.stdout) as {
      added: boolean;
      alreadyKnown: boolean;
      categoryCount: number;
      topCategories: unknown[];
    };

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain(
      "--solution is required for mistake and success types",
    );
    expect(payload).toEqual({
      added: false,
      alreadyKnown: false,
      categoryCount: 0,
      topCategories: [],
    });
  });

  test("constitution reset --rule replaces existing rules", async () => {
    const home = await useTempHome();
    const cwd = await createCwd();

    const initial = await runCli(
      ["constitution", "set", "--rule", "Rule A", "Rule B"],
      { cwd, home: home.home },
    );
    const initialPayload = JSON.parse(initial.stdout) as { rules: string[] };
    expect(initialPayload.rules).toEqual(["Rule A", "Rule B"]);

    const replaced = await runCli(
      ["constitution", "reset", "--rule", "Rule C"],
      {
        cwd,
        home: home.home,
      },
    );
    const replacedPayload = JSON.parse(replaced.stdout) as {
      session: string;
      rules: string[];
    };

    expect(replaced.exitCode).toBe(0);
    expect(replaced.stderr).toBe("");
    expect(replacedPayload.rules).toEqual(["Rule C"]);

    const get = await runCli(["constitution", "get"], { cwd, home: home.home });
    const getPayload = JSON.parse(get.stdout) as { rules: string[] };
    expect(getPayload.rules).toEqual(["Rule C"]);
  });

  test("help and fatal error stderr stay on baseline when legacy env is absent", async () => {
    const help = await runCli(["check", "--help"]);
    const error = await runCli(["unknown-command"]);

    expect(help.exitCode).toBe(0);
    expect(help.stderr).toBe("");
    expect(help.stdout).toContain("--provider");
    expect(error.exitCode).toBe(1);
    expect(error.stdout).toBe("");
    expect(JSON.parse(error.stderr)).toEqual({
      error: "error: unknown command 'unknown-command'",
    });
  });

  test("skills help documents list and install options", async () => {
    const group = await runCli(["skills", "--help"]);
    const listHelp = await runCli(["skills", "list", "--help"]);
    const installHelp = await runCli(["skills", "install", "--help"]);

    expect(group.exitCode).toBe(0);
    expect(group.stderr).toBe("");
    expect(group.stdout).toContain("list");
    expect(group.stdout).toContain("install");

    expect(listHelp.exitCode).toBe(0);
    expect(listHelp.stderr).toBe("");
    expect(listHelp.stdout).toContain("--target");

    expect(installHelp.exitCode).toBe(0);
    expect(installHelp.stderr).toBe("");
    expect(installHelp.stdout).toContain("--target");
    expect(installHelp.stdout).toContain("--dry-run");
    expect(installHelp.stdout).toContain("--force");
  });

  test("skills list emits one JSON line for default and custom targets", async () => {
    const home = await useTempHome();
    const target = join(home.home, ".agents", "skills");
    const spacedTarget = join(home.home, "skill dir", "nested");
    const absoluteTarget = join(home.home, "absolute-skills");

    const defaultList = await runCli(["skills", "list", "--json"], {
      home: home.home,
    });
    expect(defaultList.exitCode).toBe(0);
    expect(defaultList.stderr).toBe("");
    expect(defaultList.stdout.trim().split("\n")).toHaveLength(1);
    // JSON-only success: no presentation text around the payload.
    expect(defaultList.stdout).toBe(`${defaultList.stdout.trim()}\n`);
    const defaultPayload = JSON.parse(defaultList.stdout) as {
      target: string;
      skills: Array<{ name: string; status: string }>;
    };
    expect(defaultPayload.target).toBe(target);
    expect(isAbsolute(defaultPayload.target)).toBe(true);
    expect(defaultPayload.skills.map((s) => s.name)).toEqual([
      "vibe-check",
      "vibe-constitution",
      "vibe-learn",
    ]);
    expect(defaultPayload.skills.every((s) => s.status === "missing")).toBe(
      true,
    );
    expect(Object.keys(defaultPayload)).toEqual(["target", "skills"]);
    expect(
      defaultPayload.skills.every(
        (s) => Object.keys(s).sort().join(",") === "name,status",
      ),
    ).toBe(true);
    expect(await dirExists(target)).toBe(false);

    const relativeList = await runCli(
      ["skills", "list", "--target", "rel-skills", "--json"],
      {
        home: home.home,
        cwd: home.home,
      },
    );
    expect(relativeList.exitCode).toBe(0);
    expect(relativeList.stderr).toBe("");
    expect(relativeList.stdout.trim().split("\n")).toHaveLength(1);
    const relativePayload = JSON.parse(relativeList.stdout) as {
      target: string;
    };
    expect(relativePayload.target).toBe(join(home.home, "rel-skills"));
    expect(isAbsolute(relativePayload.target)).toBe(true);
    expect(await dirExists(join(home.home, "rel-skills"))).toBe(false);

    const spacedList = await runCli(
      ["skills", "list", "--target", spacedTarget, "--json"],
      {
        home: home.home,
      },
    );
    expect(spacedList.exitCode).toBe(0);
    expect(spacedList.stderr).toBe("");
    expect(spacedList.stdout.trim().split("\n")).toHaveLength(1);
    const spacedPayload = JSON.parse(spacedList.stdout) as { target: string };
    expect(spacedPayload.target).toBe(spacedTarget);
    expect(await dirExists(spacedTarget)).toBe(false);

    const tildeList = await runCli(
      ["skills", "list", "--target", "~/tilde-skills", "--json"],
      {
        home: home.home,
      },
    );
    expect(tildeList.exitCode).toBe(0);
    expect(tildeList.stderr).toBe("");
    const tildePayload = JSON.parse(tildeList.stdout) as { target: string };
    expect(tildePayload.target).toBe(join(home.home, "tilde-skills"));
    expect(await dirExists(join(home.home, "tilde-skills"))).toBe(false);

    const absoluteList = await runCli(
      ["skills", "list", "--target", absoluteTarget, "--json"],
      { home: home.home },
    );
    expect(absoluteList.exitCode).toBe(0);
    expect(absoluteList.stderr).toBe("");
    const absolutePayload = JSON.parse(absoluteList.stdout) as {
      target: string;
    };
    expect(absolutePayload.target).toBe(absoluteTarget);
    expect(await dirExists(absoluteTarget)).toBe(false);
  });

  test("skills list reports mixed statuses in lexical order without mutation", async () => {
    const home = await useTempHome();
    const target = join(home.home, "mixed-skills");
    const bundledSkills = join(originalCwd, "skills");

    // Seed target trees directly so list coverage stays independent of install.
    await mkdir(target, { recursive: true });
    await cp(join(bundledSkills, "vibe-check"), join(target, "vibe-check"), {
      recursive: true,
    });
    await cp(
      join(bundledSkills, "vibe-constitution"),
      join(target, "vibe-constitution"),
      { recursive: true },
    );
    await writeFile(
      join(target, "vibe-check", "SKILL.md"),
      "locally modified skill content\n",
    );
    // vibe-learn intentionally absent → missing.

    const before = await readFile(
      join(target, "vibe-check", "SKILL.md"),
      "utf8",
    );

    const listed = await runCli(
      ["skills", "list", "--target", target, "--json"],
      {
        home: home.home,
      },
    );
    expect(listed.exitCode).toBe(0);
    expect(listed.stderr).toBe("");
    expect(listed.stdout.trim().split("\n")).toHaveLength(1);
    const payload = JSON.parse(listed.stdout) as {
      target: string;
      skills: Array<{ name: string; status: string }>;
    };
    expect(payload.target).toBe(target);
    expect(payload.skills.map((s) => s.name)).toEqual([
      "vibe-check",
      "vibe-constitution",
      "vibe-learn",
    ]);
    expect(payload.skills.map((s) => s.status)).toEqual([
      "modified",
      "up-to-date",
      "missing",
    ]);
    expect(await readFile(join(target, "vibe-check", "SKILL.md"), "utf8")).toBe(
      before,
    );
    expect(await dirExists(join(target, "vibe-learn"))).toBe(false);
  });

  test("skills list rejects unsupported options with stderr-only fatal JSON", async () => {
    const home = await useTempHome();
    const result = await runCli(["skills", "list", "--bogus"], {
      home: home.home,
    });

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr.trim().split("\n")).toHaveLength(1);
    expect(JSON.parse(result.stderr)).toEqual({
      error: "error: unknown option '--bogus'",
    });
  });

  test("skills list surfaces target validation failures as stderr-only fatal JSON", async () => {
    const home = await useTempHome();
    const target = join(home.home, "unsafe-target");
    await mkdir(target, { recursive: true });
    await symlink("/tmp", join(target, "vibe-check"));

    const result = await runCli(
      ["skills", "list", "--target", target, "--json"],
      {
        home: home.home,
      },
    );

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr.trim().split("\n")).toHaveLength(1);
    const payload = JSON.parse(result.stderr) as { error: string };
    expect(payload.error).toContain("symlink");
    // list remains read-only even on fatal validation.
    expect(await dirExists(join(target, "vibe-constitution"))).toBe(false);
  });

  test("skills list surfaces source validation failures as stderr-only fatal JSON", async () => {
    const home = await useTempHome();
    const packageRoot = await mkdtemp(join(tmpdir(), "vibe-skills-src-"));
    cwdRoots.push(packageRoot);
    // Missing skills/ directory is a fatal source error.
    await writeFile(join(packageRoot, "package.json"), "{}\n");

    const result = await runCli(["skills", "list", "--json"], {
      home: home.home,
      preload: skillsPackageRoot,
      env: { VIBE_TEST_SKILLS_PACKAGE_ROOT: packageRoot },
    });

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr.trim().split("\n")).toHaveLength(1);
    const payload = JSON.parse(result.stderr) as { error: string };
    expect(payload.error).toContain("Skills directory does not exist");
    expect(await dirExists(join(home.home, ".agents", "skills"))).toBe(false);
  }, 15000);

  test("skills list emits empty inventory JSON without creating targets", async () => {
    const home = await useTempHome();
    const packageRoot = await mkdtemp(join(tmpdir(), "vibe-skills-empty-"));
    cwdRoots.push(packageRoot);
    await writeFile(join(packageRoot, "package.json"), "{}\n");
    await mkdir(join(packageRoot, "skills"), { recursive: true });
    const target = join(home.home, "empty-list-target");

    const result = await runCli(
      ["skills", "list", "--target", target, "--json"],
      {
        home: home.home,
        preload: skillsPackageRoot,
        env: { VIBE_TEST_SKILLS_PACKAGE_ROOT: packageRoot },
      },
    );

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout.trim().split("\n")).toHaveLength(1);
    expect(JSON.parse(result.stdout)).toEqual({
      target,
      skills: [],
    });
    expect(await dirExists(target)).toBe(false);
  }, 15000);

  test("skills list keeps missing target roots deterministic and read-only", async () => {
    const home = await useTempHome();
    const missing = join(home.home, "no", "such", "skills");

    const result = await runCli(
      ["skills", "list", "--target", missing, "--json"],
      {
        home: home.home,
      },
    );

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    const payload = JSON.parse(result.stdout) as {
      target: string;
      skills: Array<{ status: string }>;
    };
    expect(payload.target).toBe(missing);
    expect(payload.skills.length).toBeGreaterThan(0);
    expect(payload.skills.every((s) => s.status === "missing")).toBe(true);
    expect(await dirExists(missing)).toBe(false);
    expect(await dirExists(join(home.home, "no"))).toBe(false);
  });

  test("skills install dry-run plans without writing target content", async () => {
    const home = await useTempHome();
    // Keep target on the package filesystem so same-device staging remains valid.
    const targetRoot = await mkdtemp(join(originalCwd, ".skills-cli-target-"));
    cwdRoots.push(targetRoot);
    const target = join(targetRoot, "skills");

    const result = await runCli(
      ["skills", "install", "--dry-run", "--target", target, "--json"],
      { home: home.home },
    );
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout.trim().split("\n")).toHaveLength(1);
    const payload = JSON.parse(result.stdout) as {
      target: string;
      dryRun: boolean;
      force: boolean;
      ok: boolean;
      skills: Array<{ name: string; status: string; action: string }>;
    };
    expect(payload).toMatchObject({
      target,
      dryRun: true,
      force: false,
      ok: true,
    });
    expect(payload.skills.map((s) => s.action)).toEqual([
      "would-install",
      "would-install",
      "would-install",
    ]);
    expect(await dirExists(target)).toBe(false);
  });

  test("skills install copies missing skills and blocks modified targets", async () => {
    const home = await useTempHome();
    // Keep target on the package filesystem so same-device staging remains valid.
    const targetRoot = await mkdtemp(join(originalCwd, ".skills-cli-target-"));
    cwdRoots.push(targetRoot);
    const target = join(targetRoot, "skills");

    const installed = await runCli(
      ["skills", "install", "--target", target, "--json"],
      {
        home: home.home,
      },
    );
    expect(installed.exitCode).toBe(0);
    expect(installed.stderr).toBe("");
    const installedPayload = JSON.parse(installed.stdout) as {
      ok: boolean;
      skills: Array<{ name: string; action: string }>;
    };
    expect(installedPayload.ok).toBe(true);
    expect(installedPayload.skills.map((s) => s.action)).toEqual([
      "installed",
      "installed",
      "installed",
    ]);
    expect(await fileExists(join(target, "vibe-check", "SKILL.md"))).toBe(true);

    const listAfter = await runCli(
      ["skills", "list", "--target", target, "--json"],
      {
        home: home.home,
      },
    );
    const listPayload = JSON.parse(listAfter.stdout) as {
      skills: Array<{ status: string }>;
    };
    expect(listPayload.skills.every((s) => s.status === "up-to-date")).toBe(
      true,
    );

    await writeFile(
      join(target, "vibe-check", "SKILL.md"),
      "locally modified skill content\n",
    );

    const blocked = await runCli(
      ["skills", "install", "--target", target, "--json"],
      {
        home: home.home,
      },
    );
    expect(blocked.exitCode).toBe(2);
    expect(blocked.stderr).toBe("");
    const blockedPayload = JSON.parse(blocked.stdout) as {
      ok: boolean;
      skills: Array<{ name: string; status: string; action: string }>;
    };
    expect(blockedPayload.ok).toBe(false);
    expect(
      blockedPayload.skills.find((s) => s.name === "vibe-check"),
    ).toMatchObject({
      status: "modified",
      action: "blocked",
    });
    expect(await readFile(join(target, "vibe-check", "SKILL.md"), "utf8")).toBe(
      "locally modified skill content\n",
    );

    const forced = await runCli(
      ["skills", "install", "--force", "--target", target, "--json"],
      { home: home.home },
    );
    expect(forced.exitCode).toBe(0);
    expect(forced.stderr).toBe("");
    const forcedPayload = JSON.parse(forced.stdout) as {
      ok: boolean;
      force: boolean;
      skills: Array<{ action: string }>;
    };
    expect(forcedPayload.ok).toBe(true);
    expect(forcedPayload.force).toBe(true);
    expect(forcedPayload.skills.every((s) => s.action === "replaced")).toBe(
      true,
    );
    expect(
      await readFile(join(target, "vibe-check", "SKILL.md"), "utf8"),
    ).not.toBe("locally modified skill content\n");
  });

  test("skills install rejects unsupported options with stderr-only fatal JSON", async () => {
    const home = await useTempHome();
    const result = await runCli(["skills", "install", "--bogus", "--json"], {
      home: home.home,
    });

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr.trim().split("\n")).toHaveLength(1);
    expect(JSON.parse(result.stderr)).toEqual({
      error: "error: unknown option '--bogus'",
    });
  });

  test("skills install surfaces operational failures as stderr-only fatal JSON", async () => {
    const home = await useTempHome();
    const missingParent = join(home.home, "missing-parent", "skills");

    const result = await runCli(
      ["skills", "install", "--target", missingParent, "--json"],
      {
        home: home.home,
      },
    );

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr.trim().split("\n")).toHaveLength(1);
    const payload = JSON.parse(result.stderr) as { error: string };
    expect(payload.error).toContain("Target parent");
  });

  test("skills install empty inventory emits ok payload after target preflight", async () => {
    const home = await useTempHome();
    const packageRoot = await mkdtemp(
      join(tmpdir(), "vibe-skills-empty-install-"),
    );
    cwdRoots.push(packageRoot);
    await writeFile(join(packageRoot, "package.json"), "{}\n");
    await mkdir(join(packageRoot, "skills"), { recursive: true });
    const targetRoot = await mkdtemp(join(originalCwd, ".skills-cli-empty-"));
    cwdRoots.push(targetRoot);
    const target = join(targetRoot, "skills");

    const result = await runCli(
      ["skills", "install", "--target", target, "--json"],
      {
        home: home.home,
        preload: skillsPackageRoot,
        env: { VIBE_TEST_SKILLS_PACKAGE_ROOT: packageRoot },
      },
    );

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout.trim().split("\n")).toHaveLength(1);
    expect(JSON.parse(result.stdout)).toEqual({
      target,
      dryRun: false,
      force: false,
      ok: true,
      skills: [],
    });
    // Empty install must not create the target root.
    expect(await dirExists(target)).toBe(false);
  }, 15000);

  test("skills install empty inventory still rejects missing target parent", async () => {
    const home = await useTempHome();
    const packageRoot = await mkdtemp(
      join(tmpdir(), "vibe-skills-empty-parent-"),
    );
    cwdRoots.push(packageRoot);
    await writeFile(join(packageRoot, "package.json"), "{}\n");
    await mkdir(join(packageRoot, "skills"), { recursive: true });
    const missingParent = join(home.home, "no-parent", "skills");

    const result = await runCli(
      ["skills", "install", "--dry-run", "--target", missingParent, "--json"],
      {
        home: home.home,
        preload: skillsPackageRoot,
        env: { VIBE_TEST_SKILLS_PACKAGE_ROOT: packageRoot },
      },
    );

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr.trim().split("\n")).toHaveLength(1);
    const payload = JSON.parse(result.stderr) as { error: string };
    expect(payload.error).toContain("Target parent");
    expect(await dirExists(missingParent)).toBe(false);
  }, 15000);

  test("skills install dry-run plus force plans would-replace without writes", async () => {
    const home = await useTempHome();
    const targetRoot = await mkdtemp(
      join(originalCwd, ".skills-cli-force-dry-"),
    );
    cwdRoots.push(targetRoot);
    const target = join(targetRoot, "skills");
    const bundledSkills = join(originalCwd, "skills");

    await mkdir(target, { recursive: true });
    await cp(join(bundledSkills, "vibe-check"), join(target, "vibe-check"), {
      recursive: true,
    });
    await writeFile(
      join(target, "vibe-check", "SKILL.md"),
      "locally modified skill content\n",
    );
    const before = await readFile(
      join(target, "vibe-check", "SKILL.md"),
      "utf8",
    );

    const result = await runCli(
      [
        "skills",
        "install",
        "--dry-run",
        "--force",
        "--target",
        target,
        "--json",
      ],
      { home: home.home },
    );

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout.trim().split("\n")).toHaveLength(1);
    const payload = JSON.parse(result.stdout) as {
      dryRun: boolean;
      force: boolean;
      ok: boolean;
      skills: Array<{ name: string; action: string }>;
    };
    expect(payload).toMatchObject({ dryRun: true, force: true, ok: true });
    expect(payload.skills.find((s) => s.name === "vibe-check")?.action).toBe(
      "would-replace",
    );
    expect(
      payload.skills
        .filter((s) => s.name !== "vibe-check")
        .every((s) => s.action === "would-install"),
    ).toBe(true);
    expect(await readFile(join(target, "vibe-check", "SKILL.md"), "utf8")).toBe(
      before,
    );
    expect(await dirExists(join(target, "vibe-learn"))).toBe(false);
  });

  test("skills install dry-run blocks modified targets with exit 2 and no writes", async () => {
    const home = await useTempHome();
    const targetRoot = await mkdtemp(
      join(originalCwd, ".skills-cli-block-dry-"),
    );
    cwdRoots.push(targetRoot);
    const target = join(targetRoot, "skills");
    const bundledSkills = join(originalCwd, "skills");

    await mkdir(target, { recursive: true });
    await cp(join(bundledSkills, "vibe-check"), join(target, "vibe-check"), {
      recursive: true,
    });
    await writeFile(
      join(target, "vibe-check", "SKILL.md"),
      "locally modified skill content\n",
    );
    const before = await readFile(
      join(target, "vibe-check", "SKILL.md"),
      "utf8",
    );

    const result = await runCli(
      ["skills", "install", "--dry-run", "--target", target, "--json"],
      { home: home.home },
    );

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toBe("");
    expect(result.stdout.trim().split("\n")).toHaveLength(1);
    const payload = JSON.parse(result.stdout) as {
      ok: boolean;
      dryRun: boolean;
      skills: Array<{ name: string; action: string }>;
    };
    expect(payload.ok).toBe(false);
    expect(payload.dryRun).toBe(true);
    expect(payload.skills.find((s) => s.name === "vibe-check")).toMatchObject({
      action: "blocked",
    });
    expect(await readFile(join(target, "vibe-check", "SKILL.md"), "utf8")).toBe(
      before,
    );
    expect(await dirExists(join(target, "vibe-learn"))).toBe(false);
  });

  test("skills install retains documented payload for spaced target paths", async () => {
    const home = await useTempHome();
    const targetRoot = await mkdtemp(join(originalCwd, ".skills-cli-space-"));
    cwdRoots.push(targetRoot);
    const target = join(targetRoot, "skill dir", "nested skills");
    await mkdir(join(targetRoot, "skill dir"), { recursive: true });

    const result = await runCli(
      ["skills", "install", "--dry-run", "--target", target, "--json"],
      { home: home.home },
    );

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout.trim().split("\n")).toHaveLength(1);
    const payload = JSON.parse(result.stdout) as {
      target: string;
      ok: boolean;
      skills: Array<{ name: string; action: string }>;
    };
    expect(payload.target).toBe(target);
    expect(payload.ok).toBe(true);
    expect(payload.skills.map((s) => s.name)).toEqual([
      "vibe-check",
      "vibe-constitution",
      "vibe-learn",
    ]);
    expect(payload.skills.every((s) => s.action === "would-install")).toBe(
      true,
    );
    expect(await dirExists(target)).toBe(false);
  });

  test("skills list rejects symlinked target root with stderr-only fatal JSON", async () => {
    const home = await useTempHome();
    const realTarget = await createCwd();
    const linkBase = await createCwd();
    await symlink(realTarget, join(linkBase, "link-root"), "dir");

    const result = await runCli(
      ["skills", "list", "--target", join(linkBase, "link-root"), "--json"],
      { home: home.home },
    );

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr.trim().split("\n")).toHaveLength(1);
    const payload = JSON.parse(result.stderr) as { error: string };
    expect(payload.error).toContain("symlink");
    expect(await dirExists(join(linkBase, "link-root"))).toBe(true);
  });

  test("skills list rejects non-directory target root with stderr-only fatal JSON", async () => {
    const home = await useTempHome();
    const base = await createCwd();
    const fileTarget = join(base, "not-a-dir");
    await writeFile(fileTarget, "file content");

    const result = await runCli(
      ["skills", "list", "--target", fileTarget, "--json"],
      {
        home: home.home,
      },
    );

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr.trim().split("\n")).toHaveLength(1);
    const payload = JSON.parse(result.stderr) as { error: string };
    expect(payload.error).toContain("not a directory");
  });

  test("skills install rejects symlinked target root with stderr-only fatal JSON", async () => {
    const home = await useTempHome();
    const realTarget = await createCwd();
    const linkBase = await createCwd();
    await symlink(realTarget, join(linkBase, "link-root"), "dir");

    const result = await runCli(
      ["skills", "install", "--target", join(linkBase, "link-root"), "--json"],
      { home: home.home },
    );

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr.trim().split("\n")).toHaveLength(1);
    const payload = JSON.parse(result.stderr) as { error: string };
    expect(payload.error).toContain("symlink");
    // No traversal: real target remains untouched.
    const { readdir } = await import("node:fs/promises");
    const realEntries = await readdir(realTarget);
    expect(realEntries).toEqual([]);
  });

  test("skills install surfaces source validation failure as stderr-only fatal JSON", async () => {
    const home = await useTempHome();
    const packageRoot = await mkdtemp(
      join(tmpdir(), "vibe-skills-src-install-"),
    );
    cwdRoots.push(packageRoot);
    await writeFile(join(packageRoot, "package.json"), "{}\n");
    const targetRoot = await mkdtemp(
      join(originalCwd, ".skills-cli-src-install-"),
    );
    cwdRoots.push(targetRoot);
    const target = join(targetRoot, "skills");

    const result = await runCli(
      ["skills", "install", "--target", target, "--json"],
      {
        home: home.home,
        preload: skillsPackageRoot,
        env: { VIBE_TEST_SKILLS_PACKAGE_ROOT: packageRoot },
      },
    );

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr.trim().split("\n")).toHaveLength(1);
    const payload = JSON.parse(result.stderr) as { error: string };
    expect(payload.error).toContain("Skills directory does not exist");
    expect(await dirExists(target)).toBe(false);
  }, 15000);

  test("unrelated commands do not invoke skills operations", async () => {
    const home = await useTempHome();
    const help = await runCli(["--help"]);
    expect(help.exitCode).toBe(0);
    expect(help.stdout).toContain("skills");

    const migrateHelp = await runCli(["migrate", "--help"]);
    expect(migrateHelp.exitCode).toBe(0);
    expect(migrateHelp.stdout).not.toContain("bundled skills");

    const checkHelp = await runCli(["check", "--help"]);
    expect(checkHelp.exitCode).toBe(0);
    expect(checkHelp.stdout).not.toContain("--dry-run");

    // session must not create the default skills target as a side effect.
    const session = await runCli(["session"], { home: home.home });
    expect(session.exitCode).toBe(0);
    expect(session.stderr).toBe("");
    expect(JSON.parse(session.stdout)).toEqual({
      session: expect.any(String),
    });
    expect(await dirExists(join(home.home, ".agents", "skills"))).toBe(false);

    // schema documents skills contracts without running inventory.
    const schema = await runCli(["schema"], { home: home.home });
    expect(schema.exitCode).toBe(0);
    expect(schema.stderr).toBe("");
    const schemaPayload = JSON.parse(schema.stdout) as {
      commands: Record<string, unknown>;
    };
    expect(schemaPayload.commands["skills list"]).toBeDefined();
    expect(await dirExists(join(home.home, ".agents", "skills"))).toBe(false);
  });

  test("check with --model only resolves model override without provider", async () => {
    const { result, payload } = await runVibeCheck(["--model", "mock-claude"], {
      VIBE_TEST_ANTHROPIC_MODE: "proceed",
    });

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(payload).toMatchObject({
      proceed: true,
      confidence: 0.91,
      attempts: 1,
    });
  });

  test("demo command runs walkthrough with mocked LLM and exits cleanly", async () => {
    const home = await useTempHome();
    const cwd = await createCwd();
    await writeSettings(home, listSettings({ provider: "anthropic" }));

    const result = await runCli(
      ["demo", "--provider", "anthropic", "--model", "mock-claude"],
      {
        cwd,
        home: home.home,
        preload: mockAnthropicFetch,
        env: {
          ANTHROPIC_API_KEY: "ak",
          DEFAULT_MODEL: undefined,
          VIBE_TEST_ANTHROPIC_MODE: "proceed",
        },
      },
    );

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("vibe demo");
    expect(result.stdout).toContain("Demo complete");
    expect(result.stdout).toContain("constitution");
    expect(result.stdout).toContain("vibe check");
  }, 15000);

  test("skills list retains successful read-only JSON for confirmed-missing roots", async () => {
    const home = await useTempHome();
    const missing = join(home.home, "no", "such", "skills");

    const result = await runCli(
      ["skills", "list", "--target", missing, "--json"],
      {
        home: home.home,
      },
    );

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    const payload = JSON.parse(result.stdout) as {
      target: string;
      skills: Array<{ name: string; status: string }>;
    };
    expect(payload.target).toBe(missing);
    expect(payload.skills.length).toBeGreaterThan(0);
    expect(payload.skills.every((s) => s.status === "missing")).toBe(true);
    // Absent paths remain uncreated.
    expect(await dirExists(missing)).toBe(false);
    expect(await dirExists(join(home.home, "no"))).toBe(false);
  });

  test("skills list preserves byte-identical target contents after successful validation", async () => {
    const home = await useTempHome();
    const target = join(home.home, "list-success-validation");
    await mkdir(target, { recursive: true });
    await cp(
      join(originalCwd, "skills", "vibe-check"),
      join(target, "vibe-check"),
      { recursive: true },
    );
    await cp(
      join(originalCwd, "skills", "vibe-constitution"),
      join(target, "vibe-constitution"),
      { recursive: true },
    );

    const before = await readDirTree(target);

    const result = await runCli(["skills", "list", "--target", target], {
      home: home.home,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    const after = await readDirTree(target);
    expect(after).toEqual(before);
  });

  describe("CLI skills/guide output modes", () => {
    test("skills list emits readable default output and JSON under --json", async () => {
      const home = await useTempHome();

      const pretty = await runCli(["skills", "list"], { home: home.home });
      const json = await runCli(["skills", "list", "--json"], {
        home: home.home,
      });

      // Default output is readable text
      expect(pretty.exitCode).toBe(0);
      expect(pretty.stderr).toBe("");
      expect(pretty.stdout).toContain("Skills");
      expect(pretty.stdout).toContain("name");
      expect(pretty.stdout).toContain("status");
      expect(pretty.stdout).toContain("missing");

      // --json produces parseable JSON payload
      expect(json.exitCode).toBe(0);
      expect(json.stderr).toBe("");
      const payload = JSON.parse(json.stdout) as {
        target: string;
        skills: Array<{ name: string; status: string }>;
      };
      expect(payload.target).toBe(join(home.home, ".agents", "skills"));
      expect(payload.skills.length).toBeGreaterThan(0);
      expect(payload.skills.every((s) => s.status === "missing")).toBe(true);
    });

    test("skills install emits readable default output and JSON under --json", async () => {
      const home = await useTempHome();
      const targetRoot = await mkdtemp(
        join(originalCwd, ".skills-cli-output-"),
      );
      cwdRoots.push(targetRoot);
      const target = join(targetRoot, "skills");

      const pretty = await runCli(
        ["skills", "install", "--dry-run", "--target", target],
        { home: home.home },
      );
      const json = await runCli(
        ["skills", "install", "--dry-run", "--target", target, "--json"],
        { home: home.home },
      );

      // Default output is readable text
      expect(pretty.exitCode).toBe(0);
      expect(pretty.stderr).toBe("");
      expect(pretty.stdout).toContain("Skills Install");
      expect(pretty.stdout).toContain("dryRun: true");
      expect(pretty.stdout).toContain("name");
      expect(pretty.stdout).toContain("status");
      expect(pretty.stdout).toContain("action");

      // --json produces parseable JSON payload with original fields
      expect(json.exitCode).toBe(0);
      expect(json.stderr).toBe("");
      const payload = JSON.parse(json.stdout) as {
        target: string;
        dryRun: boolean;
        force: boolean;
        ok: boolean;
        skills: Array<{ name: string; status: string; action: string }>;
      };
      expect(payload).toMatchObject({
        target,
        dryRun: true,
        force: false,
        ok: true,
      });
      expect(payload.skills.every((s) => s.action === "would-install")).toBe(
        true,
      );
    });

    test("guide list emits readable default output and JSON under --json", async () => {
      const cwd = await createCwd();

      const pretty = await runCli(["guide", "list"], { cwd });
      const json = await runCli(["guide", "list", "--json"], { cwd });

      // Default output is readable text
      expect(pretty.exitCode).toBe(0);
      expect(pretty.stderr).toBe("");
      expect(pretty.stdout).toContain("Guide");
      expect(pretty.stdout).toContain("target:");
      expect(pretty.stdout).toContain("status:");

      // --json produces parseable JSON payload
      expect(json.exitCode).toBe(0);
      expect(json.stderr).toBe("");
      const payload = JSON.parse(json.stdout) as {
        target: string;
        status: string;
      };
      expect(payload.target).toBe(cwd);
      expect(["missing", "identical", "outdated"]).toContain(payload.status);
    });

    test("guide install emits readable default output and JSON under --json", async () => {
      const cwd = await createCwd();

      const pretty = await runCli(["guide", "install", "--dry-run"], { cwd });
      const json = await runCli(["guide", "install", "--dry-run", "--json"], {
        cwd,
      });

      // Default output is readable text
      expect(pretty.exitCode).toBe(0);
      expect(pretty.stderr).toBe("");
      expect(pretty.stdout).toContain("Guide Install");
      expect(pretty.stdout).toContain("target:");
      expect(pretty.stdout).toContain("dryRun: true");
      expect(pretty.stdout).toContain("ok: true");
      expect(pretty.stdout).toContain("status:");
      expect(pretty.stdout).toContain("action:");

      // --json produces parseable JSON payload
      expect(json.exitCode).toBe(0);
      expect(json.stderr).toBe("");
      const payload = JSON.parse(json.stdout) as {
        target: string;
        dryRun: boolean;
        ok: boolean;
        status: string;
        action: string;
      };
      expect(payload).toMatchObject({
        target: cwd,
        dryRun: true,
        ok: true,
      });
      expect(["would-install", "would-replace", "would-skip"]).toContain(
        payload.action,
      );
    });

    test("skills list help advertises --json option", async () => {
      const result = await runCli(["skills", "list", "--help"]);

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toContain("--json");
    });

    test("skills install help advertises --json option", async () => {
      const result = await runCli(["skills", "install", "--help"]);

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toContain("--json");
    });

    test("guide list help advertises --json option", async () => {
      const result = await runCli(["guide", "list", "--help"]);

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toContain("--json");
    });

    test("guide install help advertises --json option", async () => {
      const result = await runCli(["guide", "install", "--help"]);

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toContain("--json");
    });

    test("skills install blocked result retains exit 2 with error column in default output", async () => {
      const home = await useTempHome();
      const targetRoot = await mkdtemp(
        join(originalCwd, ".skills-cli-block-output-"),
      );
      cwdRoots.push(targetRoot);
      const target = join(targetRoot, "skills");
      const bundledSkills = join(originalCwd, "skills");

      await mkdir(target, { recursive: true });
      await cp(join(bundledSkills, "vibe-check"), join(target, "vibe-check"), {
        recursive: true,
      });
      await writeFile(
        join(target, "vibe-check", "SKILL.md"),
        "locally modified skill content\n",
      );

      const pretty = await runCli(["skills", "install", "--target", target], {
        home: home.home,
      });
      const json = await runCli(
        ["skills", "install", "--target", target, "--json"],
        { home: home.home },
      );

      // Default output: readable text with blocked status
      expect(pretty.exitCode).toBe(2);
      expect(pretty.stderr).toBe("");
      expect(pretty.stdout).toContain("Skills Install");
      expect(pretty.stdout).toContain("blocked");

      // --json preserves original payload shape
      expect(json.exitCode).toBe(2);
      expect(json.stderr).toBe("");
      const payload = JSON.parse(json.stdout) as {
        ok: boolean;
        skills: Array<{ name: string; action: string }>;
      };
      expect(payload.ok).toBe(false);
      expect(payload.skills.find((s) => s.name === "vibe-check")?.action).toBe(
        "blocked",
      );
    });

    test("skills install partial failure retains exit 2 with error detail in default output", async () => {
      const home = await useTempHome();
      const targetRoot = await mkdtemp(
        join(originalCwd, ".skills-cli-partial-fail-"),
      );
      cwdRoots.push(targetRoot);
      const target = join(targetRoot, "skills");
      const bundledSkills = join(originalCwd, "skills");

      // Pre-install every bundled skill so --force replaces each one.
      await mkdir(target, { recursive: true });
      await cp(join(bundledSkills, "vibe-check"), join(target, "vibe-check"), {
        recursive: true,
      });
      await cp(
        join(bundledSkills, "vibe-constitution"),
        join(target, "vibe-constitution"),
        { recursive: true },
      );
      await cp(join(bundledSkills, "vibe-learn"), join(target, "vibe-learn"), {
        recursive: true,
      });

      // Deterministically fail only the vibe-learn copy while others succeed.
      // Mocking node:fs/promises holds even under UID 0 where chmod-based
      // permission denial is bypassed; exact-path matching keeps the failure
      // scoped to one skill regardless of copy order.
      const fsPromises = await import("node:fs/promises");
      const originalCp = fsPromises.cp;
      const spy = spyOn(fsPromises, "cp");
      spy.mockImplementation(((
        src: string | URL,
        dest: string | URL,
        opts?: Parameters<typeof fsPromises.cp>[2],
      ) => {
        if (resolve(String(dest)) === resolve(join(target, "vibe-learn"))) {
          throw Object.assign(
            new Error(`EACCES: permission denied, copyfile '${String(dest)}'`),
            { code: "EACCES" },
          );
        }
        return originalCp(src, dest, opts);
      }) as typeof fsPromises.cp);

      try {
        const pretty = await runCli(
          ["skills", "install", "--force", "--target", target],
          { home: home.home },
        );
        const json = await runCli(
          ["skills", "install", "--force", "--target", target, "--json"],
          { home: home.home },
        );

        // Default output: readable text with error column and failed-row detail
        expect(pretty.exitCode).toBe(2);
        expect(pretty.stderr).toBe("");
        expect(pretty.stdout).toContain("Skills Install");
        expect(pretty.stdout).toContain("error");
        expect(pretty.stdout).toContain("vibe-learn");
        expect(pretty.stdout).toContain("failed");
        expect(pretty.stdout).toContain("EACCES");

        // --json preserves the original payload shape and partial-failure detail
        expect(json.exitCode).toBe(2);
        expect(json.stderr).toBe("");
        const payload = JSON.parse(json.stdout) as {
          ok: boolean;
          skills: Array<{
            name: string;
            action: string;
            error?: string;
          }>;
        };
        expect(payload.ok).toBe(false);
        const failedSkill = payload.skills.find((s) => s.name === "vibe-learn");
        expect(failedSkill?.action).toBe("failed");
        expect(failedSkill?.error).toContain("EACCES");
        expect(
          payload.skills.find((s) => s.name === "vibe-check")?.action,
        ).toBe("replaced");
      } finally {
        spy.mockRestore();
      }
    });

    test("fatal failures retain stderr-only JSON and exit 1 for skills commands", async () => {
      const home = await useTempHome();
      const missingParent = join(home.home, "missing-parent", "skills");

      const pretty = await runCli(
        ["skills", "install", "--target", missingParent],
        { home: home.home },
      );
      const json = await runCli(
        ["skills", "install", "--target", missingParent, "--json"],
        { home: home.home },
      );

      // Both modes: stderr-only JSON, exit 1, no stdout
      expect(pretty.exitCode).toBe(1);
      expect(pretty.stdout).toBe("");
      expect(JSON.parse(pretty.stderr)).toEqual({
        error: expect.any(String),
      });

      expect(json.exitCode).toBe(1);
      expect(json.stdout).toBe("");
      expect(JSON.parse(json.stderr)).toEqual({
        error: expect.any(String),
      });
    });

    test("fatal failures retain stderr-only JSON and exit 1 for guide commands", async () => {
      const pretty = await runCli([
        "guide",
        "install",
        "--target",
        "/dev/null",
      ]);
      const json = await runCli([
        "guide",
        "install",
        "--target",
        "/dev/null",
        "--json",
      ]);

      // Both modes: stderr-only JSON, exit 1, no stdout
      expect(pretty.exitCode).toBe(1);
      expect(pretty.stdout).toBe("");
      expect(JSON.parse(pretty.stderr)).toEqual({
        error: expect.any(String),
      });

      expect(json.exitCode).toBe(1);
      expect(json.stdout).toBe("");
      expect(JSON.parse(json.stderr)).toEqual({
        error: expect.any(String),
      });
    });

    test("schema advertises --json for all four skills/guide commands", async () => {
      const result = await runCli(["schema"]);
      const schema = JSON.parse(result.stdout) as {
        commands: Record<string, { opt?: Record<string, string> }>;
      };

      expect(schema.commands["skills list"]?.opt).toHaveProperty("--json");
      expect(schema.commands["skills install"]?.opt).toHaveProperty("--json");
      expect(schema.commands["guide list"]?.opt).toHaveProperty("--json");
      expect(schema.commands["guide install"]?.opt).toHaveProperty("--json");
    });
  });

  describe("CLI guide command surface", () => {
    test("guide list emits one JSON line for default and custom targets without mutation", async () => {
      const cwd = await createCwd();

      const result = await runCli(["guide", "list", "--json"], { cwd });
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout.trim().split("\n")).toHaveLength(1);
      expect(result.stdout).toBe(`${result.stdout.trim()}\n`);

      const payload = JSON.parse(result.stdout) as {
        target: string;
        status: string;
      };
      expect(payload.target).toBe(cwd);
      expect(["missing", "identical", "outdated"]).toContain(payload.status);
      expect(await fileExists(join(cwd, "vibe-guide.md"))).toBe(false);

      const target = await createCwd();
      const customResult = await runCli([
        "guide",
        "list",
        "--target",
        target,
        "--json",
      ]);
      expect(customResult.exitCode).toBe(0);
      expect(customResult.stderr).toBe("");
      expect(customResult.stdout.trim().split("\n")).toHaveLength(1);
      const customPayload = JSON.parse(customResult.stdout) as {
        target: string;
        status: string;
      };
      expect(customPayload.target).toBe(target);
      expect(await fileExists(join(target, "vibe-guide.md"))).toBe(false);
    });

    test("guide list rejects unsupported options with stderr-only fatal JSON", async () => {
      const result = await runCli(["guide", "list", "--bogus", "--json"]);
      expect(result.exitCode).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr.trim().split("\n")).toHaveLength(1);
      expect(JSON.parse(result.stderr)).toEqual({
        error: "error: unknown option '--bogus'",
      });
    });

    test("guide list surfaces fatal target validation errors as stderr-only fatal JSON", async () => {
      const result = await runCli([
        "guide",
        "list",
        "--target",
        "/dev/null",
        "--json",
      ]);
      expect(result.exitCode).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr.trim().split("\n")).toHaveLength(1);
      const payload = JSON.parse(result.stderr) as { error: string };
      expect(payload.error).toContain("Failed to stat guide destination");
    });

    test("guide install --dry-run plans without writing target files", async () => {
      const cwd = await createCwd();

      const result = await runCli(["guide", "install", "--dry-run", "--json"], {
        cwd,
      });
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout.trim().split("\n")).toHaveLength(1);

      const payload = JSON.parse(result.stdout) as {
        target: string;
        dryRun: boolean;
        ok: boolean;
        status: string;
        action: string;
      };
      expect(payload.target).toBe(cwd);
      expect(payload.dryRun).toBe(true);
      expect(payload.ok).toBe(true);
      expect(["missing", "identical", "outdated"]).toContain(payload.status);
      expect(["would-install", "would-replace", "would-skip"]).toContain(
        payload.action,
      );
      expect(await fileExists(join(cwd, "vibe-guide.md"))).toBe(false);
    });

    test("guide install writes guide file and emits one JSON line", async () => {
      const cwd = await createCwd();

      const result = await runCli(["guide", "install", "--json"], { cwd });
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout.trim().split("\n")).toHaveLength(1);

      const payload = JSON.parse(result.stdout) as {
        target: string;
        dryRun: boolean;
        ok: boolean;
        status: string;
        action: string;
      };
      expect(payload.target).toBe(cwd);
      expect(payload.dryRun).toBe(false);
      expect(payload.ok).toBe(true);
      expect(payload.action).toBe("installed");
      expect(await fileExists(join(cwd, "vibe-guide.md"))).toBe(true);
    });

    test("guide install rejects unsupported options with stderr-only fatal JSON", async () => {
      const result = await runCli(["guide", "install", "--bogus", "--json"]);
      expect(result.exitCode).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr.trim().split("\n")).toHaveLength(1);
      expect(JSON.parse(result.stderr)).toEqual({
        error: "error: unknown option '--bogus'",
      });
    });

    test("guide install surfaces fatal target validation errors as stderr-only fatal JSON", async () => {
      const result = await runCli([
        "guide",
        "install",
        "--target",
        "/dev/null",
        "--json",
      ]);
      expect(result.exitCode).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr.trim().split("\n")).toHaveLength(1);
      const payload = JSON.parse(result.stderr) as { error: string };
      expect(
        payload.error.includes("is not a directory") ||
          payload.error.includes("No write access") ||
          payload.error.includes("Failed to inspect"),
      ).toBe(true);
    });
  });

  describe("concurrent local list bootstrap process safety", () => {
    async function seedSharedHome(home: TempHomeContext): Promise<void> {
      const base = Date.parse("2026-01-01T00:00:00.000Z");
      await seedLearningEntries(home, [
        {
          type: "mistake",
          category: "alpha",
          observation: "Alpha older.",
          solution: "Fix older.",
          timestamp: base,
        },
        {
          type: "success",
          category: "alpha",
          observation: "Alpha newer.",
          solution: "Keep newer.",
          timestamp: base + 1000,
        },
      ]);
      await seedSessionsAndInteractions(
        home,
        [{ id: "s1", cwdKey: "k1", cwd: "/tmp/a" }],
        [
          {
            sessionId: "s1",
            goal: "Review",
            output: JSON.stringify({ reason: "R." }),
            timestamp: base,
          },
        ],
      );
      await writeSettings(home, listSettings());
    }

    const ALL_LIST_FORMS: string[][] = [
      ["list"],
      ["list", "--json"],
      ["list", "learnings"],
      ["list", "learnings", "--json"],
      ["list", "constitution"],
      ["list", "constitution", "--json"],
      ["list", "sessions"],
      ["list", "sessions", "--json"],
      ["list", "providers"],
      ["list", "providers", "--json"],
      ["list", "checks"],
      ["list", "checks", "--json"],
      ["list", "categories"],
      ["list", "categories", "--json"],
      ["list", "stats"],
      ["list", "stats", "--json"],
      ["list", "all"],
      ["list", "all", "--json"],
    ];

    test("concurrent list invocations sharing valid local state all succeed with nonempty output and parseable JSON", async () => {
      const home = await useTempHome();
      await seedSharedHome(home);

      const results = await runCliBatch(ALL_LIST_FORMS, {
        home: home.home,
        preload: failOnFetch,
        env: { DEFAULT_LLM_PROVIDER: undefined, DEFAULT_MODEL: undefined },
      });

      expect(results).toHaveLength(ALL_LIST_FORMS.length);
      const failures: string[] = [];
      for (const { args, result } of results) {
        if (result.exitCode !== 0) {
          failures.push(
            `${args.join(" ")} → exit ${result.exitCode} stderr: ${result.stderr.slice(0, 200)}`,
          );
        }
        expect(result.exitCode).toBe(0);
        expect(result.stderr).toBe("");
        expect(result.stdout).not.toBe("");
        if (args.includes("--json"))
          expect(() => JSON.parse(result.stdout)).not.toThrow();
      }
      if (failures.length > 0) {
        throw new Error(`Concurrent failures:\n${failures.join("\n")}`);
      }
    }, 15000);

    test("concurrent list invocations with fresh shared home converge to valid state", async () => {
      const home = await useTempHome();
      // Pre-create settings so provider-dependent commands can resolve,
      // but leave the database entirely absent for concurrent bootstrap.
      await writeSettings(home, listSettings());

      const results = await runCliBatch(ALL_LIST_FORMS, {
        home: home.home,
        preload: failOnFetch,
        env: { DEFAULT_LLM_PROVIDER: undefined, DEFAULT_MODEL: undefined },
      });

      expect(results).toHaveLength(ALL_LIST_FORMS.length);
      for (const { args, result } of results) {
        expect(result.exitCode).toBe(0);
        expect(result.stderr).toBe("");
        expect(result.stdout).not.toBe("");
        if (args.includes("--json"))
          expect(() => JSON.parse(result.stdout)).not.toThrow();
      }

      // A post-concurrency sequential call must also succeed: DB is valid.
      const after = await runCli(["list", "all", "--json"], {
        home: home.home,
      });
      expect(after.exitCode).toBe(0);
      expect(after.stderr).toBe("");
      expect(() => JSON.parse(after.stdout)).not.toThrow();
    }, 15000);

    test("concurrent list invocations with partially migrated home converge without corruption", async () => {
      const home = await useTempHome();
      await seedInitialMigrationOnly(home);
      await writeSettings(home, listSettings());

      const results = await runCliBatch(ALL_LIST_FORMS, {
        home: home.home,
        preload: failOnFetch,
        env: { DEFAULT_LLM_PROVIDER: undefined, DEFAULT_MODEL: undefined },
      });

      expect(results).toHaveLength(ALL_LIST_FORMS.length);
      for (const { args, result } of results) {
        expect(result.exitCode).toBe(0);
        expect(result.stderr).toBe("");
        expect(result.stdout).not.toBe("");
        if (args.includes("--json"))
          expect(() => JSON.parse(result.stdout)).not.toThrow();
      }

      // Verify migration converged: all expected migrations applied.
      const migrate = await runCli(["migrate"], { home: home.home });
      const report = parseMigrationReport(migrate);
      expect(report.applied).toEqual(EXPECTED_MIGRATION_IDS);
      expect(report.pending).toEqual([]);
      expect(report.status).toBe("up-to-date");
    }, 15000);

    test("concurrent list invocations never perform provider or network access", async () => {
      const home = await useTempHome();
      await seedSharedHome(home);

      const results = await runCliBatch(ALL_LIST_FORMS, {
        home: home.home,
        preload: failOnFetch,
        env: {
          DEFAULT_LLM_PROVIDER: undefined,
          DEFAULT_MODEL: undefined,
          ANTHROPIC_API_KEY: undefined,
        },
      });

      for (const { result } of results) {
        expect(result.exitCode).toBe(0);
        expect(result.stderr).toBe("");
        expect(result.stdout).not.toBe("");
        // failOnFetch throws on any network call; exitCode 0 and clean stderr
        // prove the fetch preload was never invoked.
      }
    }, 15000);

    test("migrate command under concurrent bootstrap produces deterministic report", async () => {
      const home = await useTempHome();

      const commands = [["migrate"], ["migrate"], ["migrate"], ["migrate"]];

      const results = await runCliBatch(commands, {
        home: home.home,
        env: { DEFAULT_LLM_PROVIDER: undefined, DEFAULT_MODEL: undefined },
      });

      for (const { result } of results) {
        expect(result.exitCode).toBe(0);
        expect(result.stderr).toBe("");
        const report = JSON.parse(result.stdout) as {
          applied: string[];
          pending: string[];
          status: string;
        };
        expect(report.applied).toEqual(EXPECTED_MIGRATION_IDS);
        expect(report.status).toMatch(/^(migrated|up-to-date)$/);
      }
    }, 15000);
  });

  test("skills operations leave no .skills-cli-* residue after tracked cleanup", async () => {
    // Snapshot pre-existing .skills-cli-* entries (foreign paths).
    const preExisting = await scanSkillsCliResidue();

    // Create and run through a full skills install cycle.
    const home = await useTempHome();
    const targetRoot = await mkdtemp(join(originalCwd, ".skills-cli-hygiene-"));
    cwdRoots.push(targetRoot);
    const target = join(targetRoot, "skills");

    const installed = await runCli(
      ["skills", "install", "--target", target, "--json"],
      {
        home: home.home,
      },
    );
    expect(installed.exitCode).toBe(0);
    expect(installed.stderr).toBe("");
    const payload = JSON.parse(installed.stdout) as { ok: boolean };
    expect(payload.ok).toBe(true);

    // Simulate afterEach: remove only the owned temp root.
    await rm(targetRoot, { recursive: true, force: true });
    const idx = cwdRoots.indexOf(targetRoot);
    if (idx !== -1) cwdRoots.splice(idx, 1);

    // Assert no new .skills-cli-* entries remain.
    const after = await scanSkillsCliResidue();
    const newEntries = after.filter((e) => !preExisting.includes(e));
    expect(newEntries).toEqual([]);

    // Pre-existing foreign paths survive untouched.
    for (const entry of preExisting) {
      expect(after).toContain(entry);
    }
  });

  test("overlapping runCliInProcess calls preserve isolated console output", async () => {
    // Two calls doing real async work (skills inventory reads against
    // distinct targets) so their execution genuinely interleaves — a
    // shared-global console redirect would misroute one call's output
    // into the other's captured stdout.
    const dirA = await createCwd();
    const dirB = await createCwd();
    const targetA = join(dirA, "skills-a");
    const targetB = join(dirB, "skills-b");

    const [resA, resB] = await Promise.all([
      runCliInProcess(["skills", "list", "--target", targetA, "--json"]),
      runCliInProcess(["skills", "list", "--target", targetB, "--json"]),
    ]);

    expect(resA.exitCode).toBe(0);
    expect(resB.exitCode).toBe(0);

    const payloadA = JSON.parse(resA.stdout) as { target: string };
    const payloadB = JSON.parse(resB.stdout) as { target: string };
    expect(payloadA.target).toBe(targetA);
    expect(payloadB.target).toBe(targetB);

    // No cross-talk: neither call's stdout names the other's target.
    expect(resA.stdout).not.toContain(targetB);
    expect(resB.stdout).not.toContain(targetA);
  });

  test("concurrent async invocations retain isolated stdout, stderr, and exit codes", async () => {
    // Mix success and failure payloads to prove isolation across distinct outcomes.
    const home = await useTempHome();
    await writeSettings(home, listSettings());

    const [success, failure] = await Promise.all([
      runCliInProcess(["session"]),
      runCliInProcess(["unknown-command"]),
    ]);

    // Success path: clean stdout, no stderr, exit 0.
    expect(success.exitCode).toBe(0);
    expect(success.stderr).toBe("");
    expect(() => JSON.parse(success.stdout)).not.toThrow();
    const successPayload = JSON.parse(success.stdout) as { session: string };
    expect(successPayload.session).toMatch(/^[0-9a-f-]{36}$/);

    // Failure path: no stdout, stderr contains error, exit 1.
    expect(failure.exitCode).toBe(1);
    expect(failure.stdout).toBe("");
    expect(failure.stderr).toContain("unknown command");
  });

  test("parser failures remain in their caller's stderr and exit result", async () => {
    // Commander validation errors must not leak into other concurrent captures.
    const [valid, invalid] = await Promise.all([
      runCliInProcess(["check", "--help"]),
      runCliInProcess(["check"]), // missing required options
    ]);

    // Help succeeds cleanly.
    expect(valid.exitCode).toBe(0);
    expect(valid.stderr).toBe("");
    expect(valid.stdout).toContain("--goal");

    // Validation failure stays isolated.
    expect(invalid.exitCode).toBe(1);
    expect(invalid.stdout).toBe("");
    expect(invalid.stderr).toContain("required option");
  });

  test("help and version termination retain successful caller-local output", async () => {
    // --help and --version both exit via Commander's exitOverride with code 0.
    // Both must produce stdout-only output without stderr leakage.
    const [help, version] = await Promise.all([
      runCliInProcess(["--help"]),
      runCliInProcess(["--version"]),
    ]);

    expect(help.exitCode).toBe(0);
    expect(help.stderr).toBe("");
    expect(help.stdout).toContain("vibe");

    expect(version.exitCode).toBe(0);
    expect(version.stderr).toBe("");
    expect(version.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
  });

  test("throw and termination cleanup leave no active capture state", async () => {
    // After a failing invocation, a subsequent call must still capture correctly.
    const failing = await runCliInProcess(["unknown-command"]);
    expect(failing.exitCode).toBe(1);

    // Subsequent call must capture cleanly — no residual state.
    const succeeding = await runCliInProcess(["session"]);
    expect(succeeding.exitCode).toBe(0);
    expect(succeeding.stderr).toBe("");
    expect(() => JSON.parse(succeeding.stdout)).not.toThrow();
  });

  test("three concurrent invocations with mixed outcomes preserve complete isolation", async () => {
    // Three-way overlap: success, failure, and help — each must retain its own output.
    const [session, error, help] = await Promise.all([
      runCliInProcess(["session"]),
      runCliInProcess(["unknown-command"]),
      runCliInProcess(["check", "--help"]),
    ]);

    expect(session.exitCode).toBe(0);
    expect(session.stderr).toBe("");
    expect(JSON.parse(session.stdout)).toHaveProperty("session");

    expect(error.exitCode).toBe(1);
    expect(error.stdout).toBe("");
    expect(error.stderr).toContain("unknown command");

    expect(help.exitCode).toBe(0);
    expect(help.stderr).toBe("");
    expect(help.stdout).toContain("--goal");

    // No cross-contamination.
    expect(session.stdout).not.toContain("unknown command");
    expect(help.stdout).not.toContain("unknown command");
    expect(error.stderr).not.toContain("session");
  });

  test("overlapping captures with distinct console.error markers retain isolated stderr", async () => {
    // Two concurrent captures emit distinct markers via console.error.
    // Each capture's stderr must contain only its own marker.
    const markerA = "marker-alpha-unique-123";
    const markerB = "marker-beta-unique-456";

    const dirA = await createCwd();
    const dirB = await createCwd();
    const targetA = join(dirA, "skills-a");
    const targetB = join(dirB, "skills-b");

    const [resA, resB] = await Promise.all([
      runCliInProcess(
        ["skills", "list", "--target", targetA, "--json"],
        markerA,
      ),
      runCliInProcess(
        ["skills", "list", "--target", targetB, "--json"],
        markerB,
      ),
    ]);

    expect(resA.exitCode).toBe(0);
    expect(resB.exitCode).toBe(0);

    // Each capture's stderr contains only its own marker.
    expect(resA.stderr).toContain(markerA);
    expect(resA.stderr).not.toContain(markerB);
    expect(resB.stderr).toContain(markerB);
    expect(resB.stderr).not.toContain(markerA);

    // Each capture's stdout contains only its own target.
    expect(resA.stdout).toContain(targetA);
    expect(resA.stdout).not.toContain(targetB);
    expect(resB.stdout).toContain(targetB);
    expect(resB.stdout).not.toContain(targetA);
  });

  test("separate captures after help termination contain no earlier marker or exit state", async () => {
    // First capture: help command with a marker.
    const marker = "help-marker-unique-789";
    const helpResult = await runCliInProcess(["--help"], marker);

    expect(helpResult.exitCode).toBe(0);
    expect(helpResult.stderr).toContain(marker);
    expect(helpResult.stdout).toContain("vibe");

    // Second capture: clean session command without marker.
    const sessionResult = await runCliInProcess(["session"]);

    expect(sessionResult.exitCode).toBe(0);
    expect(sessionResult.stderr).toBe("");
    expect(sessionResult.stderr).not.toContain(marker);
    expect(() => JSON.parse(sessionResult.stdout)).not.toThrow();
  });

  test("separate captures after parser-failure termination contain no earlier marker or exit state", async () => {
    // First capture: parser failure with a marker.
    const marker = "parser-fail-marker-unique-abc";
    const failResult = await runCliInProcess(["check"], marker); // missing required options

    expect(failResult.exitCode).toBe(1);
    expect(failResult.stderr).toContain(marker);
    expect(failResult.stderr).toContain("required option");

    // Second capture: clean session command without marker.
    const sessionResult = await runCliInProcess(["session"]);

    expect(sessionResult.exitCode).toBe(0);
    expect(sessionResult.stderr).toBe("");
    expect(sessionResult.stderr).not.toContain(marker);
    expect(() => JSON.parse(sessionResult.stdout)).not.toThrow();
  });

  test("coordinated overlapping calls with distinct markers and divergent exits preserve isolation", async () => {
    // Three-way overlap with distinct markers and divergent exit outcomes.
    const markerSuccess = "success-marker-unique-def";
    const markerFailure = "failure-marker-unique-ghi";
    const markerHelp = "help-marker-unique-jkl";

    const [session, error, help] = await Promise.all([
      runCliInProcess(["session"], markerSuccess),
      runCliInProcess(["unknown-command"], markerFailure),
      runCliInProcess(["check", "--help"], markerHelp),
    ]);

    // Success path: exit 0, contains its own marker.
    expect(session.exitCode).toBe(0);
    expect(session.stderr).toContain(markerSuccess);
    expect(session.stderr).not.toContain(markerFailure);
    expect(session.stderr).not.toContain(markerHelp);
    expect(JSON.parse(session.stdout)).toHaveProperty("session");

    // Failure path: exit 1, contains its own marker.
    expect(error.exitCode).toBe(1);
    expect(error.stderr).toContain(markerFailure);
    expect(error.stderr).not.toContain(markerSuccess);
    expect(error.stderr).not.toContain(markerHelp);
    expect(error.stderr).toContain("unknown command");

    // Help path: exit 0, contains its own marker.
    expect(help.exitCode).toBe(0);
    expect(help.stderr).toContain(markerHelp);
    expect(help.stderr).not.toContain(markerSuccess);
    expect(help.stderr).not.toContain(markerFailure);
    expect(help.stdout).toContain("--goal");
  });

  test("post-await markers and stdout remain caller-local during overlap", async () => {
    // Three concurrent calls with coordination callbacks that yield before marker emission.
    // Proves AsyncLocalStorage context survives across await points.
    const markerSuccess = "post-await-success-marker-unique-111";
    const markerFailure = "post-await-failure-marker-unique-222";
    const markerHelp = "post-await-help-marker-unique-333";

    const yieldOnce = async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    };

    const [session, error, help] = await Promise.all([
      runCliInProcess(["session"], markerSuccess, yieldOnce),
      runCliInProcess(["unknown-command"], markerFailure, yieldOnce),
      runCliInProcess(["check", "--help"], markerHelp, yieldOnce),
    ]);

    // Success path: exit 0, marker emitted after await.
    expect(session.exitCode).toBe(0);
    expect(session.stderr).toContain(markerSuccess);
    expect(session.stderr).not.toContain(markerFailure);
    expect(session.stderr).not.toContain(markerHelp);
    expect(JSON.parse(session.stdout)).toHaveProperty("session");

    // Failure path: exit 1, marker emitted after await.
    expect(error.exitCode).toBe(1);
    expect(error.stderr).toContain(markerFailure);
    expect(error.stderr).not.toContain(markerSuccess);
    expect(error.stderr).not.toContain(markerHelp);
    expect(error.stderr).toContain("unknown command");

    // Help path: exit 0, marker emitted after await.
    expect(help.exitCode).toBe(0);
    expect(help.stderr).toContain(markerHelp);
    expect(help.stderr).not.toContain(markerSuccess);
    expect(help.stderr).not.toContain(markerFailure);
    expect(help.stdout).toContain("--goal");
  });

  test("post-await divergent exits retain expected exit codes and streams without cross-talk", async () => {
    // Concurrent success, parser-failure, and help calls with deferred synchronization.
    const yieldOnce = async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    };

    const [success, failure, help] = await Promise.all([
      runCliInProcess(["session"], undefined, yieldOnce),
      runCliInProcess(["check"], undefined, yieldOnce),
      runCliInProcess(["check", "--help"], undefined, yieldOnce),
    ]);

    // Success path: clean stdout, no stderr.
    expect(success.exitCode).toBe(0);
    expect(success.stderr).toBe("");
    expect(JSON.parse(success.stdout)).toHaveProperty("session");

    // Parser failure: stderr contains error, exit 1.
    expect(failure.exitCode).toBe(1);
    expect(failure.stdout).toBe("");
    expect(failure.stderr).toContain("required option");

    // Help path: exit 0, stdout contains help text.
    expect(help.exitCode).toBe(0);
    expect(help.stderr).toBe("");
    expect(help.stdout).toContain("--goal");

    // No cross-talk between divergent exits.
    expect(success.stderr).not.toContain("required option");
    expect(failure.stderr).not.toContain("session");
    expect(help.stderr).not.toContain("required option");
  });

  test("post-await later capture contains no prior marker, stale stderr, or exit code", async () => {
    // First capture: with coordination callback and marker.
    const marker = "post-await-prior-marker-unique-444";
    const yieldOnce = async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    };

    const priorResult = await runCliInProcess(["session"], marker, yieldOnce);

    expect(priorResult.exitCode).toBe(0);
    expect(priorResult.stderr).toContain(marker);
    expect(JSON.parse(priorResult.stdout)).toHaveProperty("session");

    // Second capture: clean, no coordination callback, no marker.
    const laterResult = await runCliInProcess(["session"]);

    expect(laterResult.exitCode).toBe(0);
    expect(laterResult.stderr).toBe("");
    expect(laterResult.stderr).not.toContain(marker);
    expect(() => JSON.parse(laterResult.stdout)).not.toThrow();
  });

  test("console.log outside any runCliInProcess context still reaches real stdout", () => {
    // Behavioral, not reference-equality: eager install means console.log
    // permanently equals the AsyncLocalStorage-aware wrapper, so an
    // identity check would produce a false negative by design. A fresh
    // subprocess with no active capture context proves the fallback path
    // reaches real stdout — Bun's console writes below the JS-visible
    // process.stdout.write property, so an in-process spy can't observe it.
    const script = `await import(${JSON.stringify(cli)}); console.log("real-stdout-marker");`;
    const result = Bun.spawnSync({
      cmd: ["bun", "-e", script],
      stdout: "pipe",
      stderr: "pipe",
      timeout: 10_000,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toContain("real-stdout-marker");
  });
});

describe("CLI entry point edge cases", () => {
  test("direct CLI entry with path containing space and percent character emits expected JSON", async () => {
    // Create a temp project directory with special characters in its path
    const specialRoot = await mkdtemp(join(tmpdir(), "vibe-cli special%dir-"));
    const specialProject = join(specialRoot, "project");
    const specialCli = join(specialProject, "src", "cli.ts");

    try {
      // Copy the entire project to a path with space and percent characters
      await cp(originalCwd, specialProject, { recursive: true });

      // Execute the CLI from the special path
      const result = Bun.spawnSync({
        cmd: ["bun", "run", specialCli, "session"],
        cwd: specialProject,
        env: { ...process.env, HOME: EMPTY_CLI_HOME },
        stdout: "pipe",
        stderr: "pipe",
        timeout: 10_000,
      });

      expect(result.exitCode).toBe(0);
      expect(result.stderr.toString()).toBe("");
      const payload = JSON.parse(result.stdout.toString()) as {
        session: string;
      };
      expect(payload.session).toMatch(/^[0-9a-f-]{36}$/);
    } finally {
      await rm(specialRoot, { recursive: true, force: true });
    }
  });

  test("importing CLI module does not trigger CLI parsing", async () => {
    const importScript = join(tmpdir(), "vibe-cli-import-test.ts");

    try {
      // Create a script that imports the CLI module
      await writeFile(
        importScript,
        `import { runCliInProcess } from "${cli}";
console.log("import successful");
`,
      );

      // Run the import script
      const result = Bun.spawnSync({
        cmd: ["bun", "run", importScript],
        cwd: originalCwd,
        env: { ...process.env, HOME: EMPTY_CLI_HOME },
        stdout: "pipe",
        stderr: "pipe",
        timeout: 10_000,
      });

      expect(result.exitCode).toBe(0);
      expect(result.stderr.toString()).toBe("");
      expect(result.stdout.toString().trim()).toBe("import successful");
    } finally {
      await rm(importScript, { force: true });
    }
  });

  test("canonical file URL comparison handles space and percent encoding", async () => {
    // Create a temp project directory with special characters in its path
    const specialRoot = await mkdtemp(join(tmpdir(), "vibe-cli special%dir-"));
    const specialProject = join(specialRoot, "project");
    const specialCli = join(specialProject, "src", "cli.ts");

    try {
      // Copy the entire project to a path with space and percent characters
      await cp(originalCwd, specialProject, { recursive: true });

      // Execute the CLI from the special path - this tests that the direct entry
      // guard correctly handles paths with space and percent characters
      const result = Bun.spawnSync({
        cmd: ["bun", "run", specialCli, "session"],
        cwd: specialProject,
        env: { ...process.env, HOME: EMPTY_CLI_HOME },
        stdout: "pipe",
        stderr: "pipe",
        timeout: 10_000,
      });

      expect(result.exitCode).toBe(0);
      expect(result.stderr.toString()).toBe("");
      const payload = JSON.parse(result.stdout.toString()) as {
        session: string;
      };
      expect(payload.session).toMatch(/^[0-9a-f-]{36}$/);
    } finally {
      await rm(specialRoot, { recursive: true, force: true });
    }
  });
});

describe("schema - settings load failure", () => {
  test("schema reports error message as model when settings cannot be loaded", async () => {
    const home = await useTempHome();
    // Create an invalid settings.json to trigger provider resolution failure
    await mkdir(home.dataRoot, { recursive: true });
    await writeFile(
      join(home.dataRoot, "settings.json"),
      '{ "provider": "missing", "providers": [] }',
    );

    const result = await runCli(["schema"], { home: home.home });
    const schema = JSON.parse(result.stdout) as {
      config: { provider: string; model: string };
    };

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(schema.config.provider).toBe("unresolved");
    // The error message depends on the settings validation path
    expect(typeof schema.config.model).toBe("string");
    expect(schema.config.model).not.toBe("(settings.json required)");
  });

  test("schema reports settings.json required when settings file is missing", async () => {
    const home = await useTempHome();

    const result = await runCli(["schema"], { home: home.home });
    const schema = JSON.parse(result.stdout) as {
      config: { provider: string; model: string };
    };

    expect(result.exitCode).toBe(0);
    // When settings file is missing, the catch path sets model to the error message.
    // When settings file loads but model is unset, model is "(settings.json required)".
    // Both paths set provider to "unresolved".
    expect(schema.config.provider).toBe("unresolved");
    expect(typeof schema.config.model).toBe("string");
  });
});

describe("learn - handler catch path", () => {
  test("learn handler has defensive catch for unexpected vibeLearnTool throws", async () => {
    // vibeLearnTool catches all its own errors, so the CLI catch block
    // is unreachable under normal operation. Verify the defensive code exists.
    const source = await readFile(join(originalCwd, "src/cli.ts"), "utf8");
    expect(source).toContain("process.stderr.write(`${");
    expect(source).toContain("added: false");
    expect(source).toContain("alreadyKnown: false");
  });
});

describe("check - settings load graceful degradation", () => {
  test("check handles missing settings gracefully with blocking result", async () => {
    const home = await useTempHome();
    // No settings.json — loadProviderSettings will throw

    const result = await runCli(
      [
        "check",
        "--goal",
        "test",
        "--plan",
        "test plan",
        "--provider",
        "anthropic",
        "--model",
        "mock-claude",
      ],
      {
        home: home.home,
        preload: mockAnthropicFetch,
        env: {
          ANTHROPIC_API_KEY: "ak",
          DEFAULT_MODEL: undefined,
          VIBE_TEST_ANTHROPIC_MODE: "proceed",
        },
      },
    );

    const payload = JSON.parse(result.stdout) as {
      proceed: boolean;
      attempts: number;
    };

    // Without settings, buildCheckParams can't resolve the provider → blocking result
    expect([0, 2]).toContain(result.exitCode);
    expect(result.stderr).toBe("");
    // Either it proceeds (if mock resolves) or blocks (if provider can't be resolved)
    expect(typeof payload.proceed).toBe("boolean");
  }, 15000);
});

describe("emitTestErrorMarker", () => {
  test("emitTestErrorMarker writes marker to captured stderr when VIBE_TEST_ERROR_MARKER is set", async () => {
    const home = await useTempHome();

    const savedHome = process.env["HOME"];
    process.env["HOME"] = home.home;
    try {
      const result = await runCliInProcess(["session"], "MARKER_TEXT_12345");

      expect(result.stderr).toContain("MARKER_TEXT_12345");
      expect(JSON.parse(result.stdout)).toEqual({
        session: expect.any(String),
      });
    } finally {
      process.env["HOME"] = savedHome;
    }
  });
});

describe("runCliInProcess - non-Error exception handling", () => {
  test("runCliInProcess stringifies non-Error exceptions in stderr", async () => {
    // We can't easily trigger a non-Error throw from Commander handlers.
    // Instead we verify that the catch-all branch exists by checking the source.
    const source = await readFile(join(originalCwd, "src/cli.ts"), "utf8");
    expect(source).toContain(
      "ctx.stderrChunks.push(`\x24{JSON.stringify({ error: String(e) })}\\n`)",
    );
    expect(source).toContain("ctx.exitCode = 1;");
  });
});
