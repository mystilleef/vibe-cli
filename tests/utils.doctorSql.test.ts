import { Database } from "bun:sqlite";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test";
import {
  openExistingDatabase,
  runDiagnose,
  runVacuum,
} from "../src/utils/doctorSql.js";
import { createDoctorFixtures } from "./helpers/doctorFixtures.js";
import { createTempHome, type TempHomeContext } from "./helpers/tempHome.js";

/**
 * SQL-layer seams of the doctor diagnostics. Doctor connections never
 * create or migrate, so every fixture starts from a real migrated file and
 * the tests inject the remaining failures: a pragma rejected right after
 * open, a dropped table, and a freelist probe that returns no row.
 */
let home: TempHomeContext;

beforeEach(async () => {
  home = await createTempHome();
});

afterEach(async () => {
  mock.restore();
  await home.cleanup();
});

const { databasePath, seedDatabase } = createDoctorFixtures(
  () => home.dataRoot,
);

/** Let every query through except the freelist probe, which returns no row. */
function mockFreelistNoRow(): void {
  const realQuery = Database.prototype.query;
  spyOn(Database.prototype, "query").mockImplementation(function (
    this: Database,
    sql: string,
    ...rest: unknown[]
  ) {
    if (sql === "PRAGMA freelist_count") {
      return {
        get: () => null,
      } as unknown as ReturnType<Database["query"]>;
    }
    return (
      realQuery as unknown as (sql: string, ...rest: unknown[]) => unknown
    ).apply(this, [sql, ...rest]) as ReturnType<Database["query"]>;
  } as typeof Database.prototype.query);
}

// ── openExistingDatabase: partial initialization failure ──────────────────

describe("openExistingDatabase pragma failure", () => {
  test("closes the fresh handle and rethrows when post-open setup fails", async () => {
    await seedDatabase();
    const realRun = Database.prototype.run;
    spyOn(Database.prototype, "run").mockImplementation(function (
      this: Database,
      ...args: Parameters<Database["run"]>
    ) {
      if (args[0] === "PRAGMA foreign_keys = ON") {
        throw new Error("pragma setup rejected");
      }
      return realRun.apply(this, args);
    });
    const closeSpy = spyOn(Database.prototype, "close");

    expect(() => openExistingDatabase(databasePath(), "read-only")).toThrow(
      "pragma setup rejected",
    );
    expect(closeSpy).toHaveBeenCalledTimes(1);
  });
});

// ── runDiagnose: independent sections ─────────────────────────────────────

describe("runDiagnose section independence", () => {
  test("keeps healthy sections available when one section query fails", async () => {
    await seedDatabase((db) => {
      db.run("DROP TABLE legacy_imports");
    });

    const payload = await runDiagnose(databasePath());

    expect(payload.integrityCheck).toEqual({ ok: true, value: ["ok"] });
    expect(payload.foreignKeyCheck).toEqual({ ok: true, value: [] });
    // Dropping the table leaves free pages behind; the exact count is
    // irrelevant — only that the section stayed healthy.
    expect(payload.freelistCount).toEqual({
      ok: true,
      value: expect.any(Number),
    });
    expect(payload.legacyRecords).toEqual({
      ok: false,
      error: expect.stringMatching(/no such table/i),
    });
  });

  test("isolates a freelist probe returning no row into its own failed section", async () => {
    await seedDatabase();
    mockFreelistNoRow();

    const payload = await runDiagnose(databasePath());

    expect(payload.integrityCheck).toEqual({ ok: true, value: ["ok"] });
    expect(payload.foreignKeyCheck).toEqual({ ok: true, value: [] });
    expect(payload.freelistCount).toEqual({
      ok: false,
      error: "freelist_count returned no row",
    });
    expect(payload.legacyRecords).toEqual({ ok: true, value: [] });
  });

  test("propagates a freelist probe returning no row from vacuum", async () => {
    await seedDatabase();
    mockFreelistNoRow();

    await expect(runVacuum(databasePath())).rejects.toThrow(
      "freelist_count returned no row",
    );
  });
});
