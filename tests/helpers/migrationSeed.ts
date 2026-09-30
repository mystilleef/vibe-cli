/**
 * Partially-migrated database fixtures shared by suites: one source for the
 * `schema_migrations` seed and the materialized first-migration schema so
 * legacy-state setups cannot drift between tests or from the migration SQL
 * they reproduce. Callers own connection lifecycle.
 */

import type { Database } from "bun:sqlite";
import { getMigrationIds, getMigrationSql } from "../../src/utils/database";

/** Fixed `applied_at` stamped for seeded migration records. */
const DEFAULT_SEED_APPLIED_AT = "2026-01-01T00:00:00.000Z";

/**
 * Create `schema_migrations` and record `appliedIds` at `appliedAt`. Tests
 * asserting recency pass their own timestamp.
 */
export function seedSchemaMigrations(
  db: Database,
  appliedIds: readonly string[],
  appliedAt: string = DEFAULT_SEED_APPLIED_AT,
): void {
  db.exec(`
    CREATE TABLE schema_migrations (
      id TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
  `);
  const insert = db.prepare(
    "INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)",
  );
  for (const id of appliedIds) {
    insert.run(id, appliedAt);
  }
}

/**
 * Seed the canonical partially migrated state: the first migration recorded
 * as applied with its exact DDL materialized, later migrations truly pending.
 */
export function seedInitialMigration(
  db: Database,
  appliedAt: string = DEFAULT_SEED_APPLIED_AT,
): void {
  const [initialId] = getMigrationIds();
  if (initialId === undefined) {
    throw new Error("no migrations registered");
  }
  seedSchemaMigrations(db, [initialId], appliedAt);
  db.exec(getMigrationSql(initialId));
}
