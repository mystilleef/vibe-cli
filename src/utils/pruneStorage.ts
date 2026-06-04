import fs from "node:fs";
import path from "node:path";
import { openVibeDatabase, withDatabase } from "./database.js";
import {
  DAY_MS,
  DEFAULT_LEARNING_DUPLICATE_OVERLAP_THRESHOLD,
  getLearningOverlapScore,
  type LearningEntryStorageRow,
  learningRowToEntry,
} from "./learningEntryCore.js";

// ── Types ─────────────────────────────────────────────────────────────────

/** Read-only candidate emitted before any learning prune mutation. */
export interface LearningPruneCandidate {
  id: number;
  type: "mistake" | "preference" | "success";
  category: string;
  mistake: string;
  solution?: string;
  timestamp: number;
  demoId?: string;
}

export interface StaleLearningPruneOptions {
  ageDays: number;
  category?: string;
  now?: number;
}

export interface DuplicateLearningPruneOptions {
  category?: string;
  overlapThreshold?: number;
}

export interface LearningDuplicateOverlapScore {
  firstId: number;
  secondId: number;
  score: number;
}

export interface DuplicateLearningPruneGroup {
  category: string;
  kept: LearningPruneCandidate;
  prunable: LearningPruneCandidate[];
  overlapScores: LearningDuplicateOverlapScore[];
}

export interface StaleSessionPruneOptions {
  ageDays: number;
  now?: number;
  activeSessionId?: string;
}

export interface SessionPruneCascadeCounts {
  constitutionRules: number;
  interactions: number;
}

export interface SessionPruneCandidate {
  sessionId: string;
  cwd: string | null;
  createdAt: string;
  lastAccessedAt: string;
  cascadeCounts: SessionPruneCascadeCounts;
}

export const PRUNE_TARGET_ORDER = [
  "learnings",
  "duplicates",
  "demos",
  "sessions",
] as const;

export type PruneTarget = (typeof PRUNE_TARGET_ORDER)[number];
export type PruneFailureTarget = PruneTarget | "backup";

export interface PruneCandidateOptions {
  targets?: readonly PruneTarget[];
  ageDays: number;
  category?: string;
  now?: number;
  overlapThreshold?: number;
  activeSessionId?: string;
}

export interface DestructivePruneOptions extends PruneCandidateOptions {
  backupTimestamp?: Date;
  backupDirectory?: string;
}

export interface PruneCandidateSets {
  learnings: LearningPruneCandidate[];
  duplicates: DuplicateLearningPruneGroup[];
  demos: LearningPruneCandidate[];
  sessions: SessionPruneCandidate[];
}

export type PruneTargetCounts = Record<PruneTarget, number>;

export interface PruneFailureDetail {
  target: PruneFailureTarget;
  message: string;
}

export interface DestructivePruneResult {
  backupPath: string | null;
  candidates: PruneCandidateSets;
  candidateCounts: PruneTargetCounts;
  deletedCounts: PruneTargetCounts;
  skippedTargets: PruneTarget[];
  failedTargets: PruneFailureDetail[];
}

// ── Internal helpers ──────────────────────────────────────────────────────

interface SessionPruneStorageRow {
  id: string;
  cwd: string | null;
  created_at: string;
  last_accessed_at: string;
  constitution_rules_count: number;
  interactions_count: number;
}

function rowToPruneCandidate(
  row: LearningEntryStorageRow,
): LearningPruneCandidate {
  return {
    id: row.id,
    ...learningRowToEntry(row),
  };
}

function rowToSessionPruneCandidate(
  row: SessionPruneStorageRow,
): SessionPruneCandidate {
  return {
    sessionId: row.id,
    cwd: row.cwd,
    createdAt: row.created_at,
    lastAccessedAt: row.last_accessed_at,
    cascadeCounts: {
      constitutionRules: row.constitution_rules_count,
      interactions: row.interactions_count,
    },
  };
}

const LEARNING_PRUNE_SELECT =
  "SELECT id, type, category, mistake, solution, timestamp, demo_id FROM learning_entries";

const LEARNING_PRUNE_ORDER = "ORDER BY timestamp, category, id";

const SESSION_PRUNE_SELECT = `
  SELECT
    s.id,
    s.cwd,
    s.created_at,
    s.last_accessed_at,
    (
      SELECT COUNT(*) FROM constitution_rules
      WHERE session_id = s.id
    ) AS constitution_rules_count,
    (
      SELECT COUNT(*) FROM interactions
      WHERE session_id = s.id
    ) AS interactions_count
  FROM sessions AS s
`;

const SESSION_PRUNE_ORDER = "ORDER BY s.last_accessed_at, s.created_at, s.id";

