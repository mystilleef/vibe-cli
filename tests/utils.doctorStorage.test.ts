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
import { existsSync } from "node:fs";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  rm,
  rmdir,
  stat,
  symlink,
  unlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
  getMigrationIds,
  initializeSchema,
  openVibeDatabase,
} from "../src/utils/database.js";
import {
  createDoctorDatabaseBackup,
  purgeLegacyCopies,
  purgeManagedBackups,
} from "../src/utils/doctorMaintenance.js";
import {
  type DoctorExecutor,
  type DoctorSection,
  type DoctorSqlDiagnostics,
  openExistingDatabase,
  runDiagnose,
  runVacuum,
  withExistingDatabase,
} from "../src/utils/doctorSql.js";
import {
  collectDoctorDiagnostics,
  type LegacyBackupsFinding,
  type LegacyRecordRef,
  type RejectedLegacyRecord,
} from "../src/utils/doctorStorage.js";
import { makeErrno } from "../src/utils/errors.js";
import * as managedBackups from "../src/utils/managedBackups.js";
import {
  createDoctorFixtures,
  managedBackupName,
} from "./helpers/doctorFixtures.js";
import { createTempHome, type TempHomeContext } from "./helpers/tempHome.js";

const canEnforcePermissions =
  process.platform !== "win32" && process.getuid?.() !== 0;

let home: TempHomeContext;

beforeEach(async () => {
  home = await createTempHome();
});

afterEach(async () => {
  mock.restore();
  await home.cleanup();
});

// ── Fixture helpers ───────────────────────────────────────────────────────

const {
  databasePath,
  seedDatabase,
  seedLegacyRecord,
  readFreelistCount,
  seedForeignKeyViolations,
} = createDoctorFixtures(() => home.dataRoot);

/**
 * Data-root listing without SQLite's own transient `-wal`/`-shm` files,
 * which a read-only connection may create beside an idle WAL database.
 */
async function readDataRootInventory(): Promise<string[]> {
  return (await readdir(home.dataRoot))
    .filter((name) => !/^vibe\.db-(wal|shm)$/.test(name))
    .sort();
}

async function writeManagedBackup(
  prefix: string,
  iso: string,
  content = "backup",
): Promise<string> {
  const backupsDir = join(home.dataRoot, "backups");
  await mkdir(backupsDir, { recursive: true });
  const filePath = join(backupsDir, managedBackupName(prefix, iso));
  await writeFile(filePath, content);
  return filePath;
}

function sectionOk<T>(value: T): DoctorSection<T> {
  return { ok: true, value };
}

function sectionFail<T>(error: string): DoctorSection<T> {
  return { ok: false, error };
}

function sqlSections(
  partial: Partial<DoctorSqlDiagnostics> = {},
): DoctorSqlDiagnostics {
  return {
    integrityCheck: partial.integrityCheck ?? sectionOk(["ok"]),
    foreignKeyCheck: partial.foreignKeyCheck ?? sectionOk([]),
    freelistCount: partial.freelistCount ?? sectionOk(0),
    legacyRecords: partial.legacyRecords ?? sectionOk([]),
  };
}

interface FakeExecutor extends DoctorExecutor {
  diagnoseCalls: string[];
  backupCalls: Array<{ databasePath: string; timestamp: Date }>;
  backupResult: string;
}

function createFakeExecutor(
  sections: Partial<DoctorSqlDiagnostics> = {},
  failWith?: Error,
): FakeExecutor {
  const fake: FakeExecutor = {
    diagnoseCalls: [],
    backupCalls: [],
    backupResult: join("backups", "vibe-doctor-fake.db"),
    async diagnose(databasePath) {
      fake.diagnoseCalls.push(databasePath);
      if (failWith) throw failWith;
      return sqlSections(sections);
    },
    async backup(databasePath, timestamp) {
      fake.backupCalls.push({ databasePath, timestamp });
      return fake.backupResult;
    },
    async vacuum() {
      throw new Error("storage tests never dispatch vacuum");
    },
  };
  return fake;
}

async function expectClosed(handle: Database | undefined): Promise<void> {
  expect(handle).toBeDefined();
  if (!handle) return;
  expect(() => handle.query("SELECT 1").get()).toThrow(/closed/);
}

// ── collectDoctorDiagnostics: healthy and contract ────────────────────────

describe("collectDoctorDiagnostics", () => {
  test("returns resolved paths and all findings for healthy storage", async () => {
    await seedDatabase();

    const diagnostics = await collectDoctorDiagnostics({ retention: 5 });

    expect(diagnostics.dataRoot).toBe(resolve(home.dataRoot));
    expect(diagnostics.databasePath).toBe(resolve(databasePath()));
    expect(diagnostics.failures).toEqual([]);
    expect(diagnostics.findings.integrityCheck).toEqual({
      rows: ["ok"],
      ok: true,
    });
    expect(diagnostics.findings.foreignKeyCheck).toEqual([]);
    expect(diagnostics.findings.freelistCount).toBe(0);
    expect(diagnostics.findings.excessBackups).toBe(0);
    expect(diagnostics.findings.latestBackupPath).toBeNull();
    expect(diagnostics.findings.legacyBackups).toEqual({
      candidates: [],
      rejected: [],
    });
    expect(diagnostics.findings.strandedOriginals).toEqual([]);
  });

  test("reports orphaned rules and interactions with table and rowid", async () => {
    await seedDatabase();
    seedForeignKeyViolations(1, 1);

    const diagnostics = await collectDoctorDiagnostics({ retention: 5 });

    expect(diagnostics.findings.integrityCheck).toEqual({
      rows: ["ok"],
      ok: true,
    });
    const violations = diagnostics.findings.foreignKeyCheck ?? [];
    expect(violations).toHaveLength(2);
    expect(violations).toContainEqual({
      table: "constitution_rules",
      rowid: expect.any(Number),
    });
    expect(violations).toContainEqual({
      table: "interactions",
      rowid: expect.any(Number),
    });
  });

  test("reports no foreign-key violations for demo-linked learning rows", async () => {
    await seedDatabase((db) => {
      db.prepare(
        "INSERT INTO learning_entries (type, category, observation, timestamp, demo_id) VALUES (?, ?, ?, ?, ?)",
      ).run("mistake", "demo-category", "demo observation", 1, "demo-1");
    });

    const diagnostics = await collectDoctorDiagnostics({ retention: 5 });

    expect(diagnostics.findings.foreignKeyCheck).toEqual([]);
    expect(diagnostics.findings.integrityCheck?.ok).toBe(true);
  });

  test("reports the free-page count observed by an external connection", async () => {
    await seedDatabase((db) => {
      const insert = db.prepare(
        "INSERT INTO interactions (session_id, goal, output, timestamp) VALUES (?, ?, ?, ?)",
      );
      for (let index = 0; index < 50; index += 1) {
        insert.run(`s${index}`, "goal", "x".repeat(400), index);
      }
      db.run("DELETE FROM interactions WHERE id % 2 = 0");
    });
    const external = new Database(databasePath(), {
      readonly: true,
      create: false,
    });
    let expected: number;
    try {
      expected = (
        external.query("PRAGMA freelist_count").get() as {
          freelist_count: number;
        }
      ).freelist_count;
    } finally {
      external.close();
    }
    expect(expected).toBeGreaterThan(0);

    const diagnostics = await collectDoctorDiagnostics({ retention: 5 });

    expect(diagnostics.findings.freelistCount).toBe(expected);
  });

  test("leaves rows, markers, originals, and inventories unchanged after collection", async () => {
    await seedDatabase((db) => {
      db.prepare(
        "INSERT INTO learning_entries (type, category, observation, timestamp, demo_id) VALUES (?, ?, ?, ?, ?)",
      ).run("mistake", "c", "kept observation", 1, "demo-1");
      db.prepare(
        "INSERT INTO sessions (id, cwd_key, created_at, last_accessed_at) VALUES (?, ?, ?, ?)",
      ).run(
        "session-1",
        "key-1",
        "2026-01-01T00:00:00.000Z",
        "2026-01-02T00:00:00.000Z",
      );
    });
    seedForeignKeyViolations(1, 1);
    seedLegacyRecord("vibe-log.json", join(home.dataRoot, "vibe-log.json.bak"));
    await writeFile(join(home.dataRoot, "vibe-log.json"), '{"keep":true}');
    await writeFile(join(home.dataRoot, "vibe-log.json.bak"), '{"copy":true}');
    await writeManagedBackup("vibe-prune-", "2026-01-01T00:00:00.000Z");

    const snapshot = await captureState();
    await collectDoctorDiagnostics({ retention: 5 });
    expect(await captureState()).toEqual(snapshot);
  });

  test("never imports unrecorded legacy inputs during collection", async () => {
    await seedDatabase();
    await mkdir(join(home.dataRoot, "sessions"), { recursive: true });
    await writeFile(
      join(home.dataRoot, "vibe-log.json"),
      JSON.stringify({ mistakes: { c: { examples: [] } } }),
    );
    await writeFile(
      join(home.dataRoot, "sessions", "unimported.json"),
      JSON.stringify({
        id: "u",
        createdAt: "2026-01-01T00:00:00.000Z",
        lastAccessedAt: "2026-01-01T00:00:00.000Z",
      }),
    );

    await collectDoctorDiagnostics({ retention: 5 });

    const db = new Database(databasePath(), { readonly: true, create: false });
    try {
      expect(
        db.query("SELECT COUNT(*) AS c FROM legacy_imports").get(),
      ).toEqual({
        c: 0,
      });
      expect(
        db.query("SELECT COUNT(*) AS c FROM learning_entries").get(),
      ).toEqual({
        c: 0,
      });
      expect(db.query("SELECT COUNT(*) AS c FROM sessions").get()).toEqual({
        c: 0,
      });
    } finally {
      db.close();
    }
    expect(await readdir(home.dataRoot)).toContain("vibe-log.json");
    expect(await readdir(join(home.dataRoot, "sessions"))).toContain(
      "unimported.json",
    );
    expect(
      (await readdir(home.dataRoot)).filter((name) => name.endsWith(".bak")),
    ).toEqual([]);
  });

  test("keeps database bytes, journal mode, and data-root inventory unchanged during collection", async () => {
    await seedDatabase((db) => {
      db.run("PRAGMA journal_mode = WAL");
    });
    const inventory = await readDataRootInventory();
    expect(inventory).toEqual(["vibe.db"]);
    const header = await readFile(databasePath());
    expect([header[18], header[19]]).toEqual([2, 2]);

    const diagnostics = await collectDoctorDiagnostics({ retention: 5 });

    expect(await readDataRootInventory()).toEqual(inventory);
    expect(await readFile(databasePath())).toEqual(header);
    expect(diagnostics.failures).toEqual([]);
    expect(diagnostics.findings.integrityCheck?.ok).toBe(true);
  });

  test("preserves pending WAL contents and directory inventory during collection", async () => {
    const sourceDir = await mkdtemp(join(home.home, "wal-source-"));
    const sourcePath = join(sourceDir, "vibe.db");
    const seed = new Database(sourcePath);
    try {
      initializeSchema(seed);
    } finally {
      seed.close();
    }
    const writer = new Database(sourcePath);
    try {
      writer.run("PRAGMA journal_mode = WAL");
      writer
        .prepare(
          "INSERT INTO legacy_imports (artifact, imported_at, backup_path) VALUES (?, ?, ?)",
        )
        .run(
          "vibe-log.json",
          "2026-01-01T00:00:00.000Z",
          join(home.dataRoot, "vibe-log.json.bak"),
        );
      await mkdir(home.dataRoot, { recursive: true });
      await writeFile(join(home.dataRoot, "vibe-log.json"), "{}");
      await writeFile(join(home.dataRoot, "vibe-log.json.bak"), "{}");
      await copyFile(sourcePath, databasePath());
      await copyFile(`${sourcePath}-wal`, `${databasePath()}-wal`);
    } finally {
      writer.close();
    }
    const inventory = await readDataRootInventory();
    const wal = await readFile(`${databasePath()}-wal`);

    const diagnostics = await collectDoctorDiagnostics({ retention: 5 });

    expect(await readDataRootInventory()).toEqual(inventory);
    expect(await readFile(`${databasePath()}-wal`)).toEqual(wal);
    expect(diagnostics.findings.legacyBackups?.candidates).toEqual([
      {
        artifact: "vibe-log.json",
        path: join(home.dataRoot, "vibe-log.json.bak"),
      },
    ]);
    expect(diagnostics.failures).toEqual([]);
  });
});

