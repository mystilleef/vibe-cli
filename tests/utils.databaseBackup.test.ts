import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import {
  createDatabaseBackup,
  type DatabaseBackupOptions,
  DOCTOR_BACKUP_PREFIX,
  formatBackupTimestampLabel,
  PRUNE_BACKUP_PREFIX,
} from "../src/utils/databaseBackup";
import {
  type DatabaseSnapshotBoundary,
  type DatabaseSnapshotObserver,
  type DatabaseSnapshotReaped,
  executeDatabaseSnapshot,
} from "../src/utils/databaseSnapshot";
import { readManagedBackupEntries } from "../src/utils/managedBackups";
import { insertLearningRows, seedLearningEntries } from "./helpers/storageSeed";
import { createTempHome, type TempHomeContext } from "./helpers/tempHome";

const FIXED_TIMESTAMP = new Date("2026-01-02T03:04:05.678Z");
const FIXED_LABEL = formatBackupTimestampLabel(FIXED_TIMESTAMP.toISOString());
const LATER_TIMESTAMP = new Date("2026-01-02T03:04:06.000Z");
const LATER_LABEL = formatBackupTimestampLabel(LATER_TIMESTAMP.toISOString());

let home: TempHomeContext;
const openHandles: Database[] = [];

beforeEach(async () => {
  home = await createTempHome();
});

afterEach(async () => {
  jest.useRealTimers();
  Bun.spawn = realBunSpawn;
  while (openHandles.length > 0) {
    const handle = openHandles.pop();
    if (!handle) continue;
    try {
      handle.close();
    } catch {
      // Best-effort cleanup of opened test handles.
    }
  }
  await home.cleanup();
});

/** Seeded source database plus a caller-held connection to it. */
interface SourceHandle {
  database: Database;
  sourcePath: string;
}

function openSourceHandle(): SourceHandle {
  seedLearningEntries(home.dataRoot, [
    { category: "cat", observation: "entry", timestamp: 1234567890 },
  ]);
  const sourcePath = join(home.dataRoot, "vibe.db");
  const database = new Database(sourcePath);
  openHandles.push(database);
  return { database, sourcePath };
}

function managedBackupPath(prefix: string, label: string): string {
  return join(home.dataRoot, "backups", `${prefix}${label}.db`);
}

function backUp(
  sourcePath: string,
  options: Partial<DatabaseBackupOptions> = {},
): Promise<string> {
  return createDatabaseBackup(sourcePath, {
    prefix: PRUNE_BACKUP_PREFIX,
    timestamp: FIXED_TIMESTAMP,
    ...options,
  });
}

function insertLearning(database: Database, observation: string): void {
  insertLearningRows(database, [
    { category: "cat", observation, timestamp: 1234567891 },
  ]);
}

// ── Isolated child fakes ──────────────────────────────────────────────────

const realBunSpawn = Bun.spawn;

/**
 * Wrap `Bun.spawn` to record launch attempts while delegating to the real
 * spawn: regressions observe the actual launch boundary without replacing
 * production acquisition or execution.
 */
function trackSnapshotLaunches(): string[][] {
  const launches: string[][] = [];
  const realSpawn = realBunSpawn;
  Bun.spawn = ((
    command: string[],
    options?: Parameters<typeof realSpawn>[1],
  ) => {
    launches.push([...command]);
    return realSpawn(command, options);
  }) as unknown as typeof Bun.spawn;
  return launches;
}

/** Fixed protocol frame text for isolated child fakes. */
function protocolFrame(type: string, timestamp = 1): string {
  return `${JSON.stringify({ type, timestamp, hrtime: timestamp })}\n`;
}

/** ReadableStream fed from `chunks`, recording every chunk a reader pulls. */
function trackedStdout(...chunks: string[]): {
  stream: ReadableStream<Uint8Array>;
  delivered: string[];
} {
  const delivered: string[] = [];
  let index = 0;
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        const chunk = chunks[index];
        if (chunk === undefined) {
          controller.close();
          return;
        }
        index += 1;
        delivered.push(chunk);
        controller.enqueue(encoder.encode(chunk));
      },
    },
    { highWaterMark: 0 },
  );
  return { stream, delivered };
}

function emptyStdout(): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.close();
    },
  });
}

/** ReadableStream whose reads reject with `message` as the stream error. */
function failingStream(message: string): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    pull() {
      throw new Error(message);
    },
  });
}

interface FakeSnapshotChild {
  readonly proc: ReturnType<typeof Bun.spawn>;
  readonly killed: () => boolean;
}

interface FakeSnapshotChildOptions {
  stdin?:
    | {
        write: (data?: string | Uint8Array) => number;
        flush: () => void;
        end: () => void;
      }
    | null
    | number;
  stdout?: ReadableStream<Uint8Array> | null | number;
  stderr?: ReadableStream<Uint8Array> | null | number;
  exited?: Promise<number>;
  exitCode?: number | null;
  signalCode?: NodeJS.Signals | null;
  onKill?: () => void;
}

/** `Bun.spawn` replacement exposing only the members the executor consumes. */
function createFakeSnapshotChild(
  options: FakeSnapshotChildOptions = {},
): FakeSnapshotChild {
  let killed = false;
  const proc = {
    stdin:
      options.stdin === undefined
        ? {
            write: () => 1,
            flush: () => {},
            end: () => {},
          }
        : options.stdin,
    stdout: options.stdout === undefined ? emptyStdout() : options.stdout,
    stderr: options.stderr === undefined ? emptyStdout() : options.stderr,
    exited: options.exited ?? Promise.resolve(options.exitCode ?? 0),
    exitCode: options.exitCode ?? 0,
    signalCode: options.signalCode ?? null,
    pid: 4242,
    kill: () => {
      killed = true;
      options.onKill?.();
      return true;
    },
  };
  return {
    proc: proc as unknown as ReturnType<typeof Bun.spawn>,
    killed: () => killed,
  };
}

function installFakeSnapshotChild(child: FakeSnapshotChild): void {
  Bun.spawn = (() => child.proc) as unknown as typeof Bun.spawn;
}

/** Deferred promise exposing its resolve function for ordering tests. */
function createDeferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/** Arrival barrier: each participant waits until every participant arrives. */
function createArrivalBarrier(participants: number): () => Promise<void> {
  let arrived = 0;
  let release: () => void = () => {};
  const allArrived = new Promise<void>((resolve) => {
    release = resolve;
  });
  return async () => {
    arrived += 1;
    if (arrived >= participants) release();
    await allArrived;
  };
}

// ── Real SQLite & Filesystem Tests ────────────────────────────────────────

