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

/** Return a deterministically limited copy after filtering has occurred. */
export function applyListLimit<T>(items: readonly T[], limit?: number): T[] {
  return items.slice(0, limit);
}

/** Locale-independent ascending text comparator for deterministic output. */
export function compareListText(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}
