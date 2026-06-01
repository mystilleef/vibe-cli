import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { getDatabasePath, withDatabase } from "../src/utils/database";
import {
  addLearningEntry,
  collectDemoLearningPruneCandidates,
  collectDuplicateLearningPruneGroups,
  collectPruneCandidates,
  collectStaleLearningPruneCandidates,
  collectStaleSessionPruneCandidates,
  createPruneDatabaseBackup,
  executeDestructivePrune,
  getLearningCategorySummary,
  getLearningContextText,
  getLearningEntries,
  type LearningType,
  removeLearningEntriesForDemo,
} from "../src/utils/storage";
import { createTempHome, type TempHomeContext } from "./helpers/tempHome";

let home: TempHomeContext;

const DAY_MS = 24 * 60 * 60 * 1000;

beforeEach(async () => {
  home = await createTempHome();
});

afterEach(async () => {
  await home.cleanup();
});

describe("addLearningEntry", () => {
  test("creates a new category and returns the entry", () => {
    const entry = addLearningEntry("forgot import", "imports", "add import");
    expect(entry.type).toBe("mistake");
    expect(entry.category).toBe("imports");
    expect(entry.mistake).toBe("forgot import");
    expect(entry.solution).toBe("add import");
    expect(typeof entry.timestamp).toBe("number");
  });

  test("supports non-default type values", () => {
    const e = addLearningEntry("good pattern", "style", undefined, "success");
    expect(e.type).toBe("success");
    expect(e.solution).toBeUndefined();
  });

  test("increments count on repeated category writes", () => {
    addLearningEntry("e1", "cat");
    addLearningEntry("e2", "cat");
    const summary = getLearningCategorySummary();
    const found = summary.find((s) => s.category === "cat");
    expect(found?.count).toBe(2);
  });
});

describe("getLearningEntries", () => {
  test("returns empty object when log is fresh", () => {
    expect(getLearningEntries()).toEqual({});
  });

  test("groups entries by category", () => {
    addLearningEntry("e1", "a");
    addLearningEntry("e2", "b");
    addLearningEntry("e3", "a");
    const entries = getLearningEntries();
    expect(entries.a).toHaveLength(2);
    expect(entries.b).toHaveLength(1);
  });
});

describe("getLearningCategorySummary", () => {
  test("returns empty array when no entries", () => {
    expect(getLearningCategorySummary()).toEqual([]);
  });

  test("sorts by count descending and exposes recentExample", () => {
    addLearningEntry("x", "low");
    addLearningEntry("y", "high");
    addLearningEntry("z", "high");
    const summary = getLearningCategorySummary();
    expect(summary[0]?.category).toBe("high");
    expect(summary[0]?.count).toBe(2);
    expect(summary[0]?.recentExample.mistake).toBe("z");
    expect(summary[1]?.category).toBe("low");
  });
});

// Write a log file with controlled timestamps directly, bypassing Date.now() races.
function writeRawLog(
  dataRoot: string,
  categories: Record<
    string,
    Array<{
      mistake: string;
      timestamp: number;
      type?: string;
      demoId?: string;
    }>
  >,
) {
  const logPath = path.join(dataRoot, "vibe-log.json");
  const mistakes: Record<
    string,
    { count: number; examples: object[]; lastUpdated: number }
  > = {};
  for (const [cat, entries] of Object.entries(categories)) {
    mistakes[cat] = {
      count: entries.length,
      examples: entries.map((e) => ({
        type: e.type ?? "mistake",
        category: cat,
        mistake: e.mistake,
        timestamp: e.timestamp,
        ...(e.demoId !== undefined && { demoId: e.demoId }),
      })),
      lastUpdated: Math.max(...entries.map((e) => e.timestamp)),
    };
  }
  fs.mkdirSync(dataRoot, { recursive: true });
  fs.writeFileSync(
    logPath,
    JSON.stringify({ mistakes, lastUpdated: Date.now() }),
  );
}