describe("createDatabaseBackup — real SQLite and filesystem", () => {
  test.each([
    { prefix: PRUNE_BACKUP_PREFIX, name: "prune" },
    { prefix: DOCTOR_BACKUP_PREFIX, name: "doctor" },
  ])(
    "creates absolute path under sibling backups directory for $name prefix",
    async ({ prefix }) => {
      const source = openSourceHandle();

      const backupPath = await createDatabaseBackup(source.sourcePath, {
        prefix,
        timestamp: FIXED_TIMESTAMP,
      });

      expect(backupPath).toBe(resolve(managedBackupPath(prefix, FIXED_LABEL)));
      expect(existsSync(backupPath)).toBe(true);

      const backup = new Database(backupPath, {
        readonly: true,
        create: false,
      });
      try {
        expect(
          backup.query("SELECT COUNT(*) AS c FROM learning_entries").get(),
        ).toEqual({ c: 1 });
      } finally {
        backup.close();
      }
    },
  );

  test("opens independently without source WAL or SHM files and includes committed records", async () => {
    const source = openSourceHandle();
    source.database.exec("PRAGMA journal_mode = WAL");
    insertLearning(source.database, "wal entry");
    source.database
      .prepare(
        "INSERT INTO legacy_imports (artifact, imported_at, backup_path) VALUES (?, ?, ?)",
      )
      .run("vibe-log.json", "2026-01-01T00:00:00.000Z", "vibe-log.json.bak");
    expect(existsSync(`${source.sourcePath}-wal`)).toBe(true);

    const backupPath = await backUp(source.sourcePath);

    // Open from an isolated location without WAL/SHM beside it
    const backup = new Database(backupPath, { readonly: true, create: false });
    try {
      expect(
        backup
          .query<{ observation: string }, []>(
            "SELECT observation FROM learning_entries ORDER BY timestamp",
          )
          .all(),
      ).toEqual([{ observation: "entry" }, { observation: "wal entry" }]);
      expect(
        backup.query("SELECT COUNT(*) AS c FROM legacy_imports").get(),
      ).toEqual({ c: 1 });
      expect(backup.query("PRAGMA integrity_check").all()).toEqual([
        { integrity_check: "ok" },
      ]);
    } finally {
      backup.close();
    }
  });

  test("leaves caller connection usable, open, and with original busy_timeout", async () => {
    const source = openSourceHandle();
    source.database.run("PRAGMA busy_timeout = 4321");

    await backUp(source.sourcePath);

    expect(() => source.database.query("SELECT 1").get()).not.toThrow();
    expect(
      source.database
        .query<{ timeout: number }, []>("PRAGMA busy_timeout")
        .get()?.timeout,
    ).toBe(4321);
  });

  test("succeeds during concurrent WAL writer transaction without blocking", async () => {
    const source = openSourceHandle();
    source.database.exec("PRAGMA journal_mode = WAL");
    insertLearning(source.database, "committed entry");

    const writer = new Database(source.sourcePath);
    openHandles.push(writer);
    writer.exec("BEGIN IMMEDIATE");
    insertLearning(writer, "uncommitted writer entry");

    try {
      const backupPath = await backUp(source.sourcePath);
      const backup = new Database(backupPath, {
        readonly: true,
        create: false,
      });
      try {
        const rows = backup
          .query<{ observation: string }, []>(
            "SELECT observation FROM learning_entries ORDER BY timestamp",
          )
          .all();
        // Snapshot sees committed state only, excludes uncommitted writer transaction
        expect(rows).toEqual([
          { observation: "entry" },
          { observation: "committed entry" },
        ]);
      } finally {
        backup.close();
      }
    } finally {
      writer.exec("ROLLBACK");
    }
  });

  test("succeeds during concurrent WAL pinned reader without blocking", async () => {
    const source = openSourceHandle();
    source.database.exec("PRAGMA journal_mode = WAL");
    insertLearning(source.database, "initial entry");

    const reader = new Database(source.sourcePath, { readonly: true });
    openHandles.push(reader);
    reader.exec("BEGIN");
    reader.query("SELECT COUNT(*) FROM learning_entries").get();

    insertLearning(source.database, "post-reader entry");

    try {
      const backupPath = await backUp(source.sourcePath);
      const backup = new Database(backupPath, {
        readonly: true,
        create: false,
      });
      try {
        expect(backup.query("PRAGMA integrity_check").all()).toEqual([
          { integrity_check: "ok" },
        ]);
      } finally {
        backup.close();
      }
    } finally {
      reader.exec("ROLLBACK");
    }
  });

  test("rejects visibly and cleans up owned output under genuine database contention", async () => {
    const source = openSourceHandle();
    // DELETE journal mode: BEGIN EXCLUSIVE locks out any reader from opening
    source.database.exec("PRAGMA journal_mode = DELETE");
    const exclusive = new Database(source.sourcePath);
    openHandles.push(exclusive);
    exclusive.exec("BEGIN EXCLUSIVE");

    try {
      await expect(backUp(source.sourcePath)).rejects.toThrow();
    } finally {
      exclusive.exec("ROLLBACK");
    }

    expect(
      existsSync(managedBackupPath(PRUNE_BACKUP_PREFIX, FIXED_LABEL)),
    ).toBe(false);
    // Staging directory must be cleaned up
    const backupsDir = join(home.dataRoot, "backups");
    if (existsSync(backupsDir)) {
      const entries = readdirSync(backupsDir);
      expect(entries).toEqual([]);
    }
  });

  test("parent event loop makes progress concurrently while snapshot runs outside event loop", async () => {
    const source = openSourceHandle();
    let ticks = 0;
    const interval = setInterval(() => {
      ticks++;
    }, 5);

    try {
      await backUp(source.sourcePath);
    } finally {
      clearInterval(interval);
    }

    expect(ticks).toBeGreaterThan(0);
  });

  test("existing destination file remains byte-for-byte untouched and collision rejects", async () => {
    const source = openSourceHandle();
    const destPath = managedBackupPath(PRUNE_BACKUP_PREFIX, FIXED_LABEL);
    mkdirSync(join(home.dataRoot, "backups"), { recursive: true });
    writeFileSync(destPath, "pre-existing content that must not be changed");
    const priorBytes = readFileSync(destPath);

    await expect(backUp(source.sourcePath)).rejects.toThrow();

    expect(readFileSync(destPath)).toEqual(priorBytes);
  });

  test("existing empty destination file remains untouched and collision rejects", async () => {
    const source = openSourceHandle();
    const destPath = managedBackupPath(PRUNE_BACKUP_PREFIX, FIXED_LABEL);
    mkdirSync(join(home.dataRoot, "backups"), { recursive: true });
    writeFileSync(destPath, "");

    await expect(backUp(source.sourcePath)).rejects.toThrow();

    expect(statSync(destPath).size).toBe(0);
  });

  test("existing symlink destination remains untouched without following", async () => {
    const source = openSourceHandle();
    const elsewhere = join(home.dataRoot, "target.txt");
    writeFileSync(elsewhere, "original-target");
    const destPath = managedBackupPath(PRUNE_BACKUP_PREFIX, FIXED_LABEL);
    mkdirSync(join(home.dataRoot, "backups"), { recursive: true });
    symlinkSync(elsewhere, destPath);

    await expect(backUp(source.sourcePath)).rejects.toThrow();

    expect(readFileSync(elsewhere, "utf8")).toBe("original-target");
    expect(statSync(destPath).isFile()).toBe(true);
  });

  test("synchronized same-timestamp creators yield one winner, one visible collision, and winner is preserved", async () => {
    const source = openSourceHandle();
    const barrier = createArrivalBarrier(2);

    const coordinated = () =>
      backUp(source.sourcePath, {
        gated: true,
        timeout: 10_000,
        observer: {
          onReady: async ({ authorizeStart }) => {
            await barrier();
            authorizeStart();
          },
        },
      });

    const settled = await Promise.allSettled([coordinated(), coordinated()]);

    const successes = settled.filter((r) => r.status === "fulfilled");
    const rejections = settled.filter((r) => r.status === "rejected");

    expect(successes).toHaveLength(1);
    expect(rejections).toHaveLength(1);
    const collision = rejections[0] as PromiseRejectedResult;
    expect((collision.reason as NodeJS.ErrnoException).code).toBe("EEXIST");

    const winnerPath = (successes[0] as PromiseFulfilledResult<string>).value;
    const backup = new Database(winnerPath, { readonly: true, create: false });
    try {
      expect(
        backup.query("SELECT COUNT(*) AS c FROM learning_entries").get(),
      ).toEqual({ c: 1 });
    } finally {
      backup.close();
    }

    expect(readdirSync(join(home.dataRoot, "backups")).sort()).toEqual([
      `${PRUNE_BACKUP_PREFIX}${FIXED_LABEL}.db`,
    ]);
  });

  test("no incomplete managed filename appears in backups directory mid-flight", async () => {
    const source = openSourceHandle();
    let midFlightManagedFiles: string[] = [];

    await backUp(source.sourcePath, {
      gated: true,
      observer: {
        onReady: async ({ authorizeStart }) => {
          const backupsDir = join(home.dataRoot, "backups");
          if (existsSync(backupsDir)) {
            const inventory = await readManagedBackupEntries(backupsDir);
            if (inventory.ok) {
              midFlightManagedFiles = inventory.entries.map((e) => e.fileName);
            }
          }
          authorizeStart();
        },
      },
    });

    expect(midFlightManagedFiles).toEqual([]);
  });

  test("creates owner-only staging directory independent of a permissive process umask", async () => {
    const source = openSourceHandle();
    const backupsDir = join(home.dataRoot, "backups");
    const priorUmask = process.umask();
    let stagingMode = -1;

    try {
      process.umask(0o022);
      await backUp(source.sourcePath, {
        gated: true,
        observer: {
          onReady: ({ authorizeStart }) => {
            const stagingEntry = readdirSync(backupsDir).find((name) =>
              name.startsWith(".staging-"),
            );
            if (stagingEntry === undefined) {
              throw new Error("staging directory is absent during readiness");
            }
            stagingMode = statSync(join(backupsDir, stagingEntry)).mode & 0o777;
            authorizeStart();
          },
        },
      });
    } finally {
      process.umask(priorUmask);
    }

    expect(stagingMode).toBe(0o700);
  });

  test("rejects when source file does not exist without creating it", async () => {
    openSourceHandle();
    const absentPath = join(home.dataRoot, "absent.db");

    await expect(backUp(absentPath)).rejects.toThrow();

    expect(existsSync(absentPath)).toBe(false);
    expect(
      existsSync(managedBackupPath(PRUNE_BACKUP_PREFIX, FIXED_LABEL)),
    ).toBe(false);
  });

  test("rejects a source path that is not a regular file without creating backups", async () => {
    const sourceDirectory = join(home.dataRoot, "source-dir");
    mkdirSync(sourceDirectory, { recursive: true });

    await expect(backUp(sourceDirectory)).rejects.toThrow(/not a regular file/);

    expect(existsSync(join(home.dataRoot, "backups"))).toBe(false);
  });

  test("rejects an empty source path before filesystem mutation", async () => {
    openSourceHandle();

    await expect(backUp("")).rejects.toThrow(
      "invalid database backup source path",
    );

    expect(readdirSync(home.dataRoot)).not.toContain("backups");
  });

  test("rejects invalid timestamp before filesystem mutation", async () => {
    const source = openSourceHandle();

    await expect(
      backUp(source.sourcePath, { timestamp: new Date("invalid") }),
    ).rejects.toThrow(/invalid/i);

    expect(readdirSync(home.dataRoot)).not.toContain("backups");
  });

  test("rejects a non-Date timestamp value before filesystem mutation", async () => {
    const source = openSourceHandle();

    await expect(
      backUp(source.sourcePath, {
        timestamp: "2026-01-02T03:04:05.678Z" as unknown as Date,
      }),
    ).rejects.toThrow(/invalid backup timestamp/);

    expect(readdirSync(home.dataRoot)).not.toContain("backups");
  });

  test("rejects symlinked backup directory without writing through it", async () => {
    const source = openSourceHandle();
    const elsewhere = join(home.dataRoot, "elsewhere");
    mkdirSync(elsewhere, { recursive: true });
    writeFileSync(join(elsewhere, "keep.txt"), "keep");
    symlinkSync(elsewhere, join(home.dataRoot, "backups"));

    await expect(backUp(source.sourcePath)).rejects.toThrow(/symlink/i);

    expect(readdirSync(elsewhere)).toEqual(["keep.txt"]);
  });

  test("rejects backup directory blocked by regular file", async () => {
    const source = openSourceHandle();
    writeFileSync(join(home.dataRoot, "backups"), "blocked");

    await expect(backUp(source.sourcePath)).rejects.toThrow(/not a directory/i);

    expect(() => source.database.query("SELECT 1").get()).not.toThrow();
  });

  test("backs up a database with no open connections", async () => {
    const source = openSourceHandle();
    source.database.close();

    const backupPath = await backUp(source.sourcePath);
    expect(existsSync(backupPath)).toBe(true);
    const backup = new Database(backupPath, { readonly: true, create: false });
    try {
      expect(
        backup.query("SELECT COUNT(*) AS c FROM learning_entries").get(),
      ).toEqual({ c: 1 });
    } finally {
      backup.close();
    }
  });
});

