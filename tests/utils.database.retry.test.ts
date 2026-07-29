import { Database as RealDatabase } from "bun:sqlite";
import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Tests for the SQLite retry logic in openDatabase().
 *
 * The retry loop handles transient SQLITE_BUSY / SQLITE_BUSY_SNAPSHOT
 * errors that can occur when independent processes open the same
 * database file simultaneously.  It retries up to 3 times with
 * increasing backoff (50ms, 100ms, 150ms).
 *
 * We use mock.module on "bun:sqlite" to inject SQLITE_BUSY faults
 * into the Database constructor, avoiding fragile file-locking or
 * multi-process tests.
 */

/** Number of consecutive SQLITE_BUSY errors to inject at construction. */
let sqliteBusyErrorsRemaining = 0;
/** Number of consecutive SQLITE_BUSY errors to inject on `exec()` calls. */
let execBusyErrorsRemaining = 0;

function throwSqliteBusy(): never {
  const err = new Error("database is locked") as Error & { code: string };
  err.code = "SQLITE_BUSY";
  err.name = "SqliteError";
  throw err;
}

mock.module("bun:sqlite", () => ({
  Database: class MockDatabase extends RealDatabase {
    constructor(filename: string, options?: { create?: boolean }) {
      if (sqliteBusyErrorsRemaining > 0) {
        sqliteBusyErrorsRemaining--;
        throwSqliteBusy();
      }
      super(filename, options);
    }

    override exec(
      ...args: Parameters<InstanceType<typeof RealDatabase>["exec"]>
    ): ReturnType<InstanceType<typeof RealDatabase>["exec"]> {
      if (execBusyErrorsRemaining > 0) {
        execBusyErrorsRemaining--;
        throwSqliteBusy();
      }
      return super.exec(...args);
    }
  },
}));

// Import the module under test AFTER mock is registered so the mock
// takes effect when database.ts imports bun:sqlite.
import { DATABASE_FILENAME, openVibeDatabase } from "../src/utils/database";
import { isTransientSqliteError } from "../src/utils/sqliteRetry";

const roots: string[] = [];

afterEach(async () => {
  sqliteBusyErrorsRemaining = 0;
  execBusyErrorsRemaining = 0;
  await Promise.all(roots.map((r) => rm(r, { recursive: true, force: true })));
  roots.length = 0;
});

async function tempPath(name: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `vibe-cli-db-retry-${name}-`));
  roots.push(root);
  return join(root, DATABASE_FILENAME);
}

