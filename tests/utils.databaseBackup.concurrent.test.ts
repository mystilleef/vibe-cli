import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  createDatabaseBackup,
  type DatabaseBackupOptions,
  DOCTOR_BACKUP_PREFIX,
  PRUNE_BACKUP_PREFIX,
} from "../src/utils/databaseBackup";
import {
  assertBackupGeneration,
  CHILD_EXIT_TIMEOUT_MS,
  type ChildLifetime,
  type ConcurrentCheckpointerProcess,
  type ConcurrentExclusiveLockProcess,
  type ConcurrentPinnedReaderProcess,
  type ConcurrentWriterProcess,
  DEFAULT_MULTI_PAGE_ROW_COUNT,
  type MultiPageSeedResult,
  readChildJsonLine,
  seedMultiPageDatabase,
  spawnConcurrentCheckpointer,
  spawnConcurrentExclusiveLock,
  spawnConcurrentPinnedReader,
  spawnConcurrentWriter,
  type TestClock,
  terminateAndReapChild,
} from "./helpers/concurrentBackupFixtures";
import { createTempHome, type TempHomeContext } from "./helpers/tempHome";

let home: TempHomeContext;
const openHandles: Database[] = [];
const activeWriters: ConcurrentWriterProcess[] = [];
const activeCheckpointers: ConcurrentCheckpointerProcess[] = [];
const activeReaders: ConcurrentPinnedReaderProcess[] = [];
const activeExclusiveLocks: ConcurrentExclusiveLockProcess[] = [];

beforeEach(async () => {
  home = await createTempHome();
});

afterEach(async () => {
  const cleanupErrors: unknown[] = [];
  const recordCleanupError = (error: unknown): void => {
    cleanupErrors.push(error);
  };

  while (openHandles.length > 0) {
    const handle = openHandles.pop();
    if (!handle) continue;
    try {
      handle.close();
    } catch (error) {
      recordCleanupError(error);
    }
  }
  while (activeWriters.length > 0) {
    const writer = activeWriters.pop();
    if (!writer) continue;
    try {
      await writer.close();
    } catch (error) {
      recordCleanupError(error);
    }
  }
  while (activeCheckpointers.length > 0) {
    const checkpointer = activeCheckpointers.pop();
    if (!checkpointer) continue;
    try {
      await checkpointer.close();
    } catch (error) {
      recordCleanupError(error);
    }
  }
  while (activeReaders.length > 0) {
    const reader = activeReaders.pop();
    if (!reader) continue;
    try {
      await reader.close();
    } catch (error) {
      recordCleanupError(error);
    }
  }
  while (activeExclusiveLocks.length > 0) {
    const lock = activeExclusiveLocks.pop();
    if (!lock) continue;
    try {
      await lock.close();
    } catch (error) {
      recordCleanupError(error);
    }
  }
  try {
    await home.cleanup();
  } catch (error) {
    recordCleanupError(error);
  }

  if (cleanupErrors.length > 0) {
    throw new Error(
      `concurrent backup fixture cleanup failed: ${cleanupErrors
        .map((error) =>
          error instanceof Error ? error.message : String(error),
        )
        .join("; ")}`,
    );
  }
});

/** Source database path plus a caller-held connection to it. */
interface SourceHandle {
  database: Database;
  sourcePath: string;
}

function openSourceHandle(dbPath: string): SourceHandle {
  const database = new Database(dbPath);
  openHandles.push(database);
  return { database, sourcePath: dbPath };
}

function validateExecutionOverlap(
  sqlStart: number,
  publishedAt: number,
  commitTime: number,
  checkpointTime: number,
): void {
  if (sqlStart <= 0 || publishedAt <= 0) {
    throw new Error(
      `missing snapshot execution evidence: sqlStart=${sqlStart}, publishedAt=${publishedAt}`,
    );
  }
  if (publishedAt < sqlStart) {
    throw new Error(
      `inverted snapshot execution bounds: sqlStart=${sqlStart}, publishedAt=${publishedAt}`,
    );
  }
  if (commitTime < sqlStart || commitTime > publishedAt) {
    throw new Error(
      `commit (${commitTime}) occurred outside the snapshot execution window [${sqlStart}, ${publishedAt}]`,
    );
  }
  if (checkpointTime < sqlStart || checkpointTime > publishedAt) {
    throw new Error(
      `checkpoint attempt (${checkpointTime}) occurred outside the snapshot execution window [${sqlStart}, ${publishedAt}]`,
    );
  }
}

