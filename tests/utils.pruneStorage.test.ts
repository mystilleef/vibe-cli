import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { initializeSchema } from "../src/utils/database";
import {
  collectDemoLearningPruneCandidates,
  collectDuplicateLearningPruneGroups,
  collectPruneCandidates,
  collectStaleLearningPruneCandidates,
  collectStaleSessionPruneCandidates,
  computePruneTargetCounts,
  createPruneDatabaseBackup,
  executeDestructivePrune,
  PRUNE_TARGET_ORDER,
  type PruneCandidateSets,
} from "../src/utils/pruneStorage";
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

// ── Seed helpers ──────────────────────────────────────────────────────────

interface SeedLearningRow {
  category: string;
  observation: string;
  timestamp: number;
  type?: LearningType;
  solution?: string;
  demoId?: string;
}

function seedLearningEntries(rows: SeedLearningRow[]): void {
  mkdirSync(home.dataRoot, { recursive: true });
  const db = new Database(join(home.dataRoot, "vibe.db"));
  initializeSchema(db);
  const insert = db.prepare(
    "INSERT INTO learning_entries (type, category, observation, solution, timestamp, demo_id) VALUES (?, ?, ?, ?, ?, ?)",
  );
  rows.forEach((row) => {
    insert.run(
      row.type ?? "mistake",
      row.category,
      row.observation,
      row.solution ?? null,
      row.timestamp,
      row.demoId ?? null,
    );
  });
  db.close();
}

interface SeedSessionRow {
  id: string;
  cwdKey?: string;
  createdAt: string;
  lastAccessedAt: string;
  constitutionRules?: string[];
  interactions?: number;
}

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
      `/tmp/${row.id}`,
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

// ── collectStaleLearningPruneCandidates ───────────────────────────────────

describe("collectStaleLearningPruneCandidates", () => {
  test("returns entries older than the cutoff", () => {
    const now = Date.now();
    seedLearningEntries([
      { category: "cat", observation: "old", timestamp: now - 120 * DAY_MS },
      { category: "cat", observation: "recent", timestamp: now - 10 * DAY_MS },
    ]);

    const candidates = collectStaleLearningPruneCandidates({
      ageDays: 90,
      now,
    });

    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.observation).toBe("old");
  });

  test("filters by category", () => {
    const now = Date.now();
    seedLearningEntries([
      {
        category: "alpha",
        observation: "old alpha",
        timestamp: now - 100 * DAY_MS,
      },
      {
        category: "beta",
        observation: "old beta",
        timestamp: now - 100 * DAY_MS,
      },
    ]);

    const candidates = collectStaleLearningPruneCandidates({
      ageDays: 90,
      category: "alpha",
      now,
    });

    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.category).toBe("alpha");
  });

  test("returns empty array when no entries exist", () => {
    const candidates = collectStaleLearningPruneCandidates({ ageDays: 90 });

    expect(candidates).toEqual([]);
  });

  test("returns empty array when all entries are too recent", () => {
    const now = Date.now();
    seedLearningEntries([
      { category: "cat", observation: "fresh", timestamp: now - 5 * DAY_MS },
    ]);

    const candidates = collectStaleLearningPruneCandidates({
      ageDays: 90,
      now,
    });

    expect(candidates).toEqual([]);
  });

  test("respects custom now parameter", () => {
    const now = Date.now();
    seedLearningEntries([
      {
        category: "cat",
        observation: "at cutoff",
        timestamp: now - 30 * DAY_MS,
      },
    ]);

    const candidates = collectStaleLearningPruneCandidates({
      ageDays: 30,
      now,
    });

    // timestamp == cutoff → strictly less than, so excluded
    expect(candidates).toEqual([]);
  });
});

// ── collectDemoLearningPruneCandidates ────────────────────────────────────

