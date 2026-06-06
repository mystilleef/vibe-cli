import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DATABASE_FILENAME,
  getDatabasePath,
  getMigrationIds,
  getVibeDatabase,
  openVibeDatabase,
  openVibeDatabaseWithMigrationReport,
  type VibeDatabase,
  withDatabase,
} from "../src/utils/database";
import { createTempHome, type TempHomeContext } from "./helpers/tempHome";

const homes: TempHomeContext[] = [];
const roots: string[] = [];
const handles: VibeDatabase[] = [];

const EXPECTED_MIGRATION_IDS = [
  "001_initial_schema",
  "002_sessions_display_cwd",
  "003_rename_mistake_to_observation",
];

afterEach(async () => {
  for (const handle of handles.splice(0)) handle.close();
  await Promise.all(homes.splice(0).map((home) => home.cleanup()));
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function useTempHome(): Promise<TempHomeContext> {
  const home = await createTempHome();
  homes.push(home);
  return home;
}

async function tempDatabasePath(name: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `vibe-cli-db-${name}-`));
  roots.push(root);
  return join(root, DATABASE_FILENAME);
}

function openTracked(path?: string): VibeDatabase {
  const handle = openVibeDatabase(path === undefined ? undefined : { path });
  handles.push(handle);
  return handle;
}

function closeTracked(handle: VibeDatabase): void {
  handle.close();
  handles.splice(handles.indexOf(handle), 1);
}

function readMigrationIds(handle: VibeDatabase): string[] {
  const rows = handle.db
    .query("SELECT id FROM schema_migrations ORDER BY id")
    .all() as Array<{ id: string }>;
  return rows.map(({ id }) => id);
}

function readMigrationCounts(handle: VibeDatabase): Array<{
  count: number;
  id: string;
}> {
  return handle.db
    .query(
      "SELECT id, count(*) AS count FROM schema_migrations GROUP BY id ORDER BY id",
    )
    .all() as Array<{ count: number; id: string }>;
}

function assertOpenSideEffects(handle: VibeDatabase): void {
  const journalMode = handle.db.query("PRAGMA journal_mode").get() as {
    journal_mode: string;
  };
  const busyTimeout = handle.db.query("PRAGMA busy_timeout").get() as {
    timeout: number;
  };
  const legacyImportsTable = handle.db
    .query(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'legacy_imports'",
    )
    .get() as { name: string } | null;

  expect(journalMode.journal_mode).toBe("wal");
  expect(busyTimeout.timeout).toBe(5000);
  expect(legacyImportsTable).toEqual({ name: "legacy_imports" });
}

function expectReportKeys(report: object): void {
  expect(Object.keys(report).sort()).toEqual([
    "applied",
    "pending",
    "ranAt",
    "status",
  ]);
}

function seedInitialMigrationOnly(databasePath: string): void {
  const db = new Database(databasePath, { create: true });
  try {
    db.exec(`
      CREATE TABLE schema_migrations (
        id TEXT PRIMARY KEY,
        applied_at TEXT NOT NULL
      );

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

      INSERT INTO schema_migrations (id, applied_at)
      VALUES ('001_initial_schema', '2026-01-01T00:00:00.000Z');
    `);
  } finally {
    db.close();
  }
}

function seedDuplicateDisplayCwdFailure(databasePath: string): void {
  seedInitialMigrationOnly(databasePath);
  const db = new Database(databasePath, { create: true });
  try {
    db.exec("ALTER TABLE sessions ADD COLUMN cwd TEXT;");
  } finally {
    db.close();
  }
}

describe("withDatabase", () => {
  test("creates and closes a handle when called with options", async () => {
    const databasePath = await tempDatabasePath("withdb");
    let ran = false;

    withDatabase(
      (db) => {
        ran = true;
        db.exec(
          "CREATE TABLE IF NOT EXISTS test_table (id INTEGER PRIMARY KEY)",
        );
      },
      { path: databasePath },
    );

    expect(ran).toBe(true);
    // Verify the handle was closed by re-opening and checking the table exists
    const reopened = openTracked(databasePath);
    const table = reopened.db
      .query(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='test_table'",
      )
      .get() as { name: string } | null;
    expect(table).toEqual({ name: "test_table" });
  });

  test("closes the handle in finally when function throws", async () => {
    const databasePath = await tempDatabasePath("withdb-throw");

    expect(() =>
      withDatabase(
        () => {
          throw new Error("fn error");
        },
        { path: databasePath },
      ),
    ).toThrow("fn error");

    // Verify the handle was closed — re-open should succeed without lock
    const reopened = openTracked(databasePath);
    const journalMode = reopened.db.query("PRAGMA journal_mode").get() as {
      journal_mode: string;
    };
    expect(journalMode.journal_mode).toBe("wal");
  });

  test("uses singleton and does not close when called without options", async () => {
    await useTempHome();

    withDatabase((db) => {
      db.exec(
        "CREATE TABLE IF NOT EXISTS singleton_test (id INTEGER PRIMARY KEY)",
      );
    });

    // Singleton must still be open — verify by reading back through getVibeDatabase
    const handle = getVibeDatabase();
    const table = handle.db
      .query(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='singleton_test'",
      )
      .get() as { name: string } | null;
    expect(table).toEqual({ name: "singleton_test" });
  });
});

