import { Database } from "bun:sqlite";
import fs from "node:fs";
import path from "node:path";
import { ensureDataDir } from "./db-core.js";
import {
  getLegacyArtifactPath,
  importAllLegacyData,
} from "./legacyImporter.js";
import { retryOnTransientSqliteError } from "./sqliteRetry.js";

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
 * Callers needing independent lifecycle control (e.g., createPruneDatabaseBackup)
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
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
  `);

  const appliedAt = ranAt ?? new Date().toISOString();
  const pending: string[] = [];
  const insertMigration = db.prepare(
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
        db.exec(migration.sql);
        insertMigration.run(migration.id, appliedAt);
      })();
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

  db.exec(`
    CREATE TABLE IF NOT EXISTS legacy_imports (
      artifact TEXT PRIMARY KEY,
      imported_at TEXT NOT NULL,
      backup_path TEXT NOT NULL
    );
  `);

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

  return retryOnTransientSqliteError(() =>
    openDatabaseOnce(databasePath, options, captureReport),
  );
}

function openDatabaseOnce(
  databasePath: string,
  options: VibeDatabaseOptions,
  captureReport: boolean,
): VibeDatabaseMigrationResult {
  const db = new Database(databasePath, { create: true });
  try {
    db.exec("PRAGMA busy_timeout = 5000");
    db.exec("PRAGMA foreign_keys = ON");
    if (databasePath !== ":memory:") db.exec("PRAGMA journal_mode = WAL");
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

function readAppliedMigrationIds(db: Database): string[] {
  const rows = db
    .query("SELECT id FROM schema_migrations ORDER BY id")
    .all() as Array<{ id: string }>;
  return rows.map(({ id }) => id);
}
