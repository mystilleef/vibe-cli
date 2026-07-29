/**
 * Additional tests for autosession transient-error retry paths.
 *
 * Covers: resolveAutosession retry on SQLITE_BUSY / SQLITE_BUSY_SNAPSHOT,
 * exhaustion after max attempts, and permanent error propagation.
 */
import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AUTOSESSION_TTL_MS,
  getCwdKey,
  resolveAutosession,
} from "../src/utils/autosession";
import { openVibeDatabase } from "../src/utils/database";
import { createTempHome, type TempHomeContext } from "./helpers/tempHome";

const homes: TempHomeContext[] = [];
const cwdRoots: string[] = [];
const originalCwd = process.cwd();

afterEach(async () => {
  process.chdir(originalCwd);
  await Promise.all(
    cwdRoots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
  await Promise.all(homes.splice(0).map((home) => home.cleanup()));
});

async function useTempHome(): Promise<TempHomeContext> {
  const home = await createTempHome();
  homes.push(home);
  return home;
}

async function createCwd(name: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), `vibe-cli-retry-${name}-`));
  cwdRoots.push(dir);
  return dir;
}

// isTransientSqliteError coverage lives in tests/utils.database.retry.test.ts.

describe("resolveAutosession — behavior invariants", () => {
  test("created sessions have valid UUID v4 format", async () => {
    await useTempHome();
    const cwd = await createCwd("uuid");
    const session = resolveAutosession(cwd);

    expect(session.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  test("created sessions have ISO-8601 timestamps", async () => {
    await useTempHome();
    const cwd = await createCwd("iso");
    const session = resolveAutosession(cwd);

    expect(() => new Date(session.createdAt)).not.toThrow();
    expect(() => new Date(session.lastAccessedAt)).not.toThrow();
    expect(new Date(session.createdAt).toISOString()).toBe(session.createdAt);
    expect(new Date(session.lastAccessedAt).toISOString()).toBe(
      session.lastAccessedAt,
    );
  });

  test("cwd field is stored", async () => {
    await useTempHome();
    const cwd = await createCwd("cwd-store");
    const session = resolveAutosession(cwd);

    expect(session.cwd).toBe(cwd);
  });

  test("getCwdKey produces deterministic 12-char hex", () => {
    const key1 = getCwdKey("/tmp/test-dir");
    const key2 = getCwdKey("/tmp/test-dir");

    expect(key1).toBe(key2);
    expect(key1).toHaveLength(12);
    expect(key1).toMatch(/^[0-9a-f]{12}$/);
  });

  test("getCwdKey differs for different paths", () => {
    const key1 = getCwdKey("/tmp/dir-a");
    const key2 = getCwdKey("/tmp/dir-b");

    expect(key1).not.toBe(key2);
  });

  test("resolveAutosession refreshes lastAccessedAt on each call", async () => {
    await useTempHome();
    const cwd = await createCwd("refresh");
    const first = resolveAutosession(cwd);

    // Small delay to ensure timestamp differs.
    await new Promise((r) => setTimeout(r, 100));
    const second = resolveAutosession(cwd);

    expect(second.id).toBe(first.id);
    expect(Date.parse(second.lastAccessedAt)).toBeGreaterThan(
      Date.parse(first.lastAccessedAt),
    );
  });
});

describe("resolveAutosession — TTL edge cases", () => {
  test("session well before TTL boundary is NOT expired", async () => {
    await useTempHome();
    const cwd = await createCwd("ttl-not-expired");
    const session = resolveAutosession(cwd);

    // Set lastAccessedAt to 5 seconds before TTL (well under TTL).
    // Large buffer avoids race conditions from Date.now() drift.
    const bufferMs = 5000;
    const boundaryTime = new Date(
      Date.now() - AUTOSESSION_TTL_MS + bufferMs,
    ).toISOString();
    const db = openVibeDatabase();
    try {
      db.db
        .prepare("UPDATE sessions SET last_accessed_at = ? WHERE cwd_key = ?")
        .run(boundaryTime, getCwdKey(cwd));
    } finally {
      db.close();
    }

    const renewed = resolveAutosession(cwd);
    // Not expired — same session reused.
    expect(renewed.id).toBe(session.id);
    expect(Date.parse(renewed.lastAccessedAt)).toBeGreaterThan(
      Date.parse(boundaryTime),
    );
  });

  test("session exactly at TTL boundary IS expired (>= comparison)", async () => {
    await useTempHome();
    const cwd = await createCwd("ttl-exact");
    const session = resolveAutosession(cwd);

    // Set lastAccessedAt to exactly AUTOSESSION_TTL_MS ago (at boundary).
    const boundaryTime = new Date(
      Date.now() - AUTOSESSION_TTL_MS,
    ).toISOString();
    const db = openVibeDatabase();
    try {
      db.db
        .prepare("UPDATE sessions SET last_accessed_at = ? WHERE cwd_key = ?")
        .run(boundaryTime, getCwdKey(cwd));
    } finally {
      db.close();
    }

    const renewed = resolveAutosession(cwd);
    // Expired at exact boundary — new session.
    expect(renewed.id).not.toBe(session.id);
  });

  test("session slightly past TTL IS expired", async () => {
    await useTempHome();
    const cwd = await createCwd("ttl-expired");
    const session = resolveAutosession(cwd);

    // Set lastAccessedAt to slightly more than AUTOSESSION_TTL_MS ago.
    const expiredTime = new Date(
      Date.now() - AUTOSESSION_TTL_MS - 1,
    ).toISOString();
    const db = openVibeDatabase();
    try {
      db.db
        .prepare("UPDATE sessions SET last_accessed_at = ? WHERE cwd_key = ?")
        .run(expiredTime, getCwdKey(cwd));
    } finally {
      db.close();
    }

    const renewed = resolveAutosession(cwd);
    // Expired — new session created.
    expect(renewed.id).not.toBe(session.id);
  });

  test("session far past TTL creates new session with fresh timestamps", async () => {
    await useTempHome();
    const cwd = await createCwd("ttl-far");
    const session = resolveAutosession(cwd);

    const farPast = new Date(
      Date.now() - AUTOSESSION_TTL_MS * 10,
    ).toISOString();
    const db = openVibeDatabase();
    try {
      db.db
        .prepare("UPDATE sessions SET last_accessed_at = ? WHERE cwd_key = ?")
        .run(farPast, getCwdKey(cwd));
    } finally {
      db.close();
    }

    const renewed = resolveAutosession(cwd);
    expect(renewed.id).not.toBe(session.id);
    expect(Date.parse(renewed.createdAt)).toBeGreaterThan(
      Date.parse(session.createdAt),
    );
    expect(renewed.lastAccessedAt).toBe(renewed.createdAt);
  });
});

describe("resolveAutosession — transient error retry loop", () => {
  function makeBusyError(): Error & { code: string } {
    const err = new Error("SQLITE_BUSY: database is locked") as Error & {
      code: string;
    };
    err.code = "SQLITE_BUSY";
    return err;
  }

  function makeBusySnapshotError(): Error & { code: string } {
    const err = new Error(
      "SQLITE_BUSY_SNAPSHOT: snapshot is unavailable",
    ) as Error & { code: string };
    err.code = "SQLITE_BUSY_SNAPSHOT";
    return err;
  }

  test("retries on SQLITE_BUSY and succeeds on second attempt", async () => {
    await useTempHome();
    const cwd = await createCwd("retry-busy");

    const dbModule = await import("../src/utils/database");
    const originalWithDb = dbModule.withDatabase;
    const busyError = makeBusyError();
    let callCount = 0;

    const spy = spyOn(dbModule, "withDatabase");
    spy.mockImplementation((fn, options) => {
      callCount++;
      if (callCount === 1) throw busyError;
      return originalWithDb(fn, options);
    });

    const session = resolveAutosession(cwd);

    expect(callCount).toBe(2);
    expect(session.id).toMatch(/^[0-9a-f-]{36}$/);

    mock.restore();
  });

  test("retries on SQLITE_BUSY_SNAPSHOT and succeeds on third attempt", async () => {
    await useTempHome();
    const cwd = await createCwd("retry-snapshot");

    const dbModule = await import("../src/utils/database");
    const originalWithDb = dbModule.withDatabase;
    const busyError = makeBusySnapshotError();
    let callCount = 0;

    const spy = spyOn(dbModule, "withDatabase");
    spy.mockImplementation((fn, options) => {
      callCount++;
      if (callCount <= 2) throw busyError;
      return originalWithDb(fn, options);
    });

    const session = resolveAutosession(cwd);

    expect(callCount).toBe(3);
    expect(session.id).toMatch(/^[0-9a-f-]{36}$/);

    mock.restore();
  });

  test("exhausts retries and throws lastError after max attempts", async () => {
    await useTempHome();
    const cwd = await createCwd("retry-exhaust");

    const dbModule = await import("../src/utils/database");
    const busyError = makeBusyError();
    let callCount = 0;

    const spy = spyOn(dbModule, "withDatabase");
    spy.mockImplementation(() => {
      callCount++;
      throw busyError;
    });

    expect(() => resolveAutosession(cwd)).toThrow(
      "SQLITE_BUSY: database is locked",
    );
    // 3 attempts (maxAttempts) then throw
    expect(callCount).toBe(3);

    mock.restore();
  });

  test("does not retry on non-transient SQLITE_CORRUPT error", async () => {
    await useTempHome();
    const cwd = await createCwd("retry-perm");

    const dbModule = await import("../src/utils/database");
    const corruptError = new Error(
      "SQLITE_CORRUPT: database malformed",
    ) as Error & { code: string };
    corruptError.code = "SQLITE_CORRUPT";
    let callCount = 0;

    const spy = spyOn(dbModule, "withDatabase");
    spy.mockImplementation(() => {
      callCount++;
      throw corruptError;
    });

    expect(() => resolveAutosession(cwd)).toThrow(
      "SQLITE_CORRUPT: database malformed",
    );
    // No retry — fails immediately
    expect(callCount).toBe(1);

    mock.restore();
  });

  test("does not retry on plain Error without code", async () => {
    await useTempHome();
    const cwd = await createCwd("retry-plain");

    const dbModule = await import("../src/utils/database");
    const plainError = new Error("something unexpected");
    let callCount = 0;

    const spy = spyOn(dbModule, "withDatabase");
    spy.mockImplementation(() => {
      callCount++;
      throw plainError;
    });

    expect(() => resolveAutosession(cwd)).toThrow("something unexpected");
    // No retry — fails immediately
    expect(callCount).toBe(1);

    mock.restore();
  });

  test("sleeps with increasing backoff between retries", async () => {
    await useTempHome();
    const cwd = await createCwd("retry-backoff");

    const dbModule = await import("../src/utils/database");
    const originalWithDb = dbModule.withDatabase;
    const busyError = makeBusyError();
    let callCount = 0;

    // Spy on Bun.sleepSync to capture sleep durations
    const sleepSpy = spyOn(Bun, "sleepSync");

    const spy = spyOn(dbModule, "withDatabase");
    spy.mockImplementation((fn, options) => {
      callCount++;
      if (callCount <= 2) throw busyError;
      return originalWithDb(fn, options);
    });

    resolveAutosession(cwd);

    expect(callCount).toBe(3);
    // Sleep called twice: attempt 0 → 50ms, attempt 1 → 100ms
    const sleepCalls = sleepSpy.mock.calls;
    expect(sleepCalls.length).toBe(2);
    // First sleep: 50 + 0 * 50 = 50
    expect(sleepCalls[0]).toEqual([50]);
    // Second sleep: 50 + 1 * 50 = 100
    expect(sleepCalls[1]).toEqual([100]);

    mock.restore();
  });
});

describe("resolveAutosession — concurrent stress", () => {
  test("concurrent first-time resolution produces exactly one row", async () => {
    await useTempHome();
    const cwd = await createCwd("stress-concurrent");

    const CONCURRENCY = 10;
    const results = await Promise.all(
      Array.from({ length: CONCURRENCY }, () => resolveAutosession(cwd)),
    );

    const ids = results.map((r) => r.id);
    expect(new Set(ids).size).toBe(1);
  });
});
