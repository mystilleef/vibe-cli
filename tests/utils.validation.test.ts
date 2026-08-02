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

// ── validateInstallerTarget ──────────────────────────────────────────────

import {
  atomicFileWrite,
  validateInstallerTarget,
} from "../src/utils/validation.js";

let vldDirs: string[] = [];

beforeEach(async () => {
  vldDirs = [];
});

afterEach(async () => {
  await cleanupTempDirs(vldDirs);
});

describe("validateInstallerTarget", () => {
  test("resolves when target root exists and is writable", async () => {
    const dir = await createTempDir(vldDirs);
    await expect(
      validateInstallerTarget(dir, "test.txt", {
        validationErrorClass: TestValidationError,
        baseErrorClass: InstallerError,
      }),
    ).resolves.toBeUndefined();
  });

  test("resolves when target root is absent but parent exists", async () => {
    const parent = await createTempDir(vldDirs);
    const target = join(parent, "nonexistent-dir");
    await expect(
      validateInstallerTarget(target, "test.txt", {
        validationErrorClass: TestValidationError,
        baseErrorClass: InstallerError,
      }),
    ).resolves.toBeUndefined();
  });

  test("throws when target root is a regular file", async () => {
    const parent = await createTempDir(vldDirs);
    const targetFile = join(parent, "existing-file");
    await writeFile(targetFile, "content");

    await expect(
      validateInstallerTarget(targetFile, "test.txt", {
        validationErrorClass: TestValidationError,
        baseErrorClass: InstallerError,
      }),
    ).rejects.toThrow(TestValidationError);
    await expect(
      validateInstallerTarget(targetFile, "test.txt", {
        validationErrorClass: TestValidationError,
        baseErrorClass: InstallerError,
      }),
    ).rejects.toThrow(/not a directory/);
  });

  test("throws when target root is unwritable", async () => {
    const dir = await createTempDir(vldDirs);

    const fsPromises = await import("node:fs/promises");
    const origAccess = fsPromises.access;
    const spy = spyOn(fsPromises, "access");
    spy.mockImplementation(((path: string, mode?: number) => {
      if (path === dir && mode === constants.W_OK) {
        throw new Error("EACCES: permission denied");
      }
      return origAccess(path, mode);
    }) as typeof access);

    try {
      await expect(
        validateInstallerTarget(dir, "test.txt", {
          validationErrorClass: TestValidationError,
          baseErrorClass: InstallerError,
        }),
      ).rejects.toThrow(TestValidationError);
      await expect(
        validateInstallerTarget(dir, "test.txt", {
          validationErrorClass: TestValidationError,
          baseErrorClass: InstallerError,
        }),
      ).rejects.toThrow(/No write access to target root/);
    } finally {
      spy.mockRestore();
    }
  });

  test("throws when lstat on targetRoot fails with EACCES", async () => {
    const dir = await createTempDir(vldDirs);

    const fsPromises = await import("node:fs/promises");
    const origLstat = fsPromises.lstat;
    const spy = spyOn(fsPromises, "lstat");
    spy.mockImplementation(((p: Parameters<typeof fsPromises.lstat>[0]) => {
      if (p === dir) {
        const err = new Error(
          "EACCES: permission denied",
        ) as NodeJS.ErrnoException;
        err.code = "EACCES";
        throw err;
      }
      return origLstat(p);
    }) as typeof fsPromises.lstat);

    try {
      await expect(
        validateInstallerTarget(dir, "test.txt", {
          validationErrorClass: TestValidationError,
          baseErrorClass: InstallerError,
        }),
      ).rejects.toThrow(TestValidationError);
      await expect(
        validateInstallerTarget(dir, "test.txt", {
          validationErrorClass: TestValidationError,
          baseErrorClass: InstallerError,
        }),
      ).rejects.toThrow(/Failed to inspect target directory/);
    } finally {
      spy.mockRestore();
    }
  });

  test("throws when intermediate path lstat fails with EACCES", async () => {
    const parent = await createTempDir(vldDirs);
    const target = join(parent, "child");

    const fsPromises = await import("node:fs/promises");
    const origLstat = fsPromises.lstat;
    const spy = spyOn(fsPromises, "lstat");
    spy.mockImplementation(((p: Parameters<typeof fsPromises.lstat>[0]) => {
      if (typeof p === "string" && p === parent) {
        const err = new Error(
          "EACCES: permission denied",
        ) as NodeJS.ErrnoException;
        err.code = "EACCES";
        throw err;
      }
      return origLstat(p);
    }) as typeof fsPromises.lstat);

    try {
      await expect(
        validateInstallerTarget(target, "test.txt", {
          validationErrorClass: TestValidationError,
          baseErrorClass: InstallerError,
        }),
      ).rejects.toThrow(TestValidationError);
      await expect(
        validateInstallerTarget(target, "test.txt", {
          validationErrorClass: TestValidationError,
          baseErrorClass: InstallerError,
        }),
      ).rejects.toThrow(/Failed to inspect target path/);
    } finally {
      spy.mockRestore();
    }
  });

  test("throws when parent of absent target does not exist", async () => {
    const base = await createTempDir(vldDirs);
    const nonexistentParent = join(base, "nonexistent-parent");
    const target = join(nonexistentParent, "child");

    await expect(
      validateInstallerTarget(target, "test.txt", {
        validationErrorClass: TestValidationError,
        baseErrorClass: InstallerError,
      }),
    ).rejects.toThrow(TestValidationError);
    await expect(
      validateInstallerTarget(target, "test.txt", {
        validationErrorClass: TestValidationError,
        baseErrorClass: InstallerError,
      }),
    ).rejects.toThrow(/does not exist/);
  });

  test("throws when parent of absent target is not a directory", async () => {
    const base = await createTempDir(vldDirs);
    const fileParent = join(base, "not-a-dir");
    await writeFile(fileParent, "file content");
    const target = join(fileParent, "absent-target");

    await expect(
      validateInstallerTarget(target, "test.txt", {
        validationErrorClass: TestValidationError,
        baseErrorClass: InstallerError,
      }),
    ).rejects.toThrow(TestValidationError);
    await expect(
      validateInstallerTarget(target, "test.txt", {
        validationErrorClass: TestValidationError,
        baseErrorClass: InstallerError,
      }),
    ).rejects.toThrow(/is not a directory/);
  });
});

