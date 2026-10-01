/**
 * Fail-fast vacuum contract. Doctor applies a zero busy timeout to its
 * vacuum connection so lock contention surfaces immediately as SQLITE_BUSY
 * instead of engaging the default 5000ms contention wait; the healthy path
 * reports the freelist page count present when VACUUM ran.
 */
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { runVacuum } from "../src/utils/doctorSql.js";
import { createDoctorFixtures } from "./helpers/doctorFixtures.js";
import { createTempHome, type TempHomeContext } from "./helpers/tempHome.js";

let home: TempHomeContext;

beforeEach(async () => {
  home = await createTempHome();
});

afterEach(async () => {
  await home.cleanup();
});

const { databasePath, seedDatabase } = createDoctorFixtures(
  () => home.dataRoot,
);

describe("runVacuum fail-fast contention", () => {
  test("rejects immediately with SQLITE_BUSY while another connection holds the write lock", async () => {
    await seedDatabase();
    const blocker = new Database(databasePath(), {
      readwrite: true,
      create: false,
    });
    try {
      blocker.run("BEGIN IMMEDIATE");

      const startedAt = performance.now();
      await expect(runVacuum(databasePath())).rejects.toThrow(
        /database is locked/,
      );
      const elapsed = performance.now() - startedAt;

      // Fail-fast: the default 5000ms contention wait never engages.
      expect(elapsed).toBeLessThan(1000);
    } finally {
      blocker.run("ROLLBACK");
      blocker.close();
    }
  });

  test("reports the reclaimed freelist page count on an uncontended database", async () => {
    await seedDatabase();

    const freePages = await runVacuum(databasePath());

    expect(freePages).toBeGreaterThanOrEqual(0);
  });
});
