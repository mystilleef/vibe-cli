import { compareListText, groupBy } from "./listDataUtilsCollections.js";

/** Core types, constants, and pure functions shared across storage and prune modules. */

/** Full column list for `learning_entries` SELECT statements. */
export const LEARNING_ENTRIES_COLUMNS =
  "id, type, category, observation, solution, timestamp, demo_id";

/** Full `SELECT ... FROM learning_entries` fragment shared by readers. */
export const LEARNING_ENTRIES_SELECT = `SELECT ${LEARNING_ENTRIES_COLUMNS} FROM learning_entries`;

/** Deterministic default ordering for learning entry reads (category, then age, then id). */
export const LEARNING_ENTRIES_ORDER = "ORDER BY category, timestamp, id";

/** Discriminator for the kind of learning entry. */
export type LearningType = "mistake" | "preference" | "success";

/** Canonical ordered tuple of all learning types for validation. */
export const LEARNING_TYPES: readonly LearningType[] = [
  "mistake",
  "preference",
  "success",
];

/**
 * A single persisted learning record.
 *
 * @property type - Entry kind; defaults to `mistake` when callers omit it.
 * @property category - Grouping label (may be normalized by the caller).
 * @property observation - One-sentence description of the pattern or observation.
 * @property solution - Resolution text; required for mistake/success, optional for preference.
 * @property timestamp - Epoch-ms when the entry was written.
 * @property demoId - Optional identifier linking the entry to a demo session.
 */
export interface LearningEntry {
  type: LearningType;
  category: string;
  observation: string;
  solution?: string;
  timestamp: number;
  demoId?: string;
}

export const DAY_MS = 24 * 60 * 60 * 1000;

export const DEFAULT_LEARNING_DUPLICATE_OVERLAP_THRESHOLD = 0.6;

export interface LearningEntryStorageRow {
  id: number;
  type: LearningType;
  category: string;
  observation: string;
  solution: string | null;
  timestamp: number;
  demo_id: string | null;
}

export function learningRowToEntry(
  row: LearningEntryStorageRow,
): LearningEntry {
  const entry: LearningEntry = {
    type: row.type,
    category: row.category,
    observation: row.observation,
    timestamp: row.timestamp,
  };
  if (row.solution !== null) entry.solution = row.solution;
  if (row.demo_id !== null) entry.demoId = row.demo_id;
  return entry;
}

/** Deterministic comparator for learning entry storage rows: timestamp, category, id. */
export function compareLearningEntryOrder(
  left: LearningEntryStorageRow,
  right: LearningEntryStorageRow,
): number {
  return (
    left.timestamp - right.timestamp ||
    left.category.localeCompare(right.category) ||
    left.id - right.id
  );
}

export function getLearningOverlapScore(left: string, right: string): number {
  const leftWords = left.toLowerCase().split(/\W+/).filter(Boolean);
  const rightWords = right.toLowerCase().split(/\W+/).filter(Boolean);
  if (!leftWords.length || !rightWords.length) return 0;
  const overlap = leftWords.filter((word) => rightWords.includes(word));
  return overlap.length / Math.min(leftWords.length, rightWords.length);
}

/**
 * Return whether two learning descriptions meet the duplicate threshold.
 *
 * `overlapThreshold === 0` includes zero-score pairs because every overlap
 * score satisfies `score >= 0`.
 */
export function isLearningOverlapDuplicate(
  left: string,
  right: string,
  overlapThreshold = DEFAULT_LEARNING_DUPLICATE_OVERLAP_THRESHOLD,
): boolean {
  return getLearningOverlapScore(left, right) >= overlapThreshold;
}

/** A single category's aggregate view over learning entries. */
export interface LearningCategorySummary {
  category: string;
  count: number;
  recentExample: LearningEntry;
}

/** Build category summaries from already-grouped learning entries. */
export function summarizeLearningCategoryGroups(
  groups: Iterable<[string, readonly LearningEntry[]]>,
): LearningCategorySummary[] {
  return [...groups]
    .flatMap(([category, entries]) => {
      const recentExample = entries.at(-1);
      return recentExample === undefined
        ? []
        : [{ category, count: entries.length, recentExample }];
    })
    .sort(
      (left, right) =>
        right.count - left.count ||
        compareListText(left.category, right.category),
    );
}

/** Build category summaries from a learning list without additional IO. */
export function summarizeLearningCategories(
  learnings: readonly LearningEntry[],
): LearningCategorySummary[] {
  return summarizeLearningCategoryGroups(groupBy(learnings, (e) => e.category));
}