// ── collectDoctorDiagnostics: unavailable and failed diagnostics ──────────

describe("collectDoctorDiagnostics unavailable diagnostics", () => {
  test("reports multiple integrity rows as an unhealthy integrity finding", async () => {
    await seedDatabase();
    const rows = ["*** in database main", "Page 2: btree integrity error"];
    const fake = createFakeExecutor({
      integrityCheck: sectionOk(rows),
    });

    const diagnostics = await collectDoctorDiagnostics({
      retention: 5,
      executor: fake,
    });

    expect(diagnostics.findings.integrityCheck).toEqual({ rows, ok: false });
    expect(diagnostics.failures).toEqual([]);
  });

  test("marks integrity unhealthy unless a lone ok row is returned", async () => {
    await seedDatabase();
    const fake = createFakeExecutor({
      integrityCheck: sectionOk(["ok", "unexpected second row"]),
    });

    const diagnostics = await collectDoctorDiagnostics({
      retention: 5,
      executor: fake,
    });

    expect(diagnostics.findings.integrityCheck?.ok).toBe(false);
  });

  test("preserves available findings when one section fails", async () => {
    await seedDatabase();
    const fake = createFakeExecutor({
      freelistCount: sectionFail("freelist probe failed"),
    });

    const diagnostics = await collectDoctorDiagnostics({
      retention: 5,
      executor: fake,
    });

    expect(diagnostics.findings.freelistCount).toBeNull();
    expect(diagnostics.findings.integrityCheck).toEqual({
      rows: ["ok"],
      ok: true,
    });
    expect(diagnostics.findings.foreignKeyCheck).toEqual([]);
    expect(diagnostics.failures).toEqual([
      { target: "freelistCount", message: "freelist probe failed" },
    ]);
  });

  test("marks legacy findings unavailable when the record query fails", async () => {
    await seedDatabase();
    const fake = createFakeExecutor({
      legacyRecords: sectionFail("legacy query failed"),
    });

    const diagnostics = await collectDoctorDiagnostics({
      retention: 5,
      executor: fake,
    });

    expect(diagnostics.findings.legacyBackups).toBeNull();
    expect(diagnostics.findings.strandedOriginals).toBeNull();
    expect(diagnostics.failures).toEqual([
      { target: "legacyBackups", message: "legacy query failed" },
      { target: "strandedOriginals", message: "legacy query failed" },
    ]);
    expect(diagnostics.findings.integrityCheck?.ok).toBe(true);
  });

  test("rejects when the executor cannot open the database", async () => {
    await seedDatabase();
    const fake = createFakeExecutor(
      {},
      new Error("unable to open database file"),
    );

    await expect(
      collectDoctorDiagnostics({ retention: 5, executor: fake }),
    ).rejects.toThrow("unable to open database file");
  });

  test("rejects invalid retention before touching storage", async () => {
    const fake = createFakeExecutor();
    for (const retention of [
      0,
      -1,
      2.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      2 ** 53,
    ]) {
      await expect(
        collectDoctorDiagnostics({ retention, executor: fake }),
      ).rejects.toThrow(/invalid retention/);
    }
    expect(fake.diagnoseCalls).toHaveLength(0);
  });
});

// ── collectDoctorDiagnostics: storage open failures ───────────────────────

describe("collectDoctorDiagnostics open failures", () => {
  test("rejects a missing data root without creating it", async () => {
    await expect(collectDoctorDiagnostics({ retention: 5 })).rejects.toThrow(
      /vibe data root not found/,
    );
    await expect(stat(home.dataRoot)).rejects.toThrow();
  });

  test("rejects a missing database without recreating it", async () => {
    await mkdir(home.dataRoot, { recursive: true });
    await writeFile(join(home.dataRoot, "vibe-log.json"), "{}");

    await expect(collectDoctorDiagnostics({ retention: 5 })).rejects.toThrow(
      /vibe database not found/,
    );
    await expect(stat(databasePath())).rejects.toThrow();
    expect(await readdir(home.dataRoot)).toEqual(["vibe-log.json"]);
  });

  test("rejects a corrupt database", async () => {
    await mkdir(home.dataRoot, { recursive: true });
    await writeFile(databasePath(), "this is not a sqlite database at all");

    await expect(collectDoctorDiagnostics({ retention: 5 })).rejects.toThrow(
      /not a database|unable to open/,
    );
  });

  test("rejects an uninitialized database naming every pending migration", async () => {
    await mkdir(home.dataRoot, { recursive: true });
    const db = new Database(databasePath());
    try {
      db.run("CREATE TABLE sessions (id TEXT PRIMARY KEY)");
    } finally {
      db.close();
    }

    await expect(collectDoctorDiagnostics({ retention: 5 })).rejects.toThrow(
      `pending migrations: ${getMigrationIds().join(", ")}`,
    );
  });

  test("rejects a database behind this release's migrations without migrating it", async () => {
    await seedDatabase((db) => {
      db.run(
        "ALTER TABLE learning_entries RENAME COLUMN observation TO mistake",
      );
      db.run(
        "DELETE FROM schema_migrations WHERE id = '003_rename_mistake_to_observation'",
      );
    });

    await expect(collectDoctorDiagnostics({ retention: 5 })).rejects.toThrow(
      "pending migrations: 003_rename_mistake_to_observation; run `vibe migrate`",
    );

    const check = new Database(databasePath(), {
      readonly: true,
      create: false,
    });
    try {
      const columns = check
        .query<{ name: string }, []>("PRAGMA table_info(learning_entries)")
        .all()
        .map((row) => row.name);
      expect(columns).toContain("mistake");
      expect(
        check
          .query(
            "SELECT 1 FROM schema_migrations WHERE id = '003_rename_mistake_to_observation'",
          )
          .get(),
      ).toBeNull();
    } finally {
      check.close();
    }
  });

  test("rejects a data root that is not a directory", async () => {
    await writeFile(home.dataRoot, "not a directory");

    await expect(collectDoctorDiagnostics({ retention: 5 })).rejects.toThrow(
      /vibe data root is not a directory/,
    );
  });

  test("rejects a database path that is not a regular file", async () => {
    await mkdir(databasePath(), { recursive: true });

    await expect(collectDoctorDiagnostics({ retention: 5 })).rejects.toThrow(
      /vibe database is not a regular file/,
    );
  });

  test("propagates non-ENOENT stat errors without fabricating a report", async () => {
    await writeFile(join(home.home, "blocked"), "not a directory");
    const previousHome = process.env["HOME"];
    process.env["HOME"] = join(home.home, "blocked", "nested");
    try {
      await expect(collectDoctorDiagnostics({ retention: 5 })).rejects.toThrow(
        /not a directory/,
      );
    } finally {
      if (previousHome === undefined) {
        delete process.env["HOME"];
      } else {
        process.env["HOME"] = previousHome;
      }
    }
  });
});

// ── Managed backup inventory ──────────────────────────────────────────────

describe("managed backup inventory", () => {
  test("orders managed backups by embedded timestamp with filename tie-break", async () => {
    await seedDatabase();
    await writeManagedBackup("vibe-prune-", "2026-01-01T00:00:00.000Z");
    const newest = await writeManagedBackup(
      "vibe-doctor-",
      "2026-03-01T00:00:00.000Z",
    );
    await writeManagedBackup("vibe-prune-", "2026-02-01T00:00:00.000Z");
    const backupsDir = join(home.dataRoot, "backups");
    await utimes(
      join(
        backupsDir,
        managedBackupName("vibe-prune-", "2026-01-01T00:00:00.000Z"),
      ),
      new Date("2030-01-01T00:00:00.000Z"),
      new Date("2030-01-01T00:00:00.000Z"),
    );

    const diagnostics = await collectDoctorDiagnostics({ retention: 1 });

    expect(diagnostics.findings.latestBackupPath).toBe(newest);
    expect(diagnostics.findings.excessBackups).toBe(2);
  });

  test("counts a pending safety backup toward retention when requested", async () => {
    await seedDatabase();
    await writeManagedBackup("vibe-prune-", "2026-01-01T00:00:00.000Z");
    await writeManagedBackup("vibe-doctor-", "2026-01-02T00:00:00.000Z");

    const current = await collectDoctorDiagnostics({ retention: 2 });
    const projected = await collectDoctorDiagnostics({
      retention: 2,
      countPendingBackup: true,
    });

    expect(current.findings.excessBackups).toBe(0);
    expect(projected.findings.excessBackups).toBe(1);
  });

  test("breaks equal embedded timestamps deterministically by filename", async () => {
    await seedDatabase();
    const doctor = await writeManagedBackup(
      "vibe-doctor-",
      "2026-01-01T00:00:00.000Z",
    );
    await writeManagedBackup("vibe-prune-", "2026-01-01T00:00:00.000Z");

    const diagnostics = await collectDoctorDiagnostics({ retention: 5 });

    expect(diagnostics.findings.latestBackupPath).toBe(doctor);
    expect(diagnostics.findings.excessBackups).toBe(0);
  });

  test("reports empty inventory for an absent backups directory", async () => {
    await seedDatabase();

    const diagnostics = await collectDoctorDiagnostics({ retention: 5 });

    expect(diagnostics.findings.excessBackups).toBe(0);
    expect(diagnostics.findings.latestBackupPath).toBeNull();
    expect(diagnostics.failures).toEqual([]);
  });

  test("ignores malformed names, directories, and symlink entries", async () => {
    await seedDatabase();
    const managed = await writeManagedBackup(
      "vibe-prune-",
      "2026-01-01T00:00:00.000Z",
    );
    const backupsDir = join(home.dataRoot, "backups");
    await writeFile(join(backupsDir, "vibe-prune-not-a-timestamp.db"), "x");
    await writeFile(
      join(
        backupsDir,
        managedBackupName("vibe-prune-", "2026-99-99T99:99:99.999Z"),
      ),
      "x",
    );
    await writeFile(
      join(backupsDir, "vibe-other-2026-01-01T00-00-00-000Z.db"),
      "x",
    );
    await writeFile(
      join(backupsDir, "vibe-prune-2026-01-01T00-00-00-000Z.txt"),
      "x",
    );
    await mkdir(
      join(
        backupsDir,
        managedBackupName("vibe-doctor-", "2026-02-01T00:00:00.000Z"),
      ),
      { recursive: true },
    );
    await writeFile(join(backupsDir, "link-target.db"), "x");
    await symlink(
      join(backupsDir, "link-target.db"),
      join(
        backupsDir,
        managedBackupName("vibe-doctor-", "2026-03-01T00:00:00.000Z"),
      ),
    );

    const diagnostics = await collectDoctorDiagnostics({ retention: 5 });

    expect(diagnostics.findings.excessBackups).toBe(0);
    expect(diagnostics.findings.latestBackupPath).toBe(managed);
    expect(diagnostics.failures).toEqual([]);
  });

  const timestampCases: Array<[string, boolean]> = [
    ["2024-02-29T00:00:00.000Z", true],
    ["2026-01-01T23-59-59-999Z", true],
    ["2026-02-29T00:00:00.000Z", false],
    ["2026-02-30T00:00:00.000Z", false],
    ["2026-04-31T00:00:00.000Z", false],
    ["2026-01-01T24-00-00-000Z", false],
  ];

  test.each(timestampCases)(
    "classifies helper timestamp %s as accepted=%p",
    async (iso, accepted) => {
      await seedDatabase();
      const filePath = await writeManagedBackup("vibe-prune-", iso);

      const diagnostics = await collectDoctorDiagnostics({ retention: 1 });

      expect(diagnostics.findings.latestBackupPath).toBe(
        accepted ? filePath : null,
      );
      expect(diagnostics.findings.excessBackups).toBe(0);
      expect(diagnostics.failures).toEqual([]);
    },
  );

  test("fails the backup inventory when the backups path is not a directory", async () => {
    await seedDatabase();
    await writeFile(join(home.dataRoot, "backups"), "not a directory");

    const diagnostics = await collectDoctorDiagnostics({ retention: 5 });

    expect(diagnostics.findings.excessBackups).toBeNull();
    expect(diagnostics.findings.latestBackupPath).toBeNull();
    expect(diagnostics.failures).toEqual([
      {
        target: "excessBackups",
        message: expect.stringMatching(/not a directory/),
      },
      {
        target: "latestBackupPath",
        message: expect.stringMatching(/not a directory/),
      },
    ]);
    expect(diagnostics.findings.integrityCheck?.ok).toBe(true);
  });

  test.skipIf(!canEnforcePermissions)(
    "fails the backup inventory when the backups directory cannot be listed",
    async () => {
      await seedDatabase();
      await writeManagedBackup("vibe-prune-", "2026-01-01T00:00:00.000Z");
      await chmod(join(home.dataRoot, "backups"), 0o000);
      try {
        const diagnostics = await collectDoctorDiagnostics({ retention: 5 });

        expect(diagnostics.findings.excessBackups).toBeNull();
        expect(diagnostics.findings.latestBackupPath).toBeNull();
        expect(diagnostics.failures).toHaveLength(2);
        for (const failure of diagnostics.failures) {
          expect(failure.message).toMatch(/permission/i);
        }
        expect(diagnostics.findings.integrityCheck?.ok).toBe(true);
      } finally {
        await chmod(join(home.dataRoot, "backups"), 0o755);
      }
      expect(await readdir(join(home.dataRoot, "backups"))).toEqual([
        managedBackupName("vibe-prune-", "2026-01-01T00:00:00.000Z"),
      ]);
    },
  );

  test("fails the backup inventory when the backups directory is a symlink", async () => {
    await seedDatabase();
    const elsewhere = await mkdtemp(join(home.home, "elsewhere-"));
    await writeFile(
      join(
        elsewhere,
        managedBackupName("vibe-prune-", "2026-01-01T00:00:00.000Z"),
      ),
      "x",
    );
    await symlink(elsewhere, join(home.dataRoot, "backups"));

    const diagnostics = await collectDoctorDiagnostics({ retention: 5 });

    expect(diagnostics.findings.excessBackups).toBeNull();
    expect(diagnostics.findings.latestBackupPath).toBeNull();
    expect(diagnostics.failures).toHaveLength(2);
    expect(diagnostics.failures[0]?.message).toMatch(/symlink/);
  });

  test("keeps legacy findings available when the backup inventory fails", async () => {
    await seedDatabase();
    await writeFile(join(home.dataRoot, "backups"), "not a directory");
    await writeFile(join(home.dataRoot, "vibe-log.json.bak"), "{}");
    seedLegacyRecord("vibe-log.json", join(home.dataRoot, "vibe-log.json.bak"));

    const diagnostics = await collectDoctorDiagnostics({ retention: 5 });

    expect(diagnostics.findings.excessBackups).toBeNull();
    expect(diagnostics.findings.legacyBackups?.candidates).toEqual([
      {
        artifact: "vibe-log.json",
        path: join(home.dataRoot, "vibe-log.json.bak"),
      },
    ]);
    expect(diagnostics.findings.strandedOriginals).toEqual([]);
  });
});

