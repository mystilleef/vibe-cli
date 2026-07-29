import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { updateConstitution } from "../src/tools/constitution";
import { resolveAutosession } from "../src/utils/autosession";
import {
  getMigrationIds,
  openVibeDatabase,
  type VibeDatabase,
} from "../src/utils/database";
import { getLearningEntries } from "../src/utils/storage";
import { createTempHome, type TempHomeContext } from "./helpers/tempHome";

const homes: TempHomeContext[] = [];
const handles: VibeDatabase[] = [];

const originalCwd = process.cwd();
const EXPECTED_MIGRATION_IDS = getMigrationIds();

afterEach(async () => {
  for (const handle of handles.splice(0)) handle.close();
  await Promise.all(homes.splice(0).map((home) => home.cleanup()));
});

async function useTempHome(): Promise<TempHomeContext> {
  const home = await createTempHome();
  homes.push(home);
  await mkdir(home.dataRoot, { recursive: true });
  return home;
}

function openTracked(): VibeDatabase {
  const handle = openVibeDatabase();
  handles.push(handle);
  return handle;
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, JSON.stringify(value, null, 2), "utf8");
}

async function writeCompleteLegacyArtifacts(
  home: TempHomeContext,
): Promise<void> {
  const sessionsDir = join(home.dataRoot, "sessions");
  await mkdir(sessionsDir, { recursive: true });
  await writeJson(join(sessionsDir, "abc123.json"), {
    id: "session-a",
    createdAt: "2026-01-01T00:00:00.000Z",
    lastAccessedAt: "2026-01-01T01:00:00.000Z",
  });
  await writeJson(join(home.dataRoot, "vibe-log.json"), {
    mistakes: {
      coding: {
        count: 1,
        examples: [{ mistake: "used database", timestamp: 42 }],
        lastUpdated: 42,
      },
    },
    lastUpdated: 42,
  });
  await writeJson(join(home.dataRoot, "constitution.json"), {
    "session-a": ["rule one"],
  });
  await writeJson(join(home.dataRoot, "history.json"), {
    "session-a": [
      { input: { goal: "ship" }, output: "approved", timestamp: 99 },
    ],
  });
}

function expectCompleteLegacyImport(handle: VibeDatabase): void {
  expect(
    handle.db.query("SELECT id, cwd_key FROM sessions").all(),
  ).toContainEqual({ id: "session-a", cwd_key: "abc123" });
  expect(
    handle.db
      .query("SELECT observation, timestamp FROM learning_entries")
      .all(),
  ).toEqual([{ observation: "used database", timestamp: 42 }]);
  expect(
    handle.db.query("SELECT rule FROM constitution_rules").all(),
  ).toContainEqual({ rule: "rule one" });
  expect(
    handle.db.query("SELECT goal, output, timestamp FROM interactions").all(),
  ).toEqual([{ goal: "ship", output: "approved", timestamp: 99 }]);
}

describe("custom database path", () => {
  test("creates parent directory for custom path", async () => {
    const customDir = await mkdtemp(join(tmpdir(), "vibe-custom-db-"));
    const customPath = join(customDir, "subdir", "test.db");

    try {
      const handle = openVibeDatabase({ path: customPath });
      handles.push(handle);

      expect(existsSync(customPath)).toBe(true);
      expect(handle.path).toBe(customPath);
    } finally {
      await rm(customDir, { recursive: true, force: true });
    }
  });
});

