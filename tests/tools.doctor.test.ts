import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import {
  link,
  mkdir,
  readdir,
  rmdir,
  unlink,
  writeFile,
} from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import {
  DOCTOR_TARGET_ORDER,
  type DoctorApplyTarget,
  type DoctorInput,
  type DoctorSuccessPayload,
  doctorResultIndicatesFailure,
  resolveDoctorKeepBackups,
  runDoctor,
} from "../src/tools/doctor.js";
import type {
  RmdirOperation,
  UnlinkOperation,
} from "../src/utils/doctorMaintenance.js";
import type {
  DoctorExecutor,
  DoctorSection,
  DoctorSqlDiagnostics,
} from "../src/utils/doctorSql.js";
import type { DoctorFindings } from "../src/utils/doctorStorage.js";
import { makeErrno } from "../src/utils/errors.js";
import { createDoctorFixtures } from "./helpers/doctorFixtures.js";
import { requireBackupPath } from "./helpers/requireBackupPath.js";
import { createTempHome, type TempHomeContext } from "./helpers/tempHome.js";

const FIXED_TIMESTAMP = new Date("2026-01-02T03:04:05.678Z");
const NO_APPLIED = { vacuum: 0, purgeBackups: 0, purgeLegacy: 0 };
const FAKE_RECLAIMED_PAGES = 3;

let home: TempHomeContext;

beforeEach(async () => {
  home = await createTempHome();
});

afterEach(async () => {
  await home.cleanup();
});

// ── Fixtures ──────────────────────────────────────────────────────────────

const { databasePath, seedDatabase, seedLegacyRecord, readFreelistCount } =
  createDoctorFixtures(() => home.dataRoot);

/** Write `count` managed backups, oldest first, with distinct timestamps. */
async function seedManagedBackups(count: number): Promise<string[]> {
  const backupsDir = join(home.dataRoot, "backups");
  await mkdir(backupsDir, { recursive: true });
  const files: string[] = [];
  for (let day = 1; day <= count; day += 1) {
    const label = `2025-01-${String(day).padStart(2, "0")}T00-00-00-000Z`;
    const filePath = join(backupsDir, `vibe-prune-${label}.db`);
    await writeFile(filePath, "backup");
    files.push(filePath);
  }
  return files;
}

function readTable(table: string, path = databasePath()): unknown[] {
  const db = new Database(path, { readonly: true, create: false });
  try {
    return db.query(`SELECT * FROM ${table} ORDER BY rowid`).all();
  } finally {
    db.close();
  }
}

// ── Executor and filesystem fakes ─────────────────────────────────────────

function sectionOk<T>(value: T): DoctorSection<T> {
  return { ok: true, value };
}

function sectionFail<T>(error: string): DoctorSection<T> {
  return { ok: false, error };
}

function tick(): Promise<void> {
  return new Promise((resolveTick) => setImmediate(resolveTick));
}

interface FakeExecutor extends DoctorExecutor {
  backupCalls: string[];
  vacuumCalls: string[];
  backupResult: string;
  backupError?: Error;
  vacuumError?: Error;
}

/**
 * Record `begin:`/`end:` events around each dispatch so tests can prove
 * every operation completed before the next began.
 */
function createFakeExecutor(
  events: string[],
  sections: Partial<DoctorSqlDiagnostics> = {},
): FakeExecutor {
  const record = async <T>(
    name: string,
    run: () => T | Promise<T>,
  ): Promise<T> => {
    events.push(`begin:${name}`);
    await tick();
    const result = await run();
    events.push(`end:${name}`);
    return result;
  };
  const fake: FakeExecutor = {
    backupCalls: [],
    vacuumCalls: [],
    backupResult: join(home.dataRoot, "backups", "vibe-doctor-fake.db"),
    diagnose: () =>
      record("diagnose", () => ({
        integrityCheck: sectionOk(["ok"]),
        foreignKeyCheck: sectionOk([]),
        freelistCount: sectionOk(0),
        legacyRecords: sectionOk([]),
        ...sections,
      })),
    backup: (databasePath) =>
      record("backup", async () => {
        fake.backupCalls.push(databasePath);
        if (fake.backupError) throw fake.backupError;
        return fake.backupResult;
      }),
    vacuum: (databasePath) =>
      record("vacuum", () => {
        fake.vacuumCalls.push(databasePath);
        if (fake.vacuumError) throw fake.vacuumError;
        return FAKE_RECLAIMED_PAGES;
      }),
  };
  return fake;
}

