import { Database } from "bun:sqlite";
import fs from "node:fs";
import path from "node:path";
import { ensureDataDir } from "./autosession.js";
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

export function withDatabase<T>(
  fn: (db: Database) => T,
  options?: VibeDatabaseOptions,
): T {
  const handle = openVibeDatabase(options);
  try {
    return fn(handle.db);
  } finally {
    handle.close();
  }
}

const cachedHandles = new Map<string, VibeDatabase>();

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
] as const;

export function getDatabasePath(): string {
  return getLegacyArtifactPath(DATABASE_FILENAME);
}

export function openVibeDatabase(
  options: VibeDatabaseOptions = {},
): VibeDatabase {
  const databasePath = options.path ?? getDatabasePath();
  if (databasePath !== ":memory:") {
    if (options.path === undefined) {
      ensureDataDir();
    } else {
      fs.mkdirSync(path.dirname(databasePath), { recursive: true });
    }
  }

  const cached = cachedHandles.get(databasePath);
  if (cached && databasePath !== ":memory:") return cached;

  const db = new Database(databasePath, { create: true });
  db.exec("PRAGMA foreign_keys = ON");
  if (databasePath !== ":memory:") db.exec("PRAGMA journal_mode = WAL");
  initializeSchema(db);
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
  return handle;
}

export function initializeSchema(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
  `);

  const insertMigration = db.prepare(
    "INSERT OR IGNORE INTO schema_migrations (id, applied_at) VALUES (?, ?)",
  );

  db.transaction(() => {
    for (const migration of MIGRATIONS) {
      const applied = db
        .query("SELECT 1 FROM schema_migrations WHERE id = ? LIMIT 1")
        .get(migration.id);
      if (applied) continue;
      db.exec(migration.sql);
      insertMigration.run(migration.id, new Date().toISOString());
    }
  })();

  db.exec(`
    CREATE TABLE IF NOT EXISTS legacy_imports (
      artifact TEXT PRIMARY KEY,
      imported_at TEXT NOT NULL,
      backup_path TEXT NOT NULL
    );
  `);
}
