/**
 * Managed backup inventory: direct parser contract and readdir fault
 * classification. The happy-path inventory (shape guards, ordering,
 * tie-breaks, malformed-name exclusion) is covered through the diagnostics
 * layer; these tests pin the listing-failure branches at the source.
 *
 * `node:fs/promises` is wrapped so `readdir` failures inject deterministically
 * (a vanished directory and an operational fault) while every other call
 * passes through to the real module.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdirSync } from "node:fs";
import * as realFsPromises from "node:fs/promises";
import { join } from "node:path";
import { createTempHome, type TempHomeContext } from "./helpers/tempHome.js";

let readdirFault: "none" | "enoent" | "failure" = "none";

mock.module("node:fs/promises", () => ({
  ...realFsPromises,
  readdir: async (...args: Parameters<typeof realFsPromises.readdir>) => {
    if (readdirFault === "enoent") {
      const error = new Error("injected readdir ENOENT");
      (error as NodeJS.ErrnoException).code = "ENOENT";
      throw error;
    }
    if (readdirFault === "failure") {
      const error = new Error("injected readdir failure");
      (error as NodeJS.ErrnoException).code = "EACCES";
      throw error;
    }
    return realFsPromises.readdir(...args);
  },
}));

// Import after mock registration so the module sees the wrapped builtin.
const { parseManagedBackupName, readManagedBackupEntries } = await import(
  "../src/utils/managedBackups.js"
);

let home: TempHomeContext;

beforeEach(async () => {
  home = await createTempHome();
  readdirFault = "none";
});

afterEach(async () => {
  readdirFault = "none";
  await home.cleanup();
});

describe("parseManagedBackupName", () => {
  test("parses the embedded timestamp of a prune-prefixed managed name", () => {
    const timestampMs = Date.parse("2026-01-02T03:04:05.678Z");

    expect(
      parseManagedBackupName("vibe-prune-2026-01-02T03-04-05-678Z.db"),
    ).toBe(timestampMs);
  });

  test("parses the embedded timestamp of a doctor-prefixed managed name", () => {
    const timestampMs = Date.parse("2026-03-01T00:00:00.000Z");

    expect(
      parseManagedBackupName("vibe-doctor-2026-03-01T00-00-00-000Z.db"),
    ).toBe(timestampMs);
  });

  test("rejects names without a managed prefix, suffix, or valid label", () => {
    expect(
      parseManagedBackupName("vibe-other-2026-01-01T00-00-00-000Z.db"),
    ).toBeNull();
    expect(
      parseManagedBackupName("vibe-prune-2026-01-01T00-00-00-000Z.txt"),
    ).toBeNull();
    expect(parseManagedBackupName("vibe-prune-not-a-timestamp.db")).toBeNull();
    expect(
      parseManagedBackupName("vibe-prune-2026-02-30T00-00-00-000Z.db"),
    ).toBeNull();
  });
});

describe("readManagedBackupEntries — listing faults", () => {
  function backupsDir(): string {
    return join(home.dataRoot, "backups");
  }

  test("reports an empty inventory when the directory vanishes before listing", async () => {
    mkdirSync(backupsDir(), { recursive: true });
    readdirFault = "enoent";

    await expect(readManagedBackupEntries(backupsDir())).resolves.toEqual({
      ok: true,
      entries: [],
    });
  });

  test("surfaces a non-ENOENT listing fault as an inventory failure", async () => {
    mkdirSync(backupsDir(), { recursive: true });
    readdirFault = "failure";

    await expect(readManagedBackupEntries(backupsDir())).resolves.toEqual({
      ok: false,
      error: "injected readdir failure",
    });
  });
});
