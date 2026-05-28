import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { withDatabase } from "./database.js";

/** Duration in milliseconds before an unaccessed session expires (4 hours). */
export const AUTOSESSION_TTL_MS = 4 * 60 * 60 * 1000;

/** Persistent session record stored per working directory. */
export interface AutosessionRecord {
  /** Unique session identifier (UUID v4). */
  id: string;
  /** Original working-directory path for display, when available. */
  cwd: string | null;
  /** ISO-8601 timestamp when the session was first created. */
  createdAt: string;
  /** ISO-8601 timestamp of the most recent access; used for TTL expiry. */
  lastAccessedAt: string;
}

interface SessionRow {
  id: string;
  cwd: string | null;
  created_at: string;
  last_accessed_at: string;
}

/**
 * Returns the vibe-cli data root directory (`~/.vibe-cli`).
 *
 * Uses `$HOME` when set, falling back to `os.homedir()`.
 */
export function getDataRoot(): string {
  return path.join(process.env.HOME ?? os.homedir(), ".vibe-cli");
}

/** Creates the data root directory if it does not already exist. */
export function ensureDataDir(): void {
  const dataDir = getDataRoot();
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
}

/**
 * Derives a deterministic, truncated SHA-256 key from a working directory path.
 *
 * @param cwd - Absolute path to hash (defaults to `process.cwd()`).
 * @returns 12-character hex string used as the session filename.
 */
export function getCwdKey(cwd = process.cwd()): string {
  return createHash("sha256").update(cwd).digest("hex").slice(0, 12);
}

function isExpired(record: AutosessionRecord, now: number): boolean {
  return now - Date.parse(record.lastAccessedAt) >= AUTOSESSION_TTL_MS;
}

function createRecord(now: Date, cwd: string): AutosessionRecord {
  const timestamp = now.toISOString();
  return {
    id: randomUUID(),
    cwd,
    createdAt: timestamp,
    lastAccessedAt: timestamp,
  };
}

function toRecord(row: SessionRow): AutosessionRecord {
  return {
    id: row.id,
    cwd: row.cwd,
    createdAt: row.created_at,
    lastAccessedAt: row.last_accessed_at,
  };
}

/** Deletes inactive autosessions and cascading dependent rows by cutoff timestamp. */
export function deleteInactiveAutosessions(cutoff: Date): number {
  return withDatabase((db) => {
    const result = db
      .prepare("DELETE FROM sessions WHERE last_accessed_at <= ?")
      .run(cutoff.toISOString());
    return result.changes;
  });
}

/**
 * Resolves the autosession for the given working directory.
 *
 * Returns the existing session if it has not expired (within
 * {@link AUTOSESSION_TTL_MS}), updating its `lastAccessedAt` timestamp.
 * Otherwise creates and persists a new session with a fresh UUID.
 *
 * @param cwd - Working directory to resolve against (defaults to `process.cwd()`).
 * @returns The active {@link AutosessionRecord}.
 */
export function resolveAutosession(cwd = process.cwd()): AutosessionRecord {
  const cwdKey = getCwdKey(cwd);
  const now = new Date();

  return withDatabase((db) => {
    const existing = db
      .query<SessionRow, [string]>(
        "SELECT id, cwd, created_at, last_accessed_at FROM sessions WHERE cwd_key = ? LIMIT 1",
      )
      .get(cwdKey);

    if (existing) {
      const record = toRecord(existing);
      if (!isExpired(record, now.getTime())) {
        const touched = { ...record, lastAccessedAt: now.toISOString() };
        db.prepare(
          "UPDATE sessions SET last_accessed_at = ? WHERE cwd_key = ?",
        ).run(touched.lastAccessedAt, cwdKey);
        return touched;
      }

      db.prepare("DELETE FROM sessions WHERE cwd_key = ?").run(cwdKey);
    }

    const record = createRecord(now, cwd);
    db.prepare(
      "INSERT INTO sessions (id, cwd_key, cwd, created_at, last_accessed_at) VALUES (?, ?, ?, ?, ?)",
    ).run(
      record.id,
      cwdKey,
      record.cwd,
      record.createdAt,
      record.lastAccessedAt,
    );
    return record;
  });
}