describe("createDatabaseBackup — coordinated concurrency and snapshot consistency", () => {
  test("captures consistent snapshot generation while a concurrent writer commit and WAL checkpoint overlap snapshot execution", async () => {
    const seed = seedMultiPageDatabase(home.dataRoot);
    expect(seed.initialPageCount).toBeGreaterThan(50);
    expect(seed.walSizeBytes).toBeGreaterThan(0);

    const source = openSourceHandle(seed.dbPath);
    const writer = await spawnConcurrentWriter(seed.dbPath);
    activeWriters.push(writer);
    const checkpointer = await spawnConcurrentCheckpointer(seed.dbPath);
    activeCheckpointers.push(checkpointer);

    // Pre-arm the independent writer with Generation-2 changes inside BEGIN IMMEDIATE
    await writer.prepareGen2();

    let sqlStartTimestamp = 0;
    let commitTimestamp = 0;
    let checkpointTimestamp = 0;
    let reapedCode = -1;

    // The writer's armed BEGIN IMMEDIATE holds a write transaction open across
    // the whole VACUUM, so the snapshot always executes under real mutation
    // pressure; the commit and checkpoint roundtrips dispatched from onSqlStart
    // overlap the snapshot execution window by protocol order.
    const backupPath = await createDatabaseBackup(source.sourcePath, {
      prefix: PRUNE_BACKUP_PREFIX,
      gated: true,
      observer: {
        onReady: ({ authorizeStart }) => {
          authorizeStart();
        },
        onSqlStart: async ({ timestamp }) => {
          sqlStartTimestamp = timestamp;
          const checkpointPromise = checkpointer.checkpoint();
          const commitPromise = writer.commit();

          const [checkpointResult, commitResult] = await Promise.all([
            checkpointPromise,
            commitPromise,
          ]);

          checkpointTimestamp = checkpointResult.timestamp;
          commitTimestamp = commitResult.timestamp;
        },
        onReaped: ({ exitCode }) => {
          reapedCode = exitCode ?? -1;
        },
      },
    });

    expect(reapedCode).toBe(0);

    // Both bounds are protocol-guaranteed, not timing guesses: the commit and
    // checkpoint are dispatched only after VACUUM begins (sql-start), and the
    // parent cannot publish the backup until both observer roundtrips settle.
    const publishedTimestamp = Date.now();
    validateExecutionOverlap(
      sqlStartTimestamp,
      publishedTimestamp,
      commitTimestamp,
      checkpointTimestamp,
    );

    // Independent opening without source WAL/SHM verifies complete logical preservation
    const result = await assertBackupGeneration(backupPath, {
      rowCount: seed.rowCount,
    });
    expect(result.integrityCheck).toBe("ok");
    expect(result.rowCount).toBe(DEFAULT_MULTI_PAGE_ROW_COUNT);
    expect(result.pageCount).toBeGreaterThan(50);
    // Generation must be either purely gen1 or purely gen2, never mixed
    expect(["gen1", "gen2"]).toContain(result.generation);
  });

  test("rejects missing or out-of-bounds execution overlap evidence", () => {
    // Commit completed before VACUUM began
    expect(() => validateExecutionOverlap(1000, 5000, 999, 3000)).toThrow(
      /commit .* occurred outside the snapshot execution window/,
    );

    // Commit completed after publication
    expect(() => validateExecutionOverlap(1000, 5000, 5001, 3000)).toThrow(
      /commit .* occurred outside the snapshot execution window/,
    );

    // Checkpoint completed before VACUUM began
    expect(() => validateExecutionOverlap(1000, 5000, 3000, 999)).toThrow(
      /checkpoint attempt .* occurred outside the snapshot execution window/,
    );

    // Checkpoint completed after publication
    expect(() => validateExecutionOverlap(1000, 5000, 3000, 5001)).toThrow(
      /checkpoint attempt .* occurred outside the snapshot execution window/,
    );

    // Missing sql-start evidence
    expect(() => validateExecutionOverlap(0, 5000, 3000, 3000)).toThrow(
      /missing snapshot execution evidence/,
    );

    // Missing publication evidence
    expect(() => validateExecutionOverlap(1000, 0, 3000, 3000)).toThrow(
      /missing snapshot execution evidence/,
    );

    // Inverted bounds
    expect(() => validateExecutionOverlap(5000, 1000, 3000, 3000)).toThrow(
      /inverted snapshot execution bounds/,
    );
  });

  test("excludes uncommitted transaction held concurrently during snapshot execution", async () => {
    const seed = seedMultiPageDatabase(home.dataRoot);
    const source = openSourceHandle(seed.dbPath);

    const writer = await spawnConcurrentWriter(seed.dbPath);
    activeWriters.push(writer);

    // Writer holds an open BEGIN IMMEDIATE transaction with generation-3 uncommitted rows
    await writer.prepareUncommittedGen3();

    const backupPath = await createDatabaseBackup(source.sourcePath, {
      prefix: DOCTOR_BACKUP_PREFIX,
    });

    await writer.rollback();

    // Verify the backup contains only complete generation-1 committed data
    const result = await assertBackupGeneration(backupPath, {
      rowCount: seed.rowCount,
    });
    expect(result.generation).toBe("gen1");
    expect(result.rowCount).toBe(DEFAULT_MULTI_PAGE_ROW_COUNT);
    expect(result.integrityCheck).toBe("ok");
  });

  test("succeeds during concurrent WAL pinned reader and writer conditions that blocked checkpoint", async () => {
    const seed = seedMultiPageDatabase(home.dataRoot);
    const source = openSourceHandle(seed.dbPath);

    // Pinned reader process holds an open read transaction on the source WAL
    const reader = await spawnConcurrentPinnedReader(seed.dbPath);
    activeReaders.push(reader);
    await reader.pin();

    // Writer commits an additional row while reader pins the WAL log
    source.database.run(
      "INSERT INTO learning_entries (type, category, observation, solution, timestamp) " +
        "VALUES ('mistake', 'gen1', '[gen:1:row:extra] pinned-reader-test', 'extra-sol', 99999)",
    );

    // Checkpoint cannot advance past the pinned reader frame in standard WAL
    const backupPath = await createDatabaseBackup(source.sourcePath, {
      prefix: PRUNE_BACKUP_PREFIX,
    });

    await reader.release();

    expect(existsSync(backupPath)).toBe(true);

    const result = await assertBackupGeneration(backupPath, {
      rowCount: seed.rowCount,
      extraLearningRows: [
        {
          id: seed.rowCount + 1,
          type: "mistake",
          category: "gen1",
          observation: "[gen:1:row:extra] pinned-reader-test",
          solution: "extra-sol",
          demo_id: null,
          timestamp: 99999,
        },
      ],
    });
    expect(result.generation).toBe("gen1");
    expect(result.rowCount).toBe(seed.rowCount + 1);
    expect(result.integrityCheck).toBe("ok");
  });

  test("rejects visibly and cleans up owned staging output under genuine database contention", async () => {
    const seed = seedMultiPageDatabase(home.dataRoot, {
      journalMode: "DELETE",
    });
    const source = openSourceHandle(seed.dbPath);

    // Hold an exclusive rollback-journal lock blocking all readers
    const lock = await spawnConcurrentExclusiveLock(seed.dbPath);
    activeExclusiveLocks.push(lock);

    const backupOptions: Partial<DatabaseBackupOptions> = {
      prefix: DOCTOR_BACKUP_PREFIX,
      timeout: 2000,
    };

    try {
      await expect(
        createDatabaseBackup(
          source.sourcePath,
          backupOptions as DatabaseBackupOptions,
        ),
      ).rejects.toThrow();
    } finally {
      await lock.release();
    }

    // Staging directory under backups/ must be cleaned up
    const backupsDir = join(home.dataRoot, "backups");
    if (existsSync(backupsDir)) {
      const entries = readdirSync(backupsDir);
      const stagingEntries = entries.filter((name) =>
        name.startsWith(".staging-"),
      );
      expect(stagingEntries).toEqual([]);
    }
  });

  test("executes snapshot outside parent event loop while verifying nonblocking progress", async () => {
    const seed = seedMultiPageDatabase(home.dataRoot);
    const source = openSourceHandle(seed.dbPath);

    // Observable parent work is scheduled only inside the production SQL
    // execution window, so startup and publication ticks can never satisfy it.
    let ticksDuringSql = 0;
    let progressActive = false;
    const pumpParentProgress = (): void => {
      if (!progressActive) return;
      ticksDuringSql += 1;
      setImmediate(pumpParentProgress);
    };

    try {
      const backupPath = await createDatabaseBackup(source.sourcePath, {
        prefix: PRUNE_BACKUP_PREFIX,
        gated: true,
        observer: {
          onReady: ({ authorizeStart }) => {
            authorizeStart();
          },
          onSqlStart: () => {
            ticksDuringSql = 0;
            progressActive = true;
            setImmediate(pumpParentProgress);
          },
          onSqlEnd: () => {
            progressActive = false;
            if (ticksDuringSql === 0) {
              throw new Error(
                "parent event loop made no observable progress during snapshot SQL execution",
              );
            }
          },
        },
      });
      expect(existsSync(backupPath)).toBe(true);
      const result = await assertBackupGeneration(backupPath, {
        rowCount: seed.rowCount,
      });
      expect(result.generation).toBe("gen1");
    } finally {
      progressActive = false;
    }

    // Progress must have happened before settlement, while SQL executed.
    expect(ticksDuringSql).toBeGreaterThan(0);
  });

  test("preserves caller connection usability and settings across success and failure", async () => {
    const seed = seedMultiPageDatabase(home.dataRoot);
    const source = openSourceHandle(seed.dbPath);

    source.database.run("PRAGMA busy_timeout = 7890");
    source.database.run("PRAGMA foreign_keys = ON");

    // Success path
    const backupPath = await createDatabaseBackup(source.sourcePath, {
      prefix: DOCTOR_BACKUP_PREFIX,
    });
    expect(existsSync(backupPath)).toBe(true);
    const result = await assertBackupGeneration(backupPath, {
      rowCount: seed.rowCount,
    });
    expect(result.generation).toBe("gen1");
    expect(result.rowCount).toBe(seed.rowCount);

    expect(() => source.database.query("SELECT 1").get()).not.toThrow();
    expect(
      source.database
        .query<{ timeout: number }, []>("PRAGMA busy_timeout")
        .get()?.timeout,
    ).toBe(7890);
    expect(
      source.database
        .query<{ foreign_keys: number }, []>("PRAGMA foreign_keys")
        .get()?.foreign_keys,
    ).toBe(1);

    // Failure path
    await expect(
      createDatabaseBackup(join(home.dataRoot, "missing.db"), {
        prefix: DOCTOR_BACKUP_PREFIX,
      }),
    ).rejects.toThrow();

    expect(() => source.database.query("SELECT 1").get()).not.toThrow();
    expect(
      source.database
        .query<{ timeout: number }, []>("PRAGMA busy_timeout")
        .get()?.timeout,
    ).toBe(7890);
    expect(
      source.database
        .query<{ foreign_keys: number }, []>("PRAGMA foreign_keys")
        .get()?.foreign_keys,
    ).toBe(1);
  });
});