function recordingUnlink(
  events: string[],
  failFor: (target: string) => boolean = () => false,
): UnlinkOperation {
  return async (target) => {
    events.push(`begin:unlink:${basename(target)}`);
    await tick();
    events.push(`end:unlink:${basename(target)}`);
    if (failFor(target)) throw makeErrno("EACCES", `denied: ${target}`);
    await unlink(target);
  };
}

function recordingRmdir(events: string[]): RmdirOperation {
  return async (target) => {
    events.push(`begin:rmdir:${basename(target)}`);
    await tick();
    events.push(`end:rmdir:${basename(target)}`);
    await rmdir(target);
  };
}

function beginEvents(events: string[]): string[] {
  return events
    .filter((event) => event.startsWith("begin:"))
    .map((event) => event.slice("begin:".length));
}

/** Assert every dispatched operation awaited completion before the next began. */
function expectSequentialDispatch(events: string[]): void {
  for (let index = 0; index < events.length; index += 2) {
    const begin = events[index] ?? "";
    expect(begin.startsWith("begin:")).toBe(true);
    expect(events[index + 1]).toBe(`end:${begin.slice("begin:".length)}`);
  }
}

// ── resolveDoctorKeepBackups ──────────────────────────────────────────────

describe("resolveDoctorKeepBackups", () => {
  test("defaults an omitted retention value to five backups", () => {
    expect(resolveDoctorKeepBackups(undefined)).toBe(5);
  });

  test.each(["1", "2", "9007199254740991"])(
    "accepts the positive safely representable integer %s",
    (value) => {
      expect(resolveDoctorKeepBackups(value)).toBe(Number(value));
    },
  );

  test.each([
    "",
    "0",
    "-3",
    "2.5",
    "abc",
    "9007199254740992",
    "99999999999999999999",
    "5junk",
    "1e3",
    " 5",
  ])("rejects %p with a --keep-backups error", (value) => {
    expect(() => resolveDoctorKeepBackups(value)).toThrow(/--keep-backups/);
  });
});

// ── runDoctor: retention ──────────────────────────────────────────────────

describe("runDoctor — retention", () => {
  test.each([
    { keepBackups: undefined, excess: 2 },
    { keepBackups: "1", excess: 6 },
    { keepBackups: "6", excess: 1 },
    { keepBackups: "9007199254740991", excess: 0 },
  ])(
    "reports $excess excess backups for retention $keepBackups",
    async ({ keepBackups, excess }) => {
      await seedDatabase();
      await seedManagedBackups(7);

      const payload = await runDoctor(
        { ...(keepBackups !== undefined && { keepBackups }) },
        { executor: createFakeExecutor([]) },
      );

      expect(payload.findings.excessBackups).toBe(excess);
    },
  );

  test("counts the pending safety backup when backups are selected for purge", async () => {
    await seedDatabase();
    await seedManagedBackups(7);

    const payload = await runDoctor(
      { purgeBackups: true, keepBackups: "6" },
      { executor: createFakeExecutor([]) },
    );

    expect(payload.dryRun).toBe(true);
    expect(payload.findings.excessBackups).toBe(2);
  });

  test("counts the pending safety backup under bare confirmation but not bare reports", async () => {
    await seedDatabase();
    await seedManagedBackups(6);

    const bareReport = await runDoctor(
      {},
      { executor: createFakeExecutor([]) },
    );
    const bareApply = await runDoctor(
      { yes: true },
      { executor: createFakeExecutor([]) },
    );

    expect(bareReport.findings.excessBackups).toBe(1);
    expect(bareApply.findings.excessBackups).toBe(2);
  });

  test("predicts appliedCounts.purgeBackups with excessBackups under bare confirmation", async () => {
    await seedDatabase();
    await seedManagedBackups(7);

    const payload = await runDoctor(
      { yes: true },
      { timestamp: FIXED_TIMESTAMP },
    );

    expect(payload.findings.excessBackups).toBe(3);
    expect(payload.appliedCounts.purgeBackups).toBe(3);
  });

  test("rejects invalid retention before touching storage", async () => {
    const events: string[] = [];

    await expect(
      runDoctor({ keepBackups: "0" }, { executor: createFakeExecutor(events) }),
    ).rejects.toThrow(/--keep-backups/);

    expect(events).toEqual([]);
    expect(existsSync(home.dataRoot)).toBe(false);
  });
});

