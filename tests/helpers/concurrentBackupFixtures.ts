/**
 * Test fixtures and process coordination helpers for testing SQLite backup
 * snapshot consistency under coordinated concurrency.
 *
 * Provides multi-page WAL database seeding with generation markers,
 * independent writer, checkpointer, pinned-reader, and exclusive-lock
 * child processes, and strict generation-consistency assertions.
 */

import { Database } from "bun:sqlite";
import { copyFileSync, existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ReadableStreamDefaultReader } from "node:stream/web";
import type { FileSink } from "bun";
import { initializeSchema } from "../../src/utils/database.js";

/** Default row count ensuring the seeded database spans multiple SQLite pages in WAL. */
export const DEFAULT_MULTI_PAGE_ROW_COUNT = 1500;

/** Size of the payload string attached to each row to span pages. */
const ROW_PAYLOAD_SIZE = 2500;

/** Deterministic payload shared by the seed writer and the preservation oracle. */
const ROW_PAYLOAD = "x".repeat(ROW_PAYLOAD_SIZE);

export interface MultiPageSeedResult {
  readonly dbPath: string;
  readonly rowCount: number;
  readonly initialPageCount: number;
  readonly walSizeBytes: number;
}

export interface SeedMultiPageDatabaseOptions {
  rowCount?: number;
  journalMode?: "WAL" | "DELETE";
}

/**
 * Seed a real multi-page database with exact expected row identities,
 * linked records, schema objects, legacy-import markers, and generation-1 payloads
 * spanning many pages.
 */
export function seedMultiPageDatabase(
  dataRoot: string,
  options: SeedMultiPageDatabaseOptions = {},
): MultiPageSeedResult {
  const { rowCount = DEFAULT_MULTI_PAGE_ROW_COUNT, journalMode = "WAL" } =
    options;
  mkdirSync(dataRoot, { recursive: true });
  const dbPath = join(dataRoot, "vibe.db");
  const db = new Database(dbPath);

  try {
    initializeSchema(db);
    db.run(`PRAGMA journal_mode = ${journalMode}`);
    if (journalMode === "WAL") {
      db.run("PRAGMA wal_autocheckpoint = 0");
    }

    db.run(
      "INSERT INTO sessions (id, cwd_key, created_at, last_accessed_at, cwd) " +
        "VALUES ('session-1', 'key-1', '2026-01-01T00:00:00.000Z', '[gen:1:accessed]', '/tmp/session-1')",
    );

    const insertRule = db.prepare(
      "INSERT INTO constitution_rules (session_id, rule, position, created_at) VALUES (?, ?, ?, ?)",
    );
    insertRule.run(
      "session-1",
      "[gen:1:rule:0] safety first",
      0,
      "2026-01-01T00:00:00.000Z",
    );
    insertRule.run(
      "session-1",
      "[gen:1:rule:1] verify invariants",
      1,
      "2026-01-01T00:00:00.000Z",
    );
    insertRule.finalize();

    const insertInteraction = db.prepare(
      "INSERT INTO interactions (session_id, goal, output, timestamp) VALUES (?, ?, ?, ?)",
    );
    insertInteraction.run(
      "session-1",
      "[gen:1:goal:0]",
      '{"status":"[gen:1:out:0]"}',
      100,
    );
    insertInteraction.run(
      "session-1",
      "[gen:1:goal:1]",
      '{"status":"[gen:1:out:1]"}',
      101,
    );
    insertInteraction.finalize();

    db.run(
      "INSERT INTO legacy_imports (artifact, imported_at, backup_path) " +
        "VALUES ('legacy-artifact.json', '2026-01-01T00:00:00.000Z', 'legacy-backup.json')",
    );

    const insertLearning = db.prepare(
      "INSERT INTO learning_entries (type, category, observation, solution, timestamp) " +
        "VALUES (?, ?, ?, ?, ?)",
    );

    db.run("BEGIN");
    for (let i = 0; i < rowCount; i++) {
      insertLearning.run(
        "mistake",
        "gen1",
        `[gen:1:row:${i}] ${ROW_PAYLOAD}`,
        `[gen:1:sol:${i}]`,
        10000 + i,
      );
    }
    db.run("COMMIT");
    insertLearning.finalize();

    const pageCountQuery = db.query<{ page_count: number }, []>(
      "PRAGMA page_count",
    );
    const initialPageCount = pageCountQuery.get()?.page_count ?? 0;
    pageCountQuery.finalize();

    const walPath = `${dbPath}-wal`;
    const walSizeBytes = existsSync(walPath) ? statSync(walPath).size : 0;

    return {
      dbPath,
      rowCount,
      initialPageCount,
      walSizeBytes,
    };
  } finally {
    db.close();
  }
}

