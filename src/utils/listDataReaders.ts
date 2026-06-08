import { resolveAutosession } from "./autosession.js";
import { withDatabase } from "./database.js";
import {
  type LearningEntry,
  type LearningEntryStorageRow,
  type LearningType,
  learningRowToEntry,
} from "./learningEntryCore.js";
import type {
  ListAllData,
  ListCategorySummary,
  ListCheck,
  ListCheckFilters,
  ListConstitution,
  ListLearningFilters,
  ListProviderState,
  ListSession,
  ListStats,
} from "./listDataTypes.js";
import { applyListLimit, compareListText, groupBy } from "./listDataUtils.js";
import { loadProviderSettings, resolveProviderEntry } from "./settings.js";

interface RuleRow {
  rule: string;
}

function readLearningRows(): LearningEntryStorageRow[] {
  return withDatabase((db) =>
    db
      .query<LearningEntryStorageRow, []>(
        `SELECT id, type, category, observation, solution, timestamp, demo_id
         FROM learning_entries
         ORDER BY category ASC, timestamp ASC, id ASC`,
      )
      .all(),
  );
}

/** Read learning entries with deterministic filter/order/limit behavior. */
export function readListLearnings(
  filters: ListLearningFilters = {},
): LearningEntry[] {
  const filtered = readLearningRows()
    .map(learningRowToEntry)
    .filter(
      (entry) => filters.type === undefined || entry.type === filters.type,
    )
    .filter(
      (entry) =>
        filters.category === undefined || entry.category === filters.category,
    );
  return applyListLimit(filtered, filters.limit);
}

/** Read category counts and recent examples in deterministic order. */
export function readListCategories(): ListCategorySummary[] {
  return summarizeLearningCategories(readListLearnings());
}

/** Build category summaries from a learning list without additional IO. */
export function summarizeLearningCategories(
  learnings: readonly LearningEntry[],
): ListCategorySummary[] {
  return [...groupBy(learnings, (e) => e.category).entries()]
    .flatMap(([category, entries]) => {
      const recentExample = entries.at(-1);
      return recentExample === undefined
        ? []
        : [{ category, count: entries.length, recentExample }];
    })
    .sort(
      (left, right) =>
        right.count - left.count ||
        compareListText(left.category, right.category),
    );
}

/** Read rules for the active autosession constitution. */
export function readListConstitution(): ListConstitution {
  const session = resolveAutosession().id;
  const rules = withDatabase((db) =>
    db
      .query<RuleRow, [string]>(
        "SELECT rule FROM constitution_rules WHERE session_id = ? ORDER BY position ASC",
      )
      .all(session)
      .map((row) => row.rule),
  );
  return { session, rules };
}

/** Read every known session with deterministic ordering. */
export function readListSessions(): ListSession[] {
  return withDatabase((db) =>
    db
      .query<ListSession, []>(
        `SELECT id, cwd_key, cwd, created_at, last_accessed_at
         FROM sessions
         ORDER BY last_accessed_at DESC, created_at DESC, id ASC`,
      )
      .all(),
  );
}

/** Read configured providers plus the settings-selected active provider marker. */
export function readListProviders(): ListProviderState {
  const settings = loadProviderSettings();
  const activeProvider = resolveProviderEntry(settings).name;
  const providers = Object.fromEntries(
    settings.providers
      .map((provider) => [provider.name, provider.defaultModel ?? ""] as const)
      .sort(([left], [right]) => compareListText(left, right)),
  );

  return { activeProvider, providers };
}

/** Convert provider state to the exact JSON provider-model map. */
export function toProvidersJson(
  state: ListProviderState = readListProviders(),
): Record<string, string> {
  return state.providers;
}

/** Read checks with deterministic filter/order/limit behavior. */
export function readListChecks(filters: ListCheckFilters = {}): ListCheck[] {
  const rows = withDatabase((db) =>
    db
      .query<ListCheck, []>(
        `SELECT i.id, i.session_id, i.goal, i.output, i.timestamp,
                COALESCE(s.cwd, s.cwd_key) AS displayCwd
         FROM interactions i
         LEFT JOIN sessions s ON s.id = i.session_id
         ORDER BY i.session_id ASC, i.timestamp DESC, i.id DESC`,
      )
      .all(),
  );
  const filtered = rows.filter(
    (entry) =>
      filters.session === undefined || entry.session_id === filters.session,
  );
  return applyListLimit(filtered, filters.limit);
}

/** Build stable aggregate stats from already-read list data. */
export function buildListStats(
  learnings: readonly LearningEntry[],
  sessions: readonly ListSession[],
  constitution: ListConstitution,
  checks: readonly ListCheck[],
): ListStats {
  const byType: Record<LearningType, number> = {
    mistake: 0,
    preference: 0,
    success: 0,
  };
  for (const entry of learnings) byType[entry.type] += 1;

  return {
    learnings: {
      total: learnings.length,
      mistake: byType.mistake,
      preference: byType.preference,
      success: byType.success,
    },
    sessions: {
      total: sessions.length,
      mostActiveCwd: resolveMostActiveCwd(sessions, checks),
    },
    constitution: { activeRules: constitution.rules.length },
    checks: { total: checks.length },
  };
}

/** Read aggregate list stats using only local storage and configuration. */
export function readListStats(): ListStats {
  const constitution = readListConstitution();
  const learnings = readListLearnings();
  const sessions = readListSessions();
  const checks = readListChecks();
  return buildListStats(learnings, sessions, constitution, checks);
}

/** Compose every list reader into one JSON-safe envelope. */
export function readListAll(): ListAllData {
  const constitution = readListConstitution();
  const learnings = readListLearnings();
  const sessions = readListSessions();
  const providerState = readListProviders();
  const checks = readListChecks();
  const categories = summarizeLearningCategories(learnings);
  return {
    learnings,
    constitution,
    sessions,
    providers: providerState,
    checks,
    categories,
    stats: buildListStats(learnings, sessions, constitution, checks),
  };
}

function resolveMostActiveCwd(
  sessions: readonly ListSession[],
  checks: readonly ListCheck[],
): string | null {
  const counts = new Map<string, number>();
  for (const check of checks) {
    counts.set(check.session_id, (counts.get(check.session_id) ?? 0) + 1);
  }

  const [session] = sessions.slice().sort((left, right) => {
    const activity = (counts.get(right.id) ?? 0) - (counts.get(left.id) ?? 0);
    if (activity !== 0) return activity;
    const accessed = compareListText(
      right.last_accessed_at,
      left.last_accessed_at,
    );
    if (accessed !== 0) return accessed;
    return compareListText(left.id, right.id);
  });

  return session === undefined ? null : (session.cwd ?? session.cwd_key);
}
