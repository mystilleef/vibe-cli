import { Database } from "bun:sqlite";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  expectTypeOf,
  test,
} from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { link } from "node:fs/promises";
import { join } from "node:path";
import {
  type PruneRunOptions,
  type PruneSuccessPayload,
  runPrune,
} from "../src/tools/prune";
import { requireBackupPath } from "./helpers/requireBackupPath";
import { seedLearningEntries, seedSessionRows } from "./helpers/storageSeed";
import { createTempHome, type TempHomeContext } from "./helpers/tempHome";

const DAY_MS = 24 * 60 * 60 * 1000;

let home: TempHomeContext;

beforeEach(async () => {
  home = await createTempHome();
});

afterEach(async () => {
  await home.cleanup();
});

function readLearningObservations(category: string): string[] {
  const db = new Database(join(home.dataRoot, "vibe.db"));
  try {
    return db
      .query<{ observation: string }, [string]>(
        "SELECT observation FROM learning_entries WHERE category = ? ORDER BY id",
      )
      .all(category)
      .map((row) => row.observation);
  } finally {
    db.close();
  }
}

function readSessionIds(): string[] {
  const db = new Database(join(home.dataRoot, "vibe.db"));
  try {
    return db
      .query<{ id: string }, []>("SELECT id FROM sessions ORDER BY id")
      .all()
      .map((row) => row.id);
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------------------
// resolveExplicitTargets (internal, tested through runPrune)
// ---------------------------------------------------------------------------
describe("runPrune — resolveExplicitTargets (internal)", () => {
  test("maps --learnings to learnings target", async () => {
    const result = await runPrune({ learnings: true, dryRun: true });
    expect(result.targets).toEqual(["learnings"]);
    expect(result.skippedTargets).toEqual(["duplicates", "demos", "sessions"]);
  });

  test("maps --duplicates to duplicates target", async () => {
    const result = await runPrune({ duplicates: true, dryRun: true });
    expect(result.targets).toEqual(["duplicates"]);
    expect(result.skippedTargets).toEqual(["learnings", "demos", "sessions"]);
  });

  test("maps --demos to demos target", async () => {
    const result = await runPrune({ demos: true, dryRun: true });
    expect(result.targets).toEqual(["demos"]);
    expect(result.skippedTargets).toEqual([
      "learnings",
      "duplicates",
      "sessions",
    ]);
  });

  test("maps --sessions to sessions target", async () => {
    const result = await runPrune({ sessions: true, dryRun: true });
    expect(result.targets).toEqual(["sessions"]);
    expect(result.skippedTargets).toEqual(["learnings", "duplicates", "demos"]);
  });

  test("maps multiple flags to multiple targets", async () => {
    const result = await runPrune({
      learnings: true,
      duplicates: true,
      dryRun: true,
    });
    expect(result.targets).toEqual(["learnings", "duplicates"]);
    expect(result.skippedTargets).toEqual(["demos", "sessions"]);
  });

  test("defaults to all targets when no flags specified", async () => {
    const result = await runPrune({});
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
  test("uses default age (90 days) when --age is omitted", async () => {
    const now = Date.now();
    seedLearningEntries(home.dataRoot, [
      {
        category: "old",
        observation: "old entry",
        timestamp: now - 100 * DAY_MS,
      },
      {
        category: "recent",
        observation: "recent entry",
        timestamp: now - 10 * DAY_MS,
      },
    ]);

    const result = await runPrune({ learnings: true, dryRun: true });
    // With default age=90, only the 100-day-old entry should be a candidate
    expect(result.candidateCounts.learnings).toBe(1);
  });

  test("accepts valid age and narrows candidates", async () => {
    const now = Date.now();
    seedLearningEntries(home.dataRoot, [
      {
        category: "old",
        observation: "very old",
        timestamp: now - 100 * DAY_MS,
      },
      {
        category: "medium",
        observation: "medium old",
        timestamp: now - 60 * DAY_MS,
      },
      {
        category: "recent",
        observation: "pretty recent",
        timestamp: now - 10 * DAY_MS,
      },
    ]);

    const result = await runPrune({ learnings: true, age: 50, dryRun: true });
    // cutoff = now - 50 days, so entries older than 50 days: 100 and 60 day old entries
    expect(result.candidateCounts.learnings).toBe(2);
  });

  test("rejects non-integer age", async () => {
    await expect(
      runPrune({ learnings: true, age: 1.5, dryRun: true }),
    ).rejects.toThrow("--age must be a positive integer");
  });

  test("rejects zero age", async () => {
    await expect(
      runPrune({ learnings: true, age: 0, dryRun: true }),
    ).rejects.toThrow("--age must be a positive integer");
  });

  test("rejects negative age", async () => {
    await expect(
      runPrune({ learnings: true, age: -5, dryRun: true }),
    ).rejects.toThrow("--age must be a positive integer");
  });

  test("accepts large age values", async () => {
    const now = Date.now();
    seedLearningEntries(home.dataRoot, [
      {
        category: "very-old",
        observation: "some entry",
        timestamp: now - 4000 * DAY_MS,
      },
    ]);

    const result = await runPrune({ learnings: true, age: 3650, dryRun: true });
    // Entry from ~11 years ago exceeds 10-year cutoff
    expect(result.candidateCounts.learnings).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// validateOverlap (internal, tested through runPrune error propagation)
// ---------------------------------------------------------------------------
describe("runPrune — validateOverlap (internal)", () => {
  test("uses default overlap threshold (0.6) when --overlap is omitted", async () => {
    seedLearningEntries(home.dataRoot, [
      {
        category: "threshold",
        observation: "alpha beta gamma delta",
        timestamp: 10,
      },
      {
        category: "threshold",
        observation: "alpha beta gamma omega",
        timestamp: 20,
      },
    ]);

    const result = await runPrune({ duplicates: true, dryRun: true });
    expect(result.candidateCounts.duplicates).toBe(1);
  });

  test("includes exact default-threshold overlaps", async () => {
    seedLearningEntries(home.dataRoot, [
      {
        category: "threshold",
        observation: "alpha beta gamma delta epsilon",
        timestamp: 10,
      },
      {
        category: "threshold",
        observation: "alpha beta gamma zeta eta",
        timestamp: 20,
      },
    ]);

    const result = await runPrune({ duplicates: true, dryRun: true });
    expect(result.candidateCounts.duplicates).toBe(1);
  });

  test("excludes below default-threshold overlaps", async () => {
    seedLearningEntries(home.dataRoot, [
      {
        category: "threshold",
        observation: "alpha beta gamma delta epsilon",
        timestamp: 10,
      },
      {
        category: "threshold",
        observation: "alpha beta zeta eta theta",
        timestamp: 20,
      },
    ]);

    const result = await runPrune({ duplicates: true, dryRun: true });
    expect(result.candidateCounts.duplicates).toBe(0);
  });

  test("rejects overlap below 0", async () => {
    await expect(
      runPrune({ duplicates: true, overlap: -0.1, dryRun: true }),
    ).rejects.toThrow("--overlap must be a float between 0 and 1 inclusive");
  });

  test("rejects overlap above 1", async () => {
    await expect(
      runPrune({ duplicates: true, overlap: 1.5, dryRun: true }),
    ).rejects.toThrow("--overlap must be a float between 0 and 1 inclusive");
  });

  test("rejects non-number overlap", async () => {
    await expect(
      runPrune({
        duplicates: true,
        overlap: "abc" as unknown as number,
        dryRun: true,
      }),
    ).rejects.toThrow("--overlap must be a float between 0 and 1 inclusive");
  });

  test("accepts overlap of exactly 0 for zero-score pairs", async () => {
    seedLearningEntries(home.dataRoot, [
      {
        category: "threshold",
        observation: "alpha beta",
        timestamp: 10,
      },
      {
        category: "threshold",
        observation: "gamma delta",
        timestamp: 20,
      },
    ]);

    const result = await runPrune({
      duplicates: true,
      overlap: 0,
      dryRun: true,
    });
    expect(result.candidateCounts.duplicates).toBe(1);
  });

  test("accepts overlap of exactly 1", async () => {
    seedLearningEntries(home.dataRoot, [
      {
        category: "threshold",
        observation: "alpha beta gamma delta",
        timestamp: 10,
      },
      {
        category: "threshold",
        observation: "alpha beta gamma omega",
        timestamp: 20,
      },
    ]);

    const result = await runPrune({
      duplicates: true,
      overlap: 1,
      dryRun: true,
    });
    expect(result.candidateCounts.duplicates).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// validateCategory (internal, tested through runPrune error propagation)
// ---------------------------------------------------------------------------
describe("runPrune — validateCategory (internal)", () => {
  test("accepts --category with --learnings", async () => {
    const result = await runPrune({
      learnings: true,
      category: "scope",
      dryRun: true,
    });
    expect(result.dryRun).toBe(true);
    expect(result.targets).toEqual(["learnings"]);
  });

  test("accepts --category with --duplicates", async () => {
    const result = await runPrune({
      duplicates: true,
      category: "scope",
      dryRun: true,
    });
    expect(result.dryRun).toBe(true);
    expect(result.targets).toEqual(["duplicates"]);
  });

  test("accepts --category with --learnings and --duplicates together", async () => {
    const result = await runPrune({
      learnings: true,
      duplicates: true,
      category: "scope",
      dryRun: true,
    });
    expect(result.targets).toContain("learnings");
    expect(result.targets).toContain("duplicates");
  });

  test("rejects --category with --demos", async () => {
    await expect(
      runPrune({ demos: true, category: "scope", dryRun: true }),
    ).rejects.toThrow(
      "--category is only allowed with --learnings or --duplicates",
    );
  });

  test("rejects --category with --sessions", async () => {
    await expect(
      runPrune({ sessions: true, category: "scope", dryRun: true }),
    ).rejects.toThrow(
      "--category is only allowed with --learnings or --duplicates",
    );
  });

  test("accepts --category with --learnings and --demos together", async () => {
    const result = await runPrune({
      learnings: true,
      demos: true,
      category: "scope",
      dryRun: true,
    });
    expect(result.targets).toEqual(["learnings", "demos"]);
  });

  test("accepts --category with --duplicates and --sessions together", async () => {
    const result = await runPrune({
      duplicates: true,
      sessions: true,
      category: "scope",
      dryRun: true,
    });
    expect(result.targets).toEqual(["duplicates", "sessions"]);
  });

  test("rejects --category with no explicit targets", async () => {
    await expect(runPrune({ category: "scope" })).rejects.toThrow(
      "--category is only allowed with --learnings or --duplicates",
    );
  });
});

// ---------------------------------------------------------------------------
// extractRepresentativeDetails (internal, tested through runPrune output)
// ---------------------------------------------------------------------------
describe("runPrune — extractRepresentativeDetails (internal)", () => {
  test("populates learnings representative details", async () => {
    const now = Date.now();
    const oldMs = now - 100 * DAY_MS;
    seedLearningEntries(home.dataRoot, [
      { category: "cat", observation: "Mistake one.", timestamp: oldMs },
    ]);

    const result = await runPrune({ learnings: true, age: 90, dryRun: true });
    expect(result.representativeDetails.learnings).toHaveLength(1);
    expect(result.representativeDetails.learnings[0]).toMatchObject({
      category: "cat",
      observation: "Mistake one.",
    });
    expect(typeof result.representativeDetails.learnings[0]?.id).toBe("number");
  });

  test("caps learnings details at 5 entries", async () => {
    const now = Date.now();
    for (let i = 0; i < 10; i++) {
      seedLearningEntries(home.dataRoot, [
        {
          category: "cat",
          observation: `Mistake ${i}.`,
          timestamp: now - 100 * DAY_MS,
        },
      ]);
    }

    const result = await runPrune({ learnings: true, age: 90, dryRun: true });
    expect(result.representativeDetails.learnings).toHaveLength(5);
  });

  test("populates duplicates representative details", async () => {
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

    const result = await runPrune({ duplicates: true, dryRun: true });
    expect(result.representativeDetails.duplicates).toHaveLength(1);
    expect(result.representativeDetails.duplicates[0]).toMatchObject({
      category: "scope",
    });
    expect(result.representativeDetails.duplicates[0]?.prunableIds.length).toBe(
      1,
    );
  });

  test("populates demos representative details with demoId", async () => {
    seedLearningEntries(home.dataRoot, [
      {
        category: "demo-cat",
        demoId: "demo-1",
        observation: "Demo mistake.",
        timestamp: 100 * DAY_MS,
      },
    ]);

    const result = await runPrune({ demos: true, dryRun: true });
    expect(result.representativeDetails.demos).toHaveLength(1);
    expect(result.representativeDetails.demos[0]).toMatchObject({
      category: "demo-cat",
      observation: "Demo mistake.",
      demoId: "demo-1",
    });
  });

  test("permits demos representative details without demoId", () => {
    const detail: PruneSuccessPayload["representativeDetails"]["demos"][number] =
      {
        id: 1,
        category: "demo-cat",
        observation: "Demo mistake.",
      };

    expect(detail.demoId).toBeUndefined();
    expect(Object.hasOwn(detail, "demoId")).toBe(false);
  });

  test("populates sessions representative details", async () => {
    const now = new Date();
    const oldCreated = new Date(now.getTime() - 120 * DAY_MS).toISOString();
    const oldAccessed = new Date(now.getTime() - 100 * DAY_MS).toISOString();
    seedSessionRows(home.dataRoot, [
      {
        id: "session-old",
        createdAt: oldCreated,
        lastAccessedAt: oldAccessed,
      },
    ]);

    const result = await runPrune({ sessions: true, age: 90, dryRun: true });
    expect(result.representativeDetails.sessions).toHaveLength(1);
    expect(result.representativeDetails.sessions[0]).toMatchObject({
      sessionId: "session-old",
    });
  });

  test("returns empty arrays for targets with no candidates", async () => {
    const result = await runPrune({ demos: true, dryRun: true });

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
  test("dryRun=true with explicit targets returns zero deleted count", async () => {
    const now = Date.now();
    seedLearningEntries(home.dataRoot, [
      {
        category: "old",
        observation: "old entry",
        timestamp: now - 100 * DAY_MS,
      },
    ]);

    const result = await runPrune({
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

  test("no explicit targets defaults to dry-run with all targets", async () => {
    const result = await runPrune({});
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

  test("explicit targets without --yes defaults to dry-run", async () => {
    const now = Date.now();
    seedLearningEntries(home.dataRoot, [
      {
        category: "old",
        observation: "old entry",
        timestamp: now - 100 * DAY_MS,
      },
    ]);

    const result = await runPrune({ learnings: true, age: 90 });

    expect(result.dryRun).toBe(true);
    expect(result.candidateCounts.learnings).toBeGreaterThanOrEqual(1);
    expect(result.deletedCounts.learnings).toBe(0);
  });

  test("dryRun=true with yes=true rejects the conflicting modes", async () => {
    await expect(
      runPrune({
        learnings: true,
        age: 90,
        dryRun: true,
        yes: true,
      }),
    ).rejects.toThrow("--dry-run cannot be combined with --yes");
  });

  test("false target flags behave like absent target flags", async () => {
    const result = await runPrune({
      learnings: false,
      duplicates: false,
      demos: false,
      sessions: false,
      dryRun: true,
    });

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
// runPrune — destructive mode
// ---------------------------------------------------------------------------
describe("runPrune — destructive mode", () => {
  test("creates a backup and deletes stale learning entries with --yes", async () => {
    const now = Date.now();
    const oldMs = now - 100 * DAY_MS;
    const recentMs = now - 10 * DAY_MS;
    seedLearningEntries(home.dataRoot, [
      { category: "old", observation: "old entry", timestamp: oldMs },
      { category: "recent", observation: "recent entry", timestamp: recentMs },
    ]);

    const result = await runPrune({
      learnings: true,
      age: 90,
      yes: true,
    });

    expect(result.dryRun).toBe(false);
    const backupPath = requireBackupPath(result);
    expect(backupPath).toContain("backups");
    // Only the entry older than 90 days should be deleted
    expect(result.deletedCounts.learnings).toBe(1);
    expect(result.failedTargets).toEqual([]);
  });

  test("reports backup failure and preserves rows with --yes", async () => {
    const now = Date.now();
    seedLearningEntries(home.dataRoot, [
      {
        category: "old",
        observation: "kept after backup failure",
        timestamp: now - 100 * DAY_MS,
      },
    ]);
    writeFileSync(join(home.dataRoot, "backups"), "not a directory", "utf8");

    const result = await runPrune({
      learnings: true,
      age: 90,
      yes: true,
    });

    expect(result.dryRun).toBe(false);
    expect(result.backupPath).toBeNull();
    expect(result.failedTargets).toEqual([
      { target: "backup", message: expect.any(String) },
    ]);
    expect(result.deletedCounts).toEqual({
      learnings: 0,
      duplicates: 0,
      demos: 0,
      sessions: 0,
    });
    expect(readLearningObservations("old")).toEqual([
      "kept after backup failure",
    ]);
  });

  test("defers every selected prune target until backup publication succeeds", async () => {
    const now = Date.now();
    const oldIso = new Date(now - 120 * DAY_MS).toISOString();
    const backupTimestamp = new Date("2026-02-03T04:05:06.789Z");
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

    const prunePromise = runPrune(
      {
        learnings: true,
        duplicates: true,
        demos: true,
        sessions: true,
        age: 90,
        yes: true,
      },
      {
        backupTimestamp,
        backupOptions: {
          linkExclusive: async (sourcePath, destinationPath) => {
            signalPublicationStarted();
            await publicationReleased;
            await link(sourcePath, destinationPath);
          },
        },
      },
    );

    try {
      await publicationStarted;

      // Publication pending: no target started and every candidate survives.
      expect(existsSync(expectedBackupPath)).toBe(false);
      expect(readSessionIds()).toEqual(["session-to-prune"]);
      expect(readLearningObservations("stale-cat")).toEqual(["stale entry"]);
      expect(readLearningObservations("demo-cat")).toEqual(["demo entry"]);
      expect(readLearningObservations("dup-cat")).toEqual([
        "duplicate text",
        "duplicate text",
      ]);
    } finally {
      releasePublication();
    }

    const result = await prunePromise;
    expect(result.dryRun).toBe(false);
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
    expect(readSessionIds()).toEqual([]);
    expect(readLearningObservations("stale-cat")).toEqual([]);
    expect(readLearningObservations("demo-cat")).toEqual([]);
    expect(readLearningObservations("dup-cat")).toEqual(["duplicate text"]);
  });

  test("returns backupPath null without deleting on post-link staging cleanup failure", async () => {
    const now = Date.now();
    seedLearningEntries(home.dataRoot, [
      {
        category: "old",
        observation: "preserved after cleanup failure",
        timestamp: now - 100 * DAY_MS,
      },
    ]);

    const result = await runPrune(
      { learnings: true, age: 90, yes: true },
      {
        backupOptions: {
          cleanupStaging: async () => {
            throw new Error("injected post-link cleanup error");
          },
        },
      },
    );

    expect(result.backupPath).toBeNull();
    expect(result.deletedCounts.learnings).toBe(0);
    expect(result.failedTargets).toEqual([
      {
        target: "backup",
        message: expect.stringContaining("injected post-link cleanup error"),
      },
    ]);
    expect(readLearningObservations("old")).toEqual([
      "preserved after cleanup failure",
    ]);
  });

  test("creates snapshot preserving records deleted by runPrune with --yes", async () => {
    const now = Date.now();
    seedLearningEntries(home.dataRoot, [
      {
        category: "old",
        observation: "deleted from source preserved in backup",
        timestamp: now - 100 * DAY_MS,
      },
    ]);

    const result = await runPrune({
      learnings: true,
      age: 90,
      yes: true,
    });

    const backupPath = requireBackupPath(result);
    expect(readLearningObservations("old")).toEqual([]);

    const backupDb = new Database(backupPath, {
      readonly: true,
      create: false,
    });
    try {
      const rows = backupDb
        .query<{ observation: string }, [string]>(
          "SELECT observation FROM learning_entries WHERE category = ?",
        )
        .all("old");
      expect(rows).toEqual([
        { observation: "deleted from source preserved in backup" },
      ]);
      const integrity = backupDb
        .query<{ integrity_check: string }, []>("PRAGMA integrity_check")
        .get();
      expect(integrity?.integrity_check).toBe("ok");
    } finally {
      backupDb.close();
    }
  });

  test("deletes duplicate learning entries with --yes", async () => {
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

    const result = await runPrune({
      duplicates: true,
      yes: true,
    });

    expect(result.dryRun).toBe(false);
    expect(result.deletedCounts.duplicates).toBe(1);
    expect(result.backupPath).toBeDefined();
    expect(result.backupPath).not.toBeNull();
  });

  test("deletes demo entries with --yes", async () => {
    seedLearningEntries(home.dataRoot, [
      {
        category: "demo-cat",
        demoId: "demo-1",
        observation: "Demo entry.",
        timestamp: 100 * DAY_MS,
      },
    ]);

    const result = await runPrune({
      demos: true,
      yes: true,
    });

    expect(result.dryRun).toBe(false);
    expect(result.deletedCounts.demos).toBe(1);
    expect(result.backupPath).toBeDefined();
    expect(result.backupPath).not.toBeNull();
  });

  test("deletes stale sessions with --yes", async () => {
    const now = new Date();
    const oldCreated = new Date(now.getTime() - 120 * DAY_MS).toISOString();
    const oldAccessed = new Date(now.getTime() - 100 * DAY_MS).toISOString();
    seedSessionRows(home.dataRoot, [
      {
        id: "session-old",
        createdAt: oldCreated,
        lastAccessedAt: oldAccessed,
        constitutionRules: ["rule a"],
        interactions: 2,
      },
    ]);

    const result = await runPrune({
      sessions: true,
      age: 90,
      yes: true,
    });

    expect(result.dryRun).toBe(false);
    expect(result.deletedCounts.sessions).toBe(1);
    expect(result.backupPath).toBeDefined();
    expect(result.backupPath).not.toBeNull();
  });

  test("reports candidateCounts and representativeDetails in destructive mode", async () => {
    const now = Date.now();
    seedLearningEntries(home.dataRoot, [
      {
        category: "old",
        observation: "old entry one.",
        timestamp: now - 120 * DAY_MS,
      },
      {
        category: "old",
        observation: "old entry two.",
        timestamp: now - 110 * DAY_MS,
      },
    ]);

    const result = await runPrune({
      learnings: true,
      age: 90,
      yes: true,
    });

    expect(result.candidateCounts.learnings).toBe(2);
    expect(result.representativeDetails.learnings).toHaveLength(2);
    expect(result.deletedCounts.learnings).toBe(2);
  });

  test("reports skipped targets for partial target selection", async () => {
    const result = await runPrune({
      learnings: true,
      yes: true,
    });

    expect(result.skippedTargets).toEqual(["duplicates", "demos", "sessions"]);
  });

  test("reports empty skipped targets when all targets selected", async () => {
    const result = await runPrune({
      learnings: true,
      duplicates: true,
      demos: true,
      sessions: true,
      yes: true,
    });

    expect(result.skippedTargets).toEqual([]);
  });

  test("handles no-op destructive run (nothing to delete)", async () => {
    const result = await runPrune({
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
// runPrune — backup option seam
// ---------------------------------------------------------------------------
describe("runPrune — backup option seam", () => {
  test("exposes only backup lifecycle controls through PruneRunOptions", () => {
    expectTypeOf<keyof PruneRunOptions>().toEqualTypeOf<
      "backupTimestamp" | "backupDatabase" | "backupOptions"
    >();
  });

  test("ignores injected targets override and preserves input-derived selection", async () => {
    const now = Date.now();
    const oldIso = new Date(now - 120 * DAY_MS).toISOString();
    seedLearningEntries(home.dataRoot, [
      {
        category: "selected-cat",
        observation: "selected learning",
        timestamp: now - 120 * DAY_MS,
      },
    ]);
    seedSessionRows(home.dataRoot, [
      { id: "unselected-session", createdAt: oldIso, lastAccessedAt: oldIso },
    ]);

    const result = await runPrune(
      { learnings: true, age: 90, yes: true },
      // @ts-expect-error target policy derives from PruneInput, not run options
      { targets: ["sessions"] },
    );

    requireBackupPath(result);
    expect(result.dryRun).toBe(false);
    expect(result.targets).toEqual(["learnings"]);
    expect(result.skippedTargets).toEqual(["duplicates", "demos", "sessions"]);
    expect(result.failedTargets).toEqual([]);
    expect(result.deletedCounts).toEqual({
      learnings: 1,
      duplicates: 0,
      demos: 0,
      sessions: 0,
    });
    expect(readLearningObservations("selected-cat")).toEqual([]);
    expect(readSessionIds()).toEqual(["unselected-session"]);
  });

  test("ignores injected candidate-policy overrides during destructive runs", async () => {
    const now = Date.now();
    const oldIso = new Date(now - 120 * DAY_MS).toISOString();
    seedLearningEntries(home.dataRoot, [
      {
        category: "stale-cat",
        observation: "stale learning",
        timestamp: now - 120 * DAY_MS,
      },
    ]);
    seedSessionRows(home.dataRoot, [
      { id: "session-old", createdAt: oldIso, lastAccessedAt: oldIso },
    ]);

    // Simulate an untyped caller bypassing the seam's type contract.
    const injectedPolicy = {
      ageDays: 36500,
      now: 0,
      category: "missing-cat",
      activeSessionId: "session-old",
      overlapThreshold: 1,
    } as unknown as PruneRunOptions;

    const result = await runPrune(
      { learnings: true, sessions: true, age: 90, yes: true },
      injectedPolicy,
    );

    requireBackupPath(result);
    expect(result.targets).toEqual(["learnings", "sessions"]);
    expect(result.candidateCounts).toEqual({
      learnings: 1,
      duplicates: 0,
      demos: 0,
      sessions: 1,
    });
    expect(result.deletedCounts).toEqual({
      learnings: 1,
      duplicates: 0,
      demos: 0,
      sessions: 1,
    });
    expect(result.skippedTargets).toEqual(["duplicates", "demos"]);
    expect(result.failedTargets).toEqual([]);
    expect(readLearningObservations("stale-cat")).toEqual([]);
    expect(readSessionIds()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// runPrune — error propagation from validators
// ---------------------------------------------------------------------------
describe("runPrune — error propagation", () => {
  test("propagates validateAge errors", async () => {
    await expect(
      runPrune({ learnings: true, age: 0, dryRun: true }),
    ).rejects.toThrow("--age must be a positive integer");
  });

  test("propagates validateOverlap errors", async () => {
    await expect(
      runPrune({ duplicates: true, overlap: -1, dryRun: true }),
    ).rejects.toThrow("--overlap must be a float between 0 and 1 inclusive");
  });

  test("propagates validateCategory errors", async () => {
    await expect(
      runPrune({ demos: true, category: "test", dryRun: true }),
    ).rejects.toThrow(
      "--category is only allowed with --learnings or --duplicates",
    );
  });
});

// ---------------------------------------------------------------------------
// runPrune — multi-target combinations
// ---------------------------------------------------------------------------
describe("runPrune — multi-target combinations", () => {
  test("runs all four targets simultaneously in dry-run", async () => {
    const now = Date.now();
    seedLearningEntries(home.dataRoot, [
      {
        category: "old",
        observation: "old entry",
        timestamp: now - 100 * DAY_MS,
      },
      {
        category: "dup",
        observation: "duplicate pattern",
        timestamp: now - 100 * DAY_MS,
      },
      {
        category: "dup",
        observation: "duplicate pattern again",
        timestamp: now - 99 * DAY_MS,
      },
      {
        category: "demo",
        demoId: "demo-x",
        observation: "demo entry",
        timestamp: now - 100 * DAY_MS,
      },
    ]);
    const oldCreated = new Date(now - 100 * DAY_MS).toISOString();
    const oldAccessed = new Date(now - 100 * DAY_MS).toISOString();
    seedSessionRows(home.dataRoot, [
      {
        id: "session-old",
        createdAt: oldCreated,
        lastAccessedAt: oldAccessed,
      },
    ]);

    const result = await runPrune({
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

  test("runs all four targets in destructive mode", async () => {
    const now = Date.now();
    seedLearningEntries(home.dataRoot, [
      {
        category: "old",
        observation: "old entry",
        timestamp: now - 100 * DAY_MS,
      },
      {
        category: "dup",
        observation: "duplicate pattern",
        timestamp: now - 100 * DAY_MS,
      },
      {
        category: "dup",
        observation: "duplicate pattern again",
        timestamp: now - 99 * DAY_MS,
      },
      {
        category: "demo",
        demoId: "demo-x",
        observation: "demo entry",
        timestamp: now - 100 * DAY_MS,
      },
    ]);
    const oldCreated = new Date(now - 100 * DAY_MS).toISOString();
    const oldAccessed = new Date(now - 100 * DAY_MS).toISOString();
    seedSessionRows(home.dataRoot, [
      {
        id: "session-old",
        createdAt: oldCreated,
        lastAccessedAt: oldAccessed,
      },
    ]);

    const result = await runPrune({
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
