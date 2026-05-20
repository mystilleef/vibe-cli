/**
 * Per-session constitution rule storage.
 *
 * Rules persist to `~/.vibe-cli/constitution.json`, keyed by autosession id.
 * Each session holds at most 50 rules; oldest rules drop first when full.
 */
import fs from "node:fs";
import path from "node:path";
import {
  ensureDataDir,
  getDataRoot,
  resolveAutosession,
} from "../utils/autosession.js";

function getConstitutionFile(): string {
  return path.join(getDataRoot(), "constitution.json");
}
const MAX_RULES = 50;

type Store = Record<string, string[]>;

function read(): Store {
  ensureDataDir();
  try {
    return JSON.parse(fs.readFileSync(getConstitutionFile(), "utf8")) as Store;
  } catch {
    return {};
  }
}

function write(store: Store): void {
  ensureDataDir();
  fs.writeFileSync(
    getConstitutionFile(),
    JSON.stringify(store, null, 2),
    "utf8",
  );
}

function resolveSessionId(): string {
  return resolveAutosession().id;
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
  const store = read();
  const rules = store[resolvedSessionId] ?? [];
  if (rules.length >= MAX_RULES) rules.shift();
  rules.push(rule);
  store[resolvedSessionId] = rules;
  write(store);
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
  const store = read();
  store[resolvedSessionId] = rules.slice(0, MAX_RULES);
  write(store);
}

/**
 * Return the active autosession constitution rules.
 *
 * Missing, unreadable, or malformed storage resolves to an empty rule list.
 */
export function getConstitution(): string[] {
  return read()[resolveSessionId()] ?? [];
}

/**
 * Return the autosession id used as the constitution storage key.
 *
 * Returns an empty string when no autosession can be resolved.
 */
export function getCurrentConstitutionSessionId(): string {
  return resolveAutosession().id;
}
