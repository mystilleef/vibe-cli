import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  DEFAULT_PRUNE_AGE_DAYS,
  DEFAULT_PRUNE_OVERLAP_THRESHOLD,
  runPrune,
} from "../src/tools/prune";
import { initializeSchema } from "../src/utils/database";
import type { LearningType } from "../src/utils/storage";
import { createTempHome, type TempHomeContext } from "./helpers/tempHome";

const DAY_MS = 24 * 60 * 60 * 1000;

let home: TempHomeContext;

beforeEach(async () => {
  home = await createTempHome();
});

afterEach(async () => {
  await home.cleanup();
});

type SeedLearningRow = {
  category: string;
  mistake: string;
  timestamp: number;
  type?: LearningType;
  solution?: string;
  demoId?: string;
};

function seedLearningEntries(rows: SeedLearningRow[]): number[] {
  mkdirSync(home.dataRoot, { recursive: true });
  const db = new Database(join(home.dataRoot, "vibe.db"));
  initializeSchema(db);
  const insert = db.prepare(
    "INSERT INTO learning_entries (type, category, mistake, solution, timestamp, demo_id) VALUES (?, ?, ?, ?, ?, ?)",
  );
  const ids = rows.map((row) => {
    const result = insert.run(
      row.type ?? "mistake",
      row.category,
      row.mistake,
      row.solution ?? null,
      row.timestamp,
      row.demoId ?? null,
    );
    return Number(result.lastInsertRowid);
  });
  db.close();
  return ids;
}

type SeedSessionRow = {
  id: string;
  cwdKey?: string;
  cwd?: string | null;
  createdAt: string;
  lastAccessedAt: string;
  constitutionRules?: string[];
  interactions?: number;
};

function seedSessionRows(rows: SeedSessionRow[]): void {
  mkdirSync(home.dataRoot, { recursive: true });
  const db = new Database(join(home.dataRoot, "vibe.db"));
  initializeSchema(db);
  const insertSession = db.prepare(
    "INSERT INTO sessions (id, cwd_key, cwd, created_at, last_accessed_at) VALUES (?, ?, ?, ?, ?)",
  );
  const insertRule = db.prepare(
    "INSERT INTO constitution_rules (session_id, rule, position, created_at) VALUES (?, ?, ?, ?)",
  );
  const insertInteraction = db.prepare(
    "INSERT INTO interactions (session_id, goal, output, timestamp) VALUES (?, ?, ?, ?)",
  );

  rows.forEach((row, rowIndex) => {
    insertSession.run(
      row.id,
      row.cwdKey ?? `prune-test-${rowIndex}`,
      row.cwd === undefined ? `/tmp/${row.id}` : row.cwd,
      row.createdAt,
      row.lastAccessedAt,
    );

    row.constitutionRules?.forEach((rule, ruleIndex) => {
      insertRule.run(row.id, rule, ruleIndex, row.createdAt);
    });

    for (let index = 0; index < (row.interactions ?? 0); index += 1) {
      insertInteraction.run(
        row.id,
        `goal ${row.id} ${index}`,
        JSON.stringify({ reason: `output ${row.id} ${index}` }),
        index,
      );
    }
  });
  db.close();
}

