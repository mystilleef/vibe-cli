import {
  addLearningEntry,
  getLearningCategorySummary,
  getLearningEntries,
  type LearningEntry,
  type LearningType,
} from "../utils/storage.js";

export interface VibeLearnInput {
  mistake: string;
  category: string;
  solution?: string;
  type?: LearningType;
}

export interface VibeLearnOutput {
  added: boolean;
  currentTally: number;
  alreadyKnown?: boolean;
  topCategories: Array<{
    category: string;
    count: number;
    recentExample: LearningEntry;
  }>;
}

export async function vibeLearnTool(
  input: VibeLearnInput,
): Promise<VibeLearnOutput> {
  try {
    if (!input.mistake) throw new Error("--mistake is required");
    if (!input.category) throw new Error("--category is required");

    const entryType: LearningType = input.type ?? "mistake";
    if (entryType !== "preference" && !input.solution) {
      throw new Error("--solution is required for mistake and success types");
    }

    const mistake = enforceOneSentence(input.mistake);
    const solution = input.solution
      ? enforceOneSentence(input.solution)
      : undefined;
    const category = normalizeCategory(input.category);

    const existing = getLearningEntries()[category] || [];
    const alreadyKnown = existing.some((e) => isSimilar(e.mistake, mistake));

    if (!alreadyKnown) {
      addLearningEntry(mistake, category, solution, entryType);
    }

    const categorySummary = getLearningCategorySummary();
    const categoryData = categorySummary.find((m) => m.category === category);

    return {
      added: !alreadyKnown,
      alreadyKnown,
      currentTally: categoryData?.count ?? 1,
      topCategories: categorySummary.slice(0, 3),
    };
  } catch (error) {
    console.error("vibe_learn error:", error);
    return {
      added: false,
      alreadyKnown: false,
      currentTally: 0,
      topCategories: [],
    };
  }
}

function enforceOneSentence(text: string): string {
  let sentence = text.replace(/\r?\n/g, " ");
  const sentences = sentence.split(/([.!?])\s+/);
  if (sentences.length > 0) {
    sentence = (sentences[0] + (sentences[1] || "")).trim();
  }
  if (!/[.!?]$/.test(sentence)) sentence += ".";
  return sentence;
}

function isSimilar(a: string, b: string): boolean {
  const aWords = a.toLowerCase().split(/\W+/).filter(Boolean);
  const bWords = b.toLowerCase().split(/\W+/).filter(Boolean);
  if (!aWords.length || !bWords.length) return false;
  const overlap = aWords.filter((w) => bWords.includes(w));
  return overlap.length / Math.min(aWords.length, bWords.length) >= 0.6;
}

function normalizeCategory(category: string): string {
  const standard: Record<string, string[]> = {
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
  const lower = category.toLowerCase();
  for (const [name, keywords] of Object.entries(standard)) {
    if (keywords.some((k) => lower.includes(k))) return name;
  }
  return category;
}
