import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { link } from "node:fs/promises";
import { join } from "node:path";
import { openVibeDatabase } from "../src/utils/database";
import {
  collectDemoLearningPruneCandidates,
  collectDuplicateLearningPruneGroups,
  collectPruneCandidates,
  collectStaleLearningPruneCandidates,
  collectStaleSessionPruneCandidates,
  computePruneTargetCounts,
  createPruneBackup,
  executeDestructivePrune,
  PRUNE_TARGET_ORDER,
  type PruneCandidateSets,
} from "../src/utils/pruneStorage";
import {
  type ConcurrentExclusiveLockProcess,
  seedMultiPageDatabase,
  spawnConcurrentExclusiveLock,
} from "./helpers/concurrentBackupFixtures";
import { seedLearningEntries, seedSessionRows } from "./helpers/storageSeed";
import { createTempHome, type TempHomeContext } from "./helpers/tempHome";
import { DAY_MS } from "./helpers/timeFixtures";

let home: TempHomeContext;
const activeExclusiveLocks: ConcurrentExclusiveLockProcess[] = [];

beforeEach(async () => {
  home = await createTempHome();
});

afterEach(async () => {
  while (activeExclusiveLocks.length > 0) {
    const lock = activeExclusiveLocks.pop();
    if (!lock) continue;
    try {
      await lock.close();
    } catch {
      // Best-effort cleanup of spawned lock fixtures
    }
  }
  await home.cleanup();
});

/** Read rows from the active temp home's source database. */
function readSourceRows<T>(sql: string): T[] {
  const db = new Database(join(home.dataRoot, "vibe.db"));
  try {
    return db.query<T, []>(sql).all();
  } finally {
    db.close();
  }
}

// ── collectStaleLearningPruneCandidates ───────────────────────────────────