function readLearningPruneRows(category?: string): LearningEntryStorageRow[] {
  return withDatabase((db) => {
    const where = category !== undefined ? " WHERE category = ?" : "";
    const params: string[] = category !== undefined ? [category] : [];
    return db
      .query<LearningEntryStorageRow, string[]>(
        `${LEARNING_PRUNE_SELECT}${where} ${LEARNING_PRUNE_ORDER}`,
      )
      .all(...params);
  });
}

function compareLearningPruneRows(
  left: LearningEntryStorageRow,
  right: LearningEntryStorageRow,
): number {
  return (
    left.timestamp - right.timestamp ||
    left.category.localeCompare(right.category) ||
    left.id - right.id
  );
}

function compareDuplicateLearningGroups(
  left: DuplicateLearningPruneGroup,
  right: DuplicateLearningPruneGroup,
): number {
  return (
    left.category.localeCompare(right.category) ||
    left.kept.timestamp - right.kept.timestamp ||
    left.kept.id - right.kept.id
  );
}

// ── Candidate collection ──────────────────────────────────────────────────

/**
 * Return entries older than the resolved age cutoff without mutating storage.
 *
 * Results stay stable through timestamp, category, then row-id ordering so dry
 * runs and destructive callers can compare the same candidate set.
 */
export function collectStaleLearningPruneCandidates({
  ageDays,
  category,
  now = Date.now(),
}: StaleLearningPruneOptions): LearningPruneCandidate[] {
  const cutoff = now - ageDays * DAY_MS;
  const where =
    category !== undefined
      ? "WHERE timestamp < ? AND category = ?"
      : "WHERE timestamp < ?";
  const params: (number | string)[] =
    category !== undefined ? [cutoff, category] : [cutoff];

  return withDatabase((db) =>
    db
      .query<LearningEntryStorageRow, (number | string)[]>(
        `${LEARNING_PRUNE_SELECT} ${where} ${LEARNING_PRUNE_ORDER}`,
      )
      .all(...params)
      .map(rowToPruneCandidate),
  );
}

/** Return demo-linked learning entries without applying age/category filters. */
export function collectDemoLearningPruneCandidates(): LearningPruneCandidate[] {
  return withDatabase((db) =>
    db
      .query<LearningEntryStorageRow, []>(
        `${LEARNING_PRUNE_SELECT} WHERE demo_id IS NOT NULL ${LEARNING_PRUNE_ORDER}`,
      )
      .all()
      .map(rowToPruneCandidate),
  );
}

/**
 * Build an undirected graph of duplicate-pair edges across rows within a single
 * category. Each row starts with an empty adjacency set; an edge is added for
 * every pair whose overlap score meets `score >= overlapThreshold`. A threshold
 * of `0` includes zero-score pairs because every score satisfies `score >= 0`.
 *
 * @returns Adjacency map and the list of qualifying pairwise scores.
 */
function buildLearningOverlapGraph(
  rows: readonly LearningEntryStorageRow[],
  overlapThreshold: number,
): {
  edges: Map<number, Set<number>>;
  scores: readonly LearningDuplicateOverlapScore[];
} {
  const edges = new Map<number, Set<number>>();
  const scores: LearningDuplicateOverlapScore[] = [];

  for (const row of rows) edges.set(row.id, new Set());

  for (let leftIndex = 0; leftIndex < rows.length; leftIndex += 1) {
    const left = rows[leftIndex];
    if (left === undefined) continue;
    for (
      let rightIndex = leftIndex + 1;
      rightIndex < rows.length;
      rightIndex += 1
    ) {
      const right = rows[rightIndex];
      if (right === undefined) continue;
      const score = getLearningOverlapScore(left.mistake, right.mistake);
      if (score < overlapThreshold) continue;
      edges.get(left.id)?.add(right.id);
      edges.get(right.id)?.add(left.id);
      scores.push({ firstId: left.id, secondId: right.id, score });
    }
  }

  return { edges, scores };
}

/**
 * Find connected components in a duplicate overlap graph and assemble each
 * into a `DuplicateLearningPruneGroup`.
 *
 * Keeps the most-recent row; the rest become prunable candidates.  Filters
 * overlap scores to only those whose both endpoints belong to the component.
 * Silently skips isolated nodes (components of size 1).
 */