describe("collectDemoLearningPruneCandidates", () => {
  test("returns entries with demoId set", () => {
    seedLearningEntries([
      {
        category: "demo-cat",
        demoId: "demo-1",
        observation: "demo entry",
        timestamp: Date.now(),
      },
      {
        category: "normal",
        observation: "normal entry",
        timestamp: Date.now(),
      },
    ]);

    const candidates = collectDemoLearningPruneCandidates();

    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.demoId).toBe("demo-1");
  });

  test("returns empty when no demo entries exist", () => {
    seedLearningEntries([
      { category: "cat", observation: "normal", timestamp: Date.now() },
    ]);

    const candidates = collectDemoLearningPruneCandidates();

    expect(candidates).toEqual([]);
  });
});

// ── collectDuplicateLearningPruneGroups ───────────────────────────────────

describe("collectDuplicateLearningPruneGroups", () => {
  test("returns groups for duplicate observations", () => {
    seedLearningEntries([
      {
        category: "scope",
        observation: "forgot import in module",
        timestamp: 10,
      },
      {
        category: "scope",
        observation: "forgot import in module again",
        timestamp: 20,
      },
    ]);

    const groups = collectDuplicateLearningPruneGroups();

    expect(groups).toHaveLength(1);
    expect(groups[0]?.prunable).toHaveLength(1);
    // Most recent is kept
    expect(groups[0]?.kept.timestamp).toBe(20);
  });

  test("filters by category", () => {
    seedLearningEntries([
      {
        category: "alpha",
        observation: "duplicate entry one",
        timestamp: 10,
      },
      {
        category: "alpha",
        observation: "duplicate entry two",
        timestamp: 20,
      },
      {
        category: "beta",
        observation: "duplicate entry one",
        timestamp: 10,
      },
      {
        category: "beta",
        observation: "duplicate entry two",
        timestamp: 20,
      },
    ]);

    const groups = collectDuplicateLearningPruneGroups({ category: "alpha" });

    expect(groups).toHaveLength(1);
    expect(groups[0]?.category).toBe("alpha");
  });

  test("overlap threshold of 0 groups everything in a category", () => {
    seedLearningEntries([
      { category: "cat", observation: "alpha beta", timestamp: 10 },
      { category: "cat", observation: "gamma delta", timestamp: 20 },
    ]);

    const groups = collectDuplicateLearningPruneGroups({ overlapThreshold: 0 });

    // threshold 0 includes zero-score pairs → any two entries in the same category connect
    expect(groups).toHaveLength(1);
    expect(groups[0]?.prunable).toHaveLength(1);
  });

  test("overlap threshold of 1 groups nothing (partial matches excluded)", () => {
    seedLearningEntries([
      { category: "cat", observation: "alpha beta gamma", timestamp: 10 },
      { category: "cat", observation: "alpha beta omega", timestamp: 20 },
    ]);

    const groups = collectDuplicateLearningPruneGroups({ overlapThreshold: 1 });

    // 2 out of 3 overlap → 0.67 < 1.0
    expect(groups).toEqual([]);
  });

  test("sorts groups by category then kept.timestamp", () => {
    seedLearningEntries([
      { category: "beta-cat", observation: "dup a", timestamp: 100 },
      { category: "beta-cat", observation: "dup a again", timestamp: 200 },
      { category: "alpha-cat", observation: "dup b", timestamp: 50 },
      { category: "alpha-cat", observation: "dup b again", timestamp: 150 },
    ]);

    const groups = collectDuplicateLearningPruneGroups();

    // Sorted: alpha-cat first, then beta-cat (exercises compareDuplicateLearningGroups)
    expect(groups).toHaveLength(2);
    expect(groups[0]?.category).toBe("alpha-cat");
    expect(groups[1]?.category).toBe("beta-cat");
    expect(groups[0]?.kept.timestamp).toBe(150);
    expect(groups[1]?.kept.timestamp).toBe(200);
  });

  test("returns empty when no duplicates exist", () => {
    seedLearningEntries([
      { category: "cat", observation: "unique one", timestamp: 10 },
    ]);

    const groups = collectDuplicateLearningPruneGroups();

    expect(groups).toEqual([]);
  });

  test("returns empty when no entries exist", () => {
    const groups = collectDuplicateLearningPruneGroups();

    expect(groups).toEqual([]);
  });

  test("keeps most recent entry in each duplicate group", () => {
    seedLearningEntries([
      {
        category: "cat",
        observation: "duplicate observation old",
        timestamp: 10,
      },
      {
        category: "cat",
        observation: "duplicate observation new",
        timestamp: 30,
      },
      {
        category: "cat",
        observation: "duplicate observation mid",
        timestamp: 20,
      },
    ]);

    const groups = collectDuplicateLearningPruneGroups();

    expect(groups).toHaveLength(1);
    expect(groups[0]?.kept.timestamp).toBe(30);
    expect(groups[0]?.prunable).toHaveLength(2);
  });

  test("forms connected component from chain of three overlapping entries", () => {
    seedLearningEntries([
      { category: "chain", observation: "alpha beta gamma", timestamp: 10 },
      { category: "chain", observation: "alpha beta delta", timestamp: 20 },
      { category: "chain", observation: "alpha beta epsilon", timestamp: 30 },
    ]);

    const groups = collectDuplicateLearningPruneGroups();

    expect(groups).toHaveLength(1);
    expect(groups[0]?.kept.timestamp).toBe(30);
    expect(groups[0]?.prunable).toHaveLength(2);
    expect(groups[0]?.overlapScores.length).toBeGreaterThan(0);
  });

  test("separates disconnected entries into isolated nodes (no group)", () => {
    seedLearningEntries([
      {
        category: "iso",
        observation: "completely unique phrase",
        timestamp: 10,
      },
      {
        category: "iso",
        observation: "totally different words",
        timestamp: 20,
      },
    ]);

    const groups = collectDuplicateLearningPruneGroups({
      overlapThreshold: 0.8,
    });

    expect(groups).toHaveLength(0);
  });

  test("groups duplicates independently per category", () => {
    seedLearningEntries([
      { category: "cat-a", observation: "shared pattern one", timestamp: 10 },
      { category: "cat-a", observation: "shared pattern two", timestamp: 20 },
      { category: "cat-b", observation: "shared pattern one", timestamp: 30 },
      { category: "cat-b", observation: "shared pattern two", timestamp: 40 },
    ]);

    const groups = collectDuplicateLearningPruneGroups();

    expect(groups).toHaveLength(2);
    expect(groups[0]?.category).toBe("cat-a");
    expect(groups[1]?.category).toBe("cat-b");
  });

  test("overlap scores filtered to component membership", () => {
    seedLearningEntries([
      { category: "sc", observation: "alpha beta gamma delta", timestamp: 10 },
      {
        category: "sc",
        observation: "alpha beta gamma epsilon",
        timestamp: 20,
      },
      { category: "sc", observation: "alpha beta gamma zeta", timestamp: 30 },
    ]);

    const groups = collectDuplicateLearningPruneGroups();

    expect(groups).toHaveLength(1);
    const firstGroup = groups[0];
    expect(firstGroup).toBeDefined();
    if (!firstGroup) return;
    const componentIds = new Set([
      firstGroup.kept.id,
      ...firstGroup.prunable.map((p) => p.id),
    ]);
    for (const score of firstGroup.overlapScores) {
      expect(componentIds.has(score.firstId)).toBe(true);
      expect(componentIds.has(score.secondId)).toBe(true);
    }
  });
});

