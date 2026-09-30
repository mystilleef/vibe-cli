/**
 * Doctor maintenance executor: the safety backup and the purges policy
 * applies over managed backups and recorded legacy `.bak` copies.
 *
 * Purge candidates come from diagnostics findings or a fresh managed-backup
 * inventory—never directory globbing—and every candidate is revalidated
 * immediately before removal so entries changed since collection are
 * preserved silently. Per-file problems never throw or stop later
 * candidates; outcomes report per-target `{ target, message }` failures
 * alongside deletion counts.
 */

import { rmdir, unlink } from "node:fs/promises";
import path from "node:path";
import type { DatabaseBackupOptions } from "./databaseBackup.js";
import {
  BACKUP_PATH_ROLE,
  checkContainedPath,
  isWithinRoot,
  verifyRecordedPath,
} from "./doctorPaths.js";
import { type DoctorExecutorOption, doctorSqlExecutor } from "./doctorSql.js";
import type { LegacyBackupsFinding } from "./doctorStorage.js";
import { extractErrorMessage, isEnoent } from "./errors.js";
import {
  assertValidRetention,
  type ManagedBackupEntry,
  parseManagedBackupName,
  readManagedBackupEntries,
} from "./managedBackups.js";

// ── Maintenance target contract ───────────────────────────────────────────

/** Maintenance target identifiers shared by storage, policy, and CLI. */
export type DoctorTargetId =
  | "preflight"
  | "backup"
  | "vacuum"
  | "purgeBackups"
  | "purgeLegacy";

/** Failure entry for a maintenance target: `{ target, message }`. */
export interface DoctorTargetFailure {
  target: DoctorTargetId;
  message: string;
}

/** Successful removals alongside failures reported after partial progress. */
export interface DoctorPurgeResult {
  deleted: number;
  failures: DoctorTargetFailure[];
}

export interface DoctorBackupOptions extends DoctorExecutorOption {
  databasePath: string;
  timestamp?: Date;
  backupOptions?: Partial<DatabaseBackupOptions>;
}

/**
 * Create the pre-maintenance safety backup. Resolves with the created path
 * only after snapshot execution and publication complete; failures reject so
 * policy can report `backupPath: null`.
 */
export function createDoctorDatabaseBackup({
  databasePath,
  timestamp = new Date(),
  executor = doctorSqlExecutor,
  backupOptions,
}: DoctorBackupOptions): Promise<string> {
  return executor.backup(path.resolve(databasePath), timestamp, backupOptions);
}

// ── Managed backup purge ──────────────────────────────────────────────────

/** Injectable unlink so tests can fail individual removals. */
export type UnlinkOperation = (target: string) => Promise<void>;

export interface PurgeManagedBackupsOptions {
  /** Data root containing the managed `backups/` directory. */
  dataRoot: string;
  /** Positive integer count of managed backups to keep. */
  retention: number;
  /** Exact safety backup path pinned for the current invocation. */
  pinnedPath: string;
  unlinkFile?: UnlinkOperation;
}

/**
 * Reclaim retired managed backups after backup creation. Re-inventories the
 * backups directory, keeps the newest `retention` files across both managed
 * prefixes plus the pinned safety backup (never deleted, even when clock
 * skew places it outside that set), and revalidates every candidate right
 * before unlink. Per-file problems never throw or stop later candidates;
 * vanished candidates are tolerated without being counted.
 */
export async function purgeManagedBackups({
  dataRoot,
  retention,
  pinnedPath,
  unlinkFile = unlink,
}: PurgeManagedBackupsOptions): Promise<DoctorPurgeResult> {
  assertValidRetention(retention);
  const resolvedRoot = path.resolve(dataRoot);
  const backupsDir = path.join(resolvedRoot, "backups");
  const pinned = path.resolve(pinnedPath);
  const inventory = await readManagedBackupEntries(backupsDir);
  if (!inventory.ok) {
    return {
      deleted: 0,
      failures: [
        {
          target: "purgeBackups",
          message: `managed backup inventory unavailable: ${inventory.error}`,
        },
      ],
    };
  }
  const candidates = inventory.entries
    .slice(retention)
    .filter((entry) => path.resolve(entry.filePath) !== pinned)
    .reverse();
  return unlinkRevalidatedCandidates({
    target: "purgeBackups",
    noun: "managed backup",
    candidates,
    resolvePath: (entry) => entry.filePath,
    revalidate: (entry) =>
      revalidateManagedBackup(entry, backupsDir, resolvedRoot),
    unlinkFile,
  });
}

