/**
 * Doctor storage contract: non-mutating diagnostics over existing local
 * storage and the candidate collection maintenance consumes.
 *
 * `collectDoctorDiagnostics` reports health and filesystem findings and
 * never creates, migrates, imports, repairs, or mutates anything. It
 * rejects when open-level errors make a report impossible (missing root,
 * missing database, corrupt database, pending migrations) and otherwise
 * resolves with pre-apply findings; unavailable diagnostics surface
 * as `null` findings paired with `{ target, message }` failures.
 *
 * SQL work goes through a `DoctorExecutor` (`doctorSql.ts`), injectable so
 * tests control SQL outcomes. The safety backup and purges live in
 * `doctorMaintenance.ts`, which reuses the managed-backup inventory
 * (`managedBackups.ts`) and the recorded-path safety contract
 * (`doctorPaths.ts`) so collection and revalidation share one source
 * of truth.
 */

import path from "node:path";
import { getDatabasePath } from "./database.js";
import { getDataRoot } from "./db-core.js";
import {
  ARTIFACT_PATH_ROLE,
  BACKUP_PATH_ROLE,
  type RecordedPathRole,
  verifyRecordedPath,
} from "./doctorPaths.js";
import {
  type DoctorExecutorOption,
  type DoctorLegacyRecordRow,
  type DoctorSection,
  type DoctorSqlDiagnostics,
  doctorSqlExecutor,
  type ForeignKeyViolation,
} from "./doctorSql.js";
import { statOrMissing } from "./fsStats.js";
import {
  assertValidRetention,
  readManagedBackupEntries,
} from "./managedBackups.js";

// ── Findings contract ─────────────────────────────────────────────────────

/** `PRAGMA integrity_check` outcome; healthy only for a lone `ok` row. */
export interface IntegrityCheckFinding {
  rows: string[];
  ok: boolean;
}

/** A recorded legacy path classified as present and safe. */
export interface LegacyRecordRef {
  artifact: string;
  path: string;
}

/** A recorded legacy path preserved as unsafe evidence. */
export interface RejectedLegacyRecord extends LegacyRecordRef {
  message: string;
}

/** Classification of recorded legacy `.bak` copies. */
export interface LegacyBackupsFinding {
  candidates: LegacyRecordRef[];
  rejected: RejectedLegacyRecord[];
}

/** Typed pre-apply findings; unavailable diagnostics are `null`. */
export interface DoctorFindings {
  integrityCheck: IntegrityCheckFinding | null;
  foreignKeyCheck: ForeignKeyViolation[] | null;
  freelistCount: number | null;
  /** Managed backups beyond retention, including any pending safety backup. */
  excessBackups: number | null;
  latestBackupPath: string | null;
  legacyBackups: LegacyBackupsFinding | null;
  strandedOriginals: LegacyRecordRef[] | null;
}

export type DoctorFindingName = keyof DoctorFindings;

/** Findings one source contributes, with its unavailable-diagnostic failures. */
interface FindingsFold<K extends DoctorFindingName> {
  findings: Pick<DoctorFindings, K>;
  failures: DoctorDiagnosticFailure[];
}

/** Failure entry for an unavailable diagnostic finding. */
export interface DoctorDiagnosticFailure {
  target: DoctorFindingName;
  message: string;
}

/** Resolved diagnostics report. */
export interface DoctorDiagnostics {
  dataRoot: string;
  databasePath: string;
  findings: DoctorFindings;
  failures: DoctorDiagnosticFailure[];
}

// ── Collection ────────────────────────────────────────────────────────────

export interface DoctorDiagnosticsOptions extends DoctorExecutorOption {
  /** Positive integer count of managed backups to keep. */
  retention: number;
  /**
   * Count the safety backup an apply creates before purging, so
   * `excessBackups` predicts what `--purge-backups` removes.
   */
  countPendingBackup?: boolean;
}

/**
 * Collect non-mutating health and filesystem diagnostics for existing
 * storage. Throws when validation or open errors prevent a usable report;
 * resolves partial reports for later diagnostic failures.
 */
