import type Database from "bun:sqlite";
import fs from "node:fs";
import path from "node:path";
import {
  backupLegacyPath,
  getLegacyArtifactPath,
  getLegacyAutosessionDir,
  LEGACY_CONSTITUTION,
  LEGACY_HISTORY,
  LEGACY_LEARNING_LOG,
  readLegacyJson,
} from "./legacyMigration.js";

export { getLegacyArtifactPath } from "./legacyMigration.js";

interface LegacySessionRecord {
  id: string;
  createdAt: string;
  lastAccessedAt: string;
}

interface LegacyLearningEntry {
  type?: string;
  category?: string;
  mistake?: string;
  solution?: string;
  timestamp?: number;
  demoId?: string;
}

interface ImportedLearningEntry {
  type?: string;
  category: string;
  mistake: string;
  solution?: string;
  timestamp: number;
  demoId?: string;
}

interface LegacyInteraction {
  input?: { goal?: string };
  output?: string;
  timestamp?: number;
}

/** Import all legacy JSON artifacts into the SQLite database. */
export function importAllLegacyData(db: Database): void {
  importLegacySessions(db);
  importLegacyLearningEntries(db);
  importLegacyConstitutionRules(db);
  importLegacyInteractions(db);
}

function importLegacySessions(db: Database): void {
  const dir = getLegacyAutosessionDir();
  if (!fs.existsSync(dir)) return;
  let entries: string[];
  try {
    entries = fs.readdirSync(dir).filter((entry) => entry.endsWith(".json"));
  } catch {
    return;
  }

  for (const entry of entries) {
    const filePath = path.join(dir, entry);
    const artifact = `sessions/${entry}`;
    if (isImportComplete(db, artifact)) continue;
    const parsed = readLegacyJson(filePath);
    if (!isLegacySessionRecord(parsed)) continue;
    const cwdKey = path.basename(entry, ".json");

    try {
      db.transaction(() => {
        db.prepare(
          "INSERT OR IGNORE INTO sessions (id, cwd_key, created_at, last_accessed_at) VALUES (?, ?, ?, ?)",
        ).run(parsed.id, cwdKey, parsed.createdAt, parsed.lastAccessedAt);
      })();
      markImportComplete(db, artifact, backupLegacyPath(filePath));
    } catch {}
  }
}

function importLegacyLearningEntries(db: Database): void {
  const filePath = getLegacyArtifactPath(LEGACY_LEARNING_LOG);
  const artifact = LEGACY_LEARNING_LOG;
  if (!fs.existsSync(filePath) || isImportComplete(db, artifact)) return;
  const parsed = readLegacyJson(filePath);
  const entries = extractLearningEntries(parsed);
  if (!entries) return;

  try {
    db.transaction(() => {
      const insert = db.prepare(
        "INSERT OR IGNORE INTO learning_entries (type, category, mistake, solution, timestamp, demo_id) VALUES (?, ?, ?, ?, ?, ?)",
      );
      for (const entry of entries) {
        insert.run(
          entry.type ?? "mistake",
          entry.category,
          entry.mistake,
          entry.solution ?? null,
          entry.timestamp,
          entry.demoId ?? null,
        );
      }
    })();
    markImportComplete(db, artifact, backupLegacyPath(filePath));
  } catch {}
}

function importLegacyConstitutionRules(db: Database): void {
  const filePath = getLegacyArtifactPath(LEGACY_CONSTITUTION);
  const artifact = LEGACY_CONSTITUTION;
  if (!fs.existsSync(filePath) || isImportComplete(db, artifact)) return;
  const parsed = readLegacyJson(filePath);
  if (!isStringArrayRecord(parsed)) return;

  try {
    db.transaction(() => {
      const now = new Date().toISOString();
      const ensureSession = db.prepare(
        "INSERT OR IGNORE INTO sessions (id, cwd_key, created_at, last_accessed_at) VALUES (?, ?, ?, ?)",
      );
      const insertRule = db.prepare(
        "INSERT OR IGNORE INTO constitution_rules (session_id, rule, position, created_at) VALUES (?, ?, ?, ?)",
      );
      for (const [sessionId, rules] of Object.entries(parsed)) {
        ensureSession.run(sessionId, `legacy:${sessionId}`, now, now);
        rules.forEach((rule, position) => {
          insertRule.run(sessionId, rule, position, now);
        });
      }
    })();
    markImportComplete(db, artifact, backupLegacyPath(filePath));
  } catch {}
}