export interface BackupGenerationCheck {
  readonly generation: "gen1" | "gen2";
  readonly rowCount: number;
  readonly pageCount: number;
  readonly integrityCheck: string;
}

/** One exact learning-entry row expected from the deterministic seed. */
export interface ExpectedLearningRow {
  readonly id: number;
  readonly type: string;
  readonly category: string;
  readonly observation: string;
  readonly solution: string;
  readonly demo_id: string | null;
  readonly timestamp: number;
}

export interface BackupGenerationExpectations {
  /** Base learning row count seeded with generation-tagged payloads. */
  readonly rowCount?: number;
  /** Additional committed rows appended after the base rows. */
  readonly extraLearningRows?: readonly ExpectedLearningRow[];
}

interface LearningRow {
  readonly id: number;
  readonly type: string;
  readonly category: string;
  readonly observation: string;
  readonly solution: string | null;
  readonly demo_id: string | null;
  readonly timestamp: number;
}

/** Fixed seed values shared by the fixture writer and the preservation oracle. */
const SEED_CREATED_AT = "2026-01-01T00:00:00.000Z";
const SEED_LEGACY_ARTIFACT = "legacy-artifact.json";
const SEED_LEGACY_BACKUP_PATH = "legacy-backup.json";
const SEED_MIGRATION_IDS = [
  "001_initial_schema",
  "002_sessions_display_cwd",
  "003_rename_mistake_to_observation",
] as const;
const SEED_INDEXES: ReadonlyArray<readonly [string, string]> = [
  ["idx_sessions_last_accessed_at", "sessions"],
  ["idx_learning_entries_category_timestamp", "learning_entries"],
  ["idx_learning_entries_demo_id", "learning_entries"],
  ["idx_constitution_rules_session_position", "constitution_rules"],
  ["idx_interactions_session_timestamp", "interactions"],
];

const LEARNING_ROW_FIELDS = [
  "id",
  "type",
  "category",
  "observation",
  "solution",
  "demo_id",
  "timestamp",
] as const;

/** Numeric marker embedded in every generation-tagged payload. */
function generationTag(generation: "gen1" | "gen2"): "1" | "2" {
  return generation === "gen1" ? "1" : "2";
}

function expectedLearningRows(
  generation: "gen1" | "gen2",
  rowCount: number,
  extraRows: readonly ExpectedLearningRow[],
): ExpectedLearningRow[] {
  const rows: ExpectedLearningRow[] = [];
  const tag = generationTag(generation);
  for (let i = 0; i < rowCount; i += 1) {
    rows.push({
      id: i + 1,
      type: "mistake",
      category: generation,
      observation: `[gen:${tag}:row:${i}] ${ROW_PAYLOAD}`,
      solution: `[gen:${tag}:sol:${i}]`,
      demo_id: null,
      timestamp: 10000 + i,
    });
  }
  rows.push(...extraRows);
  return rows.sort((left, right) => left.id - right.id);
}

function formatGenerationValue(value: unknown): string {
  if (typeof value !== "string") return JSON.stringify(value) ?? String(value);
  const rendered = JSON.stringify(value);
  return value.length > 60
    ? `${rendered.slice(0, 60)}…(${value.length} chars)`
    : rendered;
}

/** First field mismatch across paired rows, or `null` when all rows match. */
function findFirstRowMismatch<
  FoundRow extends object,
  ExpectedRow extends object,
>(
  found: readonly FoundRow[],
  expected: readonly ExpectedRow[],
  fields: (row: ExpectedRow) => readonly (keyof FoundRow & keyof ExpectedRow)[],
): {
  index: number;
  expectedRow: ExpectedRow;
  field: string;
  expected: unknown;
  found: unknown;
} | null {
  for (let index = 0; index < found.length; index += 1) {
    const foundRow = found[index];
    const expectedRow = expected[index];
    if (foundRow === undefined || expectedRow === undefined) continue;
    for (const field of fields(expectedRow)) {
      const expectedValue: unknown = expectedRow[field];
      const foundValue: unknown = foundRow[field];
      if (foundValue !== expectedValue) {
        return {
          index,
          expectedRow,
          field: String(field),
          expected: expectedValue,
          found: foundValue,
        };
      }
    }
  }
  return null;
}

function formatRowMismatch(mismatch: {
  expected: unknown;
  found: unknown;
}): string {
  return `expected ${formatGenerationValue(mismatch.expected)}, found ${formatGenerationValue(mismatch.found)}`;
}

function findLearningMismatch(
  found: readonly LearningRow[],
  expected: readonly ExpectedLearningRow[],
): string | null {
  if (found.length !== expected.length) {
    return `found ${found.length} learning rows, expected ${expected.length}`;
  }
  const mismatch = findFirstRowMismatch(
    found,
    expected,
    () => LEARNING_ROW_FIELDS,
  );
  return mismatch === null
    ? null
    : `row ${mismatch.expectedRow.id} field ${mismatch.field}: ${formatRowMismatch(mismatch)}`;
}

