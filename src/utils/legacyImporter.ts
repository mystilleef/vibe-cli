import type Database from "bun:sqlite";
import fs from "node:fs";
import path from "node:path";
import { LEARNING_TYPES } from "./learningEntryCore.js";
import {
  backupLegacyPath,
  getLegacyArtifactPath,
  getLegacyAutosessionDir,
  LEGACY_CONSTITUTION,
  LEGACY_HISTORY,
  LEGACY_LEARNING_LOG,
  readLegacyJson,
} from "./legacyMigration.js";
import { ensureSessionRow } from "./sessionRows.js";

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

interface ValidatedLegacyLearningEntry extends LegacyLearningEntry {
  mistake: string;
  timestamp: number;
}

interface ImportedLearningEntry {
  type?: string;
  category: string;
  observation: string;
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

interface LegacyArtifactImport<T> {
  filePath: string;
  artifact: string;
  /** Parses raw JSON into the artifact shape; `null` skips the artifact. */
  parse: (value: unknown) => T | null;
  /** Transaction body applying one validated artifact. */
  apply: (data: T) => void;
}

/**
 * Import one artifact idempotently. Recorded artifacts and unparsable
 * sources skip untouched; a successful apply commits in one immediate
 * transaction and records the renamed backup. Failures never abort later
 * artifacts and leave no completion record, so a later run can retry.
 */
function importLegacyArtifact<T>(
  db: Database,
  spec: LegacyArtifactImport<T>,
): void {
  if (isImportComplete(db, spec.artifact)) return;
  const parsed = spec.parse(readLegacyJson(spec.filePath));
  if (parsed === null) return;
  try {
    db.transaction(() => spec.apply(parsed)).immediate();
    markImportComplete(db, spec.artifact, backupLegacyPath(spec.filePath));
  } catch {}
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
    const cwdKey = path.basename(entry, ".json");
    importLegacyArtifact(db, {
      filePath,
      artifact: `sessions/${entry}`,
      parse: parseLegacySessionRecord,
      apply: (session) => {
        ensureSessionRow(db, {
          id: session.id,
          cwdKey,
          createdAt: session.createdAt,
          lastAccessedAt: session.lastAccessedAt,
        });
      },
    });
  }
}

function importLegacyLearningEntries(db: Database): void {
  const filePath = getLegacyArtifactPath(LEGACY_LEARNING_LOG);
  if (!fs.existsSync(filePath)) return;
  importLegacyArtifact(db, {
    filePath,
    artifact: LEGACY_LEARNING_LOG,
    parse: extractLearningEntries,
    apply: (entries) => {
      const insert = db.query(
        "INSERT OR IGNORE INTO learning_entries (type, category, observation, solution, timestamp, demo_id) VALUES (?, ?, ?, ?, ?, ?)",
      );
      for (const entry of entries) {
        insert.run(
          entry.type ?? "mistake",
          entry.category,
          entry.observation,
          entry.solution ?? null,
          entry.timestamp,
          entry.demoId ?? null,
        );
      }
    },
  });
}

function importLegacyConstitutionRules(db: Database): void {
  const filePath = getLegacyArtifactPath(LEGACY_CONSTITUTION);
  if (!fs.existsSync(filePath)) return;
  importLegacyArtifact(db, {
    filePath,
    artifact: LEGACY_CONSTITUTION,
    parse: parseStringArrayRecord,
    apply: (rulesBySession) => {
      const now = new Date().toISOString();
      const insertRule = db.query(
        "INSERT OR IGNORE INTO constitution_rules (session_id, rule, position, created_at) VALUES (?, ?, ?, ?)",
      );
      for (const [sessionId, rules] of Object.entries(rulesBySession)) {
        ensureSessionRow(db, {
          id: sessionId,
          cwdKey: legacySessionCwdKey(sessionId),
          createdAt: now,
        });
        rules.forEach((rule, position) => {
          insertRule.run(sessionId, rule, position, now);
        });
      }
    },
  });
}

