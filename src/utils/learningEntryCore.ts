/** Core types, constants, and pure functions shared across storage and prune modules. */

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
  return {
    type: row.type,
    category: row.category,
    observation: row.observation,
    ...(row.solution !== null && { solution: row.solution }),
    timestamp: row.timestamp,
    ...(row.demo_id !== null && { demoId: row.demo_id }),
  };
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
