import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DATABASE_FILENAME,
  getDatabasePath,
  openVibeDatabase,
  type VibeDatabase,
} from "../src/utils/database";
import { createTempHome, type TempHomeContext } from "./helpers/tempHome";

const homes: TempHomeContext[] = [];
const roots: string[] = [];
const handles: VibeDatabase[] = [];

afterEach(async () => {
  for (const handle of handles.splice(0)) handle.close();
  await Promise.all(homes.splice(0).map((home) => home.cleanup()));
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function useTempHome(): Promise<TempHomeContext> {
  const home = await createTempHome();
  homes.push(home);
  return home;
}

async function tempDatabasePath(name: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `vibe-cli-db-${name}-`));
  roots.push(root);
  return join(root, DATABASE_FILENAME);
}

function openTracked(path?: string): VibeDatabase {
  const handle = openVibeDatabase(path === undefined ? undefined : { path });
  handles.push(handle);
  return handle;
}

describe("openVibeDatabase", () => {
  test("opens the default database under the vibe data root", async () => {
    const home = await useTempHome();
    const handle = openTracked();

    expect(getDatabasePath()).toBe(join(home.dataRoot, DATABASE_FILENAME));
    expect(handle.path).toBe(join(home.dataRoot, DATABASE_FILENAME));

    const journalMode = handle.db.query("PRAGMA journal_mode").get() as {
      journal_mode: string;
    };
    expect(journalMode.journal_mode).toBe("wal");
  });

  test("supports isolated file databases", async () => {
    const first = openTracked(await tempDatabasePath("first"));
    const second = openTracked(await tempDatabasePath("second"));

    first.db
      .prepare(
        "INSERT INTO sessions (id, cwd_key, created_at, last_accessed_at) VALUES (?, ?, ?, ?)",
      )
      .run(
        "session-a",
        "cwd",
        "2026-01-01T00:00:00.000Z",
        "2026-01-01T00:00:00.000Z",
      );

    const firstCount = first.db
      .query("SELECT count(*) AS count FROM sessions")
      .get() as { count: number };
    const secondCount = second.db
      .query("SELECT count(*) AS count FROM sessions")
      .get() as { count: number };

    expect(firstCount.count).toBe(1);
    expect(secondCount.count).toBe(0);
  });

  test("supports isolated in-memory databases", () => {
    const first = openTracked(":memory:");
    const second = openTracked(":memory:");

    first.db
      .prepare(
        "INSERT INTO sessions (id, cwd_key, created_at, last_accessed_at) VALUES (?, ?, ?, ?)",
      )
      .run(
        "session-a",
        "cwd",
        "2026-01-01T00:00:00.000Z",
        "2026-01-01T00:00:00.000Z",
      );

    const firstCount = first.db
      .query("SELECT count(*) AS count FROM sessions")
      .get() as { count: number };
    const secondCount = second.db
      .query("SELECT count(*) AS count FROM sessions")
      .get() as { count: number };

    expect(firstCount.count).toBe(1);
    expect(secondCount.count).toBe(0);
  });

  test("records migrations idempotently", async () => {
    const databasePath = await tempDatabasePath("migrations");
    const first = openTracked(databasePath);
    const initial = first.db
      .query("SELECT id FROM schema_migrations ORDER BY id")
      .all() as Array<{ id: string }>;
    first.close();
    handles.pop();

    const second = openTracked(databasePath);
    const repeated = second.db
      .query("SELECT id FROM schema_migrations ORDER BY id")
      .all() as Array<{ id: string }>;

    expect(initial).toEqual([{ id: "001_initial_schema" }]);
    expect(repeated).toEqual(initial);
  });

  test("reopens file databases after explicit close", async () => {
    const databasePath = await tempDatabasePath("lifecycle");
    const first = openTracked(databasePath);
    first.db
      .prepare(
        "INSERT INTO sessions (id, cwd_key, created_at, last_accessed_at) VALUES (?, ?, ?, ?)",
      )
      .run(
        "session-a",
        "cwd",
        "2026-01-01T00:00:00.000Z",
        "2026-01-01T00:00:00.000Z",
      );
    first.close();
    handles.pop();

    const second = openTracked(databasePath);
    const sessions = second.db
      .query("SELECT id FROM sessions ORDER BY id")
      .all() as Array<{ id: string }>;
    const migrations = second.db
      .query("SELECT id FROM schema_migrations ORDER BY id")
      .all() as Array<{ id: string }>;

    expect(sessions).toEqual([{ id: "session-a" }]);
    expect(migrations).toEqual([{ id: "001_initial_schema" }]);
  });

  test("enforces one session per CWD key", () => {
    const handle = openTracked(":memory:");
    const insert = handle.db.prepare(
      "INSERT INTO sessions (id, cwd_key, created_at, last_accessed_at) VALUES (?, ?, ?, ?)",
    );

    insert.run(
      "session-a",
      "same-cwd",
      "2026-01-01T00:00:00.000Z",
      "2026-01-01T00:00:00.000Z",
    );

    expect(() =>
      insert.run(
        "session-b",
        "same-cwd",
        "2026-01-01T00:00:00.000Z",
        "2026-01-01T00:00:00.000Z",
      ),
    ).toThrow();
  });

  test("supports session-bound cleanup through cascades", () => {
    const handle = openTracked(":memory:");
    handle.db
      .prepare(
        "INSERT INTO sessions (id, cwd_key, created_at, last_accessed_at) VALUES (?, ?, ?, ?)",
      )
      .run(
        "session-a",
        "cwd-a",
        "2026-01-01T00:00:00.000Z",
        "2026-01-01T00:00:00.000Z",
      );
    handle.db
      .prepare(
        "INSERT INTO constitution_rules (session_id, rule, position, created_at) VALUES (?, ?, ?, ?)",
      )
      .run("session-a", "rule", 0, "2026-01-01T00:00:00.000Z");
    handle.db
      .prepare(
        "INSERT INTO interactions (session_id, goal, output, timestamp) VALUES (?, ?, ?, ?)",
      )
      .run("session-a", "goal", "output", 1);

    handle.db.prepare("DELETE FROM sessions WHERE id = ?").run("session-a");

    const ruleCount = handle.db
      .query("SELECT count(*) AS count FROM constitution_rules")
      .get() as { count: number };
    const interactionCount = handle.db
      .query("SELECT count(*) AS count FROM interactions")
      .get() as { count: number };

    expect(ruleCount.count).toBe(0);
    expect(interactionCount.count).toBe(0);
  });

  test("orders constitution rules deterministically by position", () => {
    const handle = openTracked(":memory:");
    handle.db
      .prepare(
        "INSERT INTO sessions (id, cwd_key, created_at, last_accessed_at) VALUES (?, ?, ?, ?)",
      )
      .run(
        "session-a",
        "cwd-a",
        "2026-01-01T00:00:00.000Z",
        "2026-01-01T00:00:00.000Z",
      );
    const insertRule = handle.db.prepare(
      "INSERT INTO constitution_rules (session_id, rule, position, created_at) VALUES (?, ?, ?, ?)",
    );
    insertRule.run("session-a", "second", 1, "2026-01-01T00:00:00.000Z");
    insertRule.run("session-a", "first", 0, "2026-01-01T00:00:00.000Z");

    const rules = handle.db
      .query(
        "SELECT rule FROM constitution_rules WHERE session_id = ? ORDER BY position ASC",
      )
      .all("session-a") as Array<{ rule: string }>;

    expect(rules.map((entry) => entry.rule)).toEqual(["first", "second"]);
  });
});