// ── collectStaleSessionPruneCandidates ────────────────────────────────────

describe("collectStaleSessionPruneCandidates", () => {
  test("returns sessions older than the cutoff", () => {
    const now = new Date();
    const oldAccessed = new Date(now.getTime() - 120 * DAY_MS).toISOString();
    const oldCreated = new Date(now.getTime() - 150 * DAY_MS).toISOString();
    const recentAccessed = new Date(now.getTime() - 10 * DAY_MS).toISOString();
    const recentCreated = new Date(now.getTime() - 20 * DAY_MS).toISOString();

    seedSessionRows([
      {
        id: "session-old",
        createdAt: oldCreated,
        lastAccessedAt: oldAccessed,
        constitutionRules: ["rule a"],
        interactions: 2,
      },
      {
        id: "session-recent",
        createdAt: recentCreated,
        lastAccessedAt: recentAccessed,
      },
    ]);

    const candidates = collectStaleSessionPruneCandidates({
      ageDays: 90,
      now: now.getTime(),
    });

    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.sessionId).toBe("session-old");
    expect(candidates[0]?.cascadeCounts.constitutionRules).toBe(1);
    expect(candidates[0]?.cascadeCounts.interactions).toBe(2);
  });

  test("excludes active session when activeSessionId provided", () => {
    const now = new Date();
    const oldAccessed = new Date(now.getTime() - 120 * DAY_MS).toISOString();
    const oldCreated = new Date(now.getTime() - 150 * DAY_MS).toISOString();

    seedSessionRows([
      {
        id: "session-old",
        createdAt: oldCreated,
        lastAccessedAt: oldAccessed,
      },
    ]);

    const candidates = collectStaleSessionPruneCandidates({
      ageDays: 90,
      now: now.getTime(),
      activeSessionId: "session-old",
    });

    expect(candidates).toEqual([]);
  });

  test("returns empty when no sessions exist", () => {
    const candidates = collectStaleSessionPruneCandidates({ ageDays: 90 });

    expect(candidates).toEqual([]);
  });
});

