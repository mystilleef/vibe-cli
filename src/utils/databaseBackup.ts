/**
 * Database backup mechanics shared by prune and doctor: take a transaction-consistent
 * SQLite snapshot via a child subprocess, stage it exclusively, and publish it into
 * the sibling `backups` directory through a no-replace hard link.
 *
 * The snapshot opens its own read-only connection, so callers need no open handle.
 * Every failure rejects without overwriting, truncating, or deleting prior backups
 * or completed final snapshots.
 */

import { randomUUID } from "node:crypto";
import { link, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import {
  type DatabaseSnapshotExecutor,
  type DatabaseSnapshotOptions,
  executeDatabaseSnapshot,
} from "./databaseSnapshot.js";
import { extractErrorMessage, makeErrno } from "./errors.js";
import { lstatOrMissing } from "./fsStats.js";

/** Filename prefix for prune safety backups. */
export const PRUNE_BACKUP_PREFIX = "vibe-prune-";

/** Filename prefix for doctor safety backups. */
export const DOCTOR_BACKUP_PREFIX = "vibe-doctor-";

export interface DatabaseBackupOptions extends DatabaseSnapshotOptions {
  /** Managed filename prefix: `PRUNE_BACKUP_PREFIX` or `DOCTOR_BACKUP_PREFIX`. */
  prefix: string;
  timestamp?: Date;
  /** Injectable snapshot executor for isolated unit tests. */
  snapshotExecutor?: DatabaseSnapshotExecutor;
  /** Injectable publication link for isolated unit tests. */
  linkExclusive?: (
    sourcePath: string,
    destinationPath: string,
  ) => Promise<void>;
  /** Injectable staging cleanup for isolated unit tests. */
  cleanupStaging?: (stagingDir: string) => Promise<void>;
}

/**
 * Timestamp label embedded in managed backup filenames: an ISO instant with
 * `.` and `:` rendered as `-`. This helper pair is the single naming
 * contract shared by backup creation, the retention inventory, and test
 * fixtures, so writer and reader cannot drift apart.
 */
export function formatBackupTimestampLabel(iso: string): string {
  return iso.replace(/[.:]/g, "-");
}

const BACKUP_TIMESTAMP_LABEL_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/;

/**
 * Parse a timestamp label produced by `formatBackupTimestampLabel`; `null`
 * when the label is malformed or names an impossible date. `Date.parse`
 * normalizes overflowing calendar dates such as February 30, so an accepted
 * label must round-trip back to the exact instant it names.
 */
export function parseBackupTimestampLabel(label: string): number | null {
  const iso = label.replace(
    BACKUP_TIMESTAMP_LABEL_PATTERN,
    "$1-$2-$3T$4:$5:$6.$7Z",
  );
  if (iso === label) return null;
  const timestampMs = Date.parse(iso);
  if (Number.isNaN(timestampMs)) return null;
  return new Date(timestampMs).toISOString() === iso ? timestampMs : null;
}

/** Observed entry shape of the managed `backups` directory. */
export type BackupsDirectoryShape =
  | "ok"
  | "missing"
  | "symlink"
  | "not-directory";

/**
 * Inspect the managed `backups` entry shape once for both the write-side
 * guard and the read-side inventory: a symlink or non-directory entry is
 * never a valid managed-backups location.
 */
export async function inspectBackupsDirectory(
  backupDirectory: string,
): Promise<BackupsDirectoryShape> {
  const existing = await lstatOrMissing(backupDirectory);
  if (existing === null) return "missing";
  if (existing.isSymbolicLink()) return "symlink";
  return existing.isDirectory() ? "ok" : "not-directory";
}

/** Never write through a linked or non-directory `backups` entry. */
async function assertSafeBackupDirectory(
  backupDirectory: string,
): Promise<void> {
  const shape = await inspectBackupsDirectory(backupDirectory);
  if (shape === "symlink") {
    throw new Error(`backup destination is a symlink: ${backupDirectory}`);
  }
  if (shape === "not-directory") {
    throw new Error(
      `backup destination is not a directory: ${backupDirectory}`,
    );
  }
}

/**
 * Back up the database at `sourcePath` into the sibling `backups` directory
 * that doctor's retention inventories. Resolves only after snapshot
 * execution and exclusive publication complete.
 *
 * Lock contention fails fast without retries: a rollback-journal writer
 * holding its lock rejects the snapshot rather than blocking it.
 *
 * Owned staging output is cleaned up on every outcome. Staging cleanup
 * failures surface diagnostics without mask. A post-publication cleanup
 * failure rejects without unlinking the completed final snapshot.
 */
export async function createDatabaseBackup(
  sourcePath: string,
  {
    prefix,
    timestamp = new Date(),
    snapshotExecutor = executeDatabaseSnapshot,
    linkExclusive = (src, dst) => link(src, dst),
    cleanupStaging = (dir) => rm(dir, { recursive: true, force: true }),
    ...snapshotOptions
  }: DatabaseBackupOptions,
): Promise<string> {
  if (!(timestamp instanceof Date) || Number.isNaN(timestamp.getTime())) {
    throw new Error(`invalid backup timestamp: ${String(timestamp)}`);
  }

  // `path.resolve("")` names the working directory, never a database file.
  if (sourcePath === "") {
    throw new Error("invalid database backup source path");
  }

  const resolvedSourcePath = path.resolve(sourcePath);
  const sourceStats = await lstatOrMissing(resolvedSourcePath);
  if (sourceStats === null) {
    throw makeErrno(
      "ENOENT",
      `source database does not exist: ${resolvedSourcePath}`,
    );
  }
  if (!sourceStats.isFile()) {
    throw new Error(
      `source database is not a regular file: ${resolvedSourcePath}`,
    );
  }

  const backupDirectory = path.join(
    path.dirname(resolvedSourcePath),
    "backups",
  );
  await assertSafeBackupDirectory(backupDirectory);
  await mkdir(backupDirectory, { recursive: true });
  await assertSafeBackupDirectory(backupDirectory);

  const label = formatBackupTimestampLabel(timestamp.toISOString());
  const stagingDirName = `.staging-${prefix}${label}-${randomUUID()}`;
  const stagingDir = path.join(backupDirectory, stagingDirName);
  // Exclusive creation with owner-only permissions; a permissive process
  // umask cannot widen the requested mode.
  await mkdir(stagingDir, { mode: 0o700 });

  const stagedDbPath = path.join(stagingDir, "backup.db");
  const finalBackupPath = path.join(backupDirectory, `${prefix}${label}.db`);

  try {
    await snapshotExecutor(resolvedSourcePath, stagedDbPath, snapshotOptions);
    await linkExclusive(stagedDbPath, finalBackupPath);
  } catch (primaryError) {
    try {
      await cleanupStaging(stagingDir);
    } catch (cleanupError) {
      const primaryMsg = extractErrorMessage(primaryError);
      const cleanupMsg = extractErrorMessage(cleanupError);
      throw new Error(`${primaryMsg}; staging cleanup failed: ${cleanupMsg}`);
    }
    throw primaryError;
  }

  try {
    await cleanupStaging(stagingDir);
  } catch (cleanupError) {
    const cleanupMsg = extractErrorMessage(cleanupError);
    throw new Error(
      `backup created at ${finalBackupPath}, but staging cleanup failed: ${cleanupMsg}`,
    );
  }

  return finalBackupPath;
}