// ── Legacy record classification ──────────────────────────────────────────

describe("legacy record classification", () => {
  test("classifies safe recorded .bak copies with non-JSON prefixes and relative/absolute paths", async () => {
    await seedDatabase();
    const files = [
      "history.bak",
      "history.1.bak",
      "notes.txt.bak",
      "history.json.1x.bak",
      "vibe-log.json.bak",
      "history.json.1.bak",
    ];
    for (const name of files) {
      await writeFile(join(home.dataRoot, name), "{}");
    }
    seedLegacyRecord("history.txt", "history.bak");
    seedLegacyRecord("history.1", "history.1.bak");
    seedLegacyRecord("notes.txt", join(home.dataRoot, "notes.txt.bak"));
    seedLegacyRecord(
      "history.json",
      join(home.dataRoot, "history.json.1x.bak"),
    );
    seedLegacyRecord("vibe-log.json", "vibe-log.json.bak");
    seedLegacyRecord(
      "history-1.json",
      join(home.dataRoot, "history.json.1.bak"),
    );

    const diagnostics = await collectDoctorDiagnostics({ retention: 5 });

    const candidates = diagnostics.findings.legacyBackups?.candidates ?? [];
    expect(candidates).toHaveLength(6);
    const sortedPaths = candidates.map((c) => c.path).sort();
    const expectedPaths = files.map((name) => join(home.dataRoot, name)).sort();
    expect(sortedPaths).toEqual(expectedPaths);
    expect(diagnostics.findings.legacyBackups?.rejected).toEqual([]);
  });

  test("deduplicates duplicate recorded backup paths", async () => {
    await seedDatabase();
    await writeFile(join(home.dataRoot, "vibe-log.json.bak"), "{}");
    seedLegacyRecord("history.json", join(home.dataRoot, "vibe-log.json.bak"));
    seedLegacyRecord("vibe-log.json", join(home.dataRoot, "vibe-log.json.bak"));

    const diagnostics = await collectDoctorDiagnostics({ retention: 5 });

    expect(diagnostics.findings.legacyBackups?.candidates).toHaveLength(1);
    expect(diagnostics.findings.legacyBackups?.candidates[0]).toEqual({
      artifact: "history.json",
      path: join(home.dataRoot, "vibe-log.json.bak"),
    });
  });

  test("excludes missing recorded copies from candidates and rejections", async () => {
    await seedDatabase();
    seedLegacyRecord("vibe-log.json", join(home.dataRoot, "vibe-log.json.bak"));

    const diagnostics = await collectDoctorDiagnostics({ retention: 5 });

    expect(diagnostics.findings.legacyBackups).toEqual({
      candidates: [],
      rejected: [],
    });
  });

  test("rejects recorded backup paths that escape the data root", async () => {
    await seedDatabase();
    const outside = join(home.home, "outside.json.bak");
    await writeFile(outside, "{}");
    seedLegacyRecord(
      "outside.json",
      join(home.dataRoot, "..", "outside.json.bak"),
    );
    seedLegacyRecord(
      "sibling.json",
      join(`${home.dataRoot}-evil`, "sibling.json.bak"),
    );

    const diagnostics = await collectDoctorDiagnostics({ retention: 5 });

    const rejected = diagnostics.findings.legacyBackups?.rejected ?? [];
    expect(rejected).toHaveLength(2);
    expect(
      rejected.every((entry) => /escapes the data root/.test(entry.message)),
    ).toBe(true);
    expect(diagnostics.findings.legacyBackups?.candidates).toEqual([]);
    expect((await lstat(outside)).isFile()).toBe(true);
  });

  test("rejects recorded backup paths containing raw traversal before resolution or filesystem access", async () => {
    await seedDatabase();
    const outsideDir = join(home.home, "outside-child");
    await mkdir(outsideDir, { recursive: true });
    const outsideFile = join(home.home, "history.json.bak");
    await writeFile(outsideFile, "outside copy");

    await mkdir(home.dataRoot, { recursive: true });
    const linkPath = join(home.dataRoot, "link");
    await symlink(outsideDir, linkPath);

    const insideFile = join(home.dataRoot, "history.json.bak");
    await writeFile(insideFile, "inside copy");

    await mkdir(join(home.dataRoot, "sessions"), { recursive: true });

    const rawSymlinkTraversal = "link/../history.json.bak";
    const rawDirTraversal = "sessions/../history.json.bak";
    const rawAbsTraversal = `${home.dataRoot}/link/../history.json.bak`;

    seedLegacyRecord("history.json", rawSymlinkTraversal);
    seedLegacyRecord("history-dir.json", rawDirTraversal);
    seedLegacyRecord("history-abs.json", rawAbsTraversal);

    const diagnostics = await collectDoctorDiagnostics({ retention: 5 });

    expect(diagnostics.findings.legacyBackups?.candidates).toEqual([]);
    const rejected = diagnostics.findings.legacyBackups?.rejected ?? [];
    expect(rejected).toHaveLength(3);
    const sortedRejected = [...rejected].sort((a, b) =>
      a.path.localeCompare(b.path),
    );
    const expectedRejected = [
      {
        artifact: "history.json",
        path: rawSymlinkTraversal,
        message: "recorded backup path contains path traversal",
      },
      {
        artifact: "history-dir.json",
        path: rawDirTraversal,
        message: "recorded backup path contains path traversal",
      },
      {
        artifact: "history-abs.json",
        path: rawAbsTraversal,
        message: "recorded backup path contains path traversal",
      },
    ].sort((a, b) => a.path.localeCompare(b.path));
    expect(sortedRejected).toEqual(expectedRejected);

    expect(await readFile(insideFile, "utf8")).toBe("inside copy");
    expect(await readFile(outsideFile, "utf8")).toBe("outside copy");
    expect((await lstat(linkPath)).isSymbolicLink()).toBe(true);
    expect(await readlink(linkPath)).toBe(outsideDir);
  });

  test("rejects recorded backup paths with wrong suffixes", async () => {
    await seedDatabase();
    const recorded = [
      ["vibe-log.json", join(home.dataRoot, "vibe-log.json.txt")],
      ["history.json", join(home.dataRoot, "history.bak.old")],
      ["constitution.json", join(home.dataRoot, "constitution.json.2.bax")],
    ] as const;
    for (const [artifact, filePath] of recorded) {
      await writeFile(filePath, "{}");
      seedLegacyRecord(artifact, filePath);
    }

    const diagnostics = await collectDoctorDiagnostics({ retention: 5 });

    expect(diagnostics.findings.legacyBackups?.candidates).toEqual([]);
    const rejected = diagnostics.findings.legacyBackups?.rejected ?? [];
    expect(rejected).toHaveLength(3);
    expect(
      rejected.every(
        (entry) =>
          entry.message === "recorded backup path does not have a .bak suffix",
      ),
    ).toBe(true);
  });

  test("rejects recorded backup paths with symlink leaves or ancestors", async () => {
    await seedDatabase();
    const realCopy = join(home.home, "real-copy.json.bak");
    await writeFile(realCopy, "{}");
    const leafLink = join(home.dataRoot, "leaf.json.bak");
    await symlink(realCopy, leafLink);
    const linkedDir = join(home.home, "linked-dir");
    await mkdir(linkedDir, { recursive: true });
    await writeFile(join(linkedDir, "dir-copy.json.bak"), "{}");
    await symlink(linkedDir, join(home.dataRoot, "linked-dir"));
    const ancestorRecorded = join(
      home.dataRoot,
      "linked-dir",
      "dir-copy.json.bak",
    );
    seedLegacyRecord("leaf.json", leafLink);
    seedLegacyRecord("dir-copy.json", ancestorRecorded);

    const diagnostics = await collectDoctorDiagnostics({ retention: 5 });

    expect(diagnostics.findings.legacyBackups?.candidates).toEqual([]);
    const rejected = diagnostics.findings.legacyBackups?.rejected ?? [];
    expect(rejected).toHaveLength(2);
    expect(rejected.every((entry) => /symlink/.test(entry.message))).toBe(true);
    expect((await lstat(realCopy)).isFile()).toBe(true);
  });

  test("rejects recorded backup paths that are not regular files", async () => {
    await seedDatabase();
    const directoryRecord = join(home.dataRoot, "vibe-log.json.bak");
    await mkdir(directoryRecord, { recursive: true });
    seedLegacyRecord("vibe-log.json", directoryRecord);

    const diagnostics = await collectDoctorDiagnostics({ retention: 5 });

    expect(diagnostics.findings.legacyBackups?.candidates).toEqual([]);
    expect(diagnostics.findings.legacyBackups?.rejected).toEqual([
      {
        artifact: "vibe-log.json",
        path: directoryRecord,
        message: "recorded backup path is not a regular file",
      },
    ]);
  });

  test("rejects recorded paths beneath non-directory components while keeping safe findings", async () => {
    const { goodCopy, goodOriginal, blocker } =
      await seedNonDirectoryLegacyLayout();

    const diagnostics = await collectDoctorDiagnostics({ retention: 5 });

    expect(diagnostics.findings.legacyBackups).toEqual({
      candidates: [{ artifact: "good.json", path: goodCopy }],
      rejected: [
        {
          artifact: "bad.json",
          path: join("blocked", "bad.json.bak"),
          message: `path component is not a directory: ${blocker}`,
        },
      ],
    });
    expect(diagnostics.findings.strandedOriginals).toEqual([
      { artifact: "good.json", path: goodOriginal },
    ]);
    expect(diagnostics.failures).toEqual([]);
  });

  test("reports stranded originals with artifact and path", async () => {
    await seedDatabase();
    await mkdir(join(home.dataRoot, "sessions"), { recursive: true });
    await writeFile(join(home.dataRoot, "vibe-log.json"), "{}");
    await writeFile(join(home.dataRoot, "sessions", "one.json"), "{}");
    seedLegacyRecord("vibe-log.json", join(home.dataRoot, "vibe-log.json.bak"));
    seedLegacyRecord(
      "sessions/one.json",
      join(home.dataRoot, "sessions/one.json.bak"),
    );
    seedLegacyRecord("history.json", join(home.dataRoot, "history.json.bak"));

    const diagnostics = await collectDoctorDiagnostics({ retention: 5 });

    expect(diagnostics.findings.strandedOriginals).toEqual([
      {
        artifact: "sessions/one.json",
        path: join(home.dataRoot, "sessions", "one.json"),
      },
      { artifact: "vibe-log.json", path: join(home.dataRoot, "vibe-log.json") },
    ]);
    expect(diagnostics.findings.legacyBackups?.candidates).toEqual([]);
    expect(diagnostics.findings.legacyBackups?.rejected).toEqual([]);
  });

  test("rejects unsafe artifact names without following them", async () => {
    await seedDatabase();
    const outside = join(home.home, "outside.json");
    await writeFile(outside, "{}");
    seedLegacyRecord("outside.json", join(home.dataRoot, "outside.json.bak"));
    const escapedArtifact = join(home.dataRoot, "..", "outside.json");
    const db = new Database(databasePath());
    try {
      db.prepare(
        "UPDATE legacy_imports SET artifact = ? WHERE artifact = ?",
      ).run(escapedArtifact, "outside.json");
    } finally {
      db.close();
    }

    const diagnostics = await collectDoctorDiagnostics({ retention: 5 });

    expect(diagnostics.findings.strandedOriginals).toEqual([]);
    const rejected = diagnostics.findings.legacyBackups?.rejected ?? [];
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.message).toMatch(/escapes the data root/);
    expect((await lstat(outside)).isFile()).toBe(true);
  });

  test("rejects artifact paths containing raw traversal before resolution without creating stranded originals", async () => {
    await seedDatabase();
    await mkdir(join(home.dataRoot, "sessions"), { recursive: true });
    const insideOriginal = join(home.dataRoot, "history.json");
    await writeFile(insideOriginal, "inside original");

    const outsideDir = join(home.home, "outside-artifact");
    await mkdir(outsideDir, { recursive: true });
    const outsideOriginal = join(home.home, "outside.json");
    await writeFile(outsideOriginal, "outside original");

    const linkPath = join(home.dataRoot, "artifact-link");
    await symlink(outsideDir, linkPath);

    const rawRel = "sessions/../history.json";
    const rawLink = "artifact-link/../outside.json";
    const rawAbs = `${home.dataRoot}/sessions/../history.json`;

    seedLegacyRecord(rawRel, join(home.dataRoot, "a.json.bak"));
    seedLegacyRecord(rawLink, join(home.dataRoot, "b.json.bak"));
    seedLegacyRecord(rawAbs, join(home.dataRoot, "c.json.bak"));

    const diagnostics = await collectDoctorDiagnostics({ retention: 5 });

    expect(diagnostics.findings.strandedOriginals).toEqual([]);
    const rejected = diagnostics.findings.legacyBackups?.rejected ?? [];
    expect(rejected).toHaveLength(3);
    const sortedRejected = [...rejected].sort((a, b) =>
      a.path.localeCompare(b.path),
    );
    const expectedRejected = [
      {
        artifact: rawRel,
        path: rawRel,
        message: "artifact path contains path traversal",
      },
      {
        artifact: rawLink,
        path: rawLink,
        message: "artifact path contains path traversal",
      },
      {
        artifact: rawAbs,
        path: rawAbs,
        message: "artifact path contains path traversal",
      },
    ].sort((a, b) => a.path.localeCompare(b.path));
    expect(sortedRejected).toEqual(expectedRejected);

    expect(await readFile(insideOriginal, "utf8")).toBe("inside original");
    expect(await readFile(outsideOriginal, "utf8")).toBe("outside original");
    expect((await lstat(linkPath)).isSymbolicLink()).toBe(true);
    expect(await readlink(linkPath)).toBe(outsideDir);
  });

  test("rejects artifact paths with symlink components or non-regular files", async () => {
    await seedDatabase();
    const linkedDir = join(home.home, "artifact-dir");
    await mkdir(linkedDir, { recursive: true });
    await writeFile(join(linkedDir, "one.json"), "{}");
    await symlink(linkedDir, join(home.dataRoot, "linked-artifacts"));
    seedLegacyRecord(
      "linked-artifacts/one.json",
      join(home.dataRoot, "x.json.bak"),
    );
    await mkdir(join(home.dataRoot, "sessions"), { recursive: true });
    seedLegacyRecord("sessions", join(home.dataRoot, "y.json.bak"));

    const diagnostics = await collectDoctorDiagnostics({ retention: 5 });

    expect(diagnostics.findings.strandedOriginals).toEqual([]);
    const rejected = diagnostics.findings.legacyBackups?.rejected ?? [];
    expect(rejected).toHaveLength(2);
    expect(rejected[0]?.message).toMatch(/symlink/);
    expect(rejected[1]?.message).toMatch(/not a regular file/);
    expect((await lstat(join(linkedDir, "one.json"))).isFile()).toBe(true);
  });

  test.skipIf(!canEnforcePermissions)(
    "reports failed legacy inventory as unavailable diagnostics",
    async () => {
      await seedDatabase();
      const locked = join(home.dataRoot, "locked");
      await mkdir(locked, { recursive: true });
      await writeFile(join(locked, "one.json"), "{}");
      await writeFile(join(locked, "one.json.bak"), "{}");
      seedLegacyRecord(
        "locked/one.json",
        join(home.dataRoot, "locked/one.json.bak"),
      );
      await chmod(locked, 0o000);
      try {
        const diagnostics = await collectDoctorDiagnostics({ retention: 5 });

        expect(diagnostics.findings.legacyBackups).toBeNull();
        expect(diagnostics.findings.strandedOriginals).toBeNull();
        expect(diagnostics.failures).toEqual([
          {
            target: "legacyBackups",
            message: expect.stringMatching(/EACCES|permission/i),
          },
          {
            target: "strandedOriginals",
            message: expect.stringMatching(/EACCES|permission/i),
          },
        ]);
        expect(diagnostics.findings.integrityCheck).toEqual({
          rows: ["ok"],
          ok: true,
        });
        expect(diagnostics.findings.excessBackups).toBe(0);
      } finally {
        await chmod(locked, 0o755);
      }
    },
  );
});