// ── Observation / Barrier Contract Tests ──────────────────────────────────

describe("createDatabaseBackup — observation and barrier contract", () => {
  test("emits ready, sql-start, sql-end, and reaped lifecycle events with comparable timestamps", async () => {
    const source = openSourceHandle();
    const events: string[] = [];
    let sqlStartTimestamp = 0;
    let sqlEndTimestamp = 0;
    let reapedCode = -1;

    const observer: DatabaseSnapshotObserver = {
      onReady: () => {
        events.push("ready");
      },
      onSqlStart: ({ timestamp }) => {
        events.push("sql-start");
        sqlStartTimestamp = timestamp;
      },
      onSqlEnd: ({ timestamp }) => {
        events.push("sql-end");
        sqlEndTimestamp = timestamp;
      },
      onReaped: ({ exitCode }) => {
        events.push("reaped");
        reapedCode = exitCode ?? -1;
      },
    };

    const beforeTime = Date.now();
    await backUp(source.sourcePath, { observer });
    const afterTime = Date.now();

    expect(events).toEqual(["ready", "sql-start", "sql-end", "reaped"]);
    expect(sqlStartTimestamp).toBeGreaterThanOrEqual(beforeTime);
    expect(sqlEndTimestamp).toBeGreaterThanOrEqual(sqlStartTimestamp);
    expect(sqlEndTimestamp).toBeLessThanOrEqual(afterTime);
    expect(reapedCode).toBe(0);
  });

  test("gated executor prevents early resolution until authorized", async () => {
    const source = openSourceHandle();
    let authorize: (() => void) | undefined;
    let resolveReady: () => void;
    const readyPromise = new Promise<void>((resolve) => {
      resolveReady = resolve;
    });

    const backupPromise = backUp(source.sourcePath, {
      gated: true,
      observer: {
        onReady: ({ authorizeStart }) => {
          authorize = authorizeStart;
          resolveReady();
        },
      },
    });

    await readyPromise;
    expect(
      existsSync(managedBackupPath(PRUNE_BACKUP_PREFIX, FIXED_LABEL)),
    ).toBe(false);
    authorize?.();
    const finalPath = await backupPromise;
    expect(existsSync(finalPath)).toBe(true);
  });

  test("invokes onBeforeSpawn observer before child is spawned", async () => {
    const source = openSourceHandle();
    const events: string[] = [];

    const observer: DatabaseSnapshotObserver = {
      onBeforeSpawn: () => {
        events.push("before-spawn");
      },
      onReady: () => {
        events.push("ready");
      },
      onSqlStart: () => {
        events.push("sql-start");
      },
      onSqlEnd: () => {
        events.push("sql-end");
      },
      onReaped: () => {
        events.push("reaped");
      },
    };

    await backUp(source.sourcePath, { observer });
    expect(events).toEqual([
      "before-spawn",
      "ready",
      "sql-start",
      "sql-end",
      "reaped",
    ]);
  });

  test("pre-spawn observer rejection launches no child, publishes no backup, and cleans staging", async () => {
    const source = openSourceHandle();
    const launches = trackSnapshotLaunches();

    const err = await backUp(source.sourcePath, {
      observer: {
        onBeforeSpawn: () => {
          throw new Error("injected pre-spawn observer failure");
        },
      },
    }).catch((e) => e);

    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe("injected pre-spawn observer failure");
    expect(launches).toEqual([]);

    expect(
      existsSync(managedBackupPath(PRUNE_BACKUP_PREFIX, FIXED_LABEL)),
    ).toBe(false);

    const backupsDir = join(home.dataRoot, "backups");
    if (existsSync(backupsDir)) {
      const stagingEntries = readdirSync(backupsDir).filter((name) =>
        name.startsWith(".staging-"),
      );
      expect(stagingEntries).toEqual([]);
    }
  });

  test("pre-spawn observer timeout launches no child, publishes no backup, and cleans staging", async () => {
    const source = openSourceHandle();
    const launches = trackSnapshotLaunches();

    const err = await backUp(source.sourcePath, {
      timeout: 100,
      observer: {
        onBeforeSpawn: () => new Promise<void>(() => {}),
      },
    }).catch((e) => e);

    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/timed out after 100ms/);
    expect(launches).toEqual([]);

    expect(
      existsSync(managedBackupPath(PRUNE_BACKUP_PREFIX, FIXED_LABEL)),
    ).toBe(false);

    const backupsDir = join(home.dataRoot, "backups");
    if (existsSync(backupsDir)) {
      const stagingEntries = readdirSync(backupsDir).filter((name) =>
        name.startsWith(".staging-"),
      );
      expect(stagingEntries).toEqual([]);
    }
  });

  test("late pre-spawn observer completion resumes nothing, launches no child, and cleans staging", async () => {
    const source = openSourceHandle();
    const launches = trackSnapshotLaunches();
    const observerEntered = createDeferred<void>();
    const releaseObserver = createDeferred<void>();
    const observerFinished = createDeferred<void>();

    const backup = backUp(source.sourcePath, {
      timeout: 100,
      observer: {
        onBeforeSpawn: async () => {
          observerEntered.resolve();
          await releaseObserver.promise;
          observerFinished.resolve();
        },
      },
    }).catch((e) => e);

    await observerEntered.promise;
    const err = await backup;
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/timed out after 100ms/);
    expect(launches).toEqual([]);

    // Complete the observer after rejection through an explicit signal.
    releaseObserver.resolve();
    await observerFinished.promise;

    expect(launches).toEqual([]);
    expect(
      existsSync(managedBackupPath(PRUNE_BACKUP_PREFIX, FIXED_LABEL)),
    ).toBe(false);

    const backupsDir = join(home.dataRoot, "backups");
    if (existsSync(backupsDir)) {
      const stagingEntries = readdirSync(backupsDir).filter((name) =>
        name.startsWith(".staging-"),
      );
      expect(stagingEntries).toEqual([]);
    }
  });

  test("shares one total timeout budget between a held onBeforeSpawn observer and gated child settlement", async () => {
    const source = openSourceHandle();
    const launches = trackSnapshotLaunches();
    const timeoutMs = 400;
    const observerBudgetMs = 250;
    const remainingBudgetMs = timeoutMs - observerBudgetMs;
    const observerEntered = createDeferred<void>();
    const releaseObserver = createDeferred<void>();
    const childReady = createDeferred<() => void>();

    jest.useFakeTimers();
    try {
      const backup = backUp(source.sourcePath, {
        timeout: timeoutMs,
        gated: true,
        observer: {
          onBeforeSpawn: async () => {
            observerEntered.resolve();
            await releaseObserver.promise;
          },
          onReady: ({ authorizeStart }) => {
            childReady.resolve(authorizeStart);
          },
        },
      });

      await observerEntered.promise;
      jest.advanceTimersByTime(observerBudgetMs);
      releaseObserver.resolve();

      const authorizeStart = await childReady.promise;
      expect(launches).toHaveLength(1);

      // Only the unspent remainder of the single total budget remains.
      jest.advanceTimersByTime(remainingBudgetMs);
      // A shared deadline has already terminated the gated child; a restarted
      // child budget would still be waiting, so release the gated child to let
      // the backup settle and expose the excess budget in the assertions.
      authorizeStart();

      const err = await backup.catch((e) => e);

      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toMatch(
        new RegExp(`timed out after ${timeoutMs}ms`),
      );
      expect(
        existsSync(managedBackupPath(PRUNE_BACKUP_PREFIX, FIXED_LABEL)),
      ).toBe(false);

      const backupsDir = join(home.dataRoot, "backups");
      if (existsSync(backupsDir)) {
        expect(readdirSync(backupsDir)).toEqual([]);
      }
    } finally {
      jest.useRealTimers();
    }
  });

  test("rejects without launching when the deadline has already fired before settlement", async () => {
    const source = openSourceHandle();
    const launches = trackSnapshotLaunches();
    const timeoutMs = 1234;

    // Fire timer callbacks synchronously so the deadline is already recorded
    // before the pre-spawn settlement check runs — the settlement must reject
    // with the timeout verdict instead of launching a child.
    const realSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = ((callback: () => void) => {
      callback();
      return 1 as unknown as NodeJS.Timeout;
    }) as unknown as typeof globalThis.setTimeout;
    try {
      const err = await backUp(source.sourcePath, {
        timeout: timeoutMs,
      }).catch((e) => e);

      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toMatch(
        new RegExp(`timed out after ${timeoutMs}ms`),
      );
      expect(launches).toEqual([]);
      expect(
        existsSync(managedBackupPath(PRUNE_BACKUP_PREFIX, FIXED_LABEL)),
      ).toBe(false);

      const backupsDir = join(home.dataRoot, "backups");
      if (existsSync(backupsDir)) {
        expect(readdirSync(backupsDir)).toEqual([]);
      }
    } finally {
      globalThis.setTimeout = realSetTimeout;
    }
  });
});

