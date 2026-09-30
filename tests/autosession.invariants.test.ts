/**
 * Additional autosession tests: record invariants, TTL boundaries, write
 * locking, and in-process convergence.
 */
import { Database } from "bun:sqlite";
import {
  afterEach,
  describe,
  expect,
  mock,
  setSystemTime,
  spyOn,
  test,
} from "bun:test";
import { join } from "node:path";
import {
  AUTOSESSION_TTL_MS,
  getCwdKey,
  resolveAutosession,
} from "../src/utils/autosession";
import {
  DATABASE_FILENAME,
  getVibeDatabase,
  openVibeDatabase,
} from "../src/utils/database";
import { createTempHarness } from "./helpers/tempHome";

const harness = createTempHarness();
const { useTempHome, createCwd } = harness;

afterEach(async () => {
  mock.restore();
  setSystemTime();
  await harness.cleanup();
});

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
    setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const first = resolveAutosession(cwd);

    setSystemTime(new Date("2026-01-01T00:00:01.000Z"));
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

describe("resolveAutosession — write lock", () => {
  test("resolveAutosession locks out writers before reading the session row", async () => {
    const home = await useTempHome();
    const cwd = await createCwd("write-lock");
    resolveAutosession(cwd);

    // A second connection probes the lock at the transaction's first read;
    // a deferred transaction would not hold it yet.
    const probe = new Database(join(home.dataRoot, DATABASE_FILENAME));
    probe.exec("PRAGMA busy_timeout = 0");
    const { db } = getVibeDatabase();
    const query = db.query.bind(db);
    let probeError: unknown;
    spyOn(db, "query").mockImplementation((sql: string) => {
      try {
        probe.exec("BEGIN IMMEDIATE");
        probe.exec("ROLLBACK");
      } catch (error) {
        probeError = error;
      }
      return query(sql);
    });

    try {
      resolveAutosession(cwd);
    } finally {
      probe.close();
    }
    expect(probeError).toMatchObject({ code: "SQLITE_BUSY" });
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