describe("assertBackupGeneration — complete logical preservation", () => {
  async function createPristineBackup(): Promise<{
    backupPath: string;
    seed: MultiPageSeedResult;
  }> {
    const seed = seedMultiPageDatabase(home.dataRoot);
    const source = openSourceHandle(seed.dbPath);
    const backupPath = await createDatabaseBackup(source.sourcePath, {
      prefix: DOCTOR_BACKUP_PREFIX,
    });
    return { backupPath, seed };
  }

  function corruptBackup(backupPath: string, corruption: string): void {
    const database = new Database(backupPath);
    try {
      database.run(corruption);
      database.run("PRAGMA wal_checkpoint(TRUNCATE)");
    } finally {
      database.close();
    }
  }

  test("accepts a complete, uncorrupted generation-1 snapshot", async () => {
    const { backupPath, seed } = await createPristineBackup();
    const result = await assertBackupGeneration(backupPath, {
      rowCount: seed.rowCount,
    });
    expect(result.generation).toBe("gen1");
    expect(result.rowCount).toBe(seed.rowCount);
    expect(result.integrityCheck).toBe("ok");
  });

  test("rejects a mixed generation marker in the second constitution rule", async () => {
    const { backupPath, seed } = await createPristineBackup();
    corruptBackup(
      backupPath,
      "UPDATE constitution_rules SET rule = REPLACE(rule, '[gen:1:', '[gen:2:') WHERE position = 1",
    );
    await expect(
      assertBackupGeneration(backupPath, { rowCount: seed.rowCount }),
    ).rejects.toThrow(/generation/);
  });

  test("rejects uncommitted generation-3 interaction outputs", async () => {
    const { backupPath, seed } = await createPristineBackup();
    corruptBackup(
      backupPath,
      `UPDATE interactions SET output = '{"status":"[gen:3:out:0]"}'`,
    );
    await expect(
      assertBackupGeneration(backupPath, { rowCount: seed.rowCount }),
    ).rejects.toThrow(/generation/);
  });

  test("rejects lost learning identities, payloads, and solutions", async () => {
    const { backupPath, seed } = await createPristineBackup();
    corruptBackup(
      backupPath,
      "UPDATE learning_entries SET id = id + 10000, " +
        "observation = '[gen:1:row:0] truncated', solution = 'lost'",
    );
    await expect(
      assertBackupGeneration(backupPath, { rowCount: seed.rowCount }),
    ).rejects.toThrow(/generation/);
  });

  test("rejects rewritten legacy import marker metadata", async () => {
    const { backupPath, seed } = await createPristineBackup();
    corruptBackup(
      backupPath,
      "UPDATE legacy_imports SET imported_at = 'lost', backup_path = 'lost'",
    );
    await expect(
      assertBackupGeneration(backupPath, { rowCount: seed.rowCount }),
    ).rejects.toThrow(/generation/);
  });

  test("rejects a dropped schema index", async () => {
    const { backupPath, seed } = await createPristineBackup();
    corruptBackup(
      backupPath,
      "DROP INDEX idx_learning_entries_category_timestamp",
    );
    await expect(
      assertBackupGeneration(backupPath, { rowCount: seed.rowCount }),
    ).rejects.toThrow(/generation/);
  });

  test("rejects mixed learning generations", async () => {
    const { backupPath, seed } = await createPristineBackup();
    corruptBackup(
      backupPath,
      "UPDATE learning_entries SET category = 'gen2', " +
        "observation = REPLACE(observation, '[gen:1:', '[gen:2:'), " +
        "solution = REPLACE(solution, '[gen:1:', '[gen:2:') WHERE id <= 750",
    );
    await expect(
      assertBackupGeneration(backupPath, { rowCount: seed.rowCount }),
    ).rejects.toThrow(/generation/);
  });

  test("preserves a full generation-2 conversion committed by the concurrent writer", async () => {
    const seed = seedMultiPageDatabase(home.dataRoot);
    const source = openSourceHandle(seed.dbPath);

    const writer = await spawnConcurrentWriter(seed.dbPath);
    activeWriters.push(writer);
    await writer.prepareGen2();
    await writer.commit();

    const backupPath = await createDatabaseBackup(source.sourcePath, {
      prefix: PRUNE_BACKUP_PREFIX,
    });

    const result = await assertBackupGeneration(backupPath, {
      rowCount: seed.rowCount,
    });
    expect(result.generation).toBe("gen2");
    expect(result.rowCount).toBe(seed.rowCount);
  });
});