// ── computePruneTargetCounts ──────────────────────────────────────────────

describe("computePruneTargetCounts", () => {
  test("computes counts for all targets", () => {
    const candidates: PruneCandidateSets = {
      learnings: [
        {
          id: 1,
          type: "mistake",
          category: "cat",
          observation: "a",
          timestamp: 0,
        },
        {
          id: 2,
          type: "mistake",
          category: "cat",
          observation: "b",
          timestamp: 0,
        },
      ],
      duplicates: [
        {
          category: "cat",
          kept: {
            id: 3,
            type: "mistake",
            category: "cat",
            observation: "c",
            timestamp: 10,
          },
          prunable: [
            {
              id: 4,
              type: "mistake",
              category: "cat",
              observation: "d",
              timestamp: 5,
            },
            {
              id: 5,
              type: "mistake",
              category: "cat",
              observation: "e",
              timestamp: 5,
            },
          ],
          overlapScores: [],
        },
      ],
      demos: [
        {
          id: 6,
          type: "mistake",
          category: "demo",
          observation: "f",
          timestamp: 0,
          demoId: "d",
        },
      ],
      sessions: [
        {
          sessionId: "s1",
          cwd: "/tmp",
          createdAt: "2020-01-01",
          lastAccessedAt: "2020-01-01",
          cascadeCounts: { constitutionRules: 0, interactions: 0 },
        },
      ],
    };

    const counts = computePruneTargetCounts(candidates);

    expect(counts.learnings).toBe(2);
    expect(counts.duplicates).toBe(2);
    expect(counts.demos).toBe(1);
    expect(counts.sessions).toBe(1);
  });

  test("returns zero counts for empty candidate sets", () => {
    const candidates: PruneCandidateSets = {
      learnings: [],
      duplicates: [],
      demos: [],
      sessions: [],
    };

    const counts = computePruneTargetCounts(candidates);

    expect(counts).toEqual({
      learnings: 0,
      duplicates: 0,
      demos: 0,
      sessions: 0,
    });
  });
});

// ── collectPruneCandidates ────────────────────────────────────────────────

