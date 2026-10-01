/**
 * Doctor policy. SQL and filesystem work stay in `doctorSql` and
 * `doctorStorage`; this module only orchestrates and reports.
 */

import type { DatabaseBackupOptions } from "../utils/databaseBackup.js";
import {
  createDoctorDatabaseBackup,
  type DoctorTargetFailure,
  purgeLegacyCopies,
  purgeManagedBackups,
  type RmdirOperation,
  type UnlinkOperation,
} from "../utils/doctorMaintenance.js";
import {
  type DoctorExecutor,
  type DoctorExecutorOption,
  doctorSqlExecutor,
} from "../utils/doctorSql.js";
import {
  collectDoctorDiagnostics,
  type DoctorDiagnostics,
  type DoctorFindings,
} from "../utils/doctorStorage.js";
import { extractErrorMessage } from "../utils/errors.js";
import { isValidRetention } from "../utils/managedBackups.js";

/** Retention applied when `--keep-backups` is omitted. */
const DEFAULT_DOCTOR_KEEP_BACKUPS = 5;

/** Canonical application order shared by policy, results, and the CLI. */
export const DOCTOR_TARGET_ORDER = [
  "vacuum",
  "purgeBackups",
  "purgeLegacy",
] as const;

export type DoctorApplyTarget = (typeof DOCTOR_TARGET_ORDER)[number];

export interface DoctorInput {
  vacuum?: boolean;
  purgeBackups?: boolean;
  purgeLegacy?: boolean;
  /** Raw `--keep-backups` value; validated in full before any storage access. */
  keepBackups?: string;
  yes?: boolean;
}

export interface DoctorRunOptions extends DoctorExecutorOption {
  /** Controlled backup timestamp for deterministic backup naming. */
  timestamp?: Date;
  /** Injectable unlink operation forwarded to selected purge targets. */
  unlinkFile?: UnlinkOperation;
  /** Injectable empty-directory removal forwarded to the legacy purge. */
  removeDirectory?: RmdirOperation;
  /** Injectable backup options forwarded to database backup creation. */
  backupOptions?: Partial<DatabaseBackupOptions>;
}

export interface DoctorSuccessPayload {
  dryRun: boolean;
  targets: DoctorApplyTarget[];
  findings: DoctorFindings;
  backupPath: string | null;
  appliedCounts: Record<DoctorApplyTarget, number>;
  skippedTargets: DoctorApplyTarget[];
  failedTargets: DoctorTargetFailure[];
}

const INVALID_RETENTION_MESSAGE =
  "--keep-backups must be a positive safely representable integer";

/**
 * Resolve `--keep-backups` to a positive, safely representable integer.
 * Only plain decimal digits pass; forms `Number` would accept, such as
 * `1e3`, ` 5`, or an empty string, are rejected.
 */
export function resolveDoctorKeepBackups(supplied: string | undefined): number {
  if (supplied === undefined) {
    return DEFAULT_DOCTOR_KEEP_BACKUPS;
  }
  const parsed = /^\d+$/.test(supplied) ? Number(supplied) : Number.NaN;
  if (!isValidRetention(parsed)) {
    throw new Error(INVALID_RETENTION_MESSAGE);
  }
  return parsed;
}

/**
 * Report all findings and, with confirmation (explicit selections or all
 * targets under bare confirmation), apply them after one safety backup.
 * Whenever resolved targets contain `purgeBackups` (including report-only
 * selection), `excessBackups` counts the pending safety backup. Throws only
 * when validation or open errors make a usable report impossible; later
 * failures are reported in the returned payload alongside every available
 * finding.
 */
export async function runDoctor(
  input: DoctorInput,
  options: DoctorRunOptions = {},
): Promise<DoctorSuccessPayload> {
  const retention = resolveDoctorKeepBackups(input.keepBackups);
  const explicitTargets = DOCTOR_TARGET_ORDER.filter((target) => input[target]);
  const targets =
    explicitTargets.length > 0
      ? explicitTargets
      : input.yes === true
        ? [...DOCTOR_TARGET_ORDER]
        : [];
  const skippedTargets = DOCTOR_TARGET_ORDER.filter(
    (target) => !targets.includes(target),
  );
  const dryRun = input.yes !== true;

  const executor = options.executor ?? doctorSqlExecutor;
  const diagnostics = await collectDoctorDiagnostics({
    retention,
    countPendingBackup: targets.includes("purgeBackups"),
    executor,
  });
  let appliedCounts = zeroAppliedCounts();

  const failedTargets = evaluatePreflight(diagnostics);

  let backupPath: string | null = null;
  if (failedTargets.length === 0 && !dryRun) {
    try {
      backupPath = await createDoctorDatabaseBackup({
        databasePath: diagnostics.databasePath,
        ...(options.timestamp !== undefined && {
          timestamp: options.timestamp,
        }),
        executor,
        ...(options.backupOptions !== undefined && {
          backupOptions: options.backupOptions,
        }),
      });
    } catch (error) {
      failedTargets.push({
        target: "backup",
        message: extractErrorMessage(error),
      });
    }
    if (backupPath !== null) {
      const applied = await applyTargets(targets, {
        diagnostics,
        executor,
        retention,
        backupPath,
        options,
      });
      appliedCounts = applied.counts;
      failedTargets.push(...applied.failures);
    }
  }

  return {
    dryRun,
    targets,
    findings: diagnostics.findings,
    backupPath,
    appliedCounts,
    skippedTargets,
    failedTargets,
  };
}

