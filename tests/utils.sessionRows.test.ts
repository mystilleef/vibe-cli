/**
 * Session-row anchoring contract shared by history writes and legacy
 * imports: anchoring is idempotent, defaults `last_accessed_at` to
 * `created_at`, and never rewrites a row that already exists.
 */
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { initializeSchema } from "../src/utils/database.js";
import { ensureSessionRow } from "../src/utils/sessionRows.js";

let db: Database;

beforeEach(() => {
  db = new Database(":memory:");
  initializeSchema(db);
});

afterEach(() => {
  db.close();
});

interface SessionRow {
  id: string;
  cwd_key: string;
  created_at: string;
  last_accessed_at: string;
}

function readSession(id: string): SessionRow | null {
  return db
    .query<SessionRow, [string]>(
      "SELECT id, cwd_key, created_at, last_accessed_at FROM sessions WHERE id = ?",
    )
    .get(id);
}

describe("ensureSessionRow", () => {
  test("inserts an anchored session with last_accessed_at defaulting to created_at", () => {
    ensureSessionRow(db, {
      id: "s1",
      cwdKey: "key-1",
      createdAt: "2026-01-01T00:00:00.000Z",
    });

    expect(readSession("s1")).toEqual({
      id: "s1",
      cwd_key: "key-1",
      created_at: "2026-01-01T00:00:00.000Z",
      last_accessed_at: "2026-01-01T00:00:00.000Z",
    });
  });

  test("re-anchoring an existing id leaves stored timestamps untouched", () => {
    ensureSessionRow(db, {
      id: "s1",
      cwdKey: "key-1",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    ensureSessionRow(db, {
      id: "s1",
      cwdKey: "key-1",
      createdAt: "2027-02-02T00:00:00.000Z",
      lastAccessedAt: "2027-03-03T00:00:00.000Z",
    });

    expect(readSession("s1")).toEqual({
      id: "s1",
      cwd_key: "key-1",
      created_at: "2026-01-01T00:00:00.000Z",
      last_accessed_at: "2026-01-01T00:00:00.000Z",
    });
  });

  test("anchors distinct ids into independent rows", () => {
    ensureSessionRow(db, {
      id: "s1",
      cwdKey: "key-1",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    ensureSessionRow(db, {
      id: "s2",
      cwdKey: "key-2",
      createdAt: "2026-02-02T00:00:00.000Z",
      lastAccessedAt: "2026-03-03T00:00:00.000Z",
    });

    expect(readSession("s1")?.created_at).toBe("2026-01-01T00:00:00.000Z");
    expect(readSession("s2")).toEqual({
      id: "s2",
      cwd_key: "key-2",
      created_at: "2026-02-02T00:00:00.000Z",
      last_accessed_at: "2026-03-03T00:00:00.000Z",
    });
  });

  test("ignores an anchor whose cwd_key already names another session", () => {
    ensureSessionRow(db, {
      id: "s1",
      cwdKey: "key-1",
      createdAt: "2026-01-01T00:00:00.000Z",
    });

    ensureSessionRow(db, {
      id: "s2",
      cwdKey: "key-1",
      createdAt: "2026-02-02T00:00:00.000Z",
    });

    expect(readSession("s1")?.id).toBe("s1");
    expect(readSession("s2")).toBeNull();
  });
});
