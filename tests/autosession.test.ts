import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
  AUTOSESSION_TTL_MS,
  getCwdKey,
  getDataRoot,
  resolveAutosession,
} from "../src/utils/autosession";
import { openVibeDatabase } from "../src/utils/database";
import { runChild } from "./helpers/childProcess";
import { seedInitialMigration } from "./helpers/migrationSeed";
import { createTempHarness } from "./helpers/tempHome";

const harness = createTempHarness();
const { useTempHome, createCwd } = harness;
const originalCwd = process.cwd();

afterEach(async () => {
  await harness.cleanup();
});

function updateLastAccessed(cwd: string, lastAccessedAt: string): void {
  const handle = openVibeDatabase();
  try {
    handle.db
      .prepare("UPDATE sessions SET last_accessed_at = ? WHERE cwd_key = ?")
      .run(lastAccessedAt, getCwdKey(cwd));
  } finally {
    handle.close();
  }
}

describe("autosession resolver", () => {
  test("same CWD reuses an active session and refreshes lastAccessedAt", async () => {
    const home = await useTempHome();
    const cwd = await createCwd("same");
    process.chdir(cwd);

    const first = resolveAutosession();
    updateLastAccessed(cwd, new Date(Date.now() - 1000).toISOString());

    const second = resolveAutosession();

    expect(getDataRoot()).toBe(home.dataRoot);
    expect(second.id).toBe(first.id);
    expect(Date.parse(second.lastAccessedAt)).toBeGreaterThan(
      Date.parse(first.lastAccessedAt) - 1,
    );
  });

  test("different CWDs produce different keys and session records", async () => {
    await useTempHome();
    const firstCwd = await createCwd("first");
    const secondCwd = await createCwd("second");

    const first = resolveAutosession(firstCwd);
    const second = resolveAutosession(secondCwd);

    expect(getCwdKey(firstCwd)).not.toBe(getCwdKey(secondCwd));
    expect(first.id).not.toBe(second.id);
  });

  test("missing and expired records create new sessions", async () => {
    await useTempHome();
    const missingCwd = await createCwd("missing");
    const missing = resolveAutosession(missingCwd);
    expect(missing.id).toMatch(/^[0-9a-f-]{36}$/);

    const expiredCwd = await createCwd("expired");
    const expired = resolveAutosession(expiredCwd);
    updateLastAccessed(
      expiredCwd,
      new Date(Date.now() - AUTOSESSION_TTL_MS - 1).toISOString(),
    );
    const renewed = resolveAutosession(expiredCwd);
    expect(renewed.id).not.toBe(expired.id);
  });
});