function buildDuplicateLearningGroupsFromGraph(
  rows: readonly LearningEntryStorageRow[],
  edges: ReadonlyMap<number, ReadonlySet<number>>,
  scores: readonly LearningDuplicateOverlapScore[],
  category: string,
): DuplicateLearningPruneGroup[] {
  const rowsById = new Map(rows.map((row) => [row.id, row]));
  const visited = new Set<number>();
  const groups: DuplicateLearningPruneGroup[] = [];

  for (const row of rows) {
    if (visited.has(row.id)) continue;

    const componentIds: number[] = [];
    const stack = [row.id];
    visited.add(row.id);

    while (stack.length > 0) {
      const currentId = stack.pop();
      if (currentId === undefined) continue;
      componentIds.push(currentId);
      for (const nextId of edges.get(currentId) ?? []) {
        if (visited.has(nextId)) continue;
        visited.add(nextId);
        stack.push(nextId);
      }
    }

    if (componentIds.length < 2) continue;

    const componentRows = componentIds
      .map((id) => rowsById.get(id))
      .filter(
        (current): current is LearningEntryStorageRow => current !== undefined,
      )
      .sort(
        (left, right) => right.timestamp - left.timestamp || right.id - left.id,
      );
    const kept = componentRows[0];
    if (kept === undefined) continue;

    const componentIdSet = new Set(componentIds);
    groups.push({
      category,
      kept: rowToPruneCandidate(kept),
      prunable: componentRows
        .slice(1)
        .sort(compareLearningPruneRows)
        .map(rowToPruneCandidate),
      overlapScores: scores.filter(
        (score) =>
          componentIdSet.has(score.firstId) &&
          componentIdSet.has(score.secondId),
      ),
    });
  }

  return groups;
}

/**
 * Return duplicate learning groups without mutating storage.
 *
 * Groups never cross category boundaries. Each duplicate group keeps the most
 * recent row and reports the older rows plus pairwise overlap scores that met
 * the configured threshold.
 */
export function collectDuplicateLearningPruneGroups({
  category,
  overlapThreshold = DEFAULT_LEARNING_DUPLICATE_OVERLAP_THRESHOLD,
}: DuplicateLearningPruneOptions = {}): DuplicateLearningPruneGroup[] {
  const rowsByCategory = readLearningPruneRows(category).reduce<
    Map<string, LearningEntryStorageRow[]>
  >((grouped, row) => {
    const rows = grouped.get(row.category) ?? [];
    rows.push(row);
    grouped.set(row.category, rows);
    return grouped;
  }, new Map());

  const groups: DuplicateLearningPruneGroup[] = [];
  const categories = [...rowsByCategory.keys()].sort((left, right) =>
    left.localeCompare(right),
  );

  for (const currentCategory of categories) {
    const categoryRows = (rowsByCategory.get(currentCategory) ?? []).sort(
      compareLearningPruneRows,
    );
    const { edges, scores } = buildLearningOverlapGraph(
      categoryRows,
      overlapThreshold,
    );
    groups.push(
      ...buildDuplicateLearningGroupsFromGraph(
        categoryRows,
        edges,
        scores,
        currentCategory,
      ),
    );
  }

  return groups.sort(compareDuplicateLearningGroups);
}

/**
 * Return sessions older than the resolved age cutoff without mutating storage.
 *
 * Candidate rows include dependent table counts that SQLite would cascade if a
 * later, explicit session prune deletes the session row.
 */
export function collectStaleSessionPruneCandidates({
  ageDays,
  now = Date.now(),
  activeSessionId,
}: StaleSessionPruneOptions): SessionPruneCandidate[] {
  const cutoff = new Date(now - ageDays * DAY_MS).toISOString();
  const where =
    activeSessionId !== undefined
      ? "WHERE s.last_accessed_at < ? AND s.id <> ?"
      : "WHERE s.last_accessed_at < ?";
  const params: string[] =
    activeSessionId !== undefined ? [cutoff, activeSessionId] : [cutoff];

  return withDatabase((db) =>
    db
      .query<SessionPruneStorageRow, string[]>(
        `${SESSION_PRUNE_SELECT} ${where} ${SESSION_PRUNE_ORDER}`,
      )
      .all(...params)
      .map(rowToSessionPruneCandidate),
  );
}

// ── Candidate aggregation ─────────────────────────────────────────────────

function normalizePruneTargets(
  targets: readonly PruneTarget[] = PRUNE_TARGET_ORDER,
): PruneTarget[] {
  const selected = new Set(targets);
  return PRUNE_TARGET_ORDER.filter((target) => selected.has(target));
}

export function computePruneTargetCounts(
  candidates: PruneCandidateSets,
): PruneTargetCounts {
  return {
    learnings: candidates.learnings.length,
    duplicates: candidates.duplicates.reduce(
      (count, group) => count + group.prunable.length,
      0,
    ),
    demos: candidates.demos.length,
    sessions: candidates.sessions.length,
  };
}