describe("atomicFileWrite", () => {
  test("writes content atomically via temp file", async () => {
    const dir = await createTempDir(vldDirs);
    const dest = join(dir, "output.txt");
    const content = Buffer.from("hello world");

    await atomicFileWrite(dest, content, ".test-tmp", InstallerError);

    const { readFile } = await import("node:fs/promises");
    const written = await readFile(dest);
    expect(written).toEqual(content);
  });

  test("overwrites existing destination", async () => {
    const dir = await createTempDir(vldDirs);
    const dest = join(dir, "existing.txt");
    await writeFile(dest, "old content");
    const content = Buffer.from("new content");

    await atomicFileWrite(dest, content, ".test-tmp", InstallerError);

    const { readFile } = await import("node:fs/promises");
    const written = await readFile(dest);
    expect(written).toEqual(content);
  });

  test("throws on write failure and removes temp file", async () => {
    const dir = await createTempDir(vldDirs);
    const dest = join(dir, "output.txt");
    const content = Buffer.from("data");

    const fsPromises = await import("node:fs/promises");
    const spy = spyOn(fsPromises, "writeFile");
    spy.mockImplementation(() => {
      throw new Error("ENOSPC: no space left");
    });

    try {
      await expect(
        atomicFileWrite(dest, content, ".test-tmp", InstallerError),
      ).rejects.toThrow(InstallerError);
      await expect(
        atomicFileWrite(dest, content, ".test-tmp", InstallerError),
      ).rejects.toThrow(/Failed to install to/);
    } finally {
      spy.mockRestore();
    }
  });

  test("throws on rename failure and removes temp file", async () => {
    const dir = await createTempDir(vldDirs);
    const dest = join(dir, "output.txt");
    const content = Buffer.from("data");

    const fsPromises = await import("node:fs/promises");
    const spy = spyOn(fsPromises, "rename");
    spy.mockImplementation(() => {
      throw new Error("EXDEV: cross-device link");
    });

    try {
      await expect(
        atomicFileWrite(dest, content, ".test-tmp", InstallerError),
      ).rejects.toThrow(InstallerError);
      await expect(
        atomicFileWrite(dest, content, ".test-tmp", InstallerError),
      ).rejects.toThrow(/Failed to install to/);
    } finally {
      spy.mockRestore();
    }
  });

  test("survives rm cleanup failure when write fails", async () => {
    const dir = await createTempDir(vldDirs);
    const dest = join(dir, "output.txt");
    const content = Buffer.from("data");

    const fsPromises = await import("node:fs/promises");
    const writeSpy = spyOn(fsPromises, "writeFile");
    writeSpy.mockImplementation(() => {
      throw new Error("ENOSPC: no space left");
    });

    const rmSpy = spyOn(fsPromises, "rm");
    rmSpy.mockImplementation(() => {
      throw new Error("EACCES: cleanup also failed");
    });

    try {
      await expect(
        atomicFileWrite(dest, content, ".test-tmp", InstallerError),
      ).rejects.toThrow(InstallerError);
      await expect(
        atomicFileWrite(dest, content, ".test-tmp", InstallerError),
      ).rejects.toThrow(/Failed to install to/);
    } finally {
      writeSpy.mockRestore();
      rmSpy.mockRestore();
    }
  });
});