// ── Existing-only connection seam ─────────────────────────────────────────

describe("existing-only connection seam", () => {
  test("rejects a disappeared database without recreating it", async () => {
    await seedDatabase();
    await rm(databasePath());
    let dispatched = false;

    await expect(
      withExistingDatabase(databasePath(), "write", () => {
        dispatched = true;
      }),
    ).rejects.toThrow(/unable to open/);
    expect(dispatched).toBe(false);
    await expect(stat(databasePath())).rejects.toThrow();
  });

  test("enforces foreign keys on explicitly dispatched write-capable operations", async () => {
    await seedDatabase();

    await expect(
      withExistingDatabase(databasePath(), "write", (db) => {
        db.prepare(
          "INSERT INTO constitution_rules (session_id, rule, position, created_at) VALUES (?, ?, ?, ?)",
        ).run("ghost", "rule", 0, "2026-01-01T00:00:00.000Z");
      }),
    ).rejects.toThrow(/FOREIGN KEY/);
  });

  test("rejects writes on read-only connections", async () => {
    await seedDatabase();

    await expect(
      withExistingDatabase(databasePath(), "read-only", (db) => {
        db.run("CREATE TABLE doctor_probe (x TEXT)");
      }),
    ).rejects.toThrow(/readonly|read-only/i);
  });

  test("closes handles after success, failure, and rejection", async () => {
    await seedDatabase();
    let successHandle: Database | undefined;
    await withExistingDatabase(databasePath(), "read-only", (db) => {
      successHandle = db;
      return db.query("SELECT 1 AS one").get();
    });
    await expectClosed(successHandle);

    let failureHandle: Database | undefined;
    await expect(
      withExistingDatabase(databasePath(), "read-only", (db) => {
        failureHandle = db;
        throw new Error("dispatch failed");
      }),
    ).rejects.toThrow("dispatch failed");
    await expectClosed(failureHandle);

    expect(() => openExistingDatabase(databasePath(), "write")).not.toThrow();
  });
});

// ── runDiagnose ───────────────────────────────────────────────────────────

describe("runDiagnose", () => {
  test("collects independent SQL sections from one read snapshot", async () => {
    await seedDatabase((db) => {
      db.prepare(
        "INSERT INTO learning_entries (type, category, observation, timestamp, demo_id) VALUES (?, ?, ?, ?, ?)",
      ).run("mistake", "demo-category", "demo observation", 1, "demo-1");
    });
    seedForeignKeyViolations(1, 1);
    seedLegacyRecord("vibe-log.json", join(home.dataRoot, "vibe-log.json.bak"));

    const payload = await runDiagnose(databasePath());

    expect(payload.integrityCheck).toEqual({ ok: true, value: ["ok"] });
    if (!payload.foreignKeyCheck.ok) {
      throw new Error(payload.foreignKeyCheck.error);
    }
    expect(payload.foreignKeyCheck.value).toHaveLength(2);
    expect(payload.freelistCount).toEqual({ ok: true, value: 0 });
    expect(payload.legacyRecords).toEqual({
      ok: true,
      value: [
        {
          artifact: "vibe-log.json",
          backupPath: join(home.dataRoot, "vibe-log.json.bak"),
        },
      ],
    });
  });
});

// ── State snapshot helper ─────────────────────────────────────────────────

interface CapturedStorageState {
  rootEntries: string[];
  sessionEntries: string[];
  backupEntries: string[];
  legacyCopy: string | null;
  original: string | null;
  rows: unknown;
}

async function captureState(): Promise<CapturedStorageState> {
  const listing = async (dir: string): Promise<string[]> => {
    try {
      return (await readdir(dir)).sort();
    } catch {
      return [];
    }
  };
  const contents = async (filePath: string): Promise<string | null> => {
    try {
      return await readFile(filePath, "utf8");
    } catch {
      return null;
    }
  };
  const db = new Database(databasePath(), { readonly: true, create: false });
  let rows: unknown;
  try {
    rows = {
      sessions: db.query("SELECT * FROM sessions ORDER BY id").all(),
      learning: db.query("SELECT * FROM learning_entries ORDER BY id").all(),
      rules: db.query("SELECT * FROM constitution_rules ORDER BY id").all(),
      interactions: db.query("SELECT * FROM interactions ORDER BY id").all(),
      imports: db.query("SELECT * FROM legacy_imports ORDER BY artifact").all(),
    };
  } finally {
    db.close();
  }
  return {
    rootEntries: await listing(home.dataRoot),
    sessionEntries: await listing(join(home.dataRoot, "sessions")),
    backupEntries: await listing(join(home.dataRoot, "backups")),
    legacyCopy: await contents(join(home.dataRoot, "vibe-log.json.bak")),
    original: await contents(join(home.dataRoot, "vibe-log.json")),
    rows,
  };
}

// ── createDoctorDatabaseBackup: dispatch contract ────────────────────────

const FIXED_TIMESTAMP = new Date("2026-01-02T03:04:05.678Z");
const FIXED_LABEL = "2026-01-02T03-04-05-678Z";

describe("createDoctorDatabaseBackup dispatch", () => {
  test("dispatches one backup and resolves the created path", async () => {
    const fake = createFakeExecutor();

    const result = await createDoctorDatabaseBackup({
      databasePath: databasePath(),
      timestamp: FIXED_TIMESTAMP,
      executor: fake,
    });

    expect(result).toBe(fake.backupResult);
    expect(fake.backupCalls).toEqual([
      { databasePath: resolve(databasePath()), timestamp: FIXED_TIMESTAMP },
    ]);
  });
});

// ── createDoctorDatabaseBackup: storage contract ─────────────────────────

