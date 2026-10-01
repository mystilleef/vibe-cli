/**
 * Doctor SQL operations over existing-only connections.
 *
 * Opening never creates, migrates, initializes, or imports, and every
 * connection keeps foreign-key enforcement on. Diagnostic connections are
 * read-only and read the original inside one transaction, so every section
 * sees one consistent state, pending WAL contents included, and never
 * checkpoints or changes journal modes. SQLite may leave its own empty
 * `-wal`/`-shm` files beside an idle WAL database; the next vibe connection
 * removes them. Vacuum opens a fresh write-capable connection only when
 * policy calls for it; backup snapshots through its own read-only child.
 */
import { Database } from "bun:sqlite";
import {
  applyBusyTimeout,
  configureConnection,
  getMigrationIds,
  readAppliedMigrationIds,
  SQLITE_BUSY_TIMEOUT_DISABLED,
} from "./database.js";
import {
  createDatabaseBackup,
  type DatabaseBackupOptions,
  DOCTOR_BACKUP_PREFIX,
} from "./databaseBackup.js";
import { extractErrorMessage } from "./errors.js";

/** Result of one independently collected SQL diagnostic section. */
export type DoctorSection<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

/** One foreign-key violation; `rowid` is null for WITHOUT ROWID tables. */
export interface ForeignKeyViolation {
  table: string;
  rowid: number | null;
}

/** One recorded `legacy_imports` row read from storage. */
export interface DoctorLegacyRecordRow {
  artifact: string;
  backupPath: string;
}

/** Raw SQL diagnostics read from one snapshot. */
export interface DoctorSqlDiagnostics {
  integrityCheck: DoctorSection<string[]>;
  foreignKeyCheck: DoctorSection<ForeignKeyViolation[]>;
  freelistCount: DoctorSection<number>;
  legacyRecords: DoctorSection<DoctorLegacyRecordRow[]>;
}

/**
 * SQL operations doctor depends on. Injectable so policy and findings tests
 * control SQL outcomes without seeding corrupt databases.
 */
export interface DoctorExecutor {
  diagnose(databasePath: string): Promise<DoctorSqlDiagnostics>;
  backup(
    databasePath: string,
    timestamp: Date,
    options?: Partial<DatabaseBackupOptions>,
  ): Promise<string>;
  /** Run one `VACUUM`; resolves with the free pages it reclaimed. */
  vacuum(databasePath: string): Promise<number>;
}

/** Shared injectable-executor seam for doctor-family option contracts. */
export interface DoctorExecutorOption {
  /** Injectable SQL executor; defaults to `doctorSqlExecutor`. */
  executor?: DoctorExecutor;
}

/** Connection modes for existing-only doctor connections. */
export type DoctorConnectionMode = "read-only" | "write";

/**
 * Open an existing database without creating or initializing it, so a
 * missing or moved database fails instead of being recreated empty.
 * Callers own and must close the returned handle.
 */
export function openExistingDatabase(
  databasePath: string,
  mode: DoctorConnectionMode,
): Database {
  const db =
    mode === "write"
      ? new Database(databasePath, { readwrite: true, create: false })
      : new Database(databasePath, { readonly: true, create: false });
  try {
    configureConnection(db);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

/**
 * Run `fn` with a fresh existing-only connection, closing the handle on
 * every outcome.
 */
export async function withExistingDatabase<T>(
  databasePath: string,
  mode: DoctorConnectionMode,
  fn: (db: Database) => T | Promise<T>,
): Promise<T> {
  const db = openExistingDatabase(databasePath, mode);
  try {
    return await fn(db);
  } finally {
    db.close();
  }
}

/**
 * Collect raw SQL diagnostics over a read-only existing connection. One read
 * transaction pins a single snapshot, so a concurrent writer cannot tear or
 * mix evidence across sections. Unmigrated databases reject; individual
 * sections stay independent so one failing pragma cannot hide other evidence.
 */
export async function runDiagnose(
  databasePath: string,
): Promise<DoctorSqlDiagnostics> {
  return withExistingDatabase(databasePath, "read-only", (db) =>
    db.transaction(() => {
      assertMigrated(db);
      return {
        integrityCheck: readSection(() => readIntegrityRows(db)),
        foreignKeyCheck: readSection(() => readForeignKeyRows(db)),
        freelistCount: readSection(() => readFreelistCount(db)),
        legacyRecords: readSection(() => readLegacyRecords(db)),
      };
    })(),
  );
}

/**
 * Create the pre-maintenance safety backup.
 */
function runBackup(
  databasePath: string,
  timestamp: Date,
  options?: Partial<DatabaseBackupOptions>,
): Promise<string> {
  return createDatabaseBackup(databasePath, {
    prefix: DOCTOR_BACKUP_PREFIX,
    timestamp,
    ...options,
  });
}

/**
 * Execute one `VACUUM` and resolve with the free pages it reclaimed.
 * `VACUUM` rebuilds the file without a freelist, so every page free when it
 * runs is reclaimed; a post-`VACUUM` read would instead subtract pages a
 * concurrent writer frees afterward. Contention fails fast with
 * `SQLITE_BUSY` instead of a blocking wait, so policy can record a visible
 * failed vacuum target without retries.
 */
export async function runVacuum(databasePath: string): Promise<number> {
  return withExistingDatabase(databasePath, "write", (db) => {
    applyBusyTimeout(db, SQLITE_BUSY_TIMEOUT_DISABLED);
    const freePages = readFreelistCount(db);
    db.run("VACUUM");
    return freePages;
  });
}

/** Default executor: each operation opens and closes its own connection. */
export const doctorSqlExecutor: DoctorExecutor = {
  diagnose: runDiagnose,
  backup: runBackup,
  vacuum: runVacuum,
};

/**
 * Doctor never migrates, and diagnostics against an older schema cannot be
 * trusted, so a database behind this release's migrations rejects naming
 * the pending ids. The migration list is the single schema authority.
 */
function assertMigrated(db: Database): void {
  const applied = new Set(readAppliedMigrationIds(db));
  const pending = getMigrationIds().filter((id) => !applied.has(id));
  if (pending.length > 0) {
    throw new Error(
      `pending migrations: ${pending.join(", ")}; run \`vibe migrate\` to apply them`,
    );
  }
}

function readIntegrityRows(db: Database): string[] {
  return db
    .query<{ integrity_check: string }, []>("PRAGMA integrity_check")
    .all()
    .map((row) => row.integrity_check);
}

function readForeignKeyRows(db: Database): ForeignKeyViolation[] {
  return db
    .query<{ table: string; rowid: number | null }, []>(
      "PRAGMA foreign_key_check",
    )
    .all()
    .map((row) => ({ table: row.table, rowid: row.rowid }));
}

function readFreelistCount(db: Database): number {
  const row = db
    .query<{ freelist_count: number }, []>("PRAGMA freelist_count")
    .get();
  if (row === null) {
    throw new Error("freelist_count returned no row");
  }
  return row.freelist_count;
}

function readLegacyRecords(db: Database): DoctorLegacyRecordRow[] {
  return db
    .query<{ artifact: string; backup_path: string }, []>(
      "SELECT artifact, backup_path FROM legacy_imports ORDER BY artifact, backup_path",
    )
    .all()
    .map((row) => ({ artifact: row.artifact, backupPath: row.backup_path }));
}

function readSection<T>(read: () => T): DoctorSection<T> {
  try {
    return { ok: true, value: read() };
  } catch (error) {
    return { ok: false, error: extractErrorMessage(error) };
  }
}
