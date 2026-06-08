import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openVibeDatabase } from "../src/utils/database";
import { createTempHome, type TempHomeContext } from "./helpers/tempHome";

let home: TempHomeContext;
let cwd: string;
const originalCwd = process.cwd();

beforeEach(async () => {
  home = await createTempHome();
  cwd = await mkdtemp(join(tmpdir(), "vibe-cli-state-"));
  process.chdir(cwd);
});

afterEach(async () => {
  process.chdir(originalCwd);
  await rm(cwd, { recursive: true, force: true });
  await home.cleanup();
});

// Import fresh each test via dynamic import to get a clean module state
async function getState() {
  return import("../src/utils/state");
}

describe("getHistorySummary", () => {
  test("returns empty string for unknown session", async () => {
    const { getHistorySummary } = await getState();
    expect(getHistorySummary("no-such-session")).toBe("");
  });

  test("returns empty string when session exists but has no entries", async () => {
    const { getHistorySummary } = await getState();
    expect(getHistorySummary("empty-sess")).toBe("");
  });

  test("returns formatted history block after entries added", async () => {
    const { addToHistory, getHistorySummary } = await getState();
    await addToHistory(
      "sess1",
      { goal: "Build X", plan: "step 1" },
      "do it right",
    );
    const summary = getHistorySummary("sess1");
    expect(summary).not.toContain("History Context:");
    expect(summary).toContain("Goal Build X");
    expect(summary).toContain("do it right");
    expect(summary).not.toContain("do it right...");
  });

  test("caps output to last 5 interactions", async () => {
    const { addToHistory, getHistorySummary } = await getState();
    for (let i = 0; i < 8; i++) {
      await addToHistory("s", { goal: `g${i}`, plan: `p${i}` }, `out${i}`);
    }
    const summary = getHistorySummary("s");
    // Only interactions 3-7 should appear (last 5 of 8)
    expect(summary).not.toContain("g0");
    expect(summary).toContain("g7");
  });
});

describe("addToHistory", () => {
  test("keeps session capped at 10 entries by shifting oldest", async () => {
    const { addToHistory } = await getState();
    // Clear session directly via database
    const handle0 = openVibeDatabase({ legacyImports: "none" });
    handle0.db
      .prepare("DELETE FROM interactions WHERE session_id = ?")
      .run("cap");

    for (let i = 0; i < 11; i++) {
      await addToHistory("cap", { goal: `g${i}`, plan: `p${i}` }, `out${i}`);
    }

    const handle = openVibeDatabase({ legacyImports: "none" });
    const count = handle.db
      .query("SELECT count(*) AS count FROM interactions WHERE session_id = ?")
      .get("cap") as { count: number };
    const oldest = handle.db
      .query(
        "SELECT goal FROM interactions WHERE session_id = ? ORDER BY timestamp ASC, id ASC LIMIT 1",
      )
      .get("cap") as { goal: string };

    expect(count.count).toBe(10);
    expect(oldest.goal).toBe("g1");

    const { getHistorySummary } = await getState();
    const summary = getHistorySummary("cap");
    expect(summary).not.toContain("g0");
    expect(summary).toContain("g10");
  });

  test("appends ... only when output exceeds 100 characters", async () => {
    const { addToHistory, getHistorySummary } = await getState();
    await addToHistory("trunc", { goal: "Long", plan: "p" }, "a".repeat(100));
    const exact = getHistorySummary("trunc");
    expect(exact).not.toContain("...");

    await addToHistory(
      "trunc2",
      { goal: "Longer", plan: "p" },
      "b".repeat(150),
    );
    const truncated = getHistorySummary("trunc2");
    expect(truncated).toContain("...");
    expect(truncated).toContain("b".repeat(100));
    expect(truncated).not.toContain("b".repeat(101));
  });

  test("persists entries across database connections", async () => {
    const { addToHistory, getHistorySummary } = await getState();
    await addToHistory("persist", { goal: "persist-goal", plan: "pp" }, "out");

    const summary = getHistorySummary("persist");
    expect(summary).toContain("persist-goal");
  });

  test("writes interactions to SQLite without recreating history.json", async () => {
    const { addToHistory } = await getState();
    await addToHistory("sqlite", { goal: "sqlite-goal", plan: "p" }, "out");

    const handle = openVibeDatabase({ legacyImports: "none" });
    const row = handle.db
      .query(
        "SELECT goal, output FROM interactions WHERE session_id = ? LIMIT 1",
      )
      .get("sqlite") as { goal: string; output: string };

    expect(row).toEqual({ goal: "sqlite-goal", output: "out" });
    expect(existsSync(join(home.dataRoot, "history.json"))).toBe(false);
  });
});

describe("clearSession (internal)", () => {
  test("removing interactions makes getHistorySummary return empty", async () => {
    const { addToHistory, getHistorySummary } = await getState();
    await addToHistory("del", { goal: "g", plan: "p" }, "o");
    // Delete directly via database (clearSession is no longer exported)
    const handle = openVibeDatabase({ legacyImports: "none" });
    handle.db
      .prepare("DELETE FROM interactions WHERE session_id = ?")
      .run("del");
    const count = handle.db
      .query("SELECT count(*) AS count FROM interactions WHERE session_id = ?")
      .get("del") as { count: number };
    expect(count.count).toBe(0);
    expect(getHistorySummary("del")).toBe("");
  });

  test("deletion persists across connections", async () => {
    const { addToHistory, getHistorySummary } = await getState();
    await addToHistory("del2", { goal: "g", plan: "p" }, "o");
    // Delete directly via database
    const handle = openVibeDatabase({ legacyImports: "none" });
    handle.db
      .prepare("DELETE FROM interactions WHERE session_id = ?")
      .run("del2");
    expect(getHistorySummary("del2")).toBe("");
  });
});
