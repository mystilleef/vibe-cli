/**
 * Shared validation utilities for installer modules.
 *
 * Consolidates common validation patterns used by both guideInstaller.ts
 * and skillsInstaller.ts to eliminate DRY violations.
 */

import { access, constants, stat } from "node:fs/promises";
import { extractErrorMessage as errorMessage, isEnoent } from "./errors.js";

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
