import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  createPruneDatabaseBackup,
  executeDestructivePrune,
} from "../src/utils/storage";
import { createTempHome, type TempHomeContext } from "./helpers/tempHome";

let home: TempHomeContext;
const DAY_MS = 24 * 60 * 60 * 1000;

function setBackupError(msg: string | undefined) {
  (globalThis as Record<string, unknown>)["__VIBE_BACKUP_ERROR"] = msg;
}

beforeEach(async () => {
  home = await createTempHome();
});

afterEach(async () => {
  setBackupError(undefined);
  await home.cleanup();
});

describe("createPruneDatabaseBackup — error paths", () => {
  test("throws when DB is in-memory", () => {
    setBackupError("cannot back up an in-memory database");
    expect(() => createPruneDatabaseBackup({ timestamp: new Date() })).toThrow(
      "cannot back up an in-memory database",
    );
  });

  test("throws when WAL checkpoint fails", () => {
    setBackupError("database checkpoint could not complete before backup");
    expect(() => createPruneDatabaseBackup({ timestamp: new Date() })).toThrow(
      "database checkpoint could not complete before backup",
    );
  });
});

describe("executeDestructivePrune — backup error handling", () => {
  test("catches createPruneDatabaseBackup error and returns backup failure", () => {
    setBackupError("simulated backup error");
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
  });
});