// ── runDoctor: target selection and confirmation gating ───────────────────

describe("runDoctor — target selection and confirmation gating", () => {
  const MATRIX = [0, 1, 2, 3, 4, 5, 6, 7].flatMap((mask) => {
    const selected = DOCTOR_TARGET_ORDER.filter(
      (_, bit) => (mask & (1 << bit)) !== 0,
    );
    const targets = Object.fromEntries(
      selected.map((target) => [target, true]),
    ) as DoctorInput;
    return [false, true].map((yes) => ({
      label: `${selected.join("+") || "no targets"} ${yes ? "with" : "without"} confirmation`,
      input: { ...targets, ...(yes && { yes }) },
      selected: selected as DoctorApplyTarget[],
    }));
  });

  test.each(MATRIX)(
    "$label reports findings and applies only confirmed targets",
    async ({ input, selected }) => {
      await seedDatabase();
      const events: string[] = [];
      const fake = createFakeExecutor(events);
      const applied = input.yes === true;
      const expectedTargets =
        selected.length > 0 || !applied ? selected : [...DOCTOR_TARGET_ORDER];

      const payload = await runDoctor(input, {
        executor: fake,
        timestamp: FIXED_TIMESTAMP,
      });

      expect(payload.dryRun).toBe(!applied);
      expect(payload.targets).toEqual(expectedTargets);
      expect(payload.skippedTargets).toEqual(
        DOCTOR_TARGET_ORDER.filter(
          (target) => !expectedTargets.includes(target),
        ),
      );
      expect(payload.backupPath).toBe(applied ? fake.backupResult : null);
      expect(payload.appliedCounts).toEqual(NO_APPLIED);
      expect(payload.failedTargets).toEqual([]);
      expect(beginEvents(events)).toEqual(
        applied ? ["diagnose", "backup"] : ["diagnose"],
      );
      expectSequentialDispatch(events);
    },
  );
});

// ── runDoctor: dispatch ordering and lifecycle ────────────────────────────

describe("runDoctor — dispatch ordering and lifecycle", () => {
  test("dispatches diagnostics, one backup, then ordered targets with awaited cleanup", async () => {
    await seedDatabase();
    const [excess, retained] = await seedManagedBackups(2);
    seedLegacyRecord("vibe-log.json", "vibe-log.json.bak");
    await writeFile(join(home.dataRoot, "vibe-log.json.bak"), "old copy");
    await mkdir(join(home.dataRoot, "sessions"));
    const events: string[] = [];
    const fake = createFakeExecutor(events, {
      freelistCount: sectionOk(3),
      legacyRecords: sectionOk([
        { artifact: "vibe-log.json", backupPath: "vibe-log.json.bak" },
      ]),
    });

    const payload = await runDoctor(
      {
        vacuum: true,
        purgeBackups: true,
        purgeLegacy: true,
        keepBackups: "1",
        yes: true,
      },
      {
        executor: fake,
        timestamp: FIXED_TIMESTAMP,
        unlinkFile: recordingUnlink(events),
        removeDirectory: recordingRmdir(events),
      },
    );

    expect(beginEvents(events)).toEqual([
      "diagnose",
      "backup",
      "vacuum",
      `unlink:${basename(excess ?? "")}`,
      "unlink:vibe-log.json.bak",
      "rmdir:sessions",
    ]);
    expectSequentialDispatch(events);
    expect(payload.appliedCounts).toEqual({
      vacuum: FAKE_RECLAIMED_PAGES,
      purgeBackups: 1,
      purgeLegacy: 1,
    });
    expect(payload.failedTargets).toEqual([]);
    expect(fake.backupCalls).toHaveLength(1);
    expect(fake.vacuumCalls).toEqual([resolve(databasePath())]);
    expect(existsSync(retained ?? "")).toBe(true);
  });

  test("dispatches no deletions for report-only runs", async () => {
    await seedDatabase();
    const [excess] = await seedManagedBackups(2);
    const events: string[] = [];

    await runDoctor(
      { purgeBackups: true, keepBackups: "1" },
      {
        executor: createFakeExecutor(events),
        unlinkFile: recordingUnlink(events),
      },
    );

    expect(beginEvents(events)).toEqual(["diagnose"]);
    expect(existsSync(excess ?? "")).toBe(true);
  });
});