describe("legacy JSON migration", () => {
  test("imports valid legacy artifacts and backs them up", async () => {
    const home = await useTempHome();
    const sessionsDir = join(home.dataRoot, "sessions");
    await mkdir(sessionsDir, { recursive: true });
    await writeJson(join(sessionsDir, "abc123.json"), {
      id: "session-a",
      createdAt: "2026-01-01T00:00:00.000Z",
      lastAccessedAt: "2026-01-01T01:00:00.000Z",
    });
    await writeJson(join(home.dataRoot, "vibe-log.json"), {
      mistakes: {
        coding: {
          count: 1,
          examples: [
            {
              type: "success",
              category: "coding",
              mistake: "used database",
              solution: "keep using database",
              timestamp: 42,
              demoId: "demo-a",
            },
          ],
          lastUpdated: 42,
        },
      },
      lastUpdated: 42,
    });
    await writeJson(join(home.dataRoot, "constitution.json"), {
      "session-a": ["rule one", "rule two"],
    });
    await writeJson(join(home.dataRoot, "history.json"), {
      "session-a": [
        { input: { goal: "ship" }, output: "approved", timestamp: 99 },
      ],
    });

    const handle = openTracked();

    expect(
      handle.db.query("SELECT id, cwd_key FROM sessions").all(),
    ).toContainEqual({ id: "session-a", cwd_key: "abc123" });
    expect(
      handle.db
        .query(
          "SELECT type, category, observation, solution, timestamp, demo_id FROM learning_entries",
        )
        .all(),
    ).toEqual([
      {
        type: "success",
        category: "coding",
        observation: "used database",
        solution: "keep using database",
        timestamp: 42,
        demo_id: "demo-a",
      },
    ]);
    expect(
      handle.db
        .query("SELECT rule FROM constitution_rules ORDER BY position")
        .all(),
    ).toEqual([{ rule: "rule one" }, { rule: "rule two" }]);
    expect(
      handle.db.query("SELECT goal, output, timestamp FROM interactions").all(),
    ).toEqual([{ goal: "ship", output: "approved", timestamp: 99 }]);
    expect(existsSync(join(sessionsDir, "abc123.json.bak"))).toBe(true);
    expect(existsSync(join(home.dataRoot, "vibe-log.json.bak"))).toBe(true);
    expect(existsSync(join(home.dataRoot, "constitution.json.bak"))).toBe(true);
    expect(existsSync(join(home.dataRoot, "history.json.bak"))).toBe(true);
  });

  test("does not duplicate imported records on repeated startup", async () => {
    const home = await useTempHome();
    await writeJson(join(home.dataRoot, "vibe-log.json"), {
      mistakes: {
        process: {
          count: 1,
          examples: [{ mistake: "repeat", timestamp: 7 }],
          lastUpdated: 7,
        },
      },
      lastUpdated: 7,
    });

    const first = openTracked();
    first.close();
    handles.pop();
    const second = openTracked();

    expect(
      second.db.query("SELECT count(*) AS count FROM learning_entries").get(),
    ).toEqual({ count: 1 });
    expect(
      second.db.query("SELECT artifact FROM legacy_imports").all(),
    ).toEqual([{ artifact: "vibe-log.json" }]);
  });

  test("leaves malformed artifacts in place and unmarked", async () => {
    const home = await useTempHome();
    const badPath = join(home.dataRoot, "vibe-log.json");
    await writeFile(badPath, "{ nope", "utf8");

    const handle = openTracked();

    expect(existsSync(badPath)).toBe(true);
    expect(existsSync(`${badPath}.bak`)).toBe(false);
    expect(handle.db.query("SELECT * FROM legacy_imports").all()).toEqual([]);
    expect(
      handle.db.query("SELECT count(*) AS count FROM learning_entries").get(),
    ).toEqual({ count: 0 });
  });

  test("uses collision-safe backup paths", async () => {
    const home = await useTempHome();
    await writeJson(join(home.dataRoot, "constitution.json"), { s: ["rule"] });
    await writeFile(
      join(home.dataRoot, "constitution.json.bak"),
      "old",
      "utf8",
    );

    openTracked();

    expect(existsSync(join(home.dataRoot, "constitution.json.bak"))).toBe(true);
    expect(existsSync(join(home.dataRoot, "constitution.json.1.bak"))).toBe(
      true,
    );
  });

  test("autosession path imports every legacy artifact class", async () => {
    const home = await useTempHome();
    await writeCompleteLegacyArtifacts(home);

    resolveAutosession("/tmp/project-a");
    const handle = openTracked();

    expectCompleteLegacyImport(handle);
  });

  test("learning path imports every legacy artifact class", async () => {
    const home = await useTempHome();
    await writeCompleteLegacyArtifacts(home);

    expect(getLearningEntries()["coding"]?.[0]?.observation).toBe(
      "used database",
    );
    const handle = openTracked();

    expectCompleteLegacyImport(handle);
  });

  test("constitution path imports every legacy artifact class", async () => {
    const home = await useTempHome();
    await writeCompleteLegacyArtifacts(home);

    updateConstitution("new rule");
    const handle = openTracked();

    expectCompleteLegacyImport(handle);
  });
});

