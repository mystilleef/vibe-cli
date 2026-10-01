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
  mkdir,
  readdir,
  readFile,
  symlink,
  writeFile,
} from "node:fs/promises";
import { basename, join } from "node:path";
import { runCliInProcess } from "../src/cli.js";
import type { DoctorSuccessPayload } from "../src/tools/doctor.js";
import { type ChildProcessResult, runChild } from "./helpers/childProcess.js";
import {
  createDoctorFixtures,
  managedBackupName,
} from "./helpers/doctorFixtures.js";
import { createTempHome, type TempHomeContext } from "./helpers/tempHome.js";

const repoRoot = join(import.meta.dir, "..");
const cliEntry = join(repoRoot, "src", "cli.ts");

const DOCTOR_FLAGS = [
  "--vacuum",
  "--purge-backups",
  "--purge-legacy",
  "--keep-backups",
  "-y, --yes",
  "--json",
] as const;

let home: TempHomeContext;

beforeEach(async () => {
  home = await createTempHome();
});

afterEach(async () => {
  mock.restore();
  await home.cleanup();
});

// ── Runners and parsers ───────────────────────────────────────────────────

function runDoctor(...args: string[]): Promise<ChildProcessResult> {
  return runCliInProcess(["doctor", ...args]);
}

/** Run a real CLI process where pipe delivery matters. */
function runDoctorProcess(
  args: readonly string[],
): Promise<ChildProcessResult> {
  return runChild("bun", ["run", cliEntry, "doctor", ...args], {
    cwd: repoRoot,
    env: { ...process.env, HOME: home.home },
    timeout: 10_000,
  });
}

function parsePayload(result: ChildProcessResult): DoctorSuccessPayload {
  const lines = result.stdout.trim().split("\n");
  expect(lines).toHaveLength(1);
  return JSON.parse(lines[0] ?? "{}") as DoctorSuccessPayload;
}

function parseFatalError(result: ChildProcessResult): string {
  expect(result.exitCode).toBe(1);
  expect(result.stdout).toBe("");
  const parsed = JSON.parse(result.stderr.trim()) as { error: string };
  return parsed.error;
}

// ── Fixtures ──────────────────────────────────────────────────────────────

const {
  databasePath,
  seedDatabase,
  insertLegacyRecord,
  seedForeignKeyViolations,
} = createDoctorFixtures(() => home.dataRoot);

/** Free pages, one session, one recorded legacy copy, seven backups. */
async function seedMaintenanceFixture(): Promise<void> {
  await seedDatabase((db) => {
    db.prepare(
      "INSERT INTO sessions (id, cwd_key, created_at, last_accessed_at) VALUES (?, ?, ?, ?)",
    ).run(
      "session-1",
      "key-1",
      "2026-01-01T00:00:00.000Z",
      "2026-01-01T00:00:00.000Z",
    );
    const insert = db.prepare(
      "INSERT INTO learning_entries (type, category, observation, timestamp) VALUES (?, ?, ?, ?)",
    );
    db.transaction(() => {
      for (let index = 0; index < 100; index += 1) {
        insert.run("mistake", "maintenance", "x".repeat(800), index);
      }
    })();
    db.run("DELETE FROM learning_entries WHERE id > 50");
    insertLegacyRecord(db, "vibe-log.json", "vibe-log.json.bak");
  });
  await writeFile(join(home.dataRoot, "vibe-log.json"), '{"unimported":true}');
  await writeFile(join(home.dataRoot, "vibe-log.json.bak"), "legacy copy");
  await writeFile(join(home.dataRoot, "notes.txt"), "unknown file");
  const backupsDir = join(home.dataRoot, "backups");
  await mkdir(backupsDir);
  for (let day = 1; day <= 7; day += 1) {
    const iso = `2025-01-0${day}T00:00:00.000Z`;
    await writeFile(
      join(backupsDir, managedBackupName("vibe-prune-", iso)),
      "backup",
    );
  }
}

/**
 * One safe recorded legacy copy plus one traversal record that escapes the
 * data root; returns the outside directory holding the escaped target.
 */