// ── runDoctor: preflight gate ─────────────────────────────────────────────

describe("runDoctor — preflight gate", () => {
  const DEFECTS: Array<{
    defect: string;
    sections: Partial<DoctorSqlDiagnostics>;
    message: string;
  }> = [
    {
      defect: "an integrity failure",
      sections: { integrityCheck: sectionOk(["page 3 is malformed"]) },
      message: "integrity check failed: page 3 is malformed",
    },
    {
      defect: "a foreign-key violation",
      sections: {
        foreignKeyCheck: sectionOk([{ table: "constitution_rules", rowid: 7 }]),
      },
      message: "foreign-key violation: constitution_rules rowid 7",
    },
    {
      defect: "unavailable diagnostics",
      sections: { freelistCount: sectionFail("freelist unavailable") },
      message: "freelist unavailable",
    },
  ];
  const CASES = DEFECTS.flatMap((defect) =>
    [false, true].map((yes) => ({
      ...defect,
      mode: yes ? "apply" : "report",
      yes,
    })),
  );

  test.each(CASES)(
    "blocks every target and backup on $defect in $mode mode",
    async ({ sections, message, yes }) => {
      await seedDatabase();
      const events: string[] = [];

      const payload = await runDoctor(
        { vacuum: true, purgeBackups: true, purgeLegacy: true, yes },
        { executor: createFakeExecutor(events, sections) },
      );

      expect(payload.failedTargets).toEqual([{ target: "preflight", message }]);
      expect(payload.backupPath).toBeNull();
      expect(payload.appliedCounts).toEqual(NO_APPLIED);
      expect(beginEvents(events)).toEqual(["diagnose"]);
      expect(doctorResultIndicatesFailure(payload)).toBe(true);
    },
  );

  test("folds duplicate unavailable-diagnostic messages into one failure entry", async () => {
    await seedDatabase();

    const payload = await runDoctor(
      { purgeLegacy: true, yes: true },
      {
        executor: createFakeExecutor([], {
          legacyRecords: sectionFail("legacy read failed"),
        }),
      },
    );

    expect(payload.findings.legacyBackups).toBeNull();
    expect(payload.findings.strandedOriginals).toBeNull();
    expect(payload.failedTargets).toEqual([
      { target: "preflight", message: "legacy read failed" },
    ]);
  });

  test("blocks every target and backup when the managed backup inventory fails", async () => {
    await seedDatabase();
    await writeFile(join(home.dataRoot, "backups"), "not a directory");

    const payload = await runDoctor(
      { purgeBackups: true, yes: true },
      { timestamp: FIXED_TIMESTAMP },
    );

    expect(payload.findings.excessBackups).toBeNull();
    expect(payload.failedTargets).toEqual([
      {
        target: "preflight",
        message: expect.stringMatching(/managed backup inventory unavailable/),
      },
    ]);
    expect(payload.backupPath).toBeNull();
  });
});

// ── runDoctor: safety backup and target execution ─────────────────────────

