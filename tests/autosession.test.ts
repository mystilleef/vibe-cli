import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AUTOSESSION_TTL_MS,
  getCwdKey,
  getDataRoot,
  resolveAutosession,
} from "../src/utils/autosession";
import { openVibeDatabase } from "../src/utils/database";
import { createTempHome, type TempHomeContext } from "./helpers/tempHome";

const homes: TempHomeContext[] = [];
const cwdRoots: string[] = [];
const originalCwd = process.cwd();

afterEach(async () => {
  process.chdir(originalCwd);
  await Promise.all(
    cwdRoots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
  await Promise.all(homes.splice(0).map((home) => home.cleanup()));
});

async function useTempHome(): Promise<TempHomeContext> {
  const home = await createTempHome();
  homes.push(home);
  return home;
}

async function createCwd(name: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), `vibe-cli-${name}-`));
  cwdRoots.push(dir);
  return dir;
}

function updateLastAccessed(cwd: string, lastAccessedAt: string): void {
  const handle = openVibeDatabase();
  try {
    handle.db
      .prepare("UPDATE sessions SET last_accessed_at = ? WHERE cwd_key = ?")
      .run(lastAccessedAt, getCwdKey(cwd));
  } finally {
    handle.close();
  }
}

describe("autosession resolver", () => {
  test("same CWD reuses an active session and refreshes lastAccessedAt", async () => {
    const home = await useTempHome();
    const cwd = await createCwd("same");
    process.chdir(cwd);

    const first = resolveAutosession();
    updateLastAccessed(cwd, new Date(Date.now() - 1000).toISOString());

    const second = resolveAutosession();

    expect(getDataRoot()).toBe(home.dataRoot);
    expect(second.id).toBe(first.id);
    expect(Date.parse(second.lastAccessedAt)).toBeGreaterThan(
      Date.parse(first.lastAccessedAt) - 1,
    );
  });

  test("different CWDs produce different keys and session records", async () => {
    await useTempHome();
    const firstCwd = await createCwd("first");
    const secondCwd = await createCwd("second");

    const first = resolveAutosession(firstCwd);
    const second = resolveAutosession(secondCwd);

    expect(getCwdKey(firstCwd)).not.toBe(getCwdKey(secondCwd));
    expect(first.id).not.toBe(second.id);
  });

  test("missing and expired records create new sessions", async () => {
    await useTempHome();
    const missingCwd = await createCwd("missing");
    const missing = resolveAutosession(missingCwd);
    expect(missing.id).toMatch(/^[0-9a-f-]{36}$/);

    const expiredCwd = await createCwd("expired");
    const expired = resolveAutosession(expiredCwd);
    updateLastAccessed(
      expiredCwd,
      new Date(Date.now() - AUTOSESSION_TTL_MS - 1).toISOString(),
    );
    const renewed = resolveAutosession(expiredCwd);
    expect(renewed.id).not.toBe(expired.id);
  });
});