async function seedRefusedLegacyFixture(): Promise<string> {
  const outsideDir = join(home.home, "outside");
  await mkdir(outsideDir);
  await writeFile(join(outsideDir, "history.json.bak"), "outside copy");
  await seedDatabase((db) => {
    insertLegacyRecord(db, "vibe-log.json", "vibe-log.json.bak");
    insertLegacyRecord(db, "history.json", "link/../history.json.bak");
  });
  await symlink(outsideDir, join(home.dataRoot, "link"));
  await writeFile(join(home.dataRoot, "vibe-log.json.bak"), "legacy copy");
  await writeFile(join(home.dataRoot, "history.json.bak"), "inside copy");
  return outsideDir;
}

function readRows(path = databasePath()): Record<string, unknown[]> {
  const db = new Database(path, { readonly: true, create: false });
  try {
    return Object.fromEntries(
      [
        "sessions",
        "learning_entries",
        "constitution_rules",
        "interactions",
        "legacy_imports",
      ].map((table) => [
        table,
        db.query(`SELECT * FROM ${table} ORDER BY rowid`).all(),
      ]),
    );
  } finally {
    db.close();
  }
}

async function listBackups(): Promise<string[]> {
  return (await readdir(join(home.dataRoot, "backups"))).sort();
}

// ── CLI surface ───────────────────────────────────────────────────────────

describe("doctor CLI surface", () => {
  test("documents identical flags across help and schema", async () => {
    const help = await runDoctor("--help");
    const schema = JSON.parse((await runCliInProcess(["schema"])).stdout) as {
      commands: { doctor: { opt: Record<string, string> } };
    };

    expect(help.exitCode).toBe(0);
    expect(Object.keys(schema.commands.doctor.opt).sort()).toEqual(
      [...DOCTOR_FLAGS].sort(),
    );
    for (const flag of DOCTOR_FLAGS) {
      expect(help.stdout).toContain(flag);
    }
    expect(help.stdout).not.toContain("--dry-run");
  });

  test("documents bare confirmation fallback in help", async () => {
    const help = await runDoctor("--help");
    const normalizedHelp = help.stdout.replace(/\s+/g, " ");

    expect(help.exitCode).toBe(0);
    expect(normalizedHelp).toContain(
      "Apply selected targets (all without target flags) after one safety backup",
    );
    expect(normalizedHelp).toContain(
      "Maintenance applies only with --yes (bare --yes applies every target)",
    );
  });

  test.each([
    { args: ["--keep-backups"], error: /argument missing/ },
    { args: ["--keep-backups=0"], error: /positive safely representable/ },
    { args: ["--keep-backups=5junk"], error: /positive safely representable/ },
  ])("rejects $args before touching storage", async ({ args, error }) => {
    expect(parseFatalError(await runDoctor(...args))).toMatch(error);
    expect(existsSync(home.dataRoot)).toBe(false);
  });

  test.each([
    { label: "a missing data root", setup: async () => {}, error: /not found/ },
    {
      label: "a missing database",
      setup: () => mkdir(home.dataRoot),
      error: /database not found/,
    },
    {
      label: "a corrupt database",
      setup: async () => {
        await mkdir(home.dataRoot);
        await writeFile(databasePath(), "not a database");
      },
      error: /not a database|unable to open/,
    },
    {
      label: "pending migrations",
      setup: () =>
        seedDatabase((db) =>
          db.run(
            "DELETE FROM schema_migrations WHERE id = '003_rename_mistake_to_observation'",
          ),
        ),
      error:
        /pending migrations: 003_rename_mistake_to_observation; run `vibe migrate`/,
    },
  ])("exits one with fatal JSON for $label", async ({ setup, error }) => {
    await setup();

    expect(parseFatalError(await runDoctor())).toMatch(error);
    expect(existsSync(join(home.dataRoot, "backups"))).toBe(false);
  });
});

// ── Report ────────────────────────────────────────────────────────────────