describe("collectPruneCandidates", () => {
  test("collects only selected targets", () => {
    const now = Date.now();
    seedLearningEntries([
      { category: "old", observation: "old", timestamp: now - 100 * DAY_MS },
    ]);

    const candidates = collectPruneCandidates({
      targets: ["learnings"],
      ageDays: 90,
      now,
    });

    expect(candidates.learnings).toHaveLength(1);
    // Non-selected targets stay empty
    expect(candidates.duplicates).toEqual([]);
    expect(candidates.demos).toEqual([]);
    expect(candidates.sessions).toEqual([]);
  });

  test("collects all targets by default", () => {
    const now = Date.now();
    seedLearningEntries([
      { category: "old", observation: "old", timestamp: now - 100 * DAY_MS },
      {
        category: "demo",
        demoId: "d1",
        observation: "demo",
        timestamp: now - 100 * DAY_MS,
      },
    ]);
    const oldAccessed = new Date(now - 100 * DAY_MS).toISOString();
    const oldCreated = new Date(now - 120 * DAY_MS).toISOString();
    seedSessionRows([
      { id: "s1", createdAt: oldCreated, lastAccessedAt: oldAccessed },
    ]);

    const candidates = collectPruneCandidates({ ageDays: 90, now });

    expect(candidates.learnings.length).toBeGreaterThanOrEqual(1);
    expect(candidates.sessions.length).toBeGreaterThanOrEqual(1);
  });

  test("passes category filter to learnings and duplicates", () => {
    const now = Date.now();
    seedLearningEntries([
      {
        category: "alpha",
        observation: "alpha old",
        timestamp: now - 100 * DAY_MS,
      },
      {
        category: "beta",
        observation: "beta old",
        timestamp: now - 100 * DAY_MS,
      },
    ]);

    const candidates = collectPruneCandidates({
      targets: ["learnings", "duplicates"],
      ageDays: 90,
      category: "alpha",
      now,
    });

    expect(candidates.learnings).toHaveLength(1);
    expect(candidates.learnings[0]?.category).toBe("alpha");
  });

  test("all four candidate sets present in result", () => {
    const result = collectPruneCandidates({ ageDays: 90 });

    expect(result).toHaveProperty("learnings");
    expect(result).toHaveProperty("duplicates");
    expect(result).toHaveProperty("demos");
    expect(result).toHaveProperty("sessions");
  });
});

// ── createPruneDatabaseBackup ─────────────────────────────────────────────

describe("createPruneDatabaseBackup", () => {
  test("creates a backup file for a file-based database", () => {
    seedLearningEntries([
      { category: "cat", observation: "entry", timestamp: Date.now() },
    ]);

    const backupPath = createPruneDatabaseBackup();

    expect(backupPath).toContain("backups");
    expect(backupPath).toContain("vibe-prune-");
    expect(backupPath.endsWith(".db")).toBe(true);
  });

  test("throws when backup destination is blocked (file in place of dir)", () => {
    seedLearningEntries([
      { category: "cat", observation: "entry", timestamp: Date.now() },
    ]);
    // Place a file where backups directory would be created
    const backupsPath = join(home.dataRoot, "backups");
    writeFileSync(backupsPath, "blocked");

    expect(() => createPruneDatabaseBackup()).toThrow();
  });

  test("respects custom backup directory", () => {
    seedLearningEntries([
      { category: "cat", observation: "entry", timestamp: Date.now() },
    ]);
    const customDir = join(home.dataRoot, "custom-backups");

    const backupPath = createPruneDatabaseBackup({ directory: customDir });

    expect(backupPath).toContain("custom-backups");
  });

  test("throws when database is in-memory", async () => {
    const dbModule = await import("../src/utils/database.js");
    const spy = spyOn(dbModule, "openVibeDatabase");
    spy.mockReturnValue({
      db: {} as Database,
      path: ":memory:",
      close: () => {},
    });

    try {
      expect(() => createPruneDatabaseBackup()).toThrow(
        "cannot back up an in-memory database",
      );
    } finally {
      spy.mockRestore();
    }
  });
});

// ── executeDestructivePrune ───────────────────────────────────────────────

