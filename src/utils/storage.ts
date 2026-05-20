import fs from "node:fs";
import path from "node:path";
import { ensureDataDir, getDataRoot } from "./autosession.js";

/** Return the absolute path to the learning log (`~/.vibe-cli/vibe-log.json`). */
function getLogFile(): string {
  return path.join(getDataRoot(), "vibe-log.json");
}

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

/**
 * Top-level on-disk schema for `vibe-log.json`.
 *
 * `mistakes` is keyed by category; each value holds a running `count`, the
 * full `examples` array, and a `lastUpdated` epoch-ms.  The root
 * `lastUpdated` tracks the most recent write to any category.
 */
interface VibeLog {
  mistakes: Record<
    string,
    { count: number; examples: LearningEntry[]; lastUpdated: number }
  >;
  lastUpdated: number;
}

/** Produce a blank log used when no file exists or the file is corrupt. */
function freshLog(): VibeLog {
  return { mistakes: {}, lastUpdated: Date.now() };
}

/**
 * Read and parse the log file, creating it on first access.
 *
 * Returns a fresh log without writing back when the file contains invalid
 * JSON, so callers always receive a valid structure even on corruption.
 */
function readLogFile(): VibeLog {
  ensureDataDir();
  const logFile = getLogFile();
  if (!fs.existsSync(logFile)) {
    const log = freshLog();
    writeLogFile(log);
    return log;
  }
  try {
    return JSON.parse(fs.readFileSync(logFile, "utf8")) as VibeLog;
  } catch {
    return freshLog();
  }
}

/**
 * Serialize the log to disk.
 *
 * Swallows write errors (logs to stderr) so callers never throw on disk
 * failures.
 */
function writeLogFile(data: VibeLog): void {
  ensureDataDir();
  try {
    fs.writeFileSync(getLogFile(), JSON.stringify(data, null, 2), "utf8");
  } catch (error) {
    console.error("Error writing vibe log:", error);
  }
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
  const log = readLogFile();
  const now = Date.now();
  const entry: LearningEntry = {
    type,
    category,
    mistake,
    ...(solution !== undefined && { solution }),
    timestamp: now,
    ...(demoId !== undefined && { demoId }),
  };

  if (!log.mistakes[category]) {
    log.mistakes[category] = { count: 0, examples: [], lastUpdated: now };
  }
  log.mistakes[category].count += 1;
  log.mistakes[category].examples.push(entry);
  log.mistakes[category].lastUpdated = now;
  log.lastUpdated = now;
  writeLogFile(log);
  return entry;
}

/**
 * Return every learning entry grouped by category.
 *
 * Keys are category names; values are the full entry arrays.  Returns `{}`
 * when the log is empty or was just created.
 */
export function getLearningEntries(): Record<string, LearningEntry[]> {
  const log = readLogFile();
  return Object.fromEntries(
    Object.entries(log.mistakes).map(([cat, data]) => [cat, data.examples]),
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
  const log = readLogFile();
  return Object.entries(log.mistakes)
    .flatMap(([category, data]) => {
      const recentExample = data.examples.at(-1);
      return recentExample === undefined
        ? []
        : [
            {
              category,
              count: data.count,
              recentExample,
            },
          ];
    })
    .sort((a, b) => b.count - a.count);
}

/**
 * Rewrite the log keeping only entries that satisfy `filterEntry`.
 *
 * Deletes categories that become empty and recalculates `count` and
 * `lastUpdated` for survivors.  Used internally by the public removal
 * functions.
 */
function rewriteLearningLog(
  filterEntry: (entry: LearningEntry) => boolean,
): void {
  const log = readLogFile();
  for (const cat of Object.keys(log.mistakes)) {
    const data = log.mistakes[cat];
    if (!data) continue;
    data.examples = data.examples.filter(filterEntry);
    if (data.examples.length === 0) {
      delete log.mistakes[cat];
    } else {
      data.count = data.examples.length;
      data.lastUpdated = Math.max(...data.examples.map((e) => e.timestamp));
    }
  }
  log.lastUpdated = Date.now();
  writeLogFile(log);
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
  rewriteLearningLog((entry) => entry.timestamp < timestamp);
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
  rewriteLearningLog((entry) => entry.demoId !== demoId);
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
  const log = readLogFile();
  return Object.entries(log.mistakes)
    .map(([category, data]) => {
      const examples = [...data.examples]
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
      return `Category: ${category} (count: ${data.count})\n${examples}`;
    })
    .join("\n\n")
    .trim();
}
