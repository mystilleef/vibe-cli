import type Database from "bun:sqlite";
import type { VibeCheckInput } from "../tools/vibeCheck.js";
import { getCwdKey } from "./autosession.js";
import { withDatabase } from "./database.js";

interface InteractionRow {
  goal: string;
  output: string;
}

function ensureSession(db: Database, sessionId: string): void {
  const now = new Date().toISOString();
  db.prepare(
    "INSERT OR IGNORE INTO sessions (id, cwd_key, created_at, last_accessed_at) VALUES (?, ?, ?, ?)",
  ).run(sessionId, `history:${getCwdKey(sessionId)}`, now, now);
}

function pruneSession(db: Database, sessionId: string): void {
  db.prepare(
    `DELETE FROM interactions
     WHERE session_id = ?
       AND id NOT IN (
         SELECT id FROM interactions
         WHERE session_id = ?
         ORDER BY timestamp DESC, id DESC
         LIMIT 10
       )`,
  ).run(sessionId, sessionId);
}

/**
 * Return a truncated summary of the last 5 interactions for
 * `sessionId`, or empty string when none exist. Intended for
 * injecting recent context into LLM prompts.
 */
export function getHistorySummary(sessionId = "default"): string {
  const rows = withDatabase((db) =>
    db
      .query<InteractionRow, [string]>(
        `SELECT goal, output FROM (
           SELECT id, goal, output, timestamp
           FROM interactions
           WHERE session_id = ?
           ORDER BY timestamp DESC, id DESC
           LIMIT 5
         )
         ORDER BY timestamp ASC, id ASC`,
      )
      .all(sessionId),
  );

  if (!rows.length) return "";
  const summary = rows
    .map(
      (interaction, index) =>
        `Interaction ${index + 1}: Goal ${interaction.goal}, Guidance: ${interaction.output.slice(0, 100)}${interaction.output.length > 100 ? "..." : ""}`,
    )
    .join("\n");
  return summary;
}

/**
 * Append an interaction to `sessionId`'s history and persist.
 * Caps the buffer at 10 entries (oldest dropped first).
 */
export async function addToHistory(
  sessionId: string,
  input: VibeCheckInput,
  output: string,
): Promise<void> {
  withDatabase((db) =>
    db.transaction(() => {
      ensureSession(db, sessionId);
      db.prepare(
        "INSERT INTO interactions (session_id, goal, output, timestamp) VALUES (?, ?, ?, ?)",
      ).run(sessionId, input.goal, output, Date.now());
      pruneSession(db, sessionId);
    })(),
  );
}
