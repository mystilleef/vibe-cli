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
const capturePruneInput = join(
  originalCwd,
  "tests",
  "helpers",
  "capturePruneInput.ts",
);

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
    expect(pretty.stdout).toContain("Interactions");
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
      providers: { activeProvider: string; providers: Record<string, string> };
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
    expect(all.providers.providers.deepseek).toBe("deepseek-v4-pro");
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

  test("schema excludes list commands and preserves metadata", () => {
    const result = runCli(["schema"]);
    const schema = JSON.parse(result.stdout) as {
      v?: unknown;
      data?: unknown;
      errors?: unknown;
      config?: unknown;
      commands: Record<string, { opt?: Record<string, string>; out?: unknown }>;
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
    ]) {
      expect(schema.commands[command]).toBeDefined();
      expect(schema.commands[command]?.opt ?? {}).not.toHaveProperty(
        "--session",
      );
    }
    expect(Object.keys(schema.commands.prune?.opt ?? {})).toEqual([
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
    expect(schema.commands.prune).toMatchObject({
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

  test("prune help output shows all options", () => {
    const result = runCli(["prune", "--help"]);

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

    const result = runCli(
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
  });

  test("prune with no targets defaults to dry-run summary", async () => {
    const home = await useTempHome();

    const result = runCli(["prune"], { home: home.home });
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

    const result = runCli(["prune", "--learnings", "--age", "-5"], {
      home: home.home,
    });
    const payload = JSON.parse(result.stderr) as { error: string };

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(payload.error).toContain("--age must be a positive integer");
  });

  test("prune rejects invalid --overlap", async () => {
    const home = await useTempHome();

    const result = runCli(["prune", "--duplicates", "--overlap", "1.5"], {
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

    const result = runCli(["prune", "--category", "scope", "--dry-run"], {
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

    const result = runCli(
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

    const result = runCli(
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

      const result = runCli([...args], { home: home.home });
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

  test("prune omits negated boolean option variants from its CLI contract", () => {
    const help = runCli(["prune", "--help"]);

    expect(help.exitCode).toBe(0);
    expect(help.stdout).not.toContain("--no-dry-run");
    expect(help.stdout).not.toContain("--no-yes");

    for (const option of ["--no-dry-run", "--no-yes"]) {
      const result = runCli(["prune", option]);

      expect(result.exitCode).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("unknown option");
      expect(result.stderr).toContain(option);
    }
  });

  test("prune commands never perform provider network calls", async () => {
    const home = await useTempHome();
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

    for (const args of commands) {
      const result = runCli(args, {
        home: home.home,
        preload: failOnFetch,
        env,
      });

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).not.toBe("");
      expect(() => JSON.parse(result.stdout)).not.toThrow();
    }
  });

  test("prune destructive requires --yes and emits backup path", async () => {
    const home = await useTempHome();
    const base = Date.parse("2026-01-01T00:00:00.000Z");
    await seedLearningEntries(home, [
      {
        type: "mistake",
        category: "test",
        mistake: "Old entry.",
        solution: "Fix it.",
        timestamp: base - 100 * 24 * 60 * 60 * 1000,
      },
    ]);

    const dryRun = runCli(
      ["prune", "--learnings", "--age", "90", "--dry-run"],
      { home: home.home },
    );
    const dryPayload = JSON.parse(dryRun.stdout) as {
      dryRun: boolean;
      candidateCounts: { learnings: number };
    };

    expect(dryPayload.dryRun).toBe(true);
    expect(dryPayload.candidateCounts.learnings).toBeGreaterThanOrEqual(1);

    const destructive = runCli(
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
        mistake: "Old entry.",
        solution: "Fix it.",
        timestamp: base - 100 * 24 * 60 * 60 * 1000,
      },
    ]);

    const result = runCli(["prune", "--learnings", "--age", "90", "-y"], {
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
        mistake: "Old entry.",
        solution: "Fix it.",
        timestamp: base - 100 * 24 * 60 * 60 * 1000,
      },
    ]);

    const result = runCli(
      ["prune", "--learnings", "--age", "90", "--dry-run", "--yes"],
      { home: home.home },
    );
    const payload = JSON.parse(result.stderr) as { error: string };

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(payload.error).toContain("--dry-run cannot be combined with --yes");

    const dryRun = runCli(
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

    const result = runCli(["prune"], {
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
  });

  test("prune boolean flags include true in runPrune input when provided", async () => {
    const cases = [
      { args: ["prune", "--dry-run"], expected: "dryRun" },
      { args: ["prune", "--yes"], expected: "yes" },
      { args: ["prune", "-y"], expected: "yes" },
    ] as const;

    for (const [index, { args, expected }] of cases.entries()) {
      const home = await useTempHome();
      const capturePath = join(home.home, `prune-input-${index}.json`);

      const result = runCli([...args], {
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
  });

  test("prune --learnings includes only learnings:true in runPrune input", async () => {
    const home = await useTempHome();
    const capturePath = join(home.home, "prune-input.json");

    const result = runCli(["prune", "--learnings"], {
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
    expect(captured.learnings).toBe(true);
    expect(captured).not.toHaveProperty("duplicates");
    expect(captured).not.toHaveProperty("demos");
    expect(captured).not.toHaveProperty("sessions");
  });

  test("prune --duplicates --demos includes only those two flags in runPrune input", async () => {
    const home = await useTempHome();
    const capturePath = join(home.home, "prune-input.json");

    const result = runCli(["prune", "--duplicates", "--demos"], {
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
    expect(captured.duplicates).toBe(true);
    expect(captured.demos).toBe(true);
    expect(captured).not.toHaveProperty("learnings");
    expect(captured).not.toHaveProperty("sessions");
  });
});
