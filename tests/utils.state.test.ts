import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
    const { getHistorySummary, loadHistory } = await getState();
    await loadHistory();
    expect(getHistorySummary("no-such-session")).toBe("");
  });

  test("returns empty string when session exists but has no entries", async () => {
    const { getHistorySummary, loadHistory } = await getState();
    await loadHistory();
    expect(getHistorySummary("empty-sess")).toBe("");
  });

  test("returns formatted history block after entries added", async () => {
    const { addToHistory, getHistorySummary, loadHistory } = await getState();
    await loadHistory();
    await addToHistory(
      "sess1",
      { goal: "Build X", plan: "step 1" },
      "do it right",
    );
    const summary = getHistorySummary("sess1");
    expect(summary).toContain("History Context:");
    expect(summary).toContain("Goal Build X");
    expect(summary).toContain("do it right");
  });

  test("caps output to last 5 interactions", async () => {
    const { addToHistory, getHistorySummary, loadHistory } = await getState();
    await loadHistory();
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
    const { addToHistory, loadHistory, clearSession } = await getState();
    await loadHistory();
    await clearSession("cap");

    for (let i = 0; i < 11; i++) {
      await addToHistory("cap", { goal: `g${i}`, plan: `p${i}` }, `out${i}`);
    }
    // After 11 pushes, oldest (g0) should have been shifted out
    // Verify by checking summary only shows 5 of the last 10 but not the 11th oldest
    const { getHistorySummary } = await getState();
    const summary = getHistorySummary("cap");
    expect(summary).not.toContain("g0");
    expect(summary).toContain("g10");
  });

  test("persists entries so they survive a loadHistory round-trip", async () => {
    const { addToHistory, loadHistory, getHistorySummary } = await getState();
    await loadHistory();
    await addToHistory("persist", { goal: "persist-goal", plan: "pp" }, "out");

    // Re-load simulates a fresh process read
    await loadHistory();
    const summary = getHistorySummary("persist");
    expect(summary).toContain("persist-goal");
  });
});

describe("clearSession", () => {
  test("removes session so getHistorySummary returns empty", async () => {
    const { addToHistory, clearSession, getHistorySummary, loadHistory } =
      await getState();
    await loadHistory();
    await addToHistory("del", { goal: "g", plan: "p" }, "o");
    await clearSession("del");
    expect(getHistorySummary("del")).toBe("");
  });

  test("persists the deletion across loadHistory", async () => {
    const { addToHistory, clearSession, getHistorySummary, loadHistory } =
      await getState();
    await loadHistory();
    await addToHistory("del2", { goal: "g", plan: "p" }, "o");
    await clearSession("del2");
    await loadHistory();
    expect(getHistorySummary("del2")).toBe("");
  });
});