describe("createDoctorDatabaseBackup storage contract", () => {
  test("names the safety backup vibe-doctor-<label>.db under the backups directory", async () => {
    await seedDatabase();

    const backupPath = await createDoctorDatabaseBackup({
      databasePath: databasePath(),
      timestamp: FIXED_TIMESTAMP,
    });

    expect(backupPath).toBe(
      join(home.dataRoot, "backups", `vibe-doctor-${FIXED_LABEL}.db`),
    );
  });

  test("captures committed WAL contents and import markers without importing legacy inputs", async () => {
    await seedDatabase();
    const writer = new Database(databasePath());
    try {
      writer.run("PRAGMA journal_mode = WAL");
      const insertEntry = writer.prepare(
        "INSERT INTO learning_entries (type, category, observation, solution, timestamp, demo_id) VALUES (?, ?, ?, ?, ?, ?)",
      );
      insertEntry.run("mistake", "cat", "entry", null, 1234567890, null);
      insertEntry.run("preference", "cat", "wal entry", null, 1234567891, null);
      writer
        .prepare(
          "INSERT INTO legacy_imports (artifact, imported_at, backup_path) VALUES (?, ?, ?)",
        )
        .run(
          "vibe-log.json",
          "2026-01-01T00:00:00.000Z",
          join(home.dataRoot, "vibe-log.json.bak"),
        );
      await mkdir(join(home.dataRoot, "sessions"), { recursive: true });
      await writeFile(join(home.dataRoot, "vibe-log.json"), "{}");
      await writeFile(join(home.dataRoot, "sessions", "unimported.json"), "{}");
      expect(await readdir(home.dataRoot)).toContain("vibe.db-wal");

      const backupPath = await createDoctorDatabaseBackup({
        databasePath: databasePath(),
        timestamp: FIXED_TIMESTAMP,
      });

      const backup = new Database(backupPath, {
        readonly: true,
        create: false,
      });
      try {
        expect(
          backup
            .query<{ observation: string; timestamp: number }, []>(
              "SELECT observation, timestamp FROM learning_entries ORDER BY timestamp",
            )
            .all(),
        ).toEqual([
          { observation: "entry", timestamp: 1234567890 },
          { observation: "wal entry", timestamp: 1234567891 },
        ]);
        expect(
          backup.query("SELECT COUNT(*) AS c FROM legacy_imports").get(),
        ).toEqual({ c: 1 });
      } finally {
        backup.close();
      }

      expect(
        writer
          .query<{ observation: string; timestamp: number }, []>(
            "SELECT observation, timestamp FROM learning_entries ORDER BY timestamp",
          )
          .all(),
      ).toEqual([
        { observation: "entry", timestamp: 1234567890 },
        { observation: "wal entry", timestamp: 1234567891 },
      ]);
      expect(
        writer.query("SELECT COUNT(*) AS c FROM legacy_imports").get(),
      ).toEqual({ c: 1 });
      expect(writer.query("SELECT COUNT(*) AS c FROM sessions").get()).toEqual({
        c: 0,
      });
      expect(await readdir(join(home.dataRoot, "sessions"))).toEqual([
        "unimported.json",
      ]);
      expect(
        (await readdir(home.dataRoot)).filter((name) => name.endsWith(".bak")),
      ).toEqual([]);
    } finally {
      writer.close();
    }
  });

  test("rejects when the database disappears between diagnosis and apply without recreating it", async () => {
    await seedDatabase();
    await collectDoctorDiagnostics({ retention: 5 });
    await rm(databasePath(), { force: true });

    await expect(
      createDoctorDatabaseBackup({
        databasePath: databasePath(),
        timestamp: FIXED_TIMESTAMP,
      }),
    ).rejects.toThrow();

    expect(await readdir(home.dataRoot)).not.toContain("vibe.db");
    expect(await readdir(home.dataRoot)).not.toContain("backups");
  });

  test("rejects and retains completed snapshot on post-link staging cleanup failure", async () => {
    await seedDatabase();
    const finalBackupPath = join(
      home.dataRoot,
      "backups",
      `vibe-doctor-${FIXED_LABEL}.db`,
    );

    await expect(
      createDoctorDatabaseBackup({
        databasePath: databasePath(),
        timestamp: FIXED_TIMESTAMP,
        backupOptions: {
          cleanupStaging: async () => {
            throw new Error("injected post-link cleanup error");
          },
        },
      }),
    ).rejects.toThrow("injected post-link cleanup error");

    expect(existsSync(finalBackupPath)).toBe(true);
    const backupDb = new Database(finalBackupPath, {
      readonly: true,
      create: false,
    });
    try {
      const integrity = backupDb
        .query<{ integrity_check: string }, []>("PRAGMA integrity_check")
        .get();
      expect(integrity?.integrity_check).toBe("ok");
    } finally {
      backupDb.close();
    }
  });

  test("closes owned database connection on both success and failure in withExistingDatabase", async () => {
    await seedDatabase();
    let closedDb: Database | undefined;
    await withExistingDatabase(databasePath(), "read-only", (db) => {
      closedDb = db;
      return 123;
    });
    expect(() => closedDb?.query("SELECT 1").get()).toThrow();

    let closedErrorDb: Database | undefined;
    await expect(
      withExistingDatabase(databasePath(), "read-only", (db) => {
        closedErrorDb = db;
        throw new Error("intentional error");
      }),
    ).rejects.toThrow("intentional error");
    expect(() => closedErrorDb?.query("SELECT 1").get()).toThrow();
  });
});

// ── Managed backup purge ──────────────────────────────────────────────────────────────

