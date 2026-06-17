import type { LearningEntry } from "./learningEntryCore.js";
import type {
  ListAllData,
  ListCategorySummary,
  ListCheck,
  ListClock,
  ListCommandName,
  ListConstitution,
  ListProviderState,
  ListSession,
  ListStats,
} from "./listDataTypes.js";
import { LIST_COMMAND_NAMES } from "./listDataTypes.js";
import { groupBy } from "./listDataUtilsCollections.js";
import {
  formatAlignedRows,
  formatListSection,
  formatRelativeTime,
  truncateText,
} from "./listDataUtilsFormatting.js";
import { parseCheckReason } from "./listDataUtilsParsing.js";

/** Pretty overview used by the root `vibe list` group. */
export function formatListCommandOverview(
  commands: readonly ListCommandName[] = LIST_COMMAND_NAMES,
): string {
  return formatListSection(
    "List commands",
    commands.map((command) => `- ${command}`).join("\n"),
  );
}

/** JSON overview used by the root `vibe list --json` group. */
export function toListOverviewJson(
  commands: readonly ListCommandName[] = LIST_COMMAND_NAMES,
): { commands: ListCommandName[] } {
  return { commands: [...commands] };
}

/** Render learning entries grouped by category for pretty list output. */
export function formatListLearnings(
  learnings: readonly LearningEntry[],
  options: ListClock = {},
): string {
  const body = [...groupBy(learnings, (e) => e.category).entries()]
    .map(([category, entries]) => {
      const rows = entries.flatMap((entry) => [
        `- [${entry.type}] ${entry.observation} (${formatRelativeTime(entry.timestamp, options)})`,
        ...(entry.solution === undefined
          ? []
          : [`  Solution: ${entry.solution}`]),
      ]);
      return [`Category: ${category}`, ...rows].join("\n");
    })
    .join("\n\n");

  return formatListSection("Learnings", body);
}

/** Render active constitution rules with session context. */
export function formatListConstitution(constitution: ListConstitution): string {
  const rules = constitution.rules.length
    ? constitution.rules
        .map((rule, index) => `${index + 1}. ${rule}`)
        .join("\n")
    : "(none)";
  return formatListSection(
    "Constitution",
    [`Session: ${constitution.session}`, rules].join("\n"),
  );
}

function getSessionDisplayCwd(session: ListSession): string {
  return session.cwd || session.cwd_key;
}

/** Render local autosessions with display cwd fallback behavior. */
export function formatListSessions(sessions: readonly ListSession[]): string {
  const rows = sessions.map((session) => [
    getSessionDisplayCwd(session),
    session.id,
    session.created_at,
    session.last_accessed_at,
  ]);
  const body = rows.length
    ? formatAlignedRows(["cwd", "id", "created_at", "last_accessed_at"], rows)
    : "";
  return formatListSection("Sessions", body);
}

/** Render configured providers and mark the settings-selected active provider. */
export function formatListProviders(state: ListProviderState): string {
  const rows = Object.entries(state.providers).map(([provider, model]) => [
    provider,
    model || "(required via --model)",
    provider === state.activeProvider ? "*" : "",
  ]);
  return formatListSection(
    "Providers",
    formatAlignedRows(["provider", "model", "active"], rows),
  );
}

/** Render category counts and recent examples for pretty list output. */
export function formatListCategories(
  categories: readonly ListCategorySummary[],
): string {
  const rows = categories.map((summary) => [
    summary.category,
    String(summary.count),
    `[${summary.recentExample.type}] ${summary.recentExample.observation}`,
  ]);
  const body = rows.length
    ? formatAlignedRows(["Category", "Count", "Recent Example"], rows)
    : "";
  return formatListSection("Categories", body);
}

/** Render stored checks grouped by session for pretty list output. */
export function formatListChecks(
  checks: readonly ListCheck[],
  options: ListClock = {},
): string {
  const body = [
    ...groupBy(checks, (i) => i.displayCwd ?? i.session_id).entries(),
  ]
    .map(([sessionLabel, entries]) => {
      const rows = entries.flatMap((check) => {
        const reason = parseCheckReason(check.output).trim() || "(none)";
        return [
          `- Goal: ${check.goal} (${formatRelativeTime(check.timestamp, options)})`,
          `  Reason: ${truncateText(reason, 120)}`,
        ];
      });
      return [`Session: ${sessionLabel}`, ...rows].join("\n");
    })
    .join("\n\n");

  return formatListSection("Checks", body);
}

/** Render aggregate list stats for pretty list output. */
export function formatListStats(stats: ListStats): string {
  return formatListSection(
    "Stats",
    [
      `Learnings: ${stats.learnings.total} total (${stats.learnings.mistake} mistake, ${stats.learnings.preference} preference, ${stats.learnings.success} success)`,
      `Sessions: ${stats.sessions.total} total`,
      `Most active cwd: ${stats.sessions.mostActiveCwd ?? "(none)"}`,
      `Constitution rules: ${stats.constitution.activeRules}`,
      `Checks: ${stats.checks.total} total`,
    ].join("\n"),
  );
}

/** Render every list surface as headed pretty sections. */
export function formatListAll(
  data: ListAllData,
  options: ListClock = {},
  providerState: ListProviderState = data.providers,
): string {
  return [
    formatListLearnings(data.learnings, options),
    formatListConstitution(data.constitution),
    formatListSessions(data.sessions),
    formatListProviders(providerState),
    formatListChecks(data.checks, options),
    formatListCategories(data.categories),
    formatListStats(data.stats),
  ].join("\n\n");
}
