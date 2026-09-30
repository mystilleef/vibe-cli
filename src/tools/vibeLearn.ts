import type {
  LearningEntry,
  LearningType,
} from "../utils/learningEntryCore.js";
import {
  addLearningEntry,
  getLearningCategorySummary,
  getLearningEntries,
  isLearningOverlapDuplicate,
} from "../utils/storage.js";

/** Input for recording an agent learning pattern. */
export interface VibeLearnInput {
  /** Pattern text; stored as the first sentence and required for every entry. */
  observation: string;
  /** Category label; known aliases normalize to canonical learning categories. */
  category: string;
  /** Required resolution text for mistake and success entries. */
  solution?: string;
  /** Learning entry kind; defaults to `mistake`. */
  type?: LearningType;
  /** Optional demo identifier preserved with the stored learning entry. */
  demoId?: string;
}

/** Result of attempting to record a learning pattern. */
export interface VibeLearnOutput {
  /** True when a new entry was written; false when an existing entry overlaps. */
  added: boolean;
  /** Count for the normalized category after the attempt. */
  categoryCount: number;
  /** True when an existing entry overlaps enough to suppress a duplicate write. */
  alreadyKnown?: boolean;
  /** Up to three most frequent categories, ordered by stored count descending. */
  topCategories: Array<{
    category: string;
    count: number;
    recentExample: LearningEntry;
  }>;
}

/**
 * Record a mistake, preference, or success pattern in the local learning log.
 *
 * Preferences may omit `solution`; mistake and success entries require it. The
 * tool normalizes text to one sentence, canonicalizes known category aliases,
 * and suppresses similar entries. Blank required text and storage faults
 * throw.
 */
export async function vibeLearnTool(
  input: VibeLearnInput,
): Promise<VibeLearnOutput> {
  if (!hasText(input.observation)) {
    throw new Error("--observation is required");
  }
  if (!hasText(input.category)) throw new Error("--category is required");

  const entryType: LearningType = input.type ?? "mistake";
  if (entryType !== "preference" && !hasText(input.solution)) {
    throw new Error("--solution is required for mistake and success types");
  }

  const observation = enforceOneSentence(input.observation);
  const solution = hasText(input.solution)
    ? enforceOneSentence(input.solution)
    : undefined;
  const category = normalizeCategory(input.category);

  const existing = getLearningEntries()[category] || [];
  const alreadyKnown = existing.some((e) =>
    isLearningOverlapDuplicate(e.observation, observation),
  );

  if (!alreadyKnown) {
    addLearningEntry(observation, category, solution, entryType, input.demoId);
  }

  const categorySummary = getLearningCategorySummary();
  const categoryData = categorySummary.find((m) => m.category === category);

  return {
    added: !alreadyKnown,
    alreadyKnown,
    categoryCount: categoryData?.count ?? 1,
    topCategories: categorySummary.slice(0, 3),
  };
}

function hasText(value: string | undefined): value is string {
  return Boolean(value?.trim());
}

// UAX #29 boundaries keep periods inside versions, paths, and identifiers
// (`1.3.14`, `database.ts`, `db.transaction`) from ending the sentence.
const sentenceSegmenter = new Intl.Segmenter("en", { granularity: "sentence" });

function enforceOneSentence(text: string): string {
  const cleaned = text.replace(/\r?\n/g, " ").trim();
  const [first] = sentenceSegmenter.segment(cleaned);
  const sentence = first?.segment.trim() ?? "";
  return /[.!?]["')\]]*$/.test(sentence) ? sentence : `${sentence}.`;
}

const CATEGORY_ALIASES: Record<string, string[]> = {
  "Complex Solution Bias": [
    "complex",
    "complicated",
    "over-engineered",
    "complexity",
  ],
  "Feature Creep": ["feature", "extra", "additional", "scope creep"],
  "Premature Implementation": ["premature", "early", "jumping", "too quick"],
  Misalignment: [
    "misaligned",
    "wrong direction",
    "off target",
    "misunderstood",
  ],
  Overtooling: ["overtool", "too many tools", "unnecessary tools"],
};

function normalizeCategory(category: string): string {
  const lower = category.toLowerCase();
  for (const [name, keywords] of Object.entries(CATEGORY_ALIASES)) {
    if (keywords.some((k) => lower.includes(k))) return name;
  }
  return category;
}