// ── Isolated Fakes & Failure Injection ────────────────────────────────────

describe("createDatabaseBackup — failure injection and diagnostics", () => {
  test("injected snapshot failure cleans up partial staging output and preserves prior backups and bystanders", async () => {
    const source = openSourceHandle();
    const priorPath = managedBackupPath(PRUNE_BACKUP_PREFIX, FIXED_LABEL);
    mkdirSync(join(home.dataRoot, "backups"), { recursive: true });
    writeFileSync(priorPath, "prior backup bytes");
    const priorBytes = readFileSync(priorPath);
    const bystanderPath = join(home.dataRoot, "backups", "bystander.txt");
    writeFileSync(bystanderPath, "bystander-data");

    await expect(
      backUp(source.sourcePath, {
        timestamp: LATER_TIMESTAMP,
        snapshotExecutor: async (_sourcePath, destinationPath) => {
          writeFileSync(destinationPath, "partial staging bytes");
          throw new Error("injected snapshot execution error");
        },
      }),
    ).rejects.toThrow("injected snapshot execution error");

    expect(
      existsSync(managedBackupPath(PRUNE_BACKUP_PREFIX, LATER_LABEL)),
    ).toBe(false);
    expect(readFileSync(priorPath)).toEqual(priorBytes);
    expect(readFileSync(bystanderPath, "utf8")).toBe("bystander-data");
    expect(readdirSync(join(home.dataRoot, "backups")).sort()).toEqual([
      "bystander.txt",
      `${PRUNE_BACKUP_PREFIX}${FIXED_LABEL}.db`,
    ]);
  });

  test("injected publication failure cleans up staging and preserves prior backups", async () => {
    const source = openSourceHandle();
    const priorPath = managedBackupPath(PRUNE_BACKUP_PREFIX, FIXED_LABEL);
    mkdirSync(join(home.dataRoot, "backups"), { recursive: true });
    writeFileSync(priorPath, "prior backup bytes");
    const priorBytes = readFileSync(priorPath);

    await expect(
      backUp(source.sourcePath, {
        timestamp: LATER_TIMESTAMP,
        snapshotExecutor: async (_sourcePath, destinationPath) => {
          writeFileSync(destinationPath, "staged snapshot bytes");
        },
        linkExclusive: async () => {
          throw new Error("injected hard link failure");
        },
      }),
    ).rejects.toThrow("injected hard link failure");

    expect(
      existsSync(managedBackupPath(PRUNE_BACKUP_PREFIX, LATER_LABEL)),
    ).toBe(false);
    expect(readFileSync(priorPath)).toEqual(priorBytes);
  });

  test("injected cleanup failure before publication excludes hidden partial output from the managed inventory", async () => {
    const source = openSourceHandle();
    const priorPath = managedBackupPath(PRUNE_BACKUP_PREFIX, FIXED_LABEL);
    mkdirSync(join(home.dataRoot, "backups"), { recursive: true });
    writeFileSync(priorPath, "prior backup bytes");
    const priorBytes = readFileSync(priorPath);
    const bystanderPath = join(home.dataRoot, "backups", "bystander.txt");
    writeFileSync(bystanderPath, "bystander-data");

    const err = await backUp(source.sourcePath, {
      timestamp: LATER_TIMESTAMP,
      snapshotExecutor: async (_sourcePath, destinationPath) => {
        writeFileSync(destinationPath, "partial staging bytes");
        throw new Error("primary snapshot error");
      },
      cleanupStaging: async () => {
        throw new Error("secondary cleanup error");
      },
    }).catch((e) => e);

    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain("primary snapshot error");
    expect((err as Error).message).toContain("secondary cleanup error");

    // Cleanup failed by injection, so hidden staging residue remains; the
    // managed inventory must still exclude it.
    const backupsDir = join(home.dataRoot, "backups");
    expect(
      readdirSync(backupsDir).filter((name) => name.startsWith(".staging-")),
    ).toHaveLength(1);
    const inventory = await readManagedBackupEntries(backupsDir);
    expect(inventory.ok).toBe(true);
    if (inventory.ok) {
      expect(inventory.entries.map((e) => e.fileName)).toEqual([
        `${PRUNE_BACKUP_PREFIX}${FIXED_LABEL}.db`,
      ]);
    }
    expect(readFileSync(priorPath)).toEqual(priorBytes);
    expect(readFileSync(bystanderPath, "utf8")).toBe("bystander-data");
  });

  test("injected post-link cleanup failure rejects and preserves a concurrently replaced final path", async () => {
    const source = openSourceHandle();
    const finalPath = managedBackupPath(PRUNE_BACKUP_PREFIX, FIXED_LABEL);
    const stagedBytes = "completed staged snapshot bytes";
    const replacementBytes = "concurrent replacement bytes";
    const observed: { linkedBytes: string | null } = { linkedBytes: null };

    const err = await backUp(source.sourcePath, {
      snapshotExecutor: async (_sourcePath, destinationPath) => {
        writeFileSync(destinationPath, stagedBytes);
      },
      cleanupStaging: async () => {
        // The completed snapshot must already be linked into place before a
        // concurrent process replaces its final path.
        observed.linkedBytes = readFileSync(finalPath, "utf8");
        rmSync(finalPath);
        writeFileSync(finalPath, replacementBytes);
        throw new Error("injected post-link cleanup error");
      },
    }).catch((e) => e);

    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain(
      "injected post-link cleanup error",
    );

    expect(observed.linkedBytes).toBe(stagedBytes);
    expect(existsSync(finalPath)).toBe(true);
    expect(readFileSync(finalPath, "utf8")).toBe(replacementBytes);
  });

  test("retains an independently openable completed snapshot after a post-link cleanup failure", async () => {
    const source = openSourceHandle();
    const finalPath = managedBackupPath(PRUNE_BACKUP_PREFIX, FIXED_LABEL);

    const err = await backUp(source.sourcePath, {
      cleanupStaging: async () => {
        throw new Error("injected post-link cleanup error");
      },
    }).catch((e) => e);

    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain(
      "injected post-link cleanup error",
    );
    expect(existsSync(finalPath)).toBe(true);

    const backup = new Database(finalPath, { readonly: true, create: false });
    try {
      expect(
        backup.query("SELECT COUNT(*) AS c FROM learning_entries").get(),
      ).toEqual({ c: 1 });
      expect(backup.query("PRAGMA integrity_check").all()).toEqual([
        { integrity_check: "ok" },
      ]);
    } finally {
      backup.close();
    }
  });
});