describe("purgeManagedBackups", () => {
  function backupsDirPath(): string {
    return join(home.dataRoot, "backups");
  }

  async function currentBackupNames(): Promise<string[]> {
    return (await readdir(backupsDirPath())).sort();
  }

  test("keeps only the newest retained backups and reports exact deletion counts", async () => {
    await writeManagedBackup("vibe-prune-", "2026-02-01T00:00:00.000Z");
    await writeManagedBackup("vibe-doctor-", "2026-02-02T00:00:00.000Z");
    await writeManagedBackup("vibe-prune-", "2026-02-03T00:00:00.000Z");
    const pinned = await writeManagedBackup(
      "vibe-doctor-",
      "2026-02-04T00:00:00.000Z",
    );

    const result = await purgeManagedBackups({
      dataRoot: home.dataRoot,
      retention: 2,
      pinnedPath: pinned,
    });

    expect(result).toEqual({ deleted: 2, failures: [] });
    expect(await currentBackupNames()).toEqual(
      [
        managedBackupName("vibe-prune-", "2026-02-03T00:00:00.000Z"),
        managedBackupName("vibe-doctor-", "2026-02-04T00:00:00.000Z"),
      ].sort(),
    );
  });

  test("keeps every backup and deletes none when the inventory fits the retention", async () => {
    await writeManagedBackup("vibe-prune-", "2026-02-01T00:00:00.000Z");
    const pinned = await writeManagedBackup(
      "vibe-doctor-",
      "2026-02-02T00:00:00.000Z",
    );

    const result = await purgeManagedBackups({
      dataRoot: home.dataRoot,
      retention: 2,
      pinnedPath: pinned,
    });

    expect(result).toEqual({ deleted: 0, failures: [] });
    expect((await currentBackupNames()).length).toBe(2);
  });

  test("pools both managed prefixes into a single retention set", async () => {
    await writeManagedBackup("vibe-prune-", "2026-02-01T00:00:00.000Z");
    await writeManagedBackup("vibe-prune-", "2026-02-02T00:00:00.000Z");
    await writeManagedBackup("vibe-doctor-", "2026-02-03T00:00:00.000Z");
    const pinned = await writeManagedBackup(
      "vibe-doctor-",
      "2026-02-04T00:00:00.000Z",
    );

    const result = await purgeManagedBackups({
      dataRoot: home.dataRoot,
      retention: 2,
      pinnedPath: pinned,
    });

    expect(result).toEqual({ deleted: 2, failures: [] });
    expect(await currentBackupNames()).toEqual(
      [
        managedBackupName("vibe-doctor-", "2026-02-03T00:00:00.000Z"),
        managedBackupName("vibe-doctor-", "2026-02-04T00:00:00.000Z"),
      ].sort(),
    );
  });

  test("breaks equal embedded timestamps deterministically by filename", async () => {
    await writeManagedBackup("vibe-prune-", "2026-02-01T00:00:00.000Z");
    await writeManagedBackup("vibe-doctor-", "2026-02-01T00:00:00.000Z");
    const pinned = await writeManagedBackup(
      "vibe-doctor-",
      "2026-02-02T00:00:00.000Z",
    );

    const result = await purgeManagedBackups({
      dataRoot: home.dataRoot,
      retention: 2,
      pinnedPath: pinned,
    });

    expect(result).toEqual({ deleted: 1, failures: [] });
    expect(await currentBackupNames()).toEqual(
      [
        managedBackupName("vibe-doctor-", "2026-02-01T00:00:00.000Z"),
        managedBackupName("vibe-doctor-", "2026-02-02T00:00:00.000Z"),
      ].sort(),
    );
    expect(await currentBackupNames()).not.toContain(
      managedBackupName("vibe-prune-", "2026-02-01T00:00:00.000Z"),
    );
  });

  test("orders deletions by embedded timestamps despite misleading mtimes", async () => {
    const misleadOld = await writeManagedBackup(
      "vibe-prune-",
      "2026-02-01T00:00:00.000Z",
    );
    await writeManagedBackup("vibe-doctor-", "2026-02-02T00:00:00.000Z");
    const pinned = await writeManagedBackup(
      "vibe-prune-",
      "2026-02-03T00:00:00.000Z",
    );
    await utimes(
      misleadOld,
      new Date("2030-01-01T00:00:00.000Z"),
      new Date("2030-01-01T00:00:00.000Z"),
    );
    await utimes(
      pinned,
      new Date("2000-01-01T00:00:00.000Z"),
      new Date("2000-01-01T00:00:00.000Z"),
    );

    const result = await purgeManagedBackups({
      dataRoot: home.dataRoot,
      retention: 1,
      pinnedPath: pinned,
    });

    expect(result).toEqual({ deleted: 2, failures: [] });
    expect(await currentBackupNames()).toEqual([
      managedBackupName("vibe-prune-", "2026-02-03T00:00:00.000Z"),
    ]);
  });

  test("preserves malformed names, unrelated files, directories, and symlinks", async () => {
    await writeManagedBackup("vibe-prune-", "2026-02-01T00:00:00.000Z");
    const pinned = await writeManagedBackup(
      "vibe-doctor-",
      "2026-02-02T00:00:00.000Z",
    );
    const dir = backupsDirPath();
    await writeFile(
      join(dir, "vibe-prune-2026-02-01T00:00:00.000Z.db.bak"),
      "junk",
    );
    await writeFile(join(dir, "vibe-doctor-not-a-timestamp.db"), "junk");
    await writeFile(
      join(dir, "vibe-prune-2026-02-30T00-00-00-000Z.db"),
      "junk",
    );
    await writeFile(join(dir, "notes.txt"), "junk");
    await mkdir(
      join(dir, managedBackupName("vibe-prune-", "2026-02-03T00:00:00.000Z")),
    );
    const outside = join(home.dataRoot, "outside.db");
    await writeFile(outside, "outside");
    await symlink(
      outside,
      join(dir, managedBackupName("vibe-doctor-", "2026-02-04T00:00:00.000Z")),
    );

    const result = await purgeManagedBackups({
      dataRoot: home.dataRoot,
      retention: 1,
      pinnedPath: pinned,
    });

    expect(result).toEqual({ deleted: 1, failures: [] });
    const names = await currentBackupNames();
    expect(names).toContain("vibe-prune-2026-02-01T00:00:00.000Z.db.bak");
    expect(names).toContain("vibe-doctor-not-a-timestamp.db");
    expect(names).toContain("vibe-prune-2026-02-30T00-00-00-000Z.db");
    expect(names).toContain("notes.txt");
    expect(names).toContain(
      managedBackupName("vibe-prune-", "2026-02-03T00:00:00.000Z"),
    );
    expect(names).toContain(
      managedBackupName("vibe-doctor-", "2026-02-04T00:00:00.000Z"),
    );
    expect(await readFile(outside, "utf8")).toBe("outside");
  });

  test("always preserves the pinned backup under clock skew allowing one extra survivor", async () => {
    const pinned = await writeManagedBackup(
      "vibe-doctor-",
      "2026-02-01T00:00:00.000Z",
    );
    await writeManagedBackup("vibe-prune-", "2026-02-02T00:00:00.000Z");
    await writeManagedBackup("vibe-doctor-", "2026-02-03T00:00:00.000Z");
    await writeManagedBackup("vibe-prune-", "2026-02-04T00:00:00.000Z");

    const result = await purgeManagedBackups({
      dataRoot: home.dataRoot,
      retention: 2,
      pinnedPath: pinned,
    });

    expect(result).toEqual({ deleted: 1, failures: [] });
    expect(await currentBackupNames()).toEqual(
      [
        managedBackupName("vibe-doctor-", "2026-02-01T00:00:00.000Z"),
        managedBackupName("vibe-doctor-", "2026-02-03T00:00:00.000Z"),
        managedBackupName("vibe-prune-", "2026-02-04T00:00:00.000Z"),
      ].sort(),
    );
  });

  test("re-inventories after backup creation while pre-apply findings stay unchanged", async () => {
    await seedDatabase();
    await writeManagedBackup("vibe-prune-", "2026-01-01T00:00:00.000Z");
    await writeManagedBackup("vibe-prune-", "2026-01-02T00:00:00.000Z");
    const newestOld = await writeManagedBackup(
      "vibe-doctor-",
      "2026-01-03T00:00:00.000Z",
    );

    const diagnostics = await collectDoctorDiagnostics({ retention: 2 });
    expect(diagnostics.findings.excessBackups).toBe(1);
    expect(diagnostics.findings.latestBackupPath).toBe(newestOld);

    const backupPath = await createDoctorDatabaseBackup({
      databasePath: databasePath(),
      timestamp: new Date("2026-01-04T00:00:00.000Z"),
    });

    const result = await purgeManagedBackups({
      dataRoot: home.dataRoot,
      retention: 2,
      pinnedPath: backupPath,
    });

    expect(result).toEqual({ deleted: 2, failures: [] });
    expect(await currentBackupNames()).toEqual(
      [
        managedBackupName("vibe-doctor-", "2026-01-03T00:00:00.000Z"),
        managedBackupName("vibe-doctor-", "2026-01-04T00:00:00.000Z"),
      ].sort(),
    );
    expect(diagnostics.findings.excessBackups).toBe(1);
    expect(diagnostics.findings.latestBackupPath).toBe(newestOld);
  });

  test("preserves completed deletion counts across later unlink failures", async () => {
    await writeManagedBackup("vibe-prune-", "2026-02-01T00:00:00.000Z");
    const failing = await writeManagedBackup(
      "vibe-doctor-",
      "2026-02-02T00:00:00.000Z",
    );
    await writeManagedBackup("vibe-prune-", "2026-02-03T00:00:00.000Z");
    const pinned = await writeManagedBackup(
      "vibe-doctor-",
      "2026-02-04T00:00:00.000Z",
    );

    const result = await purgeManagedBackups({
      dataRoot: home.dataRoot,
      retention: 1,
      pinnedPath: pinned,
      unlinkFile: async (target) => {
        if (target === failing)
          throw makeErrno("EIO", "injected unlink failure");
        await unlink(target);
      },
    });

    expect(result.deleted).toBe(2);
    expect(result.failures).toEqual([
      {
        target: "purgeBackups",
        message: `failed to remove managed backup ${failing}: injected unlink failure`,
      },
    ]);
    expect(await currentBackupNames()).toEqual(
      [
        managedBackupName("vibe-doctor-", "2026-02-02T00:00:00.000Z"),
        managedBackupName("vibe-doctor-", "2026-02-04T00:00:00.000Z"),
      ].sort(),
    );
  });

  test("tolerates vanished candidates without counting them as deletions", async () => {
    const vanished = await writeManagedBackup(
      "vibe-prune-",
      "2026-02-01T00:00:00.000Z",
    );
    await writeManagedBackup("vibe-doctor-", "2026-02-02T00:00:00.000Z");
    const pinned = await writeManagedBackup(
      "vibe-prune-",
      "2026-02-03T00:00:00.000Z",
    );

    const result = await purgeManagedBackups({
      dataRoot: home.dataRoot,
      retention: 1,
      pinnedPath: pinned,
      unlinkFile: async (target) => {
        if (target === vanished) {
          await rm(target);
          throw makeErrno("ENOENT", "already gone");
        }
        await unlink(target);
      },
    });

    expect(result).toEqual({ deleted: 1, failures: [] });
    expect(await currentBackupNames()).toEqual([
      managedBackupName("vibe-prune-", "2026-02-03T00:00:00.000Z"),
    ]);
  });

  test.skipIf(!canEnforcePermissions)(
    "leaves candidates in place and reports filesystem errors without deletions",
    async () => {
      await writeManagedBackup("vibe-prune-", "2026-02-01T00:00:00.000Z");
      const pinned = await writeManagedBackup(
        "vibe-doctor-",
        "2026-02-02T00:00:00.000Z",
      );
      const dir = backupsDirPath();
      const candidate = join(
        dir,
        managedBackupName("vibe-prune-", "2026-02-01T00:00:00.000Z"),
      );
      await chmod(dir, 0o555);
      try {
        const result = await purgeManagedBackups({
          dataRoot: home.dataRoot,
          retention: 1,
          pinnedPath: pinned,
        });

        expect(result.deleted).toBe(0);
        expect(result.failures.length).toBe(1);
        expect(result.failures[0]?.target).toBe("purgeBackups");
        expect(result.failures[0]?.message).toContain(
          `failed to remove managed backup ${candidate}`,
        );
        expect((await currentBackupNames()).length).toBe(2);
      } finally {
        await chmod(dir, 0o755);
      }
    },
  );

  test.skipIf(!canEnforcePermissions)(
    "reports revalidation failures for unreadable candidates without deletions",
    async () => {
      await writeManagedBackup("vibe-prune-", "2026-02-01T00:00:00.000Z");
      const pinned = await writeManagedBackup(
        "vibe-doctor-",
        "2026-02-02T00:00:00.000Z",
      );
      const candidate = join(
        backupsDirPath(),
        managedBackupName("vibe-prune-", "2026-02-01T00:00:00.000Z"),
      );
      // Read-only directory: inventory readdir succeeds, but stat'ing a
      // candidate needs execute permission, which the pre-unlink
      // revalidation must surface as a target failure.
      await chmod(backupsDirPath(), 0o444);
      try {
        const result = await purgeManagedBackups({
          dataRoot: home.dataRoot,
          retention: 1,
          pinnedPath: pinned,
        });

        expect(result.deleted).toBe(0);
        expect(result.failures).toHaveLength(1);
        expect(result.failures[0]?.target).toBe("purgeBackups");
        expect(result.failures[0]?.message).toContain(
          "managed backup revalidation failed for",
        );
        expect(result.failures[0]?.message).toMatch(/permission/i);
      } finally {
        await chmod(backupsDirPath(), 0o755);
      }
      expect((await currentBackupNames()).length).toBe(2);
      expect(await readFile(candidate, "utf8")).toBe("backup");
    },
  );

  test("preserves a candidate swapped for a symlink before unlink", async () => {
    await writeManagedBackup("vibe-prune-", "2026-02-01T00:00:00.000Z");
    const swapped = await writeManagedBackup(
      "vibe-doctor-",
      "2026-02-02T00:00:00.000Z",
    );
    const pinned = await writeManagedBackup(
      "vibe-prune-",
      "2026-02-03T00:00:00.000Z",
    );
    const outside = join(home.dataRoot, "outside.db");
    await writeFile(outside, "outside");

    const result = await purgeManagedBackups({
      dataRoot: home.dataRoot,
      retention: 1,
      pinnedPath: pinned,
      unlinkFile: async (target) => {
        if (target !== swapped) {
          await rm(swapped);
          await symlink(outside, swapped);
        }
        await unlink(target);
      },
    });

    expect(result).toEqual({ deleted: 1, failures: [] });
    expect((await lstat(swapped)).isSymbolicLink()).toBe(true);
    expect(await readFile(outside, "utf8")).toBe("outside");
  });

  test("preserves a candidate swapped for a directory before unlink", async () => {
    await writeManagedBackup("vibe-prune-", "2026-02-01T00:00:00.000Z");
    const swapped = await writeManagedBackup(
      "vibe-doctor-",
      "2026-02-02T00:00:00.000Z",
    );
    const pinned = await writeManagedBackup(
      "vibe-prune-",
      "2026-02-03T00:00:00.000Z",
    );

    const result = await purgeManagedBackups({
      dataRoot: home.dataRoot,
      retention: 1,
      pinnedPath: pinned,
      unlinkFile: async (target) => {
        if (target !== swapped) {
          await rm(swapped);
          await mkdir(swapped);
        }
        await unlink(target);
      },
    });

    expect(result).toEqual({ deleted: 1, failures: [] });
    expect((await stat(swapped)).isDirectory()).toBe(true);
  });

  test("skips candidates whose filename no longer parses as a managed backup", async () => {
    // Stale inventory: the entry was recorded while its name parsed, but the
    // name no longer conforms at revalidation time. The pre-unlink
    // revalidation must preserve the target silently instead of unlinking.
    const pinned = await writeManagedBackup(
      "vibe-doctor-",
      "2026-02-02T00:00:00.000Z",
    );
    const inventorySpy = spyOn(
      managedBackups,
      "readManagedBackupEntries",
    ).mockResolvedValue({
      ok: true,
      entries: [
        {
          fileName: managedBackupName(
            "vibe-doctor-",
            "2026-02-02T00:00:00.000Z",
          ),
          filePath: pinned,
          timestampMs: Date.parse("2026-02-02T00:00:00.000Z"),
        },
        {
          fileName: "notes.txt",
          filePath: join(backupsDirPath(), "notes.txt"),
          timestampMs: Date.parse("2026-02-01T00:00:00.000Z"),
        },
      ],
    });

    const result = await purgeManagedBackups({
      dataRoot: home.dataRoot,
      retention: 1,
      pinnedPath: pinned,
    });

    expect(inventorySpy).toHaveBeenCalledWith(backupsDirPath());
    expect(result).toEqual({ deleted: 0, failures: [] });
    expect(await currentBackupNames()).toEqual([
      managedBackupName("vibe-doctor-", "2026-02-02T00:00:00.000Z"),
    ]);
  });

  test("fails without deletions when the backups directory is a symlink", async () => {
    await mkdir(home.dataRoot, { recursive: true });
    const outsideDir = join(home.dataRoot, "outside");
    await mkdir(outsideDir);
    await writeFile(
      join(outsideDir, "vibe-prune-2026-02-01T00-00-00-000Z.db"),
      "junk",
    );
    await symlink(outsideDir, backupsDirPath());

    const result = await purgeManagedBackups({
      dataRoot: home.dataRoot,
      retention: 1,
      pinnedPath: join(
        backupsDirPath(),
        "vibe-doctor-2026-02-02T00-00-00-000Z.db",
      ),
    });

    expect(result.deleted).toBe(0);
    expect(result.failures).toEqual([
      {
        target: "purgeBackups",
        message:
          "managed backup inventory unavailable: backups directory is a symlink",
      },
    ]);
    expect(await readdir(outsideDir)).toEqual([
      "vibe-prune-2026-02-01T00-00-00-000Z.db",
    ]);
  });

  test("fails without deletions when the backups path is not a directory", async () => {
    await mkdir(home.dataRoot, { recursive: true });
    await writeFile(backupsDirPath(), "not a directory");

    const result = await purgeManagedBackups({
      dataRoot: home.dataRoot,
      retention: 1,
      pinnedPath: join(
        backupsDirPath(),
        "vibe-doctor-2026-02-02T00-00-00-000Z.db",
      ),
    });

    expect(result.deleted).toBe(0);
    expect(result.failures).toEqual([
      {
        target: "purgeBackups",
        message:
          "managed backup inventory unavailable: backups path is not a directory",
      },
    ]);
  });

  test("reports zero deletions for an absent backups directory", async () => {
    const result = await purgeManagedBackups({
      dataRoot: home.dataRoot,
      retention: 1,
      pinnedPath: join(
        backupsDirPath(),
        "vibe-doctor-2026-02-02T00-00-00-000Z.db",
      ),
    });

    expect(result).toEqual({ deleted: 0, failures: [] });
  });

  test("rejects invalid retention values before touching storage", async () => {
    const pinned = await writeManagedBackup(
      "vibe-doctor-",
      "2026-02-01T00:00:00.000Z",
    );

    for (const retention of [0, -1, 2.5, Number.NaN]) {
      await expect(
        purgeManagedBackups({
          dataRoot: home.dataRoot,
          retention,
          pinnedPath: pinned,
        }),
      ).rejects.toThrow("invalid retention");
    }
    expect(await currentBackupNames()).toEqual([
      managedBackupName("vibe-doctor-", "2026-02-01T00:00:00.000Z"),
    ]);
  });
});

