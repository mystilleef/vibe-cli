import { Database } from "bun:sqlite";
import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DATABASE_FILENAME, openVibeDatabase } from "../src/utils/database";

/**
 * Converting a fresh file to WAL fails fast with SQLITE_BUSY when concurrent
 * first opens race; openVibeDatabase waits out the competing writer and
 * retries. Real multi-process races live in migration.test.ts; these tests
 * inject conversion faults deterministically.
 */

const WAL_PRAGMA = "PRAGMA journal_mode = WAL";
const realExec = Database.prototype.exec;
const roots: string[] = [];

afterEach(async () => {
  mock.restore();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function tempPath(name: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `vibe-cli-db-wal-${name}-`));
  roots.push(root);
  return join(root, DATABASE_FILENAME);
}

/** Fail the WAL conversion with `code` for its first `failures` attempts. */
function failWalConversion(code: string, failures: number): void {
  let remaining = failures;
  spyOn(Database.prototype, "exec").mockImplementation(function (
    this: Database,
    ...args: Parameters<Database["exec"]>
  ) {
    if (args[0] === WAL_PRAGMA && remaining > 0) {
      remaining--;
      const error = new Error(`${code}: database is locked`) as Error & {
        code: string;
      };
      error.code = code;
      throw error;
    }
    return realExec.apply(this, args);
  });
}

describe("openVibeDatabase WAL conversion", () => {
  test("opens in WAL mode when a busy conversion clears on retry", async () => {
    failWalConversion("SQLITE_BUSY", 1);
    const handle = openVibeDatabase({ path: await tempPath("busy-once") });
    try {
      const row = handle.db.query("PRAGMA journal_mode").get();
      expect(row).toEqual({ journal_mode: "wal" });
    } finally {
      handle.close();
    }
  });

  test("rethrows SQLITE_BUSY and closes the connection when every attempt fails", async () => {
    failWalConversion("SQLITE_BUSY", Number.POSITIVE_INFINITY);
    const path = await tempPath("busy-always");
    const closeSpy = spyOn(Database.prototype, "close");

    expect(() => openVibeDatabase({ path })).toThrow("database is locked");
    expect(closeSpy).toHaveBeenCalledTimes(1);
  });

  test("rethrows non-busy conversion errors without retrying", async () => {
    // One injected failure: a retry would succeed, so a throw proves none ran.
    failWalConversion("SQLITE_IOERR", 1);
    const path = await tempPath("ioerr");

    expect(() => openVibeDatabase({ path })).toThrow("SQLITE_IOERR");
  });

  test("closes the connection when post-construction schema setup fails", async () => {
    const path = await tempPath("init-fail");
    const db = new Database(path, { create: true });
    // An incompatible table makes initializeSchema throw.
    db.exec("CREATE TABLE schema_migrations (version TEXT PRIMARY KEY)");
    db.close();

    // Spy after the setup db's own close() so this only counts the handle
    // openVibeDatabase opened.
    const closeSpy = spyOn(Database.prototype, "close");
    expect(() => openVibeDatabase({ path })).toThrow();
    expect(closeSpy).toHaveBeenCalledTimes(1);
  });
});