// ── Isolated Child Protocol Fakes ─────────────────────────────────────────

describe("executeDatabaseSnapshot — isolated child protocol fakes", () => {
  test("drains queued stdout and reaps the child before rejecting an onReady failure", async () => {
    const readyFrame = protocolFrame("ready");
    const sqlStartFrame = protocolFrame("sql-start");
    const stdout = trackedStdout(readyFrame, sqlStartFrame);
    const child = createFakeSnapshotChild({ stdout: stdout.stream });
    installFakeSnapshotChild(child);

    let settled = false;
    const observed: { settledWhenReaped: boolean | null } = {
      settledWhenReaped: null,
    };
    const reaped: DatabaseSnapshotReaped[] = [];
    const backup = executeDatabaseSnapshot("source.db", "destination.db", {
      observer: {
        onReady: () => {
          throw new Error("injected onReady failure");
        },
        onReaped: (event) => {
          observed.settledWhenReaped = settled;
          reaped.push(event);
        },
      },
    });
    backup.catch(() => {
      settled = true;
    });

    await expect(backup).rejects.toThrow("injected onReady failure");

    expect(child.killed()).toBe(true);
    expect(stdout.delivered).toEqual([readyFrame, sqlStartFrame]);
    expect(stdout.stream.locked).toBe(false);
    expect(reaped).toEqual([{ exitCode: 0, signal: null }]);
    expect(observed.settledWhenReaped).toBe(false);
  });

  test("drains queued stdout and reaps the child before rejecting an onSqlStart failure", async () => {
    const readyFrame = protocolFrame("ready");
    const sqlStartFrame = protocolFrame("sql-start");
    const sqlEndFrame = protocolFrame("sql-end");
    const stdout = trackedStdout(readyFrame, sqlStartFrame, sqlEndFrame);
    const child = createFakeSnapshotChild({ stdout: stdout.stream });
    installFakeSnapshotChild(child);

    await expect(
      executeDatabaseSnapshot("source.db", "destination.db", {
        observer: {
          onSqlStart: () => {
            throw new Error("injected onSqlStart failure");
          },
        },
      }),
    ).rejects.toThrow("injected onSqlStart failure");

    expect(child.killed()).toBe(true);
    expect(stdout.delivered).toEqual([readyFrame, sqlStartFrame, sqlEndFrame]);
    expect(stdout.stream.locked).toBe(false);
  });

  test("rejects a child frame that is not valid JSON", async () => {
    const stdout = trackedStdout("not-json\n");
    const child = createFakeSnapshotChild({ stdout: stdout.stream });
    installFakeSnapshotChild(child);

    await expect(
      executeDatabaseSnapshot("source.db", "destination.db"),
    ).rejects.toThrow(/not valid JSON/);

    expect(child.killed()).toBe(true);
  });

  test("rejects a child frame with an unknown lifecycle event", async () => {
    const child = createFakeSnapshotChild({
      stdout: trackedStdout(protocolFrame("telemetry")).stream,
    });
    installFakeSnapshotChild(child);

    await expect(
      executeDatabaseSnapshot("source.db", "destination.db"),
    ).rejects.toThrow(/unknown event: telemetry/);
  });

  test("rejects out-of-order lifecycle events", async () => {
    const child = createFakeSnapshotChild({
      stdout: trackedStdout(protocolFrame("ready"), protocolFrame("sql-end"))
        .stream,
    });
    installFakeSnapshotChild(child);

    await expect(
      executeDatabaseSnapshot("source.db", "destination.db"),
    ).rejects.toThrow(/received "sql-end" while expecting "sql-start"/);
  });

  test("rejects a gated child that starts SQL before authorization", async () => {
    const child = createFakeSnapshotChild({
      stdout: trackedStdout(protocolFrame("ready"), protocolFrame("sql-start"))
        .stream,
    });
    installFakeSnapshotChild(child);

    await expect(
      executeDatabaseSnapshot("source.db", "destination.db", { gated: true }),
    ).rejects.toThrow(/before authorization/);
  });

  test("rejects a clean child exit without lifecycle evidence", async () => {
    installFakeSnapshotChild(createFakeSnapshotChild());

    await expect(
      executeDatabaseSnapshot("source.db", "destination.db"),
    ).rejects.toThrow(/protocol incomplete/);
  });

  test("rejects a clean child exit with partial lifecycle evidence", async () => {
    const child = createFakeSnapshotChild({
      stdout: trackedStdout(protocolFrame("ready"), protocolFrame("sql-start"))
        .stream,
    });
    installFakeSnapshotChild(child);

    await expect(
      executeDatabaseSnapshot("source.db", "destination.db"),
    ).rejects.toThrow(/"sql-end", "done"/);
  });

  test("terminates an unresolved onReady barrier and waits for actual child exit", async () => {
    const deferredExit = createDeferred<number>();
    const killObserved = createDeferred<void>();
    const child = createFakeSnapshotChild({
      stdout: trackedStdout(protocolFrame("ready")).stream,
      exited: deferredExit.promise,
      exitCode: null,
      signalCode: null,
      onKill: () => killObserved.resolve(undefined),
    });
    installFakeSnapshotChild(child);

    let entered = false;
    let settled = false;
    const reaped: DatabaseSnapshotReaped[] = [];

    const backup = executeDatabaseSnapshot("source.db", "destination.db", {
      timeout: 100,
      observer: {
        onReady: () => {
          entered = true;
          return new Promise<void>(() => {});
        },
        onReaped: (event) => {
          reaped.push(event);
        },
      },
    });
    backup.catch(() => {
      settled = true;
    });

    await killObserved.promise;
    expect(settled).toBe(false);
    deferredExit.resolve(0);

    await expect(backup).rejects.toThrow(/timed out after 100ms/);

    expect(entered).toBe(true);
    expect(child.killed()).toBe(true);
    expect(reaped).toHaveLength(1);
  });

  test("waits for actual child exit after a timeout before rejecting", async () => {
    const deferredExit = createDeferred<number>();
    const killObserved = createDeferred<void>();
    const child = createFakeSnapshotChild({
      exited: deferredExit.promise,
      exitCode: null,
      signalCode: null,
      onKill: () => killObserved.resolve(undefined),
    });
    installFakeSnapshotChild(child);

    let settled = false;
    const backup = executeDatabaseSnapshot("source.db", "destination.db", {
      timeout: 100,
    });
    backup.catch(() => {
      settled = true;
    });

    await killObserved.promise;
    expect(settled).toBe(false);
    deferredExit.resolve(0);

    await expect(backup).rejects.toThrow(/timed out after 100ms/);

    expect(child.killed()).toBe(true);
  });

  test("settles within the timeout when onReaped never resolves", async () => {
    const child = createFakeSnapshotChild({
      stdout: trackedStdout(
        protocolFrame("ready"),
        protocolFrame("sql-start"),
        protocolFrame("sql-end"),
        protocolFrame("done"),
      ).stream,
    });
    installFakeSnapshotChild(child);

    await expect(
      executeDatabaseSnapshot("source.db", "destination.db", {
        timeout: 100,
        observer: {
          onReaped: () => new Promise<void>(() => {}),
        },
      }),
    ).rejects.toThrow(/timed out after 100ms/);

    expect(child.killed()).toBe(true);
  });

  test("bounds settlement by the termination grace when onReaped never resolves after termination", async () => {
    const child = createFakeSnapshotChild({
      stdout: trackedStdout(protocolFrame("ready"), protocolFrame("sql-start"))
        .stream,
    });
    installFakeSnapshotChild(child);

    const started = Date.now();
    await expect(
      executeDatabaseSnapshot("source.db", "destination.db", {
        timeout: 30_000,
        observer: {
          onReady: () => {
            throw new Error("primary onReady failure");
          },
          onReaped: () => new Promise<void>(() => {}),
        },
      }),
    ).rejects.toThrow("primary onReady failure");

    // Settlement is bounded by the 250 ms termination grace, not the 30 s
    // deadline: a hanging post-termination callback cannot stall rejection.
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(child.killed()).toBe(true);
  });

  test("rejects a child frame that is not a JSON object", async () => {
    const child = createFakeSnapshotChild({
      stdout: trackedStdout("42\n").stream,
    });
    installFakeSnapshotChild(child);

    await expect(
      executeDatabaseSnapshot("source.db", "destination.db"),
    ).rejects.toThrow(/not a JSON object/);

    expect(child.killed()).toBe(true);
  });

  test("rejects a known lifecycle frame emitted without a valid timestamp", async () => {
    const child = createFakeSnapshotChild({
      stdout: trackedStdout(`${JSON.stringify({ type: "ready" })}\n`).stream,
    });
    installFakeSnapshotChild(child);

    await expect(
      executeDatabaseSnapshot("source.db", "destination.db"),
    ).rejects.toThrow(/emitted "ready" without a valid timestamp/);

    expect(child.killed()).toBe(true);
  });

  test("rejects a child frame whose timestamp is not finite", async () => {
    const child = createFakeSnapshotChild({
      stdout: trackedStdout(
        `${JSON.stringify({ type: "sql-start", timestamp: "later" })}\n`,
      ).stream,
    });
    installFakeSnapshotChild(child);

    await expect(
      executeDatabaseSnapshot("source.db", "destination.db"),
    ).rejects.toThrow(/emitted "sql-start" without a valid timestamp/);

    expect(child.killed()).toBe(true);
  });

  test("rejects a spawn failure before any child runs", async () => {
    Bun.spawn = (() => {
      throw new Error("injected spawn failure");
    }) as unknown as typeof Bun.spawn;

    await expect(
      executeDatabaseSnapshot("source.db", "destination.db"),
    ).rejects.toThrow(
      "snapshot process failed to spawn: injected spawn failure",
    );
  });

  test("rejects an unavailable stdin pipe and terminates the child", async () => {
    const child = createFakeSnapshotChild({ stdin: null });
    installFakeSnapshotChild(child);

    await expect(
      executeDatabaseSnapshot("source.db", "destination.db"),
    ).rejects.toThrow("subprocess stdin pipe is unavailable");

    expect(child.killed()).toBe(true);
  });

  test("rejects an unavailable stdout pipe and terminates the child", async () => {
    const child = createFakeSnapshotChild({ stdout: null });
    installFakeSnapshotChild(child);

    await expect(
      executeDatabaseSnapshot("source.db", "destination.db"),
    ).rejects.toThrow("subprocess stdout pipe is unavailable");

    expect(child.killed()).toBe(true);
  });

  test("rejects an unavailable stderr pipe and terminates the child", async () => {
    const child = createFakeSnapshotChild({ stderr: null });
    installFakeSnapshotChild(child);

    await expect(
      executeDatabaseSnapshot("source.db", "destination.db"),
    ).rejects.toThrow("subprocess stderr pipe is unavailable");

    expect(child.killed()).toBe(true);
  });

  test("swallows a child kill failure during termination and surfaces the primary error", async () => {
    const child = createFakeSnapshotChild({
      stdout: trackedStdout(protocolFrame("ready"), protocolFrame("sql-start"))
        .stream,
      onKill: () => {
        throw new Error("injected kill failure");
      },
    });
    installFakeSnapshotChild(child);

    await expect(
      executeDatabaseSnapshot("source.db", "destination.db", {
        observer: {
          onReady: () => {
            throw new Error("injected onReady failure");
          },
        },
      }),
    ).rejects.toThrow("injected onReady failure");

    expect(child.killed()).toBe(true);
  });

  test("swallows a child stdin close failure during termination and surfaces the primary error", async () => {
    const child = createFakeSnapshotChild({
      stdout: trackedStdout(protocolFrame("ready")).stream,
      stdin: {
        write: () => 1,
        flush: () => {},
        end: () => {
          throw new Error("injected stdin end failure");
        },
      },
    });
    installFakeSnapshotChild(child);

    await expect(
      executeDatabaseSnapshot("source.db", "destination.db", {
        observer: {
          onReady: () => {
            throw new Error("injected onReady failure");
          },
        },
      }),
    ).rejects.toThrow("injected onReady failure");

    expect(child.killed()).toBe(true);
  });

  test("swallows an authorization write failure and continues protocol validation", async () => {
    const child = createFakeSnapshotChild({
      stdout: trackedStdout(protocolFrame("ready"), protocolFrame("sql-start"))
        .stream,
      stdin: {
        write: () => {
          throw new Error("injected stdin write failure");
        },
        flush: () => {},
        end: () => {},
      },
    });
    installFakeSnapshotChild(child);

    // The executor marks authorization complete before the write attempt, so
    // a failing stdin write is swallowed and never masks the protocol outcome.
    await expect(
      executeDatabaseSnapshot("source.db", "destination.db", {
        gated: true,
        observer: {
          onReady: ({ authorizeStart }) => {
            authorizeStart();
          },
        },
      }),
    ).rejects.toThrow(/protocol incomplete/);
  });

  test("rejects a stdout read failure from the child stream", async () => {
    const child = createFakeSnapshotChild({
      stdout: failingStream("injected stdout read failure"),
    });
    installFakeSnapshotChild(child);

    await expect(
      executeDatabaseSnapshot("source.db", "destination.db"),
    ).rejects.toThrow("injected stdout read failure");

    expect(child.killed()).toBe(true);
  });

  test("rejects a lifecycle frame emitted after protocol completion", async () => {
    const child = createFakeSnapshotChild({
      stdout: trackedStdout(
        protocolFrame("ready"),
        protocolFrame("sql-start"),
        protocolFrame("sql-end"),
        protocolFrame("done"),
        protocolFrame("ready"),
      ).stream,
    });
    installFakeSnapshotChild(child);

    await expect(
      executeDatabaseSnapshot("source.db", "destination.db"),
    ).rejects.toThrow(/unexpected "ready" after completion/);

    expect(child.killed()).toBe(true);
  });

  test("rejects a stderr capture failure after the child exits", async () => {
    const child = createFakeSnapshotChild({
      stdout: trackedStdout(
        protocolFrame("ready"),
        protocolFrame("sql-start"),
        protocolFrame("sql-end"),
        protocolFrame("done"),
      ).stream,
      stderr: failingStream("injected stderr capture failure"),
    });
    installFakeSnapshotChild(child);

    await expect(
      executeDatabaseSnapshot("source.db", "destination.db"),
    ).rejects.toThrow("injected stderr capture failure");

    expect(child.killed()).toBe(true);
  });

  test("rejects an onReaped observer failure after a clean child completion", async () => {
    const child = createFakeSnapshotChild({
      stdout: trackedStdout(
        protocolFrame("ready"),
        protocolFrame("sql-start"),
        protocolFrame("sql-end"),
        protocolFrame("done"),
      ).stream,
    });
    installFakeSnapshotChild(child);

    await expect(
      executeDatabaseSnapshot("source.db", "destination.db", {
        observer: {
          onReaped: () => {
            throw new Error("injected onReaped failure");
          },
        },
      }),
    ).rejects.toThrow("injected onReaped failure");

    expect(child.killed()).toBe(false);
  });

  test("settles a complete protocol when the child-exit promise rejects", async () => {
    const stdout = trackedStdout(
      protocolFrame("ready"),
      protocolFrame("sql-start"),
      protocolFrame("sql-end"),
      protocolFrame("done"),
    );
    const child = createFakeSnapshotChild({
      stdout: stdout.stream,
      exited: Promise.reject(
        new Error("injected child-exit promise rejection"),
      ),
    });
    installFakeSnapshotChild(child);

    // The executor normalizes the exit promise, so its rejection is
    // swallowed and cannot fail a snapshot whose protocol completed.
    await expect(
      executeDatabaseSnapshot("source.db", "destination.db"),
    ).resolves.toBeUndefined();

    expect(stdout.delivered).toEqual([
      protocolFrame("ready"),
      protocolFrame("sql-start"),
      protocolFrame("sql-end"),
      protocolFrame("done"),
    ]);
    expect(stdout.stream.locked).toBe(false);
    expect(child.killed()).toBe(false);
  });

  test("rejects a clean child completion terminated by signal", async () => {
    const child = createFakeSnapshotChild({
      stdout: trackedStdout(
        protocolFrame("ready"),
        protocolFrame("sql-start"),
        protocolFrame("sql-end"),
        protocolFrame("done"),
      ).stream,
      exitCode: null,
      signalCode: "SIGTERM",
    });
    installFakeSnapshotChild(child);

    await expect(
      executeDatabaseSnapshot("source.db", "destination.db"),
    ).rejects.toThrow("snapshot process terminated by signal SIGTERM");

    expect(child.killed()).toBe(false);
  });

  test("processes multiple complete lifecycle frames delivered in one chunk", async () => {
    const combined = [
      protocolFrame("ready"),
      protocolFrame("sql-start"),
      protocolFrame("sql-end"),
      protocolFrame("done"),
    ].join("");
    const stdout = trackedStdout(combined);
    const child = createFakeSnapshotChild({ stdout: stdout.stream });
    installFakeSnapshotChild(child);

    const events: string[] = [];
    await expect(
      executeDatabaseSnapshot("source.db", "destination.db", {
        observer: {
          onReady: () => {
            events.push("ready");
          },
          onSqlStart: () => {
            events.push("sql-start");
          },
          onSqlEnd: () => {
            events.push("sql-end");
          },
        },
      }),
    ).resolves.toBeUndefined();

    expect(events).toEqual(["ready", "sql-start", "sql-end"]);
    expect(stdout.delivered).toEqual([combined]);
    expect(stdout.stream.locked).toBe(false);
    expect(child.killed()).toBe(false);
  });

  test("reassembles a lifecycle frame split across two stream chunks", async () => {
    const splitFirstPart = '{"type":"ready","times';
    const splitSecondPart = 'tamp":1,"hrtime":1}\n';
    const stdout = trackedStdout(
      splitFirstPart,
      splitSecondPart,
      protocolFrame("sql-start"),
      protocolFrame("sql-end"),
      protocolFrame("done"),
    );
    const child = createFakeSnapshotChild({ stdout: stdout.stream });
    installFakeSnapshotChild(child);

    await expect(
      executeDatabaseSnapshot("source.db", "destination.db"),
    ).resolves.toBeUndefined();

    expect(stdout.delivered).toEqual([
      splitFirstPart,
      splitSecondPart,
      protocolFrame("sql-start"),
      protocolFrame("sql-end"),
      protocolFrame("done"),
    ]);
    expect(stdout.stream.locked).toBe(false);
    expect(child.killed()).toBe(false);
  });

  test("skips blank lines between lifecycle frames without disturbing protocol order", async () => {
    const stdout = trackedStdout(
      "\n  \n",
      protocolFrame("ready"),
      protocolFrame("sql-start"),
      protocolFrame("sql-end"),
      protocolFrame("done"),
    );
    const child = createFakeSnapshotChild({ stdout: stdout.stream });
    installFakeSnapshotChild(child);

    const events: string[] = [];
    await expect(
      executeDatabaseSnapshot("source.db", "destination.db", {
        observer: {
          onReady: () => {
            events.push("ready");
          },
          onSqlStart: () => {
            events.push("sql-start");
          },
          onSqlEnd: () => {
            events.push("sql-end");
          },
        },
      }),
    ).resolves.toBeUndefined();

    expect(events).toEqual(["ready", "sql-start", "sql-end"]);
    expect(child.killed()).toBe(false);
  });

  test("delivers an undefined hrtime boundary when a frame omits it", async () => {
    const stdout = trackedStdout(
      `${JSON.stringify({ type: "ready", timestamp: 1 })}\n`,
      `${JSON.stringify({ type: "sql-start", timestamp: 2 })}\n`,
      protocolFrame("sql-end"),
      protocolFrame("done"),
    );
    const child = createFakeSnapshotChild({ stdout: stdout.stream });
    installFakeSnapshotChild(child);

    const boundaries: DatabaseSnapshotBoundary[] = [];
    await expect(
      executeDatabaseSnapshot("source.db", "destination.db", {
        observer: {
          onSqlStart: (boundary) => {
            boundaries.push(boundary);
          },
        },
      }),
    ).resolves.toBeUndefined();

    expect(boundaries).toEqual([{ timestamp: 2, hrtime: undefined }]);
    expect(child.killed()).toBe(false);
  });

  test("rejects a completed child that exits non-zero with empty stderr using the code fallback", async () => {
    const child = createFakeSnapshotChild({
      stdout: trackedStdout(
        protocolFrame("ready"),
        protocolFrame("sql-start"),
        protocolFrame("sql-end"),
        protocolFrame("done"),
      ).stream,
      exitCode: 2,
    });
    installFakeSnapshotChild(child);

    await expect(
      executeDatabaseSnapshot("source.db", "destination.db"),
    ).rejects.toThrow("snapshot execution failed: exit code 2");

    expect(child.killed()).toBe(false);
  });

  test("rejects a completed child that exits non-zero with stderr detail in the message", async () => {
    const child = createFakeSnapshotChild({
      stdout: trackedStdout(
        protocolFrame("ready"),
        protocolFrame("sql-start"),
        protocolFrame("sql-end"),
        protocolFrame("done"),
      ).stream,
      stderr: trackedStdout("vacuum failure detail").stream,
      exitCode: 1,
    });
    installFakeSnapshotChild(child);

    await expect(
      executeDatabaseSnapshot("source.db", "destination.db"),
    ).rejects.toThrow("snapshot execution failed: vacuum failure detail");

    expect(child.killed()).toBe(false);
  });

  test("surfaces the primary failure when the onReaped observer also fails", async () => {
    const child = createFakeSnapshotChild({
      stdout: trackedStdout(protocolFrame("ready"), protocolFrame("sql-start"))
        .stream,
    });
    installFakeSnapshotChild(child);

    await expect(
      executeDatabaseSnapshot("source.db", "destination.db", {
        observer: {
          onReady: () => {
            throw new Error("primary onReady failure");
          },
          onReaped: () => {
            throw new Error("secondary onReaped failure");
          },
        },
      }),
    ).rejects.toThrow("primary onReady failure");

    expect(child.killed()).toBe(true);
  });

  test("authorizes a gated child exactly once when the observer authorizes twice", async () => {
    const stdinWrites: string[] = [];
    const child = createFakeSnapshotChild({
      stdout: trackedStdout(
        protocolFrame("ready"),
        protocolFrame("sql-start"),
        protocolFrame("sql-end"),
        protocolFrame("done"),
      ).stream,
      stdin: {
        write: (data?: string | Uint8Array) => {
          stdinWrites.push(String(data));
          return 1;
        },
        flush: () => {},
        end: () => {},
      },
    });
    installFakeSnapshotChild(child);

    await expect(
      executeDatabaseSnapshot("source.db", "destination.db", {
        gated: true,
        observer: {
          onReady: ({ authorizeStart }) => {
            authorizeStart();
            authorizeStart();
          },
        },
      }),
    ).resolves.toBeUndefined();

    expect(stdinWrites).toEqual(["START\n"]);
    expect(child.killed()).toBe(false);
  });

  test("rejects a numeric stdin handle and terminates the child", async () => {
    const child = createFakeSnapshotChild({ stdin: 2 });
    installFakeSnapshotChild(child);

    await expect(
      executeDatabaseSnapshot("source.db", "destination.db"),
    ).rejects.toThrow("subprocess stdin pipe is unavailable");

    expect(child.killed()).toBe(true);
  });

  test("rejects a numeric stdout handle and terminates the child", async () => {
    const child = createFakeSnapshotChild({ stdout: 3 });
    installFakeSnapshotChild(child);

    await expect(
      executeDatabaseSnapshot("source.db", "destination.db"),
    ).rejects.toThrow("subprocess stdout pipe is unavailable");

    expect(child.killed()).toBe(true);
  });

  test("rejects a numeric stderr handle and terminates the child", async () => {
    const child = createFakeSnapshotChild({ stderr: 4 });
    installFakeSnapshotChild(child);

    await expect(
      executeDatabaseSnapshot("source.db", "destination.db"),
    ).rejects.toThrow("subprocess stderr pipe is unavailable");

    expect(child.killed()).toBe(true);
  });
});

