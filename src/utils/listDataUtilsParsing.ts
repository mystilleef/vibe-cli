import { LEARNING_TYPES, type LearningType } from "./learningEntryCore.js";

/** Parse and validate a shared list --limit option. */
export function parseListLimit(value?: number | string): number | undefined {
  if (value === undefined || value === "") return undefined;
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(numeric) || numeric <= 0) {
    throw new Error("--limit must be a positive integer");
  }
  return numeric;
}

/** Parse and validate a learning type filter. */
export function parseLearningType(value?: string): LearningType | undefined {
  if (value === undefined) return undefined;
  if (LEARNING_TYPES.includes(value as LearningType))
    return value as LearningType;
  throw new Error("--type must be mistake, preference, or success");
}

/** Extract a stored check reason when output contains a JSON reason. */
export function parseCheckReason(output: string): string {
  try {
    const parsed = JSON.parse(output) as unknown;
    if (
      parsed !== null &&
      typeof parsed === "object" &&
      "reason" in parsed &&
      typeof parsed.reason === "string"
    ) {
      return parsed.reason;
    }
    if (typeof parsed === "string") return parsed;
  } catch {
    // Fall through to raw output.
  }
  return output;
}