describe("doctor report", () => {
  test("reports findings without mutating state or touching the network", async () => {
    await seedMaintenanceFixture();
    const rowsBefore = readRows();
    const backupsBefore = await listBackups();
    const fetchSpy = spyOn(globalThis, "fetch");

    const result = await runDoctor("--json");

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    const payload = parsePayload(result);
    expect(payload).toMatchObject({
      dryRun: true,
      targets: [],
      skippedTargets: ["vacuum", "purgeBackups", "purgeLegacy"],
      backupPath: null,
      appliedCounts: { vacuum: 0, purgeBackups: 0, purgeLegacy: 0 },
      failedTargets: [],
    });
    expect(payload.findings).toMatchObject({
      integrityCheck: { rows: ["ok"], ok: true },
      foreignKeyCheck: [],
      excessBackups: 2,
      legacyBackups: { rejected: [] },
    });
    expect(payload.findings.freelistCount).toBeGreaterThan(0);
    expect(basename(payload.findings.latestBackupPath ?? "")).toBe(
      managedBackupName("vibe-prune-", "2025-01-07T00:00:00.000Z"),
    );
    expect(payload.findings.legacyBackups?.candidates).toHaveLength(1);
    expect(payload.findings.strandedOriginals).toHaveLength(1);
    expect(readRows()).toEqual(rowsBefore);
    expect(await listBackups()).toEqual(backupsBefore);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(existsSync(join(home.dataRoot, "settings.json"))).toBe(false);
  });

  test("emits exact minified JSON bytes with trailing newline under --json", async () => {
    await seedMaintenanceFixture();

    const result = await runDoctor("--json");

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(
      `${JSON.stringify(JSON.parse(result.stdout))}\n`,
    );
    const payload = JSON.parse(result.stdout) as DoctorSuccessPayload & {
      findings: Record<string, unknown>;
    };
    expect(Object.keys(payload)).toEqual([
      "dryRun",
      "targets",
      "findings",
      "backupPath",
      "appliedCounts",
      "skippedTargets",
      "failedTargets",
    ]);
    expect(Object.keys(payload.findings)).toEqual([
      "integrityCheck",
      "foreignKeyCheck",
      "freelistCount",
      "excessBackups",
      "latestBackupPath",
      "legacyBackups",
      "strandedOriginals",
    ]);
    expect(result.stdout).toContain('"backupPath":null');
    expect(result.stdout).not.toContain("Doctor:");
    expect(result.stdout).not.toContain("Status: ");
  });

  test("defaults to readable report-only text without flags", async () => {
    await seedMaintenanceFixture();

    const result = await runDoctor();

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(
      result.stdout.startsWith("Doctor: report only (apply with --yes)\n"),
    ).toBe(true);
    expect(result.stdout.trimEnd().endsWith("Status: healthy")).toBe(true);
    expect(result.stdout).toBe(`${result.stdout.trimEnd()}\n`);
    expect(result.stdout).not.toContain('"dryRun"');
    expect(result.stdout).toContain("doctor never deletes originals");
  });

  test("renders unhealthy status with exit one in text mode", async () => {
    await seedMaintenanceFixture();
    seedForeignKeyViolations(2);

    const result = await runDoctor();

    expect(result.exitCode).toBe(1);
    expect(
      result.stdout.startsWith("Doctor: report only (apply with --yes)\n"),
    ).toBe(true);
    expect(result.stdout.trimEnd().endsWith("Status: unhealthy")).toBe(true);
  });

  test("keeps targets without confirmation report-only", async () => {
    await seedMaintenanceFixture();

    const payload = parsePayload(
      await runDoctor(
        "--vacuum",
        "--purge-backups",
        "--purge-legacy",
        "--json",
      ),
    );

    expect(payload.dryRun).toBe(true);
    expect(payload.targets).toEqual(["vacuum", "purgeBackups", "purgeLegacy"]);
    expect(payload.backupPath).toBeNull();
    expect(existsSync(join(home.dataRoot, "vibe-log.json.bak"))).toBe(true);
  });

  test("exits one with findings and no effects on foreign-key violations", async () => {
    await seedMaintenanceFixture();
    seedForeignKeyViolations(2);
    const rowsBefore = readRows();

    for (const args of [
      ["--json"],
      ["--vacuum", "--purge-legacy", "--yes", "--json"],
    ]) {
      const result = await runDoctor(...args);

      expect(result.exitCode).toBe(1);
      const payload = parsePayload(result);
      expect(payload.findings.foreignKeyCheck).toHaveLength(2);
      expect(payload.backupPath).toBeNull();
      expect(payload.failedTargets.map((failure) => failure.target)).toEqual([
        "preflight",
        "preflight",
      ]);
    }
    expect(readRows()).toEqual(rowsBefore);
  });

  test("exposes rejected legacy records in report mode with exit zero", async () => {
    await seedDatabase((db) => {
      insertLegacyRecord(db, "history.json", "sessions/../history.json.bak");
    });
    await writeFile(join(home.dataRoot, "history.json.bak"), "inside copy");

    const result = await runDoctor("--json");

    expect(result.exitCode).toBe(0);
    expect(parsePayload(result).findings.legacyBackups?.rejected).toEqual([
      {
        artifact: "history.json",
        path: "sessions/../history.json.bak",
        message: "recorded backup path contains path traversal",
      },
    ]);
  });
});