function requireExactRows(
  found: readonly Record<string, unknown>[],
  expected: readonly Record<string, unknown>[],
  label: string,
): void {
  if (found.length !== expected.length) {
    throw new Error(
      `mixed generation detected: ${label} has ${found.length} rows, expected ${expected.length}`,
    );
  }
  const mismatch = findFirstRowMismatch(found, expected, (row) =>
    Object.keys(row),
  );
  if (mismatch !== null) {
    throw new Error(
      `mixed generation detected in ${label}[${mismatch.index}].${mismatch.field}: ${formatRowMismatch(mismatch)}`,
    );
  }
}

/** Assert every non-learning row and schema object matches one intact generation. */
function assertCompleteGenerationPayload(
  backup: Database,
  generation: "gen1" | "gen2",
): void {
  const tag = generationTag(generation);

  requireExactRows(
    backup
      .query<Record<string, unknown>, []>(
        "SELECT id, cwd_key, created_at, last_accessed_at, cwd FROM sessions",
      )
      .all(),
    [
      {
        id: "session-1",
        cwd_key: "key-1",
        created_at: SEED_CREATED_AT,
        last_accessed_at: `[gen:${tag}:accessed]`,
        cwd: "/tmp/session-1",
      },
    ],
    "sessions",
  );

  requireExactRows(
    backup
      .query<Record<string, unknown>, []>(
        "SELECT id, session_id, rule, position, created_at FROM constitution_rules ORDER BY position",
      )
      .all(),
    [
      {
        id: 1,
        session_id: "session-1",
        rule: `[gen:${tag}:rule:0] safety first`,
        position: 0,
        created_at: SEED_CREATED_AT,
      },
      {
        id: 2,
        session_id: "session-1",
        rule: `[gen:${tag}:rule:1] verify invariants`,
        position: 1,
        created_at: SEED_CREATED_AT,
      },
    ],
    "constitution_rules",
  );

  requireExactRows(
    backup
      .query<Record<string, unknown>, []>(
        "SELECT id, session_id, goal, output, timestamp FROM interactions ORDER BY timestamp",
      )
      .all(),
    [
      {
        id: 1,
        session_id: "session-1",
        goal: `[gen:${tag}:goal:0]`,
        output: `{"status":"[gen:${tag}:out:0]"}`,
        timestamp: 100,
      },
      {
        id: 2,
        session_id: "session-1",
        goal: `[gen:${tag}:goal:1]`,
        output: `{"status":"[gen:${tag}:out:1]"}`,
        timestamp: 101,
      },
    ],
    "interactions",
  );

  requireExactRows(
    backup
      .query<Record<string, unknown>, []>(
        "SELECT artifact, imported_at, backup_path FROM legacy_imports",
      )
      .all(),
    [
      {
        artifact: SEED_LEGACY_ARTIFACT,
        imported_at: SEED_CREATED_AT,
        backup_path: SEED_LEGACY_BACKUP_PATH,
      },
    ],
    "legacy_imports",
  );

  const migrations = backup
    .query<{ id: string }, []>("SELECT id FROM schema_migrations ORDER BY id")
    .all()
    .map((row) => row.id);
  const migrationsMatch =
    migrations.length === SEED_MIGRATION_IDS.length &&
    migrations.every((id, index) => id === SEED_MIGRATION_IDS[index]);
  if (!migrationsMatch) {
    throw new Error(
      `mixed generation detected: schema_migrations ${JSON.stringify(migrations)} does not match ${JSON.stringify(SEED_MIGRATION_IDS)}`,
    );
  }

  const indexes = new Map(
    backup
      .query<{ name: string; tbl_name: string }, []>(
        "SELECT name, tbl_name FROM sqlite_master WHERE type = 'index'",
      )
      .all()
      .map((row) => [row.name, row.tbl_name] as const),
  );
  for (const [name, table] of SEED_INDEXES) {
    if (indexes.get(name) !== table) {
      throw new Error(
        `mixed generation detected: schema index ${name} on ${table} is missing or misplaced`,
      );
    }
  }
}

/**
 * Open a completed backup database independently in an isolated directory
 * without source WAL or SHM files, and verify complete logical preservation:
 * integrity, foreign keys, exact row identities and payloads for every table,
 * schema migrations, legacy-import markers, and schema indexes. Every row
 * across all tables must belong to exactly ONE committed generation, never
 * mixed and never uncommitted generation-3 data.
 */