describe("executeDestructivePrune", () => {
  test("backs up and deletes stale learning entries", () => {
    const now = Date.now();
    seedLearningEntries([
      { category: "old", observation: "old", timestamp: now - 120 * DAY_MS },
      {
        category: "recent",
        observation: "recent",
        timestamp: now - 10 * DAY_MS,
      },
    ]);

    const result = executeDestructivePrune({
      targets: ["learnings"],
      ageDays: 90,
      now,
    });

    expect(result.backupPath).not.toBeNull();
    expect(result.candidateCounts.learnings).toBe(1);
    expect(result.deletedCounts.learnings).toBe(1);
    expect(result.failedTargets).toEqual([]);
  });

  test("skips non-selected targets", () => {
    const result = executeDestructivePrune({
      targets: ["learnings"],
      ageDays: 90,
    });

    expect(result.skippedTargets).toContain("duplicates");
    expect(result.skippedTargets).toContain("demos");
    expect(result.skippedTargets).toContain("sessions");
    expect(result.deletedCounts.learnings).toBe(0);
    expect(result.deletedCounts.duplicates).toBe(0);
    expect(result.deletedCounts.demos).toBe(0);
    expect(result.deletedCounts.sessions).toBe(0);
  });

  test("returns backup failure when backup creation fails", () => {
    const now = Date.now();
    seedLearningEntries([
      { category: "old", observation: "old", timestamp: now - 120 * DAY_MS },
    ]);
    // Block backup dir creation
    writeFileSync(join(home.dataRoot, "backups"), "blocked");

    const result = executeDestructivePrune({
      targets: ["learnings"],
      ageDays: 90,
      now,
    });

    expect(result.backupPath).toBeNull();
    expect(result.failedTargets).toHaveLength(1);
    expect(result.failedTargets[0]?.target).toBe("backup");
    expect(result.deletedCounts.learnings).toBe(0);
  });

  test("deletes stale sessions via executeDestructivePrune", () => {
    const now = new Date();
    const oldAccessed = new Date(now.getTime() - 120 * DAY_MS).toISOString();
    const oldCreated = new Date(now.getTime() - 150 * DAY_MS).toISOString();

    seedSessionRows([
      {
        id: "session-old",
        createdAt: oldCreated,
        lastAccessedAt: oldAccessed,
        constitutionRules: ["rule 1"],
        interactions: 3,
      },
    ]);

    const result = executeDestructivePrune({
      targets: ["sessions"],
      ageDays: 90,
      now: now.getTime(),
    });

    expect(result.backupPath).not.toBeNull();
    expect(result.candidateCounts.sessions).toBe(1);
    expect(result.deletedCounts.sessions).toBe(1);
    expect(result.failedTargets).toEqual([]);
  });

  test("deletes demo entries via executeDestructivePrune", () => {
    seedLearningEntries([
      {
        category: "demo-cat",
        demoId: "demo-1",
        observation: "demo entry",
        timestamp: Date.now(),
      },
    ]);

    const result = executeDestructivePrune({
      targets: ["demos"],
      ageDays: 90,
    });

    expect(result.backupPath).not.toBeNull();
    expect(result.deletedCounts.demos).toBe(1);
    expect(result.failedTargets).toEqual([]);
  });

  test("handles no-op destructive run gracefully", () => {
    const result = executeDestructivePrune({
      targets: ["learnings"],
      ageDays: 90,
    });

    expect(result.backupPath).not.toBeNull();
    expect(result.candidateCounts.learnings).toBe(0);
    expect(result.deletedCounts.learnings).toBe(0);
    expect(result.failedTargets).toEqual([]);
  });
});

// ── PRUNE_TARGET_ORDER ────────────────────────────────────────────────────

describe("PRUNE_TARGET_ORDER", () => {
  test("contains all four targets in the documented order", () => {
    expect(PRUNE_TARGET_ORDER).toEqual([
      "learnings",
      "duplicates",
      "demos",
      "sessions",
    ]);
  });
});
