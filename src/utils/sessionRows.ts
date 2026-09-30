/**
 * Session-row anchoring shared by history writes (`state.ts`) and legacy
 * imports (`legacyImporter.ts`). Lives in a dependency-free module so those
 * persistence modules can share it without forming import cycles.
 */
import type Database from "bun:sqlite";

/** Identifies a session row anchored by history or import writes. */
export interface SessionAnchor {
  id: string;
  /** Storage-key namespace; synthetic history/legacy sessions prefix their ids. */
  cwdKey: string;
  createdAt: string;
  /** Defaults to {@link SessionAnchor.createdAt} when omitted. */
  lastAccessedAt?: string;
}

/**
 * Idempotently anchor a session row so dependent rows satisfy foreign keys.
 * Re-anchoring an existing id leaves the stored timestamps untouched.
 */
export function ensureSessionRow(db: Database, anchor: SessionAnchor): void {
  const { id, cwdKey, createdAt, lastAccessedAt = createdAt } = anchor;
  db.prepare(
    "INSERT OR IGNORE INTO sessions (id, cwd_key, created_at, last_accessed_at) VALUES (?, ?, ?, ?)",
  ).run(id, cwdKey, createdAt, lastAccessedAt);
}