function importLegacyInteractions(db: Database): void {
  const filePath = getLegacyArtifactPath(LEGACY_HISTORY);
  const artifact = LEGACY_HISTORY;
  if (!fs.existsSync(filePath) || isImportComplete(db, artifact)) return;
  const parsed = readLegacyJson(filePath);
  if (!isInteractionRecord(parsed)) return;

  try {
    db.transaction(() => {
      const now = new Date().toISOString();
      const ensureSession = db.prepare(
        "INSERT OR IGNORE INTO sessions (id, cwd_key, created_at, last_accessed_at) VALUES (?, ?, ?, ?)",
      );
      const insertInteraction = db.prepare(
        "INSERT OR IGNORE INTO interactions (session_id, goal, output, timestamp) VALUES (?, ?, ?, ?)",
      );
      for (const [sessionId, interactions] of Object.entries(parsed)) {
        ensureSession.run(sessionId, `legacy:${sessionId}`, now, now);
        for (const interaction of interactions) {
          insertInteraction.run(
            sessionId,
            interaction.input?.goal ?? "",
            interaction.output ?? "",
            interaction.timestamp ?? Date.now(),
          );
        }
      }
    })();
    markImportComplete(db, artifact, backupLegacyPath(filePath));
  } catch {}
}

function isImportComplete(db: Database, artifact: string): boolean {
  return Boolean(
    db
      .query("SELECT 1 FROM legacy_imports WHERE artifact = ? LIMIT 1")
      .get(artifact),
  );
}

function markImportComplete(
  db: Database,
  artifact: string,
  backupPath: string,
): void {
  db.prepare(
    "INSERT OR IGNORE INTO legacy_imports (artifact, imported_at, backup_path) VALUES (?, ?, ?)",
  ).run(artifact, new Date().toISOString(), backupPath);
}

function isLegacySessionRecord(value: unknown): value is LegacySessionRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<LegacySessionRecord>;
  return (
    typeof record.id === "string" &&
    record.id.length > 0 &&
    typeof record.createdAt === "string" &&
    !Number.isNaN(Date.parse(record.createdAt)) &&
    typeof record.lastAccessedAt === "string" &&
    !Number.isNaN(Date.parse(record.lastAccessedAt))
  );
}

function extractLearningEntries(
  value: unknown,
): ImportedLearningEntry[] | null {
  if (!value || typeof value !== "object") return null;
  const log = value as { mistakes?: unknown };
  if (!log.mistakes || typeof log.mistakes !== "object") return null;
  const entries: ImportedLearningEntry[] = [];
  for (const [category, data] of Object.entries(log.mistakes)) {
    if (!data || typeof data !== "object") return null;
    const examples = (data as { examples?: unknown }).examples;
    if (!Array.isArray(examples)) return null;
    for (const example of examples) {
      if (!example || typeof example !== "object") return null;
      const entry = example as LegacyLearningEntry;
      if (
        typeof entry.mistake !== "string" ||
        typeof entry.timestamp !== "number" ||
        (entry.type !== undefined &&
          !["mistake", "preference", "success"].includes(entry.type)) ||
        (entry.solution !== undefined && typeof entry.solution !== "string") ||
        (entry.demoId !== undefined && typeof entry.demoId !== "string")
      ) {
        return null;
      }
      entries.push({
        ...(entry.type !== undefined && { type: entry.type }),
        category: entry.category ?? category,
        mistake: entry.mistake,
        ...(entry.solution !== undefined && { solution: entry.solution }),
        timestamp: entry.timestamp,
        ...(entry.demoId !== undefined && { demoId: entry.demoId }),
      });
    }
  }
  return entries;
}

function isStringArrayRecord(
  value: unknown,
): value is Record<string, string[]> {
  if (!value || typeof value !== "object") return false;
  return Object.values(value).every(
    (rules) =>
      Array.isArray(rules) && rules.every((rule) => typeof rule === "string"),
  );
}

function isInteractionRecord(
  value: unknown,
): value is Record<string, LegacyInteraction[]> {
  if (!value || typeof value !== "object") return false;
  return Object.values(value).every(
    (interactions) =>
      Array.isArray(interactions) &&
      interactions.every(
        (interaction) =>
          interaction &&
          typeof interaction === "object" &&
          typeof (interaction as LegacyInteraction).input?.goal === "string" &&
          typeof (interaction as LegacyInteraction).output === "string" &&
          typeof (interaction as LegacyInteraction).timestamp === "number",
      ),
  );
}