function importLegacyInteractions(db: Database): void {
  const filePath = getLegacyArtifactPath(LEGACY_HISTORY);
  if (!fs.existsSync(filePath)) return;
  importLegacyArtifact(db, {
    filePath,
    artifact: LEGACY_HISTORY,
    parse: parseInteractionRecord,
    apply: (interactionsBySession) => {
      const now = new Date().toISOString();
      const insertInteraction = db.query(
        "INSERT OR IGNORE INTO interactions (session_id, goal, output, timestamp) VALUES (?, ?, ?, ?)",
      );
      for (const [sessionId, interactions] of Object.entries(
        interactionsBySession,
      )) {
        ensureSessionRow(db, {
          id: sessionId,
          cwdKey: legacySessionCwdKey(sessionId),
          createdAt: now,
        });
        for (const interaction of interactions) {
          insertInteraction.run(
            sessionId,
            interaction.input?.goal ?? "",
            interaction.output ?? "",
            interaction.timestamp ?? Date.now(),
          );
        }
      }
    },
  });
}

/** Session key namespace for rows anchored by legacy imports. */
function legacySessionCwdKey(sessionId: string): string {
  return `legacy:${sessionId}`;
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
  db.query(
    "INSERT OR IGNORE INTO legacy_imports (artifact, imported_at, backup_path) VALUES (?, ?, ?)",
  ).run(artifact, new Date().toISOString(), backupPath);
}

function parseLegacySessionRecord(value: unknown): LegacySessionRecord | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Partial<LegacySessionRecord>;
  if (
    typeof record.id !== "string" ||
    record.id.length === 0 ||
    typeof record.createdAt !== "string" ||
    Number.isNaN(Date.parse(record.createdAt)) ||
    typeof record.lastAccessedAt !== "string" ||
    Number.isNaN(Date.parse(record.lastAccessedAt))
  ) {
    return null;
  }
  return record as LegacySessionRecord;
}

export function validateLegacyLearningEntry(
  entry: unknown,
): ValidatedLegacyLearningEntry | null {
  if (!entry || typeof entry !== "object") return null;
  const e = entry as LegacyLearningEntry;
  if (
    typeof e.mistake !== "string" ||
    typeof e.timestamp !== "number" ||
    (e.type !== undefined &&
      !LEARNING_TYPES.some((candidate) => candidate === e.type)) ||
    (e.solution !== undefined && typeof e.solution !== "string") ||
    (e.demoId !== undefined && typeof e.demoId !== "string")
  ) {
    return null;
  }
  return e as ValidatedLegacyLearningEntry;
}

export function mapLegacyEntry(
  entry: ValidatedLegacyLearningEntry,
  category: string,
): ImportedLearningEntry {
  return {
    ...(entry.type !== undefined && { type: entry.type }),
    category: entry.category ?? category,
    observation: entry.mistake,
    ...(entry.solution !== undefined && { solution: entry.solution }),
    timestamp: entry.timestamp,
    ...(entry.demoId !== undefined && { demoId: entry.demoId }),
  };
}

export function extractCategoryEntries(
  category: string,
  data: unknown,
): ImportedLearningEntry[] | null {
  if (!data || typeof data !== "object") return null;
  const examples = (data as { examples?: unknown }).examples;
  if (!Array.isArray(examples)) return null;
  const entries: ImportedLearningEntry[] = [];
  for (const example of examples) {
    const validated = validateLegacyLearningEntry(example);
    if (!validated) return null;
    entries.push(mapLegacyEntry(validated, category));
  }
  return entries;
}

export function extractLearningEntries(
  value: unknown,
): ImportedLearningEntry[] | null {
  if (!value || typeof value !== "object") return null;
  const log = value as { mistakes?: unknown };
  if (!log.mistakes || typeof log.mistakes !== "object") return null;
  const entries: ImportedLearningEntry[] = [];
  for (const [category, data] of Object.entries(log.mistakes)) {
    const categoryEntries = extractCategoryEntries(category, data);
    if (!categoryEntries) return null;
    entries.push(...categoryEntries);
  }
  return entries;
}

function parseStringArrayRecord(
  value: unknown,
): Record<string, string[]> | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, string[]>;
  const valid = Object.values(record).every(
    (rules) =>
      Array.isArray(rules) && rules.every((rule) => typeof rule === "string"),
  );
  return valid ? record : null;
}

function parseInteractionRecord(
  value: unknown,
): Record<string, LegacyInteraction[]> | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, LegacyInteraction[]>;
  const valid = Object.values(record).every(
    (interactions) =>
      Array.isArray(interactions) &&
      interactions.every(
        (interaction) =>
          interaction &&
          typeof interaction === "object" &&
          typeof interaction.input?.goal === "string" &&
          typeof interaction.output === "string" &&
          typeof interaction.timestamp === "number",
      ),
  );
  return valid ? record : null;
}