type SeedLearningRow = {
  category: string;
  mistake: string;
  timestamp: number;
  type?: LearningType;
  solution?: string;
  demoId?: string;
};

function insertLearningRows(rows: SeedLearningRow[]): number[] {
  return withDatabase((db) => {
    const insert = db.prepare(
      "INSERT INTO learning_entries (type, category, mistake, solution, timestamp, demo_id) VALUES (?, ?, ?, ?, ?, ?)",
    );
    return rows.map((row) => {
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
  });
}

function idAt(ids: number[], index: number): number {
  const id = ids[index];
  if (id === undefined) throw new Error(`missing seeded row id at ${index}`);
  return id;
}

type SeedSessionRow = {
  id: string;
  cwd?: string | null;
  createdAt: string;
  lastAccessedAt: string;
  constitutionRules?: string[];
  interactions?: number;
};

function insertSessionRows(rows: SeedSessionRow[]): void {
  withDatabase((db) => {
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
        `session-prune-${rowIndex}`,
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
  });
}

function isoAtDay(day: number): string {
  return new Date(day * DAY_MS).toISOString();
}

function readSessionTableCounts(): {
  sessions: number;
  constitutionRules: number;
  interactions: number;
} {
  return withDatabase((db) => ({
    sessions:
      db
        .query<{ count: number }, []>("SELECT COUNT(*) AS count FROM sessions")
        .get()?.count ?? 0,
    constitutionRules:
      db
        .query<{ count: number }, []>(
          "SELECT COUNT(*) AS count FROM constitution_rules",
        )
        .get()?.count ?? 0,
    interactions:
      db
        .query<{ count: number }, []>(
          "SELECT COUNT(*) AS count FROM interactions",
        )
        .get()?.count ?? 0,
  }));
}

function readLearningRowIds(): number[] {
  return withDatabase((db) =>
    db
      .query<{ id: number }, []>(
        "SELECT id FROM learning_entries ORDER BY id ASC",
      )
      .all()
      .map((row) => row.id),
  );
}

function requireBackupPath(result: { backupPath: string | null }): string {
  if (result.backupPath === null) throw new Error("missing backup path");
  expect(fs.existsSync(result.backupPath)).toBe(true);
  return result.backupPath;
}

describe("collectStaleLearningPruneCandidates", () => {
  test("returns empty candidates when no learning entries exist", () => {
    expect(
      collectStaleLearningPruneCandidates({ ageDays: 90, now: Date.now() }),
    ).toEqual([]);
  });

  test("returns stable row details older than the age cutoff", () => {
    const now = 200 * DAY_MS;
    const ids = insertLearningRows([
      { category: "a", mistake: "new", timestamp: 150 * DAY_MS },
      { category: "b", mistake: "boundary", timestamp: 110 * DAY_MS },
      {
        category: "b",
        mistake: "old b",
        solution: "fix b",
        timestamp: 100 * DAY_MS,
      },
      {
        category: "a",
        mistake: "old a",
        timestamp: 100 * DAY_MS,
        type: "success",
      },
      {
        category: "z",
        demoId: "demo-z",
        mistake: "oldest",
        timestamp: 50 * DAY_MS,
      },
    ]);

    const candidates = collectStaleLearningPruneCandidates({
      ageDays: 90,
      now,
    });

    expect(candidates.map((candidate) => candidate.id)).toEqual([
      idAt(ids, 4),
      idAt(ids, 3),
      idAt(ids, 2),
    ]);
    expect(candidates[0]).toMatchObject({
      id: idAt(ids, 4),
      type: "mistake",
      category: "z",
      mistake: "oldest",
      timestamp: 50 * DAY_MS,
      demoId: "demo-z",
    });
    expect(candidates[1]).toMatchObject({
      id: idAt(ids, 3),
      type: "success",
      category: "a",
      mistake: "old a",
      timestamp: 100 * DAY_MS,
    });
    expect(candidates[2]).toMatchObject({
      id: idAt(ids, 2),
      type: "mistake",
      category: "b",
      mistake: "old b",
      solution: "fix b",
      timestamp: 100 * DAY_MS,
    });
  });

  test("filters stale candidates by category without mutating entries", () => {
    const now = 200 * DAY_MS;
    const ids = insertLearningRows([
      { category: "target", mistake: "old target", timestamp: 50 * DAY_MS },
      { category: "other", mistake: "old other", timestamp: 50 * DAY_MS },
      { category: "target", mistake: "new target", timestamp: 150 * DAY_MS },
    ]);

    const candidates = collectStaleLearningPruneCandidates({
      ageDays: 90,
      category: "target",
      now,
    });

    expect(candidates.map((candidate) => candidate.id)).toEqual([idAt(ids, 0)]);
    expect(candidates[0]?.category).toBe("target");
    expect(getLearningEntries().target).toHaveLength(2);
    expect(getLearningEntries().other).toHaveLength(1);
  });
});

describe("collectDemoLearningPruneCandidates", () => {
  test("returns empty candidates when no demo-linked entries exist", () => {
    insertLearningRows([
      { category: "plain", mistake: "old plain", timestamp: 50 * DAY_MS },
    ]);

    expect(collectDemoLearningPruneCandidates()).toEqual([]);
  });

  test("returns demo candidates independent from age and category", () => {
    const ids = insertLearningRows([
      {
        category: "other",
        demoId: "demo-new",
        mistake: "demo new",
        timestamp: 199 * DAY_MS,
      },
      {
        category: "target",
        demoId: "demo-old",
        mistake: "demo old",
        solution: "review demo",
        timestamp: 50 * DAY_MS,
        type: "preference",
      },
      {
        category: "target",
        mistake: "plain old",
        timestamp: 50 * DAY_MS,
      },
    ]);

    const candidates = collectDemoLearningPruneCandidates();

    expect(candidates.map((candidate) => candidate.id)).toEqual([
      idAt(ids, 1),
      idAt(ids, 0),
    ]);
    expect(candidates[0]).toMatchObject({
      id: idAt(ids, 1),
      type: "preference",
      category: "target",
      mistake: "demo old",
      solution: "review demo",
      timestamp: 50 * DAY_MS,
      demoId: "demo-old",
    });
    expect(candidates[1]).toMatchObject({
      id: idAt(ids, 0),
      category: "other",
      mistake: "demo new",
      timestamp: 199 * DAY_MS,
      demoId: "demo-new",
    });
    expect(getLearningEntries().target).toHaveLength(2);
    expect(getLearningEntries().other).toHaveLength(1);
  });
});

describe("collectDuplicateLearningPruneGroups", () => {
  test("groups duplicate learning entries within the same category", () => {
    const ids = insertLearningRows([
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
      {
        category: "scope",
        mistake: "unrelated network failure",
        timestamp: 30,
      },
    ]);

    const groups = collectDuplicateLearningPruneGroups();

    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({
      category: "scope",
      kept: { id: idAt(ids, 1), mistake: "forgot import in module again" },
      prunable: [{ id: idAt(ids, 0), mistake: "forgot import in module" }],
      overlapScores: [
        { firstId: idAt(ids, 0), secondId: idAt(ids, 1), score: 1 },
      ],
    });
  });

  test("excludes matching entries from different categories", () => {
    insertLearningRows([
      { category: "alpha", mistake: "same repeated pattern", timestamp: 10 },
      { category: "beta", mistake: "same repeated pattern", timestamp: 20 },
    ]);

    expect(collectDuplicateLearningPruneGroups()).toEqual([]);
  });

  test("changes duplicate candidates when overlap threshold changes", () => {
    const ids = insertLearningRows([
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

    expect(
      collectDuplicateLearningPruneGroups({ overlapThreshold: 0.8 }),
    ).toEqual([]);
    expect(
      collectDuplicateLearningPruneGroups({ overlapThreshold: 0.7 }).map(
        (group) => ({
          keptId: group.kept.id,
          prunableIds: group.prunable.map((candidate) => candidate.id),
          scores: group.overlapScores.map((score) => score.score),
        }),
      ),
    ).toEqual([
      { keptId: idAt(ids, 1), prunableIds: [idAt(ids, 0)], scores: [0.75] },
    ]);
  });

  test("keeps the most recent entry in each duplicate group", () => {
    const ids = insertLearningRows([
      { category: "recent", mistake: "repeat pattern now", timestamp: 10 },
      {
        category: "recent",
        mistake: "repeat pattern now newest",
        timestamp: 30,
      },
      {
        category: "recent",
        mistake: "repeat pattern now middle",
        timestamp: 20,
      },
    ]);

    const groups = collectDuplicateLearningPruneGroups();

    expect(groups[0]?.kept.id).toBe(idAt(ids, 1));
    expect(groups[0]?.prunable.map((candidate) => candidate.id)).toEqual([
      idAt(ids, 0),
      idAt(ids, 2),
    ]);
  });

  test("orders groups deterministically and honors category filtering", () => {
    const ids = insertLearningRows([
      { category: "b", mistake: "blue car train", timestamp: 5 },
      { category: "a", mistake: "red apple pear", timestamp: 10 },
      { category: "b", mistake: "blue car train again", timestamp: 15 },
      { category: "a", mistake: "red apple pear again", timestamp: 20 },
    ]);

    const groups = collectDuplicateLearningPruneGroups();

    expect(groups.map((group) => group.category)).toEqual(["a", "b"]);
    expect(groups.map((group) => group.kept.id)).toEqual([
      idAt(ids, 3),
      idAt(ids, 2),
    ]);
    expect(
      collectDuplicateLearningPruneGroups({ category: "b" }).map(
        (group) => group.kept.id,
      ),
    ).toEqual([idAt(ids, 2)]);
  });
});

describe("collectStaleSessionPruneCandidates", () => {
  test("returns empty candidates when no sessions exist", () => {
    expect(
      collectStaleSessionPruneCandidates({ ageDays: 90, now: Date.now() }),
    ).toEqual([]);
  });

  test("returns stale session details and cascade counts deterministically", () => {
    const now = 200 * DAY_MS;
    insertSessionRows([
      {
        id: "session-new",
        createdAt: isoAtDay(140),
        lastAccessedAt: isoAtDay(150),
      },
      {
        id: "session-boundary",
        createdAt: isoAtDay(100),
        lastAccessedAt: isoAtDay(110),
        constitutionRules: ["boundary rule"],
        interactions: 1,
      },
      {
        id: "session-b",
        cwd: null,
        createdAt: isoAtDay(80),
        lastAccessedAt: isoAtDay(100),
        constitutionRules: ["rule b"],
        interactions: 2,
      },
      {
        id: "session-a",
        cwd: "/tmp/session-a",
        createdAt: isoAtDay(70),
        lastAccessedAt: isoAtDay(50),
        constitutionRules: ["rule a1", "rule a2"],
        interactions: 1,
      },
    ]);

    const candidates = collectStaleSessionPruneCandidates({
      ageDays: 90,
      now,
    });

    expect(candidates).toEqual([
      {
        sessionId: "session-a",
        cwd: "/tmp/session-a",
        createdAt: isoAtDay(70),
        lastAccessedAt: isoAtDay(50),
        cascadeCounts: { constitutionRules: 2, interactions: 1 },
      },
      {
        sessionId: "session-b",
        cwd: null,
        createdAt: isoAtDay(80),
        lastAccessedAt: isoAtDay(100),
        cascadeCounts: { constitutionRules: 1, interactions: 2 },
      },
    ]);
  });

  test("excludes the active session and never mutates session tables", () => {
    const now = 200 * DAY_MS;
    insertSessionRows([
      {
        id: "active-session",
        createdAt: isoAtDay(10),
        lastAccessedAt: isoAtDay(20),
        constitutionRules: ["active rule"],
        interactions: 2,
      },
      {
        id: "other-session",
        createdAt: isoAtDay(30),
        lastAccessedAt: isoAtDay(40),
        constitutionRules: ["other rule"],
        interactions: 1,
      },
    ]);
    const before = readSessionTableCounts();

    const candidates = collectStaleSessionPruneCandidates({
      ageDays: 90,
      now,
      activeSessionId: "active-session",
    });

    expect(candidates.map((candidate) => candidate.sessionId)).toEqual([
      "other-session",
    ]);
    expect(readSessionTableCounts()).toEqual(before);
  });
});

describe("executeDestructivePrune", () => {
  test("reports dry-run candidate sets and deletes selected target rows", () => {
    const now = 200 * DAY_MS;
    const ids = insertLearningRows([
      { category: "old", mistake: "old learning", timestamp: 50 * DAY_MS },
      {
        category: "dup",
        mistake: "duplicate learning pattern",
        timestamp: 120 * DAY_MS,
      },
      {
        category: "dup",
        mistake: "duplicate learning pattern again",
        timestamp: 130 * DAY_MS,
      },
      {
        category: "demo",
        demoId: "demo-prune",
        mistake: "demo learning",
        timestamp: 190 * DAY_MS,
      },
      { category: "keep", mistake: "kept learning", timestamp: 190 * DAY_MS },
    ]);
    insertSessionRows([
      {
        id: "session-old",
        createdAt: isoAtDay(40),
        lastAccessedAt: isoAtDay(50),
        constitutionRules: ["old rule"],
        interactions: 1,
      },
      {
        id: "active-session",
        createdAt: isoAtDay(10),
        lastAccessedAt: isoAtDay(20),
      },
    ]);
    const targets = ["learnings", "duplicates", "demos", "sessions"] as const;
    const dryRunCandidates = collectPruneCandidates({
      targets,
      ageDays: 90,
      now,
      activeSessionId: "active-session",
    });

    const result = executeDestructivePrune({
      targets,
      ageDays: 90,
      now,
      activeSessionId: "active-session",
      backupTimestamp: new Date("2026-01-02T03:04:05.006Z"),
    });

    requireBackupPath(result);
    expect(result.failedTargets).toEqual([]);
    expect(result.skippedTargets).toEqual([]);
    expect(result.candidates).toEqual(dryRunCandidates);
    expect(result.candidateCounts).toEqual({
      learnings: 1,
      duplicates: 1,
      demos: 1,
      sessions: 1,
    });
    expect(result.deletedCounts).toEqual({
      learnings: 1,
      duplicates: 1,
      demos: 1,
      sessions: 1,
    });
    expect(readLearningRowIds()).toEqual([idAt(ids, 2), idAt(ids, 4)]);
    expect(readSessionTableCounts()).toEqual({
      sessions: 1,
      constitutionRules: 0,
      interactions: 0,
    });
  });

  test("backs up before deletion and captures WAL-resident rows", () => {
    const now = 200 * DAY_MS;
    withDatabase(() => undefined);
    const direct = new Database(getDatabasePath(), { create: true });
    try {
      direct.exec("PRAGMA foreign_keys = ON");
      direct.exec("PRAGMA journal_mode = WAL");
      direct
        .prepare(
          "INSERT INTO learning_entries (type, category, mistake, solution, timestamp, demo_id) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .run("mistake", "wal", "wal old", null, 50 * DAY_MS, null);

      const result = executeDestructivePrune({
        targets: ["learnings"],
        ageDays: 90,
        now,
        backupTimestamp: new Date("2026-01-03T03:04:05.006Z"),
      });
      const backupPath = requireBackupPath(result);
      const backup = new Database(backupPath, { readonly: true });
      try {
        expect(
          backup
            .query<{ mistake: string }, []>(
              "SELECT mistake FROM learning_entries WHERE category = 'wal'",
            )
            .get(),
        ).toEqual({ mistake: "wal old" });
      } finally {
        backup.close();
      }

      expect(result.deletedCounts.learnings).toBe(1);
      expect(result.failedTargets).toEqual([]);
    } finally {
      direct.close();
    }
    expect(getLearningEntries().wal).toBeUndefined();
  });

  test("aborts deletion and reports backup failure details", () => {
    const now = 200 * DAY_MS;
    insertLearningRows([
      {
        category: "old",
        mistake: "kept after backup failure",
        timestamp: 50 * DAY_MS,
      },
    ]);
    const blockedBackupDirectory = path.join(home.dataRoot, "blocked-backups");
    fs.mkdirSync(home.dataRoot, { recursive: true });
    fs.writeFileSync(blockedBackupDirectory, "not a directory", "utf8");

    const result = executeDestructivePrune({
      targets: ["learnings"],
      ageDays: 90,
      now,
      backupDirectory: blockedBackupDirectory,
    });

    expect(result.backupPath).toBeNull();
    expect(result.failedTargets).toEqual([
      { target: "backup", message: expect.any(String) },
    ]);
    expect(result.candidateCounts).toEqual({
      learnings: 1,
      duplicates: 0,
      demos: 0,
      sessions: 0,
    });
    expect(result.deletedCounts).toEqual({
      learnings: 0,
      duplicates: 0,
      demos: 0,
      sessions: 0,
    });
    expect(result.skippedTargets).toEqual(["duplicates", "demos", "sessions"]);
    expect(getLearningEntries().old?.map((entry) => entry.mistake)).toEqual([
      "kept after backup failure",
    ]);
  });

  test("backs up empty destructive runs and reports zero counts", () => {
    const result = executeDestructivePrune({
      targets: ["learnings"],
      ageDays: 90,
      now: 200 * DAY_MS,
      backupTimestamp: new Date("2026-01-04T03:04:05.006Z"),
    });

    requireBackupPath(result);
    expect(result.failedTargets).toEqual([]);
    expect(result.candidates.learnings).toEqual([]);
    expect(result.candidateCounts).toEqual({
      learnings: 0,
      duplicates: 0,
      demos: 0,
      sessions: 0,
    });
    expect(result.deletedCounts).toEqual({
      learnings: 0,
      duplicates: 0,
      demos: 0,
      sessions: 0,
    });
    expect(result.skippedTargets).toEqual(["duplicates", "demos", "sessions"]);
  });

  test("deletes stale sessions through cascade behavior", () => {
    const now = 200 * DAY_MS;
    insertSessionRows([
      {
        id: "session-old",
        createdAt: isoAtDay(20),
        lastAccessedAt: isoAtDay(30),
        constitutionRules: ["first", "second"],
        interactions: 2,
      },
      {
        id: "session-new",
        createdAt: isoAtDay(140),
        lastAccessedAt: isoAtDay(150),
      },
    ]);

    const result = executeDestructivePrune({
      targets: ["sessions"],
      ageDays: 90,
      now,
      backupTimestamp: new Date("2026-01-05T03:04:05.006Z"),
    });

    requireBackupPath(result);
    expect(result.failedTargets).toEqual([]);
    expect(result.candidates.sessions).toEqual([
      {
        sessionId: "session-old",
        cwd: "/tmp/session-old",
        createdAt: isoAtDay(20),
        lastAccessedAt: isoAtDay(30),
        cascadeCounts: { constitutionRules: 2, interactions: 2 },
      },
    ]);
    expect(result.deletedCounts.sessions).toBe(1);
    expect(readSessionTableCounts()).toEqual({
      sessions: 1,
      constitutionRules: 0,
      interactions: 0,
    });
  });
});

describe("removeLearningEntriesForDemo", () => {
  test("removes only entries owned by the selected demo", () => {
    writeRawLog(home.dataRoot, {
      mixed: [
        { mistake: "legacy", timestamp: 100 },
        { mistake: "demo one", timestamp: 200, demoId: "demo-1" },
        { mistake: "demo two", timestamp: 300, demoId: "demo-2" },
      ],
    });

    removeLearningEntriesForDemo("demo-1");

    expect(getLearningEntries().mixed?.map((entry) => entry.mistake)).toEqual([
      "legacy",
      "demo two",
    ]);
  });

  test("recalculates category metadata and deletes empty categories", () => {
    writeRawLog(home.dataRoot, {
      kept: [
        { mistake: "old", timestamp: 100 },
        { mistake: "new", timestamp: 300 },
        { mistake: "demo", timestamp: 200, demoId: "demo-1" },
      ],
      empty: [{ mistake: "gone", timestamp: 400, demoId: "demo-1" }],
    });

    removeLearningEntriesForDemo("demo-1");

    const entries = getLearningEntries();
    expect(entries.empty).toBeUndefined();
    const summary = getLearningCategorySummary();
    const kept = summary.find((entry) => entry.category === "kept");
    expect(kept?.count).toBe(2);
    expect(kept?.recentExample.mistake).toBe("new");
  });
});

describe("legacy log corruption recovery", () => {
  test("ignores corrupt legacy JSON without crashing", () => {
    const logPath = path.join(home.dataRoot, "vibe-log.json");
    fs.mkdirSync(home.dataRoot, { recursive: true });
    fs.writeFileSync(logPath, "not valid json {{{", "utf8");

    expect(getLearningEntries()).toEqual({});
    expect(fs.readFileSync(logPath, "utf8")).toBe("not valid json {{{");
  });

  test("keeps later SQLite writes independent from corrupt legacy JSON", () => {
    const logPath = path.join(home.dataRoot, "vibe-log.json");
    fs.mkdirSync(home.dataRoot, { recursive: true });
    fs.writeFileSync(logPath, "garbage", "utf8");

    addLearningEntry("post-recovery", "recov");

    expect(getLearningEntries().recov).toHaveLength(1);
    expect(fs.readFileSync(logPath, "utf8")).toBe("garbage");
  });
});

describe("getLearningContextText", () => {
  test("returns empty string when no entries", () => {
    expect(getLearningContextText()).toBe("");
  });

  test("formats entries by category with label and solution", () => {
    addLearningEntry("err1", "style", "fix it");
    const text = getLearningContextText();
    expect(text).toContain("Category: style");
    expect(text).toContain("[Mistake] err1");
    expect(text).toContain("Solution: fix it");
    expect(text).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
  });

  test("omits Solution line when solution is absent", () => {
    addLearningEntry("no-sol", "bare");
    const text = getLearningContextText();
    expect(text).toContain("bare");
    // The entry line should not contain "| Solution:"
    const entryLine = text.split("\n").find((l) => l.includes("no-sol"));
    expect(entryLine).toBeDefined();
    expect(entryLine).not.toContain("Solution:");
  });

  test("respects maxPerCategory cap", () => {
    for (let i = 0; i < 10; i++) {
      addLearningEntry(`e${i}`, "cap");
    }
    const text = getLearningContextText(3);
    // Only last 3 entries should appear
    const matches = (text.match(/- \[Mistake\]/g) ?? []).length;
    expect(matches).toBe(3);
  });

  test("uses Preference label for preference type", () => {
    addLearningEntry("pref1", "prefs", undefined, "preference");
    const text = getLearningContextText();
    expect(text).toContain("[Preference] pref1");
  });

  test("uses Success label for success type", () => {
    addLearningEntry("s1", "wins", undefined, "success");
    const text = getLearningContextText();
    expect(text).toContain("[Success] s1");
  });

  test("joins multiple categories with double newline", () => {
    addLearningEntry("e1", "alpha");
    addLearningEntry("e2", "beta");
    const text = getLearningContextText();
    expect(text).toContain("Category: alpha");
    expect(text).toContain("Category: beta");
    // Categories separated by blank line
    expect(text).toContain("\n\n");
  });
});

describe("createPruneDatabaseBackup", () => {
  test("backs up with default directory when none provided", () => {
    const now = 200 * DAY_MS;
    insertLearningRows([
      {
        category: "backup-test",
        mistake: "entry to back up",
        timestamp: now,
      },
    ]);

    const result = executeDestructivePrune({
      targets: ["learnings"],
      ageDays: 90,
      now,
      backupTimestamp: new Date("2026-02-01T03:04:05.006Z"),
    });

    expect(result.backupPath).toBeDefined();
    expect(result.backupPath).not.toBeNull();
    expect(result.backupPath).toContain("backups");
    expect(result.backupPath).toContain("vibe-prune-");
    const path = result.backupPath;
    expect(path).not.toBeNull();
    if (path !== null) expect(fs.existsSync(path)).toBe(true);
  });

  test("backs up with custom directory", () => {
    const now = 200 * DAY_MS;
    const customBackupDir = path.join(home.dataRoot, "custom-backups");
    insertLearningRows([
      {
        category: "backup-custom",
        mistake: "entry for custom backup",
        timestamp: now,
      },
    ]);

    const result = executeDestructivePrune({
      targets: ["learnings"],
      ageDays: 90,
      now,
      backupTimestamp: new Date("2026-02-02T03:04:05.006Z"),
      backupDirectory: customBackupDir,
    });

    expect(result.backupPath).toContain("custom-backups");
    const customPath = result.backupPath;
    expect(customPath).not.toBeNull();
    if (customPath !== null) expect(fs.existsSync(customPath)).toBe(true);
  });

  test("creates backup with readable file at default path", () => {
    // Seed data so the database file exists.
    insertLearningRows([
      {
        category: "backup-direct",
        mistake: "entry for direct backup",
        timestamp: Date.now(),
      },
    ]);

    const timestamp = new Date("2026-02-03T03:04:05.006Z");
    const backupPath = createPruneDatabaseBackup({ timestamp });

    expect(backupPath).toContain("backups");
    expect(backupPath).toContain("vibe-prune-");
    expect(fs.existsSync(backupPath)).toBe(true);

    try {
      fs.unlinkSync(backupPath);
    } catch {
      /* cleanup */
    }
  });
});

describe("collectPruneCandidates — overlapThreshold parameter", () => {
  test("passes overlapThreshold to duplicate collection", () => {
    const now = 200 * DAY_MS;
    insertLearningRows([
      {
        category: "threshold-test",
        mistake: "alpha beta gamma delta",
        timestamp: 10,
      },
      {
        category: "threshold-test",
        mistake: "alpha beta gamma omega",
        timestamp: 20,
      },
    ]);

    // With threshold 0.8: overlap is 0.75 (3/4), should produce 0 candidates
    const strictCandidates = collectPruneCandidates({
      targets: ["duplicates"],
      ageDays: 90,
      now,
      overlapThreshold: 0.8,
    });
    expect(strictCandidates.duplicates).toHaveLength(0);

    // With threshold 0.7: overlap is 0.75, should produce 1 group
    const looseCandidates = collectPruneCandidates({
      targets: ["duplicates"],
      ageDays: 90,
      now,
      overlapThreshold: 0.7,
    });
    expect(looseCandidates.duplicates).toHaveLength(1);
  });

  test("uses default threshold when overlapThreshold is not provided", () => {
    const now = 200 * DAY_MS;
    insertLearningRows([
      {
        category: "default-threshold",
        mistake: "same repeated pattern now",
        timestamp: 10,
      },
      {
        category: "default-threshold",
        mistake: "same repeated pattern later",
        timestamp: 20,
      },
    ]);

    const candidates = collectPruneCandidates({
      targets: ["duplicates"],
      ageDays: 90,
      now,
    });

    // Full overlap (identical words), so default 0.6 should trigger
    expect(candidates.duplicates).toHaveLength(1);
  });
});

describe("SQLite write error handling", () => {
  test("persists without writing legacy JSON", () => {
    addLearningEntry("sqlite-only", "cat");

    expect(getLearningEntries().cat?.map((entry) => entry.mistake)).toEqual([
      "sqlite-only",
    ]);
    expect(fs.existsSync(path.join(home.dataRoot, "vibe-log.json"))).toBe(
      false,
    );
  });
});
