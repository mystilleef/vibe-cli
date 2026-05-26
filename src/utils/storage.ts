import { withDatabase } from "./database.js";

/** Discriminator for the kind of learning entry. */
export type LearningType = "mistake" | "preference" | "success";

/**
 * A single persisted learning record.
 *
 * @property type - Entry kind; defaults to `mistake` when callers omit it.
 * @property category - Grouping label (may be normalized by the caller).
 * @property mistake - One-sentence description of the pattern or error.
 * @property solution - Resolution text; required for mistake/success, optional for preference.
 * @property timestamp - Epoch-ms when the entry was written.
 * @property demoId - Optional identifier linking the entry to a demo session.
 */
export interface LearningEntry {
  type: LearningType;
  category: string;
  mistake: string;
  solution?: string;
  timestamp: number;
  demoId?: string;
}

interface LearningRow {
  type: LearningType;
  category: string;
  mistake: string;
  solution: string | null;
  timestamp: number;
  demo_id: string | null;
}

function rowToEntry(row: LearningRow): LearningEntry {
  return {
    type: row.type,
    category: row.category,
    mistake: row.mistake,
    ...(row.solution !== null && { solution: row.solution }),
    timestamp: row.timestamp,
    ...(row.demo_id !== null && { demoId: row.demo_id }),
  };
}

function readLearningEntries(): LearningEntry[] {
  return withDatabase((db) =>
    db
      .query<LearningRow, []>(
        "SELECT type, category, mistake, solution, timestamp, demo_id FROM learning_entries ORDER BY category, timestamp, id",
      )
      .all()
      .map(rowToEntry),
  );
}

/**
 * Append a learning entry to the log under `category`.
 *
 * Increments the category counter and returns the persisted entry.  Creates
 * the category if it does not yet exist.
 *
 * @param mistake - One-sentence pattern description.
 * @param category - Grouping label (callers should normalize beforehand).
 * @param solution - Resolution text; omit for preference entries.
 * @param type - Entry kind; defaults to `"mistake"`.
 * @param demoId - Optional demo-session identifier.
 * @returns The entry as written, including its `timestamp`.
 */
export function addLearningEntry(
  mistake: string,
  category: string,
  solution?: string,
  type: LearningType = "mistake",
  demoId?: string,
): LearningEntry {
  const now = Date.now();
  withDatabase((db) =>
    db
      .prepare(
        "INSERT INTO learning_entries (type, category, mistake, solution, timestamp, demo_id) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(type, category, mistake, solution ?? null, now, demoId ?? null),
  );
  return {
    type,
    category,
    mistake,
    ...(solution !== undefined && { solution }),
    timestamp: now,
    ...(demoId !== undefined && { demoId }),
  };
}

/**
 * Return every learning entry grouped by category.
 *
 * Keys are category names; values are the full entry arrays.  Returns `{}`
 * when the log is empty or was just created.
 */
export function getLearningEntries(): Record<string, LearningEntry[]> {
  return readLearningEntries().reduce<Record<string, LearningEntry[]>>(
    (grouped, entry) => {
      if (!grouped[entry.category]) grouped[entry.category] = [];
      grouped[entry.category]?.push(entry);
      return grouped;
    },
    {},
  );
}

/**
 * Return a summary of each category sorted by count descending.
 *
 * Each item exposes the category name, its total count, and the most recent
 * example entry.  Empty categories (no examples after removal) are omitted.
 */
export function getLearningCategorySummary(): Array<{
  category: string;
  count: number;
  recentExample: LearningEntry;
}> {
  const grouped = getLearningEntries();
  return Object.entries(grouped)
    .flatMap(([category, examples]) => {
      const recentExample = examples.at(-1);
      return recentExample === undefined
        ? []
        : [{ category, count: examples.length, recentExample }];
    })
    .sort((a, b) => b.count - a.count);
}

/**
 * Remove all entries whose `timestamp` is >= the given cutoff.
 *
 * Intended for rolling back entries written after a known-good point.
 * Empty categories are pruned automatically.
 *
 * @param timestamp - Epoch-ms cutoff; entries at or after this value are removed.
 */
export function removeLearningEntriesAfter(timestamp: number): void {
  withDatabase((db) =>
    db
      .prepare("DELETE FROM learning_entries WHERE timestamp >= ?")
      .run(timestamp),
  );
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
 *   defaults to 5.
 */
export function getLearningContextText(maxPerCategory = 5): string {
  return Object.entries(getLearningEntries())
    .map(([category, examples]) => {
      const text = [...examples]
        .sort((a, b) => a.timestamp - b.timestamp)
        .slice(-maxPerCategory)
        .map((ex) => {
          const label =
            ex.type === "mistake"
              ? "Mistake"
              : ex.type === "preference"
                ? "Preference"
                : "Success";
          const sol = ex.solution ? ` | Solution: ${ex.solution}` : "";
          return `- [${label}] ${ex.mistake}${sol}`;
        })
        .join("\n");
      return `Category: ${category} (count: ${examples.length})\n${text}`;
    })
    .join("\n\n")
    .trim();
}