export async function collectDoctorDiagnostics({
  retention,
  countPendingBackup = false,
  executor = doctorSqlExecutor,
}: DoctorDiagnosticsOptions): Promise<DoctorDiagnostics> {
  assertValidRetention(retention);
  const dataRoot = path.resolve(getDataRoot());
  const databasePath = path.resolve(getDatabasePath());
  await requireExistingStorage(dataRoot, databasePath);

  const sql = await executor.diagnose(databasePath);
  const sqlFold = foldSqlDiagnostics(sql);
  const findings: DoctorFindings = {
    ...sqlFold.findings,
    excessBackups: null,
    latestBackupPath: null,
    legacyBackups: null,
    strandedOriginals: null,
  };
  const failures: DoctorDiagnosticFailure[] = [...sqlFold.failures];

  const backupsFold = await collectBackupFindings(
    path.join(dataRoot, "backups"),
    retention,
    countPendingBackup ? 1 : 0,
  );
  findings.excessBackups = backupsFold.findings.excessBackups;
  findings.latestBackupPath = backupsFold.findings.latestBackupPath;
  failures.push(...backupsFold.failures);

  const legacyFold = await collectLegacyFindings(sql.legacyRecords, dataRoot);
  findings.legacyBackups = legacyFold.findings.legacyBackups;
  findings.strandedOriginals = legacyFold.findings.strandedOriginals;
  failures.push(...legacyFold.failures);

  return { dataRoot, databasePath, findings, failures };
}

/** Map one diagnostic snapshot's SQL sections into findings and failures. */
function foldSqlDiagnostics(
  sql: DoctorSqlDiagnostics,
): FindingsFold<"integrityCheck" | "foreignKeyCheck" | "freelistCount"> {
  const findings = {
    integrityCheck: sql.integrityCheck.ok
      ? {
          rows: sql.integrityCheck.value,
          ok:
            sql.integrityCheck.value.length === 1 &&
            sql.integrityCheck.value[0] === "ok",
        }
      : null,
    foreignKeyCheck: sql.foreignKeyCheck.ok ? sql.foreignKeyCheck.value : null,
    freelistCount: sql.freelistCount.ok ? sql.freelistCount.value : null,
  };
  const failures: DoctorDiagnosticFailure[] = [];
  for (const [target, section] of [
    ["integrityCheck", sql.integrityCheck],
    ["foreignKeyCheck", sql.foreignKeyCheck],
    ["freelistCount", sql.freelistCount],
  ] as const) {
    if (!section.ok) failures.push({ target, message: section.error });
  }
  return { findings, failures };
}

/**
 * Inventory managed backups into findings; an unavailable inventory leaves
 * both findings null and fails each with the same message.
 */
async function collectBackupFindings(
  backupsDir: string,
  retention: number,
  pendingBackups: number,
): Promise<FindingsFold<"excessBackups" | "latestBackupPath">> {
  const backups = await collectManagedBackups(
    backupsDir,
    retention,
    pendingBackups,
  );
  if (backups.ok) {
    return {
      findings: {
        excessBackups: backups.excess,
        latestBackupPath: backups.latestPath,
      },
      failures: [],
    };
  }
  const message = `managed backup inventory unavailable: ${backups.error}`;
  return {
    findings: { excessBackups: null, latestBackupPath: null },
    failures: [
      { target: "excessBackups", message },
      { target: "latestBackupPath", message },
    ],
  };
}

// ── Managed backup findings ──────────────────────────────────────────────

type BackupInventory =
  | { ok: true; excess: number; latestPath: string | null }
  | { ok: false; error: string };

async function collectManagedBackups(
  backupsDir: string,
  retention: number,
  pendingBackups: number,
): Promise<BackupInventory> {
  const entries = await readManagedBackupEntries(backupsDir);
  if (!entries.ok) return entries;
  const sorted = entries.entries;
  return {
    ok: true,
    excess: Math.max(0, sorted.length + pendingBackups - retention),
    latestPath: sorted[0]?.filePath ?? null,
  };
}

// ── Legacy record classification ──────────────────────────────────────────

/** Check whether a raw path spelling contains any parent-directory traversal component. */
function hasTraversalComponent(rawPath: string): boolean {
  return rawPath.split(/[/\\]/).includes("..");
}

interface LegacyClassification {
  candidates: LegacyRecordRef[];
  rejected: RejectedLegacyRecord[];
  stranded: LegacyRecordRef[];
}

type LegacyInventory =
  | ({ ok: true } & LegacyClassification)
  | { ok: false; error: string };

