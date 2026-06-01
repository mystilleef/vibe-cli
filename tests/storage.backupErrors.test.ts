import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  createPruneDatabaseBackup,
  executeDestructivePrune,
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

// These tests require --preload ./tests/helpers/mockBackupError.ts and
// VIBE_MOCK_BACKUP_ERROR set. When not preloaded, the real
// createPruneDatabaseBackup is called (uncovered in normal suite).
const mode = process.env.VIBE_MOCK_BACKUP_ERROR;

describe("createPruneDatabaseBackup — error paths (preload required)", () => {
  test.skipIf(!mode)("throws when DB is in-memory", () => {
    expect(() => createPruneDatabaseBackup({ timestamp: new Date() })).toThrow(
      "cannot back up an in-memory database",
    );
  });

  test.skipIf(!mode)("throws when WAL checkpoint fails", () => {
    expect(() => createPruneDatabaseBackup({ timestamp: new Date() })).toThrow(
      "database checkpoint could not complete before backup",
    );
  });
});

describe("executeDestructivePrune — backup error handling (preload required)", () => {
  test.skipIf(!mode)(
    "catches createPruneDatabaseBackup error and returns backup failure",
    () => {
      const now = 200 * DAY_MS;

      const result = executeDestructivePrune({
        targets: ["learnings"],
        ageDays: 90,
        now,
      });

      expect(result.backupPath).toBeNull();
      expect(result.failedTargets).toEqual([
        { target: "backup", message: expect.any(String) },
      ]);
      expect(result.candidates.learnings).toEqual([]);
      expect(result.deletedCounts).toEqual({
        learnings: 0,
        duplicates: 0,
        demos: 0,
        sessions: 0,
      });
    },
  );
});
