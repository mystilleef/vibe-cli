/**
 * Unit tests for shared validation utilities.
 *
 * Covers validateDirectory with all behavioral paths: happy, error, and edge
 * cases.
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import {
  type access,
  chmod,
  constants,
  stat as fsStat,
  mkdir,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { InstallerError, validateDirectory } from "../src/utils/validation.js";
import { cleanupTempDirs, createTempDir } from "./helpers/skillsTestUtils.js";

let tempDirs: string[] = [];

beforeEach(async () => {
  tempDirs = [];
});

afterEach(async () => {
  await cleanupTempDirs(tempDirs);
});

/** Local stand-in for a caller-supplied validation-error subclass. */
class TestValidationError extends InstallerError {
  constructor(message: string) {
    super(message);
    this.name = "TestValidationError";
  }
}

// ── Error class behavior ────────────────────────────────────────────────────

describe("InstallerError", () => {
  test("constructs with message and correct name", () => {
    const error = new InstallerError("test message");
    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(InstallerError);
    expect(error.message).toBe("test message");
    expect(error.name).toBe("InstallerError");
  });
});

// ── validateDirectory ───────────────────────────────────────────────────────

describe("validateDirectory - happy paths", () => {
  test("resolves when directory exists and is writable", async () => {
    const dir = await createTempDir(tempDirs);
    await expect(
      validateDirectory({
        path: dir,
        checkWritable: true,
        errorClass: TestValidationError,
        baseErrorClass: InstallerError,
      }),
    ).resolves.toBeUndefined();
  });

  test("resolves when directory exists without write check", async () => {
    const dir = await createTempDir(tempDirs);
    await expect(
      validateDirectory({
        path: dir,
        errorClass: TestValidationError,
        baseErrorClass: InstallerError,
      }),
    ).resolves.toBeUndefined();
  });

  test("resolves when directory exists and write check is explicitly false", async () => {
    const dir = await createTempDir(tempDirs);
    await expect(
      validateDirectory({
        path: dir,
        checkWritable: false,
        errorClass: TestValidationError,
        baseErrorClass: InstallerError,
      }),
    ).resolves.toBeUndefined();
  });
});

describe("validateDirectory - does not exist", () => {
  test("throws errorClass when directory does not exist", async () => {
    const base = await createTempDir(tempDirs);
    const absent = join(base, "nonexistent-dir");

    await expect(
      validateDirectory({
        path: absent,
        errorClass: TestValidationError,
        baseErrorClass: InstallerError,
      }),
    ).rejects.toThrow(TestValidationError);
    await expect(
      validateDirectory({
        path: absent,
        errorClass: TestValidationError,
        baseErrorClass: InstallerError,
      }),
    ).rejects.toThrow("does not exist");
  });
});

describe("validateDirectory - not a directory", () => {
  test("throws errorClass when path is a regular file", async () => {
    const base = await createTempDir(tempDirs);
    const filePath = join(base, "regular-file");
    await writeFile(filePath, "content");

    await expect(
      validateDirectory({
        path: filePath,
        errorClass: TestValidationError,
        baseErrorClass: InstallerError,
      }),
    ).rejects.toThrow(TestValidationError);
    await expect(
      validateDirectory({
        path: filePath,
        errorClass: TestValidationError,
        baseErrorClass: InstallerError,
      }),
    ).rejects.toThrow("is not a directory");
  });
});

describe("validateDirectory - not writable", () => {
  test("throws errorClass when directory is not writable", async () => {
    if (process.getuid?.() === 0) return;
    const dir = await createTempDir(tempDirs);
    await chmod(dir, 0o555);
    try {
      await expect(
        validateDirectory({
          path: dir,
          checkWritable: true,
          errorClass: TestValidationError,
          baseErrorClass: InstallerError,
        }),
      ).rejects.toThrow(TestValidationError);
      await expect(
        validateDirectory({
          path: dir,
          checkWritable: true,
          errorClass: TestValidationError,
          baseErrorClass: InstallerError,
        }),
      ).rejects.toThrow("No write access");
    } finally {
      await chmod(dir, 0o755);
    }
  });

  test("does not check write access when checkWritable is false", async () => {
    if (process.getuid?.() === 0) return;
    const dir = await createTempDir(tempDirs);
    await chmod(dir, 0o555);
    try {
      await expect(
        validateDirectory({
          path: dir,
          checkWritable: false,
          errorClass: TestValidationError,
          baseErrorClass: InstallerError,
        }),
      ).resolves.toBeUndefined();
    } finally {
      await chmod(dir, 0o755);
    }
  });
});

describe("validateDirectory - stat failure", () => {
  test("throws baseErrorClass when stat fails with non-ENOENT error", async () => {
    const base = await createTempDir(tempDirs);
    const dir = join(base, "target");
    await mkdir(dir);

    const originalStat = fsStat;
    const spy = spyOn(await import("node:fs/promises"), "stat");
    spy.mockImplementation(((p: Parameters<typeof fsStat>[0]) => {
      if (typeof p === "string" && p === dir) {
        const err = new Error(
          "EACCES: permission denied",
        ) as NodeJS.ErrnoException;
        err.code = "EACCES";
        throw err;
      }
      return originalStat(p);
    }) as typeof fsStat);

    try {
      await expect(
        validateDirectory({
          path: dir,
          errorClass: TestValidationError,
          baseErrorClass: InstallerError,
        }),
      ).rejects.toThrow(InstallerError);
      await expect(
        validateDirectory({
          path: dir,
          errorClass: TestValidationError,
          baseErrorClass: InstallerError,
        }),
      ).rejects.toThrow("Failed to inspect target parent");
    } finally {
      spy.mockRestore();
    }
  });
});

describe("validateDirectory - access failure", () => {
  test("throws errorClass when access for W_OK fails", async () => {
    const dir = await createTempDir(tempDirs);

    const originalAccess = await import("node:fs/promises").then(
      (m) => m.access,
    );
    const spy = spyOn(await import("node:fs/promises"), "access");
    spy.mockImplementation(((path: string, mode?: number) => {
      if (path === dir && mode === constants.W_OK) {
        throw new Error("EACCES: permission denied");
      }
      return originalAccess(path, mode);
    }) as typeof access);

    try {
      await expect(
        validateDirectory({
          path: dir,
          checkWritable: true,
          errorClass: TestValidationError,
          baseErrorClass: InstallerError,
        }),
      ).rejects.toThrow(TestValidationError);
      await expect(
        validateDirectory({
          path: dir,
          checkWritable: true,
          errorClass: TestValidationError,
          baseErrorClass: InstallerError,
        }),
      ).rejects.toThrow("No write access");
    } finally {
      spy.mockRestore();
    }
  });
});
