import type { ListClock } from "./listDataTypes.js";
import type { LearningType } from "./storage.js";

const ELLIPSIS = "…";

/** Group items by a key derived from each item. */
export function groupBy<T>(
  items: readonly T[],
  key: (item: T) => string,
): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const k = key(item);
    const group = groups.get(k) ?? [];
    group.push(item);
    groups.set(k, group);
  }
  return groups;
}

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
  const LEARNING_TYPES = ["mistake", "preference", "success"] as const;
  if (LEARNING_TYPES.includes(value as LearningType))
    return value as LearningType;
  throw new Error("--type must be mistake, preference, or success");
}

/** Return a deterministically limited copy after filtering has occurred. */
export function applyListLimit<T>(items: readonly T[], limit?: number): T[] {
  return items.slice(0, limit);
}

/** Locale-independent ascending text comparator for deterministic output. */
export function compareListText(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

/** Convert an optional timestamp-ish value to stable relative text. */
export function formatRelativeTime(
  timestamp: number | string,
  options: ListClock = {},
): string {
  const value =
    typeof timestamp === "number" ? timestamp : Date.parse(timestamp);
  if (Number.isNaN(value)) return "unknown";

  const now =
    options.now instanceof Date
      ? options.now.getTime()
      : (options.now ?? Date.now());
  const diff = now - value;
  const abs = Math.abs(diff);
  if (abs < 1000) return "just now";

  const units = [
    { label: "d", ms: 24 * 60 * 60 * 1000 },
    { label: "h", ms: 60 * 60 * 1000 },
    { label: "m", ms: 60 * 1000 },
    { label: "s", ms: 1000 },
  ] as const;
  const unit = units.find((candidate) => abs >= candidate.ms) ?? units.at(-1);
  if (unit === undefined) return "just now";
  const amount = Math.floor(abs / unit.ms);
  const suffix = diff >= 0 ? "ago" : "from now";
  return `${amount}${unit.label} ${suffix}`;
}

/** Truncate text deterministically and append an ellipsis suffix when needed. */
export function truncateText(
  text: string,
  maxLength = 120,
  suffix = ELLIPSIS,
): string {
  if (!Number.isInteger(maxLength) || maxLength < 0) {
    throw new Error("maxLength must be a non-negative integer");
  }
  return text.length <= maxLength
    ? text
    : `${text.slice(0, maxLength)}${suffix}`;
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

/** Render a titled pretty-output section without touching JSON emitters. */
export function formatListSection(title: string, body: string): string {
  const content = body.trimEnd() || "(none)";
  return `${title}\n${"-".repeat(title.length)}\n${content}`;
}

/** Render fixed-width rows for pretty table-style list commands. */
export function formatAlignedRows(
  headers: readonly string[],
  rows: readonly (readonly string[])[],
): string {
  const widths = headers.map((header, index) =>
    Math.max(header.length, ...rows.map((row) => row[index]?.length ?? 0)),
  );
  const renderRow = (row: readonly string[]) =>
    row
      .map((cell, index) => cell.padEnd(widths[index] ?? cell.length))
      .join("  ")
      .trimEnd();

  return [
    renderRow(headers),
    renderRow(
      headers.map((header, index) =>
        "-".repeat(widths[index] ?? header.length),
      ),
    ),
    ...rows.map(renderRow),
  ].join("\n");
}