// ── Apply ─────────────────────────────────────────────────────────────────

describe("doctor apply", () => {
  test("applies every confirmed target after one safety backup and preserves reachable data", async () => {
    await seedMaintenanceFixture();
    const rowsBefore = readRows();

    const result = await runDoctor(
      "--vacuum",
      "--purge-backups",
      "--purge-legacy",
      "-y",
      "--json",
    );

    expect(result.exitCode).toBe(0);
    const payload = parsePayload(result);
    expect(payload.dryRun).toBe(false);
    expect(payload.appliedCounts).toMatchObject({
      purgeBackups: 3,
      purgeLegacy: 1,
    });
    expect(payload.appliedCounts.vacuum).toBeGreaterThan(0);
    expect(payload.findings.freelistCount).toBe(payload.appliedCounts.vacuum);
    expect(payload.findings.excessBackups).toBe(3);
    expect(payload.failedTargets).toEqual([]);
    const backupPath = payload.backupPath ?? "";
    expect(readRows(backupPath)).toEqual(rowsBefore);
    expect(readRows()).toEqual(rowsBefore);
    const remaining = await listBackups();
    expect(remaining).toHaveLength(5);
    expect(remaining).toContain(basename(backupPath));
    expect(existsSync(join(home.dataRoot, "vibe-log.json.bak"))).toBe(false);
    expect(await readFile(join(home.dataRoot, "vibe-log.json"), "utf8")).toBe(
      '{"unimported":true}',
    );
    expect(await readFile(join(home.dataRoot, "notes.txt"), "utf8")).toBe(
      "unknown file",
    );
  });

  test.each(["-y", "--yes"])(
    "applies every target under bare %s",
    async (alias) => {
      await seedMaintenanceFixture();

      const result = await runDoctor(alias, "--json");

      expect(result.exitCode).toBe(0);
      const payload = parsePayload(result);
      expect(payload.dryRun).toBe(false);
      expect(payload.targets).toEqual([
        "vacuum",
        "purgeBackups",
        "purgeLegacy",
      ]);
      expect(payload.skippedTargets).toEqual([]);
      expect(payload.failedTargets).toEqual([]);
      expect(payload.appliedCounts.vacuum).toBeGreaterThan(0);
      expect(payload.appliedCounts.purgeBackups).toBe(3);
      expect(payload.appliedCounts.purgeLegacy).toBe(1);
    },
  );

  test("applies the supplied --keep-backups retention", async () => {
    await seedMaintenanceFixture();

    const payload = parsePayload(
      await runDoctor(
        "--purge-backups",
        "--keep-backups",
        "6",
        "--yes",
        "--json",
      ),
    );

    expect(payload.findings.excessBackups).toBe(2);
    expect(payload.appliedCounts.purgeBackups).toBe(2);
    expect(await listBackups()).toHaveLength(6);
  });

  test("exits one on refused legacy records while deleting safe copies", async () => {
    const outsideDir = await seedRefusedLegacyFixture();

    const result = await runDoctor("--purge-legacy", "--yes", "--json");

    expect(result.exitCode).toBe(1);
    const payload = parsePayload(result);
    expect(payload.appliedCounts.purgeLegacy).toBe(1);
    expect(payload.failedTargets).toEqual([
      {
        target: "purgeLegacy",
        message:
          "legacy cleanup refused for link/../history.json.bak: recorded backup path contains path traversal",
      },
    ]);
    expect(existsSync(join(home.dataRoot, "vibe-log.json.bak"))).toBe(false);
    expect(
      await readFile(join(home.dataRoot, "history.json.bak"), "utf8"),
    ).toBe("inside copy");
    expect(await readFile(join(outsideDir, "history.json.bak"), "utf8")).toBe(
      "outside copy",
    );
  });

  test("never refreshes sessions or imports unrecorded legacy originals", async () => {
    await seedMaintenanceFixture();
    await writeFile(join(home.dataRoot, "constitution.json"), "{}");
    await writeFile(join(home.dataRoot, "constitution.json.bak"), "unrecorded");
    const rowsBefore = readRows();

    await runDoctor();
    const result = await runDoctor("--purge-legacy", "--yes");

    expect(result.exitCode).toBe(0);
    expect(readRows()).toEqual(rowsBefore);
    expect(
      await readFile(join(home.dataRoot, "constitution.json.bak"), "utf8"),
    ).toBe("unrecorded");
  });

  test("defaults to readable applied text under confirmation", async () => {
    await seedMaintenanceFixture();

    const result = await runDoctor("--vacuum", "--purge-legacy", "-y");

    expect(result.exitCode).toBe(0);
    expect(result.stdout.startsWith("Doctor: applied\n")).toBe(true);
    expect(result.stdout.trimEnd().endsWith("Status: healthy")).toBe(true);
    expect(result.stdout).not.toContain('"dryRun"');
  });

  test("starts applied text and reports unhealthy status when failures block maintenance", async () => {
    await seedMaintenanceFixture();
    seedForeignKeyViolations(2);

    const result = await runDoctor("--vacuum", "--yes");

    expect(result.exitCode).toBe(1);
    expect(result.stdout.startsWith("Doctor: applied\n")).toBe(true);
    expect(result.stdout).toMatch(/^vacuum\s+not run\s*$/m);
    expect(result.stdout.trimEnd().endsWith("Status: unhealthy")).toBe(true);
  });

  test("flags partially applied targets in text when a target fails after backup", async () => {
    await seedRefusedLegacyFixture();

    const result = await runDoctor("--purge-legacy", "--yes");

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toMatch(/^purgeLegacy\s+1 file, see failures\s*$/m);
    expect(result.stdout).toContain("Failures\n--------\npurgeLegacy: ");
  });

  test("exits one with backupPath null and zero applied counts when backup creation fails", async () => {
    await seedMaintenanceFixture();
    const rowsBefore = readRows();
    const backupsDir = join(home.dataRoot, "backups");
    await chmod(backupsDir, 0o555);

    try {
      const result = await runDoctor(
        "--vacuum",
        "--purge-legacy",
        "--yes",
        "--json",
      );

      expect(result.exitCode).toBe(1);
      const payload = parsePayload(result);
      expect(payload.backupPath).toBeNull();
      expect(payload.appliedCounts).toEqual({
        vacuum: 0,
        purgeBackups: 0,
        purgeLegacy: 0,
      });
      expect(payload.failedTargets).toEqual([
        {
          target: "backup",
          message: expect.stringMatching(/permission denied|EACCES/),
        },
      ]);
      expect(readRows()).toEqual(rowsBefore);
      expect(existsSync(join(home.dataRoot, "vibe-log.json.bak"))).toBe(true);
    } finally {
      await chmod(backupsDir, 0o755);
    }
  });
});

// ── Process boundary ──────────────────────────────────────────────────────

describe("doctor process boundary", () => {
  test("delivers a findings payload larger than the pipe buffer before exiting one", async () => {
    await seedDatabase();
    seedForeignKeyViolations(2500);

    const result = await runDoctorProcess(["--json"]);

    expect(result.exitCode).toBe(1);
    expect(result.stdout.length).toBeGreaterThan(65_536);
    expect(parsePayload(result).findings.foreignKeyCheck).toHaveLength(2500);
  }, 15_000);
});
