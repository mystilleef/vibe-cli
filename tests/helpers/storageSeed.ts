/**
 * Storage-layer seed fixtures shared by suites: one insert contract for
 * learning entries, sessions, constitution rules, and interactions so the
 * seeded rows cannot drift between tests. The `insert*` functions assume
 * the caller owns the connection; the `seed*` functions add the shared
 * one-shot lifecycle and identity defaults (`cwd_key`, `cwd`).
 */

import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { initializeSchema } from "../../src/utils/database";
import type { LearningType } from "../../src/utils/storage";

/** Learning-entry fixture row. */
export interface SeedLearningRow {
  category: string;
  observation: string;
  timestamp: number;
  type?: LearningType;
  solution?: string;
  demoId?: string;
}

/** Session fixture row before per-suite identity defaults apply. */
export interface SeedSessionInput {
  id: string;
  cwdKey?: string;
  cwd?: string | null;
  createdAt: string;
  lastAccessedAt: string;
  constitutionRules?: string[];
  interactions?: number;
}

/** Session fixture row with resolved identity fields. */
export interface SeedSessionRow {
  id: string;
  cwdKey: string;
  cwd: string | null;
  createdAt: string;
  lastAccessedAt: string;
  constitutionRules?: string[];
  interactions?: number;
}

/** Explicit interaction fixture row. */
export interface SeedInteractionRow {
  sessionId: string;
  goal: string;
  output: string;
  timestamp: number;
}

/**
 * One-shot learning seeding with per-suite connection lifecycle: inserts
 * rows into the home's seeded database and closes it. Generated ids come
 * back in input order.
 */
export function seedLearningEntries(
  dataRoot: string,
  rows: readonly SeedLearningRow[],
): number[] {
  const db = openSeedDatabase(dataRoot);
  try {
    return insertLearningRows(db, rows);
  } finally {
    db.close();
  }
}

/**
 * One-shot session seeding with per-suite connection lifecycle and
 * identity defaults: `cwdKey` `prune-test-<index>`, `cwd` `/tmp/<id>`,
 * preserving an explicit `cwdKey` or `cwd`. Suites needing other identity
 * defaults resolve `SeedSessionInput` themselves and use
 * `insertSessionRows`.
 */
export function seedSessionRows(
  dataRoot: string,
  rows: readonly SeedSessionInput[],
): void {
  const db = openSeedDatabase(dataRoot);
  try {
    insertSessionRows(
      db,
      rows.map((row, rowIndex) => ({
        ...row,
        cwdKey: row.cwdKey ?? `prune-test-${rowIndex}`,
        cwd: row.cwd === undefined ? `/tmp/${row.id}` : row.cwd,
      })),
    );
  } finally {
    db.close();
  }
}

/** Open a schema-initialized connection to one home's seeded database. */
export function openSeedDatabase(dataRoot: string): Database {
  mkdirSync(dataRoot, { recursive: true });
  const db = new Database(join(dataRoot, "vibe.db"));
  initializeSchema(db);
  return db;
}

/** Insert learning entries; generated ids come back in input order. */
export function insertLearningRows(
  db: Database,
  rows: readonly SeedLearningRow[],
): number[] {
  const insert = db.prepare(
    "INSERT INTO learning_entries (type, category, observation, solution, timestamp, demo_id) VALUES (?, ?, ?, ?, ?, ?)",
  );
  return rows.map((row) => {
    const result = insert.run(
      row.type ?? "mistake",
      row.category,
      row.observation,
      row.solution ?? null,
      row.timestamp,
      row.demoId ?? null,
    );
    return Number(result.lastInsertRowid);
  });
}

/** Insert explicit interactions. */
export function insertInteractionRows(
  db: Database,
  rows: readonly SeedInteractionRow[],
): void {
  const insert = db.prepare(
    "INSERT INTO interactions (session_id, goal, output, timestamp) VALUES (?, ?, ?, ?)",
  );
  for (const row of rows) {
    insert.run(row.sessionId, row.goal, row.output, row.timestamp);
  }
}

/**
 * Insert sessions with their constitution rules and counted synthetic
 * interactions (goal `goal <id> <n>`, output reason `output <id> <n>`,
 * timestamp `n`), preserving per-row seeding order.
 */
export function insertSessionRows(
  db: Database,
  rows: readonly SeedSessionRow[],
): void {
  const insertSession = db.prepare(
    "INSERT INTO sessions (id, cwd_key, cwd, created_at, last_accessed_at) VALUES (?, ?, ?, ?, ?)",
  );
  const insertRule = db.prepare(
    "INSERT INTO constitution_rules (session_id, rule, position, created_at) VALUES (?, ?, ?, ?)",
  );

  for (const row of rows) {
    insertSession.run(
      row.id,
      row.cwdKey,
      row.cwd,
      row.createdAt,
      row.lastAccessedAt,
    );

    row.constitutionRules?.forEach((rule, ruleIndex) => {
      insertRule.run(row.id, rule, ruleIndex, row.createdAt);
    });

    if (row.interactions) {
      insertInteractionRows(
        db,
        Array.from({ length: row.interactions }, (_, index) => ({
          sessionId: row.id,
          goal: `goal ${row.id} ${index}`,
          output: JSON.stringify({ reason: `output ${row.id} ${index}` }),
          timestamp: index,
        })),
      );
    }
  }
}