export async function assertBackupGeneration(
  backupPath: string,
  expectations: BackupGenerationExpectations = {},
): Promise<BackupGenerationCheck> {
  const { rowCount = DEFAULT_MULTI_PAGE_ROW_COUNT, extraLearningRows = [] } =
    expectations;

  if (!existsSync(backupPath)) {
    throw new Error(`backup database does not exist at ${backupPath}`);
  }

  // Copy into an isolated temp directory to ensure no source WAL/SHM beside it.
  const tempDir = await mkdtemp(join(tmpdir(), "vibe-backup-verify-"));
  const isolatedDbPath = join(tempDir, "isolated-backup.db");
  copyFileSync(backupPath, isolatedDbPath);

  const backup = new Database(isolatedDbPath, {
    readonly: true,
    create: false,
  });

  try {
    const integrityRows = backup
      .query<{ integrity_check: string }, []>("PRAGMA integrity_check")
      .all();
    if (
      integrityRows.length === 0 ||
      integrityRows[0]?.integrity_check !== "ok"
    ) {
      throw new Error(
        `integrity_check failed: ${JSON.stringify(integrityRows)}`,
      );
    }

    const fkViolations = backup
      .query<{ table: string }, []>("PRAGMA foreign_key_check")
      .all();
    if (fkViolations.length > 0) {
      throw new Error(
        `foreign_key_check failed with ${fkViolations.length} violations: ${JSON.stringify(fkViolations)}`,
      );
    }

    const learningRows = backup
      .query<LearningRow, []>(
        "SELECT id, type, category, observation, solution, demo_id, timestamp FROM learning_entries ORDER BY id",
      )
      .all();

    const gen1Mismatch = findLearningMismatch(
      learningRows,
      expectedLearningRows("gen1", rowCount, extraLearningRows),
    );
    const gen2Mismatch = findLearningMismatch(
      learningRows,
      expectedLearningRows("gen2", rowCount, extraLearningRows),
    );

    let generation: "gen1" | "gen2";
    if (gen1Mismatch === null) {
      generation = "gen1";
    } else if (gen2Mismatch === null) {
      generation = "gen2";
    } else {
      throw new Error(
        "mixed or uncommitted generation detected: learning_entries match neither a complete generation-1 nor generation-2 payload set " +
          `(gen1: ${gen1Mismatch}; gen2: ${gen2Mismatch})`,
      );
    }

    assertCompleteGenerationPayload(backup, generation);

    const pageCount =
      backup.query<{ page_count: number }, []>("PRAGMA page_count").get()
        ?.page_count ?? 0;

    return {
      generation,
      rowCount: learningRows.length,
      pageCount,
      integrityCheck: "ok",
    };
  } finally {
    backup.close();
    rmSync(tempDir, { recursive: true, force: true });
  }
}

// ── Process-based Concurrency Helpers ─────────────────────────────────────

/** Outcome of racing an awaited operation against a deadline guard. */
const GUARD_EXPIRED = Symbol("guard-expired");

type Guarded<T> = T | typeof GUARD_EXPIRED;

/** Injectable clock so fixture deadlines run under deterministic test control. */
export interface TestClock {
  now(): number;
  schedule(callback: () => void, delayMs: number): unknown;
  cancel(handle: unknown): void;
}

