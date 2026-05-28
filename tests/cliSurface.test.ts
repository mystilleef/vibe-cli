import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getCwdKey } from "../src/utils/autosession";
import { initializeSchema } from "../src/utils/database";
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

function runCli(
  args: string[],
  options: {
    cwd?: string;
    home?: string;
    env?: Record<string, string | undefined>;
    preload?: string;
  } = {},
): CliResult {
  const env: Record<string, string> = {
    ...process.env,
    HOME: options.home ?? process.env.HOME ?? "",
  };
  for (const [key, value] of Object.entries(options.env ?? {})) {
    if (value === undefined) {
      delete env[key];
    } else {
      env[key] = value;
    }
  }

  const result = Bun.spawnSync({
    cmd: [
      "bun",
      "run",
      ...(options.preload === undefined ? [] : ["--preload", options.preload]),
      cli,
      ...args,
    ],
    cwd: options.cwd ?? originalCwd,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
    exitCode: result.exitCode,
  };
}

function expectHelpWithoutSession(command: string[]): void {
  const result = runCli([...command, "--help"]);
  expect(result.exitCode).toBe(0);
  expect(result.stdout).not.toContain("--session");
}

type SeedLearningEntry = {
  type: LearningType;
  category: string;
  mistake: string;
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
       (type, category, mistake, solution, timestamp, demo_id)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  for (const entry of entries) {
    insert.run(
      entry.type,
      entry.category,
      entry.mistake,
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
  const result = runCli(
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

  test("affected help output omits public --session options", () => {
    expectHelpWithoutSession(["check"]);
    expectHelpWithoutSession(["learn"]);
    expectHelpWithoutSession(["constitution", "set"]);
    expectHelpWithoutSession(["constitution", "get"]);
    expectHelpWithoutSession(["constitution", "reset"]);

    expectHelpWithoutSession(["demo"]);
  });

  test("removed --session options fail through Commander", () => {
    for (const command of [
      ["check", "--session", "x", "--goal", "g", "--plan", "p"],
      ["learn", "--session", "x", "--mistake", "m", "--category", "c"],
      ["constitution", "set", "--session", "x", "--rule", "r"],
      ["constitution", "get", "--session", "x"],
      ["constitution", "reset", "--session", "x"],
      ["demo", "--session", "x"],
    ]) {
      const result = runCli(command);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("unknown option '--session'");
    }
  });

  test("list command group exposes shared JSON output without affecting existing emitters", () => {
    const pretty = runCli(["list"]);
    const json = runCli(["list", "--json"]);
    const help = runCli(["list", "--help"]);

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
        "interactions",
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
    const prettyLearnings = runCli(["list", "learnings"], { home: home.home });
    const jsonLearnings = runCli(["list", "learnings", "--json"], {
      home: home.home,
    });
    const prettyCategories = runCli(["list", "categories"], {
      home: home.home,
    });
    const jsonCategories = runCli(["list", "categories", "--json"], {
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
        mistake: "Alpha older.",
        solution: "Fix older.",
        timestamp: base,
      },
      {
        type: "success",
        category: "alpha",
        mistake: "Alpha newer.",
        solution: "Keep newer.",
        timestamp: base + 1000,
      },
      {
        type: "preference",
        category: "beta",
        mistake: "Beta preference.",
        timestamp: base + 2000,
      },
      {
        type: "mistake",
        category: "beta",
        mistake: "Beta mistake.",
        solution: "Fix beta.",
        timestamp: base + 3000,
      },
      {
        type: "mistake",
        category: "gamma",
        mistake: "Gamma mistake.",
        solution: "Fix gamma.",
        timestamp: base + 4000,
      },
    ]);

    const typed = runCli(
      ["list", "learnings", "--type", "mistake", "--limit", "2", "--json"],
      { home: home.home },
    );
    const filtered = runCli(
      ["list", "learnings", "--category", "beta", "--limit", "1", "--json"],
      { home: home.home },
    );
    const pretty = runCli(["list", "learnings", "--type", "success"], {
      home: home.home,
    });

    expect(JSON.parse(typed.stdout)).toEqual([
      {
        type: "mistake",
        category: "alpha",
        mistake: "Alpha older.",
        solution: "Fix older.",
        timestamp: base,
      },
      {
        type: "mistake",
        category: "beta",
        mistake: "Beta mistake.",
        solution: "Fix beta.",
        timestamp: base + 3000,
      },
    ]);
    expect(JSON.parse(filtered.stdout)).toEqual([
      {
        type: "preference",
        category: "beta",
        mistake: "Beta preference.",
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
        mistake: "Beta older.",
        solution: "Fix beta older.",
        timestamp: base,
      },
      {
        type: "mistake",
        category: "alpha",
        mistake: "Alpha older.",
        solution: "Fix alpha older.",
        timestamp: base + 1000,
      },
      {
        type: "success",
        category: "alpha",
        mistake: "Alpha newer.",
        solution: "Keep alpha newer.",
        timestamp: base + 2000,
      },
      {
        type: "preference",
        category: "beta",
        mistake: "Beta newer.",
        timestamp: base + 3000,
      },
      {
        type: "mistake",
        category: "gamma",
        mistake: "Gamma only.",
        solution: "Fix gamma.",
        timestamp: base + 4000,
      },
    ]);

    const json = runCli(["list", "categories", "--json"], {
      home: home.home,
    });
    const pretty = runCli(["list", "categories"], { home: home.home });
    const categories = JSON.parse(json.stdout) as Array<{
      category: string;
      count: number;
      recentExample: { mistake: string };
    }>;

    expect(categories.map((category) => category.category)).toEqual([
      "alpha",
      "beta",
      "gamma",
    ]);
    expect(categories.map((category) => category.count)).toEqual([2, 2, 1]);
    expect(categories[0]?.recentExample.mistake).toBe("Alpha newer.");
    expect(categories[1]?.recentExample.mistake).toBe("Beta newer.");
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

    const empty = runCli(["list", "constitution", "--json"], {
      cwd,
      home: home.home,
    });
    const emptyPayload = JSON.parse(empty.stdout) as {
      session: string;
      rules: string[];
    };
    const set = runCli(
      ["constitution", "set", "--rule", "Prefer tests", "Prefer local state"],
      { cwd, home: home.home },
    );
    const json = runCli(["list", "constitution", "--json"], {
      cwd,
      home: home.home,
    });
    const pretty = runCli(["list", "constitution"], {
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

    const json = runCli(["list", "sessions", "--json"], { home: home.home });
    const pretty = runCli(["list", "sessions"], { home: home.home });
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

  test("list providers returns static JSON and marks the active provider", async () => {
    const home = await useTempHome();

    const json = runCli(["list", "providers", "--json"], {
      home: home.home,
      env: { DEFAULT_LLM_PROVIDER: "deepseek" },
    });
    const pretty = runCli(["list", "providers"], {
      home: home.home,
      env: { DEFAULT_LLM_PROVIDER: "deepseek" },
    });
    const payload = JSON.parse(json.stdout) as Record<string, string>;

    expect(json.exitCode).toBe(0);
    expect(json.stderr).toBe("");
    expect(payload).toMatchObject({
      anthropic: "claude-haiku-4-5-20251001",
      deepseek: "deepseek-v4-pro",
      gemini: "gemini-2.5-flash",
    });
    expect(payload).not.toHaveProperty("activeProvider");
    expect(pretty.exitCode).toBe(0);
    expect(pretty.stderr).toBe("");
    expect(pretty.stdout).toContain("Providers");
    expect(pretty.stdout).toMatch(/deepseek\s+deepseek-v4-pro\s+\*/);
  });

  test("list interactions filters, limits, parses, and truncates reasons", async () => {
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

    const json = runCli(
      [
        "list",
        "interactions",
        "--session",
        "session-alpha",
        "--limit",
        "1",
        "--json",
      ],
      { home: home.home },
    );
    const pretty = runCli(["list", "interactions"], { home: home.home });
    const payload = JSON.parse(json.stdout) as Array<{
      id: number;
      session_id: string;
      goal: string;
      output: string;
      timestamp: number;
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
      },
    ]);
    expect(pretty.exitCode).toBe(0);
    expect(pretty.stderr).toBe("");
    expect(pretty.stdout).toContain("Interactions");
    expect(pretty.stdout).toContain("Session: session-alpha");
    expect(pretty.stdout).toContain("Session: session-beta");
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
      ["list", "interactions", "--session", "missing", "--limit", "5"],
      [
        "list",
        "interactions",
        "--session",
        "missing",
        "--limit",
        "5",
        "--json",
      ],
      ["list", "categories"],
      ["list", "categories", "--json"],
      ["list", "stats"],
      ["list", "stats", "--json"],
      ["list", "all"],
      ["list", "all", "--json"],
    ];

    for (const args of commands) {
      const result = runCli(args, {
        cwd,
        home: home.home,
        preload: failOnFetch,
        env,
      });

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).not.toBe("");
      if (args.includes("--json"))
        expect(() => JSON.parse(result.stdout)).not.toThrow();
    }
  });

  test("list stats and all compose local readers", async () => {
    const home = await useTempHome();
    const cwd = await createCwd();
    const base = Date.parse("2026-01-01T00:00:00.000Z");
    const set = runCli(
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
        mistake: "Risk one.",
        solution: "Mitigate risk.",
        timestamp: base,
      },
      {
        type: "preference",
        category: "style",
        mistake: "Style one.",
        timestamp: base + 1000,
      },
      {
        type: "success",
        category: "risk",
        mistake: "Risk success.",
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

    const statsJson = runCli(["list", "stats", "--json"], {
      cwd,
      home: home.home,
    });
    const statsPretty = runCli(["list", "stats"], { cwd, home: home.home });
    const allJson = runCli(["list", "all", "--json"], {
      cwd,
      home: home.home,
      env: { DEFAULT_LLM_PROVIDER: "deepseek" },
    });
    const allPretty = runCli(["list", "all"], {
      cwd,
      home: home.home,
      env: { DEFAULT_LLM_PROVIDER: "deepseek" },
    });
    const stats = JSON.parse(statsJson.stdout);
    const all = JSON.parse(allJson.stdout) as {
      learnings: unknown[];
      constitution: { rules: string[] };
      sessions: unknown[];
      providers: Record<string, string>;
      interactions: unknown[];
      categories: unknown[];
      stats: unknown;
    };

    expect(statsJson.exitCode).toBe(0);
    expect(statsJson.stderr).toBe("");
    expect(stats).toEqual({
      learnings: { total: 3, mistake: 1, preference: 1, success: 1 },
      sessions: { total: 2, mostActiveCwd: cwd },
      constitution: { activeRules: 1 },
      interactions: { total: 3 },
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
      "interactions",
      "categories",
      "stats",
    ]);
    expect(all.learnings).toHaveLength(3);
    expect(all.constitution.rules).toEqual(["Prefer local reads"]);
    expect(all.sessions).toHaveLength(2);
    expect(all.providers.deepseek).toBe("deepseek-v4-pro");
    expect(all.interactions).toHaveLength(3);
    expect(all.categories).toHaveLength(2);
    expect(all.stats).toEqual(stats);
    expect(allPretty.exitCode).toBe(0);
    expect(allPretty.stderr).toBe("");
    for (const heading of [
      "Learnings",
      "Constitution",
      "Sessions",
      "Providers",
      "Interactions",
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
    const result = runCli(
      [
        "learn",
        "--mistake",
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
      currentTally: number;
      topCategories: Array<{
        category: string;
        count: number;
        recentExample: { type: string; mistake: string; solution: string };
      }>;
    };

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(payload).toMatchObject({
      added: true,
      alreadyKnown: false,
      currentTally: 1,
      topCategories: [
        {
          category: "archive",
          count: 1,
          recentExample: {
            type: "success",
            mistake: "Store reusable successes.",
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

  test("session command emits JSON and refreshes lastAccessedAt", async () => {
    const home = await useTempHome();
    const cwd = await createCwd();
    const cwdKey = getCwdKey(cwd);

    const first = runCli(["session"], { cwd, home: home.home });
    const firstJson = JSON.parse(first.stdout) as { session: string };
    const db = new Database(join(home.dataRoot, "vibe.db"));
    const oldTimestamp = new Date(Date.now() - 1000).toISOString();
    db.prepare(
      "UPDATE sessions SET last_accessed_at = ? WHERE cwd_key = ?",
    ).run(oldTimestamp, cwdKey);

    const second = runCli(["session"], { cwd, home: home.home });
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
    db.exec(`
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
    `);
    db.prepare(
      "INSERT INTO sessions (id, cwd_key, created_at, last_accessed_at) VALUES (?, ?, ?, ?)",
    ).run(sessionId, cwdKey, createdAt, oldTimestamp);
    db.close();

    const result = runCli(["session"], { cwd, home: home.home });
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

  test("schema reflects session and list commands with removed public session flags", () => {
    const result = runCli(["schema"]);
    const schema = JSON.parse(result.stdout) as {
      commands: Record<
        string,
        { opt?: Record<string, string>; subcommands?: string[]; out?: unknown }
      >;
    };

    expect(Object.keys(schema.commands)).toContain("session");
    expect(schema.commands.list?.opt).toHaveProperty("--json");
    expect(schema.commands.list?.subcommands).toEqual([
      "learnings",
      "constitution",
      "sessions",
      "providers",
      "interactions",
      "categories",
      "stats",
      "all",
    ]);
    expect(schema.commands["list learnings"]?.opt).toHaveProperty("--type");
    expect(schema.commands["list learnings"]?.opt).toHaveProperty("--category");
    expect(schema.commands["list learnings"]?.opt).toHaveProperty("--limit");
    expect(schema.commands["list learnings"]?.opt).toHaveProperty("--json");
    expect(schema.commands["list categories"]?.opt).toHaveProperty("--json");
    expect(schema.commands["list constitution"]?.opt).toHaveProperty("--json");
    expect(schema.commands["list sessions"]?.opt).toHaveProperty("--json");
    expect(schema.commands["list providers"]?.opt).toHaveProperty("--json");
    expect(schema.commands["list interactions"]?.opt).toHaveProperty(
      "--session",
    );
    expect(schema.commands["list interactions"]?.opt).toHaveProperty("--limit");
    expect(schema.commands["list interactions"]?.opt).toHaveProperty("--json");
    expect(schema.commands["list stats"]?.opt).toHaveProperty("--json");
    expect(schema.commands["list all"]?.opt).toHaveProperty("--json");
    for (const command of [
      "check",
      "learn",
      "constitution set",
      "constitution get",
      "constitution reset",
    ]) {
      expect(schema.commands[command]?.opt ?? {}).not.toHaveProperty(
        "--session",
      );
    }
  });

  test("schema loads home env file without overriding shell env vars", async () => {
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

    const result = runCli(["schema"], {
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
    expect(schema.config).toEqual({
      provider: "deepseek",
      model: "shell-model",
    });
  });

  test("verify emits JSON failure and exits 1 for unsupported providers", async () => {
    const home = await useTempHome();

    const result = runCli(["verify", "--provider", "bogus"], {
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
    expect(payload.error).toContain("Unknown provider: bogus");
  });

  test("check emits fatal JSON when gate provider resolution fails", async () => {
    const home = await useTempHome();

    const result = runCli(
      ["check", "--goal", "g", "--plan", "p", "--provider", "bogus"],
      { home: home.home, env: { DEFAULT_MODEL: undefined } },
    );
    const payload = JSON.parse(result.stderr) as { error: string };

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(payload.error).toContain("Unknown provider: bogus");
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
    expect(payload.questions).toContain("questions:mock-claude");
  });

  test("VIBE_MAX_ATTEMPTS env var sets default max attempts", async () => {
    const { result, payload } = await runVibeCheck([], {
      VIBE_MAX_ATTEMPTS: "1",
      VIBE_TEST_ANTHROPIC_MODE: "block",
    });

    expect(result.exitCode).toBe(2);
    expect(payload).toMatchObject({
      proceed: false,
      exhausted: true,
      attempts: 1,
    });
  });

  test("--max-attempts flag overrides VIBE_MAX_ATTEMPTS env var", async () => {
    const { result, payload } = await runVibeCheck(
      ["--model", "mock-claude", "--max-attempts", "5"],
      {
        VIBE_MAX_ATTEMPTS: "1",
        VIBE_TEST_ANTHROPIC_MODE: "proceed",
      },
    );

    expect(result.exitCode).toBe(0);
    expect(payload).toMatchObject({ proceed: true, attempts: 1 });
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

  test("VIBE_MAX_ATTEMPTS non-numeric env var silently falls back to 10", async () => {
    const { result, payload } = await runVibeCheck(["--model", "mock-claude"], {
      VIBE_MAX_ATTEMPTS: "abc",
      VIBE_TEST_ANTHROPIC_MODE: "proceed",
    });

    expect(result.exitCode).toBe(0);
    expect(payload).toMatchObject({ proceed: true, attempts: 1 });
  });

  test("--max-attempts 0 flag falls back to 10 due to falsy default", async () => {
    const { result, payload } = await runVibeCheck(["--max-attempts", "0"], {
      VIBE_TEST_ANTHROPIC_MODE: "block",
    });

    expect(result.exitCode).toBe(2);
    expect(payload.exhausted).toBe(true);
    expect(payload.attempts).toBeGreaterThanOrEqual(1);
  });

  test("VIBE_MAX_ATTEMPTS=0 env var falls back to 10 due to falsy default", async () => {
    const { result, payload } = await runVibeCheck([], {
      VIBE_MAX_ATTEMPTS: "0",
      VIBE_TEST_ANTHROPIC_MODE: "block",
    });

    expect(result.exitCode).toBe(2);
    expect(payload.exhausted).toBe(true);
    expect(payload.attempts).toBeGreaterThanOrEqual(1);
  });

  test("verify emits JSON success and exits 0 with mocked Anthropic", async () => {
    const home = await useTempHome();

    const result = runCli(
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
  });

  test("learn command emits validation failure JSON without process failure", async () => {
    const home = await useTempHome();

    const result = runCli(
      ["learn", "--mistake", "Repeated risky plan.", "--category", "risk"],
      { home: home.home },
    );
    const payload = JSON.parse(result.stdout) as {
      added: boolean;
      alreadyKnown: boolean;
      currentTally: number;
      topCategories: unknown[];
    };

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain(
      "--solution is required for mistake and success types",
    );
    expect(payload).toEqual({
      added: false,
      alreadyKnown: false,
      currentTally: 0,
      topCategories: [],
    });
  });

  test("constitution commands preserve ordered state and support clearing", async () => {
    const home = await useTempHome();
    const cwd = await createCwd();

    const set = runCli(
      ["constitution", "set", "--rule", "Prefer tests", "Prefer rollbacks"],
      { cwd, home: home.home },
    );
    const get = runCli(["constitution", "get"], { cwd, home: home.home });
    const reset = runCli(["constitution", "reset"], { cwd, home: home.home });

    expect(set.exitCode).toBe(0);
    expect(JSON.parse(set.stdout)).toMatchObject({
      rules: ["Prefer tests", "Prefer rollbacks"],
    });
    expect(JSON.parse(get.stdout)).toMatchObject({
      rules: ["Prefer tests", "Prefer rollbacks"],
    });
    expect(JSON.parse(reset.stdout)).toMatchObject({ rules: [] });
  });
});