describe("concurrent backup fixtures — guarded child coordination", () => {
  class ManualClock implements TestClock {
    private currentMs = 0;
    private nextHandle = 1;
    private readonly timers = new Map<
      number,
      { at: number; callback: () => void }
    >();

    now(): number {
      return this.currentMs;
    }

    schedule(callback: () => void, delayMs: number): unknown {
      const handle = this.nextHandle;
      this.nextHandle += 1;
      this.timers.set(handle, { at: this.currentMs + delayMs, callback });
      return handle;
    }

    cancel(handle: unknown): void {
      this.timers.delete(handle as number);
    }

    get pendingTimers(): number {
      return this.timers.size;
    }

    advance(delayMs: number): void {
      this.currentMs += delayMs;
      const due = [...this.timers.entries()]
        .filter(([, timer]) => timer.at <= this.currentMs)
        .sort((left, right) => left[1].at - right[1].at);
      for (const [handle, timer] of due) {
        this.timers.delete(handle);
        timer.callback();
      }
    }
  }

  class ControlledChildStreamReader {
    readCalls = 0;
    private readonly pending: Array<
      (result: { done: boolean; value?: Uint8Array | undefined }) => void
    > = [];

    read(): Promise<{ done: boolean; value?: Uint8Array | undefined }> {
      this.readCalls += 1;
      return new Promise((resolve) => {
        this.pending.push(resolve);
      });
    }

    deliverLine(frame: string): void {
      const resolve = this.pending.shift();
      if (!resolve) {
        throw new Error("no pending child stream read to deliver to");
      }
      resolve({
        done: false,
        value: new TextEncoder().encode(`${frame}\n`),
      });
    }
  }

  function flushAsync(): Promise<void> {
    return new Promise((resolve) => {
      setImmediate(resolve);
    });
  }

  function deferred<T>(): {
    promise: Promise<T>;
    resolve: (value: T) => void;
  } {
    let resolvePromise: (value: T) => void = () => {};
    const promise = new Promise<T>((resolve) => {
      resolvePromise = resolve;
    });
    return { promise, resolve: resolvePromise };
  }

  test("retains one outstanding stream read across guard expiry and consumes the delivered frame", async () => {
    const reader = new ControlledChildStreamReader();
    const clock = new ManualClock();
    const result = readChildJsonLine(
      reader,
      { buffer: "" },
      {
        timeoutMs: 1_000,
        readGuardMs: 100,
        clock,
      },
    );

    expect(reader.readCalls).toBe(1);
    clock.advance(100);
    await flushAsync();
    expect(reader.readCalls).toBe(1);

    reader.deliverLine('{"type":"committed","timestamp":123}');
    await expect(result).resolves.toEqual({
      type: "committed",
      timestamp: 123,
    });
    expect(reader.readCalls).toBe(1);
    expect(clock.pendingTimers).toBe(0);
  });

  test("rejects when the overall read deadline expires", async () => {
    const reader = new ControlledChildStreamReader();
    const clock = new ManualClock();
    const result = readChildJsonLine(
      reader,
      { buffer: "" },
      {
        timeoutMs: 250,
        readGuardMs: 100,
        clock,
      },
    );

    clock.advance(100);
    await flushAsync();
    clock.advance(100);
    await flushAsync();
    clock.advance(100);

    await expect(result).rejects.toThrow(
      "timed out waiting for child output after 250ms",
    );
    expect(reader.readCalls).toBe(1);
    expect(clock.pendingTimers).toBe(0);
  });

  test("terminates and reaps a child during failure cleanup", async () => {
    const clock = new ManualClock();
    const exit = deferred<void>();
    let killCount = 0;
    const lifetime: ChildLifetime = {
      exited: exit.promise,
      isExited: () => false,
      kill: () => {
        killCount += 1;
        exit.resolve(undefined);
      },
      drainStdout: async () => {},
      drainStderr: async () => {},
      releaseStdout: () => {},
    };

    await terminateAndReapChild(lifetime, "concurrency child", clock);
    expect(killCount).toBe(1);
  });

  test("surfaces a cleanup failure when a child never reaps", async () => {
    const clock = new ManualClock();
    let killCount = 0;
    const lifetime: ChildLifetime = {
      exited: new Promise<void>(() => {}),
      isExited: () => false,
      kill: () => {
        killCount += 1;
      },
      drainStdout: async () => {},
      drainStderr: async () => {},
      releaseStdout: () => {},
    };

    const cleanup = terminateAndReapChild(lifetime, "stuck child", clock);
    await flushAsync();
    expect(killCount).toBe(1);
    clock.advance(CHILD_EXIT_TIMEOUT_MS);

    await expect(cleanup).rejects.toThrow(
      /stuck child cleanup failed: .*still running/,
    );
  });

  test("cleans up a child that fails before emitting its start frame", async () => {
    await expect(
      spawnConcurrentPinnedReader(join(home.dataRoot, "missing.db")),
    ).rejects.toThrow(/child output stream ended before a complete frame/);
  });

  test("surfaces stdout drain failures during cleanup", async () => {
    const clock = new ManualClock();
    const lifetime: ChildLifetime = {
      exited: Promise.resolve(undefined),
      isExited: () => true,
      kill: () => {},
      drainStdout: async () => {
        throw new Error("stdout pipe exploded");
      },
      drainStderr: async () => {},
      releaseStdout: () => {},
    };

    await expect(
      terminateAndReapChild(lifetime, "broken child", clock),
    ).rejects.toThrow(
      /broken child cleanup failed: stdout drain failed: stdout pipe exploded/,
    );
  });
});