// ---------------------------------------------------------------------------
// resolveExplicitTargets (internal, tested through runPrune)
// ---------------------------------------------------------------------------
describe("runPrune — resolveExplicitTargets (internal)", () => {
  test("maps --learnings to learnings target", () => {
    const result = runPrune({ learnings: true, dryRun: true });
    expect(result.targets).toEqual(["learnings"]);
    expect(result.skippedTargets).toEqual(["duplicates", "demos", "sessions"]);
  });

  test("maps --duplicates to duplicates target", () => {
    const result = runPrune({ duplicates: true, dryRun: true });
    expect(result.targets).toEqual(["duplicates"]);
    expect(result.skippedTargets).toEqual(["learnings", "demos", "sessions"]);
  });

  test("maps --demos to demos target", () => {
    const result = runPrune({ demos: true, dryRun: true });
    expect(result.targets).toEqual(["demos"]);
    expect(result.skippedTargets).toEqual([
      "learnings",
      "duplicates",
      "sessions",
    ]);
  });

  test("maps --sessions to sessions target", () => {
    const result = runPrune({ sessions: true, dryRun: true });
    expect(result.targets).toEqual(["sessions"]);
    expect(result.skippedTargets).toEqual(["learnings", "duplicates", "demos"]);
  });

  test("maps multiple flags to multiple targets", () => {
    const result = runPrune({
      learnings: true,
      duplicates: true,
      dryRun: true,
    });
    expect(result.targets).toEqual(["learnings", "duplicates"]);
    expect(result.skippedTargets).toEqual(["demos", "sessions"]);
  });

  test("defaults to all targets when no flags specified", () => {
    const result = runPrune({});
    expect(result.dryRun).toBe(true);
    expect(result.targets).toEqual([
      "learnings",
      "duplicates",
      "demos",
      "sessions",
    ]);
    expect(result.skippedTargets).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// validateAge (internal, tested through runPrune error propagation)
// ---------------------------------------------------------------------------
describe("runPrune — validateAge (internal)", () => {
  test("uses default age (90 days) when --age is omitted", () => {
    const now = Date.now();
    seedLearningEntries([
      { category: "old", mistake: "old entry", timestamp: now - 100 * DAY_MS },
      {
        category: "recent",
        mistake: "recent entry",
        timestamp: now - 10 * DAY_MS,
      },
    ]);

    const result = runPrune({ learnings: true, dryRun: true });
    // With default age=90, only the 100-day-old entry should be a candidate
    expect(result.candidateCounts.learnings).toBe(1);
  });

  test("accepts valid age and narrows candidates", () => {
    const now = Date.now();
    seedLearningEntries([
      { category: "old", mistake: "very old", timestamp: now - 100 * DAY_MS },
      {
        category: "medium",
        mistake: "medium old",
        timestamp: now - 60 * DAY_MS,
      },
      {
        category: "recent",
        mistake: "pretty recent",
        timestamp: now - 10 * DAY_MS,
      },
    ]);

    const result = runPrune({ learnings: true, age: 50, dryRun: true });
    // cutoff = now - 50 days, so entries older than 50 days: 100 and 60 day old entries
    expect(result.candidateCounts.learnings).toBe(2);
  });

  test("rejects non-integer age", () => {
    expect(() => runPrune({ learnings: true, age: 1.5, dryRun: true })).toThrow(
      "--age must be a positive integer",
    );
  });

  test("rejects zero age", () => {
    expect(() => runPrune({ learnings: true, age: 0, dryRun: true })).toThrow(
      "--age must be a positive integer",
    );
  });

  test("rejects negative age", () => {
    expect(() => runPrune({ learnings: true, age: -5, dryRun: true })).toThrow(
      "--age must be a positive integer",
    );
  });

  test("accepts large age values", () => {
    const now = Date.now();
    seedLearningEntries([
      {
        category: "very-old",
        mistake: "some entry",
        timestamp: now - 4000 * DAY_MS,
      },
    ]);

    const result = runPrune({ learnings: true, age: 3650, dryRun: true });
    // Entry from ~11 years ago exceeds 10-year cutoff
    expect(result.candidateCounts.learnings).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// validateOverlap (internal, tested through runPrune error propagation)
// ---------------------------------------------------------------------------
describe("runPrune — validateOverlap (internal)", () => {
  test("uses default overlap threshold (0.6) when --overlap is omitted", () => {
    seedLearningEntries([
      {
        category: "threshold",
        mistake: "alpha beta gamma delta",
        timestamp: 10,
      },
      {
        category: "threshold",
        mistake: "alpha beta gamma omega",
        timestamp: 20,
      },
    ]);

    const result = runPrune({ duplicates: true, dryRun: true });
    expect(result.candidateCounts.duplicates).toBe(1);
  });

  test("rejects overlap below 0", () => {
    expect(() =>
      runPrune({ duplicates: true, overlap: -0.1, dryRun: true }),
    ).toThrow("--overlap must be a float between 0 and 1 inclusive");
  });

  test("rejects overlap above 1", () => {
    expect(() =>
      runPrune({ duplicates: true, overlap: 1.5, dryRun: true }),
    ).toThrow("--overlap must be a float between 0 and 1 inclusive");
  });

  test("rejects non-number overlap", () => {
    expect(() =>
      runPrune({
        duplicates: true,
        overlap: "abc" as unknown as number,
        dryRun: true,
      }),
    ).toThrow("--overlap must be a float between 0 and 1 inclusive");
  });

  test("accepts overlap of exactly 0", () => {
    seedLearningEntries([
      {
        category: "threshold",
        mistake: "alpha beta gamma delta",
        timestamp: 10,
      },
      {
        category: "threshold",
        mistake: "alpha beta gamma omega",
        timestamp: 20,
      },
    ]);

    const result = runPrune({ duplicates: true, overlap: 0, dryRun: true });
    expect(result.candidateCounts.duplicates).toBe(1);
  });

  test("accepts overlap of exactly 1", () => {
    seedLearningEntries([
      {
        category: "threshold",
        mistake: "alpha beta gamma delta",
        timestamp: 10,
      },
      {
        category: "threshold",
        mistake: "alpha beta gamma omega",
        timestamp: 20,
      },
    ]);

    const result = runPrune({ duplicates: true, overlap: 1, dryRun: true });
    expect(result.candidateCounts.duplicates).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// validateCategory (internal, tested through runPrune error propagation)
// ---------------------------------------------------------------------------
describe("runPrune — validateCategory (internal)", () => {
  test("accepts --category with --learnings", () => {
    const result = runPrune({
      learnings: true,
      category: "scope",
      dryRun: true,
    });
    expect(result.dryRun).toBe(true);
    expect(result.targets).toEqual(["learnings"]);
  });

  test("accepts --category with --duplicates", () => {
    const result = runPrune({
      duplicates: true,
      category: "scope",
      dryRun: true,
    });
    expect(result.dryRun).toBe(true);
    expect(result.targets).toEqual(["duplicates"]);
  });

  test("accepts --category with --learnings and --duplicates together", () => {
    const result = runPrune({
      learnings: true,
      duplicates: true,
      category: "scope",
      dryRun: true,
    });
    expect(result.targets).toContain("learnings");
    expect(result.targets).toContain("duplicates");
  });

  test("rejects --category with --demos", () => {
    expect(() =>
      runPrune({ demos: true, category: "scope", dryRun: true }),
    ).toThrow("--category is only allowed with --learnings or --duplicates");
  });

  test("rejects --category with --sessions", () => {
    expect(() =>
      runPrune({ sessions: true, category: "scope", dryRun: true }),
    ).toThrow("--category is only allowed with --learnings or --duplicates");
  });

  test("rejects --category with mixed targets including --demos", () => {
    expect(() =>
      runPrune({
        learnings: true,
        demos: true,
        category: "scope",
        dryRun: true,
      }),
    ).toThrow("--category is only allowed with --learnings or --duplicates");
  });

  test("rejects --category with mixed targets including --sessions", () => {
    expect(() =>
      runPrune({
        duplicates: true,
        sessions: true,
        category: "scope",
        dryRun: true,
      }),
    ).toThrow("--category is only allowed with --learnings or --duplicates");
  });

  test("allows --category with no explicit targets (default dry-run)", () => {
    // No explicit targets → dry-run with all targets → validateCategory sees empty explicitTargets
    // which means no disallowed target check triggers
    const result = runPrune({ category: "scope" });
    expect(result.dryRun).toBe(true);
    expect(result.targets).toEqual([
      "learnings",
      "duplicates",
      "demos",
      "sessions",
    ]);
  });
});

// ---------------------------------------------------------------------------
// extractRepresentativeDetails (internal, tested through runPrune output)
// ---------------------------------------------------------------------------
describe("runPrune — extractRepresentativeDetails (internal)", () => {
  test("populates learnings representative details", () => {
    const now = Date.now();
    const oldMs = now - 100 * DAY_MS;
    seedLearningEntries([
      { category: "cat", mistake: "Mistake one.", timestamp: oldMs },
    ]);

    const result = runPrune({ learnings: true, age: 90, dryRun: true });
    expect(result.representativeDetails.learnings).toHaveLength(1);
    expect(result.representativeDetails.learnings[0]).toMatchObject({
      category: "cat",
      mistake: "Mistake one.",
    });
    expect(typeof result.representativeDetails.learnings[0]?.id).toBe("number");
  });

  test("caps learnings details at 5 entries", () => {
    const now = Date.now();
    for (let i = 0; i < 10; i++) {
      seedLearningEntries([
        {
          category: "cat",
          mistake: `Mistake ${i}.`,
          timestamp: now - 100 * DAY_MS,
        },
      ]);
    }

    const result = runPrune({ learnings: true, age: 90, dryRun: true });
    expect(result.representativeDetails.learnings).toHaveLength(5);
  });

  test("populates duplicates representative details", () => {
    seedLearningEntries([
      {
        category: "scope",
        mistake: "forgot import in module",
        timestamp: 10,
      },
      {
        category: "scope",
        mistake: "forgot import in module again",
        timestamp: 20,
      },
    ]);

    const result = runPrune({ duplicates: true, dryRun: true });
    expect(result.representativeDetails.duplicates).toHaveLength(1);
    expect(result.representativeDetails.duplicates[0]).toMatchObject({
      category: "scope",
    });
    expect(result.representativeDetails.duplicates[0]?.prunableIds.length).toBe(
      1,
    );
  });

  test("populates demos representative details with demoId", () => {
    seedLearningEntries([
      {
        category: "demo-cat",
        demoId: "demo-1",
        mistake: "Demo mistake.",
        timestamp: 100 * DAY_MS,
      },
    ]);

    const result = runPrune({ demos: true, dryRun: true });
    expect(result.representativeDetails.demos).toHaveLength(1);
    expect(result.representativeDetails.demos[0]).toMatchObject({
      category: "demo-cat",
      mistake: "Demo mistake.",
      demoId: "demo-1",
    });
  });

  test("populates sessions representative details", () => {
    const now = new Date();
    const oldCreated = new Date(now.getTime() - 120 * DAY_MS).toISOString();
    const oldAccessed = new Date(now.getTime() - 100 * DAY_MS).toISOString();
    seedSessionRows([
      {
        id: "session-old",
        createdAt: oldCreated,
        lastAccessedAt: oldAccessed,
      },
    ]);

    const result = runPrune({ sessions: true, age: 90, dryRun: true });
    expect(result.representativeDetails.sessions).toHaveLength(1);
    expect(result.representativeDetails.sessions[0]).toMatchObject({
      sessionId: "session-old",
    });
  });

  test("returns empty arrays for targets with no candidates", () => {
    const result = runPrune({ demos: true, dryRun: true });

    expect(result.representativeDetails.learnings).toEqual([]);
    expect(result.representativeDetails.duplicates).toEqual([]);
    expect(result.representativeDetails.demos).toEqual([]);
    expect(result.representativeDetails.sessions).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// runPrune — dry-run mode
// ---------------------------------------------------------------------------
describe("runPrune — dry-run mode", () => {
  test("dryRun=true with explicit targets returns zero deleted count", () => {
    const now = Date.now();
    seedLearningEntries([
      { category: "old", mistake: "old entry", timestamp: now - 100 * DAY_MS },
    ]);

    const result = runPrune({
      learnings: true,
      age: 90,
      dryRun: true,
    });

    expect(result.dryRun).toBe(true);
    expect(result.candidateCounts.learnings).toBe(1);
    expect(result.deletedCounts.learnings).toBe(0);
    expect(result.backupPath).toBeNull();
    expect(result.failedTargets).toEqual([]);
  });

  test("no explicit targets defaults to dry-run with all targets", () => {
    const result = runPrune({});
    expect(result.dryRun).toBe(true);
    expect(result.targets).toEqual([
      "learnings",
      "duplicates",
      "demos",
      "sessions",
    ]);
    expect(result.deletedCounts).toEqual({
      learnings: 0,
      duplicates: 0,
      demos: 0,
      sessions: 0,
    });
  });

  test("explicit targets without --yes defaults to dry-run", () => {
    const now = Date.now();
    seedLearningEntries([
      { category: "old", mistake: "old entry", timestamp: now - 100 * DAY_MS },
    ]);

    const result = runPrune({ learnings: true, age: 90 });

    expect(result.dryRun).toBe(true);
    expect(result.candidateCounts.learnings).toBeGreaterThanOrEqual(1);
    expect(result.deletedCounts.learnings).toBe(0);
  });

  test("dryRun=true with yes=true still runs dry-run (dry-run wins)", () => {
    const now = Date.now();
    seedLearningEntries([
      { category: "old", mistake: "old entry", timestamp: now - 100 * DAY_MS },
    ]);

    const result = runPrune({
      learnings: true,
      age: 90,
      dryRun: true,
      yes: true,
    });

    expect(result.dryRun).toBe(true);
    expect(result.deletedCounts.learnings).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// runPrune — destructive mode
// ---------------------------------------------------------------------------
describe("runPrune — destructive mode", () => {
  test("deletes stale learning entries with --yes", () => {
    const now = Date.now();
    const oldMs = now - 100 * DAY_MS;
    const recentMs = now - 10 * DAY_MS;
    seedLearningEntries([
      { category: "old", mistake: "old entry", timestamp: oldMs },
      { category: "recent", mistake: "recent entry", timestamp: recentMs },
    ]);

    const result = runPrune({
      learnings: true,
      age: 90,
      yes: true,
    });

    expect(result.dryRun).toBe(false);
    // Only the entry older than 90 days should be deleted
    expect(result.deletedCounts.learnings).toBe(1);
    expect(result.backupPath).toBeDefined();
    expect(result.backupPath).not.toBeNull();
    expect(result.failedTargets).toEqual([]);
  });

  test("deletes duplicate learning entries with --yes", () => {
    seedLearningEntries([
      {
        category: "scope",
        mistake: "forgot import in module",
        timestamp: 10,
      },
      {
        category: "scope",
        mistake: "forgot import in module again",
        timestamp: 20,
      },
    ]);

    const result = runPrune({
      duplicates: true,
      yes: true,
    });

    expect(result.dryRun).toBe(false);
    expect(result.deletedCounts.duplicates).toBe(1);
    expect(result.backupPath).toBeDefined();
    expect(result.backupPath).not.toBeNull();
  });

  test("deletes demo entries with --yes", () => {
    seedLearningEntries([
      {
        category: "demo-cat",
        demoId: "demo-1",
        mistake: "Demo entry.",
        timestamp: 100 * DAY_MS,
      },
    ]);

    const result = runPrune({
      demos: true,
      yes: true,
    });

    expect(result.dryRun).toBe(false);
    expect(result.deletedCounts.demos).toBe(1);
    expect(result.backupPath).toBeDefined();
    expect(result.backupPath).not.toBeNull();
  });

  test("deletes stale sessions with --yes", () => {
    const now = new Date();
    const oldCreated = new Date(now.getTime() - 120 * DAY_MS).toISOString();
    const oldAccessed = new Date(now.getTime() - 100 * DAY_MS).toISOString();
    seedSessionRows([
      {
        id: "session-old",
        createdAt: oldCreated,
        lastAccessedAt: oldAccessed,
        constitutionRules: ["rule a"],
        interactions: 2,
      },
    ]);

    const result = runPrune({
      sessions: true,
      age: 90,
      yes: true,
    });

    expect(result.dryRun).toBe(false);
    expect(result.deletedCounts.sessions).toBe(1);
    expect(result.backupPath).toBeDefined();
    expect(result.backupPath).not.toBeNull();
  });

  test("reports candidateCounts and representativeDetails in destructive mode", () => {
    const now = Date.now();
    seedLearningEntries([
      {
        category: "old",
        mistake: "old entry one.",
        timestamp: now - 120 * DAY_MS,
      },
      {
        category: "old",
        mistake: "old entry two.",
        timestamp: now - 110 * DAY_MS,
      },
    ]);

    const result = runPrune({
      learnings: true,
      age: 90,
      yes: true,
    });

    expect(result.candidateCounts.learnings).toBe(2);
    expect(result.representativeDetails.learnings).toHaveLength(2);
    expect(result.deletedCounts.learnings).toBe(2);
  });

  test("reports skipped targets for partial target selection", () => {
    const result = runPrune({
      learnings: true,
      yes: true,
    });

    expect(result.skippedTargets).toEqual(["duplicates", "demos", "sessions"]);
  });

  test("reports empty skipped targets when all targets selected", () => {
    const result = runPrune({
      learnings: true,
      duplicates: true,
      demos: true,
      sessions: true,
      yes: true,
    });

    expect(result.skippedTargets).toEqual([]);
  });

  test("handles no-op destructive run (nothing to delete)", () => {
    const result = runPrune({
      learnings: true,
      age: 90,
      yes: true,
    });

    expect(result.dryRun).toBe(false);
    expect(result.candidateCounts.learnings).toBe(0);
    expect(result.deletedCounts.learnings).toBe(0);
    expect(result.backupPath).toBeDefined();
    expect(result.backupPath).not.toBeNull();
    expect(result.failedTargets).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// runPrune — error propagation from validators
// ---------------------------------------------------------------------------
describe("runPrune — error propagation", () => {
  test("propagates validateAge errors", () => {
    expect(() => runPrune({ learnings: true, age: 0, dryRun: true })).toThrow(
      "--age must be a positive integer",
    );
  });

  test("propagates validateOverlap errors", () => {
    expect(() =>
      runPrune({ duplicates: true, overlap: -1, dryRun: true }),
    ).toThrow("--overlap must be a float between 0 and 1 inclusive");
  });

  test("propagates validateCategory errors", () => {
    expect(() =>
      runPrune({ demos: true, category: "test", dryRun: true }),
    ).toThrow("--category is only allowed with --learnings or --duplicates");
  });
});

// ---------------------------------------------------------------------------
// runPrune — multi-target combinations
// ---------------------------------------------------------------------------
describe("runPrune — multi-target combinations", () => {
  test("runs all four targets simultaneously in dry-run", () => {
    const now = Date.now();
    seedLearningEntries([
      { category: "old", mistake: "old entry", timestamp: now - 100 * DAY_MS },
      {
        category: "dup",
        mistake: "duplicate pattern",
        timestamp: now - 100 * DAY_MS,
      },
      {
        category: "dup",
        mistake: "duplicate pattern again",
        timestamp: now - 99 * DAY_MS,
      },
      {
        category: "demo",
        demoId: "demo-x",
        mistake: "demo entry",
        timestamp: now - 100 * DAY_MS,
      },
    ]);
    const oldCreated = new Date(now - 100 * DAY_MS).toISOString();
    const oldAccessed = new Date(now - 100 * DAY_MS).toISOString();
    seedSessionRows([
      {
        id: "session-old",
        createdAt: oldCreated,
        lastAccessedAt: oldAccessed,
      },
    ]);

    const result = runPrune({
      learnings: true,
      duplicates: true,
      demos: true,
      sessions: true,
      age: 90,
      dryRun: true,
    });

    expect(result.dryRun).toBe(true);
    // All 4 entries are older than 90 days
    expect(result.candidateCounts.learnings).toBe(4);
    expect(result.candidateCounts.duplicates).toBe(1);
    expect(result.candidateCounts.demos).toBe(1);
    expect(result.candidateCounts.sessions).toBe(1);
    expect(result.skippedTargets).toEqual([]);
    expect(result.failedTargets).toEqual([]);
  });

  test("runs all four targets in destructive mode", () => {
    const now = Date.now();
    seedLearningEntries([
      { category: "old", mistake: "old entry", timestamp: now - 100 * DAY_MS },
      {
        category: "dup",
        mistake: "duplicate pattern",
        timestamp: now - 100 * DAY_MS,
      },
      {
        category: "dup",
        mistake: "duplicate pattern again",
        timestamp: now - 99 * DAY_MS,
      },
      {
        category: "demo",
        demoId: "demo-x",
        mistake: "demo entry",
        timestamp: now - 100 * DAY_MS,
      },
    ]);
    const oldCreated = new Date(now - 100 * DAY_MS).toISOString();
    const oldAccessed = new Date(now - 100 * DAY_MS).toISOString();
    seedSessionRows([
      {
        id: "session-old",
        createdAt: oldCreated,
        lastAccessedAt: oldAccessed,
      },
    ]);

    const result = runPrune({
      learnings: true,
      duplicates: true,
      demos: true,
      sessions: true,
      age: 90,
      yes: true,
    });

    expect(result.dryRun).toBe(false);
    // learnings deletes all 4 first; duplicates/demos rows already deleted by learnings pass
    expect(result.deletedCounts).toEqual({
      learnings: 4,
      duplicates: 0,
      demos: 0,
      sessions: 1,
    });
    expect(result.backupPath).toBeDefined();
    expect(result.backupPath).not.toBeNull();
    expect(result.failedTargets).toEqual([]);
    expect(result.skippedTargets).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// runPrune — constants
// ---------------------------------------------------------------------------
describe("runPrune — constants", () => {
  test("DEFAULT_PRUNE_AGE_DAYS is 90", () => {
    expect(DEFAULT_PRUNE_AGE_DAYS).toBe(90);
  });

  test("DEFAULT_PRUNE_OVERLAP_THRESHOLD is 0.6", () => {
    expect(DEFAULT_PRUNE_OVERLAP_THRESHOLD).toBe(0.6);
  });
});