/**
 * Re-check direct-directory membership, containment, filename shape, and
 * non-symlink regular-file components immediately before unlink. Entries
 * that changed since inventory are preserved silently; vanished candidates
 * are tolerated; genuine operational errors surface as failure messages.
 */
async function revalidateManagedBackup(
  entry: ManagedBackupEntry,
  backupsDir: string,
  dataRoot: string,
): Promise<UnlinkRevalidation> {
  if (path.dirname(entry.filePath) !== backupsDir) return { status: "skip" };
  if (!isWithinRoot(entry.filePath, backupsDir)) return { status: "skip" };
  if (parseManagedBackupName(entry.fileName) === null) {
    return { status: "skip" };
  }
  const check = await checkContainedPath(entry.filePath, dataRoot);
  if (check.status === "missing" || check.status === "unsafe") {
    return { status: "skip" };
  }
  if (check.status === "error") {
    return {
      status: "error",
      message: `managed backup revalidation failed for ${entry.filePath}: ${check.message}`,
    };
  }
  return check.isFile ? { status: "safe" } : { status: "skip" };
}

// ── Validated removal ─────────────────────────────────────────────────────

type UnlinkRevalidation =
  | { status: "safe" }
  | { status: "skip" }
  | { status: "error"; message: string };

interface ValidatedUnlinkOptions<T> {
  /** Target id recorded in every failure. */
  target: DoctorTargetId;
  /** Failure-message noun: `managed backup` or `legacy copy`. */
  noun: string;
  candidates: readonly T[];
  /** Absolute path the candidate removes under. */
  resolvePath: (candidate: T) => string;
  /** Pre-unlink revalidation verdict per candidate. */
  revalidate: (candidate: T, filePath: string) => Promise<UnlinkRevalidation>;
  unlinkFile: UnlinkOperation;
}

/**
 * Shared destructive-removal loop for both purges: revalidate each candidate
 * immediately before unlink so entries changed since inventory are preserved
 * silently, tolerate vanished candidates, and never let one per-file problem
 * throw or stop later candidates.
 */
async function unlinkRevalidatedCandidates<T>({
  target,
  noun,
  candidates,
  resolvePath,
  revalidate,
  unlinkFile,
}: ValidatedUnlinkOptions<T>): Promise<DoctorPurgeResult> {
  const failures: DoctorTargetFailure[] = [];
  let deleted = 0;
  for (const candidate of candidates) {
    const filePath = resolvePath(candidate);
    const verdict = await revalidate(candidate, filePath);
    if (verdict.status === "skip") continue;
    if (verdict.status === "error") {
      failures.push({ target, message: verdict.message });
      continue;
    }
    try {
      await unlinkFile(filePath);
      deleted += 1;
    } catch (error) {
      if (isEnoent(error)) continue;
      failures.push({
        target,
        message: `failed to remove ${noun} ${filePath}: ${extractErrorMessage(error)}`,
      });
    }
  }
  return { deleted, failures };
}

// ── Legacy copy purge ─────────────────────────────────────────────────────

/** Injectable nonrecursive directory removal for the empty legacy dir. */
export type RmdirOperation = (target: string) => Promise<void>;

export interface PurgeLegacyCopiesOptions {
  /** Data root containing recorded legacy artifacts. */
  dataRoot: string;
  /** Recorded legacy `.bak` classification produced by diagnostics. */
  legacyBackups: LegacyBackupsFinding | null;
  unlinkFile?: UnlinkOperation;
  removeDirectory?: RmdirOperation;
}

