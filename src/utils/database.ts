import { Database } from "bun:sqlite";
import fs from "node:fs";
import path from "node:path";
import { ensureDataDir } from "./db-core.js";
import {
  getLegacyArtifactPath,
  importAllLegacyData,
} from "./legacyImporter.js";

export const DATABASE_FILENAME = "vibe.db";

export interface VibeDatabaseOptions {
  path?: string;
  legacyImports?: "all" | "none";
}

export interface VibeDatabase {
  db: Database;
  path: string;
  close: () => void;
}

export type MigrationStatus = "migrated" | "up-to-date";

export interface MigrationReport {
  applied: string[];
  pending: string[];
  ranAt: string;
  status: MigrationStatus;
}

export interface VibeDatabaseMigrationResult {
  database: VibeDatabase;
  report: MigrationReport;
}

export function withDatabase<T>(
  fn: (db: Database) => T,
  options?: VibeDatabaseOptions,
): T {
  const handle =
    options !== undefined ? openVibeDatabase(options) : getVibeDatabase();
  try {
    // Concurrent processes share this WAL-mode file. Write transactions begin
    // IMMEDIATE so lock contention waits on busy_timeout; a deferred
    // read-then-write upgrade skips the busy handler and fails fast with
    // SQLITE_BUSY or SQLITE_BUSY_SNAPSHOT.
    return fn(handle.db);
  } finally {
    if (options !== undefined) {
      handle.close();
    }
  }
}

const cachedHandles = new Map<string, VibeDatabase>();

let singletonHandle: VibeDatabase | null = null;

/**
 * Returns a process-lifetime database singleton for normal operations.
 * Callers needing independent lifecycle control (e.g., prune backups)
 * should use openVibeDatabase() directly.
 */
export function getVibeDatabase(): VibeDatabase {
  const currentPath = getDatabasePath();
  if (singletonHandle?.path !== currentPath) {
    if (singletonHandle) {
      try {
        singletonHandle.db.close();
      } catch {
        // ignore close errors on orphaned path
      }
    }
    singletonHandle = openVibeDatabase();
    // Detach from the shared cache so openVibeDatabase() callers get
    // independent handles without sharing the singleton's connection.
    cachedHandles.delete(singletonHandle.path);
  }
  return singletonHandle;
}

const MIGRATIONS = [
  {
    id: "001_initial_schema",
    sql: `
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        cwd_key TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL,
        last_accessed_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_sessions_last_accessed_at
        ON sessions(last_accessed_at);

      CREATE TABLE IF NOT EXISTS learning_entries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        type TEXT NOT NULL CHECK (type IN ('mistake', 'preference', 'success')),
        category TEXT NOT NULL,
        mistake TEXT NOT NULL,
        solution TEXT,
        timestamp INTEGER NOT NULL,
        demo_id TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_learning_entries_category_timestamp
        ON learning_entries(category, timestamp);

      CREATE INDEX IF NOT EXISTS idx_learning_entries_demo_id
        ON learning_entries(demo_id)
        WHERE demo_id IS NOT NULL;

      CREATE TABLE IF NOT EXISTS constitution_rules (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        rule TEXT NOT NULL,
        position INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(session_id, position)
      );

      CREATE INDEX IF NOT EXISTS idx_constitution_rules_session_position
        ON constitution_rules(session_id, position);

      CREATE TABLE IF NOT EXISTS interactions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        goal TEXT NOT NULL,
        output TEXT NOT NULL,
        timestamp INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_interactions_session_timestamp
        ON interactions(session_id, timestamp);
    `,
  },
  {
    id: "002_sessions_display_cwd",
    sql: "ALTER TABLE sessions ADD COLUMN cwd TEXT;",
  },
  {
    id: "003_rename_mistake_to_observation",
    sql: "ALTER TABLE learning_entries RENAME COLUMN mistake TO observation;",
  },
];

export function getDatabasePath(): string {
  return getLegacyArtifactPath(DATABASE_FILENAME);
}

export function getMigrationIds(): string[] {
  return MIGRATIONS.map(({ id }) => id);
}

/**
 * SQL for one migration id. Callers materializing historical schema states
 * execute the migration's exact DDL instead of copying it, so fixtures can
 * never drift from the schema they claim to reproduce.
 */
export function getMigrationSql(id: string): string {
  const migration = MIGRATIONS.find((entry) => entry.id === id);
  if (migration === undefined) {
    throw new Error(`unknown migration id: ${id}`);
  }
  return migration.sql;
}

/** Lock contention waits this long before a write transaction fails busy. */
const SQLITE_BUSY_TIMEOUT_MS = 5000;

/** Busy-timeout value that makes lock contention fail fast instead of waiting. */
export const SQLITE_BUSY_TIMEOUT_DISABLED = 0;

/** Apply the connection's `busy_timeout` pragma. */
export function applyBusyTimeout(db: Database, timeoutMs: number): void {
  db.run(`PRAGMA busy_timeout = ${timeoutMs}`);
}

/**
 * Enforce the invariants every vibe connection shares: foreign-key
 * enforcement on, lock contention waiting out busy_timeout.
 */
export function configureConnection(db: Database): void {
  db.run("PRAGMA foreign_keys = ON");
  applyBusyTimeout(db, SQLITE_BUSY_TIMEOUT_MS);
}

