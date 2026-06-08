import type { ListClock } from "./listDataTypes.js";

const ELLIPSIS = "…";

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

/** Render a titled pretty-output section without touching JSON emitters. */
export function formatListSection(title: string, body: string): string {
  const content = body.trimEnd() || "(none)";
  return `${title}\n${"-".repeat(title.length)}\n${content}`;
}
