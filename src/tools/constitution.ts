/**
 * Per-session constitution rule storage.
 *
 * Rules persist to SQLite, keyed by autosession id. Each session holds at most
 * 50 rules; oldest rules drop first when full.
 */
import { resolveAutosession } from "../utils/autosession.js";
import { withDatabase } from "../utils/database.js";

const MAX_RULES = 50;

interface RuleRow {
  rule: string;
}

function resolveSessionId(): string {
  return resolveAutosession().id;
}

function getSessionRules(sessionId: string): string[] {
  return withDatabase((db) =>
    db
      .query<RuleRow, [string]>(
        "SELECT rule FROM constitution_rules WHERE session_id = ? ORDER BY position ASC",
      )
      .all(sessionId)
      .map((row) => row.rule),
  );
}

function replaceSessionRules(sessionId: string, rules: string[]): void {
  withDatabase((db) =>
    db.transaction(() => {
      db.prepare("DELETE FROM constitution_rules WHERE session_id = ?").run(
        sessionId,
      );
      const insert = db.prepare(
        "INSERT INTO constitution_rules (session_id, rule, position, created_at) VALUES (?, ?, ?, ?)",
      );
      const timestamp = new Date().toISOString();
      rules.slice(0, MAX_RULES).forEach((rule, position) => {
        insert.run(sessionId, rule, position, timestamp);
      });
    })(),
  );
}

/**
 * Append a rule to the active autosession constitution.
 *
 * Empty rules perform no write. The persisted rule list retains at most the
 * most recent 50 entries, dropping the oldest entry before appending when full.
 */
export function updateConstitution(rule: string): void {
  const resolvedSessionId = resolveSessionId();
  if (!resolvedSessionId || !rule) return;
  const rules = getSessionRules(resolvedSessionId);
  if (rules.length >= MAX_RULES) rules.shift();
  rules.push(rule);
  replaceSessionRules(resolvedSessionId, rules);
}

/**
 * Replace the active autosession constitution.
 *
 * Passing an empty array clears the session rules. Only the first 50 rules
 * persist, matching the storage limit enforced by incremental updates.
 */
export function resetConstitution(rules: string[]): void {
  const resolvedSessionId = resolveSessionId();
  if (!resolvedSessionId) return;
  replaceSessionRules(resolvedSessionId, rules);
}

/** Return the active autosession constitution rules. */
export function getConstitution(): string[] {
  return getSessionRules(resolveSessionId());
}

/** Return the autosession id used as the constitution storage key. */
export function getCurrentConstitutionSessionId(): string {
  return resolveAutosession().id;
}