const systemClock: TestClock = {
  now: () => Date.now(),
  schedule: (callback, delayMs) => setTimeout(callback, delayMs),
  cancel: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** Race `operation` against a `guardMs` deadline, cancelling a settled guard. */
function raceWithGuard<T>(
  operation: Promise<T>,
  guardMs: number,
  clock: TestClock,
): Promise<Guarded<T>> {
  return new Promise((resolve, reject) => {
    let guardFired = false;
    const handle = clock.schedule(() => {
      guardFired = true;
      resolve(GUARD_EXPIRED);
    }, guardMs);
    operation.then(
      (value) => {
        if (guardFired) return;
        clock.cancel(handle);
        resolve(value);
      },
      (error) => {
        if (guardFired) return;
        clock.cancel(handle);
        reject(error);
      },
    );
  });
}

export interface LineReaderState {
  buffer: string;
}

export interface ChildStreamReader {
  read(): Promise<ChildReadOutcome>;
}

type ChildReadOutcome = { done: boolean; value?: Uint8Array | undefined };

export interface ReadChildJsonLineOptions {
  /** Overall deadline for one frame (default: 15,000ms). */
  readonly timeoutMs?: number;
  /** Per-read guard before the same outstanding read is retried (default: 500ms). */
  readonly readGuardMs?: number;
  /** Injectable clock for deadline scheduling (default: system clock). */
  readonly clock?: TestClock;
}

/** Per-read guard used when no explicit option is supplied. */
const READ_GUARD_MS = 500;

/**
 * Read one newline-delimited JSON frame from a child stream.
 *
 * Exactly one `reader.read()` is outstanding at any moment: guard expiry
 * retries the same read instead of abandoning it, so a frame that arrives
 * after a guard expiry is still consumed and never lost. Guard timers are
 * cancelled the moment their race settles.
 */
export async function readChildJsonLine(
  reader: ChildStreamReader,
  state: LineReaderState,
  options: ReadChildJsonLineOptions = {},
): Promise<Record<string, unknown>> {
  const {
    timeoutMs = 15_000,
    readGuardMs = READ_GUARD_MS,
    clock = systemClock,
  } = options;
  const deadline = clock.now() + timeoutMs;
  let pendingRead: Promise<ChildReadOutcome> | null = null;

  while (true) {
    const newlineIndex = state.buffer.indexOf("\n");
    if (newlineIndex !== -1) {
      const line = state.buffer.slice(0, newlineIndex).trim();
      state.buffer = state.buffer.slice(newlineIndex + 1);
      if (line) {
        return JSON.parse(line) as Record<string, unknown>;
      }
      continue;
    }

    const remainingMs = deadline - clock.now();
    if (remainingMs <= 0) {
      throw new Error(
        `timed out waiting for child output after ${timeoutMs}ms`,
      );
    }

    const read: Promise<ChildReadOutcome> = pendingRead ?? reader.read();
    pendingRead = read;
    const outcome = await raceWithGuard(
      read,
      Math.min(readGuardMs, remainingMs),
      clock,
    );
    if (outcome === GUARD_EXPIRED) continue;

    pendingRead = null;
    if (outcome.done) {
      throw new Error("child output stream ended before a complete frame");
    }
    state.buffer += new TextDecoder().decode(outcome.value);
  }
}

/** Grace for a child to exit before it is considered stuck (ms). */
export const CHILD_EXIT_TIMEOUT_MS = 5_000;

/** Grace for draining a terminated child's output streams (ms). */
const CHILD_DRAIN_TIMEOUT_MS = 5_000;

/**
 * Minimal child-process surface required for bounded termination, draining,
 * and reaping during fixture teardown and failure paths.
 */
export interface ChildLifetime {
  /** Resolves once the child has actually exited and been reaped. */
  readonly exited: Promise<unknown>;
  isExited(): boolean;
  kill(): void;
  drainStdout(): Promise<void>;
  drainStderr(): Promise<void>;
  releaseStdout(): void;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Terminate, drain, and reap a child under bounded guards, surfacing every
 * cleanup failure instead of suppressing it. Every stage still runs after an
 * earlier stage fails so one failure never leaks the remaining resources.
 */
export async function terminateAndReapChild(
  child: ChildLifetime,
  label: string,
  clock: TestClock = systemClock,
): Promise<void> {
  const failures: string[] = [];

  if (!child.isExited()) {
    try {
      child.kill();
    } catch (error) {
      if (!child.isExited()) {
        failures.push(`terminate failed: ${describeError(error)}`);
      }
    }
  }

  try {
    const drained = await raceWithGuard(
      child.drainStdout(),
      CHILD_DRAIN_TIMEOUT_MS,
      clock,
    );
    if (drained === GUARD_EXPIRED) {
      failures.push(`stdout drain timed out after ${CHILD_DRAIN_TIMEOUT_MS}ms`);
    }
  } catch (error) {
    failures.push(`stdout drain failed: ${describeError(error)}`);
  }

  try {
    const drained = await raceWithGuard(
      child.drainStderr(),
      CHILD_DRAIN_TIMEOUT_MS,
      clock,
    );
    if (drained === GUARD_EXPIRED) {
      failures.push(`stderr drain timed out after ${CHILD_DRAIN_TIMEOUT_MS}ms`);
    }
  } catch (error) {
    failures.push(`stderr drain failed: ${describeError(error)}`);
  }

  try {
    const reaped = await raceWithGuard(
      child.exited,
      CHILD_EXIT_TIMEOUT_MS,
      clock,
    );
    if (reaped === GUARD_EXPIRED) {
      failures.push(`child still running after ${CHILD_EXIT_TIMEOUT_MS}ms`);
    }
  } catch (error) {
    failures.push(`reap failed: ${describeError(error)}`);
  }

  try {
    child.releaseStdout();
  } catch (error) {
    failures.push(`stdout release failed: ${describeError(error)}`);
  }

  if (failures.length > 0) {
    throw new Error(`${label} cleanup failed: ${failures.join("; ")}`);
  }
}

interface ProtocolChild {
  readonly label: string;
  readonly stdin: FileSink;
  readonly reader: ReadableStreamDefaultReader<Uint8Array<ArrayBuffer>>;
  readonly state: LineReaderState;
  readonly lifetime: ChildLifetime;
  closed: boolean;
}

/** Combine a primary failure with an optional cleanup failure. */
function withCleanupFailure(primary: unknown, cleanup: unknown): Error {
  const primaryMessage = describeError(primary);
  if (cleanup === null) return new Error(primaryMessage);
  return new Error(`${primaryMessage}; ${describeError(cleanup)}`);
}

async function terminateQuietly(
  lifetime: ChildLifetime,
  label: string,
): Promise<unknown | null> {
  try {
    await terminateAndReapChild(lifetime, label);
    return null;
  } catch (error) {
    return error;
  }
}

/**
 * Spawn one protocol child, validate its pipes, and read its first frame.
 * Every failure path terminates, drains, and reaps the child before the
 * failure surfaces, combining cleanup diagnostics with the primary cause.
 */
async function startProtocolChild(
  label: string,
  script: string,
  dbPath: string,
  expectedStartType: string,
): Promise<ProtocolChild> {
  const proc = Bun.spawn([process.execPath, "-e", script, dbPath], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });

  const stdin = proc.stdin;
  const stdout = proc.stdout;
  const stderr = proc.stderr;

  let exited = false;
  const exitSettled = proc.exited.then(
    () => {
      exited = true;
    },
    () => {
      exited = true;
    },
  );

  const reader =
    stdout && typeof stdout !== "number" ? stdout.getReader() : null;
  const state: LineReaderState = { buffer: "" };
  let released = false;

  const lifetime: ChildLifetime = {
    exited: exitSettled,
    isExited: () => exited,
    kill: () => {
      proc.kill("SIGKILL");
    },
    drainStdout: async () => {
      if (reader === null || released) return;
      while (true) {
        const { done } = await reader.read();
        if (done) return;
      }
    },
    drainStderr: async () => {
      if (stderr && typeof stderr !== "number") {
        await new Response(stderr).text();
      }
    },
    releaseStdout: () => {
      if (reader === null || released) return;
      released = true;
      reader.releaseLock();
    },
  };

  if (
    !stdin ||
    typeof stdin === "number" ||
    reader === null ||
    !stderr ||
    typeof stderr === "number"
  ) {
    const cleanupError = await terminateQuietly(lifetime, label);
    throw withCleanupFailure(
      new Error(`${label} child pipes unavailable`),
      cleanupError,
    );
  }

  let startFrame: Record<string, unknown>;
  try {
    startFrame = await readChildJsonLine(reader, state);
  } catch (error) {
    const cleanupError = await terminateQuietly(lifetime, label);
    throw withCleanupFailure(error, cleanupError);
  }

  if (startFrame["type"] !== expectedStartType) {
    const cleanupError = await terminateQuietly(lifetime, label);
    throw withCleanupFailure(
      new Error(
        `${label} unexpected start frame: ${JSON.stringify(startFrame)}`,
      ),
      cleanupError,
    );
  }

  return { label, stdin, reader, state, lifetime, closed: false };
}

/** Terminate, drain, and reap a failed child, then throw the combined cause. */
async function failChild(child: ProtocolChild, error: unknown): Promise<never> {
  child.closed = true;
  const cleanupError = await terminateQuietly(child.lifetime, child.label);
  throw withCleanupFailure(error, cleanupError);
}

/**
 * Send one protocol command and require its acknowledgment frame. Any
 * failure cleans up the child before the combined error surfaces.
 */
async function exchangeFrame(
  child: ProtocolChild,
  command: string,
  expectedType: string,
): Promise<Record<string, unknown>> {
  child.stdin.write(command);
  child.stdin.flush();
  let frame: Record<string, unknown>;
  try {
    frame = await readChildJsonLine(child.reader, child.state);
  } catch (error) {
    return failChild(child, error);
  }
  if (frame["type"] !== expectedType) {
    return failChild(
      child,
      new Error(
        `${child.label} unexpected frame while awaiting ${expectedType}: ${JSON.stringify(frame)}`,
      ),
    );
  }
  return frame;
}

/** Reap a child that is expected to exit after its final protocol frame. */
async function reapAfterProtocolFrame(child: ProtocolChild): Promise<void> {
  child.lifetime.releaseStdout();
  const reaped = await raceWithGuard(
    child.lifetime.exited,
    CHILD_EXIT_TIMEOUT_MS,
    systemClock,
  );
  if (reaped !== GUARD_EXPIRED) return;
  await failChild(
    child,
    new Error(`${child.label} did not exit within ${CHILD_EXIT_TIMEOUT_MS}ms`),
  );
}

/** Close a protocol child exactly once, surfacing cleanup failures. */
async function closeProtocolChild(child: ProtocolChild): Promise<void> {
  if (child.closed) return;
  child.closed = true;
  await terminateAndReapChild(child.lifetime, child.label);
}

const WRITER_CHILD_SCRIPT = `
import { Database } from "bun:sqlite";

const sourcePath = process.argv[1];
const db = new Database(sourcePath);
db.run("PRAGMA busy_timeout = 10000");

function emit(type, data = {}) {
  process.stdout.write(JSON.stringify({ type, ...data }) + "\\n");
}

process.stdin.resume();
emit("started");

let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk.toString();
  const lines = buffer.split("\\n");
  buffer = lines.pop() ?? "";
  for (const line of lines) {
    const cmd = line.trim();
    if (!cmd) continue;
    if (cmd === "PREPARE_GEN2") {
      try {
        db.run("BEGIN IMMEDIATE");
        db.run("UPDATE sessions SET last_accessed_at = '[gen:2:accessed]' WHERE id = 'session-1'");
        db.run("UPDATE constitution_rules SET rule = REPLACE(rule, '[gen:1:', '[gen:2:') WHERE session_id = 'session-1'");
        db.run("UPDATE interactions SET goal = REPLACE(goal, '[gen:1:', '[gen:2:'), output = REPLACE(output, '[gen:1:', '[gen:2:') WHERE session_id = 'session-1'");
        db.run("UPDATE learning_entries SET category = 'gen2', observation = REPLACE(observation, '[gen:1:', '[gen:2:'), solution = REPLACE(solution, '[gen:1:', '[gen:2:')");
        emit("prepared_gen2");
      } catch (err) {
        emit("error", { message: String(err) });
      }
    } else if (cmd === "COMMIT") {
      try {
        db.run("COMMIT");
        const timestamp = Date.now();
        const hrtime = Number(process.hrtime.bigint());
        emit("committed", { timestamp, hrtime });
        db.close();
        process.exit(0);
      } catch (err) {
        emit("error", { message: String(err) });
      }
    } else if (cmd === "PREPARE_UNCOMMITTED_GEN3") {
      try {
        db.run("BEGIN IMMEDIATE");
        db.run("UPDATE sessions SET last_accessed_at = '[gen:3:accessed]' WHERE id = 'session-1'");
        db.run("INSERT INTO learning_entries (type, category, observation, solution, timestamp) VALUES ('mistake', 'gen3', '[gen:3:uncommitted] payload', '[gen:3:sol]', 999999)");
        emit("prepared_gen3");
      } catch (err) {
        emit("error", { message: String(err) });
      }
    } else if (cmd === "ROLLBACK") {
      try {
        db.run("ROLLBACK");
        emit("rolled_back");
        db.close();
        process.exit(0);
      } catch (err) {
        emit("error", { message: String(err) });
      }
    } else if (cmd === "CLOSE") {
      db.close();
      process.exit(0);
    }
  }
});
`;

export interface ConcurrentWriterProcess {
  prepareGen2: () => Promise<void>;
  commit: () => Promise<{ timestamp: number; hrtime?: number | undefined }>;
  prepareUncommittedGen3: () => Promise<void>;
  rollback: () => Promise<void>;
  close: () => Promise<void>;
}

export async function spawnConcurrentWriter(
  dbPath: string,
): Promise<ConcurrentWriterProcess> {
  const child = await startProtocolChild(
    "writer",
    WRITER_CHILD_SCRIPT,
    dbPath,
    "started",
  );

  return {
    async prepareGen2() {
      await exchangeFrame(child, "PREPARE_GEN2\n", "prepared_gen2");
    },
    async commit() {
      const res = await exchangeFrame(child, "COMMIT\n", "committed");
      await reapAfterProtocolFrame(child);
      return {
        timestamp: res["timestamp"] as number,
        ...(typeof res["hrtime"] === "number" ? { hrtime: res["hrtime"] } : {}),
      };
    },
    async prepareUncommittedGen3() {
      await exchangeFrame(child, "PREPARE_UNCOMMITTED_GEN3\n", "prepared_gen3");
    },
    async rollback() {
      await exchangeFrame(child, "ROLLBACK\n", "rolled_back");
      await reapAfterProtocolFrame(child);
    },
    async close() {
      await closeProtocolChild(child);
    },
  };
}

const CHECKPOINTER_CHILD_SCRIPT = `
import { Database } from "bun:sqlite";

const sourcePath = process.argv[1];
const db = new Database(sourcePath);

function emit(type, data = {}) {
  process.stdout.write(JSON.stringify({ type, ...data }) + "\\n");
}

process.stdin.resume();
emit("started");

let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk.toString();
  const lines = buffer.split("\\n");
  buffer = lines.pop() ?? "";
  for (const line of lines) {
    const cmd = line.trim();
    if (!cmd) continue;
    if (cmd === "CHECKPOINT") {
      try {
        db.run("PRAGMA wal_checkpoint(PASSIVE)");
        const timestamp = Date.now();
        const hrtime = Number(process.hrtime.bigint());
        emit("checkpointed", { timestamp, hrtime });
        db.close();
        process.exit(0);
      } catch (err) {
        emit("error", { message: String(err) });
      }
    } else if (cmd === "CLOSE") {
      db.close();
      process.exit(0);
    }
  }
});
`;

export interface ConcurrentCheckpointerProcess {
  checkpoint: () => Promise<{ timestamp: number; hrtime?: number | undefined }>;
  close: () => Promise<void>;
}

export async function spawnConcurrentCheckpointer(
  dbPath: string,
): Promise<ConcurrentCheckpointerProcess> {
  const child = await startProtocolChild(
    "checkpointer",
    CHECKPOINTER_CHILD_SCRIPT,
    dbPath,
    "started",
  );

  return {
    async checkpoint() {
      const res = await exchangeFrame(child, "CHECKPOINT\n", "checkpointed");
      await reapAfterProtocolFrame(child);
      return {
        timestamp: res["timestamp"] as number,
        ...(typeof res["hrtime"] === "number" ? { hrtime: res["hrtime"] } : {}),
      };
    },
    async close() {
      await closeProtocolChild(child);
    },
  };
}

const PINNED_READER_CHILD_SCRIPT = `
import { Database } from "bun:sqlite";

const sourcePath = process.argv[1];
const db = new Database(sourcePath, { readonly: true });

function emit(type, data = {}) {
  process.stdout.write(JSON.stringify({ type, ...data }) + "\\n");
}

process.stdin.resume();
emit("started");

let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk.toString();
  const lines = buffer.split("\\n");
  buffer = lines.pop() ?? "";
  for (const line of lines) {
    const cmd = line.trim();
    if (!cmd) continue;
    if (cmd === "PIN") {
      try {
        db.run("BEGIN");
        db.query("SELECT COUNT(*) FROM learning_entries").get();
        emit("pinned");
      } catch (err) {
        emit("error", { message: String(err) });
      }
    } else if (cmd === "RELEASE") {
      try {
        db.run("ROLLBACK");
        emit("released");
        db.close();
        process.exit(0);
      } catch (err) {
        emit("error", { message: String(err) });
      }
    } else if (cmd === "CLOSE") {
      try {
        db.run("ROLLBACK");
      } catch {}
      db.close();
      process.exit(0);
    }
  }
});
`;

export interface ConcurrentPinnedReaderProcess {
  pin: () => Promise<void>;
  release: () => Promise<void>;
  close: () => Promise<void>;
}

export async function spawnConcurrentPinnedReader(
  dbPath: string,
): Promise<ConcurrentPinnedReaderProcess> {
  const child = await startProtocolChild(
    "pinned reader",
    PINNED_READER_CHILD_SCRIPT,
    dbPath,
    "started",
  );

  return {
    async pin() {
      await exchangeFrame(child, "PIN\n", "pinned");
    },
    async release() {
      await exchangeFrame(child, "RELEASE\n", "released");
      await reapAfterProtocolFrame(child);
    },
    async close() {
      await closeProtocolChild(child);
    },
  };
}

const EXCLUSIVE_LOCK_CHILD_SCRIPT = `
import { Database } from "bun:sqlite";

const sourcePath = process.argv[1];
const db = new Database(sourcePath);

function emit(type, data = {}) {
  process.stdout.write(JSON.stringify({ type, ...data }) + "\\n");
}

process.stdin.resume();
try {
  db.run("BEGIN EXCLUSIVE");
  emit("locked");
} catch (err) {
  emit("error", { message: String(err) });
  process.exit(1);
}

let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk.toString();
  const lines = buffer.split("\\n");
  buffer = lines.pop() ?? "";
  for (const line of lines) {
    const cmd = line.trim();
    if (!cmd) continue;
    if (cmd === "RELEASE" || cmd === "CLOSE") {
      try {
        db.run("ROLLBACK");
      } catch {}
      db.close();
      process.exit(0);
    }
  }
});
`;

export interface ConcurrentExclusiveLockProcess {
  release: () => Promise<void>;
  close: () => Promise<void>;
}

export async function spawnConcurrentExclusiveLock(
  dbPath: string,
): Promise<ConcurrentExclusiveLockProcess> {
  const child = await startProtocolChild(
    "exclusive lock",
    EXCLUSIVE_LOCK_CHILD_SCRIPT,
    dbPath,
    "locked",
  );

  return {
    async release() {
      child.stdin.write("RELEASE\n");
      child.stdin.flush();
      await reapAfterProtocolFrame(child);
    },
    async close() {
      await closeProtocolChild(child);
    },
  };
}