/** Read-only scope one target applier operates over after the safety backup. */
interface ApplyContext {
  diagnostics: DoctorDiagnostics;
  executor: DoctorExecutor;
  retention: number;
  backupPath: string;
  options: DoctorRunOptions;
}

/** Count and per-target failures one applier reports back to the fold. */
interface TargetOutcome {
  count: number;
  failures: DoctorTargetFailure[];
}

type TargetApplier = (context: ApplyContext) => Promise<TargetOutcome>;

/** Zeroed apply counts for every canonical target. */
function zeroAppliedCounts(): Record<DoctorApplyTarget, number> {
  return { vacuum: 0, purgeBackups: 0, purgeLegacy: 0 };
}

interface ApplyOutcome {
  counts: Record<DoctorApplyTarget, number>;
  failures: DoctorTargetFailure[];
}

/**
 * Apply selected targets in canonical order after the safety backup. Each
 * target folds its outcome into the returned counts and failures, so one
 * failing target never stops later targets.
 */
async function applyTargets(
  targets: DoctorApplyTarget[],
  context: ApplyContext,
): Promise<ApplyOutcome> {
  const counts = zeroAppliedCounts();
  const failures: DoctorTargetFailure[] = [];
  for (const target of targets) {
    const outcome = await TARGET_APPLIERS[target](context);
    counts[target] = outcome.count;
    failures.push(...outcome.failures);
  }
  return { counts, failures };
}

/** Per-target appliers keyed by canonical target id. */
const TARGET_APPLIERS: Record<DoctorApplyTarget, TargetApplier> = {
  vacuum: applyVacuum,
  purgeBackups: applyPurgeBackups,
  purgeLegacy: applyPurgeLegacy,
};

/**
 * Exit predicate for the CLI: unhealthy diagnostics or any operational or
 * target failure require exit `1`.
 */
export function doctorResultIndicatesFailure(
  payload: DoctorSuccessPayload,
): boolean {
  if (payload.failedTargets.length > 0) return true;
  const integrity = payload.findings.integrityCheck;
  if (integrity === null || !integrity.ok) return true;
  const violations = payload.findings.foreignKeyCheck;
  if (violations === null || violations.length > 0) return true;
  return (
    payload.findings.freelistCount === null ||
    payload.findings.excessBackups === null ||
    payload.findings.legacyBackups === null ||
    payload.findings.strandedOriginals === null
  );
}

/**
 * Reclaim free pages only when the observed freelist exceeds zero. A busy
 * or failing `VACUUM` surfaces as a `vacuum` failure and never stops the
 * remaining selected targets.
 */
async function applyVacuum(context: ApplyContext): Promise<TargetOutcome> {
  if ((context.diagnostics.findings.freelistCount ?? 0) <= 0) {
    return { count: 0, failures: [] };
  }
  try {
    return {
      count: await context.executor.vacuum(context.diagnostics.databasePath),
      failures: [],
    };
  } catch (error) {
    return {
      count: 0,
      failures: [{ target: "vacuum", message: extractErrorMessage(error) }],
    };
  }
}

/** Reclaim retired managed backups, pinning the invocation's safety backup. */
async function applyPurgeBackups(
  context: ApplyContext,
): Promise<TargetOutcome> {
  const result = await purgeManagedBackups({
    dataRoot: context.diagnostics.dataRoot,
    retention: context.retention,
    pinnedPath: context.backupPath,
    ...(context.options.unlinkFile !== undefined && {
      unlinkFile: context.options.unlinkFile,
    }),
  });
  return { count: result.deleted, failures: result.failures };
}

/** Reclaim recorded legacy `.bak` copies from the classified findings. */
async function applyPurgeLegacy(context: ApplyContext): Promise<TargetOutcome> {
  const result = await purgeLegacyCopies({
    dataRoot: context.diagnostics.dataRoot,
    legacyBackups: context.diagnostics.findings.legacyBackups,
    ...(context.options.unlinkFile !== undefined && {
      unlinkFile: context.options.unlinkFile,
    }),
    ...(context.options.removeDirectory !== undefined && {
      removeDirectory: context.options.removeDirectory,
    }),
  });
  return { count: result.deleted, failures: result.failures };
}

/**
 * Fold completed diagnostics into prerequisite failures. Integrity defects,
 * foreign-key violations, and unavailable diagnostics all make preflight
 * unreliable, so they block every target and backup creation; duplicate
 * unavailability messages collapse into one entry.
 */
function evaluatePreflight(
  diagnostics: DoctorDiagnostics,
): DoctorTargetFailure[] {
  const failures: DoctorTargetFailure[] = [];
  const integrity = diagnostics.findings.integrityCheck;
  if (integrity !== null && !integrity.ok) {
    failures.push({
      target: "preflight",
      message: `integrity check failed: ${integrity.rows.join("; ")}`,
    });
  }
  for (const violation of diagnostics.findings.foreignKeyCheck ?? []) {
    failures.push({
      target: "preflight",
      message: `foreign-key violation: ${violation.table} rowid ${String(
        violation.rowid,
      )}`,
    });
  }
  const seen = new Set<string>();
  for (const failure of diagnostics.failures) {
    if (seen.has(failure.message)) continue;
    seen.add(failure.message);
    failures.push({ target: "preflight", message: failure.message });
  }
  return failures;
}