async function classifyLegacyRecords(
  records: DoctorLegacyRecordRow[],
  dataRoot: string,
): Promise<LegacyInventory> {
  const candidates = new Map<string, LegacyRecordRef>();
  const stranded = new Map<string, LegacyRecordRef>();
  const rejected: RejectedLegacyRecord[] = [];
  const errors: string[] = [];

  const backupContext = { dataRoot, accepted: candidates, rejected, errors };
  const artifactContext = { dataRoot, accepted: stranded, rejected, errors };

  for (const record of records) {
    await classifyRecordedPath(
      backupContext,
      record,
      record.backupPath,
      BACKUP_PATH_ROLE,
    );
    await classifyRecordedPath(
      artifactContext,
      record,
      record.artifact,
      ARTIFACT_PATH_ROLE,
    );
  }
  const [firstError] = errors;
  if (firstError !== undefined) {
    return { ok: false, error: firstError };
  }
  return {
    ok: true,
    candidates: [...candidates.values()],
    rejected,
    stranded: [...stranded.values()],
  };
}

/** Shared sinks one recorded-path role classifies into. */
interface ClassificationContext {
  dataRoot: string;
  accepted: Map<string, LegacyRecordRef>;
  rejected: RejectedLegacyRecord[];
  errors: string[];
}

/**
 * Classify one recorded path of the given role into the accepted, rejected,
 * or error sink. The traversal-component check applies only here: purge
 * revalidation receives already-resolved candidates whose spelling cannot
 * carry raw traversal, and must keep reporting escapes as escapes.
 */
async function classifyRecordedPath(
  context: ClassificationContext,
  record: DoctorLegacyRecordRow,
  rawPath: string,
  role: RecordedPathRole,
): Promise<void> {
  if (hasTraversalComponent(rawPath)) {
    context.rejected.push({
      artifact: record.artifact,
      path: rawPath,
      message: `${role.subject} contains path traversal`,
    });
    return;
  }
  const resolved = path.resolve(context.dataRoot, rawPath);
  const verdict = await verifyRecordedPath(resolved, context.dataRoot, role);
  if (verdict.status === "error") {
    context.errors.push(verdict.message);
    return;
  }
  if (verdict.status === "missing") return;
  if (verdict.status === "rejected") {
    context.rejected.push({
      artifact: record.artifact,
      path: rawPath,
      message: verdict.message,
    });
    return;
  }
  if (!context.accepted.has(resolved)) {
    context.accepted.set(resolved, {
      artifact: record.artifact,
      path: resolved,
    });
  }
}

/**
 * Classify recorded legacy paths into findings; an unavailable inventory
 * leaves both findings null and fails each with the same message.
 */
async function collectLegacyFindings(
  records: DoctorSection<DoctorLegacyRecordRow[]>,
  dataRoot: string,
): Promise<FindingsFold<"legacyBackups" | "strandedOriginals">> {
  if (!records.ok) {
    return unavailableLegacyFindings(records.error);
  }
  const legacy = await classifyLegacyRecords(records.value, dataRoot);
  if (!legacy.ok) {
    return unavailableLegacyFindings(
      `legacy record inventory unavailable: ${legacy.error}`,
    );
  }
  return {
    findings: {
      legacyBackups: {
        candidates: legacy.candidates,
        rejected: legacy.rejected,
      },
      strandedOriginals: legacy.stranded,
    },
    failures: [],
  };
}

/** Both legacy findings unavailable, failed with one shared message. */
function unavailableLegacyFindings(
  message: string,
): FindingsFold<"legacyBackups" | "strandedOriginals"> {
  return {
    findings: { legacyBackups: null, strandedOriginals: null },
    failures: [
      { target: "legacyBackups", message },
      { target: "strandedOriginals", message },
    ],
  };
}

// ── Guards ────────────────────────────────────────────────────────────────

async function requireExistingStorage(
  dataRoot: string,
  databasePath: string,
): Promise<void> {
  const rootStats = await statOrMissing(dataRoot);
  if (!rootStats) {
    throw new Error(`vibe data root not found: ${dataRoot}`);
  }
  if (!rootStats.isDirectory()) {
    throw new Error(`vibe data root is not a directory: ${dataRoot}`);
  }
  const databaseStats = await statOrMissing(databasePath);
  if (!databaseStats) {
    throw new Error(`vibe database not found: ${databasePath}`);
  }
  if (!databaseStats.isFile()) {
    throw new Error(`vibe database is not a regular file: ${databasePath}`);
  }
}