/**
 * Reclaim recorded legacy `.bak` copies after backup creation. Classification
 * drives every candidate—never directory globbing—so only files the importer
 * recorded qualify; rejected records surface as `purgeLegacy` failures.
 * Candidates are revalidated right before unlink. Only `.bak` copies qualify,
 * so recorded `.json` originals are never deleted. The empty legacy
 * `sessions/` directory is removed nonrecursively afterward. Per-file
 * problems never throw or stop later candidates.
 */
export async function purgeLegacyCopies({
  dataRoot,
  legacyBackups,
  unlinkFile = unlink,
  removeDirectory = rmdir,
}: PurgeLegacyCopiesOptions): Promise<DoctorPurgeResult> {
  const resolvedRoot = path.resolve(dataRoot);
  const failures: DoctorTargetFailure[] = [];
  let deleted = 0;

  if (!legacyBackups) {
    failures.push({
      target: "purgeLegacy",
      message: "legacy record inventory unavailable",
    });
  } else {
    for (const entry of legacyBackups.rejected) {
      failures.push({
        target: "purgeLegacy",
        message: `legacy cleanup refused for ${entry.path}: ${entry.message}`,
      });
    }
    const purged = await unlinkRevalidatedCandidates({
      target: "purgeLegacy",
      noun: "legacy copy",
      candidates: legacyBackups.candidates,
      resolvePath: (candidate) => path.resolve(resolvedRoot, candidate.path),
      revalidate: async (_candidate, resolved) => {
        const verdict = await verifyRecordedPath(
          resolved,
          resolvedRoot,
          BACKUP_PATH_ROLE,
        );
        if (verdict.status === "missing") return { status: "skip" };
        if (verdict.status === "safe") return { status: "safe" };
        const prefix =
          verdict.status === "rejected"
            ? "legacy cleanup refused"
            : "legacy copy revalidation failed";
        return {
          status: "error",
          message: `${prefix} for ${resolved}: ${verdict.message}`,
        };
      },
      unlinkFile,
    });
    deleted = purged.deleted;
    failures.push(...purged.failures);
  }

  await removeLegacySessionsDirectory(resolvedRoot, removeDirectory, failures);
  return { deleted, failures };
}

/**
 * Remove the legacy `sessions/` directory nonrecursively when it is a safe,
 * empty directory. Missing and nonempty directories are preserved silently;
 * unsafe paths and genuine operational errors surface as target failures.
 */
async function removeLegacySessionsDirectory(
  dataRoot: string,
  removeDirectory: RmdirOperation,
  failures: DoctorTargetFailure[],
): Promise<void> {
  const sessionsPath = path.join(dataRoot, "sessions");
  const check = await checkContainedPath(sessionsPath, dataRoot);
  if (check.status === "missing") return;
  if (check.status === "error") {
    failures.push({
      target: "purgeLegacy",
      message: `failed to remove legacy sessions directory ${sessionsPath}: ${check.message}`,
    });
    return;
  }
  if (check.status === "unsafe") {
    failures.push({
      target: "purgeLegacy",
      message: `unsafe legacy sessions directory ${sessionsPath}: ${check.message}`,
    });
    return;
  }
  if (check.isFile) {
    failures.push({
      target: "purgeLegacy",
      message: `unsafe legacy sessions directory ${sessionsPath}: legacy sessions path is not a directory`,
    });
    return;
  }
  try {
    await removeDirectory(sessionsPath);
  } catch (error) {
    if (isIgnorableSessionsRemovalError(error)) return;
    failures.push({
      target: "purgeLegacy",
      message: `failed to remove legacy sessions directory ${sessionsPath}: ${extractErrorMessage(error)}`,
    });
  }
}

/** Missing and nonempty directories survive sessions cleanup without failure. */
function isIgnorableSessionsRemovalError(error: unknown): boolean {
  if (isEnoent(error)) return true;
  const code = (error as NodeJS.ErrnoException).code;
  return code === "ENOTEMPTY" || code === "EEXIST";
}
