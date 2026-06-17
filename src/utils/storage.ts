import { withDatabase } from "./database.js";
import {
  LEARNING_ENTRIES_COLUMNS,
  LEARNING_ENTRIES_ORDER,
  LEARNING_ENTRIES_SELECT,
  type LearningCategorySummary,
  type LearningEntry,
  type LearningEntryStorageRow,
  type LearningType,
  learningRowToEntry,
  summarizeLearningCategoryGroups,
} from "./learningEntryCore.js";
import { groupBy } from "./listDataUtilsCollections.js";

export {
  DEFAULT_LEARNING_DUPLICATE_OVERLAP_THRESHOLD,
  isLearningOverlapDuplicate,
  type LearningEntry,
  type LearningType,
} from "./learningEntryCore.js";
export {
  collectPruneCandidates,
  executeDestructivePrune,
} from "./pruneStorage.js";

/**
 * Append a learning entry to the log under `category`.
 *
 * Increments the category counter and returns the persisted entry.  Creates
 * the category if it does not yet exist.
 *
 * @param observation - One-sentence pattern description.
 * @param category - Grouping label (callers should normalize beforehand).
 * @param solution - Resolution text; omit for preference entries.
 * @param type - Entry kind; defaults to `"mistake"`.
 * @param demoId - Optional demo-session identifier.
 * @returns The entry as written, including its `timestamp`.
 */
export function addLearningEntry(
  observation: string,
  category: string,
  solution?: string,
  type: LearningType = "mistake",
  demoId?: string,
): LearningEntry {
  const now = Date.now();
  withDatabase((db) =>
    db
      .prepare(
        "INSERT INTO learning_entries (type, category, observation, solution, timestamp, demo_id) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(type, category, observation, solution ?? null, now, demoId ?? null),
  );
  return {
    type,
    category,
    observation,
    ...(solution !== undefined && { solution }),
    timestamp: now,
    ...(demoId !== undefined && { demoId }),
  };
}

/**
 * Return every learning entry grouped by category.
 *
 * When `maxPerCategory` is provided, each category returns at most its
 * `maxPerCategory` most-recent entries (via SQL window function) to avoid
 * full-table scans on large learning stores.
 *
 * Keys are category names; values are the full entry arrays.  Returns `{}`
 * when the log is empty or was just created.
 */
export function getLearningEntries(
  maxPerCategory?: number,
): Record<string, LearningEntry[]> {
  const entries = withDatabase((db) => {
    const rows =
      maxPerCategory === undefined
        ? db
            .query<LearningEntryStorageRow, []>(
              `${LEARNING_ENTRIES_SELECT} ${LEARNING_ENTRIES_ORDER}`,
            )
            .all()
        : db
            .query<LearningEntryStorageRow, [number]>(
              `SELECT ${LEARNING_ENTRIES_COLUMNS}
               FROM (
                 SELECT *,
                   ROW_NUMBER() OVER (
                     PARTITION BY category ORDER BY timestamp DESC, id DESC
                   ) AS rn
                 FROM learning_entries
               )
               WHERE rn <= ?
               ${LEARNING_ENTRIES_ORDER}`,
            )
            .all(maxPerCategory);
    return rows.map(learningRowToEntry);
  });
  return Object.fromEntries(groupBy(entries, (entry) => entry.category));
}

/**
 * Return a summary of each category sorted by count descending.
 *
 * Each item exposes the category name, its total count, and the most recent
 * example entry.  Empty categories (no examples after removal) are omitted.
 */
export function getLearningCategorySummary(): LearningCategorySummary[] {
  return summarizeLearningCategoryGroups(Object.entries(getLearningEntries()));
}

/**
 * Remove all entries associated with a specific demo session.
 *
 * Entries without a `demoId` or with a different `demoId` are kept.
 * Empty categories are pruned automatically.
 *
 * @param demoId - The demo identifier whose entries should be removed.
 */
export function removeLearningEntriesForDemo(demoId: string): void {
  withDatabase((db) =>
    db.prepare("DELETE FROM learning_entries WHERE demo_id = ?").run(demoId),
  );
}

/**
 * Remove all demo entries from crashed runs.
 *
 * Clears stale entries whose `demo_id` is non-null, preventing
 * `isSimilar()` suppression in subsequent demo executions.
 */
export function removeStaleDemoEntries(): void {
  withDatabase((db) =>
    db.prepare("DELETE FROM learning_entries WHERE demo_id IS NOT NULL").run(),
  );
}

/**
 * Format the learning log as plain text suitable for LLM context injection.
 *
 * Each category becomes a block headed by `Category: <name> (count: N)`
 * followed by bullet entries labeled `[Mistake]`, `[Preference]`, or
 * `[Success]`.  Solution text is appended when present.
 *
 * Categories are separated by blank lines.  Returns `""` when the log is
 * empty.
 *
 * @param maxPerCategory - Maximum entries per category (most recent first);
 *   defaults to 5.  The per-category limit is pushed into SQL via
 *   `ROW_NUMBER()` to avoid full-table scans on large learning stores.
 */
export function getLearningContextText(maxPerCategory = 5): string {
  const categoryCounts = withDatabase((db) => {
    const rows = db
      .query<{ category: string; count: number }, []>(
        "SELECT category, COUNT(*) AS count FROM learning_entries GROUP BY category",
      )
      .all();
    return new Map(rows.map((r) => [r.category, r.count]));
  });

  return Object.entries(getLearningEntries(maxPerCategory))
    .map(([category, examples]) => {
      const count = categoryCounts.get(category) ?? examples.length;
      const text = [...examples]
        .sort((a, b) => a.timestamp - b.timestamp)
        .map((ex) => {
          const label =
            ex.type === "mistake"
              ? "Mistake"
              : ex.type === "preference"
                ? "Preference"
                : "Success";
          const sol = ex.solution ? ` | Solution: ${ex.solution}` : "";
          return `- [${label}] ${ex.observation}${sol}`;
        })
        .join("\n");
      return `Category: ${category} (count: ${count})\n${text}`;
    })
    .join("\n\n")
    .trim();
}