export function openVibeDatabase(
  options: VibeDatabaseOptions = {},
): VibeDatabase {
  return openDatabase(options).database;
}

export function openVibeDatabaseWithMigrationReport(
  options: VibeDatabaseOptions = {},
): VibeDatabaseMigrationResult {
  return openDatabase(options, true);
}

export function initializeSchema(db: Database, ranAt?: string): string[] {
  db.run(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
  `);

  const pending = applyPendingMigrations(db, ranAt ?? new Date().toISOString());

  db.run(`
    CREATE TABLE IF NOT EXISTS legacy_imports (
      artifact TEXT PRIMARY KEY,
      imported_at TEXT NOT NULL,
      backup_path TEXT NOT NULL
    );
  `);

  return pending;
}

/**
 * Apply each migration missing from `schema_migrations`, returning the ids
 * applied now. Each migration commits in its own transaction so a concurrent
 * winner between the existence check and the DDL is detected on failure and
 * treated as already applied.
 */
function applyPendingMigrations(db: Database, appliedAt: string): string[] {
  const pending: string[] = [];
  const insertMigration = db.query(
    "INSERT OR IGNORE INTO schema_migrations (id, applied_at) VALUES (?, ?)",
  );

  for (const migration of MIGRATIONS) {
    // Read the latest committed state outside any transaction so we see
    // migrations applied by concurrent processes.
    const alreadyApplied = db
      .query("SELECT 1 FROM schema_migrations WHERE id = ? LIMIT 1")
      .get(migration.id);
    if (alreadyApplied) continue;

    try {
      // Apply the migration in its own transaction for atomicity.
      db.transaction(() => {
        db.run(migration.sql);
        insertMigration.run(migration.id, appliedAt);
      }).immediate();
      pending.push(migration.id);
    } catch (err) {
      // A concurrent process may have applied this migration between our
      // schema_migrations check and the DDL execution. Re-check the
      // committed state; if the migration now exists, treat it as already
      // applied by the concurrent winner.
      const nowApplied = db
        .query("SELECT 1 FROM schema_migrations WHERE id = ? LIMIT 1")
        .get(migration.id);
      if (nowApplied) continue;
      throw err;
    }
  }

  return pending;
}

function openDatabase(
  options: VibeDatabaseOptions,
  captureReport = false,
): VibeDatabaseMigrationResult {
  const databasePath = options.path ?? getDatabasePath();
  if (databasePath !== ":memory:") {
    if (options.path === undefined) {
      ensureDataDir();
    } else {
      fs.mkdirSync(path.dirname(databasePath), { recursive: true });
    }
  }

  const cached = cachedHandles.get(databasePath);
  if (cached && databasePath !== ":memory:") {
    return {
      database: cached,
      report: createMigrationReport(cached.db, [], new Date().toISOString()),
    };
  }

  return connectDatabase(databasePath, options, captureReport);
}

function connectDatabase(
  databasePath: string,
  options: VibeDatabaseOptions,
  captureReport: boolean,
): VibeDatabaseMigrationResult {
  const db = new Database(databasePath, { create: true });
  try {
    configureConnection(db);
    if (databasePath !== ":memory:") enableWriteAheadLog(db);
    const ranAt = new Date().toISOString();
    const pending = initializeSchema(db, ranAt);
    const legacyImports = options.legacyImports ?? "all";
    if (options.path === undefined && legacyImports === "all")
      importAllLegacyData(db);

    const handle: VibeDatabase = {
      db,
      path: databasePath,
      close: () => {
        db.close();
        cachedHandles.delete(databasePath);
      },
    };
    if (databasePath !== ":memory:") cachedHandles.set(databasePath, handle);
    return {
      database: handle,
      report: createMigrationReport(db, captureReport ? pending : [], ranAt),
    };
  } catch (error) {
    db.close();
    throw error;
  }
}

const WAL_ATTEMPTS = 3;

/**
 * Converting a fresh file to WAL upgrades a read lock to a write lock inside
 * SQLite, a path that skips the busy handler, so concurrent first opens fail
 * fast with SQLITE_BUSY. BEGIN IMMEDIATE waits out the competing writer on
 * busy_timeout; its conversion persists in the file header, so the next
 * attempt finds WAL already set.
 */
function enableWriteAheadLog(db: Database): void {
  for (let attempt = 1; ; attempt++) {
    try {
      db.run("PRAGMA journal_mode = WAL");
      return;
    } catch (error) {
      if (attempt === WAL_ATTEMPTS || !isSqliteBusy(error)) throw error;
      db.run("BEGIN IMMEDIATE");
      db.run("ROLLBACK");
    }
  }
}

function isSqliteBusy(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === "SQLITE_BUSY";
}

function createMigrationReport(
  db: Database,
  pending: string[],
  ranAt: string,
): MigrationReport {
  const applied = readAppliedMigrationIds(db);
  return {
    applied,
    pending,
    ranAt,
    status: pending.length > 0 ? "migrated" : "up-to-date",
  };
}

/**
 * Read applied migration ids in schema order; an unbootstrapped database
 * without a `schema_migrations` table reports none applied.
 */
export function readAppliedMigrationIds(db: Database): string[] {
  const table = db
    .query(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'",
    )
    .get();
  if (table === null) return [];
  return db
    .query<{ id: string }, []>("SELECT id FROM schema_migrations ORDER BY id")
    .all()
    .map((row) => row.id);
}