describe("malformed legacy learning entries", () => {
  test("rejects entire batch when any entry has invalid type field", async () => {
    const home = await useTempHome();
    await writeJson(join(home.dataRoot, "vibe-log.json"), {
      mistakes: {
        coding: {
          count: 2,
          examples: [
            { mistake: "valid", timestamp: 42 },
            { mistake: "bad type", timestamp: 43, type: "invalid-type" },
          ],
          lastUpdated: 43,
        },
      },
      lastUpdated: 43,
    });

    const handle = openTracked();

    // extractLearningEntries returns null on any malformed entry,
    // so the entire import is skipped
    expect(
      handle.db.query("SELECT count(*) AS count FROM learning_entries").get(),
    ).toEqual({ count: 0 });
  });

  test("rejects entire batch when any entry has non-string solution", async () => {
    const home = await useTempHome();
    await writeJson(join(home.dataRoot, "vibe-log.json"), {
      mistakes: {
        coding: {
          count: 2,
          examples: [
            { mistake: "valid", timestamp: 42 },
            { mistake: "bad solution", timestamp: 43, solution: 123 },
          ],
          lastUpdated: 43,
        },
      },
      lastUpdated: 43,
    });

    const handle = openTracked();

    expect(
      handle.db.query("SELECT count(*) AS count FROM learning_entries").get(),
    ).toEqual({ count: 0 });
  });

  test("rejects entire batch when any entry has non-string demoId", async () => {
    const home = await useTempHome();
    await writeJson(join(home.dataRoot, "vibe-log.json"), {
      mistakes: {
        coding: {
          count: 2,
          examples: [
            { mistake: "valid", timestamp: 42 },
            { mistake: "bad demoId", timestamp: 43, demoId: 123 },
          ],
          lastUpdated: 43,
        },
      },
      lastUpdated: 43,
    });

    const handle = openTracked();

    expect(
      handle.db.query("SELECT count(*) AS count FROM learning_entries").get(),
    ).toEqual({ count: 0 });
  });
});

describe("readdirSync failure handling", () => {
  test("gracefully handles unreadable sessions directory", async () => {
    const home = await useTempHome();
    const sessionsDir = join(home.dataRoot, "sessions");
    await mkdir(sessionsDir, { recursive: true });

    // Create a valid session file first
    await writeJson(join(sessionsDir, "test.json"), {
      id: "session-1",
      createdAt: "2026-01-01T00:00:00.000Z",
      lastAccessedAt: "2026-01-01T01:00:00.000Z",
    });

    // Now remove the directory and replace with a file
    // This will cause readdirSync to fail with ENOTDIR
    await rm(sessionsDir, { recursive: true, force: true });
    await writeFile(sessionsDir, "not a directory", "utf8");

    // Should not throw - the catch block handles this
    const handle = openTracked();
    handles.push(handle);

    // No sessions should be imported
    expect(
      handle.db.query("SELECT count(*) AS count FROM sessions").get(),
    ).toEqual({ count: 0 });
  });
});