// ── Legacy copy purge ─────────────────────────────────────────────────────

function legacyRef(artifact: string, target: string): LegacyRecordRef {
  return { artifact, path: target };
}

function legacyFinding(
  candidates: LegacyRecordRef[],
  rejected: RejectedLegacyRecord[] = [],
): LegacyBackupsFinding {
  return { candidates, rejected };
}

async function writeLegacyFile(
  relative: string,
  content = "legacy",
): Promise<string> {
  const target = join(home.dataRoot, relative);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, content);
  return target;
}

/**
 * Seed one safe recorded copy beside a record whose ancestor is a regular
 * file, plus the stranded original referenced by the safe record.
 */
async function seedNonDirectoryLegacyLayout(): Promise<{
  goodCopy: string;
  goodOriginal: string;
  blocker: string;
}> {
  await seedDatabase();
  const goodCopy = await writeLegacyFile("good.json.bak", "old copy");
  const goodOriginal = await writeLegacyFile("good.json", '{"fresh":"data"}');
  const blocker = join(home.dataRoot, "blocked");
  await writeFile(blocker, "not a directory");
  seedLegacyRecord("good.json", "good.json.bak");
  seedLegacyRecord("bad.json", join("blocked", "bad.json.bak"));
  return { goodCopy, goodOriginal, blocker };
}

describe("purgeLegacyCopies", () => {
  test("purges safe recorded .bak copies with non-JSON prefixes and relative/absolute paths once", async () => {
    await writeLegacyFile("history.bak", "history");
    const history1Bak = await writeLegacyFile("history.1.bak", "history 1");
    await writeLegacyFile("notes.txt.bak", "notes");
    const history1xBak = await writeLegacyFile("history.json.1x.bak", "1x");
    const plainJsonBak = await writeLegacyFile("vibe-log.json.bak", "plain");
    const unrecordedBak = await writeLegacyFile(
      "unrecorded.bak",
      "preserve me",
    );
    const otherTxt = await writeLegacyFile("other.txt", "keep me");

    const result = await purgeLegacyCopies({
      dataRoot: home.dataRoot,
      legacyBackups: legacyFinding([
        legacyRef("history.txt", "history.bak"),
        legacyRef("history.1", history1Bak),
        legacyRef("notes.txt", "notes.txt.bak"),
        legacyRef("history.json", history1xBak),
        legacyRef("vibe-log.json", plainJsonBak),
        legacyRef("history.dup", "history.bak"),
      ]),
    });

    expect(result).toEqual({ deleted: 5, failures: [] });
    expect(await readFile(unrecordedBak, "utf8")).toBe("preserve me");
    expect(await readFile(otherTxt, "utf8")).toBe("keep me");
    expect((await readdir(home.dataRoot)).sort()).toEqual([
      "other.txt",
      "unrecorded.bak",
    ]);
  });

  test("treats missing copies and absent directories as zero deletions", async () => {
    const missing = join(home.dataRoot, "vibe-log.json.bak");
    const underAbsentDir = join(home.dataRoot, "ghost", "history.json.bak");

    const result = await purgeLegacyCopies({
      dataRoot: home.dataRoot,
      legacyBackups: legacyFinding([
        legacyRef("vibe-log.json", missing),
        legacyRef("history.json", underAbsentDir),
      ]),
    });

    expect(result).toEqual({ deleted: 0, failures: [] });
    await expect(stat(home.dataRoot)).rejects.toThrow();
  });

  test("refuses sibling-prefix escapes outside the data root", async () => {
    await mkdir(home.dataRoot, { recursive: true });
    const siblingDir = `${home.dataRoot}-sibling`;
    await mkdir(siblingDir, { recursive: true });
    const outside = join(siblingDir, "evil.json.bak");
    await writeFile(outside, "outside");

    const result = await purgeLegacyCopies({
      dataRoot: home.dataRoot,
      legacyBackups: legacyFinding([legacyRef("evil.json", outside)]),
    });

    expect(result.deleted).toBe(0);
    expect(result.failures).toEqual([
      {
        target: "purgeLegacy",
        message: `legacy cleanup refused for ${outside}: recorded backup path escapes the data root`,
      },
    ]);
    expect(await readFile(outside, "utf8")).toBe("outside");
  });

  test("refuses wrong-suffix recorded copies and preserves them", async () => {
    const wrongSuffix = await writeLegacyFile("notes.txt.old");
    const wrongExtension = await writeLegacyFile("vibe-log.json.exe");

    const result = await purgeLegacyCopies({
      dataRoot: home.dataRoot,
      legacyBackups: legacyFinding([
        legacyRef("notes.json", wrongSuffix),
        legacyRef("vibe-log.json", wrongExtension),
      ]),
    });

    expect(result.deleted).toBe(0);
    expect(result.failures).toEqual([
      {
        target: "purgeLegacy",
        message: `legacy cleanup refused for ${wrongSuffix}: recorded backup path does not have a .bak suffix`,
      },
      {
        target: "purgeLegacy",
        message: `legacy cleanup refused for ${wrongExtension}: recorded backup path does not have a .bak suffix`,
      },
    ]);
    expect((await readdir(home.dataRoot)).sort()).toEqual([
      "notes.txt.old",
      "vibe-log.json.exe",
    ]);
  });

  test("refuses symlink leaves and preserves their targets", async () => {
    await mkdir(home.dataRoot, { recursive: true });
    const target = join(home.home, "swap-target.json");
    await writeFile(target, "precious");
    const copy = join(home.dataRoot, "vibe-log.json.bak");
    await symlink(target, copy);

    const result = await purgeLegacyCopies({
      dataRoot: home.dataRoot,
      legacyBackups: legacyFinding([legacyRef("vibe-log.json", copy)]),
    });

    expect(result.deleted).toBe(0);
    expect(result.failures).toEqual([
      {
        target: "purgeLegacy",
        message: `legacy cleanup refused for ${copy}: path component is a symlink: ${copy}`,
      },
    ]);
    expect((await lstat(copy)).isSymbolicLink()).toBe(true);
    expect(await readFile(target, "utf8")).toBe("precious");
  });

  test("refuses symlinked ancestor directories and preserves contained copies", async () => {
    await mkdir(home.dataRoot, { recursive: true });
    const outsideDir = join(home.home, "outside-dir");
    await mkdir(outsideDir);
    const outside = join(outsideDir, "evil.json.bak");
    await writeFile(outside, "outside");
    const link = join(home.dataRoot, "linkdir");
    await symlink(outsideDir, link);
    const recorded = join(link, "evil.json.bak");

    const result = await purgeLegacyCopies({
      dataRoot: home.dataRoot,
      legacyBackups: legacyFinding([legacyRef("evil.json", recorded)]),
    });

    expect(result.deleted).toBe(0);
    expect(result.failures).toEqual([
      {
        target: "purgeLegacy",
        message: `legacy cleanup refused for ${recorded}: path component is a symlink: ${link}`,
      },
    ]);
    expect(await readFile(outside, "utf8")).toBe("outside");
  });

  test("reports known unsafe entries as target failures while preserving diagnostics", async () => {
    const copy = await writeLegacyFile("vibe-log.json.bak");
    const finding = legacyFinding(
      [legacyRef("vibe-log.json", copy)],
      [
        {
          artifact: "evil.json",
          path: "../evil.json.bak",
          message: "recorded backup path escapes the data root",
        },
        {
          artifact: "notes.json",
          path: "notes.txt.old",
          message: "recorded backup path does not have a .bak suffix",
        },
      ],
    );
    const before = structuredClone(finding);

    const result = await purgeLegacyCopies({
      dataRoot: home.dataRoot,
      legacyBackups: finding,
    });

    expect(result.deleted).toBe(1);
    expect(result.failures).toEqual([
      {
        target: "purgeLegacy",
        message:
          "legacy cleanup refused for ../evil.json.bak: recorded backup path escapes the data root",
      },
      {
        target: "purgeLegacy",
        message:
          "legacy cleanup refused for notes.txt.old: recorded backup path does not have a .bak suffix",
      },
    ]);
    expect(finding).toEqual(before);
  });

  test("deletes safe copies while reporting records blocked by non-directory components", async () => {
    const { goodCopy, goodOriginal, blocker } =
      await seedNonDirectoryLegacyLayout();

    const diagnostics = await collectDoctorDiagnostics({ retention: 5 });
    const result = await purgeLegacyCopies({
      dataRoot: home.dataRoot,
      legacyBackups: diagnostics.findings.legacyBackups,
    });

    expect(result).toEqual({
      deleted: 1,
      failures: [
        {
          target: "purgeLegacy",
          message: `legacy cleanup refused for ${join("blocked", "bad.json.bak")}: path component is not a directory: ${blocker}`,
        },
      ],
    });
    await expect(stat(goodCopy)).rejects.toThrow();
    expect(await readFile(goodOriginal, "utf8")).toBe('{"fresh":"data"}');
    expect(await readFile(blocker, "utf8")).toBe("not a directory");
  });

  test("preserves stranded originals while deleting their recorded copies", async () => {
    const rewritten = '{"fresh":"data absent from sqlite"}';
    const original = await writeLegacyFile("vibe-log.json", rewritten);
    const copy = await writeLegacyFile("vibe-log.json.bak", "old copy");

    const result = await purgeLegacyCopies({
      dataRoot: home.dataRoot,
      legacyBackups: legacyFinding([legacyRef("vibe-log.json", copy)]),
    });

    expect(result).toEqual({ deleted: 1, failures: [] });
    expect(await readFile(original, "utf8")).toBe(rewritten);
    await expect(stat(copy)).rejects.toThrow();
  });

  test("preserves nonempty legacy sessions directories without failure", async () => {
    const sessions = join(home.dataRoot, "sessions");
    await mkdir(join(sessions, "sub"), { recursive: true });
    await writeFile(join(sessions, "fresh.json"), "{}");
    await writeFile(join(sessions, "sub", "inner.txt"), "x");

    const result = await purgeLegacyCopies({
      dataRoot: home.dataRoot,
      legacyBackups: legacyFinding([]),
    });

    expect(result).toEqual({ deleted: 0, failures: [] });
    expect((await readdir(sessions)).sort()).toEqual(["fresh.json", "sub"]);
    expect(await readFile(join(sessions, "sub", "inner.txt"), "utf8")).toBe(
      "x",
    );
  });

  test("removes an empty legacy sessions directory without counting it as a deletion", async () => {
    const sessions = join(home.dataRoot, "sessions");
    await mkdir(sessions, { recursive: true });
    const copy = await writeLegacyFile("history.json.bak");
    const removed: string[] = [];

    const result = await purgeLegacyCopies({
      dataRoot: home.dataRoot,
      legacyBackups: legacyFinding([legacyRef("history.json", copy)]),
      removeDirectory: async (target) => {
        removed.push(target);
        await rmdir(target);
      },
    });

    expect(result).toEqual({ deleted: 1, failures: [] });
    expect(removed).toEqual([sessions]);
    expect(await readdir(home.dataRoot)).toEqual([]);
  });

  test("preserves a missing legacy sessions directory without failure", async () => {
    await mkdir(home.dataRoot, { recursive: true });

    const result = await purgeLegacyCopies({
      dataRoot: home.dataRoot,
      legacyBackups: legacyFinding([]),
    });

    expect(result).toEqual({ deleted: 0, failures: [] });
  });

  test("tolerates an injected EEXIST sessions-removal error silently", async () => {
    const sessions = join(home.dataRoot, "sessions");
    await mkdir(sessions, { recursive: true });
    const copy = await writeLegacyFile("history.json.bak");

    const result = await purgeLegacyCopies({
      dataRoot: home.dataRoot,
      legacyBackups: legacyFinding([legacyRef("history.json", copy)]),
      removeDirectory: async () => {
        throw makeErrno("EEXIST", "sessions directory raced non-empty");
      },
    });

    expect(result).toEqual({ deleted: 1, failures: [] });
    expect((await stat(sessions)).isDirectory()).toBe(true);
  });

  test("fails on a symlinked legacy sessions directory and preserves its contents", async () => {
    await mkdir(home.dataRoot, { recursive: true });
    const outsideDir = join(home.home, "outside-sessions");
    await mkdir(outsideDir);
    await writeFile(join(outsideDir, "abc123.json"), "{}");
    const sessions = join(home.dataRoot, "sessions");
    await symlink(outsideDir, sessions);

    const result = await purgeLegacyCopies({
      dataRoot: home.dataRoot,
      legacyBackups: legacyFinding([]),
    });

    expect(result.deleted).toBe(0);
    expect(result.failures).toEqual([
      {
        target: "purgeLegacy",
        message: `unsafe legacy sessions directory ${sessions}: path component is a symlink: ${sessions}`,
      },
    ]);
    expect((await lstat(sessions)).isSymbolicLink()).toBe(true);
    expect(await readdir(outsideDir)).toEqual(["abc123.json"]);
  });

  test("fails when the legacy sessions path is not a directory", async () => {
    await mkdir(home.dataRoot, { recursive: true });
    const sessions = join(home.dataRoot, "sessions");
    await writeFile(sessions, "not a directory");

    const result = await purgeLegacyCopies({
      dataRoot: home.dataRoot,
      legacyBackups: legacyFinding([]),
    });

    expect(result.deleted).toBe(0);
    expect(result.failures).toEqual([
      {
        target: "purgeLegacy",
        message: `unsafe legacy sessions directory ${sessions}: legacy sessions path is not a directory`,
      },
    ]);
    expect(await readFile(sessions, "utf8")).toBe("not a directory");
  });

  test("preserves completed deletion counts across injected unlink failures", async () => {
    const first = await writeLegacyFile("vibe-log.json.bak");
    const failing = await writeLegacyFile("history.json.bak");

    const result = await purgeLegacyCopies({
      dataRoot: home.dataRoot,
      legacyBackups: legacyFinding([
        legacyRef("vibe-log.json", first),
        legacyRef("history.json", failing),
      ]),
      unlinkFile: async (target) => {
        if (target === failing) {
          throw makeErrno("EIO", "injected unlink failure");
        }
        await unlink(target);
      },
    });

    expect(result.deleted).toBe(1);
    expect(result.failures).toEqual([
      {
        target: "purgeLegacy",
        message: `failed to remove legacy copy ${failing}: injected unlink failure`,
      },
    ]);
    expect(await readdir(home.dataRoot)).toEqual(["history.json.bak"]);
  });

  test("tolerates copies that vanish at unlink without counting them", async () => {
    const vanished = await writeLegacyFile("vibe-log.json.bak");

    const result = await purgeLegacyCopies({
      dataRoot: home.dataRoot,
      legacyBackups: legacyFinding([legacyRef("vibe-log.json", vanished)]),
      unlinkFile: async (target) => {
        await rm(target);
        throw makeErrno("ENOENT", "already gone");
      },
    });

    expect(result).toEqual({ deleted: 0, failures: [] });
  });

  test("reports injected sessions-directory failures with evidence while retaining deletions", async () => {
    const sessions = join(home.dataRoot, "sessions");
    await mkdir(sessions, { recursive: true });
    const copy = await writeLegacyFile("history.json.bak");

    const result = await purgeLegacyCopies({
      dataRoot: home.dataRoot,
      legacyBackups: legacyFinding([legacyRef("history.json", copy)]),
      removeDirectory: async () => {
        throw makeErrno("EPERM", "injected rmdir failure");
      },
    });

    expect(result.deleted).toBe(1);
    expect(result.failures).toEqual([
      {
        target: "purgeLegacy",
        message: `failed to remove legacy sessions directory ${sessions}: injected rmdir failure`,
      },
    ]);
    expect((await stat(sessions)).isDirectory()).toBe(true);
  });

  test.skipIf(!canEnforcePermissions)(
    "reports session-directory probe failures without deleting anything",
    async () => {
      const sessions = join(home.dataRoot, "sessions");
      await mkdir(sessions, { recursive: true });
      // Unsearchable data root: stat'ing the sessions path fails with
      // EACCES, which the directory probe must surface as a target failure.
      await chmod(home.dataRoot, 0o000);
      try {
        const result = await purgeLegacyCopies({
          dataRoot: home.dataRoot,
          legacyBackups: legacyFinding([]),
        });

        expect(result.deleted).toBe(0);
        expect(result.failures).toHaveLength(1);
        expect(result.failures[0]?.target).toBe("purgeLegacy");
        expect(result.failures[0]?.message).toContain(
          "failed to remove legacy sessions directory",
        );
        expect(result.failures[0]?.message).toMatch(/permission/i);
      } finally {
        await chmod(home.dataRoot, 0o755);
      }
      expect((await stat(sessions)).isDirectory()).toBe(true);
    },
  );

  test("refuses a candidate swapped for a symlink before unlink", async () => {
    const swapped = await writeLegacyFile("history.json.bak", "old");
    const first = await writeLegacyFile("vibe-log.json.bak");
    const target = join(home.home, "swap-target.json");
    await writeFile(target, "precious");

    const result = await purgeLegacyCopies({
      dataRoot: home.dataRoot,
      legacyBackups: legacyFinding([
        legacyRef("vibe-log.json", first),
        legacyRef("history.json", swapped),
      ]),
      unlinkFile: async (candidate) => {
        if (candidate !== swapped) {
          await rm(swapped);
          await symlink(target, swapped);
        }
        await unlink(candidate);
      },
    });

    expect(result.deleted).toBe(1);
    expect(result.failures).toEqual([
      {
        target: "purgeLegacy",
        message: `legacy cleanup refused for ${swapped}: path component is a symlink: ${swapped}`,
      },
    ]);
    expect((await lstat(swapped)).isSymbolicLink()).toBe(true);
    expect(await readFile(target, "utf8")).toBe("precious");
  });

  test("refuses a candidate swapped for a directory before unlink", async () => {
    const swapped = await writeLegacyFile("history.json.bak", "old");
    const first = await writeLegacyFile("vibe-log.json.bak");

    const result = await purgeLegacyCopies({
      dataRoot: home.dataRoot,
      legacyBackups: legacyFinding([
        legacyRef("vibe-log.json", first),
        legacyRef("history.json", swapped),
      ]),
      unlinkFile: async (candidate) => {
        if (candidate !== swapped) {
          await rm(swapped);
          await mkdir(swapped);
        }
        await unlink(candidate);
      },
    });

    expect(result.deleted).toBe(1);
    expect(result.failures).toEqual([
      {
        target: "purgeLegacy",
        message: `legacy cleanup refused for ${swapped}: recorded backup path is not a regular file`,
      },
    ]);
    expect((await stat(swapped)).isDirectory()).toBe(true);
  });

  test("reports unavailable legacy inventory as a zero-count failure", async () => {
    const result = await purgeLegacyCopies({
      dataRoot: home.dataRoot,
      legacyBackups: null,
    });

    expect(result).toEqual({
      deleted: 0,
      failures: [
        {
          target: "purgeLegacy",
          message: "legacy record inventory unavailable",
        },
      ],
    });
  });
});

