import {
  collectPruneCandidates,
  computePruneTargetCounts,
  DEFAULT_LEARNING_DUPLICATE_OVERLAP_THRESHOLD,
  type DestructivePruneResult,
  executeDestructivePrune,
  PRUNE_TARGET_ORDER,
  type PruneCandidateSets,
  type PruneFailureDetail,
  type PruneTarget,
} from "../utils/storage.js";

export const DEFAULT_PRUNE_AGE_DAYS = 90;
export const DEFAULT_PRUNE_OVERLAP_THRESHOLD =
  DEFAULT_LEARNING_DUPLICATE_OVERLAP_THRESHOLD;

export interface PruneInput {
  learnings?: boolean;
  duplicates?: boolean;
  demos?: boolean;
  sessions?: boolean;
  age?: number;
  category?: string;
  overlap?: number;
  dryRun?: boolean;
  yes?: boolean;
}

export interface PruneSuccessPayload {
  dryRun: boolean;
  targets: PruneTarget[];
  candidateCounts: Record<PruneTarget, number>;
  representativeDetails: {
    learnings: Array<{
      id: number;
      category: string;
      mistake: string;
      timestamp: number;
    }>;
    duplicates: Array<{
      category: string;
      keptId: number;
      prunableIds: number[];
    }>;
    demos: Array<{
      id: number;
      category: string;
      mistake: string;
      demoId: string;
    }>;
    sessions: Array<{
      sessionId: string;
      cwd: string | null;
      lastAccessedAt: string;
    }>;
  };
  backupPath: string | null;
  deletedCounts: Record<PruneTarget, number>;
  skippedTargets: PruneTarget[];
  failedTargets: PruneFailureDetail[];
}

function validateAge(age: number | undefined): number {
  if (age === undefined) return DEFAULT_PRUNE_AGE_DAYS;
  if (!Number.isInteger(age) || age <= 0) {
    throw new Error("--age must be a positive integer (days)");
  }
  return age;
}

function validateOverlap(overlap: number | undefined): number {
  if (overlap === undefined) return DEFAULT_PRUNE_OVERLAP_THRESHOLD;
  if (typeof overlap !== "number" || overlap < 0 || overlap > 1) {
    throw new Error("--overlap must be a float between 0 and 1 inclusive");
  }
  return overlap;
}

function validateCategory(
  category: string | undefined,
  explicitTargets: PruneTarget[],
): string | undefined {
  if (category === undefined) return undefined;
  if (explicitTargets.some((t) => t !== "learnings" && t !== "duplicates")) {
    throw new Error(
      "--category is only allowed with --learnings or --duplicates",
    );
  }
  return category;
}

function extractRepresentativeDetails(
  candidates: PruneCandidateSets,
): PruneSuccessPayload["representativeDetails"] {
  return {
    learnings: candidates.learnings.slice(0, 5).map((entry) => ({
      id: entry.id,
      category: entry.category,
      mistake: entry.mistake,
      timestamp: entry.timestamp,
    })),
    duplicates: candidates.duplicates.slice(0, 5).map((group) => ({
      category: group.category,
      keptId: group.kept.id,
      prunableIds: group.prunable.map((entry) => entry.id),
    })),
    demos: candidates.demos.slice(0, 5).map((entry) => ({
      id: entry.id,
      category: entry.category,
      mistake: entry.mistake,
      demoId: entry.demoId ?? "",
    })),
    sessions: candidates.sessions.slice(0, 5).map((session) => ({
      sessionId: session.sessionId,
      cwd: session.cwd,
      lastAccessedAt: session.lastAccessedAt,
    })),
  };
}

export function runPrune(input: PruneInput): PruneSuccessPayload {
  const explicitTargets = PRUNE_TARGET_ORDER.filter((t) => input[t]);
  const ageDays = validateAge(input.age);
  const overlapThreshold = validateOverlap(input.overlap);
  const category = validateCategory(input.category, explicitTargets);

  const isDryRun =
    input.dryRun === true || explicitTargets.length === 0 || input.yes !== true;

  const targets =
    explicitTargets.length > 0 ? explicitTargets : [...PRUNE_TARGET_ORDER];

  if (isDryRun) {
    const candidates = collectPruneCandidates({
      targets,
      ageDays,
      ...(category !== undefined && { category }),
      overlapThreshold,
    });

    return {
      dryRun: true,
      targets,
      candidateCounts: computePruneTargetCounts(candidates),
      representativeDetails: extractRepresentativeDetails(candidates),
      backupPath: null,
      deletedCounts: { learnings: 0, duplicates: 0, demos: 0, sessions: 0 },
      skippedTargets: PRUNE_TARGET_ORDER.filter(
        (target) => !targets.includes(target),
      ),
      failedTargets: [],
    };
  }

  const result: DestructivePruneResult = executeDestructivePrune({
    targets,
    ageDays,
    ...(category !== undefined && { category }),
    overlapThreshold,
    backupTimestamp: new Date(),
  });

  return {
    dryRun: false,
    targets,
    candidateCounts: result.candidateCounts,
    representativeDetails: extractRepresentativeDetails(result.candidates),
    backupPath: result.backupPath,
    deletedCounts: result.deletedCounts,
    skippedTargets: result.skippedTargets,
    failedTargets: result.failedTargets,
  };
}