describe("getVibeDatabase", () => {
  test("first call creates a singleton with functional schema", async () => {
    const home = await useTempHome();
    const handle = getVibeDatabase();

    expect(handle.path).toBe(join(home.dataRoot, DATABASE_FILENAME));
    const tables = handle.db
      .query(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='sessions'",
      )
      .get() as { name: string } | null;
    expect(tables).toEqual({ name: "sessions" });
  });

  test("same path returns identical singleton", async () => {
    await useTempHome();
    const first = getVibeDatabase();
    const second = getVibeDatabase();

    expect(first).toBe(second);
  });

  test("path change closes old singleton and opens new at updated path", async () => {
    const home1 = await useTempHome();
    const first = getVibeDatabase();
    const firstPath = first.path;

    first.db
      .prepare(
        "INSERT INTO sessions (id, cwd_key, created_at, last_accessed_at) VALUES (?, ?, ?, ?)",
      )
      .run(
        "s1",
        "cwd1",
        "2026-01-01T00:00:00.000Z",
        "2026-01-01T00:00:00.000Z",
      );

    // Switch to a different data root via HOME
    await home1.cleanup();
    homes.splice(homes.indexOf(home1), 1);
    const home2 = await useTempHome();
    const second = getVibeDatabase();

    expect(second.path).not.toBe(firstPath);
    expect(second.path).toBe(join(home2.dataRoot, DATABASE_FILENAME));

    // Old handle must be closed
    expect(() => first.db.query("SELECT 1").get()).toThrow();

    // New database must be independent (no sessions carried over)
    const count = second.db
      .query("SELECT count(*) AS count FROM sessions")
      .get() as { count: number };
    expect(count.count).toBe(0);
  });
});