// ── Isolated Child Failure Ordering ───────────────────────────────────────

describe("createDatabaseBackup — isolated child failure ordering", () => {
  test("drains and reaps the failed child before staging cleanup runs", async () => {
    const source = openSourceHandle();
    const readyFrame = protocolFrame("ready");
    const sqlStartFrame = protocolFrame("sql-start");
    const stdout = trackedStdout(readyFrame, sqlStartFrame);
    const child = createFakeSnapshotChild({ stdout: stdout.stream });
    installFakeSnapshotChild(child);

    let reapedBeforeCleanup = false;
    let drainedBeforeCleanup = false;

    await expect(
      backUp(source.sourcePath, {
        observer: {
          onReady: () => {
            throw new Error("injected onReady failure");
          },
          onReaped: () => {
            reapedBeforeCleanup = true;
          },
        },
        cleanupStaging: async (dir) => {
          drainedBeforeCleanup =
            stdout.stream.locked === false && stdout.delivered.length === 2;
          const { rm } = await import("node:fs/promises");
          await rm(dir, { recursive: true, force: true });
        },
      }),
    ).rejects.toThrow("injected onReady failure");

    expect(reapedBeforeCleanup).toBe(true);
    expect(drainedBeforeCleanup).toBe(true);
    expect(child.killed()).toBe(true);
    expect(readdirSync(join(home.dataRoot, "backups"))).toEqual([]);
  });

  test("defers reaping, rejection, and staging cleanup until the terminated child actually exits", async () => {
    const source = openSourceHandle();
    const stdout = trackedStdout(
      protocolFrame("ready"),
      protocolFrame("sql-start"),
    );
    const deferredExit = createDeferred<number>();
    const killObserved = createDeferred<void>();
    let exitObserved = false;
    deferredExit.promise.then(() => {
      exitObserved = true;
    });
    const child = createFakeSnapshotChild({
      stdout: stdout.stream,
      exited: deferredExit.promise,
      exitCode: null,
      signalCode: null,
      onKill: () => killObserved.resolve(undefined),
    });
    installFakeSnapshotChild(child);

    let settled = false;
    const reapedExitStates: boolean[] = [];
    const cleanupExitStates: boolean[] = [];
    const backup = backUp(source.sourcePath, {
      observer: {
        onReady: () => {
          throw new Error("injected onReady failure");
        },
        onReaped: () => {
          reapedExitStates.push(exitObserved);
        },
      },
      cleanupStaging: async (dir) => {
        cleanupExitStates.push(exitObserved);
        rmSync(dir, { recursive: true, force: true });
      },
    });
    backup.catch(() => {
      settled = true;
    });

    await killObserved.promise;
    // Settlement must not outrun `proc.exited`, including past the 250 ms
    // termination grace a grace-expiry settlement used to consume.
    await Bun.sleep(400);
    expect(settled).toBe(false);
    expect(reapedExitStates).toEqual([]);
    expect(cleanupExitStates).toEqual([]);

    deferredExit.resolve(0);
    await expect(backup).rejects.toThrow("injected onReady failure");

    expect(child.killed()).toBe(true);
    expect(reapedExitStates).toEqual([true]);
    expect(cleanupExitStates).toEqual([true]);
  });
});
