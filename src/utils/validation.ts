/**
 * Shared validation utilities for installer modules.
 *
 * Consolidates common validation patterns used by guideInstaller.ts,
 * settingsInstaller.ts, and skillsInstaller.ts to eliminate DRY violations.
 */

import type { Stats } from "node:fs";
import {
  access,
  constants,
  lstat,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { extractErrorMessage as errorMessage, isEnoent } from "./errors.js";
import {
  getPathAncestorsAndSelf,
  rejectSymlinkPathComponents,
} from "./pathValidation.js";

/**
 * Base error class for installer operations.
 * Subclasses should set `name` to their specific error type.
 */
export class InstallerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InstallerError";
  }
}

/**
 * Options for directory validation.
 */
export interface ValidateDirectoryOptions {
  /** The path being validated (for error messages). */
  path: string;
  /** Whether to check write access. */
  checkWritable?: boolean;
  /** Custom error class for validation errors. */
  errorClass: new (
    message: string,
  ) => Error;
  /** Custom error class for non-validation errors. */
  baseErrorClass: new (
    message: string,
  ) => Error;
}

/**
 * Validate that a directory exists, is a directory, and optionally is writable.
 *
 * @param options - Validation options.
 * @throws {InstallerValidationError} When validation fails.
 * @throws {InstallerError} When inspection fails unexpectedly.
 */
export async function validateDirectory(
  options: ValidateDirectoryOptions,
): Promise<void> {
  const { path, checkWritable = false, errorClass, baseErrorClass } = options;

  let dirStat: Awaited<ReturnType<typeof stat>>;
  try {
    dirStat = await stat(path);
  } catch (error) {
    if (isEnoent(error)) {
      throw new errorClass(`Target parent directory '${path}' does not exist`);
    }
    throw new baseErrorClass(
      `Failed to inspect target parent '${path}': ${errorMessage(error)}`,
    );
  }

  if (!dirStat.isDirectory()) {
    throw new errorClass(`Target parent '${path}' is not a directory`);
  }

  if (checkWritable) {
    try {
      await access(path, constants.W_OK);
    } catch {
      throw new errorClass(`No write access to target parent '${path}'`);
    }
  }
}

// ── Installer action types ────────────────────────────────────────────────

/** Action result for single-file installers (guide, settings). */
export type InstallerAction =
  | "would-install"
  | "would-replace"
  | "would-skip"
  | "installed"
  | "replaced"
  | "skipped";

// ── Target validation ─────────────────────────────────────────────────────

/** Options for validateInstallerTarget. */
export interface ValidateInstallerTargetOptions {
  /** Error class for validation errors (symlink, not-directory, unwritable). */
  validationErrorClass: new (
    message: string,
  ) => Error;
  /** Error class for non-validation inspection errors. */
  baseErrorClass: new (
    message: string,
  ) => Error;
}

/**
 * Validate the target path for single-file installers.
 *
 * Checks (unconditionally, including dry-run):
 * - No symlink in the path from root to destination
 * - Existing target root must be a writable directory
 * - When target root absent, immediate parent must exist, be a directory, and be writable
 *
 * @param targetRoot - Absolute target root directory.
 * @param filename - Destination filename (e.g. "guide.md", "settings.json").
 * @param options - Error classes for validation vs. base errors.
 */
export async function validateInstallerTarget(
  targetRoot: string,
  filename: string,
  options: ValidateInstallerTargetOptions,
): Promise<void> {
  const { validationErrorClass, baseErrorClass } = options;
  const destPath = join(targetRoot, filename);
  const parentDir = dirname(targetRoot);

  await rejectSymlinkPathComponents(getPathAncestorsAndSelf(destPath), lstat, {
    destPath,
    targetRoot,
    errorClass: validationErrorClass,
    formatError: (component, root, error) => {
      if (component === root) {
        return `Failed to inspect target directory '${root}': ${errorMessage(error)}`;
      }
      if (component === destPath) {
        return `Failed to inspect destination '${destPath}': ${errorMessage(error)}`;
      }
      return `Failed to inspect target path '${component}': ${errorMessage(error)}`;
    },
  });

  // Preflight target root: reject existing regular-file and non-writable-directory roots
  let targetExists = false;
  let targetStat: Stats | undefined;
  try {
    targetStat = await lstat(targetRoot);
    targetExists = true;
  } catch (error) {
    if (isEnoent(error)) {
      // Absent root — defer to parent validation below
    } else if ((error as NodeJS.ErrnoException).code === "ENOTDIR") {
      // A path component is not a directory — defer to parent validation
    } else {
      throw new validationErrorClass(
        `Failed to inspect target root '${targetRoot}': ${errorMessage(error)}`,
      );
    }
  }

  if (targetExists && targetStat) {
    if (!targetStat.isDirectory()) {
      throw new validationErrorClass(
        `Target root '${targetRoot}' is not a directory`,
      );
    }

    try {
      await access(targetRoot, constants.W_OK);
    } catch {
      throw new validationErrorClass(
        `No write access to target root '${targetRoot}'`,
      );
    }
  }

  // Validate immediate parent when target root doesn't exist yet
  if (!targetExists) {
    await validateDirectory({
      path: parentDir,
      checkWritable: true,
      errorClass: validationErrorClass,
      baseErrorClass,
    });
  }
}

// ── Atomic file write ─────────────────────────────────────────────────────

/**
 * Atomically write content to `destPath` via a temp file + rename.
 *
 * On failure the temp file is removed before the error is rethrown.
 * Callers pass their own error class so thrown errors match the
 * surrounding installer's hierarchy.
 *
 * @param destPath - Absolute destination file path.
 * @param content - Bytes to write.
 * @param tempPrefix - Prefix for the temp file name (e.g. ".vibe-guide.tmp").
 * @param errorClass - Error constructor for the wrapped failure.
 */
export async function atomicFileWrite(
  destPath: string,
  content: Buffer,
  tempPrefix: string,
  errorClass: new (message: string) => Error,
): Promise<void> {
  const dir = dirname(destPath);
  const tempPath = join(
    dir,
    `${tempPrefix}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}`,
  );
  try {
    await writeFile(tempPath, content);
    await rename(tempPath, destPath);
  } catch (error) {
    try {
      await rm(tempPath, { force: true });
    } catch {
      // Ignore cleanup failure
    }
    throw new errorClass(
      `Failed to install to '${destPath}': ${errorMessage(error)}`,
    );
  }
}