describe("openVibeDatabase", () => {
  test("returns cached handle when opened twice at same file path", async () => {
    const databasePath = await tempDatabasePath("cached");
    const first = openVibeDatabase({ path: databasePath });
    handles.push(first);

    // Second open at same path — should return cached handle (lines 216-219)
    const second = openVibeDatabase({ path: databasePath });
    handles.push(second);

    expect(first).toBe(second);
    // Both should share the same database state
    first.db
      .prepare(
        "INSERT INTO sessions (id, cwd_key, created_at, last_accessed_at) VALUES (?, ?, ?, ?)",
      )
      .run(
        "cached-test",
        "cached-cwd",
        "2026-01-01T00:00:00.000Z",
        "2026-01-01T00:00:00.000Z",
      );
    const count = second.db
      .query("SELECT count(*) AS count FROM sessions")
      .get() as { count: number };
    expect(count.count).toBe(1);
  });

  test("opens the default database under the vibe data root", async () => {
    const home = await useTempHome();
    const handle = openTracked();

    expect(getDatabasePath()).toBe(join(home.dataRoot, DATABASE_FILENAME));
    expect(handle.path).toBe(join(home.dataRoot, DATABASE_FILENAME));

    const journalMode = handle.db.query("PRAGMA journal_mode").get() as {
      journal_mode: string;
    };
    expect(journalMode.journal_mode).toBe("wal");
  });

  test("supports isolated file databases", async () => {
    const first = openTracked(await tempDatabasePath("first"));
    const second = openTracked(await tempDatabasePath("second"));

    first.db
      .prepare(
        "INSERT INTO sessions (id, cwd_key, created_at, last_accessed_at) VALUES (?, ?, ?, ?)",
      )
      .run(
        "session-a",
        "cwd",
        "2026-01-01T00:00:00.000Z",
        "2026-01-01T00:00:00.000Z",
      );

    const firstCount = first.db
      .query("SELECT count(*) AS count FROM sessions")
      .get() as { count: number };
    const secondCount = second.db
      .query("SELECT count(*) AS count FROM sessions")
      .get() as { count: number };

    expect(firstCount.count).toBe(1);
    expect(secondCount.count).toBe(0);
  });

  test("supports isolated in-memory databases", () => {
    const first = openTracked(":memory:");
    const second = openTracked(":memory:");

    first.db
      .prepare(
        "INSERT INTO sessions (id, cwd_key, created_at, last_accessed_at) VALUES (?, ?, ?, ?)",
      )
      .run(
        "session-a",
        "cwd",
        "2026-01-01T00:00:00.000Z",
        "2026-01-01T00:00:00.000Z",
      );

    const firstCount = first.db
      .query("SELECT count(*) AS count FROM sessions")
      .get() as { count: number };
    const secondCount = second.db
      .query("SELECT count(*) AS count FROM sessions")
      .get() as { count: number };

    expect(firstCount.count).toBe(1);
    expect(secondCount.count).toBe(0);
  });

  test("records migrations idempotently", async () => {
    const databasePath = await tempDatabasePath("migrations");
    const first = openTracked(databasePath);
    const initial = readMigrationIds(first);
    closeTracked(first);

    const second = openTracked(databasePath);
    const repeated = readMigrationIds(second);

    expect(initial).toEqual(EXPECTED_MIGRATION_IDS);
    expect(repeated).toEqual(initial);
  });

  test("persists migration report state across repeated reopen cycles", async () => {
    const databasePath = await tempDatabasePath("migration-lifecycle");
    const expectedCounts = EXPECTED_MIGRATION_IDS.map((id) => ({
      count: 1,
      id,
    }));
    const first = openTracked(databasePath);

    expect(readMigrationIds(first)).toEqual(EXPECTED_MIGRATION_IDS);
    expect(readMigrationCounts(first)).toEqual(expectedCounts);
    assertOpenSideEffects(first);
    closeTracked(first);

    const second = openTracked(databasePath);

    expect(readMigrationIds(second)).toEqual(EXPECTED_MIGRATION_IDS);
    expect(readMigrationCounts(second)).toEqual(expectedCounts);
    assertOpenSideEffects(second);
    closeTracked(second);

    const third = openTracked(databasePath);

    expect(readMigrationIds(third)).toEqual(EXPECTED_MIGRATION_IDS);
    expect(readMigrationCounts(third)).toEqual(expectedCounts);
    assertOpenSideEffects(third);
  });

  test("reports fresh database migrations from one invocation", async () => {
    const databasePath = await tempDatabasePath("migration-report-fresh");
    const { database, report } = openVibeDatabaseWithMigrationReport({
      path: databasePath,
    });
    handles.push(database);

    expectReportKeys(report);
    expect(report).toEqual({
      applied: EXPECTED_MIGRATION_IDS,
      pending: EXPECTED_MIGRATION_IDS,
      ranAt: report.ranAt,
      status: "migrated",
    });
    expect(Date.parse(report.ranAt)).not.toBeNaN();
    expect(readMigrationIds(database)).toEqual(EXPECTED_MIGRATION_IDS);
  });

  test("reports current databases without pending migrations", async () => {
    const databasePath = await tempDatabasePath("migration-report-current");
    const first = openTracked(databasePath);
    closeTracked(first);

    const { database, report } = openVibeDatabaseWithMigrationReport({
      path: databasePath,
    });
    handles.push(database);

    expectReportKeys(report);
    expect(report).toEqual({
      applied: EXPECTED_MIGRATION_IDS,
      pending: [],
      ranAt: report.ranAt,
      status: "up-to-date",
    });
    expect(Date.parse(report.ranAt)).not.toBeNaN();
  });

  test("reports partially migrated databases with only invocation migrations pending", async () => {
    const databasePath = await tempDatabasePath("migration-report-partial");
    seedInitialMigrationOnly(databasePath);

    const { database, report } = openVibeDatabaseWithMigrationReport({
      path: databasePath,
    });
    handles.push(database);

    expect(report.applied).toEqual(EXPECTED_MIGRATION_IDS);
    expect(report.pending).toEqual(EXPECTED_MIGRATION_IDS.slice(1));
    expect(report.status).toBe("migrated");
  });

  test("rolls back failed migration reports without partial success", async () => {
    const databasePath = await tempDatabasePath("migration-report-failure");
    seedDuplicateDisplayCwdFailure(databasePath);

    expect(() =>
      openVibeDatabaseWithMigrationReport({ path: databasePath }),
    ).toThrow();

    const db = new Database(databasePath, { create: true });
    try {
      const ids = db
        .query("SELECT id FROM schema_migrations ORDER BY id")
        .all() as Array<{ id: string }>;
      expect(ids.map(({ id }) => id)).toEqual(["001_initial_schema"]);
    } finally {
      db.close();
    }
  });

  test("exposes canonical migration ids in order", () => {
    expect(getMigrationIds()).toEqual(EXPECTED_MIGRATION_IDS);
  });

  test("reopens file databases after explicit close", async () => {
    const databasePath = await tempDatabasePath("lifecycle");
    const first = openTracked(databasePath);
    first.db
      .prepare(
        "INSERT INTO sessions (id, cwd_key, created_at, last_accessed_at) VALUES (?, ?, ?, ?)",
      )
      .run(
        "session-a",
        "cwd",
        "2026-01-01T00:00:00.000Z",
        "2026-01-01T00:00:00.000Z",
      );
    closeTracked(first);

    const second = openTracked(databasePath);
    const sessions = second.db
      .query("SELECT id FROM sessions ORDER BY id")
      .all() as Array<{ id: string }>;
    const migrations = readMigrationIds(second);

    expect(sessions).toEqual([{ id: "session-a" }]);
    expect(migrations).toEqual(EXPECTED_MIGRATION_IDS);
  });

  test("enforces one session per CWD key", () => {
    const handle = openTracked(":memory:");
    const insert = handle.db.prepare(
      "INSERT INTO sessions (id, cwd_key, created_at, last_accessed_at) VALUES (?, ?, ?, ?)",
    );

    insert.run(
      "session-a",
      "same-cwd",
      "2026-01-01T00:00:00.000Z",
      "2026-01-01T00:00:00.000Z",
    );

    expect(() =>
      insert.run(
        "session-b",
        "same-cwd",
        "2026-01-01T00:00:00.000Z",
        "2026-01-01T00:00:00.000Z",
      ),
    ).toThrow();
  });

  test("supports session-bound cleanup through cascades", () => {
    const handle = openTracked(":memory:");
    handle.db
      .prepare(
        "INSERT INTO sessions (id, cwd_key, created_at, last_accessed_at) VALUES (?, ?, ?, ?)",
      )
      .run(
        "session-a",
        "cwd-a",
        "2026-01-01T00:00:00.000Z",
        "2026-01-01T00:00:00.000Z",
      );
    handle.db
      .prepare(
        "INSERT INTO constitution_rules (session_id, rule, position, created_at) VALUES (?, ?, ?, ?)",
      )
      .run("session-a", "rule", 0, "2026-01-01T00:00:00.000Z");
    handle.db
      .prepare(
        "INSERT INTO interactions (session_id, goal, output, timestamp) VALUES (?, ?, ?, ?)",
      )
      .run("session-a", "goal", "output", 1);

    handle.db.prepare("DELETE FROM sessions WHERE id = ?").run("session-a");

    const ruleCount = handle.db
      .query("SELECT count(*) AS count FROM constitution_rules")
      .get() as { count: number };
    const interactionCount = handle.db
      .query("SELECT count(*) AS count FROM interactions")
      .get() as { count: number };

    expect(ruleCount.count).toBe(0);
    expect(interactionCount.count).toBe(0);
  });

  test("orders constitution rules deterministically by position", () => {
    const handle = openTracked(":memory:");
    handle.db
      .prepare(
        "INSERT INTO sessions (id, cwd_key, created_at, last_accessed_at) VALUES (?, ?, ?, ?)",
      )
      .run(
        "session-a",
        "cwd-a",
        "2026-01-01T00:00:00.000Z",
        "2026-01-01T00:00:00.000Z",
      );
    const insertRule = handle.db.prepare(
      "INSERT INTO constitution_rules (session_id, rule, position, created_at) VALUES (?, ?, ?, ?)",
    );
    insertRule.run("session-a", "second", 1, "2026-01-01T00:00:00.000Z");
    insertRule.run("session-a", "first", 0, "2026-01-01T00:00:00.000Z");

    const rules = handle.db
      .query(
        "SELECT rule FROM constitution_rules WHERE session_id = ? ORDER BY position ASC",
      )
      .all("session-a") as Array<{ rule: string }>;

    expect(rules.map((entry) => entry.rule)).toEqual(["first", "second"]);
  });

  test("skips legacy imports when legacyImports is none", async () => {
    const home = await useTempHome();
    const handle = openVibeDatabase({ legacyImports: "none" });
    handles.push(handle);

    expect(handle.path).toBe(join(home.dataRoot, DATABASE_FILENAME));
    expect(readMigrationIds(handle)).toEqual(EXPECTED_MIGRATION_IDS);
    assertOpenSideEffects(handle);

    // Database must be fully functional without legacy import side effects
    handle.db
      .prepare(
        "INSERT INTO sessions (id, cwd_key, created_at, last_accessed_at) VALUES (?, ?, ?, ?)",
      )
      .run(
        "s1",
        "cwd1",
        "2026-01-01T00:00:00.000Z",
        "2026-01-01T00:00:00.000Z",
      );
    const count = handle.db
      .query("SELECT count(*) AS count FROM sessions")
      .get() as { count: number };
    expect(count.count).toBe(1);
  });

  test("skips legacy imports with report when legacyImports is none", async () => {
    const home = await useTempHome();
    const { database, report } = openVibeDatabaseWithMigrationReport({
      legacyImports: "none",
    });
    handles.push(database);

    expect(database.path).toBe(join(home.dataRoot, DATABASE_FILENAME));
    expectReportKeys(report);
    expect(report).toEqual({
      applied: EXPECTED_MIGRATION_IDS,
      pending: EXPECTED_MIGRATION_IDS,
      ranAt: report.ranAt,
      status: "migrated",
    });
  });

  test("custom path with legacyImports none opens isolated database", async () => {
    const databasePath = await tempDatabasePath("legacy-none-custom");
    const handle = openVibeDatabase({
      path: databasePath,
      legacyImports: "none",
    });
    handles.push(handle);

    expect(handle.path).toBe(databasePath);
    expect(readMigrationIds(handle)).toEqual(EXPECTED_MIGRATION_IDS);
    assertOpenSideEffects(handle);
  });

  test("reports fresh migrations on in-memory databases", () => {
    const { database, report } = openVibeDatabaseWithMigrationReport({
      path: ":memory:",
    });
    handles.push(database);

    expectReportKeys(report);
    expect(report).toEqual({
      applied: EXPECTED_MIGRATION_IDS,
      pending: EXPECTED_MIGRATION_IDS,
      ranAt: report.ranAt,
      status: "migrated",
    });
    expect(Date.parse(report.ranAt)).not.toBeNaN();
    expect(readMigrationIds(database)).toEqual(EXPECTED_MIGRATION_IDS);
  });

  test("reports up-to-date when returning cached handle via report variant", async () => {
    const databasePath = await tempDatabasePath("cached-report");

    const first = openVibeDatabase({ path: databasePath });
    handles.push(first);

    const { database, report } = openVibeDatabaseWithMigrationReport({
      path: databasePath,
    });
    handles.push(database);

    expect(database).toBe(first);
    expectReportKeys(report);
    expect(report).toEqual({
      applied: EXPECTED_MIGRATION_IDS,
      pending: [],
      ranAt: report.ranAt,
      status: "up-to-date",
    });
    expect(Date.parse(report.ranAt)).not.toBeNaN();
  });

  test("getVibeDatabase singleton is isolated from openVibeDatabase cache", async () => {
    const home = await useTempHome();

    const singleton = getVibeDatabase();
    const independent = openVibeDatabase();
    handles.push(independent);

    // Must be different handle objects — getVibeDatabase evicts from cache
    expect(independent).not.toBe(singleton);

    // Both must point to the same database file
    expect(independent.path).toBe(singleton.path);
    expect(singleton.path).toBe(join(home.dataRoot, DATABASE_FILENAME));

    // Writes through the singleton must be visible through the independent handle
    singleton.db
      .prepare(
        "INSERT INTO sessions (id, cwd_key, created_at, last_accessed_at) VALUES (?, ?, ?, ?)",
      )
      .run(
        "isolation-test",
        "iso-cwd",
        "2026-01-01T00:00:00.000Z",
        "2026-01-01T00:00:00.000Z",
      );

    const count = independent.db
      .query("SELECT count(*) AS count FROM sessions")
      .get() as { count: number };
    expect(count.count).toBe(1);

    // Writes through the independent handle must be visible through the singleton
    independent.db
      .prepare(
        "INSERT INTO sessions (id, cwd_key, created_at, last_accessed_at) VALUES (?, ?, ?, ?)",
      )
      .run(
        "isolation-test-2",
        "iso-cwd-2",
        "2026-01-01T00:00:00.000Z",
        "2026-01-01T00:00:00.000Z",
      );

    const totalCount = singleton.db
      .query("SELECT count(*) AS count FROM sessions")
      .get() as { count: number };
    expect(totalCount.count).toBe(2);
  });
});