describe("collectStaleLearningPruneCandidates", () => {
  test("returns entries older than the cutoff", () => {
    const now = Date.now();
    seedLearningEntries(home.dataRoot, [
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
    seedLearningEntries(home.dataRoot, [
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
    seedLearningEntries(home.dataRoot, [
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
    seedLearningEntries(home.dataRoot, [
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
    seedLearningEntries(home.dataRoot, [
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
    seedLearningEntries(home.dataRoot, [
      { category: "cat", observation: "normal", timestamp: Date.now() },
    ]);

    const candidates = collectDemoLearningPruneCandidates();

    expect(candidates).toEqual([]);
  });
});

// ── collectDuplicateLearningPruneGroups ───────────────────────────────────

describe("collectDuplicateLearningPruneGroups", () => {
  test("returns groups for duplicate observations", () => {
    seedLearningEntries(home.dataRoot, [
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
    seedLearningEntries(home.dataRoot, [
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
    seedLearningEntries(home.dataRoot, [
      { category: "cat", observation: "alpha beta", timestamp: 10 },
      { category: "cat", observation: "gamma delta", timestamp: 20 },
    ]);

    const groups = collectDuplicateLearningPruneGroups({ overlapThreshold: 0 });

    // threshold 0 includes zero-score pairs → any two entries in the same category connect
    expect(groups).toHaveLength(1);
    expect(groups[0]?.prunable).toHaveLength(1);
  });

  test("overlap threshold of 1 groups nothing (partial matches excluded)", () => {
    seedLearningEntries(home.dataRoot, [
      { category: "cat", observation: "alpha beta gamma", timestamp: 10 },
      { category: "cat", observation: "alpha beta omega", timestamp: 20 },
    ]);

    const groups = collectDuplicateLearningPruneGroups({ overlapThreshold: 1 });

    // 2 out of 3 overlap → 0.67 < 1.0
    expect(groups).toEqual([]);
  });

  test("sorts groups by category then kept.timestamp", () => {
    seedLearningEntries(home.dataRoot, [
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
    seedLearningEntries(home.dataRoot, [
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
    seedLearningEntries(home.dataRoot, [
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
    seedLearningEntries(home.dataRoot, [
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
    seedLearningEntries(home.dataRoot, [
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
    seedLearningEntries(home.dataRoot, [
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
    seedLearningEntries(home.dataRoot, [
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

    seedSessionRows(home.dataRoot, [
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

    seedSessionRows(home.dataRoot, [
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
    seedLearningEntries(home.dataRoot, [
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
    seedLearningEntries(home.dataRoot, [
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
    seedSessionRows(home.dataRoot, [
      { id: "s1", createdAt: oldCreated, lastAccessedAt: oldAccessed },
    ]);

    const candidates = collectPruneCandidates({ ageDays: 90, now });

    expect(candidates.learnings.length).toBeGreaterThanOrEqual(1);
    expect(candidates.sessions.length).toBeGreaterThanOrEqual(1);
  });

  test("passes category filter to learnings and duplicates", () => {
    const now = Date.now();
    seedLearningEntries(home.dataRoot, [
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

// ── executeDestructivePrune ───────────────────────────────────────────────

describe("executeDestructivePrune", () => {
  test("backs up and deletes stale learning entries", async () => {
    const now = Date.now();
    seedLearningEntries(home.dataRoot, [
      { category: "old", observation: "old", timestamp: now - 120 * DAY_MS },
      {
        category: "recent",
        observation: "recent",
        timestamp: now - 10 * DAY_MS,
      },
    ]);

    const result = await executeDestructivePrune({
      targets: ["learnings"],
      ageDays: 90,
      now,
    });

    expect(result.backupPath).not.toBeNull();
    expect(result.candidateCounts.learnings).toBe(1);
    expect(result.deletedCounts.learnings).toBe(1);
    expect(result.failedTargets).toEqual([]);
  });

  test("skips non-selected targets", async () => {
    const result = await executeDestructivePrune({
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

  test("returns backup failure when backup creation fails", async () => {
    const now = Date.now();
    seedLearningEntries(home.dataRoot, [
      { category: "old", observation: "old", timestamp: now - 120 * DAY_MS },
    ]);
    // Block backup dir creation
    writeFileSync(join(home.dataRoot, "backups"), "blocked");

    const result = await executeDestructivePrune({
      targets: ["learnings"],
      ageDays: 90,
      now,
    });

    expect(result.backupPath).toBeNull();
    expect(result.failedTargets).toHaveLength(1);
    expect(result.failedTargets[0]?.target).toBe("backup");
    expect(result.deletedCounts.learnings).toBe(0);
  });

  test("deletes stale sessions via executeDestructivePrune", async () => {
    const now = new Date();
    const oldAccessed = new Date(now.getTime() - 120 * DAY_MS).toISOString();
    const oldCreated = new Date(now.getTime() - 150 * DAY_MS).toISOString();

    seedSessionRows(home.dataRoot, [
      {
        id: "session-old",
        createdAt: oldCreated,
        lastAccessedAt: oldAccessed,
        constitutionRules: ["rule 1"],
        interactions: 3,
      },
    ]);

    const result = await executeDestructivePrune({
      targets: ["sessions"],
      ageDays: 90,
      now: now.getTime(),
    });

    expect(result.backupPath).not.toBeNull();
    expect(result.candidateCounts.sessions).toBe(1);
    expect(result.deletedCounts.sessions).toBe(1);
    expect(result.failedTargets).toEqual([]);
  });

  test("deletes demo entries via executeDestructivePrune", async () => {
    seedLearningEntries(home.dataRoot, [
      {
        category: "demo-cat",
        demoId: "demo-1",
        observation: "demo entry",
        timestamp: Date.now(),
      },
    ]);

    const result = await executeDestructivePrune({
      targets: ["demos"],
      ageDays: 90,
    });

    expect(result.backupPath).not.toBeNull();
    expect(result.deletedCounts.demos).toBe(1);
    expect(result.failedTargets).toEqual([]);
  });

  test("reports a backup failure for an in-memory database without deleting", async () => {
    seedLearningEntries(home.dataRoot, [
      { category: "old", observation: "old", timestamp: 0 },
    ]);
    collectPruneCandidates({ ageDays: 90 });
    const dbModule = await import("../src/utils/database.js");
    const spy = spyOn(dbModule, "getDatabasePath").mockReturnValue(":memory:");

    try {
      const result = await executeDestructivePrune({
        targets: ["learnings"],
        ageDays: 90,
      });

      expect(result.backupPath).toBeNull();
      expect(result.failedTargets).toEqual([
        { target: "backup", message: "cannot back up an in-memory database" },
      ]);
      expect(result.deletedCounts.learnings).toBe(0);
    } finally {
      spy.mockRestore();
    }
  });

  test("handles no-op destructive run gracefully", async () => {
    const result = await executeDestructivePrune({
      targets: ["learnings"],
      ageDays: 90,
    });

    expect(result.backupPath).not.toBeNull();
    expect(result.candidateCounts.learnings).toBe(0);
    expect(result.deletedCounts.learnings).toBe(0);
    expect(result.failedTargets).toEqual([]);
  });

  test("defers learnings, duplicates, demos, and sessions until backup publication succeeds", async () => {
    const now = Date.now();
    const oldIso = new Date(now - 120 * DAY_MS).toISOString();
    const expectedBackupPath = join(
      home.dataRoot,
      "backups",
      "vibe-prune-2026-02-03T04-05-06-789Z.db",
    );

    seedSessionRows(home.dataRoot, [
      { id: "session-to-prune", createdAt: oldIso, lastAccessedAt: oldIso },
    ]);
    seedLearningEntries(home.dataRoot, [
      {
        category: "stale-cat",
        observation: "stale entry",
        timestamp: now - 120 * DAY_MS,
      },
      {
        category: "demo-cat",
        demoId: "demo-1",
        observation: "demo entry",
        timestamp: now,
      },
      {
        category: "dup-cat",
        observation: "duplicate text",
        timestamp: now - 10 * DAY_MS,
      },
      {
        category: "dup-cat",
        observation: "duplicate text",
        timestamp: now - 5 * DAY_MS,
      },
    ]);

    let signalPublicationStarted!: () => void;
    const publicationStarted = new Promise<void>((resolveStarted) => {
      signalPublicationStarted = resolveStarted;
    });
    let releasePublication!: () => void;
    const publicationReleased = new Promise<void>((resolveRelease) => {
      releasePublication = resolveRelease;
    });

    const prunePromise = executeDestructivePrune({
      targets: ["learnings", "duplicates", "demos", "sessions"],
      ageDays: 90,
      now,
      backupTimestamp: new Date("2026-02-03T04:05:06.789Z"),
      backupOptions: {
        linkExclusive: async (sourcePath, destinationPath) => {
          signalPublicationStarted();
          await publicationReleased;
          await link(sourcePath, destinationPath);
        },
      },
    });

    try {
      await publicationStarted;

      // Publication pending: no target started and every candidate survives.
      expect(existsSync(expectedBackupPath)).toBe(false);
      expect(readSourceRows("SELECT * FROM sessions")).toHaveLength(1);
      expect(readSourceRows("SELECT * FROM learning_entries")).toHaveLength(4);
    } finally {
      releasePublication();
    }

    const result = await prunePromise;
    expect(result.backupPath).toBe(expectedBackupPath);
    expect(result.failedTargets).toEqual([]);
    expect(result.deletedCounts).toEqual({
      learnings: 1,
      duplicates: 1,
      demos: 1,
      sessions: 1,
    });

    // Every selected target applied after publication.
    expect(existsSync(expectedBackupPath)).toBe(true);
    expect(readSourceRows("SELECT * FROM sessions")).toEqual([]);
    expect(
      readSourceRows<{ observation: string }>(
        "SELECT observation FROM learning_entries",
      ),
    ).toEqual([{ observation: "duplicate text" }]);
  });

  test("creates snapshot preserving all records and relationships deleted from the source database", async () => {
    const now = Date.now();
    const oldIso = new Date(now - 120 * DAY_MS).toISOString();

    seedSessionRows(home.dataRoot, [
      {
        id: "session-to-prune",
        createdAt: oldIso,
        lastAccessedAt: oldIso,
        constitutionRules: ["preserve me in backup"],
        interactions: 2,
      },
    ]);

    seedLearningEntries(home.dataRoot, [
      {
        category: "stale-cat",
        observation: "stale entry",
        timestamp: now - 120 * DAY_MS,
      },
      {
        category: "demo-cat",
        demoId: "demo-1",
        observation: "demo entry",
        timestamp: now,
      },
      {
        category: "dup-cat",
        observation: "exact duplicate text",
        timestamp: now - 10 * DAY_MS,
      },
      {
        category: "dup-cat",
        observation: "exact duplicate text",
        timestamp: now - 5 * DAY_MS,
      },
    ]);

    const result = await executeDestructivePrune({
      targets: ["learnings", "duplicates", "demos", "sessions"],
      ageDays: 90,
      now,
    });

    expect(result.backupPath).not.toBeNull();
    expect(result.failedTargets).toEqual([]);
    expect(result.deletedCounts.learnings).toBe(1);
    expect(result.deletedCounts.demos).toBe(1);
    expect(result.deletedCounts.duplicates).toBe(1);
    expect(result.deletedCounts.sessions).toBe(1);

    const backupPath = result.backupPath as string;

    // In source DB: session-to-prune is gone, cascade rules/interactions gone, stale/demo/duplicate deleted
    const sourceDb = new Database(join(home.dataRoot, "vibe.db"));
    try {
      expect(
        sourceDb
          .query("SELECT * FROM sessions WHERE id = 'session-to-prune'")
          .all(),
      ).toHaveLength(0);
      expect(
        sourceDb
          .query(
            "SELECT * FROM constitution_rules WHERE session_id = 'session-to-prune'",
          )
          .all(),
      ).toHaveLength(0);
      expect(
        sourceDb
          .query(
            "SELECT * FROM interactions WHERE session_id = 'session-to-prune'",
          )
          .all(),
      ).toHaveLength(0);
      expect(
        sourceDb
          .query(
            "SELECT * FROM learning_entries WHERE observation = 'stale entry'",
          )
          .all(),
      ).toHaveLength(0);
      expect(
        sourceDb
          .query("SELECT * FROM learning_entries WHERE demo_id = 'demo-1'")
          .all(),
      ).toHaveLength(0);
      expect(
        sourceDb
          .query("SELECT * FROM learning_entries WHERE category = 'dup-cat'")
          .all(),
      ).toHaveLength(1);
    } finally {
      sourceDb.close();
    }

    // In snapshot DB: ALL records and relationships are preserved!
    const backupDb = new Database(backupPath, {
      readonly: true,
      create: false,
    });
    try {
      const sessions = backupDb
        .query<{ id: string }, []>(
          "SELECT id FROM sessions WHERE id = 'session-to-prune'",
        )
        .all();
      expect(sessions).toHaveLength(1);

      const rules = backupDb
        .query<{ rule: string }, []>(
          "SELECT rule FROM constitution_rules WHERE session_id = 'session-to-prune'",
        )
        .all();
      expect(rules).toHaveLength(1);
      expect(rules[0]?.rule).toBe("preserve me in backup");

      const interactions = backupDb
        .query(
          "SELECT * FROM interactions WHERE session_id = 'session-to-prune'",
        )
        .all();
      expect(interactions).toHaveLength(2);

      const staleEntries = backupDb
        .query<{ observation: string }, []>(
          "SELECT observation FROM learning_entries WHERE observation = 'stale entry'",
        )
        .all();
      expect(staleEntries).toHaveLength(1);

      const demoEntries = backupDb
        .query<{ observation: string }, []>(
          "SELECT observation FROM learning_entries WHERE demo_id = 'demo-1'",
        )
        .all();
      expect(demoEntries).toHaveLength(1);

      const dupEntries = backupDb
        .query("SELECT * FROM learning_entries WHERE category = 'dup-cat'")
        .all();
      expect(dupEntries).toHaveLength(2);

      const fk = backupDb.query("PRAGMA foreign_key_check").all();
      expect(fk).toEqual([]);
      const integrity = backupDb
        .query<{ integrity_check: string }, []>("PRAGMA integrity_check")
        .get();
      expect(integrity?.integrity_check).toBe("ok");
    } finally {
      backupDb.close();
    }
  });

  test("returns backupPath null and zero deleted counts on injected snapshot failure", async () => {
    const now = Date.now();
    seedLearningEntries(home.dataRoot, [
      { category: "cat", observation: "old", timestamp: now - 120 * DAY_MS },
    ]);

    const result = await executeDestructivePrune({
      targets: ["learnings"],
      ageDays: 90,
      now,
      backupOptions: {
        snapshotExecutor: async () => {
          throw new Error("injected snapshot failure");
        },
      },
    });

    expect(result.backupPath).toBeNull();
    expect(result.deletedCounts.learnings).toBe(0);
    expect(result.failedTargets).toEqual([
      { target: "backup", message: "injected snapshot failure" },
    ]);

    const db = new Database(join(home.dataRoot, "vibe.db"));
    try {
      expect(db.query("SELECT * FROM learning_entries").all()).toHaveLength(1);
    } finally {
      db.close();
    }
  });

  test("returns backupPath null and zero deleted counts on injected publication failure", async () => {
    const now = Date.now();
    seedLearningEntries(home.dataRoot, [
      { category: "cat", observation: "old", timestamp: now - 120 * DAY_MS },
    ]);

    const result = await executeDestructivePrune({
      targets: ["learnings"],
      ageDays: 90,
      now,
      backupOptions: {
        linkExclusive: async () => {
          throw new Error("injected publication link failure");
        },
      },
    });

    expect(result.backupPath).toBeNull();
    expect(result.deletedCounts.learnings).toBe(0);
    expect(result.failedTargets).toEqual([
      { target: "backup", message: "injected publication link failure" },
    ]);
  });

  test("returns backupPath null without deleting records on post-link staging cleanup failure while retaining complete snapshot", async () => {
    const now = Date.now();
    seedLearningEntries(home.dataRoot, [
      { category: "cat", observation: "old", timestamp: now - 120 * DAY_MS },
    ]);
    const backupTimestamp = new Date("2026-02-03T04:05:06.789Z");
    const expectedBackupFile = join(
      home.dataRoot,
      "backups",
      "vibe-prune-2026-02-03T04-05-06-789Z.db",
    );

    const result = await executeDestructivePrune({
      targets: ["learnings"],
      ageDays: 90,
      now,
      backupTimestamp,
      backupOptions: {
        cleanupStaging: async () => {
          throw new Error("injected post-link cleanup error");
        },
      },
    });

    expect(result.backupPath).toBeNull();
    expect(result.deletedCounts.learnings).toBe(0);
    expect(result.failedTargets).toEqual([
      {
        target: "backup",
        message: expect.stringContaining("injected post-link cleanup error"),
      },
    ]);

    const db = new Database(join(home.dataRoot, "vibe.db"));
    try {
      expect(db.query("SELECT * FROM learning_entries").all()).toHaveLength(1);
    } finally {
      db.close();
    }

    expect(existsSync(expectedBackupFile)).toBe(true);
    const snapshotDb = new Database(expectedBackupFile, {
      readonly: true,
      create: false,
    });
    try {
      expect(
        snapshotDb.query("SELECT * FROM learning_entries").all(),
      ).toHaveLength(1);
      const integrity = snapshotDb
        .query<{ integrity_check: string }, []>("PRAGMA integrity_check")
        .get();
      expect(integrity?.integrity_check).toBe("ok");
    } finally {
      snapshotDb.close();
    }
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

// ── createPruneBackup — acquisition, concurrency, and failure safety ──────

describe("createPruneBackup — acquisition, concurrency, and failure safety", () => {
  test("rejects backup on absent source with legacy input files, keeping source absent and legacy input untouched without backup or import artifacts", async () => {
    mkdirSync(home.dataRoot, { recursive: true });
    const logPath = join(home.dataRoot, "vibe-log.json");
    const rulesPath = join(home.dataRoot, "vibe-rules.json");
    const historyPath = join(home.dataRoot, "vibe-history.json");
    const logContent = JSON.stringify([
      { type: "mistake", category: "c", observation: "m", timestamp: 1 },
    ]);
    const rulesContent = JSON.stringify([{ rule: "r", position: 0 }]);
    const historyContent = JSON.stringify([
      { input: { goal: "g" }, output: "o", timestamp: 2 },
    ]);

    writeFileSync(logPath, logContent, "utf8");
    writeFileSync(rulesPath, rulesContent, "utf8");
    writeFileSync(historyPath, historyContent, "utf8");

    const dbPath = join(home.dataRoot, "vibe.db");
    expect(existsSync(dbPath)).toBe(false);

    await expect(createPruneBackup()).rejects.toThrow();

    // Source database must not be created
    expect(existsSync(dbPath)).toBe(false);

    // Legacy input files must remain completely unchanged
    expect(readFileSync(logPath, "utf8")).toBe(logContent);
    expect(readFileSync(rulesPath, "utf8")).toBe(rulesContent);
    expect(readFileSync(historyPath, "utf8")).toBe(historyContent);

    // No backup or import artifacts
    const backupsDir = join(home.dataRoot, "backups");
    if (existsSync(backupsDir)) {
      expect(readdirSync(backupsDir)).toEqual([]);
    }
    expect(existsSync(`${logPath}.bak`)).toBe(false);
    expect(existsSync(`${rulesPath}.bak`)).toBe(false);
    expect(existsSync(`${historyPath}.bak`)).toBe(false);
  });

  test("source removal after validation and before snapshot open rejects without recreation, output, or owned staging leftovers, preserving prior backup bytes", async () => {
    const seed = seedMultiPageDatabase(home.dataRoot);
    const backupsDir = join(home.dataRoot, "backups");
    mkdirSync(backupsDir, { recursive: true });
    const priorBackupPath = join(
      backupsDir,
      "vibe-prune-2026-01-01T00-00-00-000Z.db",
    );
    writeFileSync(priorBackupPath, "prior backup bytes preserved");
    const priorBytes = readFileSync(priorBackupPath);

    const err = await createPruneBackup(new Date("2026-02-02T00:00:00.000Z"), {
      observer: {
        onBeforeSpawn: async () => {
          rmSync(seed.dbPath);
        },
      },
    }).catch((e) => e);

    expect(err).toBeInstanceOf(Error);
    // Source database must not be recreated
    expect(existsSync(seed.dbPath)).toBe(false);

    // No new backup file published
    expect(
      existsSync(join(backupsDir, "vibe-prune-2026-02-02T00-00-00-000Z.db")),
    ).toBe(false);

    // No staging leftovers
    const staging = readdirSync(backupsDir).filter((name) =>
      name.startsWith(".staging-"),
    );
    expect(staging).toEqual([]);

    // Prior backup remains untouched
    expect(readFileSync(priorBackupPath)).toEqual(priorBytes);
  });

  test("backs up existing DELETE-journal and application-schema-free sources without journal conversion, schema initialization, or legacy import", async () => {
    mkdirSync(home.dataRoot, { recursive: true });
    const dbPath = join(home.dataRoot, "vibe.db");
    const rawDb = new Database(dbPath);
    rawDb.run("PRAGMA journal_mode = DELETE;");
    rawDb.run("CREATE TABLE custom_data (id INTEGER PRIMARY KEY, note TEXT);");
    rawDb.run("INSERT INTO custom_data VALUES (1, 'custom note test');");
    rawDb.close();

    const legacyFile = join(home.dataRoot, "vibe-log.json");
    writeFileSync(legacyFile, "legacy-bytes-must-survive", "utf8");

    const backupPath = await createPruneBackup();

    expect(backupPath).toMatch(
      /vibe-prune-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z\.db$/,
    );
    expect(existsSync(backupPath)).toBe(true);

    // Source inspection: journal_mode is still DELETE, no vibe tables, no WAL/SHM
    const checkDb = new Database(dbPath, { readonly: true, create: false });
    try {
      const jMode = checkDb
        .query<{ journal_mode: string }, []>("PRAGMA journal_mode")
        .get()?.journal_mode;
      expect(jMode?.toLowerCase()).toBe("delete");

      const tables = checkDb
        .query<{ name: string }, []>(
          "SELECT name FROM sqlite_master WHERE type = 'table'",
        )
        .all()
        .map((r) => r.name);
      expect(tables).toEqual(["custom_data"]);
      expect(tables).not.toContain("schema_migrations");
      expect(tables).not.toContain("learning_entries");
    } finally {
      checkDb.close();
    }
    expect(existsSync(`${dbPath}-wal`)).toBe(false);
    expect(existsSync(`${dbPath}-shm`)).toBe(false);

    // Legacy input file is unchanged
    expect(readFileSync(legacyFile, "utf8")).toBe("legacy-bytes-must-survive");
    expect(existsSync(`${legacyFile}.bak`)).toBe(false);

    // Backup inspection: opens independently without WAL/SHM, has custom_data
    const backupDb = new Database(backupPath, {
      readonly: true,
      create: false,
    });
    try {
      const rows = backupDb
        .query<{ id: number; note: string }, []>(
          "SELECT id, note FROM custom_data",
        )
        .all();
      expect(rows).toEqual([{ id: 1, note: "custom note test" }]);
      const integrity = backupDb
        .query<{ integrity_check: string }, []>("PRAGMA integrity_check")
        .get()?.integrity_check;
      expect(integrity).toBe("ok");
    } finally {
      backupDb.close();
    }
  });

  test("leaves concurrent application connection open, queryable, and with unchanged settings across backup", async () => {
    seedMultiPageDatabase(home.dataRoot);
    const appHandle = openVibeDatabase();
    appHandle.db.run("PRAGMA busy_timeout = 7890;");
    appHandle.db.run("PRAGMA foreign_keys = ON;");

    try {
      const backupPath = await createPruneBackup();
      expect(existsSync(backupPath)).toBe(true);
      expect(() => appHandle.db.query("SELECT 1").get()).not.toThrow();

      const timeout = appHandle.db
        .query<{ timeout: number }, []>("PRAGMA busy_timeout")
        .get()?.timeout;
      expect(timeout).toBe(7890);

      const fk = appHandle.db
        .query<{ foreign_keys: number }, []>("PRAGMA foreign_keys")
        .get()?.foreign_keys;
      expect(fk).toBe(1);
    } finally {
      appHandle.close();
    }
  });

  test("with acknowledged exclusive lock held, parent work progresses during invocation and SQLite contention rejects before lock release within measured bound below 5000ms", async () => {
    const seed = seedMultiPageDatabase(home.dataRoot, {
      journalMode: "DELETE",
    });
    const lock = await spawnConcurrentExclusiveLock(seed.dbPath);
    activeExclusiveLocks.push(lock);

    let ticksDuringInvocation = 0;
    let pumpActive = true;
    const pump = () => {
      if (!pumpActive) return;
      ticksDuringInvocation += 1;
      setImmediate(pump);
    };
    setImmediate(pump);

    const startTime = performance.now();
    let rejectionError: unknown = null;
    try {
      await createPruneBackup();
    } catch (err) {
      rejectionError = err;
    } finally {
      pumpActive = false;
      await lock.release();
    }
    const elapsedMs = performance.now() - startTime;

    expect(rejectionError).toBeInstanceOf(Error);
    const message = (rejectionError as Error).message;
    expect(message).toMatch(/busy|locked/i);
    expect(message).not.toMatch(/timed out after/i);
    expect(ticksDuringInvocation).toBeGreaterThan(0);
    expect(elapsedMs).toBeLessThan(5000);

    const backupsDir = join(home.dataRoot, "backups");
    if (existsSync(backupsDir)) {
      const staging = readdirSync(backupsDir).filter((name) =>
        name.startsWith(".staging-"),
      );
      expect(staging).toEqual([]);
    }
  }, 10_000);
});
