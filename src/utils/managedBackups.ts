/**
 * Managed backup inventory: filename shape, embedded timestamps, the
 * retention-count invariant, and the sorted inventory of the data root
 * `backups/` directory. Shared by diagnostics findings (`doctorStorage.ts`)
 * and purge revalidation (`doctorMaintenance.ts`) so collection and removal
 * read one inventory.
 */

import { readdir } from "node:fs/promises";
import path from "node:path";
import {
  DOCTOR_BACKUP_PREFIX,
  inspectBackupsDirectory,
  PRUNE_BACKUP_PREFIX,
  parseBackupTimestampLabel,
} from "./databaseBackup.js";
import { extractErrorMessage, isEnoent } from "./errors.js";

const MANAGED_BACKUP_PREFIXES = [PRUNE_BACKUP_PREFIX, DOCTOR_BACKUP_PREFIX];

export interface ManagedBackupEntry {
  fileName: string;
  filePath: string;
  timestampMs: number;
}

export async function readManagedBackupEntries(
  backupsDir: string,
): Promise<
  { ok: true; entries: ManagedBackupEntry[] } | { ok: false; error: string }
> {
  try {
    const shape = await inspectBackupsDirectory(backupsDir);
    if (shape === "symlink") {
      return { ok: false, error: "backups directory is a symlink" };
    }
    if (shape === "not-directory") {
      return { ok: false, error: "backups path is not a directory" };
    }
    if (shape === "missing") {
      return { ok: true, entries: [] };
    }
    const dirents = await readdir(backupsDir, { withFileTypes: true });
    const entries: ManagedBackupEntry[] = [];
    for (const dirent of dirents) {
      if (!dirent.isFile()) continue;
      const timestampMs = parseManagedBackupName(dirent.name);
      if (timestampMs === null) continue;
      entries.push({
        fileName: dirent.name,
        filePath: path.join(backupsDir, dirent.name),
        timestampMs,
      });
    }
    entries.sort(compareManagedBackups);
    return { ok: true, entries };
  } catch (error) {
    if (isEnoent(error)) return { ok: true, entries: [] };
    return { ok: false, error: extractErrorMessage(error) };
  }
}

/** Parse a managed backup filename into its embedded timestamp. */
export function parseManagedBackupName(fileName: string): number | null {
  const prefix = MANAGED_BACKUP_PREFIXES.find((candidate) =>
    fileName.startsWith(candidate),
  );
  if (!prefix || !fileName.endsWith(".db")) return null;
  return parseBackupTimestampLabel(
    fileName.slice(prefix.length, -".db".length),
  );
}

function compareManagedBackups(
  a: ManagedBackupEntry,
  b: ManagedBackupEntry,
): number {
  if (a.timestampMs !== b.timestampMs) return b.timestampMs - a.timestampMs;
  return a.fileName < b.fileName ? -1 : a.fileName > b.fileName ? 1 : 0;
}

/** Retention is a positive safely representable count of backups to keep. */
export function isValidRetention(retention: number): boolean {
  return Number.isSafeInteger(retention) && retention >= 1;
}

/** Throw unless `retention` satisfies the retention-count invariant. */
export function assertValidRetention(retention: number): void {
  if (!isValidRetention(retention)) {
    throw new Error(
      `invalid retention: expected a positive integer, received ${String(retention)}`,
    );
  }
}