export function collectPruneCandidates({
  targets,
  ageDays,
  category,
  now,
  overlapThreshold,
  activeSessionId,
}: PruneCandidateOptions): PruneCandidateSets {
  const selectedTargets = normalizePruneTargets(targets);
  const candidates: PruneCandidateSets = {
    learnings: [],
    duplicates: [],
    demos: [],
    sessions: [],
  };

  if (selectedTargets.includes("learnings")) {
    candidates.learnings = collectStaleLearningPruneCandidates({
      ageDays,
      ...(category !== undefined && { category }),
      ...(now !== undefined && { now }),
    });
  }

  if (selectedTargets.includes("duplicates")) {
    candidates.duplicates = collectDuplicateLearningPruneGroups({
      ...(category !== undefined && { category }),
      ...(overlapThreshold !== undefined && { overlapThreshold }),
    });
  }

  if (selectedTargets.includes("demos")) {
    candidates.demos = collectDemoLearningPruneCandidates();
  }

  if (selectedTargets.includes("sessions")) {
    candidates.sessions = collectStaleSessionPruneCandidates({
      ageDays,
      ...(now !== undefined && { now }),
      ...(activeSessionId !== undefined && { activeSessionId }),
    });
  }

  return candidates;
}

// ── Destructive execution ─────────────────────────────────────────────────

/** Creates a timestamped database backup before any destructive prune. */
export function createPruneDatabaseBackup({
  timestamp = new Date(),
  directory,
}: {
  timestamp?: Date;
  directory?: string;
} = {}): string {
  const handle = openVibeDatabase();
  try {
    if (handle.path === ":memory:") {
      throw new Error("cannot back up an in-memory database");
    }

    const checkpoint = handle.db
      .query<{ busy: number }, []>("PRAGMA wal_checkpoint(TRUNCATE)")
      .get();
    if ((checkpoint?.busy ?? 1) !== 0) {
      throw new Error("database checkpoint could not complete before backup");
    }

    const backupDirectory =
      directory ?? path.join(path.dirname(handle.path), "backups");
    const label = timestamp.toISOString().replace(/[.:]/g, "-");
    fs.mkdirSync(backupDirectory, { recursive: true });
    const backupPath = path.join(backupDirectory, `vibe-prune-${label}.db`);
    fs.copyFileSync(handle.path, backupPath, fs.constants.COPYFILE_EXCL);
    return backupPath;
  } finally {
    handle.close();
  }
}

function deleteRowsById<T extends number | string>(
  table: string,
  ids: readonly T[],
): number {
  const deduped = [...new Set(ids)];
  if (deduped.length === 0) return 0;

  return withDatabase((db) => {
    const remove = db.prepare(`DELETE FROM ${table} WHERE id = ?`);
    const removeRows = db.transaction(
      (rowIds: readonly T[]) =>
        rowIds.filter((id) => remove.run(id).changes > 0).length,
    );
    return removeRows(deduped);
  });
}

const DELETE_TARGET_MAP: Record<
  PruneTarget,
  (c: PruneCandidateSets) => readonly (number | string)[]
> = {
  learnings: (c) => c.learnings.map((e) => e.id),
  duplicates: (c) => c.duplicates.flatMap((g) => g.prunable.map((e) => e.id)),
  demos: (c) => c.demos.map((e) => e.id),
  sessions: (c) => c.sessions.map((e) => e.sessionId),
};

function deletePruneTarget(
  target: PruneTarget,
  candidates: PruneCandidateSets,
): number {
  const ids = DELETE_TARGET_MAP[target](candidates);
  const table = target === "sessions" ? "sessions" : "learning_entries";
  return deleteRowsById(table, ids);
}

export function executeDestructivePrune({
  backupTimestamp,
  backupDirectory,
  ...candidateOptions
}: DestructivePruneOptions): DestructivePruneResult {
  const selectedTargets = normalizePruneTargets(candidateOptions.targets);
  const candidates = collectPruneCandidates(candidateOptions);
  const candidateCounts = computePruneTargetCounts(candidates);
  const skippedTargets = PRUNE_TARGET_ORDER.filter(
    (target) => !selectedTargets.includes(target),
  );
  const deletedCounts: PruneTargetCounts = {
    learnings: 0,
    duplicates: 0,
    demos: 0,
    sessions: 0,
  };

  let backupPath: string;
  try {
    backupPath = createPruneDatabaseBackup({
      ...(backupTimestamp !== undefined && { timestamp: backupTimestamp }),
      ...(backupDirectory !== undefined && { directory: backupDirectory }),
    });
  } catch (error) {
    return {
      backupPath: null,
      candidates,
      candidateCounts,
      deletedCounts,
      skippedTargets,
      failedTargets: [
        {
          target: "backup",
          message: error instanceof Error ? error.message : String(error),
        },
      ],
    };
  }

  const failedTargets: PruneFailureDetail[] = [];
  for (const target of selectedTargets) {
    try {
      deletedCounts[target] = deletePruneTarget(target, candidates);
    } catch (error) {
      failedTargets.push({
        target,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return {
    backupPath,
    candidates,
    candidateCounts,
    deletedCounts,
    skippedTargets,
    failedTargets,
  };
}