describe("purgeLegacyCopies storage contract", () => {
  test("deletes recorded copies while preserving rows markers and rewritten originals", async () => {
    await seedDatabase((db) => {
      db.prepare(
        "INSERT INTO sessions (id, cwd_key, created_at, last_accessed_at) VALUES (?, ?, ?, ?)",
      ).run(
        "session-1",
        "abc123",
        "2026-01-01T00:00:00.000Z",
        "2026-01-01T00:00:00.000Z",
      );
      db.prepare(
        "INSERT INTO learning_entries (type, category, observation, solution, timestamp, demo_id) VALUES (?, ?, ?, ?, ?, ?)",
      ).run("mistake", "coding", "kept", null, 1, null);
      db.prepare(
        "INSERT INTO constitution_rules (session_id, rule, position, created_at) VALUES (?, ?, ?, ?)",
      ).run("session-1", "rule", 0, "2026-01-01T00:00:00.000Z");
      db.prepare(
        "INSERT INTO interactions (session_id, goal, output, timestamp) VALUES (?, ?, ?, ?)",
      ).run("session-1", "goal", "output", 1);
    });
    seedLegacyRecord("vibe-log.json", "vibe-log.json.bak");
    seedLegacyRecord("sessions/abc123.json", "sessions/abc123.json.bak");
    const rewritten = JSON.stringify({
      fresh: "data absent from sqlite",
    });
    await writeLegacyFile("vibe-log.json", rewritten);
    await writeLegacyFile("vibe-log.json.bak", "old copy");
    await writeLegacyFile(join("sessions", "abc123.json.bak"), "old session");

    const before = await captureState();
    const diagnostics = await collectDoctorDiagnostics({ retention: 5 });
    const result = await purgeLegacyCopies({
      dataRoot: diagnostics.dataRoot,
      legacyBackups: diagnostics.findings.legacyBackups,
    });

    expect(result).toEqual({ deleted: 2, failures: [] });
    const after = await captureState();
    expect(after.rows).toEqual(before.rows);
    expect(after.original).toBe(rewritten);
    expect(after.legacyCopy).toBeNull();
    expect(after.sessionEntries).toEqual([]);
    expect(after.rootEntries).not.toContain("sessions");
  });

  test("reopening storage honors retained markers without duplicating rewritten originals", async () => {
    await seedDatabase((db) => {
      db.prepare(
        "INSERT INTO learning_entries (type, category, observation, solution, timestamp, demo_id) VALUES (?, ?, ?, ?, ?, ?)",
      ).run("mistake", "coding", "kept", null, 1, null);
    });
    seedLegacyRecord("vibe-log.json", "vibe-log.json.bak");
    const rewritten = JSON.stringify({
      mistakes: {
        coding: { examples: [{ mistake: "fresh", timestamp: 2 }] },
      },
    });
    const original = await writeLegacyFile("vibe-log.json", rewritten);
    await writeLegacyFile("vibe-log.json.bak", "old copy");

    const diagnostics = await collectDoctorDiagnostics({ retention: 5 });
    await purgeLegacyCopies({
      dataRoot: diagnostics.dataRoot,
      legacyBackups: diagnostics.findings.legacyBackups,
    });

    const handle = openVibeDatabase();
    try {
      expect(
        handle.db
          .query(
            "SELECT id, category, observation FROM learning_entries ORDER BY id",
          )
          .all(),
      ).toEqual([{ id: 1, category: "coding", observation: "kept" }]);
      expect(
        handle.db.query("SELECT * FROM legacy_imports ORDER BY artifact").all(),
      ).toEqual([
        {
          artifact: "vibe-log.json",
          imported_at: "2026-01-01T00:00:00.000Z",
          backup_path: "vibe-log.json.bak",
        },
      ]);
    } finally {
      handle.close();
    }
    expect(await readFile(original, "utf8")).toBe(rewritten);
  });
});

// ── runVacuum ─────────────────────────────────────────────────────────────

async function seedFreePages(): Promise<void> {
  await seedDatabase((db) => {
    const insert = db.prepare(
      "INSERT INTO learning_entries (type, category, observation, timestamp, demo_id) VALUES (?, ?, ?, ?, ?)",
    );
    db.transaction(() => {
      for (let index = 0; index < 100; index += 1) {
        insert.run("mistake", "vacuum", "x".repeat(800), index, null);
      }
    })();
    db.run("DELETE FROM learning_entries WHERE id > 50");
  });
}

function readLearningIds(): number[] {
  const external = new Database(databasePath(), {
    readonly: true,
    create: false,
  });
  try {
    return external
      .query("SELECT id FROM learning_entries ORDER BY id")
      .all()
      .map((row) => (row as { id: number }).id);
  } finally {
    external.close();
  }
}

describe("runVacuum", () => {
  test("reclaims free pages and preserves rows through a fresh write connection", async () => {
    await seedFreePages();
    const preserved = readLearningIds();
    const freePages = readFreelistCount();
    expect(freePages).toBeGreaterThan(0);

    const reclaimed = await runVacuum(databasePath());

    expect(reclaimed).toBe(freePages);
    expect(readFreelistCount()).toBe(0);
    expect(readLearningIds()).toEqual(preserved);
  });

  test("fails fast with a busy error while an external write lock is held", async () => {
    await seedDatabase();
    const locker = new Database(databasePath());
    try {
      locker.run("BEGIN IMMEDIATE");

      await expect(runVacuum(databasePath())).rejects.toThrow(/locked|busy/i);
    } finally {
      locker.run("ROLLBACK");
      locker.close();
    }
    expect(readFreelistCount()).toBe(0);
  });

  test("rejects a disappeared database without recreating it", async () => {
    await mkdir(home.dataRoot, { recursive: true });
    const missing = join(home.dataRoot, "absent.db");

    await expect(runVacuum(missing)).rejects.toThrow(/unable to open/);

    expect(await readdir(home.dataRoot)).not.toContain("absent.db");
  });
});
