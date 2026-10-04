/**
 * Shared fixtures for the doctor test suites: a migrated database in the
 * active temp home and recorded legacy-import rows. Binding goes through a
 * data-root accessor so each test's `beforeEach` home assignment remains the
 * single source of the fixture location.
 */
import { Database } from "bun:sqlite";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { initializeSchema } from "../../src/utils/database.js";
import { formatBackupTimestampLabel } from "../../src/utils/databaseBackup.js";
import type { DoctorSection } from "../../src/utils/doctorSql.js";

/** Successful doctor section carrying `value`. */
export function sectionOk<T>(value: T): DoctorSection<T> {
  return { ok: true, value };
}

/** Failed doctor section carrying `error`. */
export function sectionFail<T>(error: string): DoctorSection<T> {
  return { ok: false, error };
}

/** Timestamp every recorded legacy row carries. */
const LEGACY_IMPORTED_AT = "2026-01-01T00:00:00.000Z";

export interface DoctorFixtures {
  /** Path of the vibe database inside the active data root. */
  databasePath(): string;
  /**
   * Create a migrated database and run `seed` over its open connection.
   * Resolves with the database path.
   */
  seedDatabase(seed?: (db: Database) => void): Promise<string>;
  /** Record one legacy import row over an already-open connection. */
  insertLegacyRecord(db: Database, artifact: string, backupPath: string): void;
  /** Record one legacy import row, opening and closing the database. */
  seedLegacyRecord(artifact: string, backupPath: string): void;
  /** Freelist page count of the fixture database. */
  readFreelistCount(): number;
  /**
   * Seed orphan rows with foreign-key enforcement off: `ruleCount`
   * constitution rules and `interactionCount` interactions anchored to a
   * session that does not exist.
   */
  seedForeignKeyViolations(ruleCount?: number, interactionCount?: number): void;
}

export function createDoctorFixtures(
  resolveDataRoot: () => string,
): DoctorFixtures {
  const databasePath = (): string => join(resolveDataRoot(), "vibe.db");

  const insertLegacyRecord = (
    db: Database,
    artifact: string,
    backupPath: string,
  ): void => {
    db.prepare(
      "INSERT INTO legacy_imports (artifact, imported_at, backup_path) VALUES (?, ?, ?)",
    ).run(artifact, LEGACY_IMPORTED_AT, backupPath);
  };

  return {
    databasePath,
    async seedDatabase(seed: (db: Database) => void = () => {}) {
      await mkdir(resolveDataRoot(), { recursive: true });
      const db = new Database(databasePath());
      try {
        initializeSchema(db);
        seed(db);
      } finally {
        db.close();
      }
      return databasePath();
    },
    insertLegacyRecord,
    seedLegacyRecord(artifact: string, backupPath: string): void {
      const db = new Database(databasePath());
      try {
        insertLegacyRecord(db, artifact, backupPath);
      } finally {
        db.close();
      }
    },
    readFreelistCount(): number {
      const db = new Database(databasePath(), {
        readonly: true,
        create: false,
      });
      try {
        return (
          db.query("PRAGMA freelist_count").get() as {
            freelist_count: number;
          }
        ).freelist_count;
      } finally {
        db.close();
      }
    },
    seedForeignKeyViolations(ruleCount = 1, interactionCount = 0): void {
      const db = new Database(databasePath());
      try {
        db.run("PRAGMA foreign_keys = OFF");
        const insertRule = db.prepare(
          "INSERT INTO constitution_rules (session_id, rule, position, created_at) VALUES (?, ?, ?, ?)",
        );
        const insertInteraction = db.prepare(
          "INSERT INTO interactions (session_id, goal, output, timestamp) VALUES (?, ?, ?, ?)",
        );
        // One commit: per-row autocommit fsyncs block the test worker on disk.
        db.transaction(() => {
          for (let index = 0; index < ruleCount; index += 1) {
            insertRule.run(
              "ghost",
              `orphan ${index}`,
              index,
              "2026-01-01T00:00:00.000Z",
            );
          }
          for (let index = 0; index < interactionCount; index += 1) {
            insertInteraction.run(
              "ghost",
              `orphan ${index}`,
              `orphan ${index}`,
              1,
            );
          }
        })();
      } finally {
        db.close();
      }
    },
  };
}

/** Managed-backup file name for one prefix and ISO timestamp. */
export function managedBackupName(prefix: string, iso: string): string {
  return `${prefix}${formatBackupTimestampLabel(iso)}.db`;
}
