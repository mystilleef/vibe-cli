import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { updateConstitution } from "../src/tools/constitution";
import { resolveAutosession } from "../src/utils/autosession";
import { openVibeDatabase, type VibeDatabase } from "../src/utils/database";
import { getLearningEntries } from "../src/utils/storage";
import { createTempHome, type TempHomeContext } from "./helpers/tempHome";

const homes: TempHomeContext[] = [];
const handles: VibeDatabase[] = [];

afterEach(async () => {
  for (const handle of handles.splice(0)) handle.close();
  await Promise.all(homes.splice(0).map((home) => home.cleanup()));
});

async function useTempHome(): Promise<TempHomeContext> {
  const home = await createTempHome();
  homes.push(home);
  await mkdir(home.dataRoot, { recursive: true });
  return home;
}

function openTracked(): VibeDatabase {
  const handle = openVibeDatabase();
  handles.push(handle);
  return handle;
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, JSON.stringify(value, null, 2), "utf8");
}

async function writeCompleteLegacyArtifacts(
  home: TempHomeContext,
): Promise<void> {
  const sessionsDir = join(home.dataRoot, "sessions");
  await mkdir(sessionsDir, { recursive: true });
  await writeJson(join(sessionsDir, "abc123.json"), {
    id: "session-a",
    createdAt: "2026-01-01T00:00:00.000Z",
    lastAccessedAt: "2026-01-01T01:00:00.000Z",
  });
  await writeJson(join(home.dataRoot, "vibe-log.json"), {
    mistakes: {
      coding: {
        count: 1,
        examples: [{ mistake: "used database", timestamp: 42 }],
        lastUpdated: 42,
      },
    },
    lastUpdated: 42,
  });
  await writeJson(join(home.dataRoot, "constitution.json"), {
    "session-a": ["rule one"],
  });
  await writeJson(join(home.dataRoot, "history.json"), {
    "session-a": [
      { input: { goal: "ship" }, output: "approved", timestamp: 99 },
    ],
  });
}

function expectCompleteLegacyImport(handle: VibeDatabase): void {
  expect(
    handle.db.query("SELECT id, cwd_key FROM sessions").all(),
  ).toContainEqual({ id: "session-a", cwd_key: "abc123" });
  expect(
    handle.db
      .query("SELECT observation, timestamp FROM learning_entries")
      .all(),
  ).toEqual([{ observation: "used database", timestamp: 42 }]);
  expect(
    handle.db.query("SELECT rule FROM constitution_rules").all(),
  ).toContainEqual({ rule: "rule one" });
  expect(
    handle.db.query("SELECT goal, output, timestamp FROM interactions").all(),
  ).toEqual([{ goal: "ship", output: "approved", timestamp: 99 }]);
}

describe("custom database path", () => {
  test("creates parent directory for custom path", async () => {
    const customDir = await mkdtemp(join(tmpdir(), "vibe-custom-db-"));
    const customPath = join(customDir, "subdir", "test.db");

    try {
      const handle = openVibeDatabase({ path: customPath });
      handles.push(handle);

      expect(existsSync(customPath)).toBe(true);
      expect(handle.path).toBe(customPath);
    } finally {
      await rm(customDir, { recursive: true, force: true });
    }
  });
});