describe("concurrent autosession resolution", () => {
  async function spawnResolveAutosession(
    home: string,
    cwd: string,
  ): Promise<{ sessionId: string; exitCode: number; stderr: string }> {
    const { mkdtempSync, writeFileSync } = await import("node:fs");
    const { join: pathJoin } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const scriptDir = mkdtempSync(pathJoin(tmpdir(), "vibe-as-test-"));
    const scriptPath = pathJoin(scriptDir, "resolve.ts");
    writeFileSync(
      scriptPath,
      `
import { resolveAutosession as ra } from "${join(originalCwd, "src/utils/autosession.ts")}";
const cwd = process.env.VIBE_TEST_CWD!;
const result = ra(cwd);
console.log(JSON.stringify({ sessionId: result.id }));
`,
    );
    let child: { stdout: string; stderr: string; exitCode: number };
    try {
      child = await runChild("bun", ["run", scriptPath], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          HOME: home,
          VIBE_TEST_CWD: cwd,
        },
        timeout: 10_000,
      });
    } finally {
      const { rmSync } = await import("node:fs");
      rmSync(scriptDir, { recursive: true, force: true });
    }
    const { stdout, stderr, exitCode } = child;
    if (exitCode !== 0) {
      throw new Error(`Child exit ${exitCode}: ${stderr}`);
    }
    const payload = JSON.parse(stdout.trim()) as { sessionId: string };
    return { sessionId: payload.sessionId, exitCode, stderr };
  }

  test("concurrent resolution for the same CWD key converges on one session", async () => {
    const home = await useTempHome();
    const cwd = await createCwd("concurrent-same");
    const CONCURRENCY = 6;

    const results = await Promise.all(
      Array.from({ length: CONCURRENCY }, () =>
        spawnResolveAutosession(home.home, cwd),
      ),
    );

    const sessionIds = results.map((r) => r.sessionId);
    const uniqueIds = new Set(sessionIds);

    // All children exit cleanly.
    for (const { exitCode, stderr } of results) {
      expect(exitCode).toBe(0);
      expect(stderr).toBe("");
    }

    // All return the same session.
    expect(uniqueIds.size).toBe(1);
    const sessionId = sessionIds[0] as string;
    expect(sessionId).toMatch(/^[0-9a-f-]{36}$/);

    // Verify exactly one row in the database for this CWD key.
    const db = new Database(join(home.dataRoot, "vibe.db"));
    const rows = db
      .query<{ id: string; cwd_key: string }, [string]>(
        "SELECT id, cwd_key FROM sessions WHERE cwd_key = ?",
      )
      .all(getCwdKey(cwd));
    db.close();
    expect(rows).toHaveLength(1);
    const row = rows[0] as { id: string; cwd_key: string } | undefined;
    expect(row).toBeDefined();
    if (row) expect(row.id).toBe(sessionId);
  }, 15000);

  test("concurrent resolution for different CWDs produces distinct sessions", async () => {
    const home = await useTempHome();
    const cwds = await Promise.all([
      createCwd("concurrent-diff-a"),
      createCwd("concurrent-diff-b"),
      createCwd("concurrent-diff-c"),
      createCwd("concurrent-diff-d"),
    ]);

    const results = await Promise.all(
      cwds.map((cwd) => spawnResolveAutosession(home.home, cwd)),
    );

    for (const { exitCode, stderr } of results) {
      expect(exitCode).toBe(0);
      expect(stderr).toBe("");
    }

    const ids = results.map((r) => r.sessionId);
    expect(new Set(ids).size).toBe(cwds.length);
    for (const id of ids) {
      expect(id).toMatch(/^[0-9a-f-]{36}$/);
    }

    // Each CWD key has exactly one row.
    const db = new Database(join(home.dataRoot, "vibe.db"));
    for (const cwd of cwds) {
      const rows = db
        .query<{ id: string }, [string]>(
          "SELECT id FROM sessions WHERE cwd_key = ?",
        )
        .all(getCwdKey(cwd));
      expect(rows).toHaveLength(1);
    }
    db.close();
  }, 15000);

  test("concurrent resolution with fresh database bootstraps without corruption", async () => {
    const home = await useTempHome();
    const cwds = await Promise.all([
      createCwd("fresh-a"),
      createCwd("fresh-b"),
      createCwd("fresh-c"),
    ]);

    // Run 2 rounds of concurrent resolution to exercise both fresh and reuse paths.
    await Promise.all(
      cwds.map((cwd) => spawnResolveAutosession(home.home, cwd)),
    );
    const secondRound = await Promise.all(
      cwds.map((cwd) => spawnResolveAutosession(home.home, cwd)),
    );

    for (const { exitCode, stderr } of secondRound) {
      expect(exitCode).toBe(0);
      expect(stderr).toBe("");
    }

    // One row per CWD key after both rounds.
    const db = new Database(join(home.dataRoot, "vibe.db"));
    const count = db
      .query<{ count: number }, []>("SELECT count(*) AS count FROM sessions")
      .get();
    expect(count?.count).toBe(cwds.length);
    db.close();
  }, 15000);

  test("concurrent resolution with partially migrated database converges without corruption", async () => {
    const home = await useTempHome();
    const cwd = await createCwd("partial-migration");

    // Seed a partially migrated database: only migration 001 applied, with
    // all its tables materialized. Migrations 002 and 003 remain pending.
    await mkdir(home.dataRoot, { recursive: true });
    const dbPath = join(home.dataRoot, "vibe.db");
    {
      const seedDb = new Database(dbPath);
      seedInitialMigration(seedDb);
      seedDb.close();
    }

    // Run concurrent resolution against the partially migrated database.
    const CONCURRENCY = 4;
    const results = await Promise.all(
      Array.from({ length: CONCURRENCY }, () =>
        spawnResolveAutosession(home.home, cwd),
      ),
    );

    // All children exit cleanly with no busy/snapshot diagnostics.
    for (const { exitCode, stderr } of results) {
      expect(exitCode).toBe(0);
      expect(stderr).toBe("");
    }

    // One session, one row.
    const ids = results.map((r) => r.sessionId);
    expect(new Set(ids).size).toBe(1);
    expect(ids[0]).toMatch(/^[0-9a-f-]{36}$/);

    // Remaining migrations applied.
    const verifyDb = new Database(dbPath);
    const migrationIds = verifyDb
      .query("SELECT id FROM schema_migrations ORDER BY id")
      .all()
      .map((r: unknown) => (r as { id: string }).id);
    expect(migrationIds).toContain("002_sessions_display_cwd");
    expect(migrationIds).toContain("003_rename_mistake_to_observation");

    const sessionRows = verifyDb
      .query("SELECT id FROM sessions WHERE cwd_key = ?")
      .all(getCwdKey(cwd));
    expect(sessionRows).toHaveLength(1);
    verifyDb.close();
  }, 15000);

  test("concurrent resolution with expired session creates exactly one replacement", async () => {
    const home = await useTempHome();
    const cwd = await createCwd("concurrent-expired");

    // Seed an expired session.
    const first = resolveAutosession(cwd);
    updateLastAccessed(
      cwd,
      new Date(Date.now() - AUTOSESSION_TTL_MS - 1).toISOString(),
    );

    // Resolve concurrently — both should see the expired session.
    const CONCURRENCY = 4;
    const results = await Promise.all(
      Array.from({ length: CONCURRENCY }, () =>
        spawnResolveAutosession(home.home, cwd),
      ),
    );

    for (const { exitCode, stderr } of results) {
      expect(exitCode).toBe(0);
      expect(stderr).toBe("");
    }

    const ids = results.map((r) => r.sessionId);
    // All children should return the same new session (first writer wins).
    expect(new Set(ids).size).toBe(1);
    expect(ids[0]).not.toBe(first.id);

    // Exactly one row remains.
    const db = new Database(join(home.dataRoot, "vibe.db"));
    const rows = db
      .query<{ id: string }, [string]>(
        "SELECT id FROM sessions WHERE cwd_key = ?",
      )
      .all(getCwdKey(cwd));
    db.close();
    expect(rows).toHaveLength(1);
    const row = rows[0] as { id: string } | undefined;
    expect(row).toBeDefined();
    if (row) expect(row.id).toBe(ids[0] as string);
  }, 15000);

  test("concurrent list access interleaved with autosession resolution converges", async () => {
    const home = await useTempHome();
    const cwd = await createCwd("interleaved");

    async function spawnList(
      command: string[],
    ): Promise<{ exitCode: number; stderr: string; stdout: string }> {
      return runChild(
        "bun",
        ["run", join(originalCwd, "src/cli.ts"), ...command],
        {
          cwd,
          env: {
            ...process.env,
            HOME: home.home,
            CI: "true",
            NO_COLOR: "1",
            TERM: "dumb",
            PAGER: "cat",
            DEFAULT_LLM_PROVIDER: undefined,
            DEFAULT_MODEL: undefined,
          },
          timeout: 10_000,
        },
      );
    }

    // Run session + list commands concurrently.
    const results = await Promise.all([
      spawnList(["session"]),
      spawnList(["list", "learnings", "--json"]),
      spawnList(["list", "sessions", "--json"]),
      spawnList(["session"]),
      spawnList(["list", "constitution", "--json"]),
    ]);

    for (const { exitCode, stderr, stdout } of results) {
      expect(exitCode).toBe(0);
      expect(stderr).toBe("");
      expect(stdout).not.toBe("");
      const lastLine = stdout.trim().split("\n").pop() ?? "{}";
      expect(() => JSON.parse(lastLine)).not.toThrow();
    }

    // All session commands return the same session.
    const sessionPayloads = [results[0], results[3]].map(
      (r) => JSON.parse(r.stdout.trim()) as { session: string },
    );
    const [firstSession, secondSession] = sessionPayloads as [
      { session: string },
      { session: string },
    ];
    expect(firstSession.session).toBe(secondSession.session);

    // Exactly one row in the database for this CWD key.
    const db = new Database(join(home.dataRoot, "vibe.db"));
    const rows = db
      .query<{ id: string }, [string]>(
        "SELECT id FROM sessions WHERE cwd_key = ?",
      )
      .all(getCwdKey(cwd));
    db.close();
    expect(rows).toHaveLength(1);
    const sessionRow = rows[0] as { id: string } | undefined;
    expect(sessionRow).toBeDefined();
    if (sessionRow) expect(sessionRow.id).toBe(firstSession.session);
  }, 15000);
});

describe("resolveAutosession convergence", () => {
  test("concurrent resolution converges under real transient conflicts", async () => {
    const home = await useTempHome();
    const cwd = await createCwd("real-concurrent");
    const CONCURRENCY = 5;

    const results = await Promise.all(
      Array.from({ length: CONCURRENCY }, () =>
        (async () => {
          const { resolveAutosession: ra } = await import(
            "../src/utils/autosession"
          );
          return ra(cwd);
        })(),
      ),
    );

    const ids = results.map((r) => r.id);
    expect(new Set(ids).size).toBe(1);

    // One row only.
    const db = new Database(join(home.dataRoot, "vibe.db"));
    const rows = db
      .query<{ id: string }, [string]>(
        "SELECT id FROM sessions WHERE cwd_key = ?",
      )
      .all(getCwdKey(cwd));
    db.close();
    expect(rows).toHaveLength(1);
  }, 15000);
});