describe("openVibeDatabase transient SQLite error retry", () => {
  test("retries on SQLITE_BUSY and succeeds when fault clears before exhaustion", async () => {
    // Fail the first 2 attempts, succeed on the 3rd (maxAttempts=3).
    sqliteBusyErrorsRemaining = 2;
    const path = await tempPath("retry-succeed");
    const handle = openVibeDatabase({ path });
    try {
      expect(handle.path).toBe(path);
      // Verify the database is functional after retry.
      const row = handle.db.query("SELECT 1 AS n").get() as { n: number };
      expect(row).toEqual({ n: 1 });
    } finally {
      handle.close();
    }
  });

  test("throws lastError after exhausting all retry attempts", async () => {
    // Fail all 3 attempts (maxAttempts=3).
    sqliteBusyErrorsRemaining = 3;
    const path = await tempPath("retry-exhaust");
    expect(() => openVibeDatabase({ path })).toThrow("database is locked");
  });

  test("succeeds on first try when no fault is injected", async () => {
    // Baseline: no faults → open succeeds immediately.
    sqliteBusyErrorsRemaining = 0;
    const path = await tempPath("retry-none");
    const handle = openVibeDatabase({ path });
    try {
      expect(handle.path).toBe(path);
    } finally {
      handle.close();
    }
  });

  test("retries once and succeeds on second attempt", async () => {
    sqliteBusyErrorsRemaining = 1;
    const path = await tempPath("retry-once");
    const handle = openVibeDatabase({ path });
    try {
      expect(handle.path).toBe(path);
      const row = handle.db.query("SELECT 1 AS n").get() as { n: number };
      expect(row).toEqual({ n: 1 });
    } finally {
      handle.close();
    }
  });

  test("closes database connection when post-construction schema setup fails", async () => {
    sqliteBusyErrorsRemaining = 0;
    const path = await tempPath("retry-init-fail");
    const RealDb = (await import("bun:sqlite")).Database;
    const db = new RealDb(path, { create: true });
    // Intentionally create an incompatible table to cause initializeSchema to throw
    db.exec("CREATE TABLE schema_migrations (version TEXT PRIMARY KEY)");
    db.close();

    // Spy after the setup db's own close() above, so this only counts
    // openDatabaseOnce's internal handle.
    const closeSpy = spyOn(RealDatabase.prototype, "close");
    try {
      expect(() => openVibeDatabase({ path })).toThrow();
      // openDatabaseOnce must close its own failed-construction handle
      // before rethrowing — never leak the connection it opened.
      expect(closeSpy).toHaveBeenCalledTimes(1);
    } finally {
      closeSpy.mockRestore();
    }
  });

  test("retry-then-succeed leaves no dangling handle from the failed attempt", async () => {
    sqliteBusyErrorsRemaining = 0;
    // First attempt's post-construction PRAGMA exec throws SQLITE_BUSY;
    // the second attempt (fresh handle) succeeds.
    execBusyErrorsRemaining = 1;
    const path = await tempPath("retry-exec-busy-succeed");

    const closeSpy = spyOn(RealDatabase.prototype, "close");
    try {
      const handle = openVibeDatabase({ path });
      try {
        // Exactly one close so far — the failed first attempt's handle.
        // Never two open connections at once from a single retry cycle.
        expect(closeSpy).toHaveBeenCalledTimes(1);
        const row = handle.db.query("SELECT 1 AS n").get() as { n: number };
        expect(row).toEqual({ n: 1 });
      } finally {
        handle.close();
      }
    } finally {
      closeSpy.mockRestore();
    }
  });
});

// Sole home for isTransientSqliteError coverage — previously duplicated
// across migration.test.ts and autosession.retry.test.ts.
describe("isTransientSqliteError", () => {
  function makeError(code: string): Error & { code: string } {
    const err = new Error(`SQLite error: ${code}`) as Error & {
      code: string;
    };
    err.code = code;
    return err;
  }

  test("returns true for SQLITE_BUSY", () => {
    expect(isTransientSqliteError(makeError("SQLITE_BUSY"))).toBe(true);
  });

  test("returns true for SQLITE_BUSY_SNAPSHOT", () => {
    expect(isTransientSqliteError(makeError("SQLITE_BUSY_SNAPSHOT"))).toBe(
      true,
    );
  });

  test("returns false for non-transient SQLite error codes", () => {
    for (const code of [
      "SQLITE_ERROR",
      "SQLITE_CONSTRAINT",
      "SQLITE_MISUSE",
      "SQLITE_IOERR",
      "SQLITE_CORRUPT",
      "SQLITE_READONLY",
      "SQLITE_NOMEM",
    ]) {
      expect(isTransientSqliteError(makeError(code))).toBe(false);
    }
  });

  test("returns false for non-Error values", () => {
    expect(isTransientSqliteError("string")).toBe(false);
    expect(isTransientSqliteError(null)).toBe(false);
    expect(isTransientSqliteError(undefined)).toBe(false);
    expect(isTransientSqliteError(42)).toBe(false);
    expect(isTransientSqliteError({ code: "SQLITE_BUSY" })).toBe(false);
  });

  test("returns false for Error without a code property", () => {
    expect(isTransientSqliteError(new Error("plain error"))).toBe(false);
  });
});