describe("runDoctor — safety backup and target execution", () => {
  test("creates one fixed-name safety backup before targets without candidates", async () => {
    await seedDatabase();

    const payload = await runDoctor(
      { vacuum: true, purgeBackups: true, purgeLegacy: true, yes: true },
      { timestamp: FIXED_TIMESTAMP },
    );

    expect(requireBackupPath(payload)).toBe(
      join(home.dataRoot, "backups", "vibe-doctor-2026-01-02T03-04-05-678Z.db"),
    );
    expect(payload.failedTargets).toEqual([]);
    expect(payload.appliedCounts).toEqual(NO_APPLIED);
  });

  test("returns null backupPath and a backup failure without executing targets", async () => {
    await seedDatabase();
    const events: string[] = [];
    const fake = createFakeExecutor(events);
    fake.backupError = new Error("snapshot failed");

    const payload = await runDoctor(
      { vacuum: true, purgeBackups: true, purgeLegacy: true, yes: true },
      { executor: fake },
    );

    expect(payload.backupPath).toBeNull();
    expect(payload.appliedCounts).toEqual(NO_APPLIED);
    expect(payload.failedTargets).toEqual([
      { target: "backup", message: "snapshot failed" },
    ]);
    expect(beginEvents(events)).toEqual(["diagnose", "backup"]);
  });

  test("defers vacuum, purgeBackups, and purgeLegacy until backup publication succeeds", async () => {
    await seedDatabase((db) => {
      const insert = db.prepare(
        "INSERT INTO learning_entries (type, category, observation, timestamp) VALUES (?, ?, ?, ?)",
      );
      for (let index = 0; index < 50; index += 1) {
        insert.run("mistake", "vacuum", "x".repeat(800), index);
      }
      db.exec("DELETE FROM learning_entries WHERE id > 25");
    });
    const managedBackups = await seedManagedBackups(3);
    seedLegacyRecord("vibe-log.json", "vibe-log.json.bak");
    const legacyCopyPath = join(home.dataRoot, "vibe-log.json.bak");
    await writeFile(legacyCopyPath, "old copy");
    const freePages = readFreelistCount();
    expect(freePages).toBeGreaterThan(0);

    const events: string[] = [];
    let signalPublicationStarted!: () => void;
    const publicationStarted = new Promise<void>((resolveStarted) => {
      signalPublicationStarted = resolveStarted;
    });
    let releasePublication!: () => void;
    const publicationReleased = new Promise<void>((resolveRelease) => {
      releasePublication = resolveRelease;
    });
    const expectedBackupPath = join(
      home.dataRoot,
      "backups",
      `vibe-doctor-${FIXED_TIMESTAMP.toISOString().replace(/[.:]/g, "-")}.db`,
    );

    const doctorPromise = runDoctor(
      {
        vacuum: true,
        purgeBackups: true,
        purgeLegacy: true,
        keepBackups: "1",
        yes: true,
      },
      {
        timestamp: FIXED_TIMESTAMP,
        unlinkFile: recordingUnlink(events),
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
      expect(events).toEqual([]);
      expect(readFreelistCount()).toBe(freePages);
      for (const backupPath of managedBackups) {
        expect(existsSync(backupPath)).toBe(true);
      }
      expect(existsSync(legacyCopyPath)).toBe(true);
    } finally {
      releasePublication();
    }

    const payload = await doctorPromise;
    expect(payload.backupPath).toBe(expectedBackupPath);
    expect(payload.failedTargets).toEqual([]);
    expect(payload.appliedCounts).toEqual({
      vacuum: freePages,
      purgeBackups: 3,
      purgeLegacy: 1,
    });

    // Every selected target applied after publication.
    expect(existsSync(expectedBackupPath)).toBe(true);
    expect(readFreelistCount()).toBe(0);
    for (const backupPath of managedBackups) {
      expect(existsSync(backupPath)).toBe(false);
    }
    expect(existsSync(legacyCopyPath)).toBe(false);
    expect(beginEvents(events)).toEqual([
      ...managedBackups.map((file) => `unlink:${basename(file)}`),
      "unlink:vibe-log.json.bak",
    ]);
    expectSequentialDispatch(events);
  });

  test("returns backupPath null and zero applied targets on injected snapshot failure", async () => {
    await seedDatabase((db) => {
      db.prepare(
        "INSERT INTO learning_entries (type, category, observation, timestamp) VALUES (?, ?, ?, ?)",
      ).run("mistake", "cat", "data", 100);
    });
    const rowsBefore = readTable("learning_entries");

    const payload = await runDoctor(
      { vacuum: true, purgeBackups: true, yes: true },
      {
        timestamp: FIXED_TIMESTAMP,
        backupOptions: {
          snapshotExecutor: async () => {
            throw new Error("injected snapshot failure");
          },
        },
      },
    );

    expect(payload.backupPath).toBeNull();
    expect(payload.appliedCounts).toEqual(NO_APPLIED);
    expect(payload.failedTargets).toEqual([
      { target: "backup", message: "injected snapshot failure" },
    ]);
    expect(readTable("learning_entries")).toEqual(rowsBefore);
  });

  test("returns backupPath null and cleans staging on injected publication failure", async () => {
    await seedDatabase();

    const payload = await runDoctor(
      { vacuum: true, yes: true },
      {
        timestamp: FIXED_TIMESTAMP,
        backupOptions: {
          linkExclusive: async () => {
            throw new Error("injected publication link failure");
          },
        },
      },
    );

    expect(payload.backupPath).toBeNull();
    expect(payload.appliedCounts).toEqual(NO_APPLIED);
    expect(payload.failedTargets).toEqual([
      { target: "backup", message: "injected publication link failure" },
    ]);
    const backupsDir = join(home.dataRoot, "backups");
    if (existsSync(backupsDir)) {
      const entries = await readdir(backupsDir);
      expect(entries.filter((name) => name.startsWith(".staging-"))).toEqual(
        [],
      );
    }
  });

  test("returns backupPath null with diagnostics on injected pre-link cleanup failure", async () => {
    await seedDatabase();

    const payload = await runDoctor(
      { vacuum: true, yes: true },
      {
        timestamp: FIXED_TIMESTAMP,
        backupOptions: {
          snapshotExecutor: async (_s, dest) => {
            await writeFile(dest, "partial snapshot");
            throw new Error("primary snapshot error");
          },
          cleanupStaging: async () => {
            throw new Error("secondary cleanup error");
          },
        },
      },
    );

    expect(payload.backupPath).toBeNull();
    expect(payload.appliedCounts).toEqual(NO_APPLIED);
    expect(payload.failedTargets).toHaveLength(1);
    expect(payload.failedTargets[0]?.target).toBe("backup");
    expect(payload.failedTargets[0]?.message).toContain(
      "primary snapshot error",
    );
    expect(payload.failedTargets[0]?.message).toContain(
      "secondary cleanup error",
    );
  });

  test("returns backupPath null without executing targets on post-link staging cleanup failure while retaining complete snapshot", async () => {
    await seedDatabase((db) => {
      const insert = db.prepare(
        "INSERT INTO learning_entries (type, category, observation, timestamp) VALUES (?, ?, ?, ?)",
      );
      for (let index = 0; index < 50; index += 1) {
        insert.run("mistake", "vacuum", "x".repeat(800), index);
      }
      db.exec("DELETE FROM learning_entries WHERE id > 25");
    });
    const initialFreelist = readFreelistCount();
    expect(initialFreelist).toBeGreaterThan(0);
    const rowsBefore = readTable("learning_entries");

    const expectedBackupFile = join(
      home.dataRoot,
      "backups",
      `vibe-doctor-${FIXED_TIMESTAMP.toISOString().replace(/[.:]/g, "-")}.db`,
    );

    const payload = await runDoctor(
      { vacuum: true, yes: true },
      {
        timestamp: FIXED_TIMESTAMP,
        backupOptions: {
          cleanupStaging: async () => {
            throw new Error("injected post-link cleanup error");
          },
        },
      },
    );

    expect(payload.backupPath).toBeNull();
    expect(payload.appliedCounts).toEqual(NO_APPLIED);
    expect(payload.failedTargets).toEqual([
      {
        target: "backup",
        message: expect.stringContaining("injected post-link cleanup error"),
      },
    ]);
    expect(readFreelistCount()).toBe(initialFreelist);
    expect(readTable("learning_entries")).toEqual(rowsBefore);

    expect(existsSync(expectedBackupFile)).toBe(true);
    const snapshotDb = new Database(expectedBackupFile, {
      readonly: true,
      create: false,
    });
    try {
      expect(
        snapshotDb.query("SELECT * FROM learning_entries ORDER BY rowid").all(),
      ).toEqual(rowsBefore);
      const integrity = snapshotDb
        .query<{ integrity_check: string }, []>("PRAGMA integrity_check")
        .get();
      expect(integrity?.integrity_check).toBe("ok");
    } finally {
      snapshotDb.close();
    }
  });

  test("purges older backups and verifies complete logical content of independently opened pinned replacement", async () => {
    await seedDatabase((db) => {
      db.prepare(
        "INSERT INTO sessions (id, cwd_key, created_at, last_accessed_at) VALUES (?, ?, ?, ?)",
      ).run(
        "session-1",
        "cwd-1",
        "2026-01-01T00:00:00.000Z",
        "2026-01-01T00:00:00.000Z",
      );
      db.prepare(
        "INSERT INTO constitution_rules (session_id, rule, position, created_at) VALUES (?, ?, ?, ?)",
      ).run(
        "session-1",
        "always backup before destroy",
        1,
        "2026-01-01T00:00:00.000Z",
      );
      db.prepare(
        "INSERT INTO interactions (session_id, goal, output, timestamp) VALUES (?, ?, ?, ?)",
      ).run("session-1", "hello", "hi", 1234567890);
      db.prepare(
        "INSERT INTO learning_entries (type, category, observation, timestamp) VALUES (?, ?, ?, ?)",
      ).run("mistake", "testing", "careful observation", 1234567890);
      db.prepare(
        "INSERT INTO legacy_imports (artifact, imported_at, backup_path) VALUES (?, ?, ?)",
      ).run(
        "old.json",
        "2026-01-01T00:00:00.000Z",
        join(home.dataRoot, "old.json.bak"),
      );
    });

    await seedManagedBackups(5);

    const payload = await runDoctor(
      { purgeBackups: true, keepBackups: "2", yes: true },
      { timestamp: FIXED_TIMESTAMP },
    );

    expect(payload.failedTargets).toEqual([]);
    expect(payload.appliedCounts.purgeBackups).toBe(4);
    const pinnedPath = requireBackupPath(payload);
    expect(existsSync(pinnedPath)).toBe(true);

    const pinnedDb = new Database(pinnedPath, {
      readonly: true,
      create: false,
    });
    try {
      expect(pinnedDb.query("SELECT id, cwd_key FROM sessions").all()).toEqual([
        { id: "session-1", cwd_key: "cwd-1" },
      ]);
      expect(
        pinnedDb.query("SELECT session_id, rule FROM constitution_rules").all(),
      ).toEqual([
        { session_id: "session-1", rule: "always backup before destroy" },
      ]);
      expect(
        pinnedDb
          .query("SELECT session_id, goal, output FROM interactions")
          .all(),
      ).toEqual([{ session_id: "session-1", goal: "hello", output: "hi" }]);
      expect(
        pinnedDb
          .query(
            "SELECT type, category, observation, timestamp FROM learning_entries",
          )
          .all(),
      ).toEqual([
        {
          type: "mistake",
          category: "testing",
          observation: "careful observation",
          timestamp: 1234567890,
        },
      ]);
      expect(
        pinnedDb.query("SELECT artifact FROM legacy_imports").all(),
      ).toEqual([{ artifact: "old.json" }]);
      const fk = pinnedDb.query("PRAGMA foreign_key_check").all();
      expect(fk).toEqual([]);
      const integrity = pinnedDb
        .query<{ integrity_check: string }, []>("PRAGMA integrity_check")
        .get();
      expect(integrity?.integrity_check).toBe("ok");
    } finally {
      pinnedDb.close();
    }
  });

  test("vacuums free pages once while the backup and database keep every row", async () => {
    await seedDatabase((db) => {
      const insert = db.prepare(
        "INSERT INTO learning_entries (type, category, observation, timestamp) VALUES (?, ?, ?, ?)",
      );
      for (let index = 0; index < 100; index += 1) {
        insert.run("mistake", "vacuum", "x".repeat(800), index);
      }
      db.exec("DELETE FROM learning_entries WHERE id > 50");
    });
    seedLegacyRecord("vibe-log.json", "vibe-log.json.bak");
    const learning = readTable("learning_entries");
    const markers = readTable("legacy_imports");
    const freePages = readFreelistCount();
    expect(freePages).toBeGreaterThan(0);

    const payload = await runDoctor(
      { vacuum: true, yes: true },
      { timestamp: FIXED_TIMESTAMP },
    );

    expect(payload.appliedCounts).toEqual({ ...NO_APPLIED, vacuum: freePages });
    expect(payload.failedTargets).toEqual([]);
    expect(readFreelistCount()).toBe(0);
    expect(readTable("learning_entries")).toEqual(learning);
    const backupPath = requireBackupPath(payload);
    expect(readTable("learning_entries", backupPath)).toEqual(learning);
    expect(readTable("legacy_imports", backupPath)).toEqual(markers);
  });

  test("skips vacuum at zero freelist without failure", async () => {
    await seedDatabase();

    const payload = await runDoctor(
      { vacuum: true, yes: true },
      { timestamp: FIXED_TIMESTAMP },
    );

    expect(payload.appliedCounts).toEqual(NO_APPLIED);
    expect(payload.failedTargets).toEqual([]);
    requireBackupPath(payload);
  });

  test("reports a busy vacuum failure and continues selected purges", async () => {
    await seedDatabase();
    const backups = await seedManagedBackups(3);
    const events: string[] = [];
    const fake = createFakeExecutor(events, { freelistCount: sectionOk(2) });
    fake.vacuumError = new Error("database is locked (SQLITE_BUSY)");

    const payload = await runDoctor(
      { vacuum: true, purgeBackups: true, keepBackups: "1", yes: true },
      {
        executor: fake,
        timestamp: FIXED_TIMESTAMP,
        unlinkFile: recordingUnlink(events),
      },
    );

    expect(payload.failedTargets).toEqual([
      { target: "vacuum", message: "database is locked (SQLITE_BUSY)" },
    ]);
    expect(payload.appliedCounts).toEqual({ ...NO_APPLIED, purgeBackups: 2 });
    expect(beginEvents(events)).toEqual([
      "diagnose",
      "backup",
      "vacuum",
      ...backups.slice(0, 2).map((file) => `unlink:${basename(file)}`),
    ]);
  });

  test("retains completed purge counts and continues later targets after an unlink failure", async () => {
    await seedDatabase();
    const [failing, deleted] = await seedManagedBackups(3);
    seedLegacyRecord("vibe-log.json", "vibe-log.json.bak");
    await writeFile(join(home.dataRoot, "vibe-log.json.bak"), "old copy");
    const events: string[] = [];

    const payload = await runDoctor(
      { purgeBackups: true, purgeLegacy: true, keepBackups: "1", yes: true },
      {
        executor: createFakeExecutor(events, {
          legacyRecords: sectionOk([
            { artifact: "vibe-log.json", backupPath: "vibe-log.json.bak" },
          ]),
        }),
        timestamp: FIXED_TIMESTAMP,
        unlinkFile: recordingUnlink(events, (target) => target === failing),
      },
    );

    expect(payload.appliedCounts).toEqual({
      ...NO_APPLIED,
      purgeBackups: 1,
      purgeLegacy: 1,
    });
    expect(payload.failedTargets).toEqual([
      { target: "purgeBackups", message: expect.stringMatching(/denied/) },
    ]);
    expect(existsSync(failing ?? "")).toBe(true);
    expect(existsSync(deleted ?? "")).toBe(false);
    expect(existsSync(join(home.dataRoot, "vibe-log.json.bak"))).toBe(false);
  });
});

// ── doctorResultIndicatesFailure ──────────────────────────────────────────

describe("doctorResultIndicatesFailure", () => {
  function healthyPayload(
    overrides: Partial<DoctorSuccessPayload> = {},
  ): DoctorSuccessPayload {
    return {
      dryRun: true,
      targets: [],
      findings: {
        integrityCheck: { rows: ["ok"], ok: true },
        foreignKeyCheck: [],
        freelistCount: 0,
        excessBackups: 0,
        latestBackupPath: null,
        legacyBackups: { candidates: [], rejected: [] },
        strandedOriginals: [],
      },
      backupPath: null,
      appliedCounts: NO_APPLIED,
      skippedTargets: [...DOCTOR_TARGET_ORDER],
      failedTargets: [],
      ...overrides,
    };
  }

  test("returns false for a healthy completed payload", () => {
    expect(doctorResultIndicatesFailure(healthyPayload())).toBe(false);
  });

  test("returns true when any recorded target failed", () => {
    const payload = healthyPayload({
      failedTargets: [{ target: "backup", message: "snapshot failed" }],
    });

    expect(doctorResultIndicatesFailure(payload)).toBe(true);
  });

  test.each<{ label: string; override: Partial<DoctorFindings> }>([
    { label: "missing integrity evidence", override: { integrityCheck: null } },
    {
      label: "failing integrity evidence",
      override: { integrityCheck: { rows: ["bad"], ok: false } },
    },
    {
      label: "missing foreign-key evidence",
      override: { foreignKeyCheck: null },
    },
    {
      label: "non-empty foreign-key evidence",
      override: { foreignKeyCheck: [{ table: "interactions", rowid: 2 }] },
    },
    {
      label: "unavailable freelist evidence",
      override: { freelistCount: null },
    },
    {
      label: "unavailable backup inventory",
      override: { excessBackups: null },
    },
    {
      label: "unavailable legacy inventory",
      override: { legacyBackups: null },
    },
    {
      label: "unavailable stranded originals",
      override: { strandedOriginals: null },
    },
  ])("returns true when payload carries $label", ({ override }) => {
    const payload = healthyPayload();
    payload.findings = { ...payload.findings, ...override };

    expect(doctorResultIndicatesFailure(payload)).toBe(true);
  });
});