describe("concurrent database bootstrap", () => {
  async function spawnOpenDatabase(
    home: string,
  ): Promise<{ exitCode: number; stderr: string; stdout: string }> {
    const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
    const { join: pathJoin } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const scriptDir = mkdtempSync(pathJoin(tmpdir(), "vibe-db-test-"));
    const scriptPath = pathJoin(scriptDir, "open.ts");
    writeFileSync(
      scriptPath,
      `
import { openVibeDatabase as od } from "${join(originalCwd, "src/utils/database.ts")}";
const handle = od();
const row = handle.db.query("SELECT count(*) AS count FROM schema_migrations").get() as { count: number };
handle.close();
console.log(JSON.stringify({ ok: true, count: row.count }));
`,
    );
    const proc = Bun.spawn({
      cmd: ["bun", "run", scriptPath],
      env: { ...process.env, HOME: home },
      stdout: "pipe",
      stderr: "pipe",
      timeout: 10_000,
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    rmSync(scriptDir, { recursive: true, force: true });
    return { exitCode, stderr, stdout };
  }

  test("concurrent database opening from fresh home converges to valid state", async () => {
    const home = await useTempHome();
    const CONCURRENCY = 6;

    const results = await Promise.all(
      Array.from({ length: CONCURRENCY }, () => spawnOpenDatabase(home.home)),
    );

    for (const { exitCode, stderr, stdout } of results) {
      expect(exitCode).toBe(0);
      expect(stderr).toBe("");
      const payload = JSON.parse(stdout.trim()) as {
        ok: boolean;
        count: number;
      };
      expect(payload.ok).toBe(true);
      // All migrations should be applied.
      expect(payload.count).toBe(EXPECTED_MIGRATION_IDS.length);
    }

    // Sequential verification: database is valid.
    const db = new Database(join(home.dataRoot, "vibe.db"));
    const applied = db
      .query("SELECT id FROM schema_migrations ORDER BY id")
      .all() as Array<{ id: string }>;
    db.close();
    expect(applied.map((r) => r.id)).toEqual(EXPECTED_MIGRATION_IDS);
  }, 15000);

  test("concurrent database opening from partially migrated home converges to fully migrated", async () => {
    const home = await useTempHome();
    await mkdir(home.dataRoot, { recursive: true });

    // Create a genuinely partially-migrated database: only migration 001
    // is applied, with its tables materialized. Migrations 002 and 003 are
    // truly pending (not yet executed).
    const db = new Database(join(home.dataRoot, "vibe.db"));
    db.run(`
      CREATE TABLE schema_migrations (
        id TEXT PRIMARY KEY,
        applied_at TEXT NOT NULL
      );
      INSERT INTO schema_migrations (id, applied_at)
        VALUES ('001_initial_schema', '2026-01-01T00:00:00.000Z');
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        cwd_key TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL,
        last_accessed_at TEXT NOT NULL
      );
      CREATE INDEX idx_sessions_last_accessed_at ON sessions(last_accessed_at);
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

    const CONCURRENCY = 4;
    const results = await Promise.all(
      Array.from({ length: CONCURRENCY }, () => spawnOpenDatabase(home.home)),
    );

    for (const { exitCode, stderr } of results) {
      expect(exitCode).toBe(0);
      expect(stderr).toBe("");
    }

    // All migrations should now be applied.
    const verifyDb = new Database(join(home.dataRoot, "vibe.db"));
    const applied = verifyDb
      .query("SELECT id FROM schema_migrations ORDER BY id")
      .all() as Array<{ id: string }>;
    verifyDb.close();
    expect(applied.map((r) => r.id)).toEqual(EXPECTED_MIGRATION_IDS);
  }, 15000);

  test("concurrent list commands sharing partially migrated home all succeed", async () => {
    const home = await useTempHome();
    await mkdir(home.dataRoot, { recursive: true });

    // Create a database with only migration 001 applied (missing 002, 003).
    // Also create the tables from 001 so the schema is internally consistent.
    const db = new Database(join(home.dataRoot, "vibe.db"));
    db.run(`
      CREATE TABLE schema_migrations (
        id TEXT PRIMARY KEY,
        applied_at TEXT NOT NULL
      );
      INSERT INTO schema_migrations (id, applied_at)
        VALUES ('001_initial_schema', '2026-01-01T00:00:00.000Z');
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        cwd_key TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL,
        last_accessed_at TEXT NOT NULL
      );
      CREATE INDEX idx_sessions_last_accessed_at ON sessions(last_accessed_at);
      CREATE TABLE learning_entries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        type TEXT NOT NULL CHECK (type IN ('mistake', 'preference', 'success')),
        category TEXT NOT NULL,
        mistake TEXT NOT NULL,
        solution TEXT,
        timestamp INTEGER NOT NULL,
        demo_id TEXT
      );
      CREATE TABLE constitution_rules (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        rule TEXT NOT NULL,
        position INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(session_id, position)
      );
      CREATE TABLE interactions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        goal TEXT NOT NULL,
        output TEXT NOT NULL,
        timestamp INTEGER NOT NULL
      );
    `);
    db.close();

    // Write settings so provider-dependent list commands can resolve.
    await writeFile(
      join(home.dataRoot, "settings.json"),
      JSON.stringify({
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
      }),
    );

    const LIST_COMMANDS = [
      ["session"],
      ["list", "learnings", "--json"],
      ["list", "sessions", "--json"],
      ["list", "providers", "--json"],
      ["migrate"],
    ];

    async function spawnCli(
      args: string[],
    ): Promise<{ exitCode: number; stderr: string; stdout: string }> {
      const proc = Bun.spawn({
        cmd: ["bun", "run", join(originalCwd, "src/cli.ts"), ...args],
        env: {
          ...process.env,
          HOME: home.home,
          CI: "true",
          NO_COLOR: "1",
          TERM: "dumb",
          PAGER: "cat",
          DEFAULT_LLM_PROVIDER: undefined,
          DEFAULT_MODEL: undefined,
        },
        stdout: "pipe",
        stderr: "pipe",
        timeout: 10_000,
      });
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      return { exitCode, stderr, stdout };
    }

    const results = await Promise.all(
      LIST_COMMANDS.map((args) => spawnCli(args)),
    );

    for (const { exitCode, stderr, stdout } of results) {
      expect(exitCode).toBe(0);
      expect(stderr).toBe("");
      expect(stdout).not.toBe("");
      const lastLine = stdout.trim().split("\n").pop() ?? "{}";
      expect(() => JSON.parse(lastLine)).not.toThrow();
    }

    // Migration completed: all expected migrations applied.
    const verifyDb = new Database(join(home.dataRoot, "vibe.db"));
    const applied = verifyDb
      .query("SELECT id FROM schema_migrations ORDER BY id")
      .all() as Array<{ id: string }>;
    verifyDb.close();
    expect(applied.map((r) => r.id)).toEqual(EXPECTED_MIGRATION_IDS);
  }, 15000);

  test("concurrent openDatabase with empty database file succeeds", async () => {
    const home = await useTempHome();
    await mkdir(home.dataRoot, { recursive: true });
    await writeFile(join(home.dataRoot, "vibe.db"), "");

    const CONCURRENCY = 4;
    const results = await Promise.all(
      Array.from({ length: CONCURRENCY }, () => spawnOpenDatabase(home.home)),
    );

    for (const { exitCode, stderr } of results) {
      expect(exitCode).toBe(0);
      expect(stderr).toBe("");
    }

    // Database is valid and fully migrated.
    const db = new Database(join(home.dataRoot, "vibe.db"));
    const applied = db
      .query("SELECT id FROM schema_migrations ORDER BY id")
      .all() as Array<{ id: string }>;
    db.close();
    expect(applied.map((r) => r.id)).toEqual(EXPECTED_MIGRATION_IDS);
  }, 15000);
});

// isTransientSqliteError coverage lives in tests/utils.database.retry.test.ts.