describe("legacy JSON migration", () => {
  test("imports valid legacy artifacts and backs them up", async () => {
    const home = await useTempHome();
    const sessionsDir = join(home.dataRoot, "sessions");
    await mkdir(sessionsDir, { recursive: true });
    await writeJson(join(sessionsDir, "abc123.json"), {
      id: "session-a",
      createdAt: "2026-01-01T00:00:00.000Z",
      lastAccessedAt: "2026-01-01T01:00:00.000Z",
    });
    await writeJson(join(home.dataRoot, "vibe-log.json"), {
      mistakes: {
        coding: {
          count: 1,
          examples: [
            {
              type: "success",
              category: "coding",
              mistake: "used database",
              solution: "keep using database",
              timestamp: 42,
              demoId: "demo-a",
            },
          ],
          lastUpdated: 42,
        },
      },
      lastUpdated: 42,
    });
    await writeJson(join(home.dataRoot, "constitution.json"), {
      "session-a": ["rule one", "rule two"],
    });
    await writeJson(join(home.dataRoot, "history.json"), {
      "session-a": [
        { input: { goal: "ship" }, output: "approved", timestamp: 99 },
      ],
    });

    const handle = openTracked();

    expect(
      handle.db.query("SELECT id, cwd_key FROM sessions").all(),
    ).toContainEqual({ id: "session-a", cwd_key: "abc123" });
    expect(
      handle.db
        .query(
          "SELECT type, category, observation, solution, timestamp, demo_id FROM learning_entries",
        )
        .all(),
    ).toEqual([
      {
        type: "success",
        category: "coding",
        observation: "used database",
        solution: "keep using database",
        timestamp: 42,
        demo_id: "demo-a",
      },
    ]);
    expect(
      handle.db
        .query("SELECT rule FROM constitution_rules ORDER BY position")
        .all(),
    ).toEqual([{ rule: "rule one" }, { rule: "rule two" }]);
    expect(
      handle.db.query("SELECT goal, output, timestamp FROM interactions").all(),
    ).toEqual([{ goal: "ship", output: "approved", timestamp: 99 }]);
    expect(existsSync(join(sessionsDir, "abc123.json.bak"))).toBe(true);
    expect(existsSync(join(home.dataRoot, "vibe-log.json.bak"))).toBe(true);
    expect(existsSync(join(home.dataRoot, "constitution.json.bak"))).toBe(true);
    expect(existsSync(join(home.dataRoot, "history.json.bak"))).toBe(true);
  });

  test("does not duplicate imported records on repeated startup", async () => {
    const home = await useTempHome();
    await writeJson(join(home.dataRoot, "vibe-log.json"), {
      mistakes: {
        process: {
          count: 1,
          examples: [{ mistake: "repeat", timestamp: 7 }],
          lastUpdated: 7,
        },
      },
      lastUpdated: 7,
    });

    const first = openTracked();
    first.close();
    handles.pop();
    const second = openTracked();

    expect(
      second.db.query("SELECT count(*) AS count FROM learning_entries").get(),
    ).toEqual({ count: 1 });
    expect(
      second.db.query("SELECT artifact FROM legacy_imports").all(),
    ).toEqual([{ artifact: "vibe-log.json" }]);
  });

  test("leaves malformed artifacts in place and unmarked", async () => {
    const home = await useTempHome();
    const badPath = join(home.dataRoot, "vibe-log.json");
    await writeFile(badPath, "{ nope", "utf8");

    const handle = openTracked();

    expect(existsSync(badPath)).toBe(true);
    expect(existsSync(`${badPath}.bak`)).toBe(false);
    expect(handle.db.query("SELECT * FROM legacy_imports").all()).toEqual([]);
    expect(
      handle.db.query("SELECT count(*) AS count FROM learning_entries").get(),
    ).toEqual({ count: 0 });
  });

  test("uses collision-safe backup paths", async () => {
    const home = await useTempHome();
    await writeJson(join(home.dataRoot, "constitution.json"), { s: ["rule"] });
    await writeFile(
      join(home.dataRoot, "constitution.json.bak"),
      "old",
      "utf8",
    );

    openTracked();

    expect(existsSync(join(home.dataRoot, "constitution.json.bak"))).toBe(true);
    expect(existsSync(join(home.dataRoot, "constitution.json.1.bak"))).toBe(
      true,
    );
  });

  test("autosession path imports every legacy artifact class", async () => {
    const home = await useTempHome();
    await writeCompleteLegacyArtifacts(home);

    resolveAutosession("/tmp/project-a");
    const handle = openTracked();

    expectCompleteLegacyImport(handle);
  });

  test("learning path imports every legacy artifact class", async () => {
    const home = await useTempHome();
    await writeCompleteLegacyArtifacts(home);

    expect(getLearningEntries()["coding"]?.[0]?.observation).toBe(
      "used database",
    );
    const handle = openTracked();

    expectCompleteLegacyImport(handle);
  });

  test("constitution path imports every legacy artifact class", async () => {
    const home = await useTempHome();
    await writeCompleteLegacyArtifacts(home);

    updateConstitution("new rule");
    const handle = openTracked();

    expectCompleteLegacyImport(handle);
  });
});

describe("malformed legacy learning entries", () => {
  test("rejects entire batch when any entry has invalid type field", async () => {
    const home = await useTempHome();
    await writeJson(join(home.dataRoot, "vibe-log.json"), {
      mistakes: {
        coding: {
          count: 2,
          examples: [
            { mistake: "valid", timestamp: 42 },
            { mistake: "bad type", timestamp: 43, type: "invalid-type" },
          ],
          lastUpdated: 43,
        },
      },
      lastUpdated: 43,
    });

    const handle = openTracked();

    // extractLearningEntries returns null on any malformed entry,
    // so the entire import is skipped
    expect(
      handle.db.query("SELECT count(*) AS count FROM learning_entries").get(),
    ).toEqual({ count: 0 });
  });

  test("rejects entire batch when any entry has non-string solution", async () => {
    const home = await useTempHome();
    await writeJson(join(home.dataRoot, "vibe-log.json"), {
      mistakes: {
        coding: {
          count: 2,
          examples: [
            { mistake: "valid", timestamp: 42 },
            { mistake: "bad solution", timestamp: 43, solution: 123 },
          ],
          lastUpdated: 43,
        },
      },
      lastUpdated: 43,
    });

    const handle = openTracked();

    expect(
      handle.db.query("SELECT count(*) AS count FROM learning_entries").get(),
    ).toEqual({ count: 0 });
  });

  test("rejects entire batch when any entry has non-string demoId", async () => {
    const home = await useTempHome();
    await writeJson(join(home.dataRoot, "vibe-log.json"), {
      mistakes: {
        coding: {
          count: 2,
          examples: [
            { mistake: "valid", timestamp: 42 },
            { mistake: "bad demoId", timestamp: 43, demoId: 123 },
          ],
          lastUpdated: 43,
        },
      },
      lastUpdated: 43,
    });

    const handle = openTracked();

    expect(
      handle.db.query("SELECT count(*) AS count FROM learning_entries").get(),
    ).toEqual({ count: 0 });
  });
});

describe("readdirSync failure handling", () => {
  test("gracefully handles unreadable sessions directory", async () => {
    const home = await useTempHome();
    const sessionsDir = join(home.dataRoot, "sessions");
    await mkdir(sessionsDir, { recursive: true });

    // Create a valid session file first
    await writeJson(join(sessionsDir, "test.json"), {
      id: "session-1",
      createdAt: "2026-01-01T00:00:00.000Z",
      lastAccessedAt: "2026-01-01T01:00:00.000Z",
    });

    // Now remove the directory and replace with a file
    // This will cause readdirSync to fail with ENOTDIR
    await rm(sessionsDir, { recursive: true, force: true });
    await writeFile(sessionsDir, "not a directory", "utf8");

    // Should not throw - the catch block handles this
    const handle = openTracked();
    handles.push(handle);

    // No sessions should be imported
    expect(
      handle.db.query("SELECT count(*) AS count FROM sessions").get(),
    ).toEqual({ count: 0 });
  });
});
